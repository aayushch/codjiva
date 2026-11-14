//! Jobs: one run of an agent that produces a new version of an artifact.
//!
//! There are three kinds of job:
//!
//!   Visualise  makes a still visual of one file
//!   Animate    makes a film of one file and its companions
//!   Compose    joins existing artifacts into one pipeline, as a visual or a film
//!   Feedback   changes an existing version according to what the user said about it
//!
//! A job goes through these steps:
//!
//!   prepare    choose the artifact and version, write the prompt files. A feedback job also
//!              copies the files of the version it changes into the new version folder.
//!   agent      the agent reads the code and writes sources; its progress is streamed
//!   guard      check that nothing outside `.codjiva/` was touched
//!   build      join the sources with the runtime into one page
//!   validate   run the page's self-test in a real web engine
//!   fix        if a check failed, send the exact report back to the agent and repeat from guard
//!   commit     write the manifest and make the version current
//!
//! The job reports everything it does as [`JobEvent`]s. It never shows a result that was not
//! built and checked.

use crate::agents::{AgentEvent, Backend, Turn};
use crate::artifacts::{self, AgentRecord, ArtifactKind, Companion, Manifest, ValidationRecord};
use crate::compose::{self, ArtifactPorts, Join, Part};
use crate::error::{AppError, Result};
use crate::guard::{self, Violation};
use crate::prompts::{self, Guide, Values, PROMPT_VERSION};
use crate::settings::{Effort, EffortSetting};
use crate::workspace::Workspace;
use crate::{companions, reference, store, util};
use async_trait::async_trait;
use codjiva_build::{Diagnostic, Severity, Sources};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

/// How often the agent's progress file is read while a turn runs.
const PROGRESS_POLL: Duration = Duration::from_millis(400);

/// The most issues that are written into a fix prompt. A result with more problems than this
/// is fixed in several rounds.
const REPORT_LIMIT: usize = 40;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JobKind {
    #[default]
    Visualise,
    Animate,
    Compose,
    Feedback,
}

/// The thinking effort a job of `kind` asks its agent for, given what Settings says. `None`
/// means nothing is asked for and the agent uses its own default.
pub fn effort_for(setting: EffortSetting, kind: JobKind) -> Option<Effort> {
    match setting {
        EffortSetting::Auto => Some(if matches!(kind, JobKind::Animate | JobKind::Compose) { Effort::Medium } else { Effort::Low }),
        EffortSetting::Agent => None,
        EffortSetting::Low => Some(Effort::Low),
        EffortSetting::Medium => Some(Effort::Medium),
        EffortSetting::High => Some(Effort::High),
    }
}

/// What the user said about a version, and what they were looking at when they said it.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Feedback {
    /// The user's words.
    pub text: String,
    /// Where a film was stopped, in real seconds from its start.
    pub time: Option<f64>,
    /// The title of the chapter on screen.
    pub chapter: Option<String>,
    /// The id of the scene on screen, and the same moment as that scene's animation time.
    pub scene: Option<String>,
    pub scene_time: Option<f64>,
    /// The element the user pointed at, as the runtime described it: its selector, text and box.
    pub point_at: Option<Value>,
    /// The part that was selected in a visual.
    pub selected: Option<String>,
    /// A picture of what the user saw, as a path relative to the workspace.
    pub screenshot: Option<String>,
}

/// What the interface asks for when the user starts a job.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobRequest {
    pub kind: JobKind,
    /// The file the artifact explains, relative to the workspace. A feedback job leaves it
    /// empty, because the version it changes already records its subject.
    #[serde(default)]
    pub subject: Vec<String>,
    /// Other files the agent should read.
    #[serde(default)]
    pub companions: Vec<String>,
    /// What the user wants this result to show, in their own words. May be empty.
    #[serde(default)]
    pub instructions: String,
    /// For a film: how long it should be, in real seconds.
    #[serde(default)]
    pub length_seconds: Option<u32>,
    /// For a film: an outline the user has approved or edited, which the agent must follow.
    #[serde(default)]
    pub outline: Option<Value>,
    /// For a feedback job: the artifact and the version to change.
    #[serde(default)]
    pub artifact_id: Option<String>,
    #[serde(default)]
    pub base_version: Option<u32>,
    #[serde(default)]
    pub feedback: Option<Feedback>,
    /// For a compose job: the ids of the artifacts to join, in flow order, the joins the user
    /// confirmed, and whether the pipeline is a film. Without `film` it is a still visual.
    #[serde(default)]
    pub parts: Vec<String>,
    #[serde(default)]
    pub joins: Vec<Join>,
    #[serde(default)]
    pub film: bool,
}


#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Info,
    Tool,
    Warn,
    Error,
}

/// Everything a job tells the interface, in order.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum JobEvent {
    /// The job has an artifact and a version, and an agent is about to start.
    Started { job_id: String, artifact_id: String, version: u32, agent: String },
    /// The job entered a phase: reading, analysing, outline, drawing, chapter, annotating,
    /// revising, building, validating, fixing. `detail` is a note from the agent, if it wrote
    /// one. While a film's chapters are written, `chapter` and `of` say which one is in work.
    Phase { phase: String, detail: Option<String>, chapter: Option<u32>, of: Option<u32> },
    /// The agent wrote the outline of a film: its chapters, each with a title and a summary.
    Outline { outline: Value },
    /// One line for the job log.
    Log { level: LogLevel, text: String },
    /// The result of the write guard after an agent turn. An empty list is the good outcome.
    Guard { violations: Vec<Violation> },
    /// The report of one build and self-test. `iteration` is 0 for the first, 1 after one fix.
    Validation { report: Value, iteration: u32 },
    /// What the job has cost so far, where the agent reports it.
    Usage { cost_usd: Option<f64>, input_tokens: u64, output_tokens: u64 },
    /// The job finished and the version is saved. `passed` is false when checks still fail after
    /// the allowed fix rounds; the version is kept and shown with its issues.
    Result { artifact_id: String, version: u32, passed: bool, errors: u32, warnings: u32 },
    Failed { code: String, message: String },
    Cancelled,
}

/// Runs the self-test of a built version in a real web engine. The desktop app implements this
/// with a hidden frame in its window; tests implement it with a fixed answer.
#[async_trait]
pub trait Validator: Send + Sync {
    async fn validate(&self, artifact_id: &str, version: u32) -> Result<Value>;
}

/// What a job needs besides the request.
pub struct JobContext {
    pub workspace: Arc<Workspace>,
    pub backend: Arc<dyn Backend>,
    pub validator: Arc<dyn Validator>,
    pub cancel: CancellationToken,
    pub emit: Arc<dyn Fn(JobEvent) + Send + Sync>,
    /// The model to ask the agent for, or `None` for the agent's own default.
    pub model: Option<String>,
    /// How much effort the model should spend on thinking, or `None` to leave it to the agent.
    pub effort: Option<Effort>,
    pub max_budget_usd: Option<f64>,
    /// How many times a failed check is sent back to the agent.
    pub max_fix_iterations: u32,
}

/// A job id that is unique within this run of the app and sorts by start time.
pub fn new_job_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let millis = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    format!("j{millis}-{}", COUNTER.fetch_add(1, Ordering::SeqCst))
}

/// The paths of one job. Folders are absolute; the `rel_` forms are relative to the workspace
/// root, with `/` separators, which is how prompts name them.
struct JobPaths {
    job_dir: PathBuf,
    version_dir: PathBuf,
    rel_job_dir: String,
    rel_version_dir: String,
}

fn rel(ws: &Workspace, path: &Path) -> String {
    ws.relative(path).unwrap_or_else(|| path.to_string_lossy().into_owned())
}

fn io(doing: &'static str) -> impl Fn(std::io::Error) -> AppError {
    move |e| AppError::io(doing, e)
}

/// Collects every `"ref": "path:line"` value in the analysis, however deeply nested.
fn collect_refs(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::Object(map) => {
            for (key, inner) in map {
                match (key.as_str(), inner) {
                    ("ref", Value::String(text)) => out.push(text.clone()),
                    _ => collect_refs(inner, out),
                }
            }
        }
        Value::Array(items) => items.iter().for_each(|item| collect_refs(item, out)),
        _ => {}
    }
}

/// Splits `path:line` or `path:start-end` into the path and the last line it names.
fn parse_ref(reference: &str) -> Option<(&str, u64)> {
    let (path, lines) = reference.rsplit_once(':')?;
    let last = lines.rsplit('-').next()?.parse().ok()?;
    Some((path, last))
}

/// Checks the agent's analysis: it must exist and match its schema, and every code reference in
/// it should point at a real line. A missing or malformed analysis is an error, because every
/// claim an artifact makes has to be traceable. A reference to a line that does not exist is a
/// warning.
fn check_model(ws: &Workspace, version_dir: &Path) -> (Option<Value>, Vec<Diagnostic>) {
    let Ok(text) = std::fs::read_to_string(version_dir.join("model.json")) else {
        let missing = Diagnostic { check: "missing-file".into(), severity: Severity::Error, file: "model.json".into(), line: None,
            message: "model.json is missing; write the analysis before drawing".into() };
        return (None, vec![missing]);
    };
    let (model, mut found) = codjiva_build::check_json("model.json", &text, codjiva_build::runtime::MODEL_SCHEMA);
    if let Some(model) = &model {
        let mut refs = Vec::new();
        collect_refs(model, &mut refs);
        let mut line_counts: BTreeMap<String, Option<u64>> = BTreeMap::new();
        for reference in refs {
            let Some((path, line)) = parse_ref(&reference) else { continue };
            let lines = *line_counts.entry(path.to_string()).or_insert_with(|| ws.file_info(path).ok().and_then(|info| info.lines));
            let problem = match lines {
                None => Some(format!("the reference \"{reference}\" names a file that does not exist in the workspace")),
                Some(count) if line == 0 || line > count => Some(format!("the reference \"{reference}\" names line {line}, but the file has {count} lines")),
                Some(_) => None,
            };
            if let Some(message) = problem {
                found.push(Diagnostic { check: "refs".into(), severity: Severity::Warning, file: "model.json".into(), line: None, message });
            }
        }
    }
    (model, found)
}

/// Checks a film's outline. A missing or malformed outline is a warning, not an error: the user
/// is shown the outline while the film is made, but the film itself does not depend on it.
fn check_outline(version_dir: &Path) -> Vec<Diagnostic> {
    let warning = |message: String| Diagnostic { check: "outline".into(), severity: Severity::Warning, file: "outline.json".into(), line: None, message };
    let Ok(text) = std::fs::read_to_string(version_dir.join("outline.json")) else {
        return vec![warning("outline.json is missing".into())];
    };
    let (_, found) = codjiva_build::check_json("outline.json", &text, codjiva_build::runtime::OUTLINE_SCHEMA);
    found.into_iter().map(|problem| warning(problem.message)).collect()
}

/// The outcome of building and checking a version once.
struct CheckOutcome {
    /// The combined report: build problems, analysis problems and the self-test's issues.
    report: Value,
    errors: u32,
    warnings: u32,
    /// True when a page was built, so there is something to show even if checks failed.
    built: bool,
    title: Option<String>,
    model: Option<Value>,
}

fn count(diagnostics: &[Diagnostic], severity: Severity) -> u32 {
    diagnostics.iter().filter(|d| d.severity == severity).count() as u32
}

/// Joins the sources into one page and saves it as the version's `index.html`. Returns false,
/// with the reasons added to `problems`, when the sources cannot be built.
fn build_page(sources: &Sources, version_dir: &Path, problems: &mut Vec<Diagnostic>, title: &mut Option<String>) -> Result<bool> {
    match codjiva_build::build(sources) {
        Ok(built) => {
            problems.extend(built.warnings);
            *title = Some(built.title);
            std::fs::write(version_dir.join("index.html"), built.html).map_err(io("save the built artifact"))?;
            Ok(true)
        }
        Err(failure) => {
            problems.extend(failure.diagnostics);
            Ok(false)
        }
    }
}

