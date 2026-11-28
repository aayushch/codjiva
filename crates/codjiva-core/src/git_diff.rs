//! The history of one file and the difference between two versions of it,
//! read from git.
//!
//! The diff view asks for the list of changes of a file, newest first, and
//! then for the two texts of one change and the lines in which they differ.
//! Only git is asked: `git log` for the commits that changed the file,
//! `git status` and `git cat-file` for a change that is not committed,
//! `git show` for the text of a version, and `git diff` for the lines that
//! differ. Nothing is written.

use crate::blame::git;
use crate::error::{AppError, Result};
use crate::workspace::Workspace;
use serde::{Deserialize, Serialize};

/// How many commits of a file are listed at most.
pub const HISTORY_LIMIT: usize = 500;

/// The largest text, in bytes, that is compared. A larger version is
/// reported as too large and is not sent to the interface.
const TEXT_LIMIT: usize = 2_000_000;

/// One version of a file.
///   - With `commit`, it is the file as that commit has it. `commit` is the
///     full hash, the hash followed by `^` for the first parent of that
///     commit, or `HEAD`. `path` is then the path from the root of the
///     repository.
///   - Without `commit`, it is the file as it is on disk now. `path` is
///     then the path inside the workspace.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Side {
    pub commit: Option<String>,
    pub path: String,
}

/// One change of a file: a commit that changed it, or the changes that are
/// not committed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    /// The full hash of the commit. `None` for the changes that are not
    /// committed. `author` and `summary` are then empty and `time` is 0.
    pub commit: Option<String>,
    /// The name of the commit's author.
    pub author: String,
    /// When the author made the commit, in seconds since the start of 1970
    /// in UTC.
    pub time: i64,
    /// The first line of the commit message.
    pub summary: String,
    /// The version before the change. `None` when the change created the
    /// file, so there is no earlier version to compare with.
    pub old: Option<Side>,
    /// The version the change made.
    pub new: Side,
}

/// The changes of one file, newest first. The changes that are not
/// committed come first, when the file has any.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHistory {
    pub changes: Vec<Change>,
    /// True when the file has more commits than `HISTORY_LIMIT`, so the
    /// oldest ones are not in `changes`.
    pub more: bool,
}

/// A run of lines that differ between two versions. The first line of a
/// file has the number 1.
///
/// `old_lines` lines of the old version, starting at line `old_start`, were
/// replaced by `new_lines` lines of the new version, starting at line
/// `new_start`. A count of 0 means that nothing was removed, or that nothing
/// was added. The start beside a count of 0 is the line after which the
/// lines of the other version belong.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hunk {
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
}

/// Two versions of a file and the lines in which they differ.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    /// The text of the old version. Empty when there is no old version.
    pub old_text: String,
    /// The text of the new version.
    pub new_text: String,
    /// The runs of lines that differ, from the top of the file down.
    pub hunks: Vec<Hunk>,
    /// True when one of the versions is not text. Both texts and `hunks`
    /// are then empty.
    pub binary: bool,
    /// True when one of the versions is larger than the app compares. Both
    /// texts and `hunks` are then empty.
    pub too_large: bool,
}

/// True for the three forms of `Side::commit` this module passes to git: a
/// full hash, a full hash followed by `^`, and `HEAD`. Anything else is
/// refused, so that a value from the interface can never be read by git as
/// an option.
fn is_revision(text: &str) -> bool {
    let hash = text.strip_suffix('^').unwrap_or(text);
    text == "HEAD"
        || (hash.len() == 40 && hash.chars().all(|c| c.is_ascii_hexdigit()))
}

