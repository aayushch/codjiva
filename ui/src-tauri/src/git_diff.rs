//! The commands that list the changes of a file and compare two versions of
//! it, for the diff view.

use crate::AppState;
use codjiva_core::error::{AppError, Result};
use codjiva_core::git_diff::{self, FileDiff, FileHistory, Side};
use tauri::{AppHandle, Manager};

/// The error for a git command whose thread stopped before it answered.
fn stopped(error: tauri::Error) -> AppError {
    AppError::new("git_failed", "Could not ask git about that file.")
        .with_detail(error)
}

/// The changes of a file of the open workspace, newest first: the changes
/// that are not committed, when there are any, and then the commits that
/// changed the file. Returns nothing when git cannot say, for example for a
/// folder that is not inside a repository.
#[tauri::command]
pub async fn git_file_history(
    rel_path: String,
    app: AppHandle,
) -> Result<Option<FileHistory>> {
    // Git reads the history of the file, so it runs off the interface's
    // thread.
    tauri::async_runtime::spawn_blocking(move || {
        let workspace = app.state::<AppState>().workspace()?;
        workspace.resolve(&rel_path)?;
        Ok(git_diff::file_history(&workspace, &rel_path))
    })
    .await
    .map_err(stopped)?
}

/// The versions `old` and `new` of a file of the open workspace, and the
/// lines in which they differ. Without `old`, every line of `new` counts as
/// added. The interface passes the two versions of one entry of
/// `git_file_history`.
#[tauri::command]
pub async fn git_file_diff(
    old: Option<Side>,
    new: Side,
    app: AppHandle,
) -> Result<FileDiff> {
    tauri::async_runtime::spawn_blocking(move || {
        let workspace = app.state::<AppState>().workspace()?;
        git_diff::file_diff(&workspace, old.as_ref(), &new)
    })
    .await
    .map_err(stopped)?
}
