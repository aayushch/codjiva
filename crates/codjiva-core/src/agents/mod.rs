//! Agents: the things that read the user's code and write an artifact's
//! sources.
//!
//! A job talks to an agent through the [`Backend`] trait, one *turn* at a time:
//! the first turn produces the artifact, and each later turn fixes what a check
//! or the user found. There are three kinds of backend:
//!
//!   - a command-line agent installed on the machine, started as a process
//!     ([`CliBackend`]);
//!   - a recorded session played back, for tests and for working on the
//!     interface ([`replay`]);
//!   - the app's own loop against a model provider's API (added in a later
//!     milestone).
//!
//! All of them report what they do as the same [`AgentEvent`]s.

pub mod api;
pub mod claude;
pub mod definition;
pub mod parsers;
pub mod process;
pub mod replay;

use crate::env::{run_capture, ShellEnv};
use crate::error::{AppError, Result};
use async_trait::async_trait;
use definition::{AgentDefinition, Placeholders};
use serde::Serialize;
use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

/// A turn is stopped when the agent prints nothing for this long.
const IDLE_LIMIT: Duration = Duration::from_secs(600);

/// Something an agent did or said during a turn.
#[derive(Debug, Clone, PartialEq)]
pub enum AgentEvent {
    /// The agent's session began. The id lets a later turn continue the same
    /// conversation.
    SessionStarted {
        session_id: String,
        model: Option<String>,
    },
    /// Prose from the agent.
    Text(String),
    /// The agent used a tool. `summary` names the file or pattern it worked on.
    ToolUse { name: String, summary: String },
    /// The agent wrote or edited this file. The path is as the agent gave it.
    FileWritten(String),
    /// A tool call was refused by the agent's own permission rules.
    PermissionDenied { tool: String },
    /// What the turn cost, where the agent reports it.
    Usage {
        cost_usd: Option<f64>,
        input_tokens: Option<u64>,
        output_tokens: Option<u64>,
    },
    /// A message from the agent program itself, not from the model.
    Notice(String),
    /// The turn is over. `error` is set when the agent reports that it failed.
    Finished { error: Option<String> },
}

/// Turns one line of an agent program's output into events. A parser is created
/// per turn and may keep state between lines.
pub trait LineParser: Send {
    fn parse_line(&mut self, line: &str) -> Vec<AgentEvent>;
    /// True once the agent has reported the end of its turn.
    fn finished(&self) -> bool;
}

/// Returns the parser a definition names, or an error for a name this version
/// does not know.
pub fn parser_named(name: &str) -> Result<Box<dyn LineParser>> {
    match name {
        "claude-stream-json" => {
            Ok(Box::<claude::ClaudeStreamParser>::default())
        }
        "codex-jsonl" => Ok(Box::<parsers::CodexParser>::default()),
        "gemini-stream-json" => Ok(Box::<parsers::GeminiParser>::default()),
        "cursor-stream-json" => Ok(Box::<parsers::CursorParser>::default()),
        "pi-json" => Ok(Box::<parsers::PiParser>::default()),
        other => Err(AppError::new(
            "unknown_parser",
            format!(
                "This version of the app has no output parser named \
                 \"{other}\"."
            ),
        )),
    }
}

/// Everything a backend needs for one turn.
#[derive(Debug, Clone)]
pub struct Turn {
    pub workspace_root: PathBuf,
    /// The workspace's `.codjiva` folder.
    pub dot_dir: PathBuf,
    /// The version folder the agent writes into.
    pub artifact_dir: PathBuf,
    /// This job's folder under `.codjiva/jobs`, which holds the prompt files.
    pub job_dir: PathBuf,
    pub system_prompt_path: PathBuf,
    pub user_prompt_path: PathBuf,
    pub user_prompt: String,
    /// The session of an earlier turn to continue, for agents that can.
    pub resume_session: Option<String>,
    pub model: Option<String>,
    /// How much effort the model should spend on thinking: `low`, `medium` or
    /// `high`. `None` leaves it to the agent.
    pub effort: Option<String>,
    pub max_budget_usd: Option<f64>,
    /// Where the agent's raw output is appended, for debugging.
    pub log_path: PathBuf,
}

/// How a turn ended.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TurnOutcome {
    pub session_id: Option<String>,
    pub model: Option<String>,
    pub cancelled: bool,
    /// Set when the turn failed. It is a full sentence for the user.
    pub error: Option<String>,
}

