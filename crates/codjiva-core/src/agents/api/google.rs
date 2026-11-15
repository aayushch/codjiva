//! The Google provider: Gemini models through the Generative Language API.

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
use std::time::Duration;
use tokio_util::sync::CancellationToken;

pub const DEFAULT_BASE_URL: &str = "https://generativelanguage.googleapis.com";

const MAX_OUTPUT_TOKENS: u32 = 32_000;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const READ_TIMEOUT: Duration = Duration::from_secs(300);

pub struct Google {
    client: reqwest::Client,
    base_url: String,
    api_key: String,
    model: String,
}

impl Google {
    pub fn new(
        api_key: String,
        model: String,
        base_url: Option<String>,
    ) -> Result<Google> {
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
        Ok(Google {
            client,
            base_url,
            api_key,
            model,
        })
    }
}

/// Removes `additionalProperties` from a JSON Schema, at every depth. This API
/// accepts only a subset of JSON Schema for tool parameters and rejects that
/// keyword.
fn without_additional_properties(schema: &Value) -> Value {
    match schema {
        Value::Object(map) => Value::Object(
            map.iter()
                .filter(|(key, _)| key.as_str() != "additionalProperties")
                .map(|(key, value)| {
                    (key.clone(), without_additional_properties(value))
                })
                .collect(),
        ),
        Value::Array(items) => Value::Array(
            items.iter().map(without_additional_properties).collect(),
        ),
        other => other.clone(),
    }
}

impl Provider for Google {
    fn start(
        &self,
        system: String,
        tools: Vec<ToolSpec>,
        _effort: Option<Effort>,
    ) -> Box<dyn Conversation> {
        let declarations: Vec<Value> = tools
            .iter()
            .map(|t| {
                json!({
                    "name": t.name,
                    "description": t.description,
                    "parameters": without_additional_properties(&t.input_schema)
                })
            })
            .collect();
        Box::new(GoogleConversation {
            client: self.client.clone(),
            url: format!(
                "{}/v1beta/models/{}:streamGenerateContent?alt=sse",
                self.base_url, self.model
            ),
            api_key: self.api_key.clone(),
            system,
            declarations,
            contents: Vec::new(),
        })
    }

    /// Prices are not known to the app, so no cost is shown.
    fn price(&self) -> Option<Price> {
        None
    }
}

struct GoogleConversation {
    client: reqwest::Client,
    url: String,
    api_key: String,
    system: String,
    declarations: Vec<Value>,
    /// The transcript in the API's format: a list of turns, each a list of
    /// parts.
    contents: Vec<Value>,
}

