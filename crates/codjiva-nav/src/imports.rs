//! Which files a source file imports.
//!
//! The answers come from regular expressions over the text, so they work in
//! any language without parsing it. Two things use them. Navigation ranks a
//! definition higher when it is in a file that the file being read imports.
//! The companion suggestions for a film start from the files the subject
//! imports.

pub use crate::text::{dir_of, without_extension};
use regex::Regex;
use std::collections::{BTreeSet, HashMap};
use std::sync::{Arc, OnceLock};

fn regex(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("the pattern is valid"))
}

/// The module names and paths the subject's text imports, includes or requires.
///
/// The patterns cover the common forms: a quoted path after `import`, `from`,
/// `require`, `include`, `load` or `source`; a dotted or `::` separated name
/// after `import`, `from`, `use` or `using`, with leading dots for a relative
/// Python import; and the quoted lines of a Go import block.
pub fn imported_specifiers(text: &str) -> Vec<String> {
    static QUOTED: OnceLock<Regex> = OnceLock::new();
    static NAMED: OnceLock<Regex> = OnceLock::new();
    static GO_BLOCK: OnceLock<Regex> = OnceLock::new();
    static GO_LINE: OnceLock<Regex> = OnceLock::new();
    let quoted = regex(
        &QUOTED,
        r#"(?m)(?:^\s*#\s*(?:include|import)\s*|\b(?:import|from|require|include|include_once|require_once|require_relative|load|source)\b[^"'`\n;]*?)["'<]([^"'>\n]+)["'>]"#,
    );
    let named = regex(
        &NAMED,
        r"(?m)^\s*(?:pub\s+)?(?:import|from|use|using)\s+(?:static\s+)?(\.*[A-Za-z_][\w.:]*)",
    );
    let go_block = regex(&GO_BLOCK, r"(?s)\bimport\s*\(([^)]*)\)");
    let go_line = regex(&GO_LINE, r#""([^"\n]+)""#);

    let mut found: BTreeSet<String> = BTreeSet::new();
    for capture in quoted.captures_iter(text) {
        found.insert(capture[1].trim().to_string());
    }
    for capture in named.captures_iter(text) {
        let name = capture[1].trim_end_matches(['.', ':']);
        // Leading dots are Python's relative imports: one dot is the file's own
        // package, and each further dot is one package up.
        let dots = name.len() - name.trim_start_matches('.').len();
        let prefix = if dots == 0 {
            String::new()
        } else {
            format!("./{}", "../".repeat(dots - 1))
        };
        found.insert(format!(
            "{prefix}{}",
            name[dots..].replace("::", "/").replace('.', "/")
        ));
    }
    for block in go_block.captures_iter(text) {
        for line in go_line.captures_iter(&block[1]) {
            found.insert(line[1].to_string());
        }
    }
    found.into_iter().filter(|s| !s.is_empty()).collect()
}

/// Joins a relative specifier such as `./util` or `../lib/a.h` onto a folder,
/// resolving `.` and `..`. Returns `None` when it would leave the workspace.
fn join_relative(dir: &str, specifier: &str) -> Option<String> {
    let mut parts: Vec<&str> =
        dir.split('/').filter(|p| !p.is_empty()).collect();
    for part in specifier.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            other => parts.push(other),
        }
    }
    Some(parts.join("/"))
}

/// The last part of a path: `retry` for `src/lib/retry`.
fn last_part(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// The workspace files one import specifier names.
///
/// Three ways are tried, and the first that finds something is used:
///   1. The specifier as a path relative to the subject's folder, with or
///      without an extension, or as a folder that holds an index file.
///   2. A file anywhere whose path without extension ends with the specifier.
///      This finds `ingest/limits.py` for `ingest.limits` and
///      `include/LogWriter.h` for `LogWriter.h`.
///   3. A folder anywhere whose path ends with the specifier's last two parts.
///      This finds the files of a Go package for its import path.
///
/// This function compares the specifier with every file. [`FileNames`] gives
/// the same answer faster when many specifiers are resolved against one
/// list of files.
pub fn resolve<'a>(
    specifier: &str,
    subject: &str,
    files: &'a [String],
) -> Vec<&'a String> {
    resolve_among(specifier, subject, |_| files.iter().collect())
}