/// Builds the version's page from the agent's sources, checks the analysis, and, when a page was
/// built, runs its self-test.
async fn build_and_check(ctx: &JobContext, plan: &Plan, version: u32, version_dir: &Path) -> Result<CheckOutcome> {
    let artifact_id = plan.artifact_id.as_str();
    (ctx.emit)(JobEvent::Phase { phase: "building".into(), detail: None, chapter: None, of: None });
    let mut sources = Sources::read_dir(&version_dir.join("src")).unwrap_or_default();
    let (model, mut problems) = check_model(&ctx.workspace, version_dir);
    // The job decides what is built. A film job that produced only a still visual has not
    // produced its film, and the other way round.
    let declared = if plan.film {
        problems.extend(check_outline(version_dir));
        sources.visual_json = None;
        sources.film_json.is_some()
    } else {
        sources.film_json = None;
        sources.scenes.clear();
        sources.visual_json.is_some()
    };
    if plan.kind == ArtifactKind::Pipeline && sources.pipeline_json.is_none() {
        problems.push(Diagnostic { check: "missing-file".into(), severity: Severity::Error, file: "pipeline.json".into(), line: None, message: "pipeline.json is missing from the sources folder; the app wrote it, so do not delete it".into() });
    }
    if plan.kind != ArtifactKind::Pipeline {
        // Only a pipeline has parts. Anything of the kind in another artifact is not built.
        sources.pipeline_json = None;
        sources.parts.clear();
    }
    let mut title = None;
    let built = if !declared || problems.iter().any(|p| p.check == "missing-file" && p.file == "pipeline.json") {
        let file = if plan.film { "film.json" } else { "visual.json" };
        if !declared {
            problems.push(Diagnostic { check: "missing-file".into(), severity: Severity::Error, file: file.into(), line: None, message: format!("{file} is missing from the sources folder") });
        }
        false
    } else {
        build_page(&sources, version_dir, &mut problems, &mut title)?
    };

    let mut selftest = json!({ "issues": [], "stats": {} });
    if built {
        (ctx.emit)(JobEvent::Phase { phase: "validating".into(), detail: None, chapter: None, of: None });
        selftest = ctx.validator.validate(artifact_id, version).await?;
    }
    let issues = selftest.get("issues").and_then(Value::as_array).cloned().unwrap_or_default();
    let with = |severity: &str| issues.iter().filter(|i| i.get("severity").and_then(Value::as_str) == Some(severity)).count() as u32;
    let errors = count(&problems, Severity::Error) + with("error");
    let warnings = count(&problems, Severity::Warning) + with("warning");
    let report = json!({
        "ok": errors == 0,
        "built": built,
        "build": problems,
        "issues": issues,
        "stats": selftest.get("stats").cloned().unwrap_or(Value::Null),
        "duration": selftest.get("duration").cloned().unwrap_or(Value::Null),
        "chapters": selftest.get("chapters").cloned().unwrap_or(Value::Null),
    });
    Ok(CheckOutcome { report, errors, warnings, built, title, model })
}

/// Writes the errors of a report as the text a fix prompt carries: one line per problem, with
/// the file and line for build problems and the elements and hint for self-test issues.
fn report_for_agent(report: &Value) -> String {
    let mut lines: Vec<String> = Vec::new();
    for problem in report["build"].as_array().into_iter().flatten().filter(|p| p["severity"] == "error") {
        let place = match problem["line"].as_u64() {
            Some(line) => format!("{}:{line}", problem["file"].as_str().unwrap_or("")),
            None => problem["file"].as_str().unwrap_or("").to_string(),
        };
        lines.push(format!("- [build · {}] {place}: {}", problem["check"].as_str().unwrap_or(""), problem["message"].as_str().unwrap_or("")));
    }
    for issue in report["issues"].as_array().into_iter().flatten().filter(|i| i["severity"] == "error") {
        // The fields an agent needs to find and fix the elements, without the counters.
        let mut slim = serde_json::Map::new();
        for key in ["check", "scene", "t", "message", "a", "b", "hint"] {
            if let Some(value) = issue.get(key).filter(|v| !v.is_null()) {
                slim.insert(key.to_string(), value.clone());
            }
        }
        lines.push(format!("- [self-test] {}", Value::Object(slim)));
    }
    let total = lines.len();
    lines.truncate(REPORT_LIMIT);
    if total > REPORT_LIMIT {
        lines.push(format!("({} more errors are not listed. Fix these first; the next report will list the rest.)", total - REPORT_LIMIT));
    }
    lines.join("\n")
}

/// Watches the version folder while an agent works, until `stop` is triggered. It reports each
/// change of phase in the agent's `progress.json`, and each new content of `outline.json`.
async fn watch_progress(version_dir: PathBuf, emit: Arc<dyn Fn(JobEvent) + Send + Sync>, stop: CancellationToken) {
    let mut last_phase: Option<(String, Option<u32>)> = None;
    let mut last_outline: Option<String> = None;
    // After `stop`, the files are read one last time, so what the agent wrote just before its
    // turn ended is still reported.
    let mut stopped = false;
    loop {
        if let Ok(text) = tokio::fs::read_to_string(version_dir.join("progress.json")).await {
            if let Ok(progress) = serde_json::from_str::<Value>(&text) {
                let phase = progress.get("phase").and_then(Value::as_str).unwrap_or("").to_string();
                let detail = progress.get("note").and_then(Value::as_str).filter(|n| !n.is_empty()).map(str::to_string);
                let number = |key: &str| progress.get(key).and_then(Value::as_u64).map(|n| n as u32);
                let (chapter, of) = (number("chapter"), number("of"));
                let now = (phase.clone(), chapter);
                // "done" is the agent's own view. The job decides when it is done, after its checks.
                if !phase.is_empty() && phase != "done" && last_phase.as_ref() != Some(&now) {
                    emit(JobEvent::Phase { phase, detail, chapter, of });
                    last_phase = Some(now);
                }
            }
        }
        if let Ok(text) = tokio::fs::read_to_string(version_dir.join("outline.json")).await {
            // The file is read while the agent may still be writing it, so only a complete
            // outline with at least one chapter is reported.
            if last_outline.as_deref() != Some(text.as_str()) {
                if let Ok(outline) = serde_json::from_str::<Value>(&text) {
                    if outline["chapters"].as_array().is_some_and(|chapters| !chapters.is_empty()) {
                        emit(JobEvent::Outline { outline });
                        last_outline = Some(text);
                    }
                }
            }
        }
        if stopped {
            return;
        }
        tokio::select! {
            _ = stop.cancelled() => stopped = true,
            _ = tokio::time::sleep(PROGRESS_POLL) => {}
        }
    }
}

/// Turns what an agent does into lines of the job log and running totals of its cost.
struct AgentReporter {
    emit: Arc<dyn Fn(JobEvent) + Send + Sync>,
    /// Cost and tokens of the turns that have finished, to which the running turn's are added.
    totals: Mutex<(Option<f64>, u64, u64)>,
}

impl AgentReporter {
    fn handle(&self, event: AgentEvent) {
        let log = |level: LogLevel, text: String| (self.emit)(JobEvent::Log { level, text });
        match event {
            AgentEvent::SessionStarted { model, .. } => log(LogLevel::Info, match model {
                Some(model) => format!("The agent started ({model})."),
                None => "The agent started.".to_string(),
            }),
            AgentEvent::Text(text) => {
                let short: String = text.chars().take(600).collect();
                log(LogLevel::Info, short);
            }
            AgentEvent::ToolUse { name, summary } => log(LogLevel::Tool, format!("{name} {summary}").trim().to_string()),
            AgentEvent::FileWritten(_) => {}
            AgentEvent::PermissionDenied { tool } => log(LogLevel::Warn, format!("The agent's use of {tool} was refused by its permission rules.")),
            AgentEvent::Notice(text) => log(LogLevel::Info, text),
            AgentEvent::Usage { cost_usd, input_tokens, output_tokens } => {
                let mut totals = self.totals.lock().expect("the usage lock is not poisoned");
                if let Some(cost) = cost_usd {
                    totals.0 = Some(totals.0.unwrap_or(0.0) + cost);
                }
                totals.1 += input_tokens.unwrap_or(0);
                totals.2 += output_tokens.unwrap_or(0);
                (self.emit)(JobEvent::Usage { cost_usd: totals.0, input_tokens: totals.1, output_tokens: totals.2 });
            }
            AgentEvent::Finished { .. } => {}
        }
    }
}

/// Writes the files every turn of a job reads: the schemas, the runtime API reference and the
/// worked example.
fn write_job_support(job_dir: &Path) -> Result<()> {
    let doing = "prepare the job folder";
    std::fs::create_dir_all(job_dir.join("schemas")).map_err(io(doing))?;
    for (name, schema) in [
        ("model.schema.json", codjiva_build::runtime::MODEL_SCHEMA), ("visual.schema.json", codjiva_build::runtime::VISUAL_SCHEMA),
        ("film.schema.json", codjiva_build::runtime::FILM_SCHEMA), ("outline.schema.json", codjiva_build::runtime::OUTLINE_SCHEMA),
    ] {
        std::fs::write(job_dir.join("schemas").join(name), schema).map_err(io(doing))?;
    }
    std::fs::write(job_dir.join("runtime-api.md"), codjiva_build::runtime::runtime_api_doc()).map_err(io(doing))?;
    reference::write_sources(&job_dir.join("reference")).map_err(io(doing))
}

/// The source files a version was made from: the subject, the companions the user chose, the
/// companions the agent recorded, and every file its analysis refers to. Each is recorded with
/// its current content hash; files that do not exist are left out.
fn source_hashes(ws: &Workspace, subject: &[String], companions: &[String], model: Option<&Value>) -> BTreeMap<String, String> {
    let mut paths: BTreeSet<String> = subject.iter().chain(companions).cloned().collect();
    if let Some(model) = model {
        for companion in model["companions"].as_array().into_iter().flatten() {
            if let Some(path) = companion["path"].as_str() {
                paths.insert(path.to_string());
            }
        }
        let mut refs = Vec::new();
        collect_refs(model, &mut refs);
        paths.extend(refs.iter().filter_map(|r| parse_ref(r)).map(|(path, _)| path.to_string()));
    }
    paths.into_iter().filter_map(|path| ws.hash_file(&path).map(|hash| (path, hash))).collect()
}

/// Runs a job to its end and reports the end as an event: `Result`, `Failed` or `Cancelled`.
pub async fn run(ctx: JobContext, request: JobRequest, job_id: String) {
    let emit = Arc::clone(&ctx.emit);
    match run_inner(&ctx, &request, &job_id).await {
        Ok(Some(event)) => emit(event),
        Ok(None) => emit(JobEvent::Cancelled),
        Err(error) => emit(JobEvent::Failed { code: error.code, message: error.message }),
    }
}

/// What a job is going to make, worked out from the request before anything is written.
struct Plan {
    kind: ArtifactKind,
    guide: Guide,
    artifact_id: String,
    subject: Vec<String>,
    /// The companions the user chose.
    companions: Vec<String>,
    /// For a visual of a whole folder: the code files in it. Empty for a single file.
    folder_files: Vec<String>,
    /// True when the job makes a film: an Animate job, or a pipeline in film form.
    film: bool,
    /// For a pipeline: its parts with their ports, in flow order, and the joins between them.
    parts: Vec<(Part, ArtifactPorts)>,
    joins: Vec<Join>,
    instructions: String,
    /// The version the new one is derived from: the version on screen for a feedback job, the
    /// current version for a regeneration, and `None` for a first version.
    parent: Option<u32>,
    /// For a feedback job: the manifest of the version being changed.
    base: Option<Manifest>,
}

