//! The app's self-check mode.
//!
//! When the environment variable `CODJIVA_SELFCHECK` names a folder, the interface runs a short
//! scripted tour of itself in the real window, saves screenshots and a report into that folder,
//! and the app quits. It exists because the interface runs in a different web engine on each
//! operating system, and this is the only test that exercises the real one.
//!
//!   CODJIVA_SELFCHECK               folder to write report.json and the screenshots into
//!   CODJIVA_SELFCHECK_WORKSPACE     folder to open as the workspace during the tour
//!   CODJIVA_SELFCHECK_VISUALISE     a file of that workspace to run a Visualise job on
//!   CODJIVA_SELFCHECK_INSTRUCTIONS  the instructions to give that job
//!   CODJIVA_SELFCHECK_CANCEL_AFTER  seconds after which the tour cancels that job, to check
//!                                   that cancelling works; the job then makes no version
//!   CODJIVA_SELFCHECK_ANIMATE       a file of that workspace to run an Animate job on
//!   CODJIVA_SELFCHECK_LENGTH        the length to ask for the film, in seconds; 60 when not set
//!   CODJIVA_SELFCHECK_FEEDBACK      feedback to send about the film once it is made
//!   CODJIVA_SELFCHECK_COMPOSE       files of that workspace, separated by commas, whose visuals
//!                                   are joined into a pipeline; each must already have a visual
//!   CODJIVA_SELFCHECK_COMPOSE_FILM  set to 1 to make that pipeline a film, not a still pipeline
//!
//! The job runs with whatever agent the app would use. Setting `CODJIVA_REPLAY_DIR` as well makes
//! that a recorded session, so the whole pipeline is exercised without calling an agent.

use crate::capture::{self, Rect};
use codjiva_core::error::{AppError, Result};
use serde::Serialize;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

fn out_dir() -> Option<PathBuf> {
    std::env::var_os("CODJIVA_SELFCHECK").map(PathBuf::from)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelfCheckConfig {
    workspace: Option<String>,
    visualise: Option<String>,
    instructions: Option<String>,
    animate: Option<String>,
    feedback: Option<String>,
    cancel_after: Option<f64>,
    compose: Vec<String>,
    compose_film: bool,
    length: Option<u32>,
}

/// Returns the self-check settings, or `None` when the app was started normally.
#[tauri::command]
pub fn selfcheck_config(app: AppHandle) -> Option<SelfCheckConfig> {
    out_dir()?;
    // The web engine stops drawing frames in a window that is hidden behind others, which would
    // stall the film the tour plays, so the window is brought to the front first.
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_focus();
    }
    Some(SelfCheckConfig {
        workspace: std::env::var("CODJIVA_SELFCHECK_WORKSPACE").ok(),
        visualise: std::env::var("CODJIVA_SELFCHECK_VISUALISE").ok(),
        instructions: std::env::var("CODJIVA_SELFCHECK_INSTRUCTIONS").ok(),
        animate: std::env::var("CODJIVA_SELFCHECK_ANIMATE").ok().filter(|v| !v.is_empty()),
        feedback: std::env::var("CODJIVA_SELFCHECK_FEEDBACK").ok().filter(|v| !v.is_empty()),
        cancel_after: std::env::var("CODJIVA_SELFCHECK_CANCEL_AFTER").ok().and_then(|v| v.parse().ok()),
        compose_film: std::env::var("CODJIVA_SELFCHECK_COMPOSE_FILM").is_ok_and(|v| v == "1"),
        length: std::env::var("CODJIVA_SELFCHECK_LENGTH").ok().and_then(|v| v.parse().ok()),
        compose: std::env::var("CODJIVA_SELFCHECK_COMPOSE").ok().map(|v| v.split(',').map(|f| f.trim().to_string()).filter(|f| !f.is_empty()).collect()).unwrap_or_default(),
    })
}

/// Saves a screenshot of the window, or of `rect` within it, as `<name>.png` in the self-check
/// folder.
#[tauri::command]
pub async fn selfcheck_capture(name: String, rect: Option<Rect>, app: AppHandle) -> Result<String> {
    let dir = out_dir().ok_or_else(|| AppError::new("not_in_selfcheck", "The app is not running its self-check."))?;
    let png = capture::capture_png(&app, rect, None).await?;
    let safe: String = name.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect();
    let path = dir.join(format!("{safe}.png"));
    std::fs::create_dir_all(&dir).and_then(|_| std::fs::write(&path, png)).map_err(|e| AppError::io("save the screenshot", e))?;
    Ok(path.to_string_lossy().into_owned())
}

/// Appends a comment line to a file of the open workspace, as a stand-in for the user editing
/// it, so the tour can check that the app notices. It only works during a self-check, whose
/// workspace is a throwaway copy.
#[tauri::command]
pub fn selfcheck_edit_file(rel_path: String, state: tauri::State<'_, crate::AppState>) -> Result<()> {
    out_dir().ok_or_else(|| AppError::new("not_in_selfcheck", "The app is not running its self-check."))?;
    let path = state.workspace()?.resolve(&rel_path)?;
    let mut text = std::fs::read_to_string(&path).map_err(|e| AppError::io("read the file", e))?;
    text.push_str("\n// edited by the self-check\n");
    std::fs::write(&path, text).map_err(|e| AppError::io("change the file", e))
}

/// Writes the tour's report and quits the app. The exit code is 0 when every check passed.
#[tauri::command]
pub fn selfcheck_done(report: serde_json::Value, app: AppHandle) {
    let ok = report.get("ok").and_then(serde_json::Value::as_bool).unwrap_or(false);
    if let Some(dir) = out_dir() {
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(dir.join("report.json"), serde_json::to_string_pretty(&report).unwrap_or_default());
    }
    let code = if ok { 0 } else { 1 };
    app.exit(code);
    // The request to quit is handled by the window's event loop. A window that the system has
    // put to rest in the background can leave that request waiting, and the script that
    // started the self-check would then wait for nothing. The report is already saved, so the
    // process is ended directly if it is still here a few seconds later.
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(4));
        std::process::exit(code);
    });
}