impl GoogleConversation {
    async fn request_once(
        &self,
        contents: &[Value],
    ) -> std::result::Result<(Value, Reply), Attempt> {
        let mut body = json!({
            "systemInstruction": { "parts": [{ "text": self.system }] },
            "contents": contents,
            "generationConfig": { "maxOutputTokens": MAX_OUTPUT_TOKENS },
        });
        // The API rejects an empty list of function declarations.
        if !self.declarations.is_empty() {
            body["tools"] =
                json!([{ "functionDeclarations": self.declarations }]);
        }
        let response = self
            .client
            .post(&self.url)
            .header("x-goog-api-key", &self.api_key)
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| connection_failure("Google", e))?;
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
            // This API reports a bad key as a 400, not a 401.
            let status =
                if status == 400 && said.to_lowercase().contains("api key") {
                    401
                } else {
                    status
                };
            return Err(http_failure("Google", status, &said, wait));
        }

        // The reply's parts are kept exactly as received. Some carry a
        // signature of the model's hidden reasoning, which the API wants back
        // unchanged on the next request.
        let mut parts: Vec<Value> = Vec::new();
        let mut finish: Option<String> = None;
        let mut blocked: Option<String> = None;
        let mut usage = Usage::default();
        let mut model: Option<String> = None;
        let mut reader = SseReader::default();
        let mut stream = response.bytes_stream();
        let mut received_any = false;
        while let Some(chunk) = stream.next().await {
            let bytes = chunk.map_err(|e| connection_failure("Google", e))?;
            for data in reader.push(&bytes) {
                let Ok(event) = serde_json::from_str::<Value>(&data) else {
                    continue;
                };
                received_any = true;
                if let Some(said) =
                    event.pointer("/error/message").and_then(Value::as_str)
                {
                    return Err(http_failure(
                        "Google",
                        event
                            .pointer("/error/code")
                            .and_then(Value::as_u64)
                            .unwrap_or(500) as u16,
                        said,
                        None,
                    ));
                }
                if let Some(reason) = event
                    .pointer("/promptFeedback/blockReason")
                    .and_then(Value::as_str)
                {
                    blocked = Some(reason.to_string());
                }
                if let Some(name) =
                    event.get("modelVersion").and_then(Value::as_str)
                {
                    model = Some(name.to_string());
                }
                if let Some(counts) = event.get("usageMetadata") {
                    let get = |key: &str| {
                        counts.get(key).and_then(Value::as_u64).unwrap_or(0)
                    };
                    usage.cache_read_tokens = get("cachedContentTokenCount");
                    usage.input_tokens = get("promptTokenCount")
                        .saturating_sub(usage.cache_read_tokens);
                    usage.output_tokens =
                        get("candidatesTokenCount") + get("thoughtsTokenCount");
                }
                let Some(candidate) = event.pointer("/candidates/0") else {
                    continue;
                };
                if let Some(reason) =
                    candidate.get("finishReason").and_then(Value::as_str)
                {
                    finish = Some(reason.to_string());
                }
                parts.extend(
                    candidate
                        .pointer("/content/parts")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                        .cloned(),
                );
            }
        }
        if !received_any {
            return Err(connection_failure("Google", "the reply was empty"));
        }

        let mut text = String::new();
        let mut tool_calls = Vec::new();
        for part in &parts {
            if let Some(call) = part.get("functionCall") {
                let name = call
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                // Calls have no id in older versions of this API. One is made
                // up from the call's position so results can be matched back.
                let id = call
                    .get("id")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("call-{}", tool_calls.len()));
                let input = call
                    .get("args")
                    .cloned()
                    .filter(Value::is_object)
                    .unwrap_or_else(|| json!({}));
                tool_calls.push(ToolCall {
                    id,
                    name,
                    input: Ok(input),
                });
            } else if let Some(piece) = part.get("text").and_then(Value::as_str)
            {
                // Parts marked as thoughts are summaries of reasoning, not part
                // of the answer.
                if part.get("thought").and_then(Value::as_bool) != Some(true) {
                    text.push_str(piece);
                }
            }
        }
        let stop = match (blocked, finish.as_deref()) {
            (Some(reason), _) => StopReason::Refusal(format!(
                "The request was blocked ({reason})."
            )),
            (
                None,
                Some(
                    "SAFETY" | "PROHIBITED_CONTENT" | "BLOCKLIST" | "SPII"
                    | "RECITATION",
                ),
            ) => StopReason::Refusal(format!(
                "The reply was stopped by a content filter ({}).",
                finish.as_deref().unwrap_or("")
            )),
            (None, Some("MAX_TOKENS")) => StopReason::MaxTokens,
            (None, _) if !tool_calls.is_empty() => StopReason::ToolUse,
            (None, Some("STOP") | None) => StopReason::EndTurn,
            (None, Some(other)) => StopReason::Other(other.to_string()),
        };
        Ok((
            json!({ "role": "model", "parts": parts }),
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
impl Conversation for GoogleConversation {
    async fn send(
        &mut self,
        input: Vec<UserPart>,
        cancel: &CancellationToken,
    ) -> Result<Reply> {
        let mut parts: Vec<Value> = Vec::new();
        for part in &input {
            if let UserPart::ToolResult {
                call_id,
                tool_name,
                content,
                is_error,
            } = part
            {
                let response = if *is_error {
                    json!({ "error": content })
                } else {
                    json!({ "result": content })
                };
                let mut answer =
                    json!({ "name": tool_name, "response": response });
                // Only ids the API issued are sent back; the ones made up here
                // mean nothing to it.
                if !call_id.starts_with("call-") {
                    answer["id"] = json!(call_id);
                }
                parts.push(json!({ "functionResponse": answer }));
            }
        }
        for part in &input {
            if let UserPart::Text(text) = part {
                parts.push(json!({ "text": text }));
            }
        }
        let mut contents = self.contents.clone();
        contents.push(json!({ "role": "user", "parts": parts }));
        let (model_turn, reply) =
            with_retries(cancel, || self.request_once(&contents)).await?;
        contents.push(model_turn);
        self.contents = contents;
        Ok(reply)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::api::testing::{Canned, MockServer};

    fn conversation(server: &MockServer) -> Box<dyn Conversation> {
        let tools = vec![ToolSpec {
            name: "read_file",
            description: "Read a file.".into(),
            input_schema: json!({
                "type": "object",
                "properties": { "path": { "type": "string" } },
                "required": ["path"],
                "additionalProperties": false
            }),
        }];
        Google::new(
            "g-key".into(),
            "gemini-test".into(),
            Some(server.url.clone()),
        )
        .unwrap()
        .start("SYSTEM".into(), tools, None)
    }

    fn sse(chunks: &[Value]) -> Canned {
        Canned {
            status: 200,
            headers: vec![("content-type", "text/event-stream".into())],
            body: chunks
                .iter()
                .map(|c| format!("data: {c}\r\n\r\n"))
                .collect(),
        }
    }

    #[tokio::test]
    async fn a_function_call_round_trip_keeps_the_model_parts_unchanged() {
        let first = [
            json!({
                "candidates": [{
                    "content": {
                        "role": "model",
                        "parts": [{ "text": "Looking." }]
                    }
                }],
                "modelVersion": "gemini-test-001"
            }),
            json!({
                "candidates": [{
                    "content": {
                        "role": "model",
                        "parts": [{
                            "functionCall": {
                                "name": "read_file",
                                "args": { "path": "a.go" }
                            },
                            "thoughtSignature": "SIG=="
                        }]
                    },
                    "finishReason": "STOP"
                }],
                "usageMetadata": {
                    "promptTokenCount": 900,
                    "candidatesTokenCount": 20,
                    "thoughtsTokenCount": 15,
                    "cachedContentTokenCount": 400
                }
            }),
        ];
        let second = [json!({
            "candidates": [{
                "content": {
                    "role": "model",
                    "parts": [{ "text": "Done." }]
                },
                "finishReason": "STOP"
            }]
        })];
        let server = MockServer::start(vec![sse(&first), sse(&second)]).await;
        let mut conversation = conversation(&server);
        let cancel = CancellationToken::new();

        let reply = conversation
            .send(vec![UserPart::Text("Go.".into())], &cancel)
            .await
            .unwrap();
        assert_eq!(
            (reply.text.as_str(), reply.stop.clone()),
            ("Looking.", StopReason::ToolUse)
        );
        assert_eq!(
            reply.tool_calls,
            vec![ToolCall {
                id: "call-0".into(),
                name: "read_file".into(),
                input: Ok(json!({ "path": "a.go" }))
            }]
        );
        assert_eq!(
            reply.usage,
            Usage {
                input_tokens: 500,
                output_tokens: 35,
                cache_read_tokens: 400,
                cache_write_tokens: 0
            }
        );

        let reply = conversation
            .send(
                vec![UserPart::ToolResult {
                    call_id: "call-0".into(),
                    tool_name: "read_file".into(),
                    content: "1\tpackage a".into(),
                    is_error: false,
                }],
                &cancel,
            )
            .await
            .unwrap();
        assert_eq!(reply.text, "Done.");

        let requests = server.recorded();
        assert_eq!(
            requests[0].path,
            "/v1beta/models/gemini-test:streamGenerateContent?alt=sse"
        );
        assert_eq!(requests[0].header("x-goog-api-key"), Some("g-key"));
        assert_eq!(
            requests[0].body["systemInstruction"]["parts"][0]["text"],
            "SYSTEM"
        );
        let parameters = &requests[0].body["tools"][0]["functionDeclarations"]
            [0]["parameters"];
        assert!(
            parameters.get("additionalProperties").is_none()
                && parameters["required"][0] == "path"
        );
        let contents = requests[1].body["contents"].as_array().unwrap();
        assert_eq!(
            contents[1]["parts"][1],
            json!({
                "functionCall": {
                    "name": "read_file",
                    "args": { "path": "a.go" }
                },
                "thoughtSignature": "SIG=="
            })
        );
        assert_eq!(
            contents[2],
            json!({
                "role": "user",
                "parts": [{
                    "functionResponse": {
                        "name": "read_file",
                        "response": { "result": "1\tpackage a" }
                    }
                }]
            })
        );
    }

    #[tokio::test]
    async fn a_bad_key_a_block_and_a_cut_off_reply_are_reported() {
        let bad_key = Canned::error(
            400,
            json!({
                "error": {
                    "code": 400,
                    "message": "API key not valid. Please pass a valid API key.",
                    "status": "INVALID_ARGUMENT"
                }
            }),
        );
        let blocked =
            [json!({ "promptFeedback": { "blockReason": "SAFETY" } })];
        let cut = [json!({
            "candidates": [{
                "content": {
                    "role": "model",
                    "parts": [{ "text": "Half an ans" }]
                },
                "finishReason": "MAX_TOKENS"
            }]
        })];
        let server =
            MockServer::start(vec![bad_key, sse(&blocked), sse(&cut)]).await;
        let error = conversation(&server)
            .send(vec![UserPart::Text("x".into())], &CancellationToken::new())
            .await
            .unwrap_err();
        assert_eq!(error.code, "api_key_rejected");
        let reply = conversation(&server)
            .send(vec![UserPart::Text("x".into())], &CancellationToken::new())
            .await
            .unwrap();
        assert!(matches!(reply.stop, StopReason::Refusal(_)));
        let reply = conversation(&server)
            .send(vec![UserPart::Text("x".into())], &CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(reply.stop, StopReason::MaxTokens);
    }
}
