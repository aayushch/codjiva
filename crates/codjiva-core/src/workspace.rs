//! A workspace: the folder of code the user opened.
//!
//! This module only reads the folder. It lists directories one level at a time so that very
//! large repositories open instantly, follows the repository's ignore rules, and describes
//! single files for the editor area. Paths that cross the app boundary are always relative to
//! the workspace root and use `/` as the separator on every platform.

use crate::error::{AppError, Result};
use crate::lang;
use crate::names::DOT_DIR;
use ignore::WalkBuilder;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};

/// Files larger than this are described by size only: they are not hashed and their lines are
/// not counted when the user merely selects them.
const DESCRIBE_LIMIT_BYTES: u64 = 20 * 1024 * 1024;

/// The source viewer shows at most this much of a file.
pub const VIEW_LIMIT_BYTES: usize = 2 * 1024 * 1024;

/// The quick-open index stops after this many files, so a pathological folder cannot exhaust
/// memory.
const INDEX_LIMIT_FILES: usize = 300_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    File,
    Dir,
}

/// One row of the file tree.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeEntry {
    pub name: String,
    pub rel_path: String,
    pub kind: EntryKind,
    /// The language label for files whose name reveals it.
    pub lang: Option<String>,
    pub size: Option<u64>,
}

/// What the editor area shows about a selected file before any artifact exists.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    pub rel_path: String,
    pub name: String,
    pub lang: Option<String>,
    /// The language id the source viewer's highlighter uses, or empty for plain text.
    pub highlighter: String,
    pub bytes: u64,
    /// `None` for binary files and for files above the describe limit.
    pub lines: Option<u64>,
    /// `sha256:<hex>` of the file's bytes, or `None` above the describe limit.
    pub hash: Option<String>,
    pub binary: bool,
}

/// The text of a file for the read-only source viewer.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub rel_path: String,
    pub text: String,
    /// True when the file is longer than the viewer's limit and `text` holds only its beginning.
    pub truncated: bool,
    pub highlighter: String,
}

/// One result of a quick-open search.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileHit {
    pub rel_path: String,
    pub name: String,
}

/// The list of every file in the workspace that the ignore rules do not hide. It is filled by a
/// background thread, so searches work while it is still growing.
#[derive(Default)]
struct FileIndex {
    files: RwLock<Vec<String>>,
    complete: AtomicBool,
    /// Set while a walk is running, so that two walks never run at once.
    walking: AtomicBool,
}

pub struct Workspace {
    root: PathBuf,
    name: String,
    index: Arc<FileIndex>,
}

/// Converts a path inside the workspace to the `/`-separated form used across the app boundary.
pub fn to_rel_string(rel: &Path) -> String {
    rel.components().filter_map(|c| match c {
        Component::Normal(part) => Some(part.to_string_lossy().into_owned()),
        _ => None,
    }).collect::<Vec<_>>().join("/")
}

/// Hashes bytes the way manifests record source files: `sha256:` followed by lower-case hex.
pub fn hash_bytes(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(7 + digest.len() * 2);
    out.push_str("sha256:");
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// Returns true when the bytes look like something other than text. A NUL byte in the first
/// 8 KB is the test version-control tools use, and it is right for source code.
fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8192).any(|b| *b == 0)
}

/// A walker that applies the rules the tree and the index share: ignore files are honoured,
/// dot-files are shown, and the version-control folder and Codjiva's own folder are left out.
pub(crate) fn walker(dir: &Path) -> WalkBuilder {
    let mut builder = WalkBuilder::new(dir);
    builder.hidden(false).parents(true).git_ignore(true).git_exclude(true).git_global(true).require_git(false)
        .filter_entry(|entry| {
            let name = entry.file_name();
            name != ".git" && name != DOT_DIR
        });
    builder
}

