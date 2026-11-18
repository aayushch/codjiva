//! The write guard: what changed on disk while an agent ran.
//!
//! Agents are told to write only inside the folder of the version they are
//! making, and their own permission rules enforce it where they can. This
//! module does not rely on either. It answers two questions for a job.
//!
//! Which source files changed while the job ran? [`snapshot`] records the size
//! and modification time of every file of the workspace before a run, and
//! [`changes`] compares afterwards. A job is not failed for such a change,
//! because the user may have edited the file themselves. The job reports the
//! changed files, and records a version made from one of them as stale. The
//! user can undo the changes with [`revert`].
//!
//! Did the job change a version that was already saved? [`snapshot_store`] and
//! [`store_violations`] find that. A job that did is failed, because a saved
//! version is something the user can still open.
//!
//! Files hidden by the workspace's ignore rules, such as build output and
//! installed packages, are not recorded. They are not the user's source code,
//! and scanning them would make every job on a large repository slow.

use crate::env::run_capture;
use crate::names::DOT_DIR;
use crate::workspace::{to_rel_string, Workspace};
use ignore::WalkBuilder;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;
use std::process::Command;
use std::time::{Duration, UNIX_EPOCH};

/// The size in bytes and the modification time in nanoseconds of a file.
type FileState = (u64, u128);

/// The [`FileState`] of every recorded file, by path relative to the workspace
/// root.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Snapshot {
    files: BTreeMap<String, FileState>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Change {
    Created,
    Modified,
    Deleted,
}

/// One file that changed during an agent run and that the agent was not
/// allowed to write: a file of the workspace outside `.codjiva/`, or a file of
/// a saved version.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Violation {
    pub path: String,
    pub change: Change,
    /// True when git tracks the file, in which case its last committed content
    /// can be restored.
    pub tracked: bool,
}

/// Reads the [`FileState`] of the file at `path`. Returns `None` when the file
/// cannot be read, for example because it was deleted a moment ago.
fn file_state(path: &Path) -> Option<FileState> {
    let meta = path.metadata().ok()?;
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    Some((meta.len(), modified))
}

/// Compares two sets of recorded files and returns every path that is in only
/// one of them or whose [`FileState`] differs, with what happened to it.
fn compare(
    before: &BTreeMap<String, FileState>,
    after: &BTreeMap<String, FileState>,
) -> BTreeMap<String, Change> {
    let mut found = BTreeMap::new();
    for (path, state) in after {
        match before.get(path) {
            None => {
                found.insert(path.clone(), Change::Created);
            }
            Some(old) if old != state => {
                found.insert(path.clone(), Change::Modified);
            }
            Some(_) => {}
        }
    }
    for path in before.keys() {
        if !after.contains_key(path) {
            found.insert(path.clone(), Change::Deleted);
        }
    }
    found
}

/// Records the workspace's files as they are now. The app's own folder,
/// `.codjiva/`, is left out.
pub fn snapshot(ws: &Workspace) -> Snapshot {
    let mut files = BTreeMap::new();
    let mut walker = WalkBuilder::new(ws.root());
    walker
        .hidden(false)
        .parents(true)
        .git_ignore(true)
        .git_exclude(true)
        .git_global(true)
        .require_git(false)
        .filter_entry(|entry| {
            entry.file_name() != ".git" && entry.file_name() != DOT_DIR
        });
    for item in walker.build().flatten() {
        if !item.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        let (Ok(rel), Some(state)) =
            (item.path().strip_prefix(ws.root()), file_state(item.path()))
        else {
            continue;
        };
        files.insert(to_rel_string(rel), state);
    }
    Snapshot { files }
}

/// Runs git in the workspace and returns what it printed, or `None` when git is
/// not installed, the workspace is not a repository, or the command fails.
fn git(ws: &Workspace, args: &[&str]) -> Option<String> {
    let mut command = Command::new("git");
    command.arg("-C").arg(ws.root()).args(args);
    run_capture(&mut command, Duration::from_secs(20))
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
}

