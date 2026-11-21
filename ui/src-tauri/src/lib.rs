//! The Tauri shell: the app window and the commands its interface calls.
//!
//! Each command is a thin wrapper over one function of `codjiva-core`. This
//! file owns only what needs Tauri: the shared state, the events sent to the
//! interface, and the URL scheme that serves artifacts to the sandboxed frame.

mod artifacts;
mod capture;
mod jobs;
mod nav;
mod protocol;
mod selfcheck;

use codjiva_core::error::{AppError, Result};
use codjiva_core::names;
use codjiva_core::settings::{
    self, RecentWorkspace, Settings, WorkspaceSession,
};
use codjiva_core::store::{self, GitignoreChoice, StoreStatus};
use codjiva_core::watch::DirWatcher;
use codjiva_core::workspace::{
    FileContent, FileHit, FileInfo, TreeEntry, Workspace,
};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;

/// Everything the commands share. One workspace is open at a time.
pub struct AppState {
    config_dir: PathBuf,
    workspace: RwLock<Option<Arc<Workspace>>>,
    watcher: Mutex<Option<DirWatcher>>,
    settings: RwLock<Settings>,
    jobs: jobs::JobState,
    nav: nav::NavState,
}

impl AppState {
    /// The open workspace, or the error the interface shows when a command
    /// needs one and none is open.
    pub fn workspace(&self) -> Result<Arc<Workspace>> {
        self.workspace
            .read()
            .expect("the workspace lock is not poisoned")
            .clone()
            .ok_or_else(|| {
                AppError::new("no_workspace", "Open a folder first.")
            })
    }

    /// A copy of the current settings.
    pub fn settings(&self) -> Settings {
        self.settings
            .read()
            .expect("the settings lock is not poisoned")
            .clone()
    }
}

/// Facts about the running app that the interface needs once, at start.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    name: &'static str,
    version: &'static str,
    /// `macos`, `windows` or `linux`. The interface uses it for the title bar
    /// layout and for the form of artifact URLs.
    platform: &'static str,
    runtime_version: &'static str,
    dot_dir: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceInfo {
    root: String,
    name: String,
    store: StoreStatus,
}

#[tauri::command]
fn app_info() -> AppInfo {
    AppInfo {
        name: names::APP_NAME,
        version: env!("CARGO_PKG_VERSION"),
        platform: std::env::consts::OS,
        runtime_version: codjiva_build::RUNTIME_VERSION,
        dot_dir: names::DOT_DIR,
    }
}

