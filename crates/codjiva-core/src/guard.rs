//! The write guard: proof, after every agent run, that nothing outside `.codjiva/` was touched.
//!
//! Agents are told to write only inside `.codjiva/`, and their own permission rules enforce it
//! where they can. This module does not rely on either. It records the size and modification
//! time of every file of the workspace before a run and compares afterwards, so a write that
//! slipped through is always found and shown to the user.
//!
//! Files hidden by the workspace's ignore rules, such as build output and installed packages,
//! are not recorded. They are not the user's source code, and scanning them would make every
//! job on a large repository slow.

use crate::env::run_capture;
use crate::names::DOT_DIR;
use crate::workspace::{to_rel_string, Workspace};
use ignore::WalkBuilder;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;
use std::process::Command;
use std::time::{Duration, UNIX_EPOCH};

/// The size in bytes and the modification time in nanoseconds of every recorded file, by path.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Snapshot {
    files: BTreeMap<String, (u64, u128)>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Change {
    Created,
    Modified,
    Deleted,
}

/// One file outside `.codjiva/` that changed during an agent run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Violation {
    pub path: String,
    pub change: Change,
    /// True when git tracks the file, in which case its last committed content can be restored.
    pub tracked: bool,
}

/// Records the workspace's files as they are now.
pub fn snapshot(ws: &Workspace) -> Snapshot {
    let mut files = BTreeMap::new();
    let mut walker = WalkBuilder::new(ws.root());
    walker.hidden(false).parents(true).git_ignore(true).git_exclude(true).git_global(true).require_git(false)
        .filter_entry(|entry| entry.file_name() != ".git" && entry.file_name() != DOT_DIR);
    for item in walker.build().flatten() {
        if !item.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        let (Ok(rel), Ok(meta)) = (item.path().strip_prefix(ws.root()), item.metadata()) else { continue };
        let modified = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_nanos()).unwrap_or(0);
        files.insert(to_rel_string(rel), (meta.len(), modified));
    }
    Snapshot { files }
}

/// Records every file of the app's own folder that a job must leave alone: the saved versions of
/// all artifacts and the workspace's configuration. `except` is the version folder the job is
/// writing, which is not recorded.
///
/// An agent may write anywhere in `.codjiva/` as far as the workspace's source code is
/// concerned, but a job that changed an older version would destroy something the user can
/// still open.
pub fn snapshot_store(ws: &Workspace, except: &Path) -> Snapshot {
    let mut files = BTreeMap::new();
    let dot_dir = ws.dot_dir();
    let mut record = |path: &Path| {
        let (Ok(rel), Ok(meta)) = (path.strip_prefix(ws.root()), path.metadata()) else { return };
        let modified = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_nanos()).unwrap_or(0);
        files.insert(to_rel_string(rel), (meta.len(), modified));
    };
    record(&dot_dir.join("config.json"));
    let mut walker = WalkBuilder::new(dot_dir.join("artifacts"));
    walker.hidden(false).git_ignore(false).git_exclude(false).git_global(false).parents(false).ignore(false);
    for item in walker.build().flatten() {
        if item.file_type().is_some_and(|t| t.is_file()) && !item.path().starts_with(except) {
            record(item.path());
        }
    }
    Snapshot { files }
}

/// Compares the app's own folder with a snapshot from [`snapshot_store`] and returns every file
/// that was created, changed or deleted since.
pub fn store_violations(ws: &Workspace, before: &Snapshot, except: &Path) -> Vec<Violation> {
    let after = snapshot_store(ws, except);
    let mut found: Vec<Violation> = Vec::new();
    for (path, state) in &after.files {
        match before.files.get(path) {
            None => found.push(Violation { path: path.clone(), change: Change::Created, tracked: false }),
            Some(old) if old != state => found.push(Violation { path: path.clone(), change: Change::Modified, tracked: false }),
            Some(_) => {}
        }
    }
    for path in before.files.keys() {
        if !after.files.contains_key(path) {
            found.push(Violation { path: path.clone(), change: Change::Deleted, tracked: false });
        }
    }
    found.sort_by(|a, b| a.path.cmp(&b.path));
    found
}

/// Runs git in the workspace and returns what it printed, or `None` when git is not installed,
/// the workspace is not a repository, or the command fails.
fn git(ws: &Workspace, args: &[&str]) -> Option<String> {
    let mut command = Command::new("git");
    command.arg("-C").arg(ws.root()).args(args);
    run_capture(&mut command, Duration::from_secs(20)).map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
}

/// Compares the workspace with a snapshot taken earlier and returns every file that was
/// created, changed or deleted since.
pub fn violations(ws: &Workspace, before: &Snapshot) -> Vec<Violation> {
    let after = snapshot(ws);
    let mut found: Vec<(String, Change)> = Vec::new();
    for (path, state) in &after.files {
        match before.files.get(path) {
            None => found.push((path.clone(), Change::Created)),
            Some(old) if old != state => found.push((path.clone(), Change::Modified)),
            Some(_) => {}
        }
    }
    for path in before.files.keys() {
        if !after.files.contains_key(path) {
            found.push((path.clone(), Change::Deleted));
        }
    }
    found.sort_by(|a, b| a.0.cmp(&b.0));
    found.into_iter().map(|(path, change)| {
        let tracked = change != Change::Created && git(ws, &["ls-files", "--error-unmatch", "--", &path]).is_some();
        Violation { path, change, tracked }
    }).collect()
}

