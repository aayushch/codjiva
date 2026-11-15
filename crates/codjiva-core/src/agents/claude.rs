//! Reads the output of Claude Code's non-interactive mode (`--output-format
//! stream-json`).
//!
//! The program prints one JSON object per line. The ones that matter here:
//!
//!   - `{"type":"system","subtype":"init","session_id":...,"model":...}`: the
//!     session started.
//!   - `{"type":"system","subtype":"permission_denied",...}`: a tool call was
//!     refused.
//!   - `{"type":"assistant","message":{"content":[ blocks ]}}`: text and tool
//!     calls.
//!   - `{"type":"result","subtype":"success","is_error":false,
//!     "total_cost_usd":...,"usage":{...}}`

use crate::agents::{AgentEvent, LineParser};
use serde_json::Value;

#[derive(Default)]
pub struct ClaudeStreamParser {
    finished: bool,
}

/// Describes a tool call in a few words for the job log: the file or pattern it
/// works on.
fn summarise_tool(name: &str, input: &Value) -> String {
    let text = |key: &str| input.get(key).and_then(Value::as_str).unwrap_or("");
    match name {
        "Read" => match (
            input.get("offset").and_then(Value::as_u64),
            input.get("limit").and_then(Value::as_u64),
        ) {
            (Some(offset), Some(limit)) => format!(
                "{} (lines {}–{})",
                text("file_path"),
                offset,
                offset + limit
            ),
            _ => text("file_path").to_string(),
        },
        "Write" | "Edit" | "MultiEdit" | "NotebookEdit" => {
            text("file_path").to_string()
        }
        "Glob" => text("pattern").to_string(),
        "Grep" => match text("path") {
            "" => text("pattern").to_string(),
            path => format!("{} in {}", text("pattern"), path),
        },
        _ => String::new(),
    }
}