/// Compares the workspace with a snapshot from [`snapshot`] and returns every
/// file that was created, changed or deleted since, by path relative to the
/// workspace root. The comparison cannot tell who changed a file. It may have
/// been the agent, the user in their editor, or another program.
pub fn changes(ws: &Workspace, before: &Snapshot) -> BTreeMap<String, Change> {
    compare(&before.files, &snapshot(ws).files)
}

/// The same comparison as [`changes`], as a list ordered by path that also says
/// for each file whether git tracks it.
pub fn violations(ws: &Workspace, before: &Snapshot) -> Vec<Violation> {
    changes(ws, before)
        .into_iter()
        .map(|(path, change)| {
            let tracked = change != Change::Created
                && git(ws, &["ls-files", "--error-unmatch", "--", &path])
                    .is_some();
            Violation {
                path,
                change,
                tracked,
            }
        })
        .collect()
}

/// The name of the file that a job writes last into the folder of a version. A
/// version folder that holds this file is finished. A version folder without
/// it is still being written by a running job.
const MANIFEST: &str = "manifest.json";

/// Reads every version folder under `.codjiva/artifacts`. Returns the files of
/// each folder with their [`FileState`], by the folder's path relative to the
/// workspace root. A version folder is `<artifact id>/v<number>`. Files that
/// are not inside a version folder, such as an artifact's `artifact.json`, are
/// left out.
fn version_folders(
    ws: &Workspace,
) -> BTreeMap<String, BTreeMap<String, FileState>> {
    let artifacts = ws.dot_dir().join("artifacts");
    let mut folders: BTreeMap<String, BTreeMap<String, FileState>> =
        BTreeMap::new();
    let mut walker = WalkBuilder::new(&artifacts);
    walker
        .hidden(false)
        .git_ignore(false)
        .git_exclude(false)
        .git_global(false)
        .parents(false)
        .ignore(false);
    for item in walker.build().flatten() {
        if !item.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        let Ok(inside) = item.path().strip_prefix(&artifacts) else {
            continue;
        };
        // The first two parts of the path are the artifact's folder and the
        // version's folder. A file needs a third part to be inside a version.
        let mut parts = inside.components();
        let (Some(artifact), Some(version), Some(_)) =
            (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        let folder = artifacts.join(artifact).join(version);
        let (Ok(folder), Ok(file), Some(state)) = (
            folder.strip_prefix(ws.root()),
            item.path().strip_prefix(ws.root()),
            file_state(item.path()),
        ) else {
            continue;
        };
        folders
            .entry(to_rel_string(folder))
            .or_default()
            .insert(to_rel_string(file), state);
    }
    folders
}

/// Reads the [`FileState`] of the workspace's configuration file,
/// `.codjiva/config.json`. Returns it with the file's path relative to the
/// workspace root, or `None` when the file does not exist.
fn config_file(ws: &Workspace) -> Option<(String, FileState)> {
    let config = ws.dot_dir().join("config.json");
    let state = file_state(&config)?;
    let rel = config.strip_prefix(ws.root()).ok()?;
    Some((to_rel_string(rel), state))
}

/// Records the files in the app's own folder that a job must leave alone: the
/// workspace's configuration and every file of every finished version.
///
/// A version folder that is not finished is not recorded. It is either the
/// folder this job writes, or the folder of another job that runs at the same
/// time.
pub fn snapshot_store(ws: &Workspace) -> Snapshot {
    let mut files: BTreeMap<String, FileState> =
        config_file(ws).into_iter().collect();
    for (folder, in_folder) in version_folders(ws) {
        if in_folder.contains_key(&format!("{folder}/{MANIFEST}")) {
            files.extend(in_folder);
        }
    }
    Snapshot { files }
}

/// Compares the app's own folder with a snapshot from [`snapshot_store`].
/// Returns every recorded file that was changed or deleted since, and every
/// file that was added to a version folder the snapshot recorded.
///
/// A version that another job finished after the snapshot was taken is not
/// compared, because the snapshot holds nothing of it.
pub fn store_violations(ws: &Workspace, before: &Snapshot) -> Vec<Violation> {
    let mut now: BTreeMap<String, FileState> =
        config_file(ws).into_iter().collect();
    for (folder, in_folder) in version_folders(ws) {
        // A version the snapshot recorded is compared file by file, even when
        // its manifest has been deleted since.
        if before.files.contains_key(&format!("{folder}/{MANIFEST}")) {
            now.extend(in_folder);
        }
    }
    compare(&before.files, &now)
        .into_iter()
        .map(|(path, change)| Violation {
            path,
            change,
            tracked: false,
        })
        .collect()
}

/// What happened to one file when the user asked to undo the changes that a
/// job reported.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevertResult {
    pub path: String,
    pub reverted: bool,
    /// What the user has to do by hand when the file could not be restored.
    pub note: String,
}

