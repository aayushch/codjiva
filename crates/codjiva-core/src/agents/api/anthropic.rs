//! The Anthropic provider: Claude models through the Messages API.
//!
//! Requests are streamed, so a long reply (a whole drawing in one tool call)
//! cannot run into a request timeout. The transcript is kept in the API's own
//! block format and only ever appended to: Claude's reasoning blocks are tied
//! to the exact conversation that produced them, and are sent back unchanged.

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

pub const DEFAULT_BASE_URL: &str = "https://api.anthropic.com";

/// The model used when Settings names none.
pub const DEFAULT_MODEL: &str = "claude-opus-5-5";

const API_VERSION: &str = "2026-10-21";

/// Lets the API hand a request that its safety checks decline to another model
/// in the same call, instead of ending the job. It is a beta feature that must
/// be named in a header.
const FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";

/// The most output tokens asked for per reply. It is large enough for the
/// biggest source file an artifact has, and within the limit of every current
/// model.
const MAX_TOKENS: u32 = 32_000;

/// How long to wait for the connection, and for the next piece of a streamed
/// reply.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const READ_TIMEOUT: Duration = Duration::from_secs(300);

/// Prices in US dollars per million tokens: (model id prefix, input, output,
/// cache read). They are used to estimate what a job cost and are not a bill.
/// Writing to the prompt cache is estimated at 1.25 times the input price.
const PRICES: &[(&str, f64, f64, f64)] = &[
    ("claude-fable-5-2", 8.0, 40.0, 0.20),
    ("claude-fable-5", 10.0, 50.0, 1.0),
    ("claude-opus-5-5", 4.0, 20.0, 0.20),
    ("claude-opus-5", 5.0, 25.0, 0.50),
    ("claude-opus-4", 5.0, 25.0, 0.50),
    ("claude-sonnet-5", 2.0, 10.0, 0.10),
    ("claude-sonnet-4", 3.0, 15.0, 0.30),
    ("claude-haiku-5", 0.10, 0.50, 0.01),
    ("claude-haiku-4", 1.0, 5.0, 0.10),
];

pub struct Anthropic {
    client: reqwest::Client,
    base_url: String,
    api_key: String,
    model: String,
}

impl Anthropic {
    pub fn new(
        api_key: String,
        model: Option<String>,
        base_url: Option<String>,
    ) -> Result<Anthropic> {
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
        Ok(Anthropic {
            client,
            api_key,
            model: model
                .filter(|m| !m.trim().is_empty())
                .unwrap_or_else(|| DEFAULT_MODEL.to_string()),
            base_url: base_url
                .filter(|u| !u.trim().is_empty())
                .unwrap_or_else(|| DEFAULT_BASE_URL.to_string())
                .trim_end_matches('/')
                .to_string(),
        })
    }
}

impl Provider for Anthropic {
    fn start(
        &self,
        system: String,
        tools: Vec<ToolSpec>,
        effort: Option<Effort>,
    ) -> Box<dyn Conversation> {
        Box::new(AnthropicConversation {
            client: self.client.clone(),
            url: format!("{}/v1/messages", self.base_url),
            api_key: self.api_key.clone(),
            model: self.model.clone(),
            system,
            tools,
            messages: Vec::new(),
            use_fallbacks: AtomicBool::new(true),
            effort,
            use_effort: AtomicBool::new(true),
        })
    }

    fn price(&self) -> Option<Price> {
        PRICES
            .iter()
            .find(|(prefix, ..)| self.model.starts_with(prefix))
            .map(|(_, input, output, cache_read)| Price {
                input: *input,
                output: *output,
                cache_read: *cache_read,
                cache_write: input * 1.25,
            })
    }
}

struct AnthropicConversation {
    client: reqwest::Client,
    url: String,
    api_key: String,
    model: String,
    system: String,
    tools: Vec<ToolSpec>,
    /// The transcript in the API's own format. It only grows.
    messages: Vec<Value>,
    /// Two request features that not every model or account accepts. Each
    /// starts on and is switched off for the rest of the conversation when the
    /// API rejects it.
    use_fallbacks: AtomicBool,
    use_effort: AtomicBool,
    effort: Option<Effort>,
}

/// What a streamed reply has built up so far.
#[derive(Default)]
struct StreamState {
    /// The reply's content blocks, by index, in the API's format.
    blocks: Vec<Value>,
    /// The JSON text of each tool call's input, which arrives in fragments.
    input_json: Vec<String>,
    stop_reason: Option<String>,
    refusal: Option<String>,
    usage: Usage,
    model: Option<String>,
    finished: bool,
}