/// Checks the request and decides what the job makes.
fn plan(ws: &Workspace, request: &JobRequest) -> Result<Plan> {
    if request.kind == JobKind::Feedback {
        let (Some(id), Some(version)) = (request.artifact_id.as_deref(), request.base_version) else {
            return Err(AppError::new("bad_request", "The feedback does not say which version it is about."));
        };
        if request.feedback.as_ref().is_none_or(|f| f.text.trim().is_empty()) {
            return Err(AppError::new("bad_request", "Write what should change first."));
        }
        let base = artifacts::read_manifest(ws, id, version)?;
        return Ok(Plan {
            film: base.kind == ArtifactKind::Film || base.form.as_deref() == Some("film"),
            parts: Vec::new(),
            joins: base.joins.clone(),
            kind: base.kind,
            guide: Guide::Fix,
            artifact_id: base.artifact_id.clone(),
            subject: base.subject.clone(),
            companions: base.companions.iter().map(|c| c.path.clone()).collect(),
            instructions: base.instructions.clone(),
            folder_files: Vec::new(),
            parent: Some(version),
            base: Some(base),
        });
    }

    if request.kind == JobKind::Compose {
        return plan_pipeline(ws, request);
    }

    let (kind, guide, verb) = match request.kind {
        JobKind::Animate => (ArtifactKind::Film, Guide::Animate, "animate"),
        _ => (ArtifactKind::Visual, Guide::Visualise, "visualise"),
    };
    if request.subject.len() != 1 {
        return Err(AppError::new("bad_request", format!("Choose exactly one file to {verb}.")));
    }
    // A subject that ends with a slash is a folder. Only a still visual can be made of one.
    if let Some(dir) = request.subject[0].strip_suffix('/') {
        if request.kind != JobKind::Visualise {
            return Err(AppError::new("bad_request", "A film follows one file. Choose a file to animate."));
        }
        if !ws.resolve(dir)?.is_dir() {
            return Err(AppError::new("not_found", format!("The folder {dir} does not exist.")));
        }
        let info = companions::folder_info(ws, dir, &list_files(ws));
        if info.files.is_empty() {
            return Err(AppError::new("empty_folder", format!("The folder {dir} holds no code files.")));
        }
        if info.too_large {
            return Err(AppError::new("folder_too_large", format!(
                "The folder {dir} holds {} code files, about {} thousand tokens. That is more than an agent can read at once. Choose a smaller folder.",
                info.files.len(), info.estimated_tokens / 1000)));
        }
        let subject = vec![format!("{}/", info.rel_path)];
        let artifact_id = artifacts::artifact_id(kind, &subject);
        let parent = artifacts::read_meta(ws, &artifact_id).ok().map(|meta| meta.current_version);
        return Ok(Plan { kind, guide, artifact_id, subject, companions: Vec::new(), folder_files: info.files, film: false, parts: Vec::new(), joins: Vec::new(),
            instructions: request.instructions.trim().to_string(), parent, base: None });
    }
    for path in request.subject.iter().chain(&request.companions) {
        let info = ws.file_info(path)?;
        if info.binary {
            return Err(AppError::new("binary_file", format!("{path} is not a text file, so there is no code to read.")));
        }
    }
    let artifact_id = artifacts::artifact_id(kind, &request.subject);
    let parent = artifacts::read_meta(ws, &artifact_id).ok().map(|meta| meta.current_version);
    Ok(Plan { kind, guide, artifact_id, subject: request.subject.clone(), companions: request.companions.clone(), folder_files: Vec::new(),
        film: kind == ArtifactKind::Film, parts: Vec::new(), joins: Vec::new(), instructions: request.instructions.trim().to_string(), parent, base: None })
}

/// Checks a compose request and decides what the pipeline is made of.
///
/// A pipeline needs at least two parts, each a visual or a film, each of a different file, and
/// at least one join between them. The pipeline's subject is the files of its parts, so the same
/// set of files always gives the same pipeline, and composing them again adds a version.
fn plan_pipeline(ws: &Workspace, request: &JobRequest) -> Result<Plan> {
    if request.parts.len() < 2 {
        return Err(AppError::new("bad_request", "Choose at least two artifacts to compose."));
    }
    if request.parts.len() > 6 {
        return Err(AppError::new("bad_request", "A pipeline can join at most six artifacts."));
    }
    let ports = compose::artifact_ports(ws, &request.parts)?;
    let mut subjects: BTreeSet<&str> = BTreeSet::new();
    for part in &ports {
        let kind = artifacts::read_meta(ws, &part.artifact_id)?.kind;
        if kind == ArtifactKind::Pipeline {
            return Err(AppError::new("bad_request", "A pipeline cannot be a part of another pipeline. Choose visuals and films."));
        }
        if !subjects.insert(part.subject.first().map(String::as_str).unwrap_or("")) {
            return Err(AppError::new("bad_request", "Two of the chosen artifacts explain the same file. Choose one of them."));
        }
    }
    if request.joins.is_empty() {
        return Err(AppError::new("bad_request", "Choose at least one join between the artifacts."));
    }
    for join in &request.joins {
        if !request.parts.contains(&join.from_artifact) || !request.parts.contains(&join.to_artifact) {
            return Err(AppError::new("bad_request", "A join names an artifact that is not one of the parts."));
        }
    }
    let keys = compose::part_keys(&ports);
    let parts: Vec<(Part, ArtifactPorts)> = ports.into_iter().zip(keys).map(|(port, key)| (Part { key, artifact: port.artifact_id.clone(), version: port.version }, port)).collect();
    let subject: Vec<String> = parts.iter().filter_map(|(_, ports)| ports.subject.first().cloned()).collect();
    let artifact_id = artifacts::artifact_id(ArtifactKind::Pipeline, &subject);
    let parent = artifacts::read_meta(ws, &artifact_id).ok().map(|meta| meta.current_version);
    Ok(Plan {
        kind: ArtifactKind::Pipeline, guide: Guide::Compose, artifact_id, subject, companions: Vec::new(), folder_files: Vec::new(),
        film: request.film, parts, joins: request.joins.clone(), instructions: request.instructions.trim().to_string(), parent, base: None,
    })
}

/// Copies each part's plant into the new version's `parts/<key>/` folder. The pipeline keeps
/// its own copies, so a later change to a part does not change a pipeline that was already made.
fn copy_parts(ws: &Workspace, plan: &Plan, version_dir: &Path) -> Result<()> {
    for (part, _) in &plan.parts {
        let from = artifacts::version_dir(ws, &part.artifact, part.version)?.join("src/plant.js");
        let to = version_dir.join("src/parts").join(&part.key);
        std::fs::create_dir_all(&to).and_then(|()| std::fs::copy(&from, to.join("plant.js")).map(|_| ())).map_err(io("copy a part into the pipeline"))?;
    }
    Ok(())
}

/// Puts the parts' plants back as they were copied, and returns the keys of the parts whose
/// copy the agent had changed. A part is shown in a pipeline exactly as it was made.
fn restore_parts(ws: &Workspace, plan: &Plan, version_dir: &Path) -> Vec<String> {
    let mut changed = Vec::new();
    for (part, _) in &plan.parts {
        let Ok(source) = artifacts::version_dir(ws, &part.artifact, part.version) else { continue };
        let original = std::fs::read(source.join("src/plant.js")).unwrap_or_default();
        let copy = version_dir.join("src/parts").join(&part.key).join("plant.js");
        if std::fs::read(&copy).unwrap_or_default() != original {
            let _ = std::fs::create_dir_all(copy.parent().expect("the copy has a parent folder"));
            let _ = std::fs::write(&copy, &original);
            changed.push(part.key.clone());
        }
    }
    changed
}

/// Describes the parts and the joins of a pipeline for the agent's prompt.
fn pipeline_values(ws: &Workspace, plan: &Plan, values: &mut Values) -> Result<()> {
    let mut parts = Vec::new();
    for (part, ports) in &plan.parts {
        let dir = rel(ws, &artifacts::version_dir(ws, &part.artifact, part.version)?);
        let mut lines = vec![
            format!("- `{}`: {} ({})", part.key, ports.title, ports.subject.join(", ")),
            format!("  Its analysis: {dir}/model.json. Its sources: {dir}/src/. Its plant, copied for you: {}/parts/{}/plant.js.", values["srcDir"], part.key),
        ];
        for port in &ports.ports {
            let anchor = port.anchor.map(|a| format!(", anchor [{}, {}]", a[0], a[1])).unwrap_or_default();
            lines.push(format!("  Port `{}`: `{}` at {}{anchor}. Carries: {}.", port.id, port.symbol, port.reference, if port.carries.is_empty() { "not said" } else { &port.carries }));
        }
        parts.push(lines.join("\n"));
    }
    values.insert("parts", parts.join("\n"));
    let key_of = |artifact: &str| plan.parts.iter().find(|(part, _)| part.artifact == artifact).map(|(part, _)| part.key.as_str()).unwrap_or("?");
    let joins: Vec<String> = plan.joins.iter().map(|join| {
        format!("- `{}#{}` → `{}#{}`{}", key_of(&join.from_artifact), join.from_port, key_of(&join.to_artifact), join.to_port, if join.reason.is_empty() { String::new() } else { format!(" ({})", join.reason) })
    }).collect();
    values.insert("joins", joins.join("\n"));
    values.insert("form", if plan.film { "film" } else { "visual" }.to_string());
    Ok(())
}

/// Every file of the workspace, relative to its root, found by walking it now with the same
/// ignore rules as the file tree.
fn list_files(ws: &Workspace) -> Vec<String> {
    crate::workspace::walker(ws.root()).build().flatten().filter(|item| item.file_type().is_some_and(|t| t.is_file()))
        .filter_map(|item| item.path().strip_prefix(ws.root()).ok().map(crate::workspace::to_rel_string)).collect()
}

/// Copies every file under `from` to the same relative path under `to`.
fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    if !from.is_dir() {
        return Ok(());
    }
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

/// Fills in the prompt values that describe what the user said about a version.
fn feedback_values(values: &mut Values, feedback: &Feedback) {
    let seconds = |x: f64| format!("{}", (x * 10.0).round() / 10.0);
    values.insert("feedback", feedback.text.trim().to_string());
    if let Some(time) = feedback.time {
        values.insert("time", seconds(time));
    }
    if let Some(chapter) = &feedback.chapter {
        values.insert("chapter", chapter.clone());
    }
    if let (Some(scene), Some(scene_time)) = (&feedback.scene, feedback.scene_time) {
        values.insert("scene", scene.clone());
        values.insert("sceneTime", seconds(scene_time));
    }
    if let Some(point_at) = feedback.point_at.as_ref().filter(|p| p.is_object()) {
        values.insert("pointAt", point_at.to_string());
    }
    if let Some(selected) = &feedback.selected {
        values.insert("selected", selected.clone());
    }
    if let Some(screenshot) = &feedback.screenshot {
        values.insert("screenshot", screenshot.clone());
    }
}