impl LineParser for ClaudeStreamParser {
    fn parse_line(&mut self, line: &str) -> Vec<AgentEvent> {
        let Ok(event) = serde_json::from_str::<Value>(line) else {
            // Anything that is not JSON is a message from the program itself,
            // such as a warning.
            return vec![AgentEvent::Notice(line.to_string())];
        };
        let kind = event.get("type").and_then(Value::as_str).unwrap_or("");
        let subtype =
            event.get("subtype").and_then(Value::as_str).unwrap_or("");
        let mut out = Vec::new();
        match (kind, subtype) {
            ("system", "init") => {
                if let Some(id) =
                    event.get("session_id").and_then(Value::as_str)
                {
                    out.push(AgentEvent::SessionStarted {
                        session_id: id.to_string(),
                        model: event
                            .get("model")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                    });
                }
            }
            ("system", "permission_denied") => {
                let tool = event
                    .get("tool_name")
                    .and_then(Value::as_str)
                    .unwrap_or("a tool")
                    .to_string();
                out.push(AgentEvent::PermissionDenied { tool });
            }
            ("assistant", _) => {
                for block in event
                    .pointer("/message/content")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    match block.get("type").and_then(Value::as_str) {
                        Some("text") => {
                            let text = block
                                .get("text")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .trim();
                            if !text.is_empty() {
                                out.push(AgentEvent::Text(text.to_string()));
                            }
                        }
                        Some("tool_use") => {
                            let name = block
                                .get("name")
                                .and_then(Value::as_str)
                                .unwrap_or("tool")
                                .to_string();
                            let input = block
                                .get("input")
                                .cloned()
                                .unwrap_or(Value::Null);
                            if matches!(
                                name.as_str(),
                                "Write" | "Edit" | "MultiEdit"
                            ) {
                                if let Some(path) = input
                                    .get("file_path")
                                    .and_then(Value::as_str)
                                {
                                    out.push(AgentEvent::FileWritten(
                                        path.to_string(),
                                    ));
                                }
                            }
                            out.push(AgentEvent::ToolUse {
                                summary: summarise_tool(&name, &input),
                                name,
                            });
                        }
                        _ => {}
                    }
                }
            }
            ("result", _) => {
                self.finished = true;
                let usage = event.get("usage");
                let tokens = |key: &str| {
                    usage
                        .and_then(|u| u.get(key))
                        .and_then(Value::as_u64)
                        .unwrap_or(0)
                };
                // `total_cost_usd` is the cost of the whole session, which for
                // a continued session includes the turns before this one.
                // `model_usage_since_last_result` holds the cost of this turn
                // alone, per model, and is used when it is present.
                let this_turn = event
                    .get("model_usage_since_last_result")
                    .and_then(Value::as_object)
                    .filter(|models| !models.is_empty())
                    .map(|models| {
                        models
                            .values()
                            .filter_map(|usage| {
                                usage.get("costUSD").and_then(Value::as_f64)
                            })
                            .sum::<f64>()
                    });
                out.push(AgentEvent::Usage {
                    cost_usd: this_turn.or_else(|| {
                        event.get("total_cost_usd").and_then(Value::as_f64)
                    }),
                    // Tokens read from or written to the prompt cache are input
                    // tokens too.
                    input_tokens: Some(
                        tokens("input_tokens")
                            + tokens("cache_creation_input_tokens")
                            + tokens("cache_read_input_tokens"),
                    ),
                    output_tokens: Some(tokens("output_tokens")),
                });
                let failed = event
                    .get("is_error")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                    || subtype != "success";
                let error = failed.then(|| {
                    let said = event
                        .get("result")
                        .and_then(Value::as_str)
                        .filter(|s| !s.is_empty());
                    said.map(str::to_string).unwrap_or_else(|| {
                        format!("The agent stopped early ({subtype}).")
                    })
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

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(lines: &[&str]) -> Vec<AgentEvent> {
        let mut parser = ClaudeStreamParser::default();
        lines.iter().flat_map(|l| parser.parse_line(l)).collect()
    }

    #[test]
    fn a_continued_session_reports_the_cost_of_its_last_turn_only() {
        let events = parse(&[
            r#"{"type":"result","subtype":"success","is_error":false,"result":"Done.","session_id":"s-1","total_cost_usd":1.04,"usage":{"input_tokens":8,"output_tokens":1456},"model_usage_since_last_result":{"model-a":{"costUSD":0.05},"model-b":{"costUSD":0.02}}}"#,
        ]);
        let Some(AgentEvent::Usage {
            cost_usd: Some(cost),
            ..
        }) = events.first()
        else {
            panic!("{events:?}")
        };
        assert!((cost - 0.07).abs() < 1e-9, "{cost}");
    }

    #[test]
    fn a_whole_turn_becomes_session_tools_text_usage_and_finish() {
        let events = parse(&[
            r#"{"type":"system","subtype":"init","session_id":"s-1","model":"claude-sonnet-5-5","tools":["Read"]}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"src/a.go"}}]}}"#,
            r#"{"type":"user","message":{"content":[{"type":"tool_result","content":"..."}]}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"..."},{"type":"tool_use","name":"Write","input":{"file_path":".codjiva/artifacts/a/v1/model.json","content":"{}"}}]}}"#,
            r#"{"type":"rate_limit_event","rate_limit_info":{}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":" Done. "}]}}"#,
            r#"{"type":"result","subtype":"success","is_error":false,"result":"Done.","session_id":"s-1","total_cost_usd":0.25,"usage":{"input_tokens":10,"cache_read_input_tokens":90,"output_tokens":40}}"#,
        ]);
        assert_eq!(
            events,
            vec![
                AgentEvent::SessionStarted {
                    session_id: "s-1".into(),
                    model: Some("claude-sonnet-5-5".into())
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
                    cost_usd: Some(0.25),
                    input_tokens: Some(100),
                    output_tokens: Some(40)
                },
                AgentEvent::Finished { error: None },
            ]
        );
    }

    #[test]
    fn an_error_result_carries_what_the_agent_said() {
        let events = parse(&[
            r#"{"type":"result","subtype":"success","is_error":true,"result":"Not logged in · Please run /login"}"#,
        ]);
        assert_eq!(
            events.last(),
            Some(&AgentEvent::Finished {
                error: Some("Not logged in · Please run /login".into())
            })
        );
        let events = parse(&[
            r#"{"type":"result","subtype":"error_max_turns","is_error":false}"#,
        ]);
        assert_eq!(
            events.last(),
            Some(&AgentEvent::Finished {
                error: Some(
                    "The agent stopped early (error_max_turns).".into()
                )
            })
        );
    }

    #[test]
    fn a_denied_tool_call_and_a_plain_text_line_are_reported() {
        let events = parse(&[
            r#"{"type":"system","subtype":"permission_denied","tool_name":"Write"}"#,
            "Warning: something odd",
        ]);
        assert_eq!(
            events,
            vec![
                AgentEvent::PermissionDenied {
                    tool: "Write".into()
                },
                AgentEvent::Notice("Warning: something odd".into())
            ]
        );
    }

    #[test]
    fn tool_summaries_name_the_file_or_pattern() {
        let read = serde_json::json!({
            "file_path": "a.cpp",
            "offset": 180,
            "limit": 240
        });
        assert_eq!(summarise_tool("Read", &read), "a.cpp (lines 180–420)");
        assert_eq!(
            summarise_tool(
                "Grep",
                &serde_json::json!({"pattern": "flush", "path": "src"})
            ),
            "flush in src"
        );
        assert_eq!(
            summarise_tool("Glob", &serde_json::json!({"pattern": "**/*.h"})),
            "**/*.h"
        );
    }
}
