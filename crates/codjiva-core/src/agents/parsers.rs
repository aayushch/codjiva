//! Parsers for the output of the command-line agents other than Claude Code.
//!
//! Each program prints one JSON object per line while it works, in its own
//! format. A parser turns those lines into the same [`AgentEvent`]s, so the
//! rest of the app does not care which program ran.
//!
//!   - `codex-jsonl`: `codex exec --json`.
//!   - `gemini-stream-json`: `gemini -o stream-json`, and the Antigravity CLI
//!     that replaced it.
//!   - `cursor-stream-json`: `cursor-agent -p --output-format stream-json`.
//!   - `pi-json`: `pi -p --mode json`.

use crate::agents::{AgentEvent, LineParser};
use serde_json::Value;

fn text_of<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn number_of(value: &Value, key: &str) -> Option<u64> {
    value.get(key).and_then(Value::as_u64)
}

/// The most characters of a shell command, a search pattern or a search
/// query that the job log shows. A path is never cut.
const COMMAND_LIMIT: usize = 1000;

/// Writes a shell command, a search pattern or a search query on one line for
/// the job log. Line breaks and runs of spaces become one space. Text longer
/// than [`COMMAND_LIMIT`] characters is cut there and ends with "…".
///
/// The job panel wraps long lines, so the limit only keeps a command that
/// carries a whole file, such as a script written with a here-document, from
/// filling the log.
fn shorten(text: &str) -> String {
    let one_line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.chars().count() <= COMMAND_LIMIT {
        return one_line;
    }
    format!(
        "{}…",
        one_line.chars().take(COMMAND_LIMIT).collect::<String>()
    )
}

/// The names the programs give the argument that holds the path of the file a
/// tool call works on.
const PATH_ARGUMENTS: [&str; 5] = [
    "path",
    "file_path",
    "filePath",
    "absolute_path",
    "target_file",
];

/// Describes a tool call for the job log from its arguments: the file, pattern
/// or command it works on. The programs name these arguments differently, so
/// the usual names are tried in order.
///
/// A path is returned whole. The caller removes the workspace folder from its
/// start afterwards, which only works on a path that still has its end. A
/// pattern, query or command is written on one line by [`shorten`].
fn summarise(args: Option<&Value>) -> String {
    let Some(args) = args else {
        return String::new();
    };
    let named = |key: &str| text_of(args, key).filter(|s| !s.is_empty());
    if let Some(path) = PATH_ARGUMENTS.iter().find_map(|key| named(key)) {
        return path.to_string();
    }
    ["pattern", "query", "glob", "command"]
        .iter()
        .find_map(|key| named(key))
        .map(shorten)
        .unwrap_or_default()
}

/// The path a tool call writes to, when the tool is one that writes files.
fn written_path(tool: &str, args: Option<&Value>) -> Option<String> {
    let lower = tool.to_lowercase();
    if !["write", "edit", "replace", "create", "patch"]
        .iter()
        .any(|word| lower.contains(word))
    {
        return None;
    }
    let args = args?;
    PATH_ARGUMENTS
        .iter()
        .find_map(|key| text_of(args, key))
        .map(str::to_string)
}

/// A tool's name with a capital first letter, as the job log shows tools:
/// `read_file` is shown as `Read_file`, `shell` as `Shell`.
fn tool_title(name: &str) -> String {
    let mut chars = name.chars();
    match chars.next() {
        Some(first) => {
            first.to_uppercase().collect::<String>() + chars.as_str()
        }
        None => "Tool".to_string(),
    }
}

/// The events for one tool call: a `FileWritten` first when the tool writes a
/// file, then the `ToolUse` line for the log.
fn tool_events(name: &str, args: Option<&Value>) -> Vec<AgentEvent> {
    let mut out = Vec::new();
    if let Some(path) = written_path(name, args) {
        out.push(AgentEvent::FileWritten(path));
    }
    out.push(AgentEvent::ToolUse {
        name: tool_title(name),
        summary: summarise(args),
    });
    out
}

// ----------------------------------------------------------------------------
// Codex