impl StreamState {
    fn read_usage(&mut self, usage: &Value) {
        let get = |key: &str| usage.get(key).and_then(Value::as_u64);
        if let Some(n) = get("input_tokens") {
            self.usage.input_tokens = n;
        }
        if let Some(n) = get("output_tokens") {
            self.usage.output_tokens = n;
        }
        if let Some(n) = get("cache_read_input_tokens") {
            self.usage.cache_read_tokens = n;
        }
        if let Some(n) = get("cache_creation_input_tokens") {
            self.usage.cache_write_tokens = n;
        }
    }

    /// Applies one event of the stream. Returns an error for an `error` event,
    /// which the API can send in the middle of a reply, for example when it
    /// becomes overloaded.
    fn apply(&mut self, event: &Value) -> std::result::Result<(), Attempt> {
        let index = event
            .get("index")
            .and_then(Value::as_u64)
            .map(|i| i as usize);
        match event.get("type").and_then(Value::as_str).unwrap_or("") {
            "message_start" => {
                self.model = event
                    .pointer("/message/model")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                if let Some(usage) = event.pointer("/message/usage") {
                    self.read_usage(usage);
                }
            }
            "content_block_start" => {
                let Some(i) = index else { return Ok(()) };
                if self.blocks.len() <= i {
                    self.blocks.resize(i + 1, Value::Null);
                    self.input_json.resize(i + 1, String::new());
                }
                self.blocks[i] =
                    event.get("content_block").cloned().unwrap_or(Value::Null);
            }
            "content_block_delta" => {
                let (Some(i), Some(delta)) = (index, event.get("delta")) else {
                    return Ok(());
                };
                let Some(block) = self.blocks.get_mut(i) else {
                    return Ok(());
                };
                let append = |block: &mut Value, field: &str, more: &str| {
                    let old = block
                        .get(field)
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    block[field] = Value::String(old + more);
                };
                let piece = |key: &str| {
                    delta.get(key).and_then(Value::as_str).unwrap_or("")
                };
                match delta.get("type").and_then(Value::as_str).unwrap_or("") {
                    "text_delta" => append(block, "text", piece("text")),
                    "thinking_delta" => {
                        append(block, "thinking", piece("thinking"))
                    }
                    "signature_delta" => {
                        block["signature"] =
                            Value::String(piece("signature").to_string())
                    }
                    "input_json_delta" => {
                        self.input_json[i].push_str(piece("partial_json"))
                    }
                    _ => {}
                }
            }
            "message_delta" => {
                if let Some(reason) =
                    event.pointer("/delta/stop_reason").and_then(Value::as_str)
                {
                    self.stop_reason = Some(reason.to_string());
                }
                let details = event.pointer("/delta/stop_details");
                if let Some(text) = details
                    .and_then(|d| {
                        d.get("explanation").or_else(|| d.get("category"))
                    })
                    .and_then(Value::as_str)
                {
                    self.refusal = Some(text.to_string());
                }
                if let Some(usage) = event.get("usage") {
                    self.read_usage(usage);
                }
            }
            "message_stop" => self.finished = true,
            "error" => {
                let kind = event
                    .pointer("/error/type")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let said = event
                    .pointer("/error/message")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let status = match kind {
                    "overloaded_error" => 529,
                    "rate_limit_error" => 429,
                    "api_error" => 500,
                    _ => 400,
                };
                return Err(http_failure("Anthropic", status, said, None));
            }
            _ => {}
        }
        Ok(())
    }

