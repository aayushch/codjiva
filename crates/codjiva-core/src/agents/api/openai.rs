//! The OpenAI provider, which also serves any endpoint that speaks the same
//! Chat Completions format: OpenRouter, Azure OpenAI, and local servers such as
//! Ollama and LM Studio.

use crate::agents::api::provider::{
    connection_failure, http_failure, retry_after, with_retries, Attempt,
    Conversation, Price, Provider, Reply, SseReader, StopReason, ToolCall,
    Usage, UserPart,
};
use crate::agents::api::tools::ToolSpec;
use crate::error::{AppError, Result};
use crate::settings::Effort;
use async_trait::async_trait;
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

pub const DEFAULT_BASE_URL: &str = "https://api.openai.com/v1";

const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const READ_TIMEOUT: Duration = Duration::from_secs(300);

pub struct OpenAi {
    client: reqwest::Client,
    /// The name used in messages to the user: "OpenAI", or the host of a custom
    /// endpoint.
    label: String,
    base_url: String,
    /// Empty for local servers that need no key.
    api_key: String,
    model: String,
}

impl OpenAi {
    pub fn new(
        label: &str,
        api_key: String,
        model: String,
        base_url: Option<String>,
    ) -> Result<OpenAi> {
        let client = reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .read_timeout(READ_TIMEOUT)
            .build()
            .map_err(|e| {
                AppError::new(
                    "http_client",
                    "The network client could not be set up.",
                )
                .with_detail(e)
            })?;
        let base_url = base_url
            .filter(|u| !u.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_BASE_URL.to_string())
            .trim_end_matches('/')
            .to_string();
        Ok(OpenAi {
            client,
            label: label.to_string(),
            base_url,
            api_key,
            model,
        })
    }
}

impl Provider for OpenAi {
    fn start(
        &self,
        system: String,
        tools: Vec<ToolSpec>,
        _effort: Option<Effort>,
    ) -> Box<dyn Conversation> {
        Box::new(OpenAiConversation {
            client: self.client.clone(),
            label: self.label.clone(),
            url: format!("{}/chat/completions", self.base_url),
            api_key: self.api_key.clone(),
            model: self.model.clone(),
            tools,
            messages: vec![json!({ "role": "system", "content": system })],
            ask_for_usage: AtomicBool::new(true),
        })
    }

    /// Prices differ by model and by endpoint and are not known to the app, so
    /// no cost is shown.
    fn price(&self) -> Option<Price> {
        None
    }
}

struct OpenAiConversation {
    client: reqwest::Client,
    label: String,
    url: String,
    api_key: String,
    model: String,
    tools: Vec<ToolSpec>,
    /// The transcript in the Chat Completions format, starting with the system
    /// message.
    messages: Vec<Value>,
    /// Whether to ask for token counts at the end of the stream. Some
    /// compatible servers reject the option; it is switched off for the rest of
    /// the conversation when one does.
    ask_for_usage: AtomicBool,
}

/// One tool call as it builds up from fragments of a stream.
#[derive(Default, Clone)]
struct PartialCall {
    id: String,
    name: String,
    arguments: String,
}

impl OpenAiConversation {
    fn body(&self, messages: &[Value]) -> Value {
        let tools: Vec<Value> = self
            .tools
            .iter()
            .map(|t| {
                json!({
                    "type": "function",
                    "function": {
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.input_schema
                    }
                })
            })
            .collect();
        let mut body = json!({
            "model": self.model,
            "messages": messages,
            "stream": true
        });
        // The API rejects an empty list of tools.
        if !tools.is_empty() {
            body["tools"] = json!(tools);
        }
        if self.ask_for_usage.load(Ordering::SeqCst) {
            body["stream_options"] = json!({ "include_usage": true });
        }
        body
    }