/// `codex exec --json`. The stream is a `thread.started` line, then items as
/// they start and complete, then `turn.completed` with the token counts, or
/// `turn.failed`.
#[derive(Default)]
pub struct CodexParser {
    finished: bool,
}

impl LineParser for CodexParser {
    fn parse_line(&mut self, line: &str) -> Vec<AgentEvent> {
        let Ok(event) = serde_json::from_str::<Value>(line) else {
            return vec![AgentEvent::Notice(line.to_string())];
        };
        match text_of(&event, "type").unwrap_or("") {
            "thread.started" => text_of(&event, "thread_id")
                .map(|id| AgentEvent::SessionStarted {
                    session_id: id.to_string(),
                    model: None,
                })
                .into_iter()
                .collect(),
            kind @ ("item.started" | "item.completed") => {
                let completed = kind == "item.completed";
                let item = event.get("item").unwrap_or(&Value::Null);
                match (text_of(item, "type").unwrap_or(""), completed) {
                    // A message is reported once, when it is complete.
                    ("agent_message", true) => text_of(item, "text")
                        .map(str::trim)
                        .filter(|t| !t.is_empty())
                        .map(|t| AgentEvent::Text(t.to_string()))
                        .into_iter()
                        .collect(),
                    ("command_execution", false) => vec![AgentEvent::ToolUse {
                        name: "Shell".into(),
                        summary: shorten(
                            text_of(item, "command").unwrap_or(""),
                        ),
                    }],
                    // A file change lists every file it touched, with what
                    // happened to each.
                    ("file_change", true) => item
                        .get("changes")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                        .filter_map(|change| text_of(change, "path"))
                        .flat_map(|path| {
                            [
                                AgentEvent::FileWritten(path.to_string()),
                                AgentEvent::ToolUse {
                                    name: "Write".into(),
                                    summary: path.to_string(),
                                },
                            ]
                        })
                        .collect(),
                    ("mcp_tool_call", false) => vec![AgentEvent::ToolUse {
                        name: tool_title(
                            text_of(item, "tool").unwrap_or("tool"),
                        ),
                        summary: String::new(),
                    }],
                    ("web_search", false) => vec![AgentEvent::ToolUse {
                        name: "Web_search".into(),
                        summary: shorten(text_of(item, "query").unwrap_or("")),
                    }],
                    _ => Vec::new(),
                }
            }
            "turn.completed" => {
                self.finished = true;
                let usage = event.get("usage").unwrap_or(&Value::Null);
                vec![
                    // Tokens read from the cache are counted as input here, as
                    // for every agent.
                    AgentEvent::Usage {
                        cost_usd: None,
                        input_tokens: number_of(usage, "input_tokens"),
                        output_tokens: number_of(usage, "output_tokens"),
                    },
                    AgentEvent::Finished { error: None },
                ]
            }
            "turn.failed" | "error" => {
                self.finished = true;
                let said = text_of(&event, "message")
                    .or_else(|| {
                        event.get("error").and_then(|e| text_of(e, "message"))
                    })
                    .unwrap_or("Codex reported an error.");
                vec![AgentEvent::Finished {
                    error: Some(said.to_string()),
                }]
            }
            _ => Vec::new(),
        }
    }

    fn finished(&self) -> bool {
        self.finished
    }
}

// ----------------------------------------------------------------------------
// Gemini

/// `gemini -o stream-json`. The stream is an `init` line, `message` lines for
/// both sides of the conversation, `tool_use` and `tool_result` lines, and a
/// final `result` with the counts.
#[derive(Default)]
pub struct GeminiParser {
    finished: bool,
    /// The assistant's text collected from partial messages, reported when it
    /// is complete.
    pending: String,
}

impl GeminiParser {
    /// Reports the text collected so far as one message.
    fn flush(&mut self, out: &mut Vec<AgentEvent>) {
        let text = std::mem::take(&mut self.pending);
        if !text.trim().is_empty() {
            out.push(AgentEvent::Text(text.trim().to_string()));
        }
    }
}

