//! Suggests companion files for a film: the files the subject uses, the files
//! that use it, and the files that belong to it by name.
//!
//! The suggestions come from cheap text signals that work in any language. They
//! are only a starting list for the user to tick or untick. The agent reads the
//! code and decides which companions really matter.
//!
//! Four signals are scored and added up per file:
//!
//!   - import: the subject imports or includes the file, or a file it imports
//!     does.
//!   - sibling: the file has the same base name, such as a header for an
//!     implementation.
//!   - reference: the file mentions names the subject declares.
//!   - test: the file is a test that mentions the subject.
//!
//! The user can keep files out of the suggestions with an [`IgnoreList`], for
//! example the folder that holds third-party code.

use crate::workspace::Workspace;
use codjiva_nav::imports::{
    dir_of, imported_specifiers, resolve, without_extension,
};
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use regex::Regex;
use serde::Serialize;
use std::collections::BTreeMap;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

/// Files larger than this are not searched for references.
const MAX_SCAN_BYTES: u64 = 400_000;
/// The search for references stops after this long, so a very large workspace
/// still answers.
const SCAN_BUDGET: Duration = Duration::from_millis(1500);
/// The most declared names that are searched for.
const MAX_NAMES: usize = 24;

/// The most imported files whose own imports are looked at.
const MAX_FOLLOWED: usize = 8;

const SCORE_IMPORT: u32 = 10;
const SCORE_INDIRECT_IMPORT: u32 = 5;
const SCORE_SIBLING: u32 = 8;
const SCORE_TEST: u32 = 3;
/// A file that mentions the subject's names scores this plus one per mention,
/// up to the cap.
const SCORE_REFERENCE_BASE: u32 = 2;
const SCORE_REFERENCE_CAP: u32 = 6;

/// One suggested companion.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    pub path: String,
    /// Why the file is suggested, as a short phrase for the user.
    pub why: String,
    pub score: u32,
}

/// The files and folders that are never suggested as companions.
///
/// It is built from the patterns of the `companion_ignore` setting. A pattern
/// is written the way a line of a `.gitignore` file is written, and is matched
/// against a file's path relative to the workspace root:
///
///   - `vendor/`: every folder named `vendor`, at any depth, with everything
///     in it.
///   - `/internal/gen/`: only the folder `internal/gen` directly under the
///     workspace root.
///   - `*.pb.go`: every file whose name ends in `.pb.go`.
///   - `!vendor/ours/`: an exception: files in `vendor/ours` are suggested
///     after all.
///
/// An empty line and a line that starts with `#` are skipped.
pub struct IgnoreList {
    matcher: Gitignore,
    /// The patterns that could not be read as a pattern. They match nothing.
    invalid: Vec<String>,
}

impl IgnoreList {
    pub fn new(patterns: &[String]) -> IgnoreList {
        // The matcher's root is empty because the paths it is asked about are
        // already relative to the workspace root.
        let mut builder = GitignoreBuilder::new("");
        let mut invalid = Vec::new();
        for pattern in patterns {
            if builder.add_line(None, pattern).is_err() {
                invalid.push(pattern.clone());
            }
        }
        IgnoreList {
            matcher: builder.build().unwrap_or_else(|_| Gitignore::empty()),
            invalid,
        }
    }

    /// An ignore list that matches nothing.
    pub fn none() -> IgnoreList {
        IgnoreList {
            matcher: Gitignore::empty(),
            invalid: Vec::new(),
        }
    }

    /// True when the file at `rel_path`, or a folder it is in, matches a
    /// pattern.
    pub fn matches(&self, rel_path: &str) -> bool {
        self.matcher
            .matched_path_or_any_parents(
                rel_path.trim_start_matches('/'),
                false,
            )
            .is_ignore()
    }

    pub fn invalid(&self) -> &[String] {
        &self.invalid
    }
}

/// What a set of ignore patterns does in the open workspace. The interface
/// shows it while the user writes a pattern, before the pattern is saved.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IgnoreCheck {
    /// How many code files of the workspace the patterns match.
    pub matched: usize,
    /// The first few of those files.
    pub examples: Vec<String>,
    /// Which of the paths the caller asked about match.
    pub matched_paths: Vec<String>,
    /// The patterns that could not be read as a pattern.
    pub invalid: Vec<String>,
}

/// How many example files an [`IgnoreCheck`] names.
const CHECK_EXAMPLES: usize = 5;

