//! The tools the app offers a model when it runs the agent loop itself.
//!
//! A model reached through an API key has no hands of its own, so the app gives it five tools.
//! Four read: list a folder, read a file, search the workspace. One writes, and only inside the
//! version folder of the artifact being made. The last one, `finish`, ends the turn. Because the
//! app carries out every call, the rule "write only inside `.codjiva/`" is enforced here exactly,
//! not left to the model.

use crate::error::AppError;
use crate::workspace::{to_rel_string, EntryKind, Workspace};
use ignore::overrides::OverrideBuilder;
use ignore::WalkBuilder;
use serde_json::{json, Value};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

/// The most lines one `read_file` call returns. A longer file is read in several calls.
const READ_LIMIT_LINES: usize = 800;
/// The most characters one `read_file` call returns, for files with very long lines.
const READ_LIMIT_CHARS: usize = 60_000;
const LIST_LIMIT_ENTRIES: usize = 500;
const SEARCH_LIMIT_MATCHES: usize = 100;
/// A matched line is cut to this many characters in search results.
const SEARCH_LINE_CHARS: usize = 200;
/// Files larger than this are skipped by `search`.
const SEARCH_FILE_BYTES: u64 = 2 * 1024 * 1024;
const WRITE_LIMIT_BYTES: usize = 1024 * 1024;

/// A tool as it is described to a model: a name, what it does, and the JSON Schema of its input.
#[derive(Debug, Clone)]
pub struct ToolSpec {
    pub name: &'static str,
    pub description: String,
    pub input_schema: Value,
}

/// What a tool call produced.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolOutput {
    /// The text sent back to the model.
    pub content: String,
    /// True when the call failed. The text then says why, so the model can correct itself.
    pub is_error: bool,
    /// The workspace-relative path the call wrote, for `write_file`.
    pub wrote: Option<String>,
    /// The model's closing summary, for `finish`.
    pub finished: Option<String>,
}

impl ToolOutput {
    fn ok(content: impl Into<String>) -> Self {
        ToolOutput { content: content.into(), is_error: false, wrote: None, finished: None }
    }

    fn error(content: impl Into<String>) -> Self {
        ToolOutput { content: content.into(), is_error: true, wrote: None, finished: None }
    }
}

pub struct ToolBox {
    workspace: Arc<Workspace>,
    /// The only folder `write_file` may write into.
    artifact_dir: PathBuf,
}

fn object_schema(properties: Value, required: &[&str]) -> Value {
    json!({ "type": "object", "properties": properties, "required": required, "additionalProperties": false })
}

impl ToolBox {
    pub fn new(workspace: Arc<Workspace>, artifact_dir: PathBuf) -> ToolBox {
        ToolBox { workspace, artifact_dir }
    }

    /// The tools, in a fixed order. The order and wording never change between turns of a job,
    /// because a provider's prompt cache only helps while the start of the request is identical.
    pub fn specs(&self) -> Vec<ToolSpec> {
        let writable = self.workspace.relative(&self.artifact_dir).unwrap_or_default();
        vec![
            ToolSpec {
                name: "list_dir",
                description: "List the entries of a folder in the workspace. Folders end with a slash. Paths are relative to the workspace root; use \"\" for the root.".into(),
                input_schema: object_schema(json!({ "path": { "type": "string", "description": "Folder path relative to the workspace root." } }), &["path"]),
            },
            ToolSpec {
                name: "read_file",
                description: format!("Read a text file of the workspace. Returns the lines with their line numbers, which you need for path:line references. At most {READ_LIMIT_LINES} lines per call; pass start_line and end_line to read a longer file in parts."),
                input_schema: object_schema(json!({
                    "path": { "type": "string", "description": "File path relative to the workspace root." },
                    "start_line": { "type": "integer", "description": "First line to return, counting from 1. Default 1." },
                    "end_line": { "type": "integer", "description": "Last line to return, inclusive. Default: as many as fit." },
                }), &["path"]),
            },
            ToolSpec {
                name: "search",
                description: format!("Search the workspace's text files with a regular expression. Returns up to {SEARCH_LIMIT_MATCHES} matches as path:line: text. Use it to find where a symbol is defined or called."),
                input_schema: object_schema(json!({
                    "pattern": { "type": "string", "description": "A regular expression, for example \"func \\\\w+Flush\" or \"class EventGuard\"." },
                    "glob": { "type": "string", "description": "Optional. Only search files matching this glob, for example \"*.go\" or \"src/**/*.ts\"." },
                }), &["pattern"]),
            },
            ToolSpec {
                name: "write_file",
                description: format!("Create or replace a file. You may only write inside {writable}/ . Give the whole content of the file; there is no partial edit."),
                input_schema: object_schema(json!({
                    "path": { "type": "string", "description": format!("File path relative to the workspace root, inside {writable}/ .") },
                    "content": { "type": "string", "description": "The complete content of the file." },
                }), &["path", "content"]),
            },
            ToolSpec {
                name: "finish",
                description: "Call this once, when every file is written and you have checked your work. It ends your turn.".into(),
                input_schema: object_schema(json!({ "summary": { "type": "string", "description": "One or two sentences on what you made." } }), &["summary"]),
            },
        ]
    }