impl Workspace {
    /// Opens the folder at `path`. Fails when it does not exist or is not a folder.
    pub fn open(path: &Path) -> Result<Workspace> {
        let root = fs::canonicalize(path).map_err(|e| AppError::io("open that folder", e))?;
        if !root.is_dir() {
            return Err(AppError::new("not_a_folder", "That path is a file. Open the folder that contains your code."));
        }
        let name = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| root.to_string_lossy().into_owned());
        Ok(Workspace { root, name, index: Arc::new(FileIndex::default()) })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    /// The folder that holds everything Codjiva generates for this workspace.
    pub fn dot_dir(&self) -> PathBuf {
        self.root.join(DOT_DIR)
    }

    /// Turns a workspace-relative path into an absolute one, refusing any path that would leave
    /// the workspace. A path may not be absolute or contain `..`, and if it exists and goes
    /// through a symbolic link, the link's target must also be inside the workspace.
    pub fn resolve(&self, rel: &str) -> Result<PathBuf> {
        let outside = || AppError::new("outside_workspace", "That path is outside the open folder.");
        let rel_path = Path::new(rel);
        if rel_path.components().any(|c| !matches!(c, Component::Normal(_) | Component::CurDir)) {
            return Err(outside());
        }
        let full = self.root.join(rel_path);
        if let Ok(real) = fs::canonicalize(&full) {
            if !real.starts_with(&self.root) {
                return Err(outside());
            }
        }
        Ok(full)
    }

    /// The workspace-relative form of an absolute path, or `None` when it is not inside.
    pub fn relative(&self, absolute: &Path) -> Option<String> {
        absolute.strip_prefix(&self.root).ok().map(to_rel_string)
    }

    /// Lists one directory: folders first, then files, each group in name order ignoring case.
    /// `rel_dir` is `""` for the workspace root.
    pub fn children(&self, rel_dir: &str) -> Result<Vec<TreeEntry>> {
        let dir = self.resolve(rel_dir)?;
        if !dir.is_dir() {
            return Err(AppError::new("not_found", "That folder no longer exists."));
        }
        let mut entries = Vec::new();
        for item in walker(&dir).max_depth(Some(1)).build().flatten() {
            if item.depth() == 0 {
                continue;
            }
            let path = item.path();
            let Some(rel) = self.relative(path) else { continue };
            let name = item.file_name().to_string_lossy().into_owned();
            let is_dir = item.file_type().is_some_and(|t| t.is_dir()) || path.is_dir();
            entries.push(TreeEntry {
                lang: if is_dir { None } else { lang::of_file_name(&name).map(|l| l.label.to_string()) },
                size: if is_dir { None } else { item.metadata().ok().map(|m| m.len()) },
                kind: if is_dir { EntryKind::Dir } else { EntryKind::File },
                rel_path: rel,
                name,
            });
        }
        entries.sort_by(|a, b| (a.kind == EntryKind::File, a.name.to_lowercase()).cmp(&(b.kind == EntryKind::File, b.name.to_lowercase())));
        Ok(entries)
    }

    /// Describes one file: its language, size, line count and content hash.
    pub fn file_info(&self, rel: &str) -> Result<FileInfo> {
        let path = self.resolve(rel)?;
        let meta = fs::metadata(&path).map_err(|e| AppError::io("read that file", e))?;
        if meta.is_dir() {
            return Err(AppError::new("not_a_file", "That path is a folder."));
        }
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let language = lang::of_file_name(&name);
        let mut info = FileInfo {
            rel_path: rel.to_string(),
            lang: language.map(|l| l.label.to_string()),
            highlighter: language.map(|l| l.highlighter.to_string()).unwrap_or_default(),
            bytes: meta.len(),
            lines: None,
            hash: None,
            binary: false,
            name,
        };
        if meta.len() <= DESCRIBE_LIMIT_BYTES {
            let bytes = fs::read(&path).map_err(|e| AppError::io("read that file", e))?;
            info.binary = looks_binary(&bytes);
            info.hash = Some(hash_bytes(&bytes));
            if !info.binary {
                let newlines = bytes.iter().filter(|b| **b == b'\n').count() as u64;
                // A last line without a trailing newline still counts as a line.
                info.lines = Some(newlines + u64::from(bytes.last().is_some_and(|b| *b != b'\n')));
            }
        }
        Ok(info)
    }

