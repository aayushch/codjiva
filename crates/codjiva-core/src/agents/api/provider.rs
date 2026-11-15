//! What the agent loop needs from a model provider, whichever company's API is
//! behind it.
//!
//! Every provider has its own wire format for messages, tool calls and the
//! hidden reasoning that must be sent back unchanged. So a provider keeps the
//! transcript itself, in its own format, behind the [`Conversation`] trait. The
//! loop only ever hands over what the user side says next (text and tool
//! results) and gets back what the model said and which tools it wants.

use crate::agents::api::tools::ToolSpec;
use crate::error::{AppError, Result};
use crate::settings::Effort;
use async_trait::async_trait;
use serde_json::Value;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

/// One thing the user side adds to the conversation.
#[derive(Debug, Clone, PartialEq)]
pub enum UserPart {
    Text(String),
    /// The result of a tool call the model made in its last reply.
    ToolResult {
        call_id: String,
        tool_name: String,
        content: String,
        is_error: bool,
    },
}

/// A tool call the model asked for.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    /// The call's input. `Err` holds the raw text when the model sent something
    /// that is not valid JSON, which happens when a reply is cut off in the
    /// middle of a call.
    pub input: std::result::Result<Value, String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum StopReason {
    /// The model finished what it wanted to say.
    EndTurn,
    /// The model is waiting for the results of the tool calls in this reply.
    ToolUse,
    /// The reply hit the output limit and is incomplete.
    MaxTokens,
    /// The provider declined to answer. The text explains, where the provider
    /// says why.
    Refusal(String),
    Other(String),
}

/// Tokens used by one reply.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Usage {
    /// Input tokens billed at the full price.
    pub input_tokens: u64,
    pub output_tokens: u64,
    /// Input tokens read from the provider's prompt cache, billed at a reduced
    /// price.
    pub cache_read_tokens: u64,
    /// Input tokens written to the prompt cache, billed at a raised price by
    /// some providers.
    pub cache_write_tokens: u64,
}

/// What a model costs, in US dollars per million tokens.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Price {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
}