    /// Carries out one tool call. It never fails outright: a problem with the call comes back
    /// as an error result the model can read.
    pub fn call(&self, name: &str, input: &Value) -> ToolOutput {
        let text = |key: &str| -> Result<&str, ToolOutput> {
            input.get(key).and_then(Value::as_str).ok_or_else(|| ToolOutput::error(format!("The input must have a string \"{key}\".")))
        };
        let result = match name {
            "list_dir" => text("path").map(|path| self.list_dir(path)),
            "read_file" => text("path").map(|path| self.read_file(path, input.get("start_line").and_then(Value::as_u64), input.get("end_line").and_then(Value::as_u64))),
            "search" => text("pattern").map(|pattern| self.search(pattern, input.get("glob").and_then(Value::as_str))),
            "write_file" => text("path").and_then(|path| text("content").map(|content| self.write_file(path, content))),
            "finish" => text("summary").map(|summary| ToolOutput { finished: Some(summary.to_string()), ..ToolOutput::ok("Finished.") }),
            other => Err(ToolOutput::error(format!("There is no tool named \"{other}\"."))),
        };
        result.unwrap_or_else(|error| error)
    }

    fn describe(error: AppError) -> ToolOutput {
        ToolOutput::error(error.message)
    }

    fn list_dir(&self, path: &str) -> ToolOutput {
        match self.workspace.children(path.trim_matches('/')) {
            Err(error) => Self::describe(error),
            Ok(entries) => {
                let total = entries.len();
                let mut lines: Vec<String> = entries.into_iter().take(LIST_LIMIT_ENTRIES).map(|e| match e.kind {
                    EntryKind::Dir => format!("{}/", e.name),
                    EntryKind::File => format!("{} ({} bytes)", e.name, e.size.unwrap_or(0)),
                }).collect();
                if total > LIST_LIMIT_ENTRIES {
                    lines.push(format!("... and {} more entries", total - LIST_LIMIT_ENTRIES));
                }
                ToolOutput::ok(if lines.is_empty() { "(empty folder)".to_string() } else { lines.join("\n") })
            }
        }
    }

