//! Which files of the workspace git reports as changed, read from git.
//!
//! The file tree asks for this and shows a letter and a colour for each
//! changed file. Only git is asked: `git status` for the changes, and
//! `git rev-parse` for where the workspace folder is inside the repository.
//! `git status` runs with `--no-optional-locks`, so it does not write the
//! index and does not get in the way of a git command the user runs at the
//! same time.

use crate::blame::git;
use crate::workspace::Workspace;
use serde::Serialize;

/// How many changes are reported at most. A repository with more changed
/// files than this reports the first ones `git status` prints.
const ENTRY_LIMIT: usize = 10_000;

/// What git says about one changed file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FileStatus {
    /// The content of a tracked file changed.
    Modified,
    /// The file is new and was added to the index.
    Added,
    /// The file is new and git does not track it.
    Untracked,
    /// A tracked file was deleted.
    Deleted,
    /// A tracked file was given another name. The entry has the new name.
    Renamed,
    /// A merge left the file with a conflict that is not resolved.
    Conflicted,
}

/// One changed file or folder of the workspace.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusEntry {
    /// The path inside the workspace, with `/` separators. A path with a
    /// slash at its end is a folder in which git tracks nothing. Git reports
    /// such a folder once, and not each file inside it.
    pub path: String,
    pub status: FileStatus,
}

/// The status for the two letters `git status --porcelain` prints in front
/// of a path. `index` is the first letter, which describes the index, and
/// `tree` is the second, which describes the working tree. Returns `None`
/// for letters that are not a change the file tree shows, such as `!!` for
/// an ignored file.
fn status_of(index: char, tree: char) -> Option<FileStatus> {
    match (index, tree) {
        ('?', '?') => Some(FileStatus::Untracked),
        ('!', '!') => None,
        // Every pair with a `U`, and the pairs `DD` and `AA`, are the two
        // sides of a merge that are not resolved.
        ('U', _) | (_, 'U') | ('D', 'D') | ('A', 'A') => {
            Some(FileStatus::Conflicted)
        }
        (_, 'D') | ('D', _) => Some(FileStatus::Deleted),
        ('A', _) | (_, 'A') | ('C', _) => Some(FileStatus::Added),
        ('R', _) | (_, 'R') => Some(FileStatus::Renamed),
        ('M', _) | (_, 'M') | ('T', _) | (_, 'T') => Some(FileStatus::Modified),
        _ => None,
    }
}

/// Reads the output of `git status --porcelain=v1 -z`.
///
/// The output is a list of records that each end with a NUL byte. A record
/// is the two status letters, a space and the path from the root of the
/// repository. The record of a renamed or copied file is followed by one
/// more record, which holds only the earlier path and is skipped here.
///
/// `prefix` is the path of the workspace folder from the root of the
/// repository, with a slash at its end, or empty when the workspace is the
/// root. It is removed from each path. A path that does not start with it is
/// outside the workspace and is left out.
fn parse(output: &str, prefix: &str) -> Vec<StatusEntry> {
    let mut found = Vec::new();
    let mut records = output.split('\0');
    while let Some(record) = records.next() {
        let mut letters = record.chars();
        let (Some(index), Some(tree), Some(' ')) =
            (letters.next(), letters.next(), letters.next())
        else {
            continue;
        };
        let path = letters.as_str();
        if index == 'R' || index == 'C' || tree == 'R' || tree == 'C' {
            records.next();
        }
        let Some(status) = status_of(index, tree) else {
            continue;
        };
        let Some(path) = path.strip_prefix(prefix) else {
            continue;
        };
        if path.is_empty() {
            continue;
        }
        found.push(StatusEntry {
            path: path.to_string(),
            status,
        });
        if found.len() == ENTRY_LIMIT {
            break;
        }
    }
    found
}

