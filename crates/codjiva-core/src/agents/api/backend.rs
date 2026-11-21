//! The agent loop of API-key mode: the app itself plays the part a command-line
//! agent plays.
//!
//! One turn of a job is a conversation with a model: the app sends the prompt,
//! the model answers with tool calls, the app carries them out and sends the
//! results, and so on until the model calls `finish` or stops by itself. A fix
//! turn continues the same conversation, so the model still knows what it drew
//! and why.

use crate::agents::api::provider::{
    Conversation, Price, Provider, StopReason, ToolCall, UserPart,
};
use crate::agents::api::tools::{ToolBox, ToolOutput};
use crate::agents::{AgentEvent, AgentInfo, Backend, Turn, TurnOutcome};
use crate::error::{AppError, Result};
use crate::settings::Effort;
use crate::workspace::Workspace;
use async_trait::async_trait;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio_util::sync::CancellationToken;

/// The most requests one turn may make. A model that has not finished by then
/// is going in circles.
const MAX_REQUESTS_PER_TURN: usize = 60;

/// How many times in a row a model may be cut off at the output limit before
/// the turn fails.
const MAX_CUT_OFF_IN_A_ROW: usize = 3;

/// A conversation kept between the turns of a job, with the tool results the
/// model is still owed. A model that called `finish` gets that call's result at
/// the start of the next turn.
struct Session {
    conversation: Box<dyn Conversation>,
    owed: Vec<UserPart>,
}

pub struct ApiBackend {
    info: AgentInfo,
    provider: Arc<dyn Provider>,
    /// Conversations of jobs that may still get a fix turn, by session id. They
    /// live only as long as the app runs.
    sessions: Mutex<HashMap<String, Session>>,
    next_session: AtomicU64,
}

impl ApiBackend {
    pub fn new(info: AgentInfo, provider: Arc<dyn Provider>) -> ApiBackend {
        ApiBackend {
            info,
            provider,
            sessions: Mutex::new(HashMap::new()),
            next_session: AtomicU64::new(1),
        }
    }
}