impl LineParser for GeminiParser {
    fn parse_line(&mut self, line: &str) -> Vec<AgentEvent> {
        let Ok(event) = serde_json::from_str::<Value>(line) else {
            // The program prints diagnostics and stack traces as plain lines.
            // Only short ones that are not stack frames are worth showing.
            let plain = line.trim();
            return if plain.is_empty()
                || plain.starts_with("at ")
                || plain.len() > 300
            {
                Vec::new()
            } else {
                vec![AgentEvent::Notice(plain.to_string())]
            };
        };
        let mut out = Vec::new();
        match text_of(&event, "type").unwrap_or("") {
            "init" => {
                if let Some(id) = text_of(&event, "session_id") {
                    out.push(AgentEvent::SessionStarted {
                        session_id: id.to_string(),
                        model: text_of(&event, "model").map(str::to_string),
                    });
                }
            }
            "message" if text_of(&event, "role") == Some("assistant") => {
                let content = text_of(&event, "content").unwrap_or("");
                // A message marked `delta` is a piece of a longer one. A
                // message without the mark is complete and replaces what was
                // collected.
                if event.get("delta").and_then(Value::as_bool) == Some(true) {
                    self.pending.push_str(content);
                } else {
                    self.pending = content.to_string();
                    self.flush(&mut out);
                }
            }
            "tool_use" => {
                self.flush(&mut out);
                out.extend(tool_events(
                    text_of(&event, "tool_name").unwrap_or("tool"),
                    event.get("parameters"),
                ));
            }
            "tool_result" if text_of(&event, "status") == Some("error") => {
                let said = event
                    .get("error")
                    .and_then(|e| text_of(e, "message"))
                    .or_else(|| text_of(&event, "output"))
                    .unwrap_or("");
                // A refused write is the one tool failure the user should see
                // as such.
                if said.to_lowercase().contains("denied")
                    || said.to_lowercase().contains("not allowed")
                    || said.to_lowercase().contains("policy")
                {
                    out.push(AgentEvent::PermissionDenied {
                        tool: "a tool".into(),
                    });
                }
            }
            "error" => {
                if let Some(said) = text_of(&event, "message") {
                    out.push(AgentEvent::Notice(said.to_string()));
                }
            }
            "result" => {
                self.flush(&mut out);
                self.finished = true;
                let stats = event.get("stats").unwrap_or(&Value::Null);
                out.push(AgentEvent::Usage {
                    cost_usd: None,
                    input_tokens: number_of(stats, "input_tokens"),
                    output_tokens: number_of(stats, "output_tokens"),
                });
                let error =
                    (text_of(&event, "status") == Some("error")).then(|| {
                        api_error_message(
                            event
                                .get("error")
                                .and_then(|e| text_of(e, "message"))
                                .unwrap_or("Gemini CLI reported an error."),
                        )
                    });
                out.push(AgentEvent::Finished { error });
            }
            _ => {}
        }
        out
    }

    fn finished(&self) -> bool {
        self.finished
    }
}

/// The Gemini CLI reports an API failure as JSON nested inside JSON inside a
/// string. This digs out the innermost `message`, which is the sentence a
/// person can read, and falls back to the text as given.
fn api_error_message(raw: &str) -> String {
    let mut current = raw.to_string();
    for _ in 0..4 {
        let Some(start) = current.find('{') else {
            break;
        };
        let Some(end) = current.rfind('}') else { break };
        let Ok(parsed) = serde_json::from_str::<Value>(&current[start..=end])
        else {
            break;
        };
        let Some(inner) =
            parsed.pointer("/error/message").and_then(Value::as_str)
        else {
            break;
        };
        current = inner.to_string();
    }
    current.trim().to_string()
}

// ----------------------------------------------------------------------------
// Cursor

/// `cursor-agent -p --output-format stream-json`. The stream is a `system` line
/// with the session, `thinking` pieces, `assistant` messages, `tool_call` lines
/// when a tool starts and completes, and a final `result`.
#[derive(Default)]
pub struct CursorParser {
    finished: bool,
}

