//! The hidden folder at the root of a workspace where everything Codjiva generates is kept.
//!
//! Layout:
//!
//!   .codjiva/
//!     config.json     settings for this workspace
//!     .gitignore      keeps transient files out of version control when the folder is tracked
//!     artifacts/      one folder per visual, film or pipeline
//!     jobs/           prompts and logs of recent jobs
//!     cache/          anything that can be recomputed

use crate::error::{AppError, Result};
use crate::names::DOT_DIR;
use crate::util;
use crate::workspace::Workspace;
use ignore::gitignore::GitignoreBuilder;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// The version of the folder layout. It is raised when a change would make an older app misread
/// the folder.
pub const SCHEMA_VERSION: u32 = 1;

/// What goes into `.codjiva/.gitignore`. A team that commits its artifacts still does not want
/// job logs and caches in the repository.
const INNER_GITIGNORE: &str = "# Written by Codjiva. Transient files that should not be committed even when artifacts are.\njobs/\ncache/\n*.log.jsonl\n*.tmp\n";

/// What the user decided about keeping the folder out of version control.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GitignoreChoice {
    /// The user had the folder added to the repository's `.gitignore`.
    Added,
    /// The user wants the folder tracked, to share artifacts with the team.
    Tracked,
}

/// The contents of `.codjiva/config.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceConfig {
    pub schema_version: u32,
    /// `None` until the user has answered the question, which is then never asked again.
    #[serde(default)]
    pub gitignore_choice: Option<GitignoreChoice>,
}

impl Default for WorkspaceConfig {
    fn default() -> Self {
        WorkspaceConfig { schema_version: SCHEMA_VERSION, gitignore_choice: None }
    }
}

/// Whether version control would currently pick up the folder.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitState {
    /// The workspace is not inside a git repository, so there is nothing to decide.
    NotARepository,
    /// An ignore rule already covers the folder.
    Ignored,
    /// The folder would be tracked.
    NotIgnored,
}

/// What the interface needs to know after the folder was made ready.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreStatus {
    pub git: GitState,
    pub gitignore_choice: Option<GitignoreChoice>,
    /// True when the user should be asked whether to add the folder to `.gitignore`: the
    /// workspace is a repository, the folder is not ignored, and the user has not answered yet.
    pub ask_about_gitignore: bool,
}

/// The directory that contains `.git` for this workspace, searching upwards from its root.
fn repository_root(root: &Path) -> Option<PathBuf> {
    root.ancestors().find(|dir| dir.join(".git").exists()).map(Path::to_path_buf)
}

/// Reports whether git would ignore `.codjiva/`. It reads the `.gitignore` files from the
/// repository root down to the workspace root, and the repository's own exclude file.
pub fn git_state(ws: &Workspace) -> GitState {
    let Some(repo) = repository_root(ws.root()) else {
        return GitState::NotARepository;
    };
    let mut builder = GitignoreBuilder::new(&repo);
    builder.add(repo.join(".git").join("info").join("exclude"));
    let mut dirs: Vec<&Path> = ws.root().ancestors().take_while(|dir| dir.starts_with(&repo)).collect();
    dirs.reverse();
    for dir in dirs {
        builder.add(dir.join(".gitignore"));
    }
    let Ok(rules) = builder.build() else {
        return GitState::NotIgnored;
    };
    if rules.matched_path_or_any_parents(ws.dot_dir(), true).is_ignore() {
        GitState::Ignored
    } else {
        GitState::NotIgnored
    }
}

fn config_path(ws: &Workspace) -> PathBuf {
    ws.dot_dir().join("config.json")
}

pub fn read_config(ws: &Workspace) -> Result<WorkspaceConfig> {
    Ok(util::read_json(&config_path(ws))?.unwrap_or_default())
}

pub fn write_config(ws: &Workspace, config: &WorkspaceConfig) -> Result<()> {
    util::write_json(&config_path(ws), config)
}

/// Creates the folder and its fixed contents if they are missing, and reports what the user
/// still has to decide. It never changes files that already exist.
pub fn ensure(ws: &Workspace) -> Result<StoreStatus> {
    let dot = ws.dot_dir();
    for sub in ["artifacts", "jobs", "cache"] {
        fs::create_dir_all(dot.join(sub)).map_err(|e| AppError::io("create the .codjiva folder", e))?;
    }
    let inner = dot.join(".gitignore");
    if !inner.exists() {
        util::write_atomic(&inner, INNER_GITIGNORE)?;
    }
    if !config_path(ws).exists() {
        write_config(ws, &WorkspaceConfig::default())?;
    }
    status(ws)
}