#[tauri::command]
fn workspace_open(
    path: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<WorkspaceInfo> {
    let ws = Arc::new(Workspace::open(Path::new(&path))?);
    ws.start_indexing();
    let root = ws.root().to_string_lossy().into_owned();
    // Recent workspaces are a convenience. Failing to record one must not stop
    // the folder opening.
    let _ = settings::remember_workspace(&state.config_dir, &root, ws.name());

    let emitter = app.clone();
    let indexed = Arc::clone(&ws);
    let watcher = DirWatcher::new(ws.root(), move |changes| {
        // A file was added, removed or renamed somewhere visible, so the
        // quick-open list is refreshed. The call does nothing while a refresh
        // is already running.
        indexed.start_indexing();
        let _ = emitter.emit("fs-changed", &changes);
    })?;
    *state
        .watcher
        .lock()
        .expect("the watcher lock is not poisoned") = Some(watcher);

    let info = WorkspaceInfo {
        root,
        name: ws.name().to_string(),
        store: store::status(&ws)?,
    };
    *state
        .workspace
        .write()
        .expect("the workspace lock is not poisoned") = Some(ws);
    Ok(info)
}

#[tauri::command]
fn workspace_close(state: State<'_, AppState>) {
    *state
        .watcher
        .lock()
        .expect("the watcher lock is not poisoned") = None;
    *state
        .workspace
        .write()
        .expect("the workspace lock is not poisoned") = None;
}

#[tauri::command]
fn workspace_recent(state: State<'_, AppState>) -> Vec<RecentWorkspace> {
    settings::recent_workspaces(&state.config_dir)
}

/// The file tabs that were open in the open workspace when it was last used.
#[tauri::command]
fn workspace_session_get(
    state: State<'_, AppState>,
) -> Result<WorkspaceSession> {
    let root = state.workspace()?.root().to_string_lossy().into_owned();
    Ok(settings::workspace_session(&state.config_dir, &root))
}

/// Keeps the file tabs that are open in the open workspace, for the next time
/// the same folder is opened.
#[tauri::command]
fn workspace_session_set(
    session: WorkspaceSession,
    state: State<'_, AppState>,
) -> Result<()> {
    let root = state.workspace()?.root().to_string_lossy().into_owned();
    settings::remember_session(&state.config_dir, &root, &session)
}

#[tauri::command]
fn tree_children(
    rel_path: String,
    state: State<'_, AppState>,
) -> Result<Vec<TreeEntry>> {
    state.workspace()?.children(&rel_path)
}

#[tauri::command]
fn file_info(rel_path: String, state: State<'_, AppState>) -> Result<FileInfo> {
    state.workspace()?.file_info(&rel_path)
}

#[tauri::command]
fn file_read(
    rel_path: String,
    state: State<'_, AppState>,
) -> Result<FileContent> {
    state.workspace()?.read_text(&rel_path)
}

#[tauri::command]
fn files_search(
    query: String,
    limit: Option<usize>,
    state: State<'_, AppState>,
) -> Result<Vec<FileHit>> {
    Ok(state
        .workspace()?
        .search_files(&query, limit.unwrap_or(50).min(200)))
}

/// Replaces the set of folders watched for changes. The interface sends the
/// folders that are expanded in the file tree; `""` is the workspace root.
#[tauri::command]
fn watch_dirs(dirs: Vec<String>, state: State<'_, AppState>) -> Result<()> {
    state.workspace()?;
    if let Some(watcher) = state
        .watcher
        .lock()
        .expect("the watcher lock is not poisoned")
        .as_mut()
    {
        watcher.set(&dirs);
    }
    Ok(())
}

#[tauri::command]
fn store_ensure(state: State<'_, AppState>) -> Result<StoreStatus> {
    store::ensure(&*state.workspace()?)
}

#[tauri::command]
fn gitignore_add(state: State<'_, AppState>) -> Result<StoreStatus> {
    store::add_to_gitignore(&*state.workspace()?)
}

#[tauri::command]
fn gitignore_keep_tracked(state: State<'_, AppState>) -> Result<StoreStatus> {
    store::record_choice(&*state.workspace()?, GitignoreChoice::Tracked)
}

#[tauri::command]
fn settings_get(state: State<'_, AppState>) -> Settings {
    state
        .settings
        .read()
        .expect("the settings lock is not poisoned")
        .clone()
}

#[tauri::command]
fn settings_set(
    settings: Settings,
    state: State<'_, AppState>,
) -> Result<Settings> {
    settings.save(&state.config_dir)?;
    *state
        .settings
        .write()
        .expect("the settings lock is not poisoned") = settings.clone();
    Ok(settings)
}

/// Splits a command line into its program and arguments. Double quotes group
/// words that contain spaces. No shell is involved, so nothing else is special.
fn split_command(command: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    let mut started = false;
    for c in command.chars() {
        match c {
            '"' => {
                quoted = !quoted;
                started = true;
            }
            c if c.is_whitespace() && !quoted => {
                if started {
                    parts.push(std::mem::take(&mut current));
                    started = false;
                }
            }
            c => {
                current.push(c);
                started = true;
            }
        }
    }
    if started {
        parts.push(current);
    }
    parts
}

/// Opens a workspace file at a line in the user's own editor, using the command
/// template from Settings. `{file}` is replaced by the file's absolute path and
/// `{line}` by the line number.
#[tauri::command]
fn open_external(
    rel_path: String,
    line: Option<u32>,
    state: State<'_, AppState>,
) -> Result<()> {
    let ws = state.workspace()?;
    let file = ws.resolve(&rel_path)?;
    let template = state
        .settings
        .read()
        .expect("the settings lock is not poisoned")
        .external_editor_command
        .clone();
    let parts: Vec<String> = split_command(&template)
        .into_iter()
        .map(|part| {
            part.replace("{file}", &file.to_string_lossy())
                .replace("{line}", &line.unwrap_or(1).to_string())
        })
        .collect();
    let Some((program, args)) = parts.split_first() else {
        return Err(AppError::new(
            "no_editor_command",
            "No external editor command is set. Add one in Settings.",
        ));
    };
    std::process::Command::new(program)
        .args(args)
        .current_dir(ws.root())
        .spawn()
        .map(|_| ())
        .map_err(|e| {
            AppError::new(
                "editor_failed",
                format!(
                    "Could not start \"{program}\". Check the external editor \
                     command in Settings."
                ),
            )
            .with_detail(e)
        })
}

/// Shows a workspace file or folder in the operating system's file manager.
#[tauri::command]
fn reveal(
    rel_path: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<()> {
    let path = state.workspace()?.resolve(&rel_path)?;
    app.opener().reveal_item_in_dir(path).map_err(|e| {
        AppError::new(
            "reveal_failed",
            "Could not show that item in the file manager.",
        )
        .with_detail(e)
    })
}

pub fn run() {
    let config_dir = settings::config_dir();
    let loaded = Settings::load(&config_dir).unwrap_or_default();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        // The updater reads `latest.json` from the newest release on GitHub
        // and installs a newer version when the interface asks it to. The
        // process plugin restarts the app afterwards.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(AppState {
            config_dir,
            workspace: RwLock::new(None),
            watcher: Mutex::new(None),
            settings: RwLock::new(loaded),
            jobs: jobs::JobState::default(),
            nav: nav::NavState::default(),
        })
        .register_asynchronous_uri_scheme_protocol(
            names::SCHEME,
            |ctx, request, responder| {
                let app = ctx.app_handle().clone();
                // Building and reading pages can take a moment, so it is done
                // off the main thread.
                std::thread::spawn(move || {
                    let state = app.state::<AppState>();
                    responder.respond(protocol::respond(
                        &state,
                        request.uri().path(),
                    ));
                });
            },
        )
        .invoke_handler(tauri::generate_handler![
            app_info,
            workspace_open,
            workspace_close,
            workspace_recent,
            workspace_session_get,
            workspace_session_set,
            tree_children,
            file_info,
            file_read,
            files_search,
            watch_dirs,
            store_ensure,
            gitignore_add,
            gitignore_keep_tracked,
            settings_get,
            settings_set,
            open_external,
            reveal,
            jobs::agents_detect,
            jobs::job_start,
            jobs::job_estimate,
            jobs::job_cancel,
            jobs::suggest_cached,
            jobs::suggest_views,
            jobs::job_validated,
            jobs::api_providers,
            jobs::api_key_set,
            jobs::api_key_clear,
            jobs::api_check,
            jobs::companions_suggest,
            jobs::companions_ignore_check,
            jobs::feedback_capture,
            jobs::folder_info,
            jobs::compose_propose,
            artifacts::artifact_list,
            artifacts::artifact_detail,
            artifacts::artifact_set_current,
            artifacts::artifact_delete,
            artifacts::artifact_export,
            artifacts::artifact_open_in_browser,
            artifacts::artifact_reveal,
            artifacts::guard_revert,
            nav::nav_lookup,
            nav::nav_references,
            nav::nav_cancel,
            nav::nav_symbols,
            nav::nav_refresh,
            selfcheck::selfcheck_config,
            selfcheck::selfcheck_capture,
            selfcheck::selfcheck_edit_file,
            selfcheck::selfcheck_done,
        ])
        .run(tauri::generate_context!())
        .expect("the app starts");
}

#[cfg(test)]
mod tests {
    use super::split_command;

    #[test]
    fn splits_a_command_template_and_keeps_quoted_words_together() {
        assert_eq!(
            split_command("code -g {file}:{line}"),
            vec!["code", "-g", "{file}:{line}"]
        );
        assert_eq!(
            split_command(
                "\"/Applications/My Editor/bin/edit\"  --line {line} {file}"
            ),
            vec![
                "/Applications/My Editor/bin/edit",
                "--line",
                "{line}",
                "{file}"
            ]
        );
        assert!(split_command("   ").is_empty());
    }
}
