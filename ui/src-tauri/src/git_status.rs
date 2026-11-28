//! The command that says which files of the workspace git reports as
//! changed, for the file tree.

use crate::AppState;
use codjiva_core::error::{AppError, Result};
use codjiva_core::git_status::{self, StatusEntry};
use tauri::{AppHandle, Manager};

/// The changed files of the open workspace, as git knows them. Returns
/// nothing when git cannot say, for example for a folder that is not inside
/// a repository.
#[tauri::command]
pub async fn git_status(app: AppHandle) -> Result<Option<Vec<StatusEntry>>> {
    // Git compares every tracked file with the index, which takes a moment
    // in a large repository, so it runs off the interface's thread.
    tauri::async_runtime::spawn_blocking(move || {
        let workspace = app.state::<AppState>().workspace()?;
        Ok(git_status::of_workspace(&workspace))
    })
    .await
    .map_err(|error| {
        AppError::new("git_status_failed", "Could not ask git for changes.")
            .with_detail(error)
    })?
}