/// The changed files of the workspace, as `git status` reports them for the
/// repository that contains the workspace folder.
///
/// Returns `None` when git cannot say: git is not installed, or the
/// workspace folder is not inside a repository. A repository in a subfolder
/// of the workspace is not asked.
pub fn of_workspace(ws: &Workspace) -> Option<Vec<StatusEntry>> {
    let prefix = git(ws, &["rev-parse", "--show-prefix"])?;
    let output = git(
        ws,
        &[
            "--no-optional-locks",
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=normal",
            "--",
            ".",
        ],
    )?;
    Some(parse(&output, prefix.trim_end_matches(['\n', '\r'])))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;
    use std::process::Command;

    fn entry(path: &str, status: FileStatus) -> StatusEntry {
        StatusEntry {
            path: path.to_string(),
            status,
        }
    }

    #[test]
    fn the_porcelain_output_is_read_and_paths_are_made_relative() {
        let output = [
            " M app/src/a.ts",
            "A  app/src/new.ts",
            "?? app/notes/",
            "R  app/src/to.ts",
            "app/src/from.ts",
            "UU app/both.ts",
            " D app/gone.ts",
            "!! app/out/",
            " M other/b.ts",
            "",
        ]
        .join("\0");
        assert_eq!(
            parse(&output, "app/"),
            vec![
                entry("src/a.ts", FileStatus::Modified),
                entry("src/new.ts", FileStatus::Added),
                entry("notes/", FileStatus::Untracked),
                entry("src/to.ts", FileStatus::Renamed),
                entry("both.ts", FileStatus::Conflicted),
                entry("gone.ts", FileStatus::Deleted),
            ]
        );
        // With an empty prefix the paths are kept as git prints them.
        assert_eq!(
            parse("MM a.ts\0", ""),
            vec![entry("a.ts", FileStatus::Modified)]
        );
        assert_eq!(parse("", ""), vec![]);
    }

    #[test]
    fn two_status_letters_give_one_status() {
        assert_eq!(status_of('A', 'M'), Some(FileStatus::Added));
        assert_eq!(status_of('M', 'D'), Some(FileStatus::Deleted));
        assert_eq!(status_of('R', 'M'), Some(FileStatus::Renamed));
        assert_eq!(status_of('A', 'A'), Some(FileStatus::Conflicted));
        assert_eq!(status_of('D', 'U'), Some(FileStatus::Conflicted));
        assert_eq!(status_of('T', ' '), Some(FileStatus::Modified));
        assert_eq!(status_of('!', '!'), None);
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
    fn the_changes_of_a_repository_are_reported() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("app/src")).unwrap();
        fs::write(root.join("app/src/a.go"), "package a\n").unwrap();
        fs::write(root.join("app/src/gone.go"), "package a\n").unwrap();
        fs::write(root.join("top.go"), "package top\n").unwrap();
        run(root, &["init", "-q"]);
        run(root, &["add", "."]);
        run(root, &["commit", "-q", "-m", "Start"]);

        let ws = Workspace::open(root).unwrap();
        assert_eq!(of_workspace(&ws), Some(vec![]));

        fs::write(root.join("app/src/a.go"), "package a\n\nvar A = 1\n")
            .unwrap();
        fs::remove_file(root.join("app/src/gone.go")).unwrap();
        fs::write(root.join("app/src/staged.go"), "package a\n").unwrap();
        run(root, &["add", "app/src/staged.go"]);
        fs::create_dir_all(root.join("app/fresh")).unwrap();
        fs::write(root.join("app/fresh/one.go"), "package fresh\n").unwrap();
        fs::write(root.join("top.go"), "package top\n\nvar T = 1\n").unwrap();

        let mut whole = of_workspace(&ws).expect("the folder is a repository");
        whole.sort_by(|a, b| a.path.cmp(&b.path));
        assert_eq!(
            whole,
            vec![
                entry("app/fresh/", FileStatus::Untracked),
                entry("app/src/a.go", FileStatus::Modified),
                entry("app/src/gone.go", FileStatus::Deleted),
                entry("app/src/staged.go", FileStatus::Added),
                entry("top.go", FileStatus::Modified),
            ]
        );

        // A workspace that is a subfolder of the repository reports only
        // what is inside it, with paths that start at the workspace.
        let inner = Workspace::open(&root.join("app")).unwrap();
        let mut part = of_workspace(&inner).expect("inside a repository");
        part.sort_by(|a, b| a.path.cmp(&b.path));
        assert_eq!(
            part,
            vec![
                entry("fresh/", FileStatus::Untracked),
                entry("src/a.go", FileStatus::Modified),
                entry("src/gone.go", FileStatus::Deleted),
                entry("src/staged.go", FileStatus::Added),
            ]
        );
    }

    #[test]
    fn a_folder_that_is_not_a_repository_has_no_status() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.go"), "package a\n").unwrap();
        let ws = Workspace::open(dir.path()).unwrap();
        assert_eq!(of_workspace(&ws), None);
    }
}
