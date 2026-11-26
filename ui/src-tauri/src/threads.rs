//! The commands for discussions, for the parts of a file that discussions
//! and visuals are about, and for building a version again with the current
//! runtime.

use crate::jobs::agent_for_next_job;
use crate::AppState;
use codjiva_core::error::Result;
use codjiva_core::jobs::{self, JobKind};
use codjiva_core::scope::{self, Candidates};
use codjiva_core::threads::{
    self, AskEvent, AskOptions, AskRequest, ThreadView,
};
use tauri::ipc::Channel;
use tauri::{AppHandle, State};

/// Every discussion of the open workspace, the one that was added to last
/// first.
#[tauri::command]
pub fn thread_list(state: State<'_, AppState>) -> Result<Vec<ThreadView>> {
    Ok(threads::list(&*state.workspace()?))
}

/// Puts one question to the agent that would run the next job, and returns
/// the discussion with the question and the answer added. What the agent
/// does meanwhile arrives on `on_event`.
///
/// The agent is asked with the model and the effort of a job that makes a
/// still visual, so that a question about a visual continues the
/// conversation that drew it with the same model.
///
/// `ask_id` is a name the interface chose for this question. Passing it to
/// `job_cancel` stops the question, which then fails with the error
/// `cancelled`.
#[tauri::command]
pub async fn thread_ask(
    request: AskRequest,
    ask_id: String,
    on_event: Channel<AskEvent>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ThreadView> {
    let workspace = state.workspace()?;
    let settings = state.settings();
    let (backend, model) = agent_for_next_job(&app, &settings).await?;
    let options = AskOptions {
        model,
        effort: jobs::effort_for(settings.effort, JobKind::Visualise)
            .map(|effort| effort.as_str().to_string()),
        customizations: settings.agent_customizations,
    };
    let cancel = state.jobs.track(&ask_id);
    let answered = threads::ask(
        &workspace,
        backend.as_ref(),
        &options,
        &request,
        &cancel,
        &|event| {
            let _ = on_event.send(event);
        },
    )
    .await;
    state.jobs.forget(&ask_id);
    answered
}

/// Deletes a discussion, and with it the notes its answers put on visuals.
#[tauri::command]
pub fn thread_delete(id: String, state: State<'_, AppState>) -> Result<()> {
    threads::delete(&*state.workspace()?, &id)
}

/// Works out what the lines `start_line` to `end_line` of the file at
/// `rel_path` can stand for: the lines themselves, and the definition
/// around them when there is one. A selection that a discussion or a visual
/// already exists for gives the scope of that discussion or visual.
#[tauri::command]
pub fn scope_for_selection(
    rel_path: String,
    start_line: u32,
    end_line: u32,
    state: State<'_, AppState>,
) -> Result<Candidates> {
    let workspace = state.workspace()?;
    let known = threads::scopes_of_file(&workspace, &rel_path);
    scope::for_selection(&workspace, &rel_path, start_line, end_line, &known)
}

/// Builds a version of an artifact again with the runtime of this app, as a
/// new version, and returns the number of the new version. No agent runs.
/// See `jobs::rebuild` for when the new version is kept.
#[tauri::command]
pub async fn artifact_rebuild(
    id: String,
    version: u32,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<u32> {
    let workspace = state.workspace()?;
    let validator = state.jobs.validator(&app);
    jobs::rebuild(&workspace, validator.as_ref(), &id, version).await
}
