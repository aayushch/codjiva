//! Who last changed a line of a file, read from git.
//!
//! The source view asks for this when the user clicks a line, and shows the
//! answer at the end of that line. Only git is asked: `git blame` for the
//! line, `git show` for the full message of the commit that `git blame`
//! names, and `git config` for the user's own name and address. Nothing is
//! written.

use crate::env::run_capture;
use crate::workspace::Workspace;
use serde::Serialize;
use std::process::Command;
use std::time::Duration;

/// How long one git command may run. `git blame` reads the history of the
/// file, which takes longest for a large file with many commits.
const LIMIT: Duration = Duration::from_secs(15);

/// The hash `git blame` gives a line that is changed in the working tree and
/// not committed.
const NOT_COMMITTED: &str = "0000000000000000000000000000000000000000";

/// The last change of one line.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Blame {
    /// False for a line that is changed in the working tree and not
    /// committed. `commit`, `author`, `summary` and `body` are then empty and
    /// `time` is 0.
    pub committed: bool,
    /// The full hash of the commit.
    pub commit: String,
    /// The name of the commit's author.
    pub author: String,
    /// True when the author's address is git's `user.email` for the
    /// workspace, or, if no address is set, the author's name is git's
    /// `user.name`.
    pub by_user: bool,
    /// When the author made the commit, in seconds since the start of 1970
    /// in UTC.
    pub time: i64,
    /// The first line of the commit message.
    pub summary: String,
    /// The commit message after its first line, without the empty lines
    /// around it.
    pub body: String,
}

/// Runs git in the workspace and returns what it printed. Returns `None`
/// when git is not installed, the workspace is not a repository, or the
/// command fails.
pub(crate) fn git(ws: &Workspace, args: &[&str]) -> Option<String> {
    let mut command = Command::new("git");
    command.arg("-C").arg(ws.root()).args(args);
    run_capture(&mut command, LIMIT)
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
}

/// What `git blame --porcelain` says about one line: the hash of the commit,
/// and the author's name, the author's address, the time and the summary.
/// The four after the hash are empty or 0 when the output does not have
/// them.
#[derive(Debug, Default, PartialEq)]
struct Porcelain {
    commit: String,
    author: String,
    mail: String,
    time: i64,
    summary: String,
}

/// Reads the output of `git blame --porcelain` for one line. The first line
/// of the output starts with the hash. Each line after it is a name, a space
/// and a value, up to the line of code itself, which starts with a tab.
fn parse(output: &str) -> Option<Porcelain> {
    let mut lines = output.lines();
    let commit = lines.next()?.split(' ').next()?.to_string();
    if commit.len() != 40 || !commit.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let mut found = Porcelain {
        commit,
        ..Porcelain::default()
    };
    for line in lines {
        if line.starts_with('\t') {
            break;
        }
        let (name, value) = line.split_once(' ').unwrap_or((line, ""));
        match name {
            "author" => found.author = value.to_string(),
            "author-mail" => {
                found.mail = value
                    .trim_start_matches('<')
                    .trim_end_matches('>')
                    .to_string();
            }
            "author-time" => found.time = value.parse().unwrap_or(0),
            "summary" => found.summary = value.to_string(),
            _ => {}
        }
    }
    Some(found)
}

/// The value git has for `key`, such as `user.email`, in the workspace.
/// Empty when it is not set.
fn config(ws: &Workspace, key: &str) -> String {
    git(ws, &["config", key])
        .map(|value| value.trim().to_string())
        .unwrap_or_default()
}