/// What happened to one file when the user asked to undo the agent's changes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevertResult {
    pub path: String,
    pub reverted: bool,
    /// What the user has to do by hand when the file could not be restored.
    pub note: String,
}

/// Restores the files of `violations` that git tracks to their last committed content. Files
/// the agent created are never deleted by the app; they are listed for the user to remove.
pub fn revert(ws: &Workspace, violations: &[Violation]) -> Vec<RevertResult> {
    violations.iter().map(|v| {
        if v.change == Change::Created {
            return RevertResult { path: v.path.clone(), reverted: false, note: "This file is new. Delete it yourself if you do not want it.".into() };
        }
        if !v.tracked {
            return RevertResult { path: v.path.clone(), reverted: false, note: "Git does not track this file, so its earlier content cannot be restored.".into() };
        }
        match git(ws, &["checkout", "--", &v.path]) {
            Some(_) => RevertResult { path: v.path.clone(), reverted: true, note: "Restored to the last committed content.".into() },
            None => RevertResult { path: v.path.clone(), reverted: false, note: "Git could not restore this file.".into() },
        }
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn workspace(files: &[(&str, &str)]) -> (tempfile::TempDir, Workspace) {
        let dir = tempfile::tempdir().unwrap();
        for (rel, text) in files {
            let path = dir.path().join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, text).unwrap();
        }
        let ws = Workspace::open(dir.path()).unwrap();
        (dir, ws)
    }

    #[test]
    fn writes_inside_the_dot_folder_and_ignored_folders_are_not_violations() {
        let (dir, ws) = workspace(&[(".gitignore", "build/\n"), ("src/a.go", "package a\n")]);
        let before = snapshot(&ws);
        fs::create_dir_all(dir.path().join(".codjiva/artifacts/x/v1/src")).unwrap();
        fs::write(dir.path().join(".codjiva/artifacts/x/v1/src/plant.js"), "x").unwrap();
        fs::create_dir_all(dir.path().join("build")).unwrap();
        fs::write(dir.path().join("build/out.o"), "x").unwrap();
        assert!(violations(&ws, &before).is_empty());
    }

    #[test]
    fn a_change_to_a_saved_version_is_found_and_the_version_being_written_is_not() {
        let (dir, ws) = workspace(&[("src/a.go", "package a\n"), (".codjiva/artifacts/x/v1/src/plant.js", "one"), (".codjiva/artifacts/x/artifact.json", "{}"), (".codjiva/config.json", "{}")]);
        let writing = ws.root().join(".codjiva/artifacts/x/v2");
        let before = snapshot_store(&ws, &writing);
        fs::create_dir_all(writing.join("src")).unwrap();
        fs::write(writing.join("src/plant.js"), "two").unwrap();
        assert!(store_violations(&ws, &before, &writing).is_empty());
        fs::write(dir.path().join(".codjiva/artifacts/x/v1/src/plant.js"), "changed by the agent").unwrap();
        fs::write(dir.path().join(".codjiva/artifacts/y.txt"), "stray").unwrap();
        let found: Vec<(String, Change)> = store_violations(&ws, &before, &writing).into_iter().map(|v| (v.path, v.change)).collect();
        assert_eq!(found, vec![(".codjiva/artifacts/x/v1/src/plant.js".to_string(), Change::Modified), (".codjiva/artifacts/y.txt".to_string(), Change::Created)]);
    }

    #[test]
    fn created_modified_and_deleted_files_are_all_found() {
        let (dir, ws) = workspace(&[("src/a.go", "package a\n"), ("src/b.go", "package a\n"), ("README.md", "hi\n")]);
        let before = snapshot(&ws);
        fs::write(dir.path().join("src/a.go"), "package a\n// agent was here\n").unwrap();
        fs::remove_file(dir.path().join("src/b.go")).unwrap();
        fs::write(dir.path().join("new.txt"), "x").unwrap();
        let found: Vec<(String, Change)> = violations(&ws, &before).into_iter().map(|v| (v.path, v.change)).collect();
        assert_eq!(found, vec![("new.txt".to_string(), Change::Created), ("src/a.go".to_string(), Change::Modified), ("src/b.go".to_string(), Change::Deleted)]);
    }

    #[test]
    fn tracked_files_are_restored_and_new_files_are_left_for_the_user() {
        let (dir, ws) = workspace(&[("src/a.go", "package a\n")]);
        let run = |args: &[&str]| Command::new("git").arg("-C").arg(dir.path()).args(args).output().map(|o| o.status.success()).unwrap_or(false);
        // Without git on the machine there is nothing to check here.
        if !run(&["init", "-q"]) {
            return;
        }
        assert!(run(&["-c", "user.email=t@example.com", "-c", "user.name=T", "add", "-A"]));
        assert!(run(&["-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-q", "-m", "first"]));
        let before = snapshot(&ws);
        fs::write(dir.path().join("src/a.go"), "package a\n// changed by an agent\n").unwrap();
        fs::write(dir.path().join("stray.txt"), "x").unwrap();
        let found = violations(&ws, &before);
        assert_eq!(found.iter().map(|v| (v.path.as_str(), v.tracked)).collect::<Vec<_>>(), vec![("src/a.go", true), ("stray.txt", false)]);
        let results = revert(&ws, &found);
        assert!(results[0].reverted);
        assert!(!results[1].reverted && results[1].note.contains("Delete it yourself"));
        assert_eq!(fs::read_to_string(dir.path().join("src/a.go")).unwrap(), "package a\n");
        assert!(dir.path().join("stray.txt").exists(), "the app never deletes a file the agent created");
    }
}