    /// Turns the finished stream into the assistant message for the transcript
    /// and the reply for the agent loop.
    fn finish(mut self) -> (Value, Reply) {
        let mut text_parts: Vec<String> = Vec::new();
        let mut tool_calls = Vec::new();
        for (i, block) in self.blocks.iter_mut().enumerate() {
            match block.get("type").and_then(Value::as_str) {
                Some("text") => {
                    let text = block
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .trim();
                    if !text.is_empty() {
                        text_parts.push(text.to_string());
                    }
                }
                Some("tool_use") => {
                    let raw = std::mem::take(&mut self.input_json[i]);
                    // A call with no parameters streams no input at all.
                    let parsed = if raw.trim().is_empty() {
                        Ok(json!({}))
                    } else {
                        serde_json::from_str::<Value>(&raw)
                            .ok()
                            .filter(Value::is_object)
                            .ok_or(raw)
                    };
                    // The transcript must hold an object even when the model's
                    // input was not valid JSON. The model learns about the
                    // problem from the tool result.
                    block["input"] =
                        parsed.clone().unwrap_or_else(|_| json!({}));
                    tool_calls.push(ToolCall {
                        id: block
                            .get("id")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                        name: block
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                        input: parsed,
                    });
                }
                _ => {}
            }
        }
        let stop = match self.stop_reason.as_deref() {
            Some("end_turn") | Some("stop_sequence") => StopReason::EndTurn,
            Some("tool_use") => StopReason::ToolUse,
            Some("max_tokens") | Some("model_context_window_exceeded") => {
                StopReason::MaxTokens
            }
            Some("refusal") => {
                StopReason::Refusal(self.refusal.unwrap_or_default())
            }
            other => StopReason::Other(other.unwrap_or("unknown").to_string()),
        };
        let content: Vec<Value> =
            self.blocks.into_iter().filter(|b| !b.is_null()).collect();
        let reply = Reply {
            text: text_parts.join("\n\n"),
            tool_calls,
            stop,
            usage: self.usage,
            model: self.model,
        };
        (json!({ "role": "assistant", "content": content }), reply)
    }
}

impl AnthropicConversation {
    fn body(&self, messages: &[Value]) -> Value {
        let tools: Vec<Value> = self
            .tools
            .iter()
            .map(|tool| {
                json!({
                    "name": tool.name,
                    "description": tool.description,
                    "input_schema": tool.input_schema,
                    // Lets a large tool input, such as a whole file, stream as
                    // it is written instead of arriving in one piece after a
                    // long silence.
                    "eager_input_streaming": true,
                })
            })
            .collect();
        let mut body = json!({
            "model": self.model,
            "max_tokens": MAX_TOKENS,
            "stream": true,
            // The system prompt and the tools are the same for every request of
            // a job, so they are marked for the prompt cache. The top-level
            // mark caches the growing transcript.
            "system": [{
                "type": "text",
                "text": self.system,
                "cache_control": { "type": "ephemeral" }
            }],
            "tools": tools,
            "messages": messages,
            "cache_control": { "type": "ephemeral" },
        });
        if let Some(effort) = self
            .effort
            .filter(|_| self.use_effort.load(Ordering::SeqCst))
        {
            body["output_config"] = json!({ "effort": effort.as_str() });
        }
        // The API rejects an empty list of tools.
        if self.tools.is_empty() {
            body.as_object_mut()
                .expect("the request body is an object")
                .remove("tools");
        }
        if self.use_fallbacks.load(Ordering::SeqCst) {
            body["fallbacks"] = json!("default");
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
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", API_VERSION)
            .header("content-type", "application/json");
        if self.use_fallbacks.load(Ordering::SeqCst) {
            request = request.header("anthropic-beta", FALLBACK_BETA);
        }
        let response = request
            .json(&self.body(messages))
            .send()
            .await
            .map_err(|e| connection_failure("Anthropic", e))?;
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
            // A 400 that names one of the optional features means this model or
            // account does not accept it. The feature is switched off and the
            // request sent again at once.
            if status == 400 {
                let lower = said.to_lowercase();
                let fallbacks_rejected = (lower.contains("fallback")
                    || lower.contains("anthropic-beta"))
                    && self.use_fallbacks.swap(false, Ordering::SeqCst);
                let effort_rejected = (lower.contains("effort")
                    || lower.contains("output_config"))
                    && self.use_effort.swap(false, Ordering::SeqCst);
                if fallbacks_rejected || effort_rejected {
                    let mut again = http_failure(
                        "Anthropic",
                        status,
                        &said,
                        Some(Duration::ZERO),
                    );
                    again.retryable = true;
                    return Err(again);
                }
            }
            return Err(http_failure("Anthropic", status, &said, wait));
        }

        let mut state = StreamState::default();
        let mut reader = SseReader::default();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let bytes =
                chunk.map_err(|e| connection_failure("Anthropic", e))?;
            for data in reader.push(&bytes) {
                if let Ok(event) = serde_json::from_str::<Value>(&data) {
                    state.apply(&event)?;
                }
            }
        }
        if !state.finished {
            return Err(connection_failure(
                "Anthropic",
                "the reply ended before it was complete",
            ));
        }
        Ok(state.finish())
    }
}