/// The last change of line `line` of the file at `rel_path`, counted from 1.
///
/// Returns `None` when git cannot say: git is not installed, the workspace
/// is not a repository, git does not track the file, or the file has no
/// such line.
pub fn of_line(ws: &Workspace, rel_path: &str, line: u32) -> Option<Blame> {
    let range = format!("{line},{line}");
    let output =
        git(ws, &["blame", "--porcelain", "-L", &range, "--", rel_path])?;
    let found = parse(&output)?;
    if found.commit == NOT_COMMITTED {
        return Some(Blame {
            committed: false,
            commit: String::new(),
            author: String::new(),
            by_user: false,
            time: 0,
            summary: String::new(),
            body: String::new(),
        });
    }
    let message = git(ws, &["show", "-s", "--format=%B", &found.commit])
        .unwrap_or_default();
    let body = message
        .trim()
        .split_once('\n')
        .map(|(_, rest)| rest.trim().to_string())
        .unwrap_or_default();
    let own_mail = config(ws, "user.email");
    let by_user = if own_mail.is_empty() {
        let own_name = config(ws, "user.name");
        !own_name.is_empty() && own_name == found.author
    } else {
        own_mail.eq_ignore_ascii_case(&found.mail)
    };
    Some(Blame {
        committed: true,
        commit: found.commit,
        author: found.author,
        by_user,
        time: found.time,
        summary: found.summary,
        body,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn the_porcelain_output_of_one_line_is_read() {
        let output = "\
9dbe5110c0ffee00000000000000000000000001 3 3 1
author Ada Writer
author-mail <ada@example.com>
author-time 1700000000
author-tz +0800
committer Ada Writer
summary Count the ports of an artifact
filename src/ports.ts
\texport function portCount() {}
";
        assert_eq!(
            parse(output),
            Some(Porcelain {
                commit: "9dbe5110c0ffee00000000000000000000000001".to_string(),
                author: "Ada Writer".to_string(),
                mail: "ada@example.com".to_string(),
                time: 1_700_000_000,
                summary: "Count the ports of an artifact".to_string(),
            })
        );
        assert_eq!(parse("fatal: no such path\n"), None);
    }

    /// Runs git in `dir` with a fixed author, and fails the test when git
    /// fails.
    fn run(dir: &std::path::Path, args: &[&str]) {
        let status = Command::new("git")
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
        assert!(status.status.success(), "git {args:?} failed");
    }

    #[test]
    fn a_line_is_blamed_on_its_commit_and_an_edited_line_on_none() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.go");
        fs::write(&file, "package a\n\nfunc One() {}\n").unwrap();
        run(dir.path(), &["init", "-q"]);
        run(dir.path(), &["config", "user.email", "ada@example.com"]);
        run(dir.path(), &["add", "a.go"]);
        run(
            dir.path(),
            &[
                "commit",
                "-q",
                "-m",
                "Add One\n\nIt does nothing yet.\nThat comes later.",
            ],
        );
        let ws = Workspace::open(dir.path()).unwrap();

        let blame = of_line(&ws, "a.go", 3).expect("the line is committed");
        assert!(blame.committed);
        assert_eq!(blame.commit.len(), 40);
        assert_eq!(blame.author, "Ada Writer");
        assert!(blame.by_user);
        assert!(blame.time > 0);
        assert_eq!(blame.summary, "Add One");
        assert_eq!(blame.body, "It does nothing yet.\nThat comes later.");

        // A line that is changed and not committed has no commit.
        fs::write(&file, "package a\n\nfunc Two() {}\n").unwrap();
        let edited = of_line(&ws, "a.go", 3).expect("git tracks the file");
        assert!(!edited.committed);
        assert_eq!(edited.commit, "");

        // Git cannot say anything about a line the file does not have, or
        // about a file it does not track.
        assert_eq!(of_line(&ws, "a.go", 99), None);
        fs::write(dir.path().join("new.go"), "package a\n").unwrap();
        assert_eq!(of_line(&ws, "new.go", 1), None);
    }

    #[test]
    fn a_folder_that_is_not_a_repository_has_no_blame() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.go"), "package a\n").unwrap();
        let ws = Workspace::open(dir.path()).unwrap();
        assert_eq!(of_line(&ws, "a.go", 1), None);
    }
}
