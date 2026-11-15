//! The commands that start, cancel and report on jobs, and the bridge that lets
//! a job have its result checked in the app's own web engine.

use crate::capture::{self, Rect};
use crate::AppState;
use async_trait::async_trait;
use codjiva_core::agents::api::catalog::{self, ProviderStatus};
use codjiva_core::agents::api::keys::{Keys, MemoryKeyStore, OsKeyStore};
use codjiva_core::agents::replay::ReplayBackend;
use codjiva_core::agents::{definition, detect_cli_agents, AgentInfo, Backend};
use codjiva_core::companions::{self, FolderInfo, IgnoreCheck, Suggestion};
use codjiva_core::compose::{self, ArtifactPorts, Join};
use codjiva_core::env::ShellEnv;
use codjiva_core::error::{AppError, Result};
use codjiva_core::jobs::{self, JobContext, JobEvent, JobRequest, Validator};
use codjiva_core::settings::Settings;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

/// How long a job waits for the window to return a self-test report. The
/// self-test itself is given 60 seconds; the rest covers loading the page.
const VALIDATION_WAIT: Duration = Duration::from_secs(90);

/// The width in pixels of the picture of a frame that is given to an agent with
/// feedback. It is wide enough to read every label and small enough to be cheap
/// for a model to look at.
const FEEDBACK_IMAGE_WIDTH: f64 = 1440.0;

/// What the job commands share: the agents found on this machine, the user's
/// API keys, the jobs that are running and the self-tests the window has been
/// asked to run.
pub struct JobState {
    env: OnceLock<Arc<ShellEnv>>,
    /// The command-line agents found on this machine. `None` until they are
    /// first looked for.
    cli_backends: Mutex<Option<Vec<Arc<dyn Backend>>>>,
    keys: Keys,
    running: Mutex<HashMap<String, CancellationToken>>,
    /// Self-tests in progress, by the token sent to the window. The sender
    /// delivers the report back to the waiting job.
    validations: Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>,
}

impl Default for JobState {
    fn default() -> Self {
        // The automated self-check, and anyone who sets CODJIVA_KEYS=memory,
        // gets a key store that lives only in memory, so the user's real
        // credentials are never read or changed.
        let in_memory = std::env::var_os("CODJIVA_SELFCHECK").is_some()
            || std::env::var("CODJIVA_KEYS").is_ok_and(|v| v == "memory");
        let keys = if in_memory {
            Keys::new(Box::new(MemoryKeyStore::default()))
        } else {
            Keys::new(Box::new(OsKeyStore))
        };
        JobState {
            env: OnceLock::new(),
            cli_backends: Mutex::new(None),
            keys,
            running: Mutex::new(HashMap::new()),
            validations: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

impl JobState {
    /// The environment agents run in. Reading it starts the user's login shell,
    /// which can take a few seconds, so it is done once and only when an agent
    /// is first needed.
    fn env(&self) -> Arc<ShellEnv> {
        Arc::clone(self.env.get_or_init(|| Arc::new(ShellEnv::capture())))
    }

    /// Everything that could run jobs: the command-line agents first, then the
    /// API providers.
    ///
    /// Command-line agents are looked for on first use and again when `refresh`
    /// is true, for example after the user installed one. API providers are
    /// built from the current settings and keys on every call, so a key or
    /// model the user just changed takes effect at once.
    fn backends(
        &self,
        config_dir: &std::path::Path,
        settings: &Settings,
        refresh: bool,
    ) -> Vec<Arc<dyn Backend>> {
        let overrides = &settings.agent_paths;
        let mut cached = self
            .cli_backends
            .lock()
            .expect("the agents lock is not poisoned");
        if refresh || cached.is_none() {
            let mut found: Vec<Arc<dyn Backend>> = Vec::new();
            // A recorded session stands in for an agent when this variable
            // names its folder. The app's self-check and work on the interface
            // use it.
            if let Some(dir) = std::env::var_os("CODJIVA_REPLAY_DIR") {
                found.push(Arc::new(ReplayBackend::new(
                    &PathBuf::from(dir),
                    Duration::from_millis(60),
                )));
            }
            let (definitions, _problems) =
                definition::load_definitions(config_dir);
            for backend in
                detect_cli_agents(&definitions, &self.env(), overrides)
            {
                found.push(Arc::new(backend));
            }
            *cached = Some(found);
        }
        let mut all = cached.clone().unwrap_or_default();
        all.extend(catalog::backends(settings, &self.keys));
        all
    }
}

/// Lists the agents that could run jobs, with what is known about each.
#[tauri::command]
pub async fn agents_detect(
    refresh: Option<bool>,
    app: AppHandle,
) -> Result<Vec<AgentInfo>> {
    // Detection starts programs and waits for them, so it runs off the
    // interface's thread.
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let state = app.state::<AppState>();
        state
            .jobs
            .backends(
                &state.config_dir,
                &state.settings(),
                refresh.unwrap_or(false),
            )
            .iter()
            .map(|b| b.info())
            .collect()
    })
    .await
    .map_err(|e| {
        AppError::new("detect_failed", "Could not look for agents.")
            .with_detail(e)
    })
}

/// Lists the API providers with what each still needs before it can run a job.
#[tauri::command]
pub async fn api_providers(app: AppHandle) -> Result<Vec<ProviderStatus>> {
    // Reading a key can make the operating system show a permission prompt and
    // wait for the user, so it runs off the interface's thread.
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let state = app.state::<AppState>();
        catalog::statuses(&state.settings(), &state.jobs.keys)
    })
    .await
    .map_err(|e| {
        AppError::new("keys_failed", "Could not read the API keys.")
            .with_detail(e)
    })
}