/// Reports what `patterns` match. `files` is every file of the workspace,
/// relative to its root. `paths` are the files the caller wants an answer for
/// one by one, such as the companions a dialog lists.
pub fn check_ignore(
    patterns: &[String],
    files: &[String],
    paths: &[String],
) -> IgnoreCheck {
    let list = IgnoreList::new(patterns);
    let matched: Vec<&String> = files
        .iter()
        .filter(|f| is_code(f) && list.matches(f))
        .collect();
    IgnoreCheck {
        matched: matched.len(),
        examples: matched
            .iter()
            .take(CHECK_EXAMPLES)
            .map(|f| f.to_string())
            .collect(),
        matched_paths: paths
            .iter()
            .filter(|p| list.matches(p))
            .cloned()
            .collect(),
        invalid: list.invalid().to_vec(),
    }
}

fn regex(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("the pattern is valid"))
}

/// The names the subject declares: the word after `class`, `struct`, `func`,
/// `def` and similar keywords. Very short names are left out because they match
/// by accident.
fn declared_names(text: &str) -> Vec<String> {
    static DECLARED: OnceLock<Regex> = OnceLock::new();
    let declared = regex(
        &DECLARED,
        r"\b(?:class|struct|interface|trait|enum|type|func|fn|def|function|module|object|protocol)\s+(?:\([^)]*\)\s*)?([A-Za-z_][A-Za-z0-9_]{3,})",
    );
    let mut names: Vec<String> = Vec::new();
    for capture in declared.captures_iter(text) {
        let name = capture[1].to_string();
        if !names.contains(&name) {
            names.push(name);
        }
    }
    names.truncate(MAX_NAMES);
    names
}

/// True for a path that looks like a test: it is under a test folder or its
/// name says so.
fn is_test(path: &str) -> bool {
    let lower = path.to_lowercase();
    let name = lower.rsplit('/').next().unwrap_or("");
    lower.split('/').any(|part| {
        matches!(
            part,
            "test" | "tests" | "__tests__" | "spec" | "specs" | "testing"
        )
    }) || name.starts_with("test_")
        || name.contains("_test.")
        || name.contains(".test.")
        || name.contains(".spec.")
        || name.contains("_spec.")
}

/// The base name both a file and its siblings share: the file name without
/// extensions and without the usual test markers. `src/handler_test.go` and
/// `src/handler.go` both give `handler`.
fn family_name(path: &str) -> String {
    let name = path.rsplit('/').next().unwrap_or(path).to_lowercase();
    let first = name.split('.').next().unwrap_or(&name);
    first
        .trim_start_matches("test_")
        .trim_end_matches("_test")
        .trim_end_matches("_spec")
        .to_string()
}

/// A rough count of the tokens a model reads for this many bytes of code. Code
/// averages close to four bytes per token; the result is an estimate for the
/// user, not a measurement.
pub fn estimated_tokens(bytes: u64) -> u64 {
    bytes / 4
}

/// The most code files a folder may hold for a Visualise job on the whole
/// folder, and the most tokens they may add up to. A larger folder does not fit
/// in what an agent can read at once.
pub const FOLDER_MAX_FILES: usize = 150;
pub const FOLDER_MAX_TOKENS: u64 = 400_000;
/// From this many tokens on, the interface warns in stronger words.
pub const FOLDER_LARGE_TOKENS: u64 = 80_000;

/// What a Visualise job on a whole folder would have to read.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderInfo {
    /// The folder, relative to the workspace root, without a trailing slash.
    pub rel_path: String,
    pub name: String,
    /// The code files in the folder and the folders below it, relative to the
    /// workspace root.
    pub files: Vec<String>,
    /// Their total size in bytes, and the estimated number of tokens.
    pub bytes: u64,
    pub estimated_tokens: u64,
    /// True from [`FOLDER_LARGE_TOKENS`] on.
    pub large: bool,
    /// True when the folder is over a limit and cannot be visualised as a
    /// whole.
    pub too_large: bool,
}