/// The body of [`run`]. Returns the final `Result` event, or `None` when the job was cancelled.
async fn run_inner(ctx: &JobContext, request: &JobRequest, job_id: &str) -> Result<Option<JobEvent>> {
    let ws = &ctx.workspace;
    let plan = plan(ws, request)?;
    let (kind, artifact_id) = (plan.kind, plan.artifact_id.clone());

    // ---- prepare
    store::ensure(ws)?;
    let version = artifacts::next_version(ws, &artifact_id)?;
    let version_dir = artifacts::version_dir(ws, &artifact_id, version)?;
    let job_dir = ws.dot_dir().join("jobs").join(job_id);
    std::fs::create_dir_all(version_dir.join("src")).map_err(io("create the version folder"))?;
    write_job_support(&job_dir)?;
    let paths = JobPaths { rel_job_dir: rel(ws, &job_dir), rel_version_dir: rel(ws, &version_dir), job_dir, version_dir };

    // A failed or cancelled job leaves no half-made version behind.
    let discard = || { let _ = std::fs::remove_dir_all(&paths.version_dir); };

    let mut values: Values = BTreeMap::new();
    values.insert("artifactDir", paths.rel_version_dir.clone());
    values.insert("srcDir", format!("{}/src", paths.rel_version_dir));
    values.insert("schemasDir", format!("{}/schemas", paths.rel_job_dir));
    values.insert("referenceDir", format!("{}/reference", paths.rel_job_dir));
    values.insert("subject", plan.subject.join(", "));
    if !plan.folder_files.is_empty() {
        values.insert("folderFiles", plan.folder_files.join("\n"));
    }
    values.insert("companions", plan.companions.join(", "));
    values.insert("instructions", plan.instructions.clone());

    let mut user_prompt = match request.kind {
        JobKind::Compose => {
            values.insert("length", request.length_seconds.unwrap_or(180).to_string());
            if let Some(parent) = plan.parent {
                values.insert("previous", rel(ws, &artifacts::version_dir(ws, &artifact_id, parent)?));
            }
            let parts: Vec<Part> = plan.parts.iter().map(|(part, _)| part.clone()).collect();
            let prepared = copy_parts(ws, &plan, &paths.version_dir)
                .and_then(|()| compose::pipeline_json("Pipeline", &parts, &plan.joins))
                .and_then(|pipeline| util::write_atomic(&paths.version_dir.join("src/pipeline.json"), &serde_json::to_string_pretty(&pipeline).unwrap_or_default()))
                .and_then(|()| pipeline_values(ws, &plan, &mut values));
            if let Err(error) = prepared {
                discard();
                return Err(error);
            }
            prompts::user_compose(&values)
        }
        JobKind::Visualise => {
            if let Some(parent) = plan.parent {
                values.insert("previous", rel(ws, &artifacts::version_dir(ws, &artifact_id, parent)?));
            }
            prompts::user_visualise(&values)
        }
        JobKind::Animate => {
            values.insert("length", request.length_seconds.unwrap_or(180).to_string());
            if let Some(parent) = plan.parent {
                values.insert("previous", rel(ws, &artifacts::version_dir(ws, &artifact_id, parent)?));
            }
            // A still visual of the same file gives the film its plant to start from.
            let visual_id = artifacts::artifact_id(ArtifactKind::Visual, &plan.subject);
            if let Ok(meta) = artifacts::read_meta(ws, &visual_id) {
                values.insert("visual", rel(ws, &artifacts::version_dir(ws, &visual_id, meta.current_version)?));
            }
            if let Some(outline) = request.outline.as_ref().filter(|o| o.is_object()) {
                let text = serde_json::to_string_pretty(outline).unwrap_or_default();
                if let Err(error) = util::write_atomic(&paths.version_dir.join("outline.json"), &text) {
                    discard();
                    return Err(error);
                }
                values.insert("outline", text);
            }
            prompts::user_animate(&values)
        }
        JobKind::Feedback => {
            // The new version starts as a copy of the one the user looked at.
            let from = artifacts::version_dir(ws, &artifact_id, plan.parent.unwrap_or(1))?;
            let copied = copy_tree(&from.join("src"), &paths.version_dir.join("src")).and_then(|()| {
                for name in ["model.json", "outline.json"] {
                    if from.join(name).is_file() {
                        std::fs::copy(from.join(name), paths.version_dir.join(name))?;
                    }
                }
                Ok(())
            });
            if let Err(error) = copied {
                discard();
                return Err(AppError::io("copy the version to change", error));
            }
            feedback_values(&mut values, request.feedback.as_ref().expect("plan() checked that the feedback is present"));
            // A model reached through an API has only the tools the app gives it, and none of
            // them can show it a picture. It is told the moment and the element in words.
            if ctx.backend.info().kind == "api" {
                values.remove("screenshot");
            }
            prompts::user_fix_feedback(&values)
        }
    };
    let system_prompt_path = paths.job_dir.join("system.md");
    util::write_atomic(&system_prompt_path, &prompts::system_prompt(plan.guide, &values))?;

    let agent = ctx.backend.info();
    (ctx.emit)(JobEvent::Started { job_id: job_id.to_string(), artifact_id: artifact_id.clone(), version, agent: agent.name.clone() });

    let reporter = Arc::new(AgentReporter { emit: Arc::clone(&ctx.emit), totals: Mutex::new((None, 0, 0)) });
    // A feedback job continues the conversation that made the version, when the same agent made
    // it and can continue a conversation. The agent then still knows why it drew things as it did.
    let mut session: Option<String> = plan.base.as_ref().filter(|base| base.agent.kind == agent.id && agent.supports_resume).and_then(|base| base.agent.session_id.clone());
    let mut continues_earlier_session = session.is_some();
    let mut model_used: Option<String> = None;
    let mut iteration = 0u32;
    let before = guard::snapshot(ws);
    let store_before = guard::snapshot_store(ws, &paths.version_dir);

    let outcome = loop {
        // ---- agent
        let user_prompt_path = paths.job_dir.join(format!("user-{}.md", iteration + 1));
        util::write_atomic(&user_prompt_path, &user_prompt)?;
        let turn = Turn {
            workspace_root: ws.root().to_path_buf(),
            dot_dir: ws.dot_dir(),
            artifact_dir: paths.version_dir.clone(),
            job_dir: paths.job_dir.clone(),
            system_prompt_path: system_prompt_path.clone(),
            user_prompt_path,
            user_prompt: user_prompt.clone(),
            resume_session: if agent.supports_resume { session.clone() } else { None },
            model: ctx.model.clone(),
            effort: ctx.effort.map(|e| e.as_str().to_string()),
            max_budget_usd: ctx.max_budget_usd,
            log_path: paths.version_dir.join("agent.log.jsonl"),
        };
        let phase = match (iteration, request.kind) {
            (0, JobKind::Feedback) => "revising",
            (0, _) => "reading",
            _ => "fixing",
        };
        (ctx.emit)(JobEvent::Phase { phase: phase.into(), detail: None, chapter: None, of: None });
        // The progress file still holds the previous turn's last phase, which must not be
        // reported again as if it were new.
        let _ = std::fs::remove_file(paths.version_dir.join("progress.json"));
        let stop_watching = CancellationToken::new();
        let watcher = tokio::spawn(watch_progress(paths.version_dir.clone(), Arc::clone(&ctx.emit), stop_watching.clone()));
        let on_event = { let reporter = Arc::clone(&reporter); move |event: AgentEvent| reporter.handle(event) };
        let turn_result = ctx.backend.run(&turn, &ctx.cancel, &on_event).await;
        stop_watching.cancel();
        let _ = watcher.await;

        if ctx.cancel.is_cancelled() || turn_result.as_ref().is_ok_and(|outcome| outcome.cancelled) {
            discard();
            return Ok(None);
        }
        // The conversation that made the earlier version may no longer exist, for example after
        // the agent cleared its history. The turn is then run once more as a new conversation.
        let failed = turn_result.as_ref().map_or(true, |outcome| outcome.error.is_some());
        if failed && continues_earlier_session {
            continues_earlier_session = false;
            session = None;
            (ctx.emit)(JobEvent::Log { level: LogLevel::Warn, text: "The earlier conversation could not be continued, so the agent starts a new one.".into() });
            continue;
        }
        continues_earlier_session = false;
        let turn_outcome = match turn_result {
            Ok(outcome) => outcome,
            Err(error) => { discard(); return Err(error); }
        };
        session = turn_outcome.session_id.or(session);
        model_used = turn_outcome.model.or(model_used);
        if let Some(message) = turn_outcome.error {
            discard();
            return Err(AppError::new("agent_failed", message));
        }

        // ---- guard
        let mut touched = guard::violations(ws, &before);
        touched.extend(guard::store_violations(ws, &store_before, &paths.version_dir));
        (ctx.emit)(JobEvent::Guard { violations: touched.clone() });
        if !touched.is_empty() {
            discard();
            let names: Vec<&str> = touched.iter().map(|v| v.path.as_str()).collect();
            return Err(AppError::new("write_guard", format!("The agent changed files it must not touch: {}. The result was discarded.", names.join(", "))));
        }

        // ---- build and validate
        let touched_parts = restore_parts(ws, &plan, &paths.version_dir);
        if !touched_parts.is_empty() {
            (ctx.emit)(JobEvent::Log { level: LogLevel::Warn, text: format!("The agent changed the copy of {}. A part is shown as it was made, so the copy was put back.", touched_parts.join(", ")) });
        }
        let check = match build_and_check(ctx, &plan, version, &paths.version_dir).await {
            Ok(check) => check,
            Err(error) => { discard(); return Err(error); }
        };
        if ctx.cancel.is_cancelled() {
            discard();
            return Ok(None);
        }
        (ctx.emit)(JobEvent::Validation { report: check.report.clone(), iteration });
        if check.errors == 0 || iteration >= ctx.max_fix_iterations {
            break check;
        }

        // ---- fix
        iteration += 1;
        util::write_json(&paths.job_dir.join(format!("report-{iteration}.json")), &check.report)?;
        let mut fix_values = values.clone();
        fix_values.insert("round", iteration.to_string());
        fix_values.insert("maxRounds", ctx.max_fix_iterations.to_string());
        fix_values.insert("report", report_for_agent(&check.report));
        user_prompt = prompts::user_fix_report(&fix_values);
    };

    // ---- commit
    if !outcome.built {
        discard();
        let first = outcome.report["build"].as_array().and_then(|list| list.iter().find(|p| p["severity"] == "error"))
            .and_then(|p| p["message"].as_str()).unwrap_or("the sources could not be built").to_string();
        return Err(AppError::new("build_failed", format!("The agent's result could not be built after {iteration} fix round(s): {first}.")));
    }
    util::write_json(&paths.version_dir.join("validation.json"), &outcome.report)?;
    let companions = outcome.model.as_ref().and_then(|m| serde_json::from_value::<Vec<Companion>>(m["companions"].clone()).ok())
        .unwrap_or_else(|| plan.companions.iter().map(|path| Companion { path: path.clone(), why: String::new() }).collect());
    // A feedback job does not read the code again, so its version keeps the source hashes of
    // the version it changed. Whether it is stale is still judged against the code the agent
    // actually read.
    let sources = match &plan.base {
        Some(base) => base.sources.clone(),
        // For a folder, every code file in it is a source, so a change to any of them makes the
        // visual stale.
        None if !plan.folder_files.is_empty() => source_hashes(ws, &plan.folder_files, &plan.companions, outcome.model.as_ref()),
        // A pipeline is made from everything its parts were made from.
        None if !plan.parts.is_empty() => {
            let mut files: Vec<String> = Vec::new();
            for (part, _) in &plan.parts {
                files.extend(artifacts::read_manifest(ws, &part.artifact, part.version)?.sources.into_keys());
            }
            source_hashes(ws, &files, &[], outcome.model.as_ref())
        }
        None => source_hashes(ws, &plan.subject, &plan.companions, outcome.model.as_ref()),
    };
    let totals = *reporter.totals.lock().expect("the usage lock is not poisoned");
    let manifest = Manifest {
        schema_version: artifacts::SCHEMA_VERSION,
        artifact_id: artifact_id.clone(),
        version,
        kind,
        title: outcome.title.clone().unwrap_or_else(|| plan.subject.first().cloned().unwrap_or_default()),
        subject: plan.subject.clone(),
        companions,
        sources,
        instructions: plan.instructions.clone(),
        agent: AgentRecord { kind: agent.id.clone(), version: agent.version.clone(), model: model_used.or_else(|| ctx.model.clone()), session_id: session },
        prompt_version: PROMPT_VERSION.to_string(),
        runtime_version: codjiva_build::RUNTIME_VERSION.to_string(),
        duration_sec: outcome.report["duration"].as_f64(),
        chapters: outcome.report["chapters"].as_array().cloned().unwrap_or_default(),
        ports: outcome.model.as_ref().and_then(|m| m["ports"].as_array().cloned()).unwrap_or_default(),
        validation: ValidationRecord { passed: outcome.errors == 0, iterations: iteration, errors: outcome.errors, warnings: outcome.warnings },
        created_at: util::now_rfc3339(),
        parent: plan.parent,
        feedback: request.feedback.as_ref().filter(|_| request.kind == JobKind::Feedback).map(|f| f.text.trim().to_string()),
        cost_usd: totals.0,
        form: (kind == ArtifactKind::Pipeline).then(|| if plan.film { "film" } else { "visual" }.to_string()),
        parts: match &plan.base {
            Some(base) => base.parts.clone(),
            None => plan.parts.iter().map(|(part, _)| part.clone()).collect(),
        },
        joins: plan.joins.clone(),
    };
    artifacts::commit_version(ws, &manifest)?;
    Ok(Some(JobEvent::Result { artifact_id, version, passed: outcome.errors == 0, errors: outcome.errors, warnings: outcome.warnings }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::replay::ReplayBackend;

    /// A validator that answers from a list, one report per call, repeating the last.
    struct ScriptedValidator {
        reports: Mutex<Vec<Value>>,
    }

    #[async_trait]
    impl Validator for ScriptedValidator {
        async fn validate(&self, _artifact_id: &str, _version: u32) -> Result<Value> {
            let mut reports = self.reports.lock().unwrap();
            Ok(if reports.len() > 1 { reports.remove(0) } else { reports[0].clone() })
        }
    }

    const PLANT: &str = "CJ.definePlant({ draw({ c, extraSvg, extraHtml }) { return '<svg class=\"art\" viewBox=\"0 0 1920 1080\">' + CJ.grid(c('grid')) + CJ.machine(c('h'), 300, 400, 300, 200) + extraSvg + '</svg>' + CJ.plate('Submit()', 300, 358) + extraHtml; }, nodes: [], ports: [] });";
    const VISUAL: &str = r#"{"schemaVersion":1,"title":"Handler · queueing an order","camera":{"cx":960,"cy":560,"z":1},"nodes":[{"id":"h","label":"Submit()","role":"Queues an order","refs":[{"path":"src/handler.go","line":3}],"select":["h"]}]}"#;
    const MODEL: &str = r#"{"schemaVersion":1,"subject":["src/handler.go"],"companions":[{"path":"src/store.go","why":"receives the batch"}],"unit":{"primary":"order"},"entryPoints":[{"symbol":"Submit","ref":"src/handler.go:3"}],"steps":[{"name":"queue","ref":"src/handler.go:4"},{"name":"beyond","ref":"src/handler.go:99"}]}"#;

    struct Setup {
        _dir: tempfile::TempDir,
        ws: Arc<Workspace>,
        recording: PathBuf,
    }

    /// A workspace with two source files, and a recording whose first turn writes `turn1` and
    /// whose second turn writes `turn2`, both as `(path, content)` relative to the version folder.
    fn setup(turn1: &[(&str, &str)], turn2: &[(&str, &str)]) -> Setup {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("ws");
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/handler.go"), "package orders\n\nfunc Submit() {\n\tqueue()\n}\n").unwrap();
        std::fs::write(root.join("src/store.go"), "package orders\n").unwrap();
        let recording = dir.path().join("recording");
        for (n, files) in [(1, turn1), (2, turn2)] {
            if files.is_empty() { continue; }
            let turn = recording.join(format!("turn-{n}"));
            std::fs::create_dir_all(turn.join("files")).unwrap();
            let lines = [
                r#"{"type":"system","subtype":"init","session_id":"sess-1","model":"test-model"}"#.to_string(),
                r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"src/handler.go"}}]}}"#.to_string(),
                format!(r#"{{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.1{n},"usage":{{"input_tokens":100,"output_tokens":50}}}}"#),
            ];
            std::fs::write(turn.join("stdout.jsonl"), lines.join("\n")).unwrap();
            for (path, content) in files {
                let file = turn.join("files").join(path);
                std::fs::create_dir_all(file.parent().unwrap()).unwrap();
                std::fs::write(file, content).unwrap();
            }
        }
        let ws = Arc::new(Workspace::open(&root).unwrap());
        Setup { _dir: dir, ws, recording }
    }

    async fn run_job(setup: &Setup, reports: Vec<Value>, max_fix: u32) -> Vec<JobEvent> {
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&events);
        let ctx = JobContext {
            workspace: Arc::clone(&setup.ws),
            backend: Arc::new(ReplayBackend::new(&setup.recording, Duration::ZERO)),
            validator: Arc::new(ScriptedValidator { reports: Mutex::new(reports) }),
            cancel: CancellationToken::new(),
            emit: Arc::new(move |e| sink.lock().unwrap().push(e)),
            model: None,
            effort: None,
            max_budget_usd: None,
            max_fix_iterations: max_fix,
        };
        let request = JobRequest { kind: JobKind::Visualise, subject: vec!["src/handler.go".into()], instructions: "Show the queue".into(), ..JobRequest::default() };
        run(ctx, request, new_job_id()).await;
        let out = events.lock().unwrap().clone();
        out
    }

    fn ok_report() -> Value {
        json!({ "ok": true, "issues": [{ "check": "packet-size", "severity": "warning" }], "stats": { "samples": 3 } })
    }

    fn failing_report() -> Value {
        json!({ "ok": false, "issues": [{ "check": "text-overlap", "severity": "error", "scene": "v", "a": { "selector": ".v-x", "text": "one", "box": [1, 2, 3, 4] },
            "b": { "selector": ".v-y", "text": "two", "box": [2, 2, 3, 4] }, "hint": "Move one label.", "count": 7 }] })
    }

    const GOOD: &[(&str, &str)] = &[("src/plant.js", PLANT), ("src/visual.json", VISUAL), ("model.json", MODEL), ("progress.json", r#"{"phase":"done"}"#)];

    #[tokio::test]
    async fn a_good_first_turn_is_built_checked_and_committed() {
        let s = setup(GOOD, &[]);
        let events = run_job(&s, vec![ok_report()], 3).await;
        let Some(JobEvent::Result { artifact_id, version, passed, errors, warnings }) = events.last().cloned() else { panic!("{events:?}") };
        // One warning from the self-test and one from the reference to a line that does not exist.
        assert_eq!((version, passed, errors, warnings), (1, true, 0, 2));
        assert!(matches!(events.first(), Some(JobEvent::Started { version: 1, .. })));
        assert!(events.iter().any(|e| matches!(e, JobEvent::Guard { violations } if violations.is_empty())));
        assert!(events.iter().any(|e| matches!(e, JobEvent::Log { level: LogLevel::Tool, text } if text == "Read src/handler.go")));

        let listed = artifacts::list(&s.ws);
        assert_eq!(listed.len(), 1);
        assert_eq!((listed[0].title.as_str(), listed[0].stale), ("Handler · queueing an order", false));
        // The agent's recorded companion is a source too, so changing it makes the visual stale.
        assert_eq!(listed[0].sources, vec!["src/handler.go", "src/store.go"]);
        let detail = artifacts::detail(&s.ws, &artifact_id, None).unwrap();
        assert_eq!(detail.manifest.instructions, "Show the queue");
        assert_eq!(detail.manifest.agent.session_id.as_deref(), Some("sess-1"));
        assert_eq!(detail.manifest.cost_usd, Some(0.11));
        assert!(artifacts::read_page(&s.ws, &artifact_id, 1).unwrap().contains("CJ.boot({\"visual\":"));
        assert!(detail.validation.unwrap()["build"].as_array().unwrap().iter().any(|p| p["check"] == "refs"));

        // The prompt the agent got names its folders and carries the user's instructions.
        let jobs = std::fs::read_dir(s.ws.dot_dir().join("jobs")).unwrap().next().unwrap().unwrap().path();
        let user = std::fs::read_to_string(jobs.join("user-1.md")).unwrap();
        assert!(user.contains("Show the queue") && user.contains(".codjiva/artifacts/"));
        assert!(jobs.join("reference/film/plant.js").exists() && jobs.join("schemas/visual.schema.json").exists());
    }

    /// One streamed reply in the Chat Completions format that makes the given tool calls.
    fn tool_calls_reply(calls: &[(&str, Value)]) -> crate::agents::api::testing::Canned {
        let fragments: Vec<Value> = calls.iter().enumerate().map(|(index, (name, input))| {
            json!({ "index": index, "id": format!("call_{index}"), "type": "function", "function": { "name": name, "arguments": input.to_string() } })
        }).collect();
        crate::agents::api::testing::Canned::sse_with_done(&[
            json!({ "model": "served-model", "choices": [{ "index": 0, "delta": { "tool_calls": fragments }, "finish_reason": "tool_calls" }] }),
            json!({ "choices": [], "usage": { "prompt_tokens": 1000, "completion_tokens": 200 } }),
        ])
    }

    /// A whole job in API-key mode against a local stand-in for the provider: the model reads
    /// the file, writes the artifact through tool calls and finishes; the self-test fails once;
    /// the fix turn continues the same conversation.
    #[tokio::test]
    async fn an_api_provider_runs_a_job_and_its_fix_turn_in_one_conversation() {
        use crate::agents::api::backend::ApiBackend;
        use crate::agents::api::openai::OpenAi;
        use crate::agents::api::testing::MockServer;
        use crate::agents::AgentInfo;

        let s = setup(&[], &[]);
        let id = artifacts::artifact_id(ArtifactKind::Visual, &["src/handler.go".to_string()]);
        let v1 = format!(".codjiva/artifacts/{id}/v1");
        let write = |file: &str, content: &str| ("write_file", json!({ "path": format!("{v1}/{file}"), "content": content }));
        let server = MockServer::start(vec![
            tool_calls_reply(&[("read_file", json!({ "path": "src/handler.go" })), ("write_file", json!({ "path": "src/handler.go", "content": "hijacked" }))]),
            tool_calls_reply(&[write("model.json", MODEL), write("src/plant.js", PLANT), write("src/visual.json", VISUAL)]),
            tool_calls_reply(&[("finish", json!({ "summary": "Drew the handler." }))]),
            tool_calls_reply(&[write("src/visual.json", VISUAL), ("finish", json!({ "summary": "Moved the label." }))]),
        ]).await;
        let info = AgentInfo { id: "api-compatible".into(), name: "Test endpoint".into(), kind: "api".into(), path: None, version: Some("asked-model".into()), ok: true, note: String::new(), supports_resume: true, verified: true, default_model: None, limits: String::new() };
        let provider = Arc::new(OpenAi::new("the endpoint", "sk-secret-value-123".into(), "asked-model".into(), Some(server.url.clone())).unwrap());

        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&events);
        let ctx = JobContext {
            workspace: Arc::clone(&s.ws),
            backend: Arc::new(ApiBackend::new(info, provider)),
            validator: Arc::new(ScriptedValidator { reports: Mutex::new(vec![failing_report(), ok_report()]) }),
            cancel: CancellationToken::new(),
            emit: Arc::new(move |e| sink.lock().unwrap().push(e)),
            model: None,
            effort: None,
            max_budget_usd: None,
            max_fix_iterations: 3,
        };
        let request = JobRequest { kind: JobKind::Visualise, subject: vec!["src/handler.go".into()], ..JobRequest::default() };
        run(ctx, request, new_job_id()).await;
        let events = events.lock().unwrap().clone();

        assert!(matches!(events.last(), Some(JobEvent::Result { passed: true, version: 1, .. })), "{:?}", events.last());
        assert!(events.iter().any(|e| matches!(e, JobEvent::Guard { violations } if violations.is_empty())), "the refused write left the source alone");
        assert_eq!(std::fs::read_to_string(s.ws.root().join("src/handler.go")).unwrap(), "package orders\n\nfunc Submit() {\n\tqueue()\n}\n");
        assert!(events.iter().any(|e| matches!(e, JobEvent::Log { level: LogLevel::Tool, text } if text == "Read src/handler.go")));
        let manifest = artifacts::detail(&s.ws, &id, None).unwrap().manifest;
        assert_eq!((manifest.agent.kind.as_str(), manifest.agent.model.as_deref(), manifest.validation.iterations), ("api-compatible", Some("served-model"), 1));

        let requests = server.recorded();
        assert_eq!(requests.len(), 4);
        // The model was told that its write outside the artifact folder was refused.
        let refused = requests[1].body["messages"].as_array().unwrap().iter().filter(|m| m["role"] == "tool").nth(1).unwrap()["content"].as_str().unwrap().to_string();
        assert!(refused.starts_with("ERROR: ") && refused.contains("You may only write inside"), "{refused}");
        // The fix turn is the same conversation: the first turn's messages, the result owed for
        // the earlier `finish` call, and then the report.
        let fix = requests[3].body["messages"].as_array().unwrap();
        assert_eq!(fix[0]["role"], "system");
        assert!(fix[1]["content"].as_str().unwrap().contains("src/handler.go"));
        let last = fix.last().unwrap();
        assert!(last["role"] == "user" && last["content"].as_str().unwrap().contains("Move one label."), "{last}");
        assert_eq!(fix[fix.len() - 2]["role"], "tool");

        // The key went to the provider and nowhere else: not into any file of the workspace and
        // not into anything the job reported.
        assert_eq!(requests[0].header("authorization"), Some("Bearer sk-secret-value-123"));
        for entry in ignore::WalkBuilder::new(s.ws.root()).hidden(false).git_ignore(false).build().flatten() {
            if entry.file_type().is_some_and(|t| t.is_file()) {
                let bytes = std::fs::read(entry.path()).unwrap();
                assert!(!String::from_utf8_lossy(&bytes).contains("sk-secret-value-123"), "{} holds the key", entry.path().display());
            }
        }
        assert!(!format!("{events:?}").contains("sk-secret-value-123"));
    }

    #[tokio::test]
    async fn a_failed_self_test_is_sent_back_with_its_report_and_the_fix_is_accepted() {
        let s = setup(GOOD, GOOD);
        let events = run_job(&s, vec![failing_report(), ok_report()], 3).await;
        assert!(matches!(events.last(), Some(JobEvent::Result { passed: true, version: 1, .. })), "{:?}", events.last());
        let iterations: Vec<u32> = events.iter().filter_map(|e| if let JobEvent::Validation { iteration, .. } = e { Some(*iteration) } else { None }).collect();
        assert_eq!(iterations, vec![0, 1]);
        assert!(events.iter().any(|e| matches!(e, JobEvent::Phase { phase, .. } if phase == "fixing")));
        let jobs = std::fs::read_dir(s.ws.dot_dir().join("jobs")).unwrap().next().unwrap().unwrap().path();
        let fix = std::fs::read_to_string(jobs.join("user-2.md")).unwrap();
        assert!(fix.contains("round 1 of 3") && fix.contains("\"selector\":\".v-x\"") && fix.contains("Move one label."), "{fix}");
        assert!(!fix.contains("\"count\""), "counters are not part of what the agent needs");
        let manifest = artifacts::detail(&s.ws, &artifacts::list(&s.ws)[0].id, None).unwrap().manifest;
        assert_eq!(manifest.validation.iterations, 1);
        // Both turns' costs are added up.
        assert_eq!(manifest.cost_usd, Some(0.11 + 0.12));
    }

    #[tokio::test]
    async fn a_version_that_still_fails_after_the_last_round_is_kept_with_its_issues() {
        let s = setup(GOOD, GOOD);
        let events = run_job(&s, vec![failing_report()], 1).await;
        assert!(matches!(events.last(), Some(JobEvent::Result { passed: false, errors: 1, .. })), "{:?}", events.last());
        let listed = artifacts::list(&s.ws);
        assert_eq!((listed[0].versions[0].passed, listed[0].versions[0].errors), (false, 1));
    }

    #[tokio::test]
    async fn a_build_error_goes_to_a_fix_round_and_an_unbuildable_result_fails_cleanly() {
        let bad_plant: &[(&str, &str)] = &[("src/plant.js", "CJ.definePlant({});\nfetch('/x');"), ("src/visual.json", VISUAL), ("model.json", MODEL)];
        let s = setup(bad_plant, GOOD);
        let events = run_job(&s, vec![ok_report()], 3).await;
        assert!(matches!(events.last(), Some(JobEvent::Result { passed: true, .. })), "{:?}", events.last());
        let jobs = std::fs::read_dir(s.ws.dot_dir().join("jobs")).unwrap().next().unwrap().unwrap().path();
        let fix = std::fs::read_to_string(jobs.join("user-2.md")).unwrap();
        assert!(fix.contains("[build · forbidden-token] plant.js:2"), "{fix}");

        let s = setup(bad_plant, &[]);
        let events = run_job(&s, vec![ok_report()], 1).await;
        let Some(JobEvent::Failed { code, message }) = events.last() else { panic!("{events:?}") };
        assert_eq!(code, "build_failed");
        assert!(message.contains("fetch"), "{message}");
        assert!(artifacts::list(&s.ws).is_empty());
        assert_eq!(artifacts::next_version(&s.ws, &artifacts::artifact_id(ArtifactKind::Visual, &["src/handler.go".into()])).unwrap(), 1, "the failed version folder was removed");
    }

    #[tokio::test]
    async fn a_missing_analysis_is_an_error_the_agent_must_fix() {
        let without_model: &[(&str, &str)] = &[("src/plant.js", PLANT), ("src/visual.json", VISUAL)];
        let s = setup(without_model, GOOD);
        let events = run_job(&s, vec![ok_report()], 3).await;
        assert!(matches!(events.last(), Some(JobEvent::Result { passed: true, .. })));
        let first = events.iter().find_map(|e| if let JobEvent::Validation { report, iteration: 0 } = e { Some(report.clone()) } else { None }).unwrap();
        assert_eq!(first["ok"], false);
        assert!(first["build"].as_array().unwrap().iter().any(|p| p["file"] == "model.json" && p["check"] == "missing-file"));
    }

    /// A recording of one turn that writes the given files, and nothing else.
    fn recording(dir: &Path, name: &str, files: &[(&str, &str)]) -> PathBuf {
        let turn = dir.join(name).join("turn-1");
        std::fs::create_dir_all(turn.join("files")).unwrap();
        std::fs::write(turn.join("stdout.jsonl"), r#"{"type":"system","subtype":"init","session_id":"sess-9","model":"test-model"}"#).unwrap();
        for (path, content) in files {
            let file = turn.join("files").join(path);
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(file, content).unwrap();
        }
        dir.join(name)
    }

    async fn run_with(ws: &Arc<Workspace>, backend: Arc<dyn Backend>, reports: Vec<Value>, request: JobRequest) -> Vec<JobEvent> {
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&events);
        let ctx = JobContext {
            workspace: Arc::clone(ws),
            backend,
            validator: Arc::new(ScriptedValidator { reports: Mutex::new(reports) }),
            cancel: CancellationToken::new(),
            emit: Arc::new(move |e| sink.lock().unwrap().push(e)),
            model: None,
            effort: None,
            max_budget_usd: None,
            max_fix_iterations: 3,
        };
        run(ctx, request, new_job_id()).await;
        let out = events.lock().unwrap().clone();
        out
    }

    const OUTLINE: &str = r#"{"schemaVersion":1,"title":"How an event moves","chapters":[{"id":"overview","title":"The assembly line","summary":"One event runs the main path.","beats":[{"what":"an event enters"}]},{"id":"flush","title":"7 · Flush","summary":"The batch is written.","beats":[{"what":"the crate leaves"}]}]}"#;

    #[tokio::test]
    async fn an_animate_job_makes_a_film_with_its_outline_and_chapters() {
        let s = setup(GOOD, &[]);
        // A visual of the same file exists first, so the film job is told to start from it.
        let events = run_job(&s, vec![ok_report()], 3).await;
        assert!(matches!(events.last(), Some(JobEvent::Result { passed: true, .. })));

        let film = reference::film_sources();
        let mut files: Vec<(String, String)> = vec![("model.json".into(), MODEL.into()), ("outline.json".into(), OUTLINE.into()),
            ("progress.json".into(), r#"{"phase":"chapter","chapter":2,"of":7}"#.into()),
            ("src/plant.js".into(), film.plant_js.clone().unwrap()), ("src/film.json".into(), film.film_json.clone().unwrap())];
        files.extend(film.scenes.iter().map(|(id, code)| (format!("src/scenes/{id}.js"), code.clone())));
        let borrowed: Vec<(&str, &str)> = files.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect();
        let recorded = recording(s._dir.path(), "film", &borrowed);
        let report = json!({ "ok": true, "issues": [], "stats": {}, "duration": 270.0, "chapters": [{ "id": "overview", "title": "The assembly line", "start": 0, "dur": 20.5 }] });
        let request = JobRequest { kind: JobKind::Animate, subject: vec!["src/handler.go".into()], companions: vec!["src/store.go".into()], instructions: "Follow one order".into(),
            length_seconds: Some(60), ..JobRequest::default() };
        let events = run_with(&s.ws, Arc::new(ReplayBackend::new(&recorded, Duration::from_millis(250))), vec![report], request).await;

        let Some(JobEvent::Result { artifact_id, version: 1, passed: true, .. }) = events.last().cloned() else { panic!("{:?}", events.last()) };
        assert!(artifact_id.starts_with("film-src_handler_go-"), "{artifact_id}");
        let outline = events.iter().find_map(|e| if let JobEvent::Outline { outline } = e { Some(outline.clone()) } else { None }).expect("the outline was reported while the agent worked");
        assert_eq!(outline["chapters"][1]["title"], "7 · Flush");
        assert!(events.iter().any(|e| matches!(e, JobEvent::Phase { phase, chapter: Some(2), of: Some(7), .. } if phase == "chapter")));

        let detail = artifacts::detail(&s.ws, &artifact_id, None).unwrap();
        assert_eq!((detail.manifest.kind, detail.manifest.duration_sec, detail.manifest.chapters.len()), (ArtifactKind::Film, Some(270.0), 1));
        assert!(artifacts::read_page(&s.ws, &artifact_id, 1).unwrap().contains("CJ.boot({\"film\":"));
        // The file now has two artifacts: the visual and the film.
        assert_eq!(artifacts::list(&s.ws).len(), 2);

        let jobs_dir = s.ws.dot_dir().join("jobs");
        let prompt = std::fs::read_dir(&jobs_dir).unwrap().flatten().map(|e| std::fs::read_to_string(e.path().join("user-1.md")).unwrap()).find(|text| text.starts_with("Animate")).unwrap();
        assert!(prompt.contains("about 60 seconds") && prompt.contains("Companions (read these too): src/store.go") && prompt.contains("Follow one order"), "{prompt}");
        assert!(prompt.contains("A still visual of this subject exists at .codjiva/artifacts/visual-src_handler_go-"), "{prompt}");
    }

    #[tokio::test]
    async fn an_approved_outline_is_saved_first_and_given_to_the_agent() {
        let s = setup(GOOD, &[]);
        let outline: Value = serde_json::from_str(OUTLINE).unwrap();
        // The recorded turn writes a visual, not a film, so the build fails. This test is only
        // about what the job prepared before the agent started.
        let request = JobRequest { kind: JobKind::Animate, subject: vec!["src/handler.go".into()], outline: Some(outline), ..JobRequest::default() };
        let events = run_with(&s.ws, Arc::new(ReplayBackend::new(&s.recording, Duration::ZERO)), vec![], request).await;
        assert!(matches!(events.iter().find(|e| matches!(e, JobEvent::Outline { .. })), Some(JobEvent::Outline { outline }) if outline["title"] == "How an event moves"));
        let job = std::fs::read_dir(s.ws.dot_dir().join("jobs")).unwrap().next().unwrap().unwrap().path();
        let prompt = std::fs::read_to_string(job.join("user-1.md")).unwrap();
        assert!(prompt.contains("The user has approved this outline") && prompt.contains("\"title\": \"7 · Flush\""), "{prompt}");
        assert!(std::fs::read_to_string(job.join("system.md")).unwrap().contains("# Job: Animate"));
    }

    #[tokio::test]
    async fn a_feedback_job_changes_a_copy_and_keeps_the_version_it_started_from() {
        let s = setup(GOOD, &[]);
        let events = run_job(&s, vec![ok_report()], 3).await;
        let Some(JobEvent::Result { artifact_id, .. }) = events.last().cloned() else { panic!("{events:?}") };
        let v1_sources = artifacts::read_manifest(&s.ws, &artifact_id, 1).unwrap().sources;
        // The code changes after the first version, so that version is now stale.
        std::fs::write(s.ws.root().join("src/handler.go"), "package orders\n\nfunc Submit() {\n\tqueue()\n\tlog()\n}\n").unwrap();

        // The feedback turn rewrites only visual.json. plant.js and model.json come from the copy.
        let changed = VISUAL.replace("Queues an order", "Queues one order");
        let recorded = recording(s._dir.path(), "feedback", &[("src/visual.json", &changed)]);
        let feedback = Feedback { text: " The role should say one order ".into(), selected: Some("h".into()),
            point_at: Some(json!({ "selector": ".v-h", "text": "Submit()", "box": [300, 400, 300, 200] })), ..Feedback::default() };
        let request = JobRequest { kind: JobKind::Feedback, artifact_id: Some(artifact_id.clone()), base_version: Some(1), feedback: Some(feedback), ..JobRequest::default() };
        let events = run_with(&s.ws, Arc::new(ReplayBackend::new(&recorded, Duration::ZERO)), vec![ok_report()], request).await;

        assert!(matches!(events.last(), Some(JobEvent::Result { version: 2, passed: true, .. })), "{:?}", events.last());
        assert!(events.iter().any(|e| matches!(e, JobEvent::Phase { phase, .. } if phase == "revising")));
        let v2 = artifacts::detail(&s.ws, &artifact_id, None).unwrap();
        assert_eq!((v2.manifest.version, v2.manifest.parent, v2.manifest.feedback.as_deref()), (2, Some(1), Some("The role should say one order")));
        assert_eq!(v2.manifest.instructions, "Show the queue", "the instructions of the first version are kept");
        assert_eq!(v2.definition.unwrap()["nodes"][0]["role"], "Queues one order");
        assert!(artifacts::version_dir(&s.ws, &artifact_id, 2).unwrap().join("src/plant.js").is_file());
        // The first version is untouched, and the new one is as stale as the one it came from.
        assert_eq!(artifacts::detail(&s.ws, &artifact_id, Some(1)).unwrap().definition.unwrap()["nodes"][0]["role"], "Queues an order");
        assert_eq!(v2.manifest.sources, v1_sources);
        assert!(artifacts::list(&s.ws)[0].stale);

        let jobs_dir = s.ws.dot_dir().join("jobs");
        let job = std::fs::read_dir(&jobs_dir).unwrap().flatten().map(|e| e.path()).find(|p| std::fs::read_to_string(p.join("system.md")).unwrap().contains("# Job: Fix")).unwrap();
        let prompt = std::fs::read_to_string(job.join("user-1.md")).unwrap();
        assert!(prompt.contains("The role should say one order") && prompt.contains("\"selector\":\".v-h\"") && prompt.contains("selected in the visual was: h"), "{prompt}");

        let empty = JobRequest { kind: JobKind::Feedback, artifact_id: Some(artifact_id), base_version: Some(1), feedback: Some(Feedback::default()), ..JobRequest::default() };
        let events = run_with(&s.ws, Arc::new(ReplayBackend::new(&recorded, Duration::ZERO)), vec![], empty).await;
        assert!(matches!(events.last(), Some(JobEvent::Failed { code, .. }) if code == "bad_request"));
    }

    #[tokio::test]
    async fn a_folder_can_be_visualised_as_a_whole_and_any_of_its_files_makes_it_stale() {
        let s = setup(GOOD, &[]);
        let request = JobRequest { kind: JobKind::Visualise, subject: vec!["src/".into()], ..JobRequest::default() };
        let events = run_with(&s.ws, Arc::new(ReplayBackend::new(&s.recording, Duration::ZERO)), vec![ok_report()], request).await;
        let Some(JobEvent::Result { artifact_id, passed: true, .. }) = events.last().cloned() else { panic!("{:?}", events.last()) };
        assert!(artifact_id.starts_with("visual-src-"), "{artifact_id}");
        let manifest = artifacts::read_manifest(&s.ws, &artifact_id, 1).unwrap();
        assert_eq!(manifest.subject, vec!["src/"]);
        assert_eq!(manifest.sources.keys().collect::<Vec<_>>(), vec!["src/handler.go", "src/store.go"]);
        let job = std::fs::read_dir(s.ws.dot_dir().join("jobs")).unwrap().next().unwrap().unwrap().path();
        let prompt = std::fs::read_to_string(job.join("user-1.md")).unwrap();
        assert!(prompt.contains("The subject is a whole folder. Its code files are:\nsrc/handler.go\nsrc/store.go"), "{prompt}");
        std::fs::write(s.ws.root().join("src/store.go"), "package orders\n// changed\n").unwrap();
        assert_eq!(artifacts::list(&s.ws)[0].stale_sources, vec!["src/store.go"]);

        // A film of a folder, a folder that does not exist and a folder without code are refused.
        for (request, code) in [
            (JobRequest { kind: JobKind::Animate, subject: vec!["src/".into()], ..JobRequest::default() }, "bad_request"),
            (JobRequest { kind: JobKind::Visualise, subject: vec!["nowhere/".into()], ..JobRequest::default() }, "not_found"),
            (JobRequest { kind: JobKind::Visualise, subject: vec![".codjiva/jobs/".into()], ..JobRequest::default() }, "empty_folder"),
        ] {
            let events = run_with(&s.ws, Arc::new(ReplayBackend::new(&s.recording, Duration::ZERO)), vec![], request).await;
            assert!(matches!(events.last(), Some(JobEvent::Failed { code: found, .. }) if found == code), "{code}: {:?}", events.last());
        }
    }

    /// Plays back the two sessions recorded from a real agent on the Go fixture workspace, a
    /// visual and a film, and checks that what the agent wrote still builds. This catches a
    /// change to the builder or the schemas that would reject artifacts users already have.
    #[tokio::test]
    async fn sessions_recorded_from_a_real_agent_still_build() {
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("go-orders");
        copy_tree(&repo.join("fixtures/go-orders"), &root).unwrap();
        let ws = Arc::new(Workspace::open(&root).unwrap());
        let subject = vec!["internal/orders/handler.go".to_string()];
        for (kind, recording, opening) in [(JobKind::Visualise, "go-orders-visual", "CJ.boot({\"visual\":"), (JobKind::Animate, "go-orders-film", "CJ.boot({\"film\":")] {
            let backend = Arc::new(ReplayBackend::new(&repo.join("fixtures/replay").join(recording), Duration::ZERO));
            let request = JobRequest { kind, subject: subject.clone(), ..JobRequest::default() };
            let events = run_with(&ws, backend, vec![ok_report()], request).await;
            let Some(JobEvent::Result { artifact_id, passed: true, errors: 0, .. }) = events.last().cloned() else { panic!("{recording}: {:?}", events.last()) };
            let first = events.iter().find_map(|e| if let JobEvent::Validation { report, iteration: 0 } = e { Some(report.clone()) } else { None }).unwrap();
            assert_eq!(first["build"].as_array().unwrap().iter().filter(|p| p["severity"] == "error").count(), 0, "{recording}: {}", first["build"]);
            assert!(artifacts::read_page(&ws, &artifact_id, 1).unwrap().contains(opening));
            assert!(events.iter().any(|e| matches!(e, JobEvent::Log { level: LogLevel::Tool, text } if text == "Read internal/orders/handler.go")), "{recording}");
        }
    }

    /// The sources a compose turn writes for a pipeline of the two parts `handler` and `store`:
    /// a yard that draws both bays and one join pipe, and a visual with a node for each.
    const YARD: &str = "CJ.definePlant({ draw({ c, extraSvg, extraHtml }) { const a = CJ.bay('handler'), b = CJ.bay('store'); const f = a.point([1800, 500]), t = b.point([60, 500]); return '<svg class=\"art\" viewBox=\"0 0 1920 1080\">' + CJ.grid(c('grid')) + CJ.pipe(c('join1'), 'M' + f[0] + ' ' + f[1] + ' H' + t[0], 'hot') + extraSvg + '</svg>' + a.draw(c) + b.draw(c) + CJ.plate('write · Store.WriteBatch()', 800, 300) + extraHtml; }, nodes: [], ports: [] });";
    const YARD_VISUAL: &str = r#"{"schemaVersion":1,"title":"Order to disk","camera":{"cx":960,"cy":560,"z":1},"nodes":[{"id":"handler","label":"Handler","role":"Queues orders","select":["bay-handler"]},{"id":"store","label":"Store","role":"Writes batches","select":["bay-store"]},{"id":"join","label":"Store.WriteBatch","role":"Where a batch leaves the handler","refs":[{"path":"src/handler.go","line":4}],"select":["join1"]}]}"#;

    /// Makes a visual of `file` with the given ports, by playing back a turn that writes it.
    async fn visual_with_ports(s: &Setup, file: &str, name: &str, ports: &str) -> String {
        let model = MODEL.replace(r#""subject":["src/handler.go"]"#, &format!(r#""subject":["{file}"],"ports":{ports}"#));
        let recorded = recording(s._dir.path(), name, &[("src/plant.js", PLANT), ("src/visual.json", VISUAL), ("model.json", &model)]);
        let request = JobRequest { kind: JobKind::Visualise, subject: vec![file.into()], ..JobRequest::default() };
        let events = run_with(&s.ws, Arc::new(ReplayBackend::new(&recorded, Duration::ZERO)), vec![ok_report()], request).await;
        let Some(JobEvent::Result { artifact_id, passed: true, .. }) = events.last().cloned() else { panic!("{:?}", events.last()) };
        artifact_id
    }

    #[tokio::test]
    async fn a_compose_job_joins_two_artifacts_into_a_pipeline() {
        let s = setup(&[], &[]);
        let handler = visual_with_ports(&s, "src/handler.go", "handler", r#"[{"id":"out:Store.WriteBatch","dir":"out","symbol":"Store.WriteBatch","ref":"src/handler.go:4","kind":"write","carries":"a batch","anchor":[1800,500]}]"#).await;
        let store = visual_with_ports(&s, "src/store.go", "store", r#"[{"id":"in:Store.WriteBatch","dir":"in","symbol":"WriteBatch(orders []Order)","ref":"src/store.go:1","anchor":[60,500]}]"#).await;

        let ports = compose::artifact_ports(&s.ws, &[handler.clone(), store.clone()]).unwrap();
        let joins = compose::propose_joins(&s.ws, &ports);
        assert_eq!(joins.len(), 1, "{joins:?}");
        assert_eq!((joins[0].from_artifact.as_str(), joins[0].to_port.as_str(), joins[0].strength), (handler.as_str(), "in:Store.WriteBatch", Some(compose::Strength::Name)));

        // The turn writes the yard and its visual. It also edits one part's copy, which is put back.
        let recorded = recording(s._dir.path(), "yard", &[("src/plant.js", YARD), ("src/visual.json", YARD_VISUAL), ("model.json", MODEL), ("src/parts/store/plant.js", "CJ.definePlant({});")]);
        let request = JobRequest { kind: JobKind::Compose, parts: vec![handler.clone(), store.clone()], joins: joins.clone(), instructions: "Follow one batch".into(), ..JobRequest::default() };
        let events = run_with(&s.ws, Arc::new(ReplayBackend::new(&recorded, Duration::ZERO)), vec![ok_report()], request).await;
        let Some(JobEvent::Result { artifact_id, version: 1, passed: true, .. }) = events.last().cloned() else { panic!("{:?}", events) };
        assert!(artifact_id.starts_with("pipeline-src_handler_go-"), "{artifact_id}");
        assert!(events.iter().any(|e| matches!(e, JobEvent::Log { level: LogLevel::Warn, text } if text.contains("copy of store"))));

        let detail = artifacts::detail(&s.ws, &artifact_id, None).unwrap();
        let m = &detail.manifest;
        assert_eq!((m.kind, m.form.as_deref(), m.subject.clone()), (ArtifactKind::Pipeline, Some("visual"), vec!["src/handler.go".to_string(), "src/store.go".to_string()]));
        assert_eq!(m.parts.iter().map(|p| (p.key.as_str(), p.artifact.as_str())).collect::<Vec<_>>(), vec![("handler", handler.as_str()), ("store", store.as_str())]);
        assert_eq!(m.joins, joins);
        let page = artifacts::read_page(&s.ws, &artifact_id, 1).unwrap();
        assert!(page.contains("CJ.__part(\"handler\"") && page.contains("CJ.__part(\"store\"") && page.contains("\"pipeline\":{"));
        // The part's copy is the part's own plant again, not what the agent wrote over it.
        assert!(page.contains("CJ.plate('Submit()', 300, 358)") && !page.contains("CJ.definePlant({});"));

        let job = std::fs::read_dir(s.ws.dot_dir().join("jobs")).unwrap().flatten().map(|e| e.path()).find(|p| std::fs::read_to_string(p.join("system.md")).unwrap().contains("# Job: Compose")).unwrap();
        let prompt = std::fs::read_to_string(job.join("user-1.md")).unwrap();
        assert!(prompt.contains("one pipeline visual") && prompt.contains("- `handler`: Handler · queueing an order (src/handler.go)"), "{prompt}");
        assert!(prompt.contains("Port `out:Store.WriteBatch`: `Store.WriteBatch` at src/handler.go:4, anchor [1800, 500]. Carries: a batch."), "{prompt}");
        assert!(prompt.contains("- `handler#out:Store.WriteBatch` → `store#in:Store.WriteBatch`") && prompt.contains("Follow one batch"), "{prompt}");

        // A change to a file of either part makes the pipeline stale.
        std::fs::write(s.ws.root().join("src/store.go"), "package orders\n// changed\n").unwrap();
        let pipeline = artifacts::list(&s.ws).into_iter().find(|a| a.id == artifact_id).unwrap();
        assert!(pipeline.stale && pipeline.stale_sources == vec!["src/store.go"] && pipeline.parts.len() == 2);

        // Requests that cannot make a pipeline are refused before anything is written.
        let refused = |request: JobRequest| { let ws = Arc::clone(&s.ws); let recorded = recorded.clone(); async move {
            run_with(&ws, Arc::new(ReplayBackend::new(&recorded, Duration::ZERO)), vec![], request).await.last().cloned()
        } };
        for request in [
            JobRequest { kind: JobKind::Compose, parts: vec![handler.clone()], joins: joins.clone(), ..JobRequest::default() },
            JobRequest { kind: JobKind::Compose, parts: vec![handler.clone(), store.clone()], ..JobRequest::default() },
            JobRequest { kind: JobKind::Compose, parts: vec![handler.clone(), artifact_id.clone()], joins: joins.clone(), ..JobRequest::default() },
        ] {
            assert!(matches!(refused(request).await, Some(JobEvent::Failed { code, .. }) if code == "bad_request"));
        }
    }

    /// An agent that fails whenever it is asked to continue an earlier conversation, and that
    /// changes a file of an older version when `vandal` is set.
    struct ForgetfulBackend {
        vandal: bool,
        resumed: Mutex<Vec<Option<String>>>,
    }

    #[async_trait]
    impl Backend for ForgetfulBackend {
        fn info(&self) -> crate::agents::AgentInfo {
            crate::agents::AgentInfo { id: "replay".into(), name: "Forgetful".into(), kind: "replay".into(), path: None, version: None, ok: true, note: String::new(), supports_resume: true, verified: true, default_model: None, limits: String::new() }
        }

        async fn run(&self, turn: &Turn, _cancel: &CancellationToken, _on_event: &(dyn Fn(AgentEvent) + Send + Sync)) -> Result<crate::agents::TurnOutcome> {
            self.resumed.lock().unwrap().push(turn.resume_session.clone());
            if turn.resume_session.is_some() {
                return Ok(crate::agents::TurnOutcome { error: Some("No conversation found with that id.".into()), ..Default::default() });
            }
            if self.vandal {
                let older = turn.artifact_dir.parent().unwrap().join("v1/src/visual.json");
                std::fs::write(older, "{}").unwrap();
            }
            Ok(crate::agents::TurnOutcome { session_id: Some("fresh".into()), ..Default::default() })
        }
    }

    #[tokio::test]
    async fn feedback_continues_the_earlier_conversation_and_starts_a_new_one_when_that_fails() {
        let s = setup(GOOD, &[]);
        let events = run_job(&s, vec![ok_report()], 3).await;
        let Some(JobEvent::Result { artifact_id, .. }) = events.last().cloned() else { panic!("{events:?}") };
        let request = || JobRequest { kind: JobKind::Feedback, artifact_id: Some(artifact_id.clone()), base_version: Some(1),
            feedback: Some(Feedback { text: "Shorter labels".into(), ..Feedback::default() }), ..JobRequest::default() };

        let backend = Arc::new(ForgetfulBackend { vandal: false, resumed: Mutex::new(Vec::new()) });
        let events = run_with(&s.ws, backend.clone(), vec![ok_report()], request()).await;
        assert!(matches!(events.last(), Some(JobEvent::Result { version: 2, passed: true, .. })), "{:?}", events.last());
        // The first try names the session recorded in version 1; the second is a new conversation.
        assert_eq!(*backend.resumed.lock().unwrap(), vec![Some("sess-1".to_string()), None]);
        assert!(events.iter().any(|e| matches!(e, JobEvent::Log { level: LogLevel::Warn, text } if text.contains("could not be continued"))));
        assert_eq!(artifacts::read_manifest(&s.ws, &artifact_id, 2).unwrap().agent.session_id.as_deref(), Some("fresh"));

        // An agent that changes an older version fails the job, and no version is added.
        let vandal = Arc::new(ForgetfulBackend { vandal: true, resumed: Mutex::new(Vec::new()) });
        let events = run_with(&s.ws, vandal, vec![ok_report()], request()).await;
        let Some(JobEvent::Failed { code, message }) = events.last() else { panic!("{events:?}") };
        assert_eq!(code, "write_guard");
        assert!(message.contains("/v1/src/visual.json"), "{message}");
        assert_eq!(artifacts::next_version(&s.ws, &artifact_id).unwrap(), 3);
    }

    /// An agent that produces a valid result but also rewrites one of the user's source files.
    struct MisbehavingBackend;

    #[async_trait]
    impl Backend for MisbehavingBackend {
        fn info(&self) -> crate::agents::AgentInfo {
            crate::agents::AgentInfo { id: "bad".into(), name: "Bad Agent".into(), kind: "replay".into(), path: None, version: None, ok: true, note: String::new(), supports_resume: false, verified: true, default_model: None, limits: String::new() }
        }

        async fn run(&self, turn: &Turn, _cancel: &CancellationToken, _on_event: &(dyn Fn(AgentEvent) + Send + Sync)) -> Result<crate::agents::TurnOutcome> {
            for (path, content) in GOOD {
                let file = turn.artifact_dir.join(path);
                std::fs::create_dir_all(file.parent().unwrap()).unwrap();
                std::fs::write(file, content).unwrap();
            }
            std::fs::write(turn.workspace_root.join("src/handler.go"), "package orders\n// rewritten by the agent\n").unwrap();
            std::fs::write(turn.workspace_root.join("notes.txt"), "left behind").unwrap();
            Ok(crate::agents::TurnOutcome::default())
        }
    }

    #[tokio::test]
    async fn a_write_outside_the_dot_folder_fails_the_job_and_discards_the_result() {
        let s = setup(GOOD, &[]);
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&events);
        let ctx = JobContext {
            workspace: Arc::clone(&s.ws),
            backend: Arc::new(MisbehavingBackend),
            validator: Arc::new(ScriptedValidator { reports: Mutex::new(vec![ok_report()]) }),
            cancel: CancellationToken::new(),
            emit: Arc::new(move |e| sink.lock().unwrap().push(e)),
            model: None,
            effort: None,
            max_budget_usd: None,
            max_fix_iterations: 3,
        };
        let request = JobRequest { kind: JobKind::Visualise, subject: vec!["src/handler.go".into()], ..JobRequest::default() };
        run(ctx, request, new_job_id()).await;
        let events = events.lock().unwrap().clone();

        let touched: Vec<String> = events.iter().find_map(|e| if let JobEvent::Guard { violations } = e { Some(violations.iter().map(|v| v.path.clone()).collect()) } else { None }).unwrap();
        assert_eq!(touched, vec!["notes.txt", "src/handler.go"]);
        let Some(JobEvent::Failed { code, message }) = events.last() else { panic!("{events:?}") };
        assert_eq!(code, "write_guard");
        assert!(message.contains("src/handler.go") && message.contains("notes.txt"), "{message}");
        // The result is not shown or kept, even though it would have built and passed.
        assert!(artifacts::list(&s.ws).is_empty());
        assert!(!events.iter().any(|e| matches!(e, JobEvent::Validation { .. })));
    }

    #[tokio::test]
    async fn cancelling_a_job_ends_it_without_a_version() {
        let s = setup(GOOD, &[]);
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&events);
        let cancel = CancellationToken::new();
        let ctx = JobContext {
            workspace: Arc::clone(&s.ws),
            // A pause between recorded lines gives the cancel time to arrive mid-turn.
            backend: Arc::new(ReplayBackend::new(&s.recording, Duration::from_millis(300))),
            validator: Arc::new(ScriptedValidator { reports: Mutex::new(vec![ok_report()]) }),
            cancel: cancel.clone(),
            emit: Arc::new(move |e| sink.lock().unwrap().push(e)),
            model: None,
            effort: None,
            max_budget_usd: None,
            max_fix_iterations: 3,
        };
        let request = JobRequest { kind: JobKind::Visualise, subject: vec!["src/handler.go".into()], ..JobRequest::default() };
        tokio::spawn(async move { tokio::time::sleep(Duration::from_millis(100)).await; cancel.cancel(); });
        run(ctx, request, new_job_id()).await;
        assert!(matches!(events.lock().unwrap().last(), Some(JobEvent::Cancelled)));
        assert!(artifacts::list(&s.ws).is_empty());
    }

    #[tokio::test]
    async fn the_second_job_for_the_same_file_adds_a_version_and_points_at_the_first() {
        let s = setup(GOOD, &[]);
        run_job(&s, vec![ok_report()], 3).await;
        let events = run_job(&s, vec![ok_report()], 3).await;
        assert!(matches!(events.last(), Some(JobEvent::Result { version: 2, .. })));
        let listed = artifacts::list(&s.ws);
        assert_eq!((listed[0].current_version, listed[0].versions.len(), listed[0].versions[1].parent), (2, 2, Some(1)));
        let mut jobs: Vec<PathBuf> = std::fs::read_dir(s.ws.dot_dir().join("jobs")).unwrap().flatten().map(|e| e.path()).collect();
        jobs.sort();
        let second = std::fs::read_to_string(jobs[1].join("user-1.md")).unwrap();
        assert!(second.contains("An earlier version of this visual is at .codjiva/artifacts/") && second.contains("/v1"), "{second}");
    }
}