impl LineParser for CursorParser {
    fn parse_line(&mut self, line: &str) -> Vec<AgentEvent> {
        let Ok(event) = serde_json::from_str::<Value>(line) else {
            return vec![AgentEvent::Notice(line.to_string())];
        };
        let subtype = text_of(&event, "subtype").unwrap_or("");
        let mut out = Vec::new();
        match text_of(&event, "type").unwrap_or("") {
            "system" if subtype == "init" => {
                if let Some(id) = text_of(&event, "session_id") {
                    out.push(AgentEvent::SessionStarted {
                        session_id: id.to_string(),
                        model: text_of(&event, "model").map(str::to_string),
                    });
                }
            }
            "assistant" => {
                let text: String = event
                    .pointer("/message/content")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter(|block| text_of(block, "type") == Some("text"))
                    .filter_map(|block| text_of(block, "text"))
                    .collect();
                if !text.trim().is_empty() {
                    out.push(AgentEvent::Text(text.trim().to_string()));
                }
            }
            "tool_call" => {
                // The call is an object with one key that names the tool, such
                // as `readToolCall`, holding the arguments and, once complete,
                // the result.
                let call = event.get("tool_call").and_then(Value::as_object);
                let Some((key, body)) = call.and_then(|c| {
                    c.iter().find(|(key, _)| key.ends_with("ToolCall"))
                }) else {
                    return out;
                };
                let name = key.trim_end_matches("ToolCall");
                if subtype == "started" {
                    out.extend(tool_events(name, body.get("args")));
                } else if subtype == "completed" {
                    let rejected = body.pointer("/result/rejected").is_some()
                        || body
                            .pointer("/result/error/errorMessage")
                            .and_then(Value::as_str)
                            .is_some_and(|m| {
                                m.to_lowercase().contains("reject")
                            });
                    if rejected {
                        out.push(AgentEvent::PermissionDenied {
                            tool: tool_title(name),
                        });
                    }
                }
            }
            "result" => {
                self.finished = true;
                let usage = event.get("usage").unwrap_or(&Value::Null);
                let input = number_of(usage, "inputTokens").map(|n| {
                    n + number_of(usage, "cacheReadTokens").unwrap_or(0)
                        + number_of(usage, "cacheWriteTokens").unwrap_or(0)
                });
                out.push(AgentEvent::Usage {
                    cost_usd: None,
                    input_tokens: input,
                    output_tokens: number_of(usage, "outputTokens"),
                });
                let failed = event
                    .get("is_error")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let error = failed.then(|| {
                    text_of(&event, "result")
                        .filter(|s| !s.is_empty())
                        .unwrap_or("Cursor Agent reported an error.")
                        .to_string()
                });
                out.push(AgentEvent::Finished { error });
            }
            _ => {}
        }
        out
    }

    fn finished(&self) -> bool {
        self.finished
    }
}

// ----------------------------------------------------------------------------
// Pi

/// `pi -p --mode json`. The stream is a `session` line, then for each message a
/// `message_start`, updates, and a `message_end` with the whole message and its
/// token counts, with `tool_execution_start` lines between, and `agent_end`
/// last.
#[derive(Default)]
pub struct PiParser {
    finished: bool,
    session_reported: bool,
    session_id: Option<String>,
}