/// What is known about one agent, for Settings and the title bar.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    pub id: String,
    pub name: String,
    /// `cli`, `api` or `replay`.
    pub kind: String,
    pub path: Option<String>,
    pub version: Option<String>,
    /// True when the agent can be used.
    pub ok: bool,
    /// What the user should know or do: an install hint, a warning about
    /// changed flags.
    pub note: String,
    pub supports_resume: bool,
    pub verified: bool,
    /// The model jobs use when Settings names none, for agents that have one.
    #[serde(default)]
    pub default_model: Option<String>,
    /// What the user should know about how far this agent can be confined.
    /// Empty when the agent's own permission rules confine it to the version
    /// folder.
    #[serde(default)]
    pub limits: String,
}

#[async_trait]
pub trait Backend: Send + Sync {
    fn info(&self) -> AgentInfo;
    /// Runs one turn. `on_event` is called for everything the agent does, in
    /// order.
    async fn run(
        &self,
        turn: &Turn,
        cancel: &CancellationToken,
        on_event: &(dyn Fn(AgentEvent) + Send + Sync),
    ) -> Result<TurnOutcome>;
}

/// A command-line agent described by an [`AgentDefinition`].
pub struct CliBackend {
    definition: AgentDefinition,
    program: PathBuf,
    env: Arc<ShellEnv>,
    info: AgentInfo,
}

impl CliBackend {
    /// Looks for the definition's program and asks it for its version and help
    /// text. The returned backend reports itself as not usable, with a hint,
    /// when the program is missing.
    pub fn detect(
        definition: AgentDefinition,
        env: Arc<ShellEnv>,
        path_override: Option<&str>,
    ) -> CliBackend {
        let program = path_override
            .filter(|p| !p.is_empty())
            .map(PathBuf::from)
            .filter(|p| p.is_file())
            .or_else(|| env.find_program(&definition.program));
        let mut info = AgentInfo {
            id: definition.id.clone(),
            name: definition.name.clone(),
            kind: "cli".to_string(),
            path: program.as_ref().map(|p| p.to_string_lossy().into_owned()),
            version: None,
            ok: program.is_some(),
            note: String::new(),
            supports_resume: definition.supports_resume,
            verified: definition.verified,
            default_model: definition.default_model.clone(),
            limits: definition.limits.clone(),
        };
        match &program {
            None => {
                info.note = format!(
                    "`{}` was not found. {}",
                    definition.program, definition.install_hint
                )
            }
            Some(path) => {
                let probe = |args: &[String]| -> Option<String> {
                    if args.is_empty() {
                        return None;
                    }
                    let mut command = Command::new(path);
                    command.args(args).env_clear().envs(env.vars());
                    run_capture(&mut command, Duration::from_secs(8)).map(
                        |bytes| String::from_utf8_lossy(&bytes).into_owned(),
                    )
                };
                info.version = probe(&definition.version_args)
                    .and_then(|text| {
                        text.lines().next().map(|l| l.trim().to_string())
                    })
                    .filter(|v| !v.is_empty());
                if let Some(help) = probe(&definition.help_args) {
                    let missing: Vec<&str> = definition
                        .check_flags
                        .iter()
                        .map(String::as_str)
                        .filter(|flag| !help.contains(flag))
                        .collect();
                    if !missing.is_empty() {
                        info.note = format!(
                            "This version of {} no longer lists {} in its \
                             help. Jobs may fail until the adapter definition \
                             is updated.",
                            definition.name,
                            missing.join(", ")
                        );
                    }
                }
                if info.note.is_empty() && !definition.verified {
                    info.note = format!(
                        "The settings for {} have not been confirmed against \
                         the real program yet.",
                        definition.name
                    );
                }
            }
        }
        CliBackend {
            program: program
                .unwrap_or_else(|| PathBuf::from(&definition.program)),
            definition,
            env,
            info,
        }
    }
}

/// Writes text as a path relative to the workspace when it is inside it, for
/// the job log.
fn display_path(path: &str, workspace_root: &Path) -> String {
    Path::new(path)
        .strip_prefix(workspace_root)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| path.to_string())
}

#[async_trait]
impl Backend for CliBackend {
    fn info(&self) -> AgentInfo {
        self.info.clone()
    }

    async fn run(
        &self,
        turn: &Turn,
        cancel: &CancellationToken,
        on_event: &(dyn Fn(AgentEvent) + Send + Sync),
    ) -> Result<TurnOutcome> {
        if !self.info.ok {
            return Err(AppError::new("agent_missing", self.info.note.clone()));
        }
        let text = |p: &Path| p.to_string_lossy().into_owned();
        let mut values = Placeholders::default();
        values
            .set("workspaceRoot", text(&turn.workspace_root))
            .set("dotDirAbs", text(&turn.dot_dir))
            .set("artifactDirAbs", text(&turn.artifact_dir))
            .set("jobDirAbs", text(&turn.job_dir))
            .set("systemPromptPath", text(&turn.system_prompt_path))
            .set("userPromptPath", text(&turn.user_prompt_path))
            .set("userPromptText", turn.user_prompt.clone());
        if let Some(model) = turn
            .model
            .as_ref()
            .or(self.definition.default_model.as_ref())
        {
            values.set("model", model.clone());
        }
        if let Some(effort) = &turn.effort {
            values.set("effort", effort.clone());
        }
        if let Some(session) = &turn.resume_session {
            values.set("sessionId", session.clone());
        }
        if let Some(budget) = turn.max_budget_usd {
            values.set("maxBudgetUsd", budget.to_string());
        }
        let spec = self.definition.spawn_spec(&values);
        let mut parser = parser_named(&self.definition.parser)?;
        let mut log = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&turn.log_path)
            .ok();