/// Describes a tool call for the job log, in the same words a command-line
/// agent's calls get.
fn summarise(call: &ToolCall) -> (String, String) {
    let text = |key: &str| {
        call.input
            .as_ref()
            .ok()
            .and_then(|v| v.get(key))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    match call.name.as_str() {
        "read_file" => {
            let lines = call
                .input
                .as_ref()
                .ok()
                .and_then(|v| v.get("start_line"))
                .and_then(Value::as_u64)
                .map(|s| format!(" (from line {s})"))
                .unwrap_or_default();
            ("Read".into(), format!("{}{lines}", text("path")))
        }
        "list_dir" => (
            "List".into(),
            if text("path").is_empty() {
                ".".into()
            } else {
                text("path")
            },
        ),
        "search" => ("Search".into(), text("pattern")),
        "write_file" => ("Write".into(), text("path")),
        other => (other.to_string(), String::new()),
    }
}

/// Estimates what one reply cost, when the model's price is known.
fn cost_of(
    price: Option<Price>,
    usage: &crate::agents::api::provider::Usage,
) -> Option<f64> {
    price.map(|p| p.cost(usage))
}

#[async_trait]
impl Backend for ApiBackend {
    fn info(&self) -> AgentInfo {
        self.info.clone()
    }

    async fn run(
        &self,
        turn: &Turn,
        cancel: &CancellationToken,
        on_event: &(dyn Fn(AgentEvent) + Send + Sync),
    ) -> Result<TurnOutcome> {
        let workspace = Arc::new(Workspace::open(&turn.workspace_root)?);
        let toolbox = ToolBox::new(workspace, turn.artifact_dir.clone());

        // Continue the job's conversation if there is one, otherwise start a
        // new one.
        let resumed = turn.resume_session.as_ref().and_then(|id| {
            self.sessions
                .lock()
                .expect("the sessions lock is not poisoned")
                .remove(id)
                .map(|s| (id.clone(), s))
        });
        let (session_id, mut session) = match resumed {
            Some(found) => found,
            None => {
                let system = std::fs::read_to_string(&turn.system_prompt_path)
                    .map_err(|e| AppError::io("read the job's prompt", e))?;
                let id = format!(
                    "api-{}",
                    self.next_session.fetch_add(1, Ordering::SeqCst)
                );
                on_event(AgentEvent::SessionStarted {
                    session_id: id.clone(),
                    model: self.info.version.clone(),
                });
                (
                    id,
                    Session {
                        conversation: self.provider.start(
                            system,
                            toolbox.specs(),
                            turn.effort.as_deref().and_then(Effort::parse),
                        ),
                        owed: Vec::new(),
                    },
                )
            }
        };

        let mut outcome = TurnOutcome {
            session_id: Some(session_id.clone()),
            model: self.info.version.clone(),
            ..TurnOutcome::default()
        };
        let mut input: Vec<UserPart> = std::mem::take(&mut session.owed);
        input.push(UserPart::Text(turn.user_prompt.clone()));
        let price = self.provider.price();
        let mut cut_off_in_a_row = 0;

        for _ in 0..MAX_REQUESTS_PER_TURN {
            let reply = match session
                .conversation
                .send(std::mem::take(&mut input), cancel)
                .await
            {
                Ok(reply) => reply,
                Err(error) if error.code == "cancelled" => {
                    outcome.cancelled = true;
                    return Ok(outcome);
                }
                Err(error) => {
                    outcome.error = Some(error.message);
                    return Ok(outcome);
                }
            };
            if let Some(model) = &reply.model {
                outcome.model = Some(model.clone());
            }
            on_event(AgentEvent::Usage {
                cost_usd: cost_of(price, &reply.usage),
                input_tokens: Some(
                    reply.usage.input_tokens
                        + reply.usage.cache_read_tokens
                        + reply.usage.cache_write_tokens,
                ),
                output_tokens: Some(reply.usage.output_tokens),
            });
            if !reply.text.is_empty() {
                on_event(AgentEvent::Text(reply.text.clone()));
            }

            match &reply.stop {
                StopReason::Refusal(why) => {
                    outcome.error = Some(format!(
                        "The model declined this request{}",
                        if why.is_empty() {
                            ".".to_string()
                        } else {
                            format!(": {why}")
                        }
                    ));
                    return Ok(outcome);
                }
                StopReason::MaxTokens => {
                    cut_off_in_a_row += 1;
                    if cut_off_in_a_row >= MAX_CUT_OFF_IN_A_ROW {
                        outcome.error = Some(
                            "The model's replies kept being cut off at the \
                             output limit, so it could not finish."
                                .into(),
                        );
                        return Ok(outcome);
                    }
                    // A reply cut off in the middle of a tool call has
                    // incomplete input. Its tools are not run; the model is
                    // told to send the call again.
                    for call in &reply.tool_calls {
                        input.push(UserPart::ToolResult {
                            call_id: call.id.clone(),
                            tool_name: call.name.clone(),
                            is_error: true,
                            content: "Your reply was cut off at the output \
                                      limit before this call was complete, so \
                                      it was not carried out. Send it again. \
                                      If it was a large file, make the file \
                                      smaller."
                                .into(),
                        });
                    }
                    if reply.tool_calls.is_empty() {
                        input.push(UserPart::Text(
                            "Your reply was cut off at the output limit. \
                             Continue from where you stopped."
                                .into(),
                        ));
                    }
                    continue;
                }
                _ => cut_off_in_a_row = 0,
            }

            if reply.tool_calls.is_empty() {
                // The model stopped without calling a tool: it considers itself
                // done.
                self.sessions
                    .lock()
                    .expect("the sessions lock is not poisoned")
                    .insert(session_id, session);
                on_event(AgentEvent::Finished { error: None });
                return Ok(outcome);
            }

            let mut finished = false;
            for call in &reply.tool_calls {
                let (name, summary) = summarise(call);
                let output = match &call.input {
                    Ok(value) => toolbox.call(&call.name, value),
                    // Sending the unreadable input back lets the model see what
                    // it got wrong.
                    Err(raw) => ToolOutput {
                        content: serde_json::json!({ "INVALID_JSON": raw })
                            .to_string(),
                        is_error: true,
                        wrote: None,
                        finished: None,
                    },
                };
                if call.name != "finish" {
                    on_event(AgentEvent::ToolUse { name, summary });
                }
                if let Some(path) = &output.wrote {
                    on_event(AgentEvent::FileWritten(path.clone()));
                }
                finished |= output.finished.is_some();
                input.push(UserPart::ToolResult {
                    call_id: call.id.clone(),
                    tool_name: call.name.clone(),
                    content: output.content,
                    is_error: output.is_error,
                });
            }
            if finished {
                // The results of this last round are owed to the model if the
                // job continues.
                session.owed = input;
                self.sessions
                    .lock()
                    .expect("the sessions lock is not poisoned")
                    .insert(session_id, session);
                on_event(AgentEvent::Finished { error: None });
                return Ok(outcome);
            }
            if cancel.is_cancelled() {
                outcome.cancelled = true;
                return Ok(outcome);
            }
        }
        outcome.error = Some(format!(
            "The model made {MAX_REQUESTS_PER_TURN} requests without \
             finishing."
        ));
        Ok(outcome)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::api::provider::{Reply, Usage};
    use crate::agents::api::tools::ToolSpec;
    use serde_json::json;
    use std::collections::VecDeque;

    /// A provider that answers from a script and records what it was sent.
    struct Scripted {
        replies: Arc<Mutex<VecDeque<Result<Reply>>>>,
        received: Arc<Mutex<Vec<Vec<UserPart>>>>,
        systems: Arc<Mutex<Vec<String>>>,
    }

    struct ScriptedConversation {
        replies: Arc<Mutex<VecDeque<Result<Reply>>>>,
        received: Arc<Mutex<Vec<Vec<UserPart>>>>,
    }

    #[async_trait]
    impl Conversation for ScriptedConversation {
        async fn send(
            &mut self,
            input: Vec<UserPart>,
            _cancel: &CancellationToken,
        ) -> Result<Reply> {
            self.received.lock().unwrap().push(input);
            self.replies
                .lock()
                .unwrap()
                .pop_front()
                .expect("the script has a reply for every request")
        }
    }

    impl Provider for Scripted {
        fn start(
            &self,
            system: String,
            _tools: Vec<ToolSpec>,
            _effort: Option<crate::settings::Effort>,
        ) -> Box<dyn Conversation> {
            self.systems.lock().unwrap().push(system);
            Box::new(ScriptedConversation {
                replies: Arc::clone(&self.replies),
                received: Arc::clone(&self.received),
            })
        }

        fn price(&self) -> Option<Price> {
            Some(Price {
                input: 1.0,
                output: 10.0,
                cache_read: 0.1,
                cache_write: 1.25,
            })
        }
    }

    fn reply(
        text: &str,
        calls: Vec<(&str, &str, Value)>,
        stop: StopReason,
    ) -> Result<Reply> {
        Ok(Reply {
            text: text.into(),
            tool_calls: calls
                .into_iter()
                .map(|(id, name, input)| ToolCall {
                    id: id.into(),
                    name: name.into(),
                    input: Ok(input),
                })
                .collect(),
            stop,
            usage: Usage {
                input_tokens: 1000,
                output_tokens: 100,
                cache_read_tokens: 0,
                cache_write_tokens: 0,
            },
            model: Some("scripted-1".into()),
        })
    }

    struct Setup {
        _dir: tempfile::TempDir,
        turn: Turn,
        backend: ApiBackend,
        received: Arc<Mutex<Vec<Vec<UserPart>>>>,
        systems: Arc<Mutex<Vec<String>>>,
    }

    fn setup(replies: Vec<Result<Reply>>) -> Setup {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir_all(root.join(".codjiva/artifacts/a/v1/src"))
            .unwrap();
        std::fs::write(root.join("src/a.go"), "package a\n").unwrap();
        std::fs::write(root.join("system.md"), "SYSTEM PROMPT").unwrap();
        let turn = Turn {
            workspace_root: root.clone(),
            dot_dir: root.join(".codjiva"),
            artifact_dir: root.join(".codjiva/artifacts/a/v1"),
            job_dir: root.join(".codjiva/jobs/j"),
            system_prompt_path: root.join("system.md"),
            user_prompt_path: root.join("user.md"),
            user_prompt: "Visualise src/a.go".into(),
            resume_session: None,
            model: None,
            effort: None,
            max_budget_usd: None,
            customizations: false,
            log_path: root.join("log"),
        };
        let received = Arc::new(Mutex::new(Vec::new()));
        let systems = Arc::new(Mutex::new(Vec::new()));
        let provider = Scripted {
            replies: Arc::new(Mutex::new(VecDeque::from(replies))),
            received: Arc::clone(&received),
            systems: Arc::clone(&systems),
        };
        let info = AgentInfo {
            id: "api-test".into(),
            name: "Test API".into(),
            kind: "api".into(),
            path: None,
            version: Some("scripted-1".into()),
            ok: true,
            note: String::new(),
            supports_resume: true,
            verified: true,
            default_model: None,
            quick_model: None,
            limits: String::new(),
            plain_args: Vec::new(),
            plain_note: String::new(),
        };
        Setup {
            _dir: dir,
            turn,
            backend: ApiBackend::new(info, Arc::new(provider)),
            received,
            systems,
        }
    }

    async fn run(setup: &Setup, turn: &Turn) -> (TurnOutcome, Vec<AgentEvent>) {
        let events = Mutex::new(Vec::new());
        let outcome = setup
            .backend
            .run(turn, &CancellationToken::new(), &|e| {
                events.lock().unwrap().push(e)
            })
            .await
            .unwrap();
        (outcome, events.into_inner().unwrap())
    }

    #[tokio::test]
    async fn a_turn_reads_writes_and_finishes_and_reports_it_like_any_agent() {
        let s = setup(vec![
            reply(
                "Reading.",
                vec![
                    ("c1", "read_file", json!({ "path": "src/a.go" })),
                    ("c2", "list_dir", json!({ "path": "" })),
                ],
                StopReason::ToolUse,
            ),
            reply(
                "",
                vec![(
                    "c3",
                    "write_file",
                    json!({ "path": ".codjiva/artifacts/a/v1/src/plant.js", "content": "CJ.definePlant({});" }),
                )],
                StopReason::ToolUse,
            ),
            reply(
                "All done.",
                vec![("c4", "finish", json!({ "summary": "Drew it." }))],
                StopReason::ToolUse,
            ),
        ]);
        let (outcome, events) = run(&s, &s.turn).await;
        assert_eq!(
            (outcome.error, outcome.cancelled, outcome.model.as_deref()),
            (None, false, Some("scripted-1"))
        );
        assert_eq!(
            std::fs::read_to_string(s.turn.artifact_dir.join("src/plant.js"))
                .unwrap(),
            "CJ.definePlant({});"
        );
        assert_eq!(*s.systems.lock().unwrap(), vec!["SYSTEM PROMPT"]);

        // The model got the prompt first, then the results of both calls of its
        // first reply in one message.
        let received = s.received.lock().unwrap().clone();
        assert_eq!(
            received[0],
            vec![UserPart::Text("Visualise src/a.go".into())]
        );
        assert_eq!(received[1].len(), 2);
        assert!(matches!(
            &received[1][0],
            UserPart::ToolResult { call_id, content, is_error: false, .. }
                if call_id == "c1" && content.starts_with("1\tpackage a")
        ));

        assert!(events.contains(&AgentEvent::ToolUse {
            name: "Read".into(),
            summary: "src/a.go".into()
        }));
        assert!(events.contains(&AgentEvent::ToolUse {
            name: "Write".into(),
            summary: ".codjiva/artifacts/a/v1/src/plant.js".into()
        }));
        assert!(events.contains(&AgentEvent::FileWritten(
            ".codjiva/artifacts/a/v1/src/plant.js".into()
        )));
        assert!(events.contains(&AgentEvent::Text("All done.".into())));
        assert_eq!(events.last(), Some(&AgentEvent::Finished { error: None }));
        // 1,000 input tokens at $1 and 100 output tokens at $10 per million.
        assert!(events.iter().any(|e| matches!(
            e,
            AgentEvent::Usage {
                cost_usd: Some(c),
                input_tokens: Some(1000),
                output_tokens: Some(100),
            } if (c - 0.002).abs() < 1e-9
        )));
    }

    #[tokio::test]
    async fn a_write_outside_the_artifact_folder_is_refused_and_the_model_is_told(
    ) {
        let s = setup(vec![
            reply(
                "",
                vec![(
                    "c1",
                    "write_file",
                    json!({ "path": "src/a.go", "content": "hacked" }),
                )],
                StopReason::ToolUse,
            ),
            reply("Sorry.", vec![], StopReason::EndTurn),
        ]);
        let (outcome, _) = run(&s, &s.turn).await;
        assert!(outcome.error.is_none());
        assert_eq!(
            std::fs::read_to_string(s.turn.workspace_root.join("src/a.go"))
                .unwrap(),
            "package a\n"
        );
        let received = s.received.lock().unwrap().clone();
        assert!(matches!(
            &received[1][0],
            UserPart::ToolResult { is_error: true, content, .. }
                if content.contains("You may only write inside")
        ));
    }

    #[tokio::test]
    async fn a_fix_turn_continues_the_same_conversation_and_pays_the_owed_result_first(
    ) {
        let s = setup(vec![
            reply(
                "",
                vec![("c1", "finish", json!({ "summary": "v1" }))],
                StopReason::ToolUse,
            ),
            reply("Fixed.", vec![], StopReason::EndTurn),
        ]);
        let (first, _) = run(&s, &s.turn).await;
        let mut fix = s.turn.clone();
        fix.resume_session = first.session_id.clone();
        fix.user_prompt = "Fix the overlap.".into();
        let (second, _) = run(&s, &fix).await;
        assert_eq!(second.session_id, first.session_id);
        assert_eq!(
            s.systems.lock().unwrap().len(),
            1,
            "no second conversation was started"
        );
        let received = s.received.lock().unwrap().clone();
        assert!(matches!(
            &received[1][0],
            UserPart::ToolResult { call_id, .. } if call_id == "c1"
        ));
        assert_eq!(received[1][1], UserPart::Text("Fix the overlap.".into()));
    }

    #[tokio::test]
    async fn a_reply_cut_off_in_a_tool_call_is_not_carried_out() {
        let cut = Ok(Reply {
            text: String::new(),
            tool_calls: vec![ToolCall {
                id: "c1".into(),
                name: "write_file".into(),
                input: Err("{\"path\": \
                            \".codjiva/artifacts/a/v1/src/plant.js\", \
                            \"content\": \"CJ.def"
                    .into()),
            }],
            stop: StopReason::MaxTokens,
            usage: Usage::default(),
            model: None,
        });
        let s = setup(vec![cut, reply("ok", vec![], StopReason::EndTurn)]);
        let (outcome, events) = run(&s, &s.turn).await;
        assert!(outcome.error.is_none());
        assert!(!s.turn.artifact_dir.join("src/plant.js").exists());
        assert!(!events
            .iter()
            .any(|e| matches!(e, AgentEvent::FileWritten(_))));
        let received = s.received.lock().unwrap().clone();
        assert!(matches!(
            &received[1][0],
            UserPart::ToolResult { is_error: true, content, .. }
                if content.contains("cut off")
        ));
    }

    #[tokio::test]
    async fn invalid_tool_input_refusals_and_provider_errors_end_or_correct_the_turn(
    ) {
        let broken = Ok(Reply {
            text: String::new(),
            tool_calls: vec![ToolCall {
                id: "c1".into(),
                name: "read_file".into(),
                input: Err("{oops".into()),
            }],
            stop: StopReason::ToolUse,
            usage: Usage::default(),
            model: None,
        });
        let s = setup(vec![broken, reply("ok", vec![], StopReason::EndTurn)]);
        run(&s, &s.turn).await;
        assert!(matches!(
            &s.received.lock().unwrap()[1][0],
            UserPart::ToolResult { is_error: true, content, .. }
                if content == "{\"INVALID_JSON\":\"{oops\"}"
        ));

        let s = setup(vec![reply(
            "",
            vec![],
            StopReason::Refusal("Declined for safety.".into()),
        )]);
        assert_eq!(
            run(&s, &s.turn).await.0.error.as_deref(),
            Some("The model declined this request: Declined for safety.")
        );

        let s = setup(vec![Err(AppError::new(
            "api_key_rejected",
            "Anthropic rejected the API key. Check the key in Settings.",
        ))]);
        assert_eq!(
            run(&s, &s.turn).await.0.error.as_deref(),
            Some("Anthropic rejected the API key. Check the key in Settings.")
        );

        let s = setup(vec![Err(AppError::new(
            "cancelled",
            "The job was cancelled.",
        ))]);
        assert!(run(&s, &s.turn).await.0.cancelled);
    }
}