/// The same report as [`ensure`], without creating anything.
pub fn status(ws: &Workspace) -> Result<StoreStatus> {
    let config = read_config(ws)?;
    let git = git_state(ws);
    Ok(StoreStatus { git, gitignore_choice: config.gitignore_choice, ask_about_gitignore: git == GitState::NotIgnored && config.gitignore_choice.is_none() })
}

/// Adds `.codjiva/` to the `.gitignore` at the workspace root, creating that file if needed, and
/// records the choice. This is the only file outside `.codjiva/` that the app ever writes, and it
/// does so only when the user asks for it.
pub fn add_to_gitignore(ws: &Workspace) -> Result<StoreStatus> {
    let path = ws.root().join(".gitignore");
    let line = format!("{DOT_DIR}/");
    let existing = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(AppError::io("read .gitignore", e)),
    };
    let already = existing.lines().any(|l| matches!(l.trim(), s if s == line || s == DOT_DIR || s == format!("/{DOT_DIR}/") || s == format!("/{DOT_DIR}")));
    if !already {
        let mut text = existing;
        if !text.is_empty() && !text.ends_with('\n') {
            text.push('\n');
        }
        text.push_str(&format!("\n# Codjiva visuals and films\n{line}\n"));
        fs::write(&path, text).map_err(|e| AppError::io("update .gitignore", e))?;
    }
    record_choice(ws, GitignoreChoice::Added)
}

/// Records what the user decided about `.gitignore`, so the question is not asked again.
pub fn record_choice(ws: &Workspace, choice: GitignoreChoice) -> Result<StoreStatus> {
    ensure(ws)?;
    let mut config = read_config(ws)?;
    config.gitignore_choice = Some(choice);
    write_config(ws, &config)?;
    status(ws)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo() -> (tempfile::TempDir, Workspace) {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join(".git")).unwrap();
        let ws = Workspace::open(dir.path()).unwrap();
        (dir, ws)
    }

    #[test]
    fn ensure_creates_the_layout_once_and_asks_about_gitignore_in_a_repository() {
        let (dir, ws) = repo();
        let status = ensure(&ws).unwrap();
        assert_eq!(status.git, GitState::NotIgnored);
        assert!(status.ask_about_gitignore);
        for path in ["config.json", ".gitignore", "artifacts", "jobs", "cache"] {
            assert!(dir.path().join(DOT_DIR).join(path).exists(), "{path}");
        }
        // Running it again changes nothing the user may have edited.
        fs::write(dir.path().join(DOT_DIR).join(".gitignore"), "mine\n").unwrap();
        ensure(&ws).unwrap();
        assert_eq!(fs::read_to_string(dir.path().join(DOT_DIR).join(".gitignore")).unwrap(), "mine\n");
    }

    #[test]
    fn adding_to_gitignore_is_idempotent_and_stops_the_question() {
        let (dir, ws) = repo();
        fs::write(dir.path().join(".gitignore"), "target/").unwrap();
        ensure(&ws).unwrap();
        let after = add_to_gitignore(&ws).unwrap();
        assert_eq!((after.git, after.ask_about_gitignore, after.gitignore_choice), (GitState::Ignored, false, Some(GitignoreChoice::Added)));
        add_to_gitignore(&ws).unwrap();
        let text = fs::read_to_string(dir.path().join(".gitignore")).unwrap();
        assert!(text.starts_with("target/\n"));
        assert_eq!(text.matches(".codjiva/").count(), 1, "{text}");
    }

    #[test]
    fn choosing_to_track_the_folder_stops_the_question_without_touching_gitignore() {
        let (dir, ws) = repo();
        ensure(&ws).unwrap();
        let after = record_choice(&ws, GitignoreChoice::Tracked).unwrap();
        assert_eq!((after.git, after.ask_about_gitignore), (GitState::NotIgnored, false));
        assert!(!dir.path().join(".gitignore").exists());
    }

    #[test]
    fn a_folder_outside_any_repository_is_never_asked() {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::open(dir.path()).unwrap();
        // The temporary folder may itself sit inside a repository on a developer's machine, in
        // which case this test has nothing to check.
        if repository_root(ws.root()).is_some() {
            return;
        }
        let status = ensure(&ws).unwrap();
        assert_eq!((status.git, status.ask_about_gitignore), (GitState::NotARepository, false));
    }

    #[test]
    fn a_rule_in_a_parent_folder_of_the_workspace_counts() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join(".git")).unwrap();
        fs::write(dir.path().join(".gitignore"), ".codjiva/\n").unwrap();
        fs::create_dir_all(dir.path().join("services/api")).unwrap();
        let ws = Workspace::open(&dir.path().join("services/api")).unwrap();
        assert_eq!(git_state(&ws), GitState::Ignored);
    }
}