/// Describes a folder for a Visualise job on the whole folder. `files` is every
/// file of the workspace, relative to its root.
pub fn folder_info(
    ws: &Workspace,
    rel_dir: &str,
    files: &[String],
) -> FolderInfo {
    let dir = rel_dir.trim_matches('/');
    let prefix = if dir.is_empty() {
        String::new()
    } else {
        format!("{dir}/")
    };
    let inside: Vec<String> = files
        .iter()
        .filter(|f| f.starts_with(&prefix) && is_code(f))
        .cloned()
        .collect();
    let bytes: u64 = inside
        .iter()
        .filter_map(|f| ws.resolve(f).ok())
        .filter_map(|path| path.metadata().ok())
        .map(|meta| meta.len())
        .sum();
    let tokens = estimated_tokens(bytes);
    FolderInfo {
        rel_path: dir.to_string(),
        name: if dir.is_empty() {
            ws.name().to_string()
        } else {
            dir.rsplit('/').next().unwrap_or(dir).to_string()
        },
        too_large: inside.len() > FOLDER_MAX_FILES
            || tokens > FOLDER_MAX_TOKENS,
        large: tokens >= FOLDER_LARGE_TOKENS,
        files: inside,
        bytes,
        estimated_tokens: tokens,
    }
}

/// True for a file that holds code, judged by its name. Documentation and data
/// files are never suggested, because a film follows code.
fn is_code(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path);
    crate::lang::of_file_name(name).is_some_and(|language| {
        !matches!(
            language.label,
            "Markdown"
                | "reStructuredText"
                | "Text"
                | "JSON"
                | "YAML"
                | "TOML"
                | "INI"
                | "Config"
                | "XML"
                | "HTML"
                | "CSS"
                | "SCSS"
                | "Less"
        )
    })
}