/// Does the work of [`resolve`]. `among` is given a few names and returns
/// the files to compare the specifier with, in the order of the workspace's
/// file list. It must return at least every file whose name without its
/// extension is one of those names, and every file in a folder that has one
/// of those names. It may return more.
fn resolve_among<'a>(
    specifier: &str,
    subject: &str,
    among: impl FnOnce(&[&str]) -> Vec<&'a String>,
) -> Vec<&'a String> {
    let clean = specifier
        .trim_start_matches("@/")
        .trim_start_matches("~/")
        .trim_start_matches("$lib/")
        .trim_matches('/');
    if clean.is_empty() {
        return Vec::new();
    }
    let spec_stem = without_extension(clean);
    let joined = join_relative(dir_of(subject), clean);
    let tail = spec_stem.trim_start_matches("./").trim_start_matches("../");
    let parts: Vec<&str> = tail.split('/').collect();
    let folder = parts[parts.len().saturating_sub(2)..].join("/");

    let mut names = vec![
        last_part(tail),
        without_extension(last_part(clean)),
        last_part(&folder),
    ];
    if let Some(joined) = &joined {
        names.push(last_part(joined));
        names.push(last_part(without_extension(joined)));
    }
    // A file never imports itself, whatever the specifier looks like.
    // `LogWriter.h`, included by `src/LogWriter.cpp`, must not be matched to
    // that same source file because the two share a base name.
    let mut others = among(&names);
    others.retain(|f| f.as_str() != subject);

    if let Some(joined) = joined {
        let stem = without_extension(&joined);
        let direct: Vec<&String> = others
            .iter()
            .copied()
            .filter(|f| {
                let file_stem = without_extension(f);
                **f == joined
                    || file_stem == joined
                    || file_stem == stem
                    || (dir_of(f) == joined
                        && matches!(
                            without_extension(last_part(f)),
                            "index" | "mod" | "__init__"
                        ))
            })
            .collect();
        if !direct.is_empty() {
            return direct;
        }
    }

    // True when `path` is `end` or ends with a slash and `end`. `slashed` is
    // `end` with the slash in front of it.
    let ends_with_path = |path: &str, end: &str, slashed: &str| {
        path == end || path.ends_with(slashed)
    };
    let (slashed_tail, slashed_clean) =
        (format!("/{tail}"), format!("/{clean}"));
    let by_file: Vec<&String> = others
        .iter()
        .copied()
        .filter(|f| {
            ends_with_path(without_extension(f), tail, &slashed_tail)
                || ends_with_path(f, clean, &slashed_clean)
        })
        .collect();
    if !by_file.is_empty() {
        return by_file;
    }

    let slashed_folder = format!("/{folder}");
    others
        .into_iter()
        .filter(|f| ends_with_path(dir_of(f), &folder, &slashed_folder))
        .take(6)
        .collect()
}

/// The files of a workspace, arranged so that [`FileNames::resolve`] finds
/// the files an import names without comparing it with every file.
pub struct FileNames {
    files: Arc<Vec<String>>,
    /// For a name, the positions in `files` of every file that has this name
    /// without its extension, and of every file in a folder of this name.
    by_name: HashMap<String, Vec<u32>>,
}

impl FileNames {
    pub fn new(files: Arc<Vec<String>>) -> FileNames {
        let mut by_name: HashMap<String, Vec<u32>> = HashMap::new();
        for (at, file) in files.iter().enumerate() {
            let name = without_extension(last_part(file));
            let folder = last_part(dir_of(file));
            by_name.entry(name.to_string()).or_default().push(at as u32);
            if folder != name {
                by_name
                    .entry(folder.to_string())
                    .or_default()
                    .push(at as u32);
            }
        }
        FileNames { files, by_name }
    }

    /// The list of files these tables were built from.
    pub fn files(&self) -> &Arc<Vec<String>> {
        &self.files
    }

    /// The same answer as [`resolve`] gives for these files.
    pub fn resolve(&self, specifier: &str, subject: &str) -> Vec<&String> {
        resolve_among(specifier, subject, |names| {
            let mut found: Vec<u32> = names
                .iter()
                .filter_map(|name| self.by_name.get(*name))
                .flatten()
                .copied()
                .collect();
            found.sort_unstable();
            found.dedup();
            found.iter().map(|at| &self.files[*at as usize]).collect()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn import_forms_of_several_languages_are_recognised() {
        let text = "import { a } from './transport';\nconst r = \
                    require(\"../lib/retry\");\n#include \
                    \"LogWriter.h\"\n#include <vector>\nfrom ingest.limits \
                    import X\nimport os.path\nuse \
                    crate::agents::process;\nusing System.Text;\nimport \
                    (\n\t\"fmt\"\n\t\"example.com/shop/internal/orders\"\n)\n";
        let found = imported_specifiers(text);
        for expected in [
            "./transport",
            "../lib/retry",
            "LogWriter.h",
            "vector",
            "ingest/limits",
            "os/path",
            "crate/agents/process",
            "System/Text",
            "fmt",
            "example.com/shop/internal/orders",
        ] {
            assert!(
                found.iter().any(|f| f == expected),
                "{expected} is missing from {found:?}"
            );
        }
    }

    #[test]
    fn a_specifier_is_matched_to_the_files_it_names() {
        let files: Vec<String> = [
            "include/LogWriter.h",
            "ingest/limits.py",
            "internal/orders/handler.go",
            "internal/orders/store.go",
            "src/retry.ts",
            "src/uploader.ts",
        ]
        .iter()
        .map(|f| f.to_string())
        .collect();
        let named = |specifier: &str, subject: &str| -> Vec<String> {
            let found: Vec<String> = resolve(specifier, subject, &files)
                .into_iter()
                .cloned()
                .collect();
            // The tables give the same answer as the comparison with every
            // file.
            let names = FileNames::new(Arc::new(files.clone()));
            let quick: Vec<String> = names
                .resolve(specifier, subject)
                .into_iter()
                .cloned()
                .collect();
            assert_eq!(found, quick, "{specifier} from {subject}");
            found
        };
        assert_eq!(named("./retry", "src/uploader.ts"), ["src/retry.ts"]);
        assert_eq!(
            named("LogWriter.h", "src/LogWriter.cpp"),
            ["include/LogWriter.h"]
        );
        assert_eq!(
            named("ingest/limits", "ingest/pipeline.py"),
            ["ingest/limits.py"]
        );
        assert_eq!(
            named("example.com/shop/internal/orders", "cmd/intake/main.go"),
            ["internal/orders/handler.go", "internal/orders/store.go"]
        );
        assert!(named("fmt", "cmd/intake/main.go").is_empty());
        // A specifier that could only name the importing file names
        // nothing.
        assert!(named("./uploader", "src/uploader.ts").is_empty());
    }
}