impl LineParser for PiParser {
    fn parse_line(&mut self, line: &str) -> Vec<AgentEvent> {
        let Ok(event) = serde_json::from_str::<Value>(line) else {
            return vec![AgentEvent::Notice(line.to_string())];
        };
        let mut out = Vec::new();
        match text_of(&event, "type").unwrap_or("") {
            "session" => {
                self.session_id = text_of(&event, "id").map(str::to_string)
            }
            "message_start" => {
                // The model is only known once the first assistant message
                // starts, so the session is reported then, with both.
                let message = event.get("message").unwrap_or(&Value::Null);
                if text_of(message, "role") == Some("assistant")
                    && !self.session_reported
                {
                    if let Some(id) = self.session_id.clone() {
                        self.session_reported = true;
                        let model =
                            text_of(message, "model").map(
                                |model| match text_of(message, "provider") {
                                    Some(provider) => {
                                        format!("{provider}/{model}")
                                    }
                                    None => model.to_string(),
                                },
                            );
                        out.push(AgentEvent::SessionStarted {
                            session_id: id,
                            model,
                        });
                    }
                }
            }
            "message_end" => {
                let message = event.get("message").unwrap_or(&Value::Null);
                if text_of(message, "role") == Some("assistant") {
                    let text: String = message
                        .get("content")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                        .filter(|block| text_of(block, "type") == Some("text"))
                        .filter_map(|block| text_of(block, "text"))
                        .collect::<Vec<_>>()
                        .join("\n");
                    if !text.trim().is_empty() {
                        out.push(AgentEvent::Text(text.trim().to_string()));
                    }
                    if let Some(usage) = message.get("usage") {
                        let cost = usage
                            .pointer("/cost/total")
                            .and_then(Value::as_f64)
                            .filter(|c| *c > 0.0);
                        let input = number_of(usage, "input").map(|n| {
                            n + number_of(usage, "cacheRead").unwrap_or(0)
                                + number_of(usage, "cacheWrite").unwrap_or(0)
                        });
                        out.push(AgentEvent::Usage {
                            cost_usd: cost,
                            input_tokens: input,
                            output_tokens: number_of(usage, "output"),
                        });
                    }
                    if text_of(message, "stopReason") == Some("error") {
                        self.finished = true;
                        out.push(AgentEvent::Finished {
                            error: Some(
                                text_of(message, "errorMessage")
                                    .unwrap_or("Pi reported an error.")
                                    .to_string(),
                            ),
                        });
                    }
                }
            }
            "tool_execution_start" => out.extend(tool_events(
                text_of(&event, "toolName").unwrap_or("tool"),
                event.get("args"),
            )),
            "agent_end" if !self.finished => {
                self.finished = true;
                out.push(AgentEvent::Finished { error: None });
            }
            _ => {}
        }
        out
    }