/// Saves the key of one provider in the operating system's credential store.
#[tauri::command]
pub async fn api_key_set(
    provider_id: String,
    key: String,
    app: AppHandle,
) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let spec = catalog::spec(&provider_id)?;
        app.state::<AppState>().jobs.keys.save(spec.id, &key)
    })
    .await
    .map_err(|e| {
        AppError::new("keys_failed", "Could not save the API key.")
            .with_detail(e)
    })?
}

/// Removes the saved key of one provider.
#[tauri::command]
pub async fn api_key_clear(provider_id: String, app: AppHandle) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let spec = catalog::spec(&provider_id)?;
        app.state::<AppState>().jobs.keys.forget(spec.id)
    })
    .await
    .map_err(|e| {
        AppError::new("keys_failed", "Could not remove the API key.")
            .with_detail(e)
    })?
}

/// Sends one very small request to a provider and returns the name of the model
/// that answered. It tells the user whether the key, the model and the address
/// work before a job depends on them.
#[tauri::command]
pub async fn api_check(
    provider_id: String,
    state: State<'_, AppState>,
) -> Result<String> {
    let spec = catalog::spec(&provider_id)?;
    catalog::check(spec, &state.settings(), &state.jobs.keys).await
}

/// Suggests companion files for a film of `rel_path`, best first.
#[tauri::command]
pub async fn companions_suggest(
    rel_path: String,
    app: AppHandle,
) -> Result<Vec<Suggestion>> {
    // The search reads many files, so it runs off the interface's thread.
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let state = app.state::<AppState>();
        let workspace = state.workspace()?;
        // The list of files is made in the background when a workspace opens. A
        // request that arrives before it is complete waits for it, but not for
        // long.
        let began = std::time::Instant::now();
        while !workspace.index_complete()
            && began.elapsed() < Duration::from_secs(5)
        {
            std::thread::sleep(Duration::from_millis(25));
        }
        let settings = state.settings();
        let ignored = companions::IgnoreList::new(&settings.companion_ignore);
        Ok(companions::suggest(
            &workspace,
            &rel_path,
            &workspace.indexed_files(),
            settings.max_companion_files as usize,
            &ignored,
        ))
    })
    .await
    .map_err(|e| {
        AppError::new("suggest_failed", "Could not look for companion files.")
            .with_detail(e)
    })?
}