    /// The content hash of a file, or `None` when it cannot be read. Staleness compares this
    /// with the hash recorded when an artifact was made.
    pub fn hash_file(&self, rel: &str) -> Option<String> {
        let path = self.resolve(rel).ok()?;
        fs::read(path).ok().map(|bytes| hash_bytes(&bytes))
    }

    /// Reads a file for the source viewer. Bytes that are not valid UTF-8 are replaced, and a
    /// file longer than the viewer's limit is cut at a line break.
    pub fn read_text(&self, rel: &str) -> Result<FileContent> {
        let path = self.resolve(rel)?;
        let bytes = fs::read(&path).map_err(|e| AppError::io("read that file", e))?;
        if looks_binary(&bytes) {
            return Err(AppError::new("binary_file", "This file is not text, so there is no source to show."));
        }
        let truncated = bytes.len() > VIEW_LIMIT_BYTES;
        let shown = if truncated {
            let cut = bytes[..VIEW_LIMIT_BYTES].iter().rposition(|b| *b == b'\n').map_or(VIEW_LIMIT_BYTES, |i| i + 1);
            &bytes[..cut]
        } else {
            &bytes[..]
        };
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        Ok(FileContent {
            rel_path: rel.to_string(),
            text: String::from_utf8_lossy(shown).into_owned(),
            truncated,
            highlighter: lang::of_file_name(&name).map(|l| l.highlighter.to_string()).unwrap_or_default(),
        })
    }

    /// Starts listing every file of the workspace on a background thread, for quick-open. Does
    /// nothing when a listing is already running. Call it again after files were added or
    /// removed to refresh the list.
    pub fn start_indexing(&self) {
        if self.index.walking.swap(true, Ordering::SeqCst) {
            return;
        }
        let index = Arc::clone(&self.index);
        let root = self.root.clone();
        std::thread::spawn(move || {
            let mut files = Vec::new();
            for item in walker(&root).build().flatten() {
                if item.file_type().is_some_and(|t| t.is_file()) {
                    if let Ok(rel) = item.path().strip_prefix(&root) {
                        files.push(to_rel_string(rel));
                    }
                    if files.len() >= INDEX_LIMIT_FILES {
                        break;
                    }
                }
            }
            files.sort_unstable();
            *index.files.write().expect("the file index lock is not poisoned") = files;
            index.complete.store(true, Ordering::SeqCst);
            index.walking.store(false, Ordering::SeqCst);
        });
    }

    /// Every file of the workspace as the last listing found it, as paths relative to the
    /// root. Empty until the first listing has finished.
    pub fn indexed_files(&self) -> Vec<String> {
        self.index.files.read().expect("the file index lock is not poisoned").clone()
    }

    /// True once the first full listing has finished.
    pub fn index_complete(&self) -> bool {
        self.index.complete.load(Ordering::SeqCst)
    }

    /// Finds files whose path contains the letters of `query` in order, best matches first.
    /// An empty query returns nothing.
    pub fn search_files(&self, query: &str, limit: usize) -> Vec<FileHit> {
        let needle: Vec<char> = query.chars().filter(|c| !c.is_whitespace()).flat_map(char::to_lowercase).collect();
        if needle.is_empty() {
            return Vec::new();
        }
        let files = self.index.files.read().expect("the file index lock is not poisoned");
        let mut scored: Vec<(i64, &String)> = files.iter().filter_map(|path| fuzzy_score(path, &needle).map(|s| (s, path))).collect();
        scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.len().cmp(&b.1.len())).then_with(|| a.1.cmp(b.1)));
        scored.into_iter().take(limit).map(|(_, path)| FileHit {
            name: path.rsplit('/').next().unwrap_or(path).to_string(),
            rel_path: path.clone(),
        }).collect()
    }
}

