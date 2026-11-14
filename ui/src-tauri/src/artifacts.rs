//! The commands that list, show, switch, export and delete artifacts.

use crate::AppState;
use codjiva_core::artifacts::{self, ArtifactDetail, ArtifactSummary};
use codjiva_core::error::{AppError, Result};
use codjiva_core::guard::{self, RevertResult, Violation};
use std::path::PathBuf;
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
pub fn artifact_list(state: State<'_, AppState>) -> Result<Vec<ArtifactSummary>> {
    Ok(artifacts::list(&*state.workspace()?))
}

#[tauri::command]
pub fn artifact_detail(id: String, version: Option<u32>, state: State<'_, AppState>) -> Result<ArtifactDetail> {
    artifacts::detail(&*state.workspace()?, &id, version)
}

#[tauri::command]
pub fn artifact_set_current(id: String, version: u32, state: State<'_, AppState>) -> Result<()> {
    artifacts::set_current(&*state.workspace()?, &id, version)
}

#[tauri::command]
pub fn artifact_delete(id: String, state: State<'_, AppState>) -> Result<()> {
    artifacts::delete(&*state.workspace()?, &id)
}

/// Copies a version's self-contained page to a path the user chose in a save dialog.
#[tauri::command]
pub fn artifact_export(id: String, version: Option<u32>, dest_path: String, state: State<'_, AppState>) -> Result<()> {
    artifacts::export(&*state.workspace()?, &id, version, &PathBuf::from(dest_path))
}

/// Opens a version's page in the user's default browser.
#[tauri::command]
pub fn artifact_open_in_browser(id: String, version: u32, app: AppHandle, state: State<'_, AppState>) -> Result<()> {
    let page = artifacts::version_dir(&*state.workspace()?, &id, version)?.join("index.html");
    app.opener().open_path(page.to_string_lossy(), None::<&str>).map_err(|e| AppError::new("open_failed", "Could not open the artifact in a browser.").with_detail(e))
}

/// Shows a version's folder in the operating system's file manager.
#[tauri::command]
pub fn artifact_reveal(id: String, version: u32, app: AppHandle, state: State<'_, AppState>) -> Result<()> {
    let dir = artifacts::version_dir(&*state.workspace()?, &id, version)?;
    app.opener().reveal_item_in_dir(dir.join("index.html")).map_err(|e| AppError::new("reveal_failed", "Could not show that folder in the file manager.").with_detail(e))
}

/// Undoes the changes a failed job's agent made outside `.codjiva/`, where git can restore them.
#[tauri::command]
pub fn guard_revert(violations: Vec<Violation>, state: State<'_, AppState>) -> Result<Vec<RevertResult>> {
    Ok(guard::revert(&*state.workspace()?, &violations))
}