#[async_trait]
impl Conversation for AnthropicConversation {
    async fn send(
        &mut self,
        input: Vec<UserPart>,
        cancel: &CancellationToken,
    ) -> Result<Reply> {
        // The API requires tool results to come before any text in the same
        // message.
        let mut content: Vec<Value> = Vec::new();
        for part in &input {
            if let UserPart::ToolResult {
                call_id,
                content: text,
                is_error,
                ..
            } = part
            {
                content.push(json!({
                    "type": "tool_result",
                    "tool_use_id": call_id,
                    "content": text,
                    "is_error": is_error
                }));
            }
        }
        for part in &input {
            if let UserPart::Text(text) = part {
                content.push(json!({ "type": "text", "text": text }));
            }
        }
        let mut messages = self.messages.clone();
        messages.push(json!({ "role": "user", "content": content }));
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

    fn tools() -> Vec<ToolSpec> {
        vec![ToolSpec {
            name: "read_file",
            description: "Read a file.".into(),
            input_schema: json!({
                "type": "object",
                "properties": { "path": { "type": "string" } },
                "required": ["path"],
                "additionalProperties": false
            }),
        }]
    }

    fn conversation(server: &MockServer) -> Box<dyn Conversation> {
        Anthropic::new("sk-test".into(), None, Some(server.url.clone()))
            .unwrap()
            .start("You are a test.".into(), tools(), Some(Effort::High))
    }

    /// The events of a reply that thinks, says something and calls a tool whose
    /// input arrives in two fragments.
    fn tool_reply() -> Vec<Value> {
        vec![
            json!({
                "type": "message_start",
                "message": {
                    "model": "claude-opus-5-5",
                    "usage": {
                        "input_tokens": 12,
                        "cache_read_input_tokens": 3000,
                        "cache_creation_input_tokens": 40,
                        "output_tokens": 1
                    }
                }
            }),
            json!({
                "type": "content_block_start",
                "index": 0,
                "content_block": {
                    "type": "thinking",
                    "thinking": "",
                    "signature": ""
                }
            }),
            json!({
                "type": "content_block_delta",
                "index": 0,
                "delta": { "type": "signature_delta", "signature": "SIG123" }
            }),
            json!({ "type": "content_block_stop", "index": 0 }),
            json!({
                "type": "content_block_start",
                "index": 1,
                "content_block": { "type": "text", "text": "" }
            }),
            json!({
                "type": "content_block_delta",
                "index": 1,
                "delta": { "type": "text_delta", "text": "Reading " }
            }),
            json!({
                "type": "content_block_delta",
                "index": 1,
                "delta": { "type": "text_delta", "text": "the file." }
            }),
            json!({ "type": "content_block_stop", "index": 1 }),
            json!({
                "type": "content_block_start",
                "index": 2,
                "content_block": {
                    "type": "tool_use",
                    "id": "toolu_1",
                    "name": "read_file",
                    "input": {}
                }
            }),
            json!({
                "type": "content_block_delta",
                "index": 2,
                "delta": {
                    "type": "input_json_delta",
                    "partial_json": "{\"path\": \"src/"
                }
            }),
            json!({
                "type": "content_block_delta",
                "index": 2,
                "delta": {
                    "type": "input_json_delta",
                    "partial_json": "a.go\"}"
                }
            }),
            json!({ "type": "content_block_stop", "index": 2 }),
            json!({
                "type": "message_delta",
                "delta": { "stop_reason": "tool_use" },
                "usage": { "output_tokens": 55 }
            }),
            json!({ "type": "message_stop" }),
        ]
    }

    fn text_reply(text: &str) -> Vec<Value> {
        vec![
            json!({
                "type": "message_start",
                "message": {
                    "model": "claude-opus-5-5",
                    "usage": { "input_tokens": 5, "output_tokens": 1 }
                }
            }),
            json!({
                "type": "content_block_start",
                "index": 0,
                "content_block": { "type": "text", "text": "" }
            }),
            json!({
                "type": "content_block_delta",
                "index": 0,
                "delta": { "type": "text_delta", "text": text }
            }),
            json!({ "type": "content_block_stop", "index": 0 }),
            json!({
                "type": "message_delta",
                "delta": { "stop_reason": "end_turn" },
                "usage": { "output_tokens": 9 }
            }),
            json!({ "type": "message_stop" }),
        ]
    }

    #[tokio::test]
    async fn a_tool_call_round_trip_keeps_the_transcript_whole() {
        let server = MockServer::start(vec![
            Canned::sse(&tool_reply()),
            Canned::sse(&text_reply("Done.")),
        ])
        .await;
        let mut conversation = conversation(&server);
        let cancel = CancellationToken::new();

        let first = conversation
            .send(vec![UserPart::Text("Visualise it.".into())], &cancel)
            .await
            .unwrap();
        assert_eq!(first.text, "Reading the file.");
        assert_eq!(first.stop, StopReason::ToolUse);
        assert_eq!(
            first.tool_calls,
            vec![ToolCall {
                id: "toolu_1".into(),
                name: "read_file".into(),
                input: Ok(json!({ "path": "src/a.go" }))
            }]
        );
        assert_eq!(
            first.usage,
            Usage {
                input_tokens: 12,
                output_tokens: 55,
                cache_read_tokens: 3000,
                cache_write_tokens: 40
            }
        );

        let second = conversation
            .send(
                vec![
                    UserPart::Text("Carry on.".into()),
                    UserPart::ToolResult {
                        call_id: "toolu_1".into(),
                        tool_name: "read_file".into(),
                        content: "1\tpackage a".into(),
                        is_error: false,
                    },
                ],
                &cancel,
            )
            .await
            .unwrap();
        assert_eq!(
            (second.text.as_str(), second.stop),
            ("Done.", StopReason::EndTurn)
        );

        let requests = server.recorded();
        let first_request = &requests[0];
        assert_eq!(first_request.path, "/v1/messages");
        assert_eq!(first_request.header("x-api-key"), Some("sk-test"));
        assert_eq!(
            first_request.header("anthropic-version"),
            Some("2026-10-21")
        );
        assert_eq!(
            first_request.header("anthropic-beta"),
            Some("server-side-fallback-2026-07-01")
        );
        let body = &first_request.body;
        assert_eq!(
            (
                body["model"].as_str(),
                body["stream"].as_bool(),
                body["fallbacks"].as_str()
            ),
            (Some("claude-opus-5-5"), Some(true), Some("default"))
        );
        assert_eq!(body["system"][0]["cache_control"]["type"], "ephemeral");
        assert_eq!(body["tools"][0]["eager_input_streaming"], true);
        assert_eq!(body["output_config"]["effort"], "high");
        assert!(
            body.get("temperature").is_none() && body.get("thinking").is_none()
        );

        // The second request replays the assistant turn exactly, reasoning
        // block included, and puts the tool result before the text.
        let messages = requests[1].body["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 3);
        assert_eq!(
            messages[1]["content"][0],
            json!({ "type": "thinking", "thinking": "", "signature": "SIG123" })
        );
        assert_eq!(
            messages[1]["content"][2]["input"],
            json!({ "path": "src/a.go" })
        );
        assert_eq!(messages[2]["content"][0]["type"], "tool_result");
        assert_eq!(messages[2]["content"][0]["tool_use_id"], "toolu_1");
        assert_eq!(
            messages[2]["content"][1],
            json!({ "type": "text", "text": "Carry on." })
        );
    }

    #[tokio::test]
    async fn an_overloaded_api_is_retried_and_a_rejected_key_is_not() {
        let overloaded = Canned {
            status: 529,
            headers: vec![("retry-after", "0".into())],
            body: json!({
                "type": "error",
                "error": {
                    "type": "overloaded_error",
                    "message": "Overloaded"
                }
            })
            .to_string(),
        };
        let server =
            MockServer::start(vec![overloaded, Canned::sse(&text_reply("ok"))])
                .await;
        let reply = conversation(&server)
            .send(vec![UserPart::Text("hi".into())], &CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(reply.text, "ok");
        assert_eq!(server.recorded().len(), 2);

        let server = MockServer::start(vec![Canned::error(
            401,
            json!({
                "type": "error",
                "error": {
                    "type": "authentication_error",
                    "message": "invalid x-api-key"
                }
            }),
        )])
        .await;
        let error = conversation(&server)
            .send(vec![UserPart::Text("hi".into())], &CancellationToken::new())
            .await
            .unwrap_err();
        assert_eq!(error.code, "api_key_rejected");
        assert_eq!(server.recorded().len(), 1);
    }

    #[tokio::test]
    async fn a_feature_the_api_rejects_is_dropped_and_the_request_sent_again() {
        let rejected = Canned::error(
            400,
            json!({
                "type": "error",
                "error": {
                    "type": "invalid_request_error",
                    "message": "Unexpected value(s) `server-side-fallback-2026-07-01` for the `anthropic-beta` header."
                }
            }),
        );
        let server = MockServer::start(vec![
            rejected,
            Canned::sse(&text_reply("ok")),
            Canned::sse(&text_reply("again")),
        ])
        .await;
        let mut conversation = conversation(&server);
        conversation
            .send(vec![UserPart::Text("hi".into())], &CancellationToken::new())
            .await
            .unwrap();
        conversation
            .send(
                vec![UserPart::Text("more".into())],
                &CancellationToken::new(),
            )
            .await
            .unwrap();
        let requests = server.recorded();
        assert!(requests[0].body.get("fallbacks").is_some());
        for later in &requests[1..] {
            assert!(
                later.body.get("fallbacks").is_none()
                    && later.header("anthropic-beta").is_none()
            );
            assert_eq!(
                later.body["output_config"]["effort"], "high",
                "only the rejected feature is dropped"
            );
        }
    }

    #[tokio::test]
    async fn a_failed_request_leaves_the_transcript_as_it_was() {
        let server = MockServer::start(vec![
            Canned::error(
                400,
                json!({
                    "type": "error",
                    "error": {
                        "type": "invalid_request_error",
                        "message": "prompt is too long"
                    }
                }),
            ),
            Canned::sse(&text_reply("ok")),
        ])
        .await;
        let mut conversation = conversation(&server);
        let error = conversation
            .send(
                vec![UserPart::Text("first".into())],
                &CancellationToken::new(),
            )
            .await
            .unwrap_err();
        assert!(error.message.contains("prompt is too long"));
        conversation
            .send(
                vec![UserPart::Text("second".into())],
                &CancellationToken::new(),
            )
            .await
            .unwrap();
        let messages = server.recorded()[1].body["messages"]
            .as_array()
            .unwrap()
            .clone();
        assert_eq!(
            messages.len(),
            1,
            "the failed message is not in the transcript"
        );
        assert_eq!(messages[0]["content"][0]["text"], "second");
    }

    #[tokio::test]
    async fn refusals_cut_off_replies_and_broken_tool_input_are_reported_as_such(
    ) {
        let mut refused = text_reply("");
        refused[4] = json!({
            "type": "message_delta",
            "delta": {
                "stop_reason": "refusal",
                "stop_details": {
                    "type": "refusal",
                    "category": "cyber",
                    "explanation": "This request was declined."
                }
            },
            "usage": { "output_tokens": 0 }
        });
        let mut cut = tool_reply();
        cut[10] = json!({
            "type": "content_block_delta",
            "index": 2,
            "delta": { "type": "input_json_delta", "partial_json": "a.g" }
        });
        cut[12] = json!({
            "type": "message_delta",
            "delta": { "stop_reason": "max_tokens" },
            "usage": { "output_tokens": 32000 }
        });
        let server =
            MockServer::start(vec![Canned::sse(&refused), Canned::sse(&cut)])
                .await;

        let reply = conversation(&server)
            .send(vec![UserPart::Text("x".into())], &CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(
            reply.stop,
            StopReason::Refusal("This request was declined.".into())
        );

        let reply = conversation(&server)
            .send(vec![UserPart::Text("x".into())], &CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(reply.stop, StopReason::MaxTokens);
        assert_eq!(
            reply.tool_calls[0].input,
            Err("{\"path\": \"src/a.g".to_string())
        );
    }

    #[tokio::test]
    async fn an_error_in_the_middle_of_a_stream_is_retried() {
        let mut broken = text_reply("partial");
        broken.truncate(3);
        broken.push(json!({
            "type": "error",
            "error": { "type": "overloaded_error", "message": "Overloaded" }
        }));
        let server = MockServer::start(vec![
            Canned::sse(&broken),
            Canned::sse(&text_reply("whole")),
        ])
        .await;
        let reply = conversation(&server)
            .send(vec![UserPart::Text("x".into())], &CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(reply.text, "whole");
    }

    #[test]
    fn prices_are_known_for_current_models_and_unknown_for_others() {
        let price = |model: &str| {
            Anthropic::new("k".into(), Some(model.into()), None)
                .unwrap()
                .price()
        };
        assert_eq!(
            price("claude-opus-5-5").map(|p| (p.input, p.output, p.cache_read)),
            Some((4.0, 20.0, 0.20))
        );
        assert_eq!(price("claude-fable-5-2").map(|p| p.input), Some(8.0));
        assert_eq!(price("claude-fable-5-1").map(|p| p.input), Some(10.0));
        assert_eq!(price("claude-sonnet-5-5").map(|p| p.output), Some(10.0));
        assert!(price("some-future-model").is_none());
    }
}