impl Price {
    pub fn cost(&self, usage: &Usage) -> f64 {
        (usage.input_tokens as f64 * self.input
            + usage.output_tokens as f64 * self.output
            + usage.cache_read_tokens as f64 * self.cache_read
            + usage.cache_write_tokens as f64 * self.cache_write)
            / 1_000_000.0
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Reply {
    /// The prose of the reply, with every text block joined.
    pub text: String,
    pub tool_calls: Vec<ToolCall>,
    pub stop: StopReason,
    pub usage: Usage,
    /// The model that answered, as the provider names it.
    pub model: Option<String>,
}

/// One conversation with a model. It keeps the whole transcript and sends it
/// with every request.
#[async_trait]
pub trait Conversation: Send {
    /// Adds `input` to the transcript, asks the model for its next reply and
    /// adds that too. When the request fails, the transcript is left as it was
    /// before the call, so the same input can be sent again.
    async fn send(
        &mut self,
        input: Vec<UserPart>,
        cancel: &CancellationToken,
    ) -> Result<Reply>;
}

pub trait Provider: Send + Sync {
    /// Starts a conversation with a fixed system prompt and set of tools.
    /// `effort` is how much thinking to ask the model for; `None`, and any
    /// provider that has no such control, leaves it to the model.
    fn start(
        &self,
        system: String,
        tools: Vec<ToolSpec>,
        effort: Option<Effort>,
    ) -> Box<dyn Conversation>;
    /// The price of the model this provider is set up for, when it is known.
    fn price(&self) -> Option<Price>;
}

/// How often a request that failed for a passing reason is tried again, and how
/// long to wait before each new try when the provider does not say.
#[cfg(not(test))]
const RETRY_WAITS: [Duration; 4] = [
    Duration::from_secs(2),
    Duration::from_secs(6),
    Duration::from_secs(15),
    Duration::from_secs(30),
];

/// Tests retry as often as the app does but wait only milliseconds, so they
/// stay fast without changing the clock.
#[cfg(test)]
const RETRY_WAITS: [Duration; 4] = [
    Duration::from_millis(2),
    Duration::from_millis(4),
    Duration::from_millis(6),
    Duration::from_millis(8),
];

/// A failed request, and whether trying again could help.
pub struct Attempt {
    pub error: AppError,
    pub retryable: bool,
    /// How long the provider asked the caller to wait, from a `retry-after`
    /// header.
    pub retry_after: Option<Duration>,
}

impl Attempt {
    pub fn fatal(error: AppError) -> Attempt {
        Attempt {
            error,
            retryable: false,
            retry_after: None,
        }
    }

    pub fn retryable(error: AppError) -> Attempt {
        Attempt {
            error,
            retryable: true,
            retry_after: None,
        }
    }
}

/// Runs `request` until it succeeds, fails for good, or has been retried as
/// often as allowed. Rate limits, overload and connection failures are worth
/// retrying; a rejected key or a bad request is not. The wait between tries can
/// be cut short by `cancel`.
pub async fn with_retries<T, F, Fut>(
    cancel: &CancellationToken,
    mut request: F,
) -> Result<T>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = std::result::Result<T, Attempt>>,
{
    let mut tries = 0;
    loop {
        let failure = tokio::select! {
            _ = cancel.cancelled() => return Err(cancelled()),
            outcome = request() => match outcome {
                Ok(value) => return Ok(value),
                Err(failure) => failure,
            },
        };
        if !failure.retryable || tries >= RETRY_WAITS.len() {
            return Err(failure.error);
        }
        let wait = failure
            .retry_after
            .unwrap_or(RETRY_WAITS[tries])
            .min(Duration::from_secs(120));
        tries += 1;
        tokio::select! {
            _ = cancel.cancelled() => return Err(cancelled()),
            _ = tokio::time::sleep(wait) => {}
        }
    }
}

/// The error a cancelled request ends with. The agent loop recognises it by its
/// code.
pub fn cancelled() -> AppError {
    AppError::new("cancelled", "The job was cancelled.")
}

/// Turns an HTTP error status into an error the user can act on, and says
/// whether a retry could help. `said` is the provider's own message, when its
/// error body had one.
pub fn http_failure(
    provider: &str,
    status: u16,
    said: &str,
    retry_after: Option<Duration>,
) -> Attempt {
    let detail = if said.is_empty() {
        format!("HTTP {status}")
    } else {
        said.to_string()
    };
    let (code, message, retryable) = match status {
        401 | 403 => (
            "api_key_rejected",
            format!(
                "{provider} rejected the API key. Check the key in Settings."
            ),
            false,
        ),
        402 => (
            "api_billing",
            format!("{provider} reported a billing problem with this account."),
            false,
        ),
        404 => (
            "api_not_found",
            format!(
                "{provider} does not know the requested model, or this key \
                 may not use it. Check the model name in Settings."
            ),
            false,
        ),
        408 | 409 | 429 => (
            "api_rate_limited",
            format!("{provider} is limiting requests from this key right now."),
            true,
        ),
        413 => (
            "api_too_large",
            format!(
                "The request was too large for {provider}. Choose fewer or \
                 smaller files."
            ),
            false,
        ),
        500..=599 => (
            "api_unavailable",
            format!("{provider} is overloaded or unavailable right now."),
            true,
        ),
        _ => (
            "api_bad_request",
            format!("{provider} did not accept the request: {detail}"),
            false,
        ),
    };
    Attempt {
        error: AppError::new(code, message).with_detail(detail),
        retryable,
        retry_after,
    }
}

/// A connection that failed or broke off, which is always worth another try.
pub fn connection_failure(
    provider: &str,
    error: impl std::fmt::Display,
) -> Attempt {
    Attempt::retryable(
        AppError::new(
            "api_unreachable",
            format!(
                "Could not reach {provider}. Check the network connection."
            ),
        )
        .with_detail(error),
    )
}

/// Reads the number of seconds from a `retry-after` header.
pub fn retry_after(headers: &reqwest::header::HeaderMap) -> Option<Duration> {
    headers
        .get("retry-after")?
        .to_str()
        .ok()?
        .trim()
        .parse::<f64>()
        .ok()
        .filter(|s| *s >= 0.0)
        .map(Duration::from_secs_f64)
}

/// Splits a streamed response body into server-sent events.
///
/// Bytes arrive in arbitrary pieces. `push` takes a piece and returns the
/// `data:` payload of every event that piece completed. An event ends at a
/// blank line, and an event with several `data:` lines yields them joined by a
/// newline.
#[derive(Default)]
pub struct SseReader {
    buffer: Vec<u8>,
}

impl SseReader {
    pub fn push(&mut self, bytes: &[u8]) -> Vec<String> {
        self.buffer.extend_from_slice(bytes);
        let mut events = Vec::new();
        loop {
            // An event ends with a blank line: two line breaks in a row, with
            // or without carriage returns.
            let end = self
                .buffer
                .windows(2)
                .position(|w| w == b"\n\n")
                .map(|i| (i, 2))
                .into_iter()
                .chain(
                    self.buffer
                        .windows(4)
                        .position(|w| w == b"\r\n\r\n")
                        .map(|i| (i, 4)),
                )
                .min_by_key(|(i, _)| *i);
            let Some((at, gap)) = end else { break };
            let block: Vec<u8> = self.buffer.drain(..at + gap).collect();
            let text = String::from_utf8_lossy(&block[..at]);
            let data: Vec<&str> = text
                .lines()
                .filter_map(|line| line.strip_prefix("data:"))
                .map(|d| d.strip_prefix(' ').unwrap_or(d))
                .collect();
            if !data.is_empty() {
                events.push(data.join("\n"));
            }
        }
        events
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn sse_events_are_found_across_arbitrary_chunk_boundaries() {
        let stream = "event: a\ndata: {\"n\":1}\n\nevent: ping\ndata: \
                      {}\n\r\n: comment only\n\ndata: first\ndata: second\n\n";
        for size in [1, 3, 7, 1000] {
            let mut reader = SseReader::default();
            let events: Vec<String> = stream
                .as_bytes()
                .chunks(size)
                .flat_map(|chunk| reader.push(chunk))
                .collect();
            assert_eq!(
                events,
                vec!["{\"n\":1}", "{}", "first\nsecond"],
                "chunk size {size}"
            );
        }
    }

    #[test]
    fn cost_adds_each_kind_of_token_at_its_price() {
        let price = Price {
            input: 4.0,
            output: 20.0,
            cache_read: 0.2,
            cache_write: 5.0,
        };
        let usage = Usage {
            input_tokens: 1_000_000,
            output_tokens: 100_000,
            cache_read_tokens: 2_000_000,
            cache_write_tokens: 10_000,
        };
        assert!((price.cost(&usage) - (4.0 + 2.0 + 0.4 + 0.05)).abs() < 1e-9);
    }

    #[test]
    fn http_statuses_become_actionable_errors() {
        let rejected =
            http_failure("Anthropic", 401, "invalid x-api-key", None);
        assert_eq!(
            (rejected.error.code.as_str(), rejected.retryable),
            ("api_key_rejected", false)
        );
        assert!(http_failure("Anthropic", 529, "Overloaded", None).retryable);
        assert!(http_failure("Anthropic", 429, "", None).retryable);
        let bad = http_failure("OpenAI", 400, "max_tokens is too large", None);
        assert!(
            !bad.retryable
                && bad.error.message.contains("max_tokens is too large")
        );
    }

    #[tokio::test]
    async fn retries_passing_failures_and_gives_up_on_lasting_ones() {
        let calls = AtomicUsize::new(0);
        let ok: Result<u32> =
            with_retries(&CancellationToken::new(), || async {
                if calls.fetch_add(1, Ordering::SeqCst) < 2 {
                    Err(http_failure("X", 529, "", None))
                } else {
                    Ok(7)
                }
            })
            .await;
        assert_eq!((ok.unwrap(), calls.load(Ordering::SeqCst)), (7, 3));

        let calls = AtomicUsize::new(0);
        let fatal: Result<u32> =
            with_retries(&CancellationToken::new(), || async {
                calls.fetch_add(1, Ordering::SeqCst);
                Err(http_failure("X", 401, "", None))
            })
            .await;
        assert_eq!(
            (
                fatal.unwrap_err().code.as_str(),
                calls.load(Ordering::SeqCst)
            ),
            ("api_key_rejected", 1)
        );

        let calls = AtomicUsize::new(0);
        let exhausted: Result<u32> =
            with_retries(&CancellationToken::new(), || async {
                calls.fetch_add(1, Ordering::SeqCst);
                Err(http_failure("X", 500, "", None))
            })
            .await;
        assert_eq!(
            (
                exhausted.unwrap_err().code.as_str(),
                calls.load(Ordering::SeqCst)
            ),
            ("api_unavailable", 5)
        );
    }

    #[tokio::test]
    async fn a_cancel_ends_the_wait_between_tries() {
        let cancel = CancellationToken::new();
        let trigger = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            trigger.cancel();
        });
        let began = std::time::Instant::now();
        let result: Result<u32> = with_retries(&cancel, || async {
            Err(http_failure("X", 529, "", Some(Duration::from_secs(60))))
        })
        .await;
        assert_eq!(result.unwrap_err().code, "cancelled");
        assert!(began.elapsed() < Duration::from_secs(5));
    }
}