/// Reads the output of `git log --follow --name-status` with the format
/// `LOG_FORMAT`, and returns the commits as changes, newest first.
///
/// Each commit starts with the byte 0x1e. Its first line holds the hash, the
/// author, the time and the summary, with the byte 0x1f between them. A
/// line below it names the file as the commit changed it: a status letter,
/// a tab and the path from the root of the repository. For a renamed file
/// the line has the earlier path and then the new path.
///
/// `path` is the path of the file in the newest commit. A commit without a
/// line for the file, such as a merge, is taken to have the file at the
/// path the next newer commit had it before its change.
fn parse_log(output: &str, path: &str) -> Vec<Change> {
    let mut current = path.to_string();
    let mut found = Vec::new();
    for record in output.split('\x1e').skip(1) {
        let (head, rest) = record.split_once('\n').unwrap_or((record, ""));
        let mut fields = head.split('\x1f');
        let (Some(commit), Some(author), Some(time), Some(summary)) =
            (fields.next(), fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        if !is_revision(commit) {
            continue;
        }
        let named: Vec<&str> = rest
            .lines()
            .find(|line| line.contains('\t'))
            .map(|line| line.split('\t').collect())
            .unwrap_or_default();
        let (before, now) = match named.as_slice() {
            // The commit created the file.
            [status, now] if status.starts_with('A') => (None, now.to_string()),
            // The commit renamed or copied the file.
            [_, before, now] => (Some(before.to_string()), now.to_string()),
            [_, now] => (Some(now.to_string()), now.to_string()),
            _ => (Some(current.clone()), current.clone()),
        };
        found.push(Change {
            commit: Some(commit.to_string()),
            author: author.to_string(),
            time: time.parse().unwrap_or(0),
            summary: summary.to_string(),
            old: before.as_ref().map(|before| Side {
                commit: Some(format!("{commit}^")),
                path: before.clone(),
            }),
            new: Side {
                commit: Some(commit.to_string()),
                path: now,
            },
        });
        if let Some(before) = before {
            current = before;
        }
    }
    found
}

/// The format of one commit in the output `parse_log` reads.
const LOG_FORMAT: &str = "--format=%x1e%H%x1f%an%x1f%at%x1f%s";

/// The changes of the file at `rel_path`, a path inside the workspace.
///
/// Returns `None` when git cannot say: git is not installed, or the
/// workspace folder is not inside a repository. A file git does not track
/// has one change, the one that is not committed, with no old version.
pub fn file_history(ws: &Workspace, rel_path: &str) -> Option<FileHistory> {
    let prefix = git(ws, &["rev-parse", "--show-prefix"])?;
    let root_path =
        format!("{}{rel_path}", prefix.trim_end_matches(['\n', '\r']));
    let in_workspace = format!("./{rel_path}");
    let mut changes = Vec::new();

    let status = git(
        ws,
        &[
            "--no-optional-locks",
            "status",
            "--porcelain=v1",
            "-z",
            "--",
            &in_workspace,
        ],
    )
    .unwrap_or_default();
    if !status.is_empty() {
        let in_head =
            git(ws, &["cat-file", "-e", &format!("HEAD:{root_path}")])
                .is_some();
        changes.push(Change {
            commit: None,
            author: String::new(),
            time: 0,
            summary: String::new(),
            old: in_head.then(|| Side {
                commit: Some("HEAD".to_string()),
                path: root_path.clone(),
            }),
            new: Side {
                commit: None,
                path: rel_path.to_string(),
            },
        });
    }

    let count = format!("{}", HISTORY_LIMIT + 1);
    let log = git(
        ws,
        &[
            "-c",
            "core.quotePath=false",
            "log",
            "--follow",
            "-n",
            &count,
            LOG_FORMAT,
            "--name-status",
            "--",
            &in_workspace,
        ],
    )
    .unwrap_or_default();
    let mut commits = parse_log(&log, &root_path);
    let more = commits.len() > HISTORY_LIMIT;
    commits.truncate(HISTORY_LIMIT);
    changes.extend(commits);
    Some(FileHistory { changes, more })
}

/// Reads the headers of the hunks in the output of `git diff -U0`. A header
/// is a line such as `@@ -12,2 +14 @@`. The numbers after `-` are the first
/// line and the count of lines of the old version, and the numbers after
/// `+` are the same for the new version. A count that is left out is 1.
fn parse_hunks(output: &str) -> Vec<Hunk> {
    let range = |text: &str| -> Option<(u32, u32)> {
        let (start, lines) = text.split_once(',').unwrap_or((text, "1"));
        Some((start.parse().ok()?, lines.parse().ok()?))
    };
    output
        .lines()
        .filter_map(|line| {
            let mut parts = line.strip_prefix("@@ -")?.split(' ');
            let (old_start, old_lines) = range(parts.next()?)?;
            let (new_start, new_lines) =
                range(parts.next()?.strip_prefix('+')?)?;
            Some(Hunk {
                old_start,
                old_lines,
                new_start,
                new_lines,
            })
        })
        .collect()
}

/// What git is given to name `side` in a command: `commit:path` for a
/// version in a commit, and `./path` for the file on disk.
fn name_of(ws: &Workspace, side: &Side) -> Result<String> {
    match &side.commit {
        Some(commit) if is_revision(commit) => {
            Ok(format!("{commit}:{}", side.path))
        }
        Some(_) => Err(AppError::new(
            "bad_revision",
            "That is not a version git can show.",
        )),
        None => {
            ws.resolve(&side.path)?;
            Ok(format!("./{}", side.path))
        }
    }
}

/// The bytes of the file as `side` names it.
fn bytes_of(ws: &Workspace, side: &Side) -> Result<Vec<u8>> {
    if side.commit.is_none() {
        let path = ws.resolve(&side.path)?;
        return std::fs::read(path)
            .map_err(|e| AppError::io("read the file", e));
    }
    let name = name_of(ws, side)?;
    git(ws, &["show", &name])
        .map(String::into_bytes)
        .ok_or_else(|| {
            AppError::new(
                "no_such_version",
                "Git could not read that version of the file.",
            )
        })
}

/// The two versions `old` and `new` of a file, and the lines in which they
/// differ. Without `old`, every line of `new` counts as added.
///
/// `old` must be a version in a commit. `new` may be a version in a commit
/// or the file on disk.
pub fn file_diff(
    ws: &Workspace,
    old: Option<&Side>,
    new: &Side,
) -> Result<FileDiff> {
    if old.is_some_and(|side| side.commit.is_none()) {
        return Err(AppError::new(
            "bad_revision",
            "The older version must be one that is committed.",
        ));
    }
    let old_bytes = match old {
        Some(side) => bytes_of(ws, side)?,
        None => Vec::new(),
    };
    let new_bytes = bytes_of(ws, new)?;
    let empty = |binary: bool, too_large: bool| FileDiff {
        old_text: String::new(),
        new_text: String::new(),
        hunks: Vec::new(),
        binary,
        too_large,
    };
    if old_bytes.contains(&0) || new_bytes.contains(&0) {
        return Ok(empty(true, false));
    }
    if old_bytes.len() > TEXT_LIMIT || new_bytes.len() > TEXT_LIMIT {
        return Ok(empty(false, true));
    }
    let old_text = String::from_utf8_lossy(&old_bytes).into_owned();
    let new_text = String::from_utf8_lossy(&new_bytes).into_owned();

    let hunks = match old {
        None => {
            let lines = new_text.lines().count() as u32;
            if lines == 0 {
                Vec::new()
            } else {
                vec![Hunk {
                    old_start: 0,
                    old_lines: 0,
                    new_start: 1,
                    new_lines: lines,
                }]
            }
        }
        Some(side) => {
            let output = git(
                ws,
                &[
                    "--no-optional-locks",
                    "diff",
                    "--no-color",
                    "--no-ext-diff",
                    "--no-textconv",
                    "--diff-algorithm=histogram",
                    "-U0",
                    &name_of(ws, side)?,
                    &name_of(ws, new)?,
                ],
            )
            .ok_or_else(|| {
                AppError::new(
                    "diff_failed",
                    "Git could not compare the two versions.",
                )
            })?;
            if output.lines().any(|line| line.starts_with("Binary files ")) {
                return Ok(empty(true, false));
            }
            parse_hunks(&output)
        }
    };
    Ok(FileDiff {
        old_text,
        new_text,
        hunks,
        binary: false,
        too_large: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;
    use std::process::Command;

    const ONE: &str = "1111111111111111111111111111111111111111";
    const TWO: &str = "2222222222222222222222222222222222222222";
    const THREE: &str = "3333333333333333333333333333333333333333";

    #[test]
    fn only_hashes_and_head_are_revisions() {
        assert!(is_revision("HEAD"));
        assert!(is_revision(ONE));
        assert!(is_revision(&format!("{ONE}^")));
        assert!(!is_revision("--output=/tmp/x"));
        assert!(!is_revision("main"));
        assert!(!is_revision(&ONE[..39]));
    }

    #[test]
    fn the_log_of_a_file_is_read_through_a_rename() {
        let output = format!(
            "\x1e{THREE}\x1fAda Writer\x1f1700000300\x1fTune the limit\n\n\
             M\tapp/limits.go\n\
             \x1e{TWO}\x1fBo Reader\x1f1700000200\x1fMove the limits\n\n\
             R087\tapp/old.go\tapp/limits.go\n\
             \x1e{ONE}\x1fAda Writer\x1f1700000100\x1fAdd the limits\n\n\
             A\tapp/old.go\n"
        );
        let changes = parse_log(&output, "app/limits.go");
        assert_eq!(changes.len(), 3);
        assert_eq!(changes[0].summary, "Tune the limit");
        assert_eq!(changes[0].time, 1_700_000_300);
        assert_eq!(
            changes[0].old,
            Some(Side {
                commit: Some(format!("{THREE}^")),
                path: "app/limits.go".to_string(),
            })
        );
        // The commit that renamed the file compares the new path with the
        // earlier one.
        assert_eq!(changes[1].author, "Bo Reader");
        assert_eq!(changes[1].new.path, "app/limits.go");
        assert_eq!(changes[1].old.as_ref().unwrap().path, "app/old.go");
        // The commit that created the file has no old version.
        assert_eq!(changes[2].new.path, "app/old.go");
        assert_eq!(changes[2].old, None);
        assert_eq!(parse_log("", "a.go"), vec![]);
    }

    #[test]
    fn the_headers_of_hunks_are_read() {
        let output = "diff --git a/a.go b/a.go\n--- a/a.go\n+++ b/a.go\n\
                      @@ -3 +3,2 @@ func One() {}\n-old\n+new\n+more\n\
                      @@ -10,2 +10,0 @@\n-gone\n-gone too\n\
                      @@ -20,0 +19,3 @@ tail\n+a\n+b\n+c\n";
        assert_eq!(
            parse_hunks(output),
            vec![
                Hunk {
                    old_start: 3,
                    old_lines: 1,
                    new_start: 3,
                    new_lines: 2
                },
                Hunk {
                    old_start: 10,
                    old_lines: 2,
                    new_start: 10,
                    new_lines: 0
                },
                Hunk {
                    old_start: 20,
                    old_lines: 0,
                    new_start: 19,
                    new_lines: 3
                },
            ]
        );
    }

    /// Runs git in `dir` with a fixed author, and fails the test when git
    /// fails.
    fn run(dir: &Path, args: &[&str]) {
        let output = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args([
                "-c",
                "user.name=Ada Writer",
                "-c",
                "user.email=ada@example.com",
                "-c",
                "commit.gpgsign=false",
            ])
            .args(args)
            .output()
            .expect("git is installed");
        assert!(output.status.success(), "git {args:?} failed");
    }

    #[test]
    fn the_history_of_a_file_is_walked_from_what_is_not_committed() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("app")).unwrap();
        let first = "package app\n\nconst Limit = 1\n\nfunc One() {}\n";
        fs::write(root.join("app/old.go"), first).unwrap();
        run(root, &["init", "-q"]);
        run(root, &["add", "."]);
        run(root, &["commit", "-q", "-m", "Add the limits"]);
        run(root, &["mv", "app/old.go", "app/limits.go"]);
        run(root, &["commit", "-q", "-m", "Move the limits"]);
        let second = "package app\n\nconst Limit = 2\n\nfunc One() {}\n";
        fs::write(root.join("app/limits.go"), second).unwrap();
        run(root, &["commit", "-q", "-am", "Tune the limit"]);

        // The workspace is a subfolder of the repository, so the paths of
        // commits start at the root and the path on disk at the workspace.
        let ws = Workspace::open(&root.join("app")).unwrap();
        let clean = file_history(&ws, "limits.go").expect("a repository");
        assert_eq!(clean.changes.len(), 3);
        assert!(!clean.more);
        assert_eq!(clean.changes[0].summary, "Tune the limit");
        assert_eq!(clean.changes[1].old.as_ref().unwrap().path, "app/old.go");
        assert_eq!(clean.changes[2].old, None);

        let third = "package app\n\nconst Limit = 2\n\nfunc One() {}\n\n\
                     func Two() {}\n";
        fs::write(root.join("app/limits.go"), third).unwrap();
        let history = file_history(&ws, "limits.go").unwrap();
        assert_eq!(history.changes.len(), 4);
        let pending = &history.changes[0];
        assert_eq!(pending.commit, None);
        assert_eq!(pending.new.path, "limits.go");
        assert_eq!(
            pending.old,
            Some(Side {
                commit: Some("HEAD".to_string()),
                path: "app/limits.go".to_string(),
            })
        );

        // What is not committed, against the last commit.
        let diff = file_diff(&ws, pending.old.as_ref(), &pending.new).unwrap();
        assert_eq!(diff.old_text, second);
        assert_eq!(diff.new_text, third);
        assert_eq!(
            diff.hunks,
            vec![Hunk {
                old_start: 5,
                old_lines: 0,
                new_start: 6,
                new_lines: 2
            }]
        );

        // A commit, against the version before it.
        let tuned = &history.changes[1];
        let diff = file_diff(&ws, tuned.old.as_ref(), &tuned.new).unwrap();
        assert_eq!(diff.old_text, first);
        assert_eq!(diff.new_text, second);
        assert_eq!(
            diff.hunks,
            vec![Hunk {
                old_start: 3,
                old_lines: 1,
                new_start: 3,
                new_lines: 1
            }]
        );

        // Two commits that are not next to each other, with the rename
        // between them: the first commit against the third.
        let created = &history.changes[3];
        let diff = file_diff(&ws, Some(&created.new), &tuned.new).unwrap();
        assert_eq!(diff.old_text, first);
        assert_eq!(diff.new_text, second);
        assert_eq!(
            diff.hunks,
            vec![Hunk {
                old_start: 3,
                old_lines: 1,
                new_start: 3,
                new_lines: 1
            }]
        );

        // The first commit against the file on disk.
        let diff = file_diff(&ws, Some(&created.new), &pending.new).unwrap();
        assert_eq!(diff.old_text, first);
        assert_eq!(diff.new_text, third);
        assert_eq!(diff.hunks.len(), 2);

        // The commit that created the file: every line is added.
        let added = &history.changes[3];
        let diff = file_diff(&ws, added.old.as_ref(), &added.new).unwrap();
        assert_eq!(diff.old_text, "");
        assert_eq!(
            diff.hunks,
            vec![Hunk {
                old_start: 0,
                old_lines: 0,
                new_start: 1,
                new_lines: 5
            }]
        );

        // A file git does not track has one change, with no old version.
        fs::write(root.join("app/new.go"), "package app\n").unwrap();
        let fresh = file_history(&ws, "new.go").unwrap();
        assert_eq!(fresh.changes.len(), 1);
        assert_eq!(fresh.changes[0].old, None);
    }

    #[test]
    fn a_version_that_is_not_text_is_not_compared() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("dot.bin"), [1u8, 0, 2, 0]).unwrap();
        run(root, &["init", "-q"]);
        run(root, &["add", "."]);
        run(root, &["commit", "-q", "-m", "Add a dot"]);
        fs::write(root.join("dot.bin"), [1u8, 0, 3, 0]).unwrap();
        let ws = Workspace::open(root).unwrap();
        let history = file_history(&ws, "dot.bin").unwrap();
        let pending = &history.changes[0];
        let diff = file_diff(&ws, pending.old.as_ref(), &pending.new).unwrap();
        assert!(diff.binary);
        assert_eq!(diff.hunks, vec![]);

        // A value that is not a hash is refused before git sees it.
        let bad = Side {
            commit: Some("--output=x".to_string()),
            path: "dot.bin".to_string(),
        };
        assert!(file_diff(&ws, None, &bad).is_err());
    }

    #[test]
    fn a_folder_that_is_not_a_repository_has_no_history() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.go"), "package a\n").unwrap();
        let ws = Workspace::open(dir.path()).unwrap();
        assert_eq!(file_history(&ws, "a.go"), None);
    }
}