    fn finished(&self) -> bool {
        self.finished
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn parse(
        mut parser: impl LineParser,
        lines: &[&str],
    ) -> (Vec<AgentEvent>, bool) {
        let events = lines
            .iter()
            .flat_map(|line| parser.parse_line(line))
            .collect();
        (events, parser.finished())
    }

    #[test]
    fn codex_items_become_tools_writes_text_and_a_finish() {
        let (events, finished) = parse(
            CodexParser::default(),
            &[
                r#"{"type":"thread.started","thread_id":"t-1"}"#,
                r#"{"type":"turn.started"}"#,
                r#"{"type":"item.started","item":{"id":"i1","type":"command_execution","command":"bash -lc 'cat src/a.go'","status":"in_progress"}}"#,
                r#"{"type":"item.completed","item":{"id":"i1","type":"command_execution","command":"bash -lc 'cat src/a.go'","exit_code":0}}"#,
                r#"{"type":"item.completed","item":{"id":"i2","type":"file_change","changes":[{"path":".codjiva/artifacts/a/v1/model.json","kind":"add"}],"status":"completed"}}"#,
                r#"{"type":"item.completed","item":{"id":"i3","type":"reasoning","text":"thinking"}}"#,
                r#"{"type":"item.completed","item":{"id":"i4","type":"agent_message","text":" Done. "}}"#,
                r#"{"type":"turn.completed","usage":{"input_tokens":900,"cached_input_tokens":500,"output_tokens":40}}"#,
            ],
        );
        assert!(finished);
        assert_eq!(
            events,
            vec![
                AgentEvent::SessionStarted {
                    session_id: "t-1".into(),
                    model: None
                },
                AgentEvent::ToolUse {
                    name: "Shell".into(),
                    summary: "bash -lc 'cat src/a.go'".into()
                },
                AgentEvent::FileWritten(
                    ".codjiva/artifacts/a/v1/model.json".into()
                ),
                AgentEvent::ToolUse {
                    name: "Write".into(),
                    summary: ".codjiva/artifacts/a/v1/model.json".into()
                },
                AgentEvent::Text("Done.".into()),
                AgentEvent::Usage {
                    cost_usd: None,
                    input_tokens: Some(900),
                    output_tokens: Some(40)
                },
                AgentEvent::Finished { error: None },
            ]
        );
        let (events, finished) = parse(
            CodexParser::default(),
            &[
                r#"{"type":"turn.failed","error":{"message":"You are not signed in."}}"#,
            ],
        );
        assert_eq!(
            (events, finished),
            (
                vec![AgentEvent::Finished {
                    error: Some("You are not signed in.".into())
                }],
                true
            )
        );
    }

    #[test]
    fn gemini_messages_tools_and_the_result_are_reported() {
        let (events, finished) = parse(
            GeminiParser::default(),
            &[
                "Ripgrep is not available. Falling back to GrepTool.",
                "    at Object.run (file:///x.js:1:1)",
                r#"{"type":"init","timestamp":"t","session_id":"g-1","model":"gemini-3-flash-preview"}"#,
                r#"{"type":"message","role":"user","content":"Do it."}"#,
                r#"{"type":"message","role":"assistant","content":"I will read ","delta":true}"#,
                r#"{"type":"message","role":"assistant","content":"the file.","delta":true}"#,
                r#"{"type":"tool_use","tool_name":"read_file","tool_id":"r1","parameters":{"file_path":"src/a.go"}}"#,
                r#"{"type":"tool_result","tool_id":"r1","status":"success","output":"package a"}"#,
                r#"{"type":"tool_use","tool_name":"write_file","tool_id":"w1","parameters":{"file_path":".codjiva/artifacts/a/v1/model.json","content":"{}"}}"#,
                r#"{"type":"tool_use","tool_name":"write_file","tool_id":"w2","parameters":{"file_path":"src/a.go","content":"x"}}"#,
                r#"{"type":"tool_result","tool_id":"w2","status":"error","error":{"message":"Tool execution denied by policy."}}"#,
                r#"{"type":"message","role":"assistant","content":"Done."}"#,
                r#"{"type":"result","status":"success","stats":{"total_tokens":1200,"input_tokens":1100,"output_tokens":100,"duration_ms":900,"tool_calls":3}}"#,
            ],
        );
        assert!(finished);
        assert_eq!(
            events,
            vec![
                AgentEvent::Notice(
                    "Ripgrep is not available. Falling back to GrepTool."
                        .into()
                ),
                AgentEvent::SessionStarted {
                    session_id: "g-1".into(),
                    model: Some("gemini-3-flash-preview".into())
                },
                AgentEvent::Text("I will read the file.".into()),
                AgentEvent::ToolUse {
                    name: "Read_file".into(),
                    summary: "src/a.go".into()
                },
                AgentEvent::FileWritten(
                    ".codjiva/artifacts/a/v1/model.json".into()
                ),
                AgentEvent::ToolUse {
                    name: "Write_file".into(),
                    summary: ".codjiva/artifacts/a/v1/model.json".into()
                },
                AgentEvent::FileWritten("src/a.go".into()),
                AgentEvent::ToolUse {
                    name: "Write_file".into(),
                    summary: "src/a.go".into()
                },
                AgentEvent::PermissionDenied {
                    tool: "a tool".into()
                },
                AgentEvent::Text("Done.".into()),
                AgentEvent::Usage {
                    cost_usd: None,
                    input_tokens: Some(1100),
                    output_tokens: Some(100)
                },
                AgentEvent::Finished { error: None },
            ]
        );
    }

    /// The exact lines Gemini CLI 0.49 printed on this project's test machine
    /// when its API key was not valid.
    #[test]
    fn a_gemini_api_failure_is_reduced_to_the_sentence_a_person_can_read() {
        let result = r#"{"type":"result","timestamp":"2026-11-14T11:52:57.517Z","status":"error","error":{"type":"unknown","message":"[API Error: {\"error\":{\"message\":\"{\\n  \\\"error\\\": {\\n    \\\"code\\\": 400,\\n    \\\"message\\\": \\\"API key not valid. Please pass a valid API key.\\\",\\n    \\\"status\\\": \\\"INVALID_ARGUMENT\\\"\\n  }\\n}\\n\",\"code\":400,\"status\":\"\"}}]"},"stats":{"total_tokens":0,"input_tokens":0,"output_tokens":0}}"#;
        let (events, finished) = parse(GeminiParser::default(), &[result]);
        assert!(finished);
        assert_eq!(
            events.last(),
            Some(&AgentEvent::Finished {
                error: Some(
                    "API key not valid. Please pass a valid API key.".into()
                )
            })
        );
        assert_eq!(api_error_message("plain words"), "plain words");
    }

    /// Lines in the shapes Cursor Agent 2026.10.16 printed on this project's
    /// test machine.
    #[test]
    fn cursor_tool_calls_messages_and_the_result_are_reported() {
        let (events, finished) = parse(
            CursorParser::default(),
            &[
                r#"{"type":"system","subtype":"init","apiKeySource":"login","cwd":"/ws","session_id":"c-1","model":"Auto","permissionMode":"default"}"#,
                r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Do it."}]},"session_id":"c-1"}"#,
                r#"{"type":"thinking","subtype":"delta","text":"The","session_id":"c-1"}"#,
                r#"{"type":"thinking","subtype":"completed","session_id":"c-1"}"#,
                r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I'll read the file."}]},"session_id":"c-1"}"#,
                r#"{"type":"tool_call","subtype":"started","call_id":"x","tool_call":{"readToolCall":{"args":{"path":"/ws/src/a.go"}},"hookAdditionalContexts":[],"toolCallId":"x"}}"#,
                r#"{"type":"tool_call","subtype":"completed","call_id":"x","tool_call":{"readToolCall":{"args":{"path":"/ws/src/a.go"},"result":{"success":{"content":"package a"}}}}}"#,
                r#"{"type":"tool_call","subtype":"started","call_id":"y","tool_call":{"editToolCall":{"args":{"path":"/ws/.codjiva/artifacts/a/v1/model.json","streamContent":"{}"}}}}"#,
                r#"{"type":"tool_call","subtype":"started","call_id":"z","tool_call":{"shellToolCall":{"args":{"command":"mkdir -p out && ls -la","workingDirectory":""}}}}"#,
                r#"{"type":"tool_call","subtype":"completed","call_id":"z","tool_call":{"shellToolCall":{"args":{"command":"mkdir -p out && ls -la"},"result":{"rejected":{"command":"mkdir -p out && ls -la","reason":""}}}}}"#,
                r#"{"type":"result","subtype":"success","duration_ms":13006,"is_error":false,"result":"done","session_id":"c-1","usage":{"inputTokens":8564,"outputTokens":307,"cacheReadTokens":1000,"cacheWriteTokens":0}}"#,
            ],
        );
        assert!(finished);
        assert_eq!(
            events,
            vec![
                AgentEvent::SessionStarted {
                    session_id: "c-1".into(),
                    model: Some("Auto".into())
                },
                AgentEvent::Text("I'll read the file.".into()),
                AgentEvent::ToolUse {
                    name: "Read".into(),
                    summary: "/ws/src/a.go".into()
                },
                AgentEvent::FileWritten(
                    "/ws/.codjiva/artifacts/a/v1/model.json".into()
                ),
                AgentEvent::ToolUse {
                    name: "Edit".into(),
                    summary: "/ws/.codjiva/artifacts/a/v1/model.json".into()
                },
                AgentEvent::ToolUse {
                    name: "Shell".into(),
                    summary: "mkdir -p out && ls -la".into()
                },
                AgentEvent::PermissionDenied {
                    tool: "Shell".into()
                },
                AgentEvent::Usage {
                    cost_usd: None,
                    input_tokens: Some(9564),
                    output_tokens: Some(307)
                },
                AgentEvent::Finished { error: None },
            ]
        );
        let (events, _) = parse(
            CursorParser::default(),
            &[
                r#"{"type":"result","subtype":"error","is_error":true,"result":"Not logged in."}"#,
            ],
        );
        assert_eq!(
            events.last(),
            Some(&AgentEvent::Finished {
                error: Some("Not logged in.".into())
            })
        );
    }

    #[test]
    fn pi_messages_tools_cost_and_the_end_are_reported() {
        let (events, finished) = parse(
            PiParser::default(),
            &[
                r#"{"type":"session","version":3,"id":"p-1","cwd":"/ws"}"#,
                r#"{"type":"agent_start"}"#,
                r#"{"type":"message_start","message":{"role":"user","content":[{"type":"text","text":"Do it."}]}}"#,
                r#"{"type":"message_start","message":{"role":"assistant","content":[],"provider":"anthropic","model":"claude-sonnet-5-5"}}"#,
                r#"{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"Read"}}"#,
                r#"{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Reading the file."},{"type":"toolCall","name":"read"}],"usage":{"input":10,"output":20,"cacheRead":90,"cacheWrite":0,"cost":{"total":0.012}},"stopReason":"toolUse"}}"#,
                r#"{"type":"tool_execution_start","toolCallId":"t1","toolName":"read","args":{"path":"src/a.go"}}"#,
                r#"{"type":"tool_execution_end","toolCallId":"t1","toolName":"read","isError":false}"#,
                r#"{"type":"tool_execution_start","toolCallId":"t2","toolName":"write","args":{"path":".codjiva/artifacts/a/v1/model.json","content":"{}"}}"#,
                r#"{"type":"message_start","message":{"role":"assistant","content":[],"provider":"anthropic","model":"claude-sonnet-5-5"}}"#,
                r#"{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Done."}],"usage":{"input":5,"output":3,"cost":{"total":0.001}},"stopReason":"stop"}}"#,
                r#"{"type":"agent_end","messages":[]}"#,
            ],
        );
        assert!(finished);
        assert_eq!(
            events,
            vec![
                AgentEvent::SessionStarted {
                    session_id: "p-1".into(),
                    model: Some("anthropic/claude-sonnet-5-5".into())
                },
                AgentEvent::Text("Reading the file.".into()),
                AgentEvent::Usage {
                    cost_usd: Some(0.012),
                    input_tokens: Some(100),
                    output_tokens: Some(20)
                },
                AgentEvent::ToolUse {
                    name: "Read".into(),
                    summary: "src/a.go".into()
                },
                AgentEvent::FileWritten(
                    ".codjiva/artifacts/a/v1/model.json".into()
                ),
                AgentEvent::ToolUse {
                    name: "Write".into(),
                    summary: ".codjiva/artifacts/a/v1/model.json".into()
                },
                AgentEvent::Text("Done.".into()),
                AgentEvent::Usage {
                    cost_usd: Some(0.001),
                    input_tokens: Some(5),
                    output_tokens: Some(3)
                },
                AgentEvent::Finished { error: None },
            ]
        );
    }

    #[test]
    fn a_long_path_is_shown_whole_and_only_a_very_long_command_is_cut() {
        // A path of 150 characters, as an agent gives it: absolute, deep
        // inside the workspace.
        let path = format!("/ws/{}/handler.go", "internal/orders".repeat(9));
        assert!(path.chars().count() > 140);
        let events = tool_events("write", Some(&json!({ "path": path })));
        assert_eq!(
            events,
            vec![
                AgentEvent::FileWritten(path.clone()),
                AgentEvent::ToolUse {
                    name: "Write".into(),
                    summary: path.clone(),
                },
            ]
        );

        // A command of several lines is written on one line and not cut.
        let command = format!(
            "nl -ba {path}\n  nl -ba {}",
            "internal/store/store.go".repeat(8)
        );
        let (events, _) = parse(
            CodexParser::default(),
            &[&json!({
                "type": "item.started",
                "item": { "type": "command_execution", "command": command }
            })
            .to_string()],
        );
        let AgentEvent::ToolUse { summary, .. } = &events[0] else {
            panic!("{events:?}")
        };
        assert_eq!(
            summary,
            &command.split_whitespace().collect::<Vec<_>>().join(" ")
        );

        // A command longer than the limit is cut at the limit.
        let long = "x".repeat(COMMAND_LIMIT + 50);
        let cut = shorten(&long);
        assert_eq!(cut.chars().count(), COMMAND_LIMIT + 1);
        assert!(cut.ends_with('…'));
    }

    #[test]
    fn a_line_that_is_not_json_is_a_notice_from_the_program() {
        for mut parser in [
            Box::new(CodexParser::default()) as Box<dyn LineParser>,
            Box::new(CursorParser::default()),
            Box::new(PiParser::default()),
        ] {
            assert_eq!(
                parser.parse_line("warning: something"),
                vec![AgentEvent::Notice("warning: something".into())]
            );
            assert!(!parser.finished());
        }
    }
}