    fn read_file(&self, path: &str, start_line: Option<u64>, end_line: Option<u64>) -> ToolOutput {
        // The reference example and schemas live under .codjiva, so the app's own folder is
        // readable. Everything else goes through the workspace's own path checks.
        let full = match self.workspace.resolve(path) {
            Ok(full) => full,
            Err(error) => return Self::describe(error),
        };
        let bytes = match std::fs::read(&full) {
            Ok(bytes) => bytes,
            Err(_) => return ToolOutput::error(format!("{path} does not exist or cannot be read. Use list_dir to see what is there.")),
        };
        if bytes.iter().take(8192).any(|b| *b == 0) {
            return ToolOutput::error(format!("{path} is a binary file."));
        }
        let text = String::from_utf8_lossy(&bytes);
        let lines: Vec<&str> = text.lines().collect();
        let total = lines.len();
        let first = start_line.unwrap_or(1).max(1) as usize;
        if first > total.max(1) {
            return ToolOutput::error(format!("{path} has {total} lines; start_line {first} is past the end."));
        }
        let wanted_last = end_line.map(|e| e as usize).unwrap_or(usize::MAX).min(total);
        let mut out = String::new();
        let mut last = first.saturating_sub(1);
        for (index, line) in lines.iter().enumerate().skip(first - 1).take(READ_LIMIT_LINES) {
            if index + 1 > wanted_last || out.len() + line.len() > READ_LIMIT_CHARS {
                break;
            }
            out.push_str(&format!("{}\t{}\n", index + 1, line));
            last = index + 1;
        }
        if last < wanted_last {
            out.push_str(&format!("[lines {first}-{last} of {total}; call read_file again with start_line {} for more]\n", last + 1));
        } else if first > 1 || last < total {
            out.push_str(&format!("[lines {first}-{last} of {total}]\n"));
        }
        ToolOutput::ok(out)
    }