        let mut outcome = TurnOutcome::default();
        let mut reported_error: Option<String> = None;
        let base_env: &BTreeMap<String, String> = self.env.vars();
        let process = process::run_lines(
            &self.program,
            &spec,
            base_env,
            IDLE_LIMIT,
            cancel,
            |line| {
                if let Some(file) = log.as_mut() {
                    let _ = writeln!(file, "{line}");
                }
                for event in parser.parse_line(line) {
                    match &event {
                        AgentEvent::SessionStarted { session_id, model } => {
                            outcome.session_id = Some(session_id.clone());
                            outcome.model = model.clone();
                        }
                        AgentEvent::Finished { error } => {
                            reported_error = error.clone()
                        }
                        _ => {}
                    }
                    let event = match event {
                        AgentEvent::ToolUse { name, summary } => {
                            AgentEvent::ToolUse {
                                name,
                                summary: display_path(
                                    &summary,
                                    &turn.workspace_root,
                                ),
                            }
                        }
                        AgentEvent::FileWritten(path) => {
                            AgentEvent::FileWritten(display_path(
                                &path,
                                &turn.workspace_root,
                            ))
                        }
                        other => other,
                    };
                    on_event(event);
                }
            },
        )
        .await?;

        outcome.cancelled = process.cancelled;
        if process.cancelled {
            return Ok(outcome);
        }
        let name = &self.definition.name;
        outcome.error = if let Some(said) = reported_error {
            // A sign-in problem is the most common first failure, so it gets
            // the remedy with it.
            let hint = if said.to_lowercase().contains("log")
                && !self.definition.login_hint.is_empty()
            {
                format!(" {}", self.definition.login_hint)
            } else {
                String::new()
            };
            Some(format!("{name} reported an error: {said}{hint}"))
        } else if process.idle_timed_out {
            Some(format!(
                "{name} printed nothing for {} minutes and was stopped.",
                IDLE_LIMIT.as_secs() / 60
            ))
        } else if !process.succeeded() {
            let code = process
                .exit_code
                .map_or("a signal".to_string(), |c| format!("code {c}"));
            let detail = if process.stderr_tail.is_empty() {
                String::new()
            } else {
                format!(
                    ": {}",
                    process.stderr_tail.lines().last().unwrap_or("")
                )
            };
            Some(format!("{name} exited with {code}{detail}"))
        } else if !parser.finished() {
            Some(format!("{name} exited without reporting a result."))
        } else {
            None
        };
        Ok(outcome)
    }
}

/// Finds every agent that could run jobs: each definition's program, checked on
/// this machine.
pub fn detect_cli_agents(
    definitions: &[AgentDefinition],
    env: &Arc<ShellEnv>,
    path_overrides: &BTreeMap<String, String>,
) -> Vec<CliBackend> {
    definitions
        .iter()
        .map(|d| {
            CliBackend::detect(
                d.clone(),
                Arc::clone(env),
                path_overrides.get(&d.id).map(String::as_str),
            )
        })
        .collect()
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::Mutex;

    /// Writes a shell script that stands in for an agent program, and returns
    /// its definition.
    fn fake_agent(dir: &Path, script: &str) -> AgentDefinition {
        let program = dir.join("fake-agent");
        std::fs::write(&program, format!("#!/bin/sh\n{script}\n")).unwrap();
        std::fs::set_permissions(
            &program,
            std::fs::Permissions::from_mode(0o755),
        )
        .unwrap();
        serde_json::from_value(serde_json::json!({
            "id": "fake",
            "name": "Fake Agent",
            "program": program,
            "versionArgs": ["--version"],
            "helpArgs": ["--help"],
            "args": ["run", "{systemPromptPath}"],
            "resumeArgs": ["--resume", "{sessionId}"],
            "stdin": "{userPromptText}",
            "cwd": "{workspaceRoot}",
            "parser": "claude-stream-json",
            "checkFlags": ["--output-format", "--gone-flag"],
            "supportsResume": true,
            "verified": true,
            "loginHint": "Sign in first."
        }))
        .unwrap()
    }

    fn turn(dir: &Path) -> Turn {
        Turn {
            workspace_root: dir.to_path_buf(),
            dot_dir: dir.join(".codjiva"),
            artifact_dir: dir.join(".codjiva/artifacts/a/v1"),
            job_dir: dir.join(".codjiva/jobs/j"),
            system_prompt_path: dir.join("system.md"),
            user_prompt_path: dir.join("user.md"),
            user_prompt: "the task".into(),
            resume_session: None,
            model: None,
            effort: None,
            max_budget_usd: None,
            log_path: dir.join("agent.log.jsonl"),
        }
    }

    fn env() -> Arc<ShellEnv> {
        Arc::new(ShellEnv::from_vars([(
            "PATH".to_string(),
            "/bin:/usr/bin".to_string(),
        )]))
    }

    const SCRIPT: &str = r#"
case "$1" in
  --version) echo "9.9.9 (Fake)"; exit 0 ;;
  --help) echo "usage: fake --output-format <f>"; exit 0 ;;