    async fn request_once(
        &self,
        messages: &[Value],
    ) -> std::result::Result<(Value, Reply), Attempt> {
        let mut request = self
            .client
            .post(&self.url)
            .header("content-type", "application/json");
        if !self.api_key.is_empty() {
            request = request.bearer_auth(&self.api_key);
        }
        let response = request
            .json(&self.body(messages))
            .send()
            .await
            .map_err(|e| connection_failure(&self.label, e))?;
        let status = response.status().as_u16();
        if status != 200 {
            let wait = retry_after(response.headers());
            let text = response.text().await.unwrap_or_default();
            let said = serde_json::from_str::<Value>(&text)
                .ok()
                .and_then(|v| {
                    v.pointer("/error/message")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .unwrap_or(text);
            if status == 400
                && said.contains("stream_options")
                && self.ask_for_usage.swap(false, Ordering::SeqCst)
            {
                let mut again = http_failure(
                    &self.label,
                    status,
                    &said,
                    Some(Duration::ZERO),
                );
                again.retryable = true;
                return Err(again);
            }
            return Err(http_failure(&self.label, status, &said, wait));
        }

        let mut text = String::new();
        let mut calls: Vec<PartialCall> = Vec::new();
        let mut finish: Option<String> = None;
        let mut refusal = String::new();
        let mut usage = Usage::default();
        let mut model: Option<String> = None;
        let mut reader = SseReader::default();
        let mut stream = response.bytes_stream();
        let mut done = false;
        while let Some(chunk) = stream.next().await {
            let bytes =
                chunk.map_err(|e| connection_failure(&self.label, e))?;
            for data in reader.push(&bytes) {
                if data.trim() == "[DONE]" {
                    done = true;
                    continue;
                }
                let Ok(event) = serde_json::from_str::<Value>(&data) else {
                    continue;
                };
                if let Some(said) =
                    event.pointer("/error/message").and_then(Value::as_str)
                {
                    return Err(http_failure(&self.label, 500, said, None));
                }
                if let Some(name) = event.get("model").and_then(Value::as_str) {
                    model = Some(name.to_string());
                }
                if let Some(counts) =
                    event.get("usage").filter(|u| u.is_object())
                {
                    let cached = counts
                        .pointer("/prompt_tokens_details/cached_tokens")
                        .and_then(Value::as_u64)
                        .unwrap_or(0);
                    usage.cache_read_tokens = cached;
                    usage.input_tokens = counts
                        .get("prompt_tokens")
                        .and_then(Value::as_u64)
                        .unwrap_or(0)
                        .saturating_sub(cached);
                    usage.output_tokens = counts
                        .get("completion_tokens")
                        .and_then(Value::as_u64)
                        .unwrap_or(0);
                }
                let Some(choice) = event.pointer("/choices/0") else {
                    continue;
                };
                if let Some(reason) =
                    choice.get("finish_reason").and_then(Value::as_str)
                {
                    finish = Some(reason.to_string());
                }
                let Some(delta) = choice.get("delta") else {
                    continue;
                };
                if let Some(piece) =
                    delta.get("content").and_then(Value::as_str)
                {
                    text.push_str(piece);
                }
                if let Some(piece) =
                    delta.get("refusal").and_then(Value::as_str)
                {
                    refusal.push_str(piece);
                }
                // A tool call arrives as fragments that share an index: the id
                // and name come first, then the arguments text in pieces.
                for fragment in delta
                    .get("tool_calls")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    let index = fragment
                        .get("index")
                        .and_then(Value::as_u64)
                        .unwrap_or(calls.len() as u64)
                        as usize;
                    if calls.len() <= index {
                        calls.resize(index + 1, PartialCall::default());
                    }
                    if let Some(id) = fragment
                        .get("id")
                        .and_then(Value::as_str)
                        .filter(|s| !s.is_empty())
                    {
                        calls[index].id = id.to_string();
                    }
                    if let Some(name) = fragment
                        .pointer("/function/name")
                        .and_then(Value::as_str)
                    {
                        calls[index].name.push_str(name);
                    }
                    if let Some(arguments) = fragment
                        .pointer("/function/arguments")
                        .and_then(Value::as_str)
                    {
                        calls[index].arguments.push_str(arguments);
                    }
                }
            }
        }
        // Some compatible servers close the stream without the final marker, so
        // a stream that named its finish reason also counts as complete.
        if !done && finish.is_none() {
            return Err(connection_failure(
                &self.label,
                "the reply ended before it was complete",
            ));
        }

        let calls: Vec<PartialCall> = calls
            .into_iter()
            .filter(|c| !c.name.is_empty())
            .enumerate()
            .map(|(i, mut c)| {
                if c.id.is_empty() {
                    c.id = format!("call_{i}");
                }
                c
            })
            .collect();
        let tool_calls: Vec<ToolCall> = calls
            .iter()
            .map(|c| ToolCall {
                id: c.id.clone(),
                name: c.name.clone(),
                input: if c.arguments.trim().is_empty() {
                    Ok(json!({}))
                } else {
                    serde_json::from_str::<Value>(&c.arguments)
                        .ok()
                        .filter(Value::is_object)
                        .ok_or_else(|| c.arguments.clone())
                },
            })
            .collect();
        let stop = match finish.as_deref() {
            _ if !refusal.is_empty() => StopReason::Refusal(refusal.clone()),
            Some("content_filter") => StopReason::Refusal(
                "The provider's content filter stopped the reply.".into(),
            ),
            Some("length") => StopReason::MaxTokens,
            _ if !tool_calls.is_empty() => StopReason::ToolUse,
            Some("stop") | None => StopReason::EndTurn,
            Some(other) => StopReason::Other(other.to_string()),
        };
        let mut assistant = json!({
            "role": "assistant",
            "content": if text.is_empty() {
                Value::Null
            } else {
                Value::String(text.clone())
            }
        });
        if !calls.is_empty() {
            // The transcript must hold valid JSON arguments even when the
            // model's were not.
            assistant["tool_calls"] = calls
                .iter()
                .zip(&tool_calls)
                .map(|(c, parsed)| {
                    json!({
                        "id": c.id,
                        "type": "function",
                        "function": {
                            "name": c.name,
                            "arguments": if parsed.input.is_ok()
                                && !c.arguments.trim().is_empty()
                            {
                                c.arguments.clone()
                            } else {
                                "{}".to_string()
                            }
                        },
                    })
                })
                .collect();
        }
        Ok((
            assistant,
            Reply {
                text: text.trim().to_string(),
                tool_calls,
                stop,
                usage,
                model,
            },
        ))
    }
}

#[async_trait]
impl Conversation for OpenAiConversation {
    async fn send(
        &mut self,
        input: Vec<UserPart>,
        cancel: &CancellationToken,
    ) -> Result<Reply> {
        let mut messages = self.messages.clone();
        // Each tool result is its own message and must directly follow the
        // assistant message that made the calls, so results go before any new
        // user text.
        for part in &input {
            if let UserPart::ToolResult {
                call_id,
                content,
                is_error,
                ..
            } = part
            {
                // This format has no error flag on a tool result, so a failure
                // is said in words.
                let content = if *is_error {
                    format!("ERROR: {content}")
                } else {
                    content.clone()
                };
                messages.push(json!({
                    "role": "tool",
                    "tool_call_id": call_id,
                    "content": content
                }));
            }
        }
        for part in &input {
            if let UserPart::Text(text) = part {
                messages.push(json!({ "role": "user", "content": text }));
            }
        }
        let (assistant, reply) =
            with_retries(cancel, || self.request_once(&messages)).await?;
        messages.push(assistant);
        self.messages = messages;
        Ok(reply)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::api::testing::{Canned, MockServer};

    fn conversation(server: &MockServer, key: &str) -> Box<dyn Conversation> {
        let tools = vec![ToolSpec {
            name: "read_file",
            description: "Read a file.".into(),
            input_schema: json!({
                "type": "object",
                "properties": { "path": { "type": "string" } },
                "required": ["path"]
            }),
        }];
        OpenAi::new(
            "OpenAI",
            key.into(),
            "gpt-test".into(),
            Some(server.url.clone()),
        )
        .unwrap()
        .start("SYSTEM".into(), tools, None)
    }

    fn chunk(delta: Value, finish: Option<&str>) -> Value {
        json!({
            "id": "c1",
            "model": "gpt-test-2026",
            "choices": [{
                "index": 0,
                "delta": delta,
                "finish_reason": finish
            }]
        })
    }

    fn tool_call_stream() -> Vec<Value> {
        vec![
            chunk(json!({ "role": "assistant", "content": "Let me " }), None),
            chunk(json!({ "content": "look." }), None),
            chunk(
                json!({
                    "tool_calls": [{
                        "index": 0,
                        "id": "call_abc",
                        "type": "function",
                        "function": { "name": "read_file", "arguments": "" }
                    }]
                }),
                None,
            ),
            chunk(
                json!({
                    "tool_calls": [{
                        "index": 0,
                        "function": { "arguments": "{\"path\":" }
                    }]
                }),
                None,
            ),
            chunk(
                json!({
                    "tool_calls": [{
                        "index": 0,
                        "function": { "arguments": " \"a.go\"}" }
                    }]
                }),
                None,
            ),
            chunk(json!({}), Some("tool_calls")),
            json!({
                "id": "c1",
                "choices": [],
                "usage": {
                    "prompt_tokens": 1200,
                    "completion_tokens": 30,
                    "prompt_tokens_details": { "cached_tokens": 1000 }
                }
            }),
        ]
    }

    #[tokio::test]
    async fn a_streamed_tool_call_is_assembled_and_answered_in_the_right_format(
    ) {
        let done = vec![chunk(json!({ "content": "Done." }), Some("stop"))];
        let server = MockServer::start(vec![
            Canned::sse_with_done(&tool_call_stream()),
            Canned::sse_with_done(&done),
        ])
        .await;
        let mut conversation = conversation(&server, "sk-openai");
        let cancel = CancellationToken::new();

        let first = conversation
            .send(vec![UserPart::Text("Go.".into())], &cancel)
            .await
            .unwrap();
        assert_eq!(first.text, "Let me look.");
        assert_eq!(first.stop, StopReason::ToolUse);
        assert_eq!(
            first.tool_calls,
            vec![ToolCall {
                id: "call_abc".into(),
                name: "read_file".into(),
                input: Ok(json!({ "path": "a.go" }))
            }]
        );
        assert_eq!(
            first.usage,
            Usage {
                input_tokens: 200,
                output_tokens: 30,
                cache_read_tokens: 1000,
                cache_write_tokens: 0
            }
        );
        assert_eq!(first.model.as_deref(), Some("gpt-test-2026"));

        let second = conversation
            .send(
                vec![UserPart::ToolResult {
                    call_id: "call_abc".into(),
                    tool_name: "read_file".into(),
                    content: "no such file".into(),
                    is_error: true,
                }],
                &cancel,
            )
            .await
            .unwrap();
        assert_eq!(
            (second.text.as_str(), second.stop),
            ("Done.", StopReason::EndTurn)
        );

        let requests = server.recorded();
        assert_eq!(requests[0].path, "/chat/completions");
        assert_eq!(
            requests[0].header("authorization"),
            Some("Bearer sk-openai")
        );
        assert_eq!(
            requests[0].body["messages"][0],
            json!({ "role": "system", "content": "SYSTEM" })
        );
        assert_eq!(
            requests[0].body["tools"][0]["function"]["name"],
            "read_file"
        );
        let messages = requests[1].body["messages"].as_array().unwrap();
        assert_eq!(
            messages[2]["tool_calls"][0]["function"]["arguments"],
            "{\"path\": \"a.go\"}"
        );
        assert_eq!(
            messages[3],
            json!({ "role": "tool", "tool_call_id": "call_abc", "content": "ERROR: no such file" })
        );
    }

    #[tokio::test]
    async fn a_server_without_keys_or_usage_reporting_still_works() {
        let rejected = Canned::error(
            400,
            json!({ "error": { "message": "Unknown parameter: stream_options" } }),
        );
        // This server also ends its stream without the final marker.
        let plain = Canned {
            status: 200,
            headers: vec![],
            body: format!(
                "data: {}\n\n",
                chunk(json!({ "content": "hi" }), Some("stop"))
            ),
        };
        let server = MockServer::start(vec![rejected, plain]).await;
        let reply = conversation(&server, "")
            .send(vec![UserPart::Text("x".into())], &CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(reply.text, "hi");
        let requests = server.recorded();
        assert!(requests[0].header("authorization").is_none());
        assert!(
            requests[0].body.get("stream_options").is_some()
                && requests[1].body.get("stream_options").is_none()
        );
    }

    #[tokio::test]
    async fn cut_off_arguments_and_filters_are_reported() {
        let mut cut = tool_call_stream();
        cut.truncate(4);
        cut.push(chunk(json!({}), Some("length")));
        let filtered = vec![chunk(json!({}), Some("content_filter"))];
        let server = MockServer::start(vec![
            Canned::sse_with_done(&cut),
            Canned::sse_with_done(&filtered),
        ])
        .await;
        let reply = conversation(&server, "k")
            .send(vec![UserPart::Text("x".into())], &CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(reply.stop, StopReason::MaxTokens);
        assert_eq!(reply.tool_calls[0].input, Err("{\"path\":".to_string()));
        let reply = conversation(&server, "k")
            .send(vec![UserPart::Text("x".into())], &CancellationToken::new())
            .await
            .unwrap();
        assert!(matches!(reply.stop, StopReason::Refusal(_)));
    }
}