    fn search(&self, pattern: &str, glob: Option<&str>) -> ToolOutput {
        let regex = match regex::Regex::new(pattern) {
            Ok(regex) => regex,
            Err(error) => return ToolOutput::error(format!("That is not a valid regular expression: {error}")),
        };
        let root = self.workspace.root();
        let mut walker = WalkBuilder::new(root);
        walker.hidden(false).parents(true).git_ignore(true).git_exclude(true).git_global(true).require_git(false)
            .filter_entry(|entry| entry.file_name() != ".git" && entry.file_name() != crate::names::DOT_DIR);
        if let Some(glob) = glob.filter(|g| !g.trim().is_empty()) {
            let mut overrides = OverrideBuilder::new(root);
            if overrides.add(glob).is_err() {
                return ToolOutput::error(format!("\"{glob}\" is not a valid glob."));
            }
            match overrides.build() {
                Ok(built) => { walker.overrides(built); }
                Err(_) => return ToolOutput::error(format!("\"{glob}\" is not a valid glob.")),
            }
        }
        let mut matches: Vec<String> = Vec::new();
        'files: for item in walker.sort_by_file_path(|a, b| a.cmp(b)).build().flatten() {
            if !item.file_type().is_some_and(|t| t.is_file()) || item.metadata().map(|m| m.len() > SEARCH_FILE_BYTES).unwrap_or(true) {
                continue;
            }
            let Ok(bytes) = std::fs::read(item.path()) else { continue };
            if bytes.iter().take(8192).any(|b| *b == 0) {
                continue;
            }
            let Ok(rel) = item.path().strip_prefix(root) else { continue };
            let rel = to_rel_string(rel);
            for (index, line) in String::from_utf8_lossy(&bytes).lines().enumerate() {
                if regex.is_match(line) {
                    let shown: String = line.trim().chars().take(SEARCH_LINE_CHARS).collect();
                    matches.push(format!("{rel}:{}: {shown}", index + 1));
                    if matches.len() >= SEARCH_LIMIT_MATCHES {
                        matches.push(format!("[stopped at {SEARCH_LIMIT_MATCHES} matches; narrow the pattern or add a glob]"));
                        break 'files;
                    }
                }
            }
        }
        ToolOutput::ok(if matches.is_empty() { "No matches.".to_string() } else { matches.join("\n") })
    }

    fn write_file(&self, path: &str, content: &str) -> ToolOutput {
        let allowed = self.workspace.relative(&self.artifact_dir).unwrap_or_default();
        let refuse = || ToolOutput::error(format!("You may only write inside {allowed}/ . Nothing was written."));
        let rel = Path::new(path);
        if rel.components().any(|c| !matches!(c, Component::Normal(_) | Component::CurDir)) {
            return refuse();
        }
        let full = self.workspace.root().join(rel);
        if !full.starts_with(&self.artifact_dir) || full == self.artifact_dir {
            return refuse();
        }
        if full.file_name().is_some_and(|n| n == "index.html") {
            return ToolOutput::error("Do not write index.html. The app builds it from your sources.");
        }
        if content.len() > WRITE_LIMIT_BYTES {
            return ToolOutput::error(format!("The content is {} bytes; a file may be at most {WRITE_LIMIT_BYTES} bytes.", content.len()));
        }
        // A symbolic link inside the artifact folder must not lead a write out of it.
        if let Some(parent) = full.parent() {
            if std::fs::create_dir_all(parent).is_err() {
                return ToolOutput::error("The folder for that file could not be created.");
            }
            match (std::fs::canonicalize(parent), std::fs::canonicalize(&self.artifact_dir)) {
                (Ok(real_parent), Ok(real_allowed)) if real_parent.starts_with(&real_allowed) => {}
                _ => return refuse(),
            }
        }
        match std::fs::write(&full, content) {
            Ok(()) => ToolOutput { wrote: Some(to_rel_string(rel)), ..ToolOutput::ok(format!("Wrote {} bytes to {path}.", content.len())) },
            Err(error) => ToolOutput::error(format!("The file could not be written: {error}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn toolbox() -> (tempfile::TempDir, ToolBox) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("src/orders")).unwrap();
        std::fs::create_dir_all(root.join(".codjiva/artifacts/a/v1/src")).unwrap();
        std::fs::create_dir_all(root.join(".codjiva/jobs/j/reference")).unwrap();
        std::fs::write(root.join("src/orders/handler.go"), (1..=1000).map(|n| format!("line {n}")).collect::<Vec<_>>().join("\n")).unwrap();
        std::fs::write(root.join("src/orders/store.go"), "package orders\n\nfunc Flush() {}\nfunc flushAll() {}\n").unwrap();
        std::fs::write(root.join("README.md"), "# shop\nFlush happens nightly.\n").unwrap();
        std::fs::write(root.join(".codjiva/jobs/j/reference/plant.js"), "CJ.definePlant({});\n").unwrap();
        std::fs::write(root.join("blob.bin"), b"a\0b").unwrap();
        let ws = Arc::new(Workspace::open(root).unwrap());
        let artifact_dir = ws.root().join(".codjiva/artifacts/a/v1");
        (dir, ToolBox::new(ws, artifact_dir))
    }

    #[test]
    fn list_dir_shows_folders_with_a_slash_and_files_with_sizes() {
        let (_dir, tools) = toolbox();
        let out = tools.call("list_dir", &json!({ "path": "src/orders" }));
        assert_eq!(out.content, format!("handler.go ({} bytes)\nstore.go (51 bytes)", 8892));
        assert!(tools.call("list_dir", &json!({ "path": "" })).content.contains("src/"));
        assert!(tools.call("list_dir", &json!({ "path": "../" })).is_error);
    }

    #[test]
    fn read_file_numbers_lines_and_pages_through_a_long_file() {
        let (_dir, tools) = toolbox();
        let first = tools.call("read_file", &json!({ "path": "src/orders/handler.go" }));
        assert!(first.content.starts_with("1\tline 1\n2\tline 2\n"));
        assert!(first.content.ends_with("[lines 1-800 of 1000; call read_file again with start_line 801 for more]\n"), "{}", &first.content[first.content.len() - 120..]);
        let rest = tools.call("read_file", &json!({ "path": "src/orders/handler.go", "start_line": 801 }));
        assert!(rest.content.starts_with("801\tline 801\n") && rest.content.ends_with("[lines 801-1000 of 1000]\n"));
        let part = tools.call("read_file", &json!({ "path": "src/orders/handler.go", "start_line": 10, "end_line": 11 }));
        assert_eq!(part.content, "10\tline 10\n11\tline 11\n[lines 10-11 of 1000]\n");
        // The worked example under the app's own folder is readable.
        assert!(!tools.call("read_file", &json!({ "path": ".codjiva/jobs/j/reference/plant.js" })).is_error);
    }

    #[test]
    fn read_file_explains_what_went_wrong() {
        let (_dir, tools) = toolbox();
        for (input, expected) in [
            (json!({ "path": "missing.go" }), "does not exist"),
            (json!({ "path": "blob.bin" }), "binary file"),
            (json!({ "path": "../outside.txt" }), "outside the open folder"),
            (json!({ "path": "src/orders/store.go", "start_line": 99 }), "past the end"),
            (json!({}), "must have a string \"path\""),
        ] {
            let out = tools.call("read_file", &input);
            assert!(out.is_error && out.content.contains(expected), "{input}: {}", out.content);
        }
    }

    #[test]
    fn search_finds_matches_with_their_lines_and_honours_a_glob() {
        let (_dir, tools) = toolbox();
        let all = tools.call("search", &json!({ "pattern": "[Ff]lush" }));
        assert_eq!(all.content, "README.md:2: Flush happens nightly.\nsrc/orders/store.go:3: func Flush() {}\nsrc/orders/store.go:4: func flushAll() {}");
        let go_only = tools.call("search", &json!({ "pattern": "Flush", "glob": "*.go" }));
        assert_eq!(go_only.content, "src/orders/store.go:3: func Flush() {}");
        assert_eq!(tools.call("search", &json!({ "pattern": "nothing-like-this" })).content, "No matches.");
        assert!(tools.call("search", &json!({ "pattern": "(" })).is_error);
        // The app's own folder is not searched: its copies of sources would double every match.
        assert!(!tools.call("search", &json!({ "pattern": "definePlant" })).content.contains(".codjiva"));
    }

    #[test]
    fn write_file_writes_inside_the_artifact_folder_and_nowhere_else() {
        let (dir, tools) = toolbox();
        let ok = tools.call("write_file", &json!({ "path": ".codjiva/artifacts/a/v1/src/plant.js", "content": "x" }));
        assert_eq!((ok.is_error, ok.wrote.as_deref()), (false, Some(".codjiva/artifacts/a/v1/src/plant.js")));
        let nested = tools.call("write_file", &json!({ "path": ".codjiva/artifacts/a/v1/src/scenes/one.js", "content": "y" }));
        assert!(!nested.is_error && dir.path().join(".codjiva/artifacts/a/v1/src/scenes/one.js").exists());

        for path in ["src/orders/handler.go", "notes.txt", ".codjiva/artifacts/a/v2/x.js", ".codjiva/artifacts/a/v1/../../../../escape.txt", "/tmp/abs.txt", ".codjiva/config.json", ".codjiva/artifacts/a/v1"] {
            let out = tools.call("write_file", &json!({ "path": path, "content": "bad" }));
            assert!(out.is_error && out.content.contains("You may only write inside .codjiva/artifacts/a/v1/"), "{path}: {}", out.content);
        }
        assert!(!dir.path().join("notes.txt").exists());
        assert!(std::fs::read_to_string(dir.path().join("src/orders/handler.go")).unwrap().starts_with("line 1"));
        assert!(tools.call("write_file", &json!({ "path": ".codjiva/artifacts/a/v1/index.html", "content": "x" })).content.contains("Do not write index.html"));
    }

    #[cfg(unix)]
    #[test]
    fn write_file_does_not_follow_a_link_out_of_the_artifact_folder() {
        let (dir, tools) = toolbox();
        std::os::unix::fs::symlink(dir.path().join("src"), dir.path().join(".codjiva/artifacts/a/v1/link")).unwrap();
        let out = tools.call("write_file", &json!({ "path": ".codjiva/artifacts/a/v1/link/planted.go", "content": "bad" }));
        assert!(out.is_error, "{}", out.content);
        assert!(!dir.path().join("src/planted.go").exists());
    }

    #[test]
    fn finish_and_unknown_tools() {
        let (_dir, tools) = toolbox();
        assert_eq!(tools.call("finish", &json!({ "summary": "Drew the handler." })).finished.as_deref(), Some("Drew the handler."));
        assert!(tools.call("run_shell", &json!({ "command": "ls" })).content.contains("no tool named"));
        assert_eq!(tools.specs().iter().map(|s| s.name).collect::<Vec<_>>(), vec!["list_dir", "read_file", "search", "write_file", "finish"]);
    }
}