esac
read prompt
echo '{"type":"system","subtype":"init","session_id":"sess-7","model":"m1"}'
echo "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"prompt was: $prompt; args: $*\"}]}}"
echo '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.5,"usage":{"input_tokens":1,"output_tokens":2}}'
"#;

    #[test]
    fn detection_reads_the_version_and_warns_about_a_flag_missing_from_help() {
        let dir = tempfile::tempdir().unwrap();
        let backend =
            CliBackend::detect(fake_agent(dir.path(), SCRIPT), env(), None);
        let info = backend.info();
        assert!(info.ok);
        assert_eq!(info.version.as_deref(), Some("9.9.9 (Fake)"));
        assert!(
            info.note.contains("--gone-flag")
                && !info.note.contains("--output-format,"),
            "{}",
            info.note
        );
    }

    #[test]
    fn a_missing_program_is_reported_with_the_install_hint() {
        let mut definition =
            fake_agent(tempfile::tempdir().unwrap().path(), SCRIPT);
        definition.program = "definitely-not-installed-anywhere".into();
        definition.install_hint = "Install it from example.com.".into();
        let info = CliBackend::detect(definition, env(), None).info();
        assert!(!info.ok);
        assert!(
            info.note.contains("was not found")
                && info.note.contains("Install it from example.com."),
            "{}",
            info.note
        );
    }

    #[tokio::test]
    async fn a_turn_passes_the_prompt_on_stdin_and_collects_events_session_and_log(
    ) {
        let dir = tempfile::tempdir().unwrap();
        let backend =
            CliBackend::detect(fake_agent(dir.path(), SCRIPT), env(), None);
        let events = Mutex::new(Vec::new());
        let mut t = turn(dir.path());
        t.resume_session = Some("earlier".into());
        let outcome = backend
            .run(&t, &CancellationToken::new(), &|e| {
                events.lock().unwrap().push(e)
            })
            .await
            .unwrap();
        assert_eq!(
            outcome,
            TurnOutcome {
                session_id: Some("sess-7".into()),
                model: Some("m1".into()),
                cancelled: false,
                error: None
            }
        );
        let events = events.into_inner().unwrap();
        let said = events
            .iter()
            .find_map(|e| {
                if let AgentEvent::Text(t) = e {
                    Some(t.clone())
                } else {
                    None
                }
            })
            .unwrap();
        assert!(
            said.starts_with("prompt was: the task; args: run "),
            "{said}"
        );
        assert!(said.ends_with("--resume earlier"), "{said}");
        assert!(events.contains(&AgentEvent::Usage {
            cost_usd: Some(0.5),
            input_tokens: Some(1),
            output_tokens: Some(2)
        }));
        assert_eq!(
            std::fs::read_to_string(dir.path().join("agent.log.jsonl"))
                .unwrap()
                .lines()
                .count(),
            3
        );
    }

    #[tokio::test]
    async fn failures_become_sentences_for_the_user() {
        let dir = tempfile::tempdir().unwrap();
        let run = |script: &'static str| {
            let dir = dir.path().to_path_buf();
            async move {
                let backend =
                    CliBackend::detect(fake_agent(&dir, script), env(), None);
                backend
                    .run(&turn(&dir), &CancellationToken::new(), &|_| {})
                    .await
                    .unwrap()
                    .error
                    .unwrap()
            }
        };
        let said = run(r#"echo '{"type":"result","subtype":"success","is_error":true,"result":"Not logged in"}'"#).await;
        assert_eq!(
            said,
            "Fake Agent reported an error: Not logged in Sign in first."
        );
        let crashed = run("echo 'boom' >&2; exit 2").await;
        assert_eq!(crashed, "Fake Agent exited with code 2: boom");
        let silent = run("exit 0").await;
        assert_eq!(silent, "Fake Agent exited without reporting a result.");
    }
}