/// Reports what the ignore patterns `patterns` match among the code files of
/// the open workspace, and which of `paths` they match. With no workspace open,
/// only the patterns that cannot be read are reported. Nothing is saved.
#[tauri::command]
pub async fn companions_ignore_check(
    patterns: Vec<String>,
    paths: Vec<String>,
    app: AppHandle,
) -> Result<IgnoreCheck> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let state = app.state::<AppState>();
        let files = state
            .workspace()
            .map(|workspace| workspace.indexed_files())
            .unwrap_or_default();
        companions::check_ignore(&patterns, &files, &paths)
    })
    .await
    .map_err(|e| {
        AppError::new("ignore_check_failed", "Could not try those patterns.")
            .with_detail(e)
    })
}

/// What the compose dialog starts from: the ports of the chosen artifacts and
/// the joins the app proposes between them.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposeProposal {
    parts: Vec<ArtifactPorts>,
    joins: Vec<Join>,
}

/// Reads the ports of the given artifacts and proposes joins between them.
#[tauri::command]
pub fn compose_propose(
    artifact_ids: Vec<String>,
    state: State<'_, AppState>,
) -> Result<ComposeProposal> {
    let workspace = state.workspace()?;
    let parts = compose::artifact_ports(&workspace, &artifact_ids)?;
    let joins = compose::propose_joins(&workspace, &parts);
    Ok(ComposeProposal { parts, joins })
}

/// Describes a folder for a Visualise job on the whole folder: its code files,
/// their size and an estimate of the tokens an agent would read.
#[tauri::command]
pub async fn folder_info(
    rel_path: String,
    app: AppHandle,
) -> Result<FolderInfo> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let state = app.state::<AppState>();
        let workspace = state.workspace()?;
        workspace.resolve(rel_path.trim_matches('/'))?;
        let began = std::time::Instant::now();
        while !workspace.index_complete()
            && began.elapsed() < Duration::from_secs(5)
        {
            std::thread::sleep(Duration::from_millis(25));
        }
        Ok(companions::folder_info(
            &workspace,
            &rel_path,
            &workspace.indexed_files(),
        ))
    })
    .await
    .map_err(|e| {
        AppError::new("folder_failed", "Could not read that folder.")
            .with_detail(e)
    })?
}

/// Saves a picture of `rect` of the window for a feedback job, and returns its
/// path relative to the workspace. Returns `None` on systems where the app
/// cannot take such a picture; the feedback is then sent without one.
#[tauri::command]
pub async fn feedback_capture(
    rect: Rect,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<String>> {
    let workspace = state.workspace()?;
    let Ok(png) =
        capture::capture_png(&app, Some(rect), Some(FEEDBACK_IMAGE_WIDTH))
            .await
    else {
        return Ok(None);
    };
    let dir = workspace.dot_dir().join("jobs").join("frames");
    let path = dir.join(format!("frame-{}.png", jobs::new_job_id()));
    std::fs::create_dir_all(&dir)
        .and_then(|_| std::fs::write(&path, png))
        .map_err(|e| AppError::io("save the picture of the frame", e))?;
    Ok(workspace.relative(&path))
}

/// The agent that runs the next job: the one chosen in Settings if it is
/// usable, otherwise the first usable one.
fn choose_backend(
    backends: &[Arc<dyn Backend>],
    wanted: Option<&str>,
) -> Result<Arc<dyn Backend>> {
    let usable: Vec<&Arc<dyn Backend>> =
        backends.iter().filter(|b| b.info().ok).collect();
    let chosen = wanted
        .and_then(|id| usable.iter().find(|b| b.info().id == id))
        .or_else(|| usable.first());
    chosen.map(|b| Arc::clone(b)).ok_or_else(|| {
        let hint = backends
            .iter()
            .map(|b| b.info().note)
            .find(|n| !n.is_empty())
            .unwrap_or_default();
        AppError::new(
            "no_agent",
            format!("No agent is available to run this. {hint}")
                .trim()
                .to_string(),
        )
    })
}

/// What the window is sent when a job needs a version checked.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ValidateRequest {
    token: String,
    artifact_id: String,
    version: u32,
}

