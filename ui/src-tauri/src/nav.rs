//! The commands of code navigation in the source view: what a name is and
//! where it is defined, where it is used, and which definitions have a name
//! like the one the user typed.

use crate::AppState;
use codjiva_core::error::{AppError, Result};
use codjiva_core::nav::{self, Lookup, RefsEvent, SymbolHit};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

/// What the navigation commands share: the switch that stops the search for
/// references that is running. Only one such search runs at a time, because
/// the interface shows the references of one name.
#[derive(Default)]
pub struct NavState {
    search: Mutex<Arc<AtomicBool>>,
}

impl NavState {
    /// Stops the running search, if there is one, and returns the switch of
    /// a new one.
    fn next_search(&self) -> Arc<AtomicBool> {
        let mut search = self.search.lock().expect("the lock is not poisoned");
        search.store(true, Ordering::SeqCst);
        *search = Arc::new(AtomicBool::new(false));
        Arc::clone(&search)
    }
}

fn failed(error: impl ToString) -> AppError {
    AppError::new("navigation_failed", "Could not read the code for that.")
        .with_detail(error)
}

/// Says what the name at a place of a file is and where it is defined. The
/// line is counted from 1 and the column from 0, in UTF-16 code units.
/// `declaration` asks for prototypes before bodies. Returns nothing when
/// there is no name at that place.
#[tauri::command]
pub async fn nav_lookup(
    rel_path: String,
    line: u32,
    column: u32,
    declaration: Option<bool>,
    app: AppHandle,
) -> Result<Option<Lookup>> {
    // A lookup reads and parses files, so it runs off the interface's thread.
    tauri::async_runtime::spawn_blocking(move || {
        let workspace = app.state::<AppState>().workspace()?;
        workspace.resolve(&rel_path)?;
        Ok(nav::lookup(
            workspace.nav(),
            &rel_path,
            line,
            column,
            declaration.unwrap_or(false),
        ))
    })
    .await
    .map_err(failed)?
}

/// Searches for the uses of the name at a place of a file, and sends them to
/// `on_event` as they are found. The command returns when the search has
/// ended. A search that is still running when this is called again, or when
/// `nav_cancel` is called, ends early.
#[tauri::command]
pub async fn nav_references(
    rel_path: String,
    line: u32,
    column: u32,
    on_event: Channel<RefsEvent>,
    app: AppHandle,
) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let workspace = state.workspace()?;
        workspace.resolve(&rel_path)?;
        let cancel = state.nav.next_search();
        nav::references(
            workspace.nav(),
            &rel_path,
            line,
            column,
            &cancel,
            &mut |event| {
                // A search that was stopped has been replaced by another
                // one, and its results must not be mixed into that one's.
                if !cancel.load(Ordering::SeqCst) {
                    let _ = on_event.send(event);
                }
            },
        );
        Ok(())
    })
    .await
    .map_err(failed)?
}

/// Stops the running search for references, if there is one.
#[tauri::command]
pub fn nav_cancel(state: State<'_, AppState>) {
    state.nav.next_search();
}

/// Lists definitions whose name contains `query`, best first.
#[tauri::command]
pub fn nav_symbols(
    query: String,
    limit: Option<usize>,
    state: State<'_, AppState>,
) -> Result<Vec<SymbolHit>> {
    Ok(state
        .workspace()?
        .nav()
        .search(&query, limit.unwrap_or(50).min(200)))
}

/// Lists the files of the workspace again and brings the navigation index
/// up to date with them. The interface calls this when the window comes to
/// the front, because the user may have changed files in another program
/// meanwhile.
#[tauri::command]
pub fn nav_refresh(state: State<'_, AppState>) -> Result<()> {
    state.workspace()?.start_indexing();
    Ok(())
}