/// Suggests up to `max` companions for `subject`, best first. `files` is every
/// file of the workspace, relative to its root. A file that `ignored` matches
/// is never suggested, and the files it imports are not looked at.
pub fn suggest(
    ws: &Workspace,
    subject: &str,
    files: &[String],
    max: usize,
    ignored: &IgnoreList,
) -> Vec<Suggestion> {
    let Ok(content) = ws.read_text(subject) else {
        return Vec::new();
    };
    let text = content.text;
    let candidates: Vec<String> = files
        .iter()
        .filter(|f| f.as_str() != subject && is_code(f) && !ignored.matches(f))
        .cloned()
        .collect();
    // Score and reasons per file.
    let mut found: BTreeMap<String, (u32, Vec<String>)> = BTreeMap::new();
    let mut add = |path: &str, score: u32, reason: String| {
        let entry = found.entry(path.to_string()).or_default();
        entry.0 += score;
        if !entry.1.contains(&reason) {
            entry.1.push(reason);
        }
    };

    let mut direct: Vec<String> = Vec::new();
    for specifier in imported_specifiers(&text) {
        for path in resolve(&specifier, subject, &candidates) {
            add(path, SCORE_IMPORT, "imported by this file".into());
            if !direct.contains(path) {
                direct.push(path.clone());
            }
        }
    }
    // One step further: what the imported files import themselves. A C++ source
    // file often includes only its own header, and the header includes the
    // rest.
    for imported in direct.iter().take(MAX_FOLLOWED) {
        let Ok(content) = ws.read_text(imported) else {
            continue;
        };
        for specifier in imported_specifiers(&content.text) {
            for path in resolve(&specifier, imported, &candidates) {
                if !direct.contains(path) {
                    add(
                        path,
                        SCORE_INDIRECT_IMPORT,
                        format!(
                            "imported by {}",
                            imported.rsplit('/').next().unwrap_or(imported)
                        ),
                    );
                }
            }
        }
    }

    let family = family_name(subject);
    if family.len() >= 3 {
        for path in candidates.iter().filter(|f| family_name(f) == family) {
            let reason = if is_test(path) {
                "its test"
            } else {
                "same name"
            };
            add(path, SCORE_SIBLING, reason.into());
        }
    }

    // The names to look for in other files: what the subject declares, what the
    // files of the same name declare (a C++ class is declared in the header,
    // not in the source file), and the file's own base name when it is long
    // enough to be telling.
    let mut names = declared_names(&text);
    for sibling in candidates
        .iter()
        .filter(|f| {
            family.len() >= 3 && family_name(f) == family && !is_test(f)
        })
        .take(3)
    {
        if let Ok(content) = ws.read_text(sibling) {
            for name in declared_names(&content.text) {
                if !names.contains(&name) {
                    names.push(name);
                }
            }
        }
    }
    let stem = without_extension(subject.rsplit('/').next().unwrap_or(subject))
        .to_string();
    if stem.len() >= 5
        && !names.iter().any(|name| name.eq_ignore_ascii_case(&stem))
    {
        names.push(stem);
    }
    names.truncate(MAX_NAMES);
    if !names.is_empty() {
        let pattern = format!(
            r"\b(?:{})\b",
            names
                .iter()
                .map(|n| regex::escape(n))
                .collect::<Vec<_>>()
                .join("|")
        );
        if let Ok(mentions) = Regex::new(&pattern) {
            let began = Instant::now();
            // Files near the subject are searched first, so the time budget is
            // spent where companions are most likely.
            let subject_dir = dir_of(subject);
            let shared = |path: &str| {
                dir_of(path)
                    .split('/')
                    .zip(subject_dir.split('/'))
                    .take_while(|(a, b)| a == b)
                    .count()
            };
            let mut ordered: Vec<&String> = candidates.iter().collect();
            ordered.sort_by_key(|path| std::cmp::Reverse(shared(path)));
            for path in ordered {
                if began.elapsed() > SCAN_BUDGET {
                    break;
                }
                let Ok(absolute) = ws.resolve(path) else {
                    continue;
                };
                if absolute
                    .metadata()
                    .map_or(true, |meta| meta.len() > MAX_SCAN_BYTES)
                {
                    continue;
                }
                let Ok(other) = std::fs::read_to_string(&absolute) else {
                    continue;
                };
                let mut used: Vec<&str> = Vec::new();
                let mut count = 0u32;
                for hit in mentions.find_iter(&other) {
                    count += 1;
                    if !used.contains(&hit.as_str()) {
                        used.push(hit.as_str());
                    }
                }
                if count == 0 {
                    continue;
                }
                let shown = used
                    .iter()
                    .take(2)
                    .map(|name| format!("`{name}`"))
                    .collect::<Vec<_>>()
                    .join(", ");
                let more = if used.len() > 2 {
                    format!(" and {} more", used.len() - 2)
                } else {
                    String::new()
                };
                add(
                    path,
                    SCORE_REFERENCE_BASE + count.min(SCORE_REFERENCE_CAP),
                    format!("uses {shown}{more}"),
                );
                if is_test(path) {
                    add(path, SCORE_TEST, "a test".into());
                }
            }
        }
    }

    let mut list: Vec<Suggestion> = found
        .into_iter()
        .map(|(path, (score, reasons))| Suggestion {
            path,
            why: reasons.join(" · "),
            score,
        })
        .collect();
    list.sort_by(|a, b| {
        b.score.cmp(&a.score).then_with(|| a.path.cmp(&b.path))
    });
    list.truncate(max);
    list
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn workspace(
        files: &[(&str, &str)],
    ) -> (tempfile::TempDir, Workspace, Vec<String>) {
        let dir = tempfile::tempdir().unwrap();
        for (rel, text) in files {
            let path = dir.path().join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, text).unwrap();
        }
        let ws = Workspace::open(dir.path()).unwrap();
        let mut listed: Vec<String> =
            files.iter().map(|(rel, _)| rel.to_string()).collect();
        listed.sort();
        (dir, ws, listed)
    }

    fn paths(list: &[Suggestion]) -> Vec<&str> {
        list.iter().map(|s| s.path.as_str()).collect()
    }

    #[test]
    fn typescript_imports_siblings_and_users_are_suggested_with_reasons() {
        let (_dir, ws, files) = workspace(&[
            (
                "src/uploader.ts",
                "import { send } from './transport';\nimport { decideRetry } \
                 from './retry';\nexport class Uploader {}\nexport function \
                 enqueueChunk() {}\n",
            ),
            ("src/transport.ts", "export function send() {}\n"),
            ("src/retry.ts", "export function decideRetry() {}\n"),
            (
                "src/index.ts",
                "import { Uploader } from './uploader';\nnew Uploader(); \
                 enqueueChunk(); enqueueChunk();\n",
            ),
            (
                "src/uploader.test.ts",
                "import { Uploader } from './uploader';\ndescribe('Uploader', \
                 () => {});\n",
            ),
            ("src/unrelated.ts", "export const x = 1;\n"),
            ("README.md", "The Uploader sends chunks.\n"),
        ]);
        let list =
            suggest(&ws, "src/uploader.ts", &files, 12, &IgnoreList::none());
        let by_path: BTreeMap<&str, &Suggestion> =
            list.iter().map(|s| (s.path.as_str(), s)).collect();
        assert_eq!(by_path["src/transport.ts"].why, "imported by this file");
        assert!(
            by_path["src/uploader.test.ts"]
                .why
                .starts_with("its test · uses `Uploader`"),
            "{}",
            by_path["src/uploader.test.ts"].why
        );
        assert!(
            by_path["src/index.ts"].why.contains("`Uploader`")
                && by_path["src/index.ts"].why.contains("`enqueueChunk`")
        );
        assert!(
            !by_path.contains_key("src/unrelated.ts")
                && !by_path.contains_key("src/uploader.ts")
        );
        assert_eq!(
            paths(&list)[0],
            "src/uploader.test.ts",
            "the file's own test scores highest: {list:?}"
        );
        assert_eq!(
            suggest(&ws, "src/uploader.ts", &files, 2, &IgnoreList::none())
                .len(),
            2
        );
    }

    /// The four fixture workspaces of the repository: each file to visualise
    /// gets the files a reader would open next.
    #[test]
    fn the_fixture_workspaces_get_the_companions_a_reader_would_open() {
        let fixtures = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../fixtures");
        for (folder, subject, expected) in [
            (
                "go-orders",
                "internal/orders/handler.go",
                vec![
                    "internal/orders/limiter.go",
                    "internal/orders/store.go",
                    "cmd/intake/main.go",
                ],
            ),
            (
                "cpp-logbuf",
                "src/LogWriter.cpp",
                vec![
                    "include/LogWriter.h",
                    "include/FileSink.h",
                    "src/main.cpp",
                ],
            ),
            (
                "ts-uploader",
                "src/uploader.ts",
                vec!["src/transport.ts", "src/retry.ts", "src/index.ts"],
            ),
            (
                "py-ingest",
                "ingest/pipeline.py",
                vec!["ingest/limits.py", "ingest/sink.py", "ingest/cli.py"],
            ),
        ] {
            let ws = Workspace::open(&fixtures.join(folder)).unwrap();
            ws.start_indexing();
            let began = Instant::now();
            while !ws.index_complete() {
                assert!(
                    began.elapsed() < Duration::from_secs(10),
                    "indexing did not finish"
                );
                std::thread::sleep(Duration::from_millis(5));
            }
            let list = suggest(
                &ws,
                subject,
                &ws.indexed_files(),
                12,
                &IgnoreList::none(),
            );
            for path in expected {
                assert!(
                    paths(&list).contains(&path),
                    "{folder}: {path} is missing from {list:#?}"
                );
            }
        }
    }

    #[test]
    fn ignored_files_and_folders_are_never_suggested() {
        let (_dir, ws, files) = workspace(&[
            (
                "cmd/main.go",
                "package main\n\nimport \
                 (\n\t\"example.com/shop/internal/orders\"\n\t\"github.com/\
                 acme/sdk/client\"\n)\n\nfunc StartServer() {}\n",
            ),
            ("internal/orders/handler.go", "package orders\n"),
            (
                "internal/orders/handler.pb.go",
                "package orders\n// StartServer\n",
            ),
            (
                "vendor/github.com/acme/sdk/client/client.go",
                "package client\n\nimport \"github.com/acme/sdk/wire\"\n",
            ),
            ("vendor/github.com/acme/sdk/wire/wire.go", "package wire\n"),
            ("tools/vendor/notes.go", "package notes\n// StartServer\n"),
        ]);
        let all = suggest(&ws, "cmd/main.go", &files, 12, &IgnoreList::none());
        assert!(
            paths(&all)
                .contains(&"vendor/github.com/acme/sdk/client/client.go")
                && paths(&all)
                    .contains(&"vendor/github.com/acme/sdk/wire/wire.go"),
            "{all:?}"
        );

        // A folder name without a leading slash matches that folder at any
        // depth. The files the ignored client imports are not followed either.
        let list = IgnoreList::new(&[
            "vendor/".to_string(),
            "# generated code".to_string(),
            "".to_string(),
            "*.pb.go".to_string(),
        ]);
        assert_eq!(
            paths(&suggest(&ws, "cmd/main.go", &files, 12, &list)),
            vec!["internal/orders/handler.go"]
        );
        assert!(list.invalid().is_empty());

        // A leading slash ties the pattern to the workspace root.
        let rooted = IgnoreList::new(&["/vendor/".to_string()]);
        assert!(
            rooted.matches("vendor/github.com/acme/sdk/wire/wire.go")
                && !rooted.matches("tools/vendor/notes.go")
        );
        let one_file = IgnoreList::new(&["/vendor/github.com/acme/sdk/wire/\
                                          wire.go"
            .to_string()]);
        assert!(
            one_file.matches("vendor/github.com/acme/sdk/wire/wire.go")
                && !one_file
                    .matches("vendor/github.com/acme/sdk/client/client.go")
        );

        // A later line that starts with `!` takes files back out of the list.
        let except = IgnoreList::new(&[
            "/vendor/**".to_string(),
            "!/vendor/github.com/acme/sdk/wire/**".to_string(),
        ]);
        assert!(
            except.matches("vendor/github.com/acme/sdk/client/client.go")
                && !except.matches("vendor/github.com/acme/sdk/wire/wire.go")
        );
    }

    #[test]
    fn a_check_counts_what_patterns_match_and_names_the_ones_it_cannot_read() {
        let files: Vec<String> = [
            "vendor/a/a.go",
            "vendor/a/README.md",
            "vendor/b/b.go",
            "src/main.go",
        ]
        .iter()
        .map(|f| f.to_string())
        .collect();
        let asked =
            vec!["vendor/b/b.go".to_string(), "src/main.go".to_string()];
        let check = check_ignore(
            &["/vendor/a/".to_string(), "/vendor/b/".to_string()],
            &files,
            &asked,
        );
        assert_eq!(
            (check.matched, check.examples.len()),
            (2, 2),
            "only code files are counted"
        );
        assert_eq!(check.matched_paths, vec!["vendor/b/b.go"]);
        let broken =
            check_ignore(&["src/[z-a].go".to_string()], &files, &asked);
        assert_eq!(
            (broken.matched, broken.invalid),
            (0, vec!["src/[z-a].go".to_string()])
        );
    }

    #[test]
    fn a_folder_is_described_by_its_code_files_and_their_size() {
        let (_dir, ws, files) = workspace(&[
            ("pkg/a.go", &"x".repeat(4000)),
            ("pkg/sub/b.go", &"y".repeat(2000)),
            ("pkg/README.md", "docs"),
            ("pkg/data.json", "{}"),
            ("other/c.go", "package c\n"),
        ]);
        let info = folder_info(&ws, "pkg/", &files);
        assert_eq!(
            (info.rel_path.as_str(), info.name.as_str()),
            ("pkg", "pkg")
        );
        assert_eq!(info.files, vec!["pkg/a.go", "pkg/sub/b.go"]);
        assert_eq!(
            (
                info.bytes,
                info.estimated_tokens,
                info.large,
                info.too_large
            ),
            (6000, 1500, false, false)
        );
        assert_eq!(folder_info(&ws, "", &files).files.len(), 3);
        let many: Vec<String> = (0..=FOLDER_MAX_FILES)
            .map(|i| format!("big/f{i}.go"))
            .collect();
        assert!(folder_info(&ws, "big", &many).too_large);
    }

    #[test]
    fn headers_python_modules_and_go_packages_are_resolved() {
        let (_dir, ws, files) = workspace(&[
            (
                "src/LogWriter.cpp",
                "#include \"LogWriter.h\"\n#include \"FileSink.h\"\n#include \
                 <map>\n",
            ),
            ("include/LogWriter.h", "class LogWriter {};\n"),
            ("include/FileSink.h", "class FileSink {};\n"),
            (
                "ingest/pipeline.py",
                "from ingest.limits import REJECT_SOFT_LIMIT\nfrom .sink \
                 import Sink\n",
            ),
            ("ingest/limits.py", "REJECT_SOFT_LIMIT = 3\n"),
            ("ingest/sink.py", "class Sink: pass\n"),
            (
                "cmd/intake/main.go",
                "package main\n\nimport \
                 (\n\t\"fmt\"\n\t\"example.com/shop/internal/orders\"\n)\n",
            ),
            ("internal/orders/handler.go", "package orders\n"),
            ("internal/orders/store.go", "package orders\n"),
        ]);
        assert_eq!(
            paths(&suggest(
                &ws,
                "src/LogWriter.cpp",
                &files,
                12,
                &IgnoreList::none()
            )),
            vec!["include/LogWriter.h", "include/FileSink.h"]
        );
        let python =
            suggest(&ws, "ingest/pipeline.py", &files, 12, &IgnoreList::none());
        assert!(
            paths(&python).contains(&"ingest/limits.py")
                && paths(&python).contains(&"ingest/sink.py"),
            "{python:?}"
        );
        let go =
            suggest(&ws, "cmd/intake/main.go", &files, 12, &IgnoreList::none());
        assert_eq!(
            paths(&go),
            vec!["internal/orders/handler.go", "internal/orders/store.go"]
        );
    }
}