/// Restores the files of `violations` that git tracks to their last committed
/// content. A file that was created during the job is never deleted by the
/// app. It is listed for the user to remove.
pub fn revert(ws: &Workspace, violations: &[Violation]) -> Vec<RevertResult> {
    violations
        .iter()
        .map(|v| {
            if v.change == Change::Created {
                return RevertResult {
                    path: v.path.clone(),
                    reverted: false,
                    note: "This file is new. Delete it yourself if you do not \
                           want it."
                        .into(),
                };
            }
            if !v.tracked {
                return RevertResult {
                    path: v.path.clone(),
                    reverted: false,
                    note: "Git does not track this file, so its earlier \
                           content cannot be restored."
                        .into(),
                };
            }
            match git(ws, &["checkout", "--", &v.path]) {
                Some(_) => RevertResult {
                    path: v.path.clone(),
                    reverted: true,
                    note: "Restored to the last committed content.".into(),
                },
                None => RevertResult {
                    path: v.path.clone(),
                    reverted: false,
                    note: "Git could not restore this file.".into(),
                },
            }
        })
        .collect()
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
        let (dir, ws) = workspace(&[
            (".gitignore", "build/\n"),
            ("src/a.go", "package a\n"),
        ]);
        let before = snapshot(&ws);
        fs::create_dir_all(dir.path().join(".codjiva/artifacts/x/v1/src"))
            .unwrap();
        fs::write(dir.path().join(".codjiva/artifacts/x/v1/src/plant.js"), "x")
            .unwrap();
        fs::create_dir_all(dir.path().join("build")).unwrap();
        fs::write(dir.path().join("build/out.o"), "x").unwrap();
        assert!(violations(&ws, &before).is_empty());
    }

    #[test]
    fn a_change_to_a_finished_version_is_found() {
        let (dir, ws) = workspace(&[
            ("src/a.go", "package a\n"),
            (".codjiva/artifacts/x/v1/src/plant.js", "one"),
            (".codjiva/artifacts/x/v1/manifest.json", "{}"),
            (".codjiva/artifacts/x/artifact.json", "{}"),
            (".codjiva/config.json", "{}"),
        ]);
        let before = snapshot_store(&ws);
        assert!(store_violations(&ws, &before).is_empty());
        fs::write(
            dir.path().join(".codjiva/artifacts/x/v1/src/plant.js"),
            "changed by the agent",
        )
        .unwrap();
        fs::write(dir.path().join(".codjiva/artifacts/x/v1/extra.js"), "new")
            .unwrap();
        fs::remove_file(
            dir.path().join(".codjiva/artifacts/x/v1/manifest.json"),
        )
        .unwrap();
        let found: Vec<(String, Change)> = store_violations(&ws, &before)
            .into_iter()
            .map(|v| (v.path, v.change))
            .collect();
        assert_eq!(
            found,
            vec![
                (
                    ".codjiva/artifacts/x/v1/extra.js".to_string(),
                    Change::Created
                ),
                (
                    ".codjiva/artifacts/x/v1/manifest.json".to_string(),
                    Change::Deleted
                ),
                (
                    ".codjiva/artifacts/x/v1/src/plant.js".to_string(),
                    Change::Modified
                ),
            ]
        );
    }

    #[test]
    fn what_jobs_write_while_they_run_and_when_they_finish_is_not_a_violation()
    {
        let (dir, ws) = workspace(&[
            (".codjiva/artifacts/x/v1/src/plant.js", "one"),
            (".codjiva/artifacts/x/v1/manifest.json", "{}"),
            (".codjiva/artifacts/x/artifact.json", "{}"),
            // The folder of another job that was already running when the
            // snapshot was taken. It has no manifest yet.
            (".codjiva/artifacts/y/v1/src/plant.js", "half"),
        ]);
        let artifacts = dir.path().join(".codjiva/artifacts");
        let before = snapshot_store(&ws);
        // This job writes its own version folder.
        fs::create_dir_all(artifacts.join("x/v2/src")).unwrap();
        fs::write(artifacts.join("x/v2/src/plant.js"), "two").unwrap();
        // The other job writes more, finishes, and is made the current version
        // of its artifact.
        fs::write(artifacts.join("y/v1/src/plant.js"), "whole").unwrap();
        fs::write(artifacts.join("y/v1/manifest.json"), "{}").unwrap();
        fs::write(artifacts.join("y/artifact.json"), "{}").unwrap();
        // A third job starts and is cancelled, which deletes its folder.
        fs::create_dir_all(artifacts.join("z/v1/src")).unwrap();
        fs::remove_dir_all(artifacts.join("z")).unwrap();
        assert_eq!(store_violations(&ws, &before), vec![]);
    }

    #[test]
    fn created_modified_and_deleted_files_are_all_found() {
        let (dir, ws) = workspace(&[
            ("src/a.go", "package a\n"),
            ("src/b.go", "package a\n"),
            ("README.md", "hi\n"),
        ]);
        let before = snapshot(&ws);
        fs::write(
            dir.path().join("src/a.go"),
            "package a\n// agent was here\n",
        )
        .unwrap();
        fs::remove_file(dir.path().join("src/b.go")).unwrap();
        fs::write(dir.path().join("new.txt"), "x").unwrap();
        let found: Vec<(String, Change)> = violations(&ws, &before)
            .into_iter()
            .map(|v| (v.path, v.change))
            .collect();
        assert_eq!(
            found,
            vec![
                ("new.txt".to_string(), Change::Created),
                ("src/a.go".to_string(), Change::Modified),
                ("src/b.go".to_string(), Change::Deleted)
            ]
        );
    }

    #[test]
    fn tracked_files_are_restored_and_new_files_are_left_for_the_user() {
        let (dir, ws) = workspace(&[("src/a.go", "package a\n")]);
        let run = |args: &[&str]| {
            Command::new("git")
                .arg("-C")
                .arg(dir.path())
                .args(args)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        };
        // Without git on the machine there is nothing to check here.
        if !run(&["init", "-q"]) {
            return;
        }
        // Git for Windows converts LF to CRLF on checkout by default. This
        // test compares the restored file byte for byte, so the conversion is
        // turned off in this repository.
        assert!(run(&["config", "core.autocrlf", "false"]));
        assert!(run(&[
            "-c",
            "user.email=t@example.com",
            "-c",
            "user.name=T",
            "add",
            "-A"
        ]));
        assert!(run(&[
            "-c",
            "user.email=t@example.com",
            "-c",
            "user.name=T",
            "commit",
            "-q",
            "-m",
            "first"
        ]));
        let before = snapshot(&ws);
        fs::write(
            dir.path().join("src/a.go"),
            "package a\n// changed by an agent\n",
        )
        .unwrap();
        fs::write(dir.path().join("stray.txt"), "x").unwrap();
        let found = violations(&ws, &before);
        assert_eq!(
            found
                .iter()
                .map(|v| (v.path.as_str(), v.tracked))
                .collect::<Vec<_>>(),
            vec![("src/a.go", true), ("stray.txt", false)]
        );
        let results = revert(&ws, &found);
        assert!(results[0].reverted);
        assert!(
            !results[1].reverted
                && results[1].note.contains("Delete it yourself")
        );
        assert_eq!(
            fs::read_to_string(dir.path().join("src/a.go")).unwrap(),
            "package a\n"
        );
        assert!(
            dir.path().join("stray.txt").exists(),
            "the app never deletes a file the agent created"
        );
    }
}
