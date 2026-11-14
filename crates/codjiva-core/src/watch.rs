//! Watches folders of the workspace for changes on disk.
//!
//! Only the folders the caller names are watched, each without its subfolders. The interface
//! names the folders that are expanded in the file tree, and the app adds the folders of every
//! file an artifact was made from. That keeps the number of watches small in a repository with a
//! hundred thousand files, on every operating system.

use crate::error::{AppError, Result};
use crate::names::DOT_DIR;
use crate::workspace::to_rel_string;
use notify::RecursiveMode;
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Changes are collected for this long before they are reported, so saving one file from an
/// editor, which often touches several paths, produces one report.
const DEBOUNCE: Duration = Duration::from_millis(250);

/// One report of changes. Paths are relative to the workspace root, with `/` separators.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Changes {
    /// The watched folders in which something changed. `""` is the workspace root.
    pub dirs: Vec<String>,
    /// The files and folders that changed.
    pub paths: Vec<String>,
}

pub struct DirWatcher {
    root: PathBuf,
    debouncer: Debouncer<notify::RecommendedWatcher>,
    watched: BTreeSet<String>,
}

impl DirWatcher {
    /// Creates a watcher for the workspace at `root`. `on_change` is called from a background
    /// thread each time watched folders change.
    pub fn new(root: &Path, on_change: impl Fn(Changes) + Send + 'static) -> Result<DirWatcher> {
        let base = root.to_path_buf();
        let debouncer = new_debouncer(DEBOUNCE, move |result: DebounceEventResult| {
            let Ok(events) = result else { return };
            let mut dirs = BTreeSet::new();
            let mut paths = BTreeSet::new();
            for event in events {
                let Ok(rel) = event.path.strip_prefix(&base) else { continue };
                let rel_text = to_rel_string(rel);
                // Changes inside Codjiva's own folder are reported through job events instead.
                if rel_text == DOT_DIR || rel_text.starts_with(&format!("{DOT_DIR}/")) {
                    continue;
                }
                dirs.insert(rel.parent().map(to_rel_string).unwrap_or_default());
                paths.insert(rel_text);
            }
            if !paths.is_empty() {
                on_change(Changes { dirs: dirs.into_iter().collect(), paths: paths.into_iter().collect() });
            }
        }).map_err(|e| AppError::new("watch_failed", "Could not watch the folder for changes.").with_detail(e))?;
        Ok(DirWatcher { root: root.to_path_buf(), debouncer, watched: BTreeSet::new() })
    }

    /// Replaces the set of watched folders. Folders that no longer exist are skipped.
    pub fn set(&mut self, rel_dirs: &[String]) {
        let wanted: BTreeSet<String> = rel_dirs.iter().cloned().collect();
        let (to_remove, to_add): (Vec<String>, Vec<String>) = (
            self.watched.difference(&wanted).cloned().collect(),
            wanted.difference(&self.watched).cloned().collect(),
        );
        for rel in to_remove {
            let _ = self.debouncer.watcher().unwatch(&self.root.join(&rel));
            self.watched.remove(&rel);
        }
        for rel in to_add {
            if self.debouncer.watcher().watch(&self.root.join(&rel), RecursiveMode::NonRecursive).is_ok() {
                self.watched.insert(rel);
            }
        }
    }

    pub fn watched(&self) -> Vec<String> {
        self.watched.iter().cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn reports_a_change_in_a_watched_folder_and_ignores_unwatched_ones() {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir_all(root.join("other")).unwrap();
        let (tx, rx) = mpsc::channel();
        let mut watcher = DirWatcher::new(&root, move |changes| { let _ = tx.send(changes); }).unwrap();
        watcher.set(&["src".to_string()]);
        assert_eq!(watcher.watched(), vec!["src"]);
        std::thread::sleep(Duration::from_millis(200));

        std::fs::write(root.join("other/b.txt"), "b").unwrap();
        std::fs::write(root.join("src/a.txt"), "a").unwrap();
        let changes = rx.recv_timeout(Duration::from_secs(5)).expect("a change is reported");
        assert_eq!(changes.dirs, vec!["src"]);
        assert!(changes.paths.contains(&"src/a.txt".to_string()), "{changes:?}");
        assert!(!changes.paths.iter().any(|p| p.starts_with("other")), "{changes:?}");
    }
}