/// Scores how well `path` matches the lower-cased letters in `needle`, or returns `None` when the
/// letters do not all appear in order.
///
/// A higher score is a better match. Each matched letter scores 1, plus 3 when it is inside the
/// file name, plus 5 when it starts a word (after `/`, `_`, `-`, `.`, or at a change from lower
/// to upper case), plus 4 when it directly follows the previous matched letter. Letters of the
/// file extension never count as starting a word, so `obw` prefers `OrderBatchWriter.cpp` to
/// `job.ws`. A path can contain the letters in several ways, and the score is that of the best
/// way, so `obw` finds the capitals of `OrderBatchWriter` instead of the first `o`, `b` and `w`
/// in the path.
fn fuzzy_score(path: &str, needle: &[char]) -> Option<i64> {
    let chars: Vec<char> = path.chars().collect();
    let lower: Vec<char> = chars.iter().map(|c| c.to_lowercase().next().unwrap_or(*c)).collect();

    // A cheap test first: most paths do not contain the letters at all.
    let mut want = 0;
    for c in &lower {
        if want < needle.len() && *c == needle[want] {
            want += 1;
        }
    }
    if want < needle.len() {
        return None;
    }

    let name_start = chars.iter().rposition(|c| *c == '/').map_or(0, |i| i + 1);
    // Where the file extension begins: the last dot of the file name, unless the name starts
    // with it, as in `.gitignore`.
    let extension_start = chars.iter().rposition(|c| *c == '.').filter(|i| *i > name_start).unwrap_or(chars.len());
    let gain = |i: usize| -> i64 {
        let word_start = i < extension_start
            && (i == 0 || matches!(chars[i - 1], '/' | '_' | '-' | '.' | ' ') || (chars[i - 1].is_lowercase() && chars[i].is_uppercase()));
        1 + if i >= name_start { 3 } else { 0 } + if word_start { 5 } else { 0 }
    };

    // previous[j] is the best score of matching the letters so far with the last one at
    // position j, or None when that is impossible.
    let mut previous: Vec<Option<i64>> = lower.iter().enumerate().map(|(j, c)| (*c == needle[0]).then(|| gain(j))).collect();
    for letter in &needle[1..] {
        let mut current: Vec<Option<i64>> = vec![None; lower.len()];
        // The best score among all earlier positions of the previous letter.
        let mut best_before: Option<i64> = None;
        for j in 0..lower.len() {
            if j > 0 {
                best_before = best_before.max(previous[j - 1]);
            }
            if lower[j] != *letter {
                continue;
            }
            let adjacent = if j > 0 { previous[j - 1].map(|s| s + 4) } else { None };
            if let Some(base) = best_before.max(adjacent) {
                current[j] = Some(base + gain(j));
            }
        }
        previous = current;
    }
    previous.into_iter().flatten().max()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    fn workspace_with(files: &[(&str, &str)]) -> (tempfile::TempDir, Workspace) {
        let dir = tempfile::tempdir().unwrap();
        for (rel, text) in files {
            let path = dir.path().join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, text).unwrap();
        }
        let ws = Workspace::open(dir.path()).unwrap();
        (dir, ws)
    }

    fn wait_for_index(ws: &Workspace) {
        ws.start_indexing();
        let began = Instant::now();
        while !ws.index_complete() {
            assert!(began.elapsed() < Duration::from_secs(10), "indexing did not finish");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn lists_folders_first_and_honours_ignore_rules() {
        let (_dir, ws) = workspace_with(&[
            (".gitignore", "build/\n*.log\n"),
            ("src/main.go", "package main\n"),
            ("build/out.bin", "x"),
            ("debug.log", "x"),
            ("README.md", "# hi\n"),
            (".codjiva/config.json", "{}"),
            (".git/HEAD", "ref"),
            ("Zeta.txt", "z"),
        ]);
        let names: Vec<String> = ws.children("").unwrap().into_iter().map(|e| e.name).collect();
        assert_eq!(names, vec!["src", ".gitignore", "README.md", "Zeta.txt"]);
        let inner = ws.children("src").unwrap();
        assert_eq!(inner[0].rel_path, "src/main.go");
        assert_eq!(inner[0].lang.as_deref(), Some("Go"));
    }

    #[test]
    fn refuses_paths_that_leave_the_workspace() {
        let (_dir, ws) = workspace_with(&[("a.txt", "a")]);
        for bad in ["../x", "/etc/passwd", "a/../../x"] {
            assert_eq!(ws.resolve(bad).unwrap_err().code, "outside_workspace", "{bad}");
        }
        assert!(ws.resolve("a.txt").is_ok());
        assert!(ws.resolve("new/file/that/does/not/exist.txt").is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_symbolic_link_that_points_outside() {
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.txt"), "s").unwrap();
        let (dir, ws) = workspace_with(&[("a.txt", "a")]);
        std::os::unix::fs::symlink(outside.path(), dir.path().join("link")).unwrap();
        assert_eq!(ws.resolve("link/secret.txt").unwrap_err().code, "outside_workspace");
    }

    #[test]
    fn describes_a_text_file_and_a_binary_file() {
        let (_dir, ws) = workspace_with(&[("a.py", "x = 1\ny = 2"), ("b.bin", "a\0b")]);
        let info = ws.file_info("a.py").unwrap();
        assert_eq!((info.lines, info.bytes, info.binary), (Some(2), 11, false));
        assert_eq!(info.lang.as_deref(), Some("Python"));
        assert!(info.hash.unwrap().starts_with("sha256:"));
        let binary = ws.file_info("b.bin").unwrap();
        assert_eq!((binary.lines, binary.binary), (None, true));
        assert_eq!(ws.read_text("b.bin").unwrap_err().code, "binary_file");
    }

    #[test]
    fn hash_changes_when_the_file_changes() {
        let (dir, ws) = workspace_with(&[("a.txt", "one")]);
        let before = ws.hash_file("a.txt").unwrap();
        assert_eq!(before, hash_bytes(b"one"));
        fs::write(dir.path().join("a.txt"), "two").unwrap();
        assert_ne!(ws.hash_file("a.txt").unwrap(), before);
        assert!(ws.hash_file("missing.txt").is_none());
    }

    #[test]
    fn quick_open_prefers_file_name_matches_and_skips_ignored_files() {
        let (_dir, ws) = workspace_with(&[
            (".gitignore", "node_modules/\n"),
            ("core/orders/OrderBatchWriter.cpp", ""),
            ("core/orders/OrderBatchWriter.h", ""),
            ("docs/order_batch_notes.md", ""),
            ("node_modules/obw/index.js", ""),
            ("jobs/sweep.go", ""),
        ]);
        wait_for_index(&ws);
        let hits: Vec<String> = ws.search_files("obw", 10).into_iter().map(|h| h.rel_path).collect();
        assert!(hits[0].ends_with("OrderBatchWriter.h") || hits[0].ends_with("OrderBatchWriter.cpp"), "{hits:?}");
        assert!(!hits.iter().any(|h| h.contains("node_modules")), "{hits:?}");
        assert!(ws.search_files("", 10).is_empty());
        // The capitals of a name beat the same letters spread over a name and its extension.
        assert!(fuzzy_score("src/OrderBatchWriter.cpp", &['o', 'b', 'w']) > fuzzy_score("src/job.ws", &['o', 'b', 'w']));
        assert!(ws.search_files("zzzz", 10).is_empty());
    }

    #[test]
    fn lists_one_level_of_a_very_large_folder_quickly() {
        let dir = tempfile::tempdir().unwrap();
        for d in 0..200 {
            let sub = dir.path().join(format!("pkg{d:03}"));
            fs::create_dir(&sub).unwrap();
            for f in 0..100 {
                fs::write(sub.join(format!("file{f:03}.rs")), "").unwrap();
            }
        }
        let ws = Workspace::open(dir.path()).unwrap();
        let began = Instant::now();
        let top = ws.children("").unwrap();
        let one = ws.children("pkg100").unwrap();
        assert_eq!((top.len(), one.len()), (200, 100));
        assert!(began.elapsed() < Duration::from_millis(500), "listing took {:?}", began.elapsed());
    }
}