/// Asks the app window to load a built version in a hidden frame, run its
/// self-test there and send the report back.
struct WindowValidator {
    app: AppHandle,
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>,
}

#[async_trait]
impl Validator for WindowValidator {
    async fn validate(&self, artifact_id: &str, version: u32) -> Result<Value> {
        let token = jobs::new_job_id();
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .expect("the validations lock is not poisoned")
            .insert(token.clone(), tx);
        let sent = self.app.emit(
            "validate-request",
            ValidateRequest {
                token: token.clone(),
                artifact_id: artifact_id.to_string(),
                version,
            },
        );
        let report = match sent {
            Err(e) => Err(AppError::new(
                "validation_failed",
                "The result could not be handed to the window for checking.",
            )
            .with_detail(e)),
            Ok(()) => match tokio::time::timeout(VALIDATION_WAIT, rx).await {
                Ok(Ok(report)) => Ok(report),
                _ => Err(AppError::new(
                    "validation_timeout",
                    "The self-test did not finish. The result was not shown \
                     because it could not be checked.",
                )),
            },
        };
        self.pending
            .lock()
            .expect("the validations lock is not poisoned")
            .remove(&token);
        report
    }
}

/// Starts a job and returns its id at once. Everything the job does arrives on
/// `on_event`.
#[tauri::command]
pub async fn job_start(
    request: JobRequest,
    on_event: Channel<JobEvent>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String> {
    let workspace = state.workspace()?;
    let settings = state.settings();
    let detect_app = app.clone();
    let detect_settings = settings.clone();
    let backends = tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let state = detect_app.state::<AppState>();
        state
            .jobs
            .backends(&state.config_dir, &detect_settings, false)
    })
    .await
    .map_err(|e| {
        AppError::new("detect_failed", "Could not look for agents.")
            .with_detail(e)
    })?;
    let backend = choose_backend(&backends, settings.agent.as_deref())?;
    let model = settings
        .models
        .get(&backend.info().id)
        .cloned()
        .filter(|m| !m.trim().is_empty());

    let job_id = jobs::new_job_id();
    let cancel = CancellationToken::new();
    state
        .jobs
        .running
        .lock()
        .expect("the jobs lock is not poisoned")
        .insert(job_id.clone(), cancel.clone());

    let ctx = JobContext {
        workspace,
        backend,
        validator: Arc::new(WindowValidator {
            app: app.clone(),
            pending: Arc::clone(&state.jobs.validations),
        }),
        cancel,
        emit: Arc::new(move |event| {
            let _ = on_event.send(event);
        }),
        model,
        effort: jobs::effort_for(settings.effort, request.kind),
        max_budget_usd: settings.max_budget_usd,
        max_fix_iterations: settings.max_fix_iterations,
    };
    let finished_id = job_id.clone();
    tauri::async_runtime::spawn(async move {
        use tauri::Manager;
        jobs::run(ctx, request, finished_id.clone()).await;
        app.state::<AppState>()
            .jobs
            .running
            .lock()
            .expect("the jobs lock is not poisoned")
            .remove(&finished_id);
    });
    Ok(job_id)
}

/// Asks a running job to stop. The job reports `cancelled` on its event channel
/// when it has.
#[tauri::command]
pub fn job_cancel(job_id: String, state: State<'_, AppState>) {
    if let Some(cancel) = state
        .jobs
        .running
        .lock()
        .expect("the jobs lock is not poisoned")
        .get(&job_id)
    {
        cancel.cancel();
    }
}

/// Delivers a self-test report from the window to the job that asked for it.
#[tauri::command]
pub fn job_validated(token: String, report: Value, state: State<'_, AppState>) {
    if let Some(sender) = state
        .jobs
        .validations
        .lock()
        .expect("the validations lock is not poisoned")
        .remove(&token)
    {
        let _ = sender.send(report);
    }
}
