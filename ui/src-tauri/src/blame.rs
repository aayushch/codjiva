//! The command that says who last changed a line of a file, for the source
//! view.

use crate::AppState;
use codjiva_core::blame::{self, Blame};
use codjiva_core::error::{AppError, Result};
use tauri::{AppHandle, Manager};

/// The last change of line `line` of a file of the open workspace, counted
/// from 1, as git knows it. Returns nothing when git cannot say, for example
/// for a folder that is not a repository or a file git does not track.
#[tauri::command]
pub async fn git_blame(
    rel_path: String,
    line: u32,
    app: AppHandle,
) -> Result<Option<Blame>> {
    // Git reads the history of the file, so it runs off the interface's
    // thread.
    tauri::async_runtime::spawn_blocking(move || {
        let workspace = app.state::<AppState>().workspace()?;
        workspace.resolve(&rel_path)?;
        Ok(blame::of_line(&workspace, &rel_path, line))
    })
    .await
    .map_err(|error| {
        AppError::new("blame_failed", "Could not ask git about that line.")
            .with_detail(error)
    })?
}
