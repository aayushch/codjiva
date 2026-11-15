//! The API providers the app knows, and what each needs before it can run jobs.
//!
//! Every provider appears in the list of agents next to the command-line
//! agents. A provider is usable when it has what it needs: a key, a model, and
//! for the OpenAI-compatible provider the address of the endpoint.

use crate::agents::api::anthropic::{self, Anthropic};
use crate::agents::api::backend::ApiBackend;
use crate::agents::api::google::{self, Google};
use crate::agents::api::keys::{KeySource, Keys};
use crate::agents::api::openai::{self, OpenAi};
use crate::agents::api::provider::{Provider, StopReason, UserPart};
use crate::agents::{AgentEvent, AgentInfo, Backend, Turn, TurnOutcome};
use crate::error::{AppError, Result};
use crate::settings::Settings;
use async_trait::async_trait;
use serde::Serialize;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

/// What is fixed about one provider.
pub struct ProviderSpec {
    /// The id used in Settings, in manifests and as the name of the saved key.
    pub id: &'static str,
    pub name: &'static str,
    /// The environment variables that may hold the key, in the order they are
    /// tried.
    pub env_vars: &'static [&'static str],
    /// The model used when Settings names none. `None` means the user has to
    /// choose one.
    pub default_model: Option<&'static str>,
    /// The provider's usual address. `None` means the user has to enter one.
    pub default_base_url: Option<&'static str>,
    /// True when the provider can work without a key, as local model servers
    /// do.
    pub key_optional: bool,
}

pub const PROVIDERS: [ProviderSpec; 4] = [
    ProviderSpec {
        id: "api-anthropic",
        name: "Anthropic API",
        env_vars: &["ANTHROPIC_API_KEY"],
        default_model: Some(anthropic::DEFAULT_MODEL),
        default_base_url: Some(anthropic::DEFAULT_BASE_URL),
        key_optional: false,
    },
    ProviderSpec {
        id: "api-openai",
        name: "OpenAI API",
        env_vars: &["OPENAI_API_KEY"],
        default_model: None,
        default_base_url: Some(openai::DEFAULT_BASE_URL),
        key_optional: false,
    },
    ProviderSpec {
        id: "api-google",
        name: "Google Gemini API",
        env_vars: &["GEMINI_API_KEY", "GOOGLE_API_KEY"],
        default_model: None,
        default_base_url: Some(google::DEFAULT_BASE_URL),
        key_optional: false,
    },
    ProviderSpec {
        id: "api-compatible",
        name: "OpenAI-compatible endpoint",
        env_vars: &[],
        default_model: None,
        default_base_url: None,
        key_optional: true,
    },
];

pub fn spec(provider_id: &str) -> Result<&'static ProviderSpec> {
    PROVIDERS
        .iter()
        .find(|p| p.id == provider_id)
        .ok_or_else(|| {
            AppError::new(
                "unknown_provider",
                format!("There is no API provider called {provider_id}."),
            )
        })
}

/// What Settings shows for one provider.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub id: String,
    pub name: String,
    /// Where the key in use came from, or `None` when there is no key.
    pub key_source: Option<KeySource>,
    pub key_optional: bool,
    pub env_vars: Vec<String>,
    /// The model jobs will use, or `None` when the user still has to choose
    /// one.
    pub model: Option<String>,
    pub default_model: Option<String>,
    /// The address requests go to, or `None` when the user still has to enter
    /// one.
    pub base_url: Option<String>,
    pub default_base_url: Option<String>,
    /// True when the provider has everything it needs to run a job.
    pub ok: bool,
    /// What is missing, as a sentence for the user. Empty when nothing is.
    pub note: String,
}

/// A value from Settings with surrounding spaces removed, or `None` when it is
/// empty.
fn setting(
    map: &std::collections::BTreeMap<String, String>,
    id: &str,
) -> Option<String> {
    map.get(id)
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

pub fn status(
    spec: &ProviderSpec,
    settings: &Settings,
    keys: &Keys,
) -> ProviderStatus {
    let key_source =
        keys.find(spec.id, spec.env_vars).map(|(_, source)| source);
    let model = setting(&settings.models, spec.id)
        .or_else(|| spec.default_model.map(str::to_string));
    let base_url = setting(&settings.api_base_urls, spec.id)
        .or_else(|| spec.default_base_url.map(str::to_string));
    let note = if base_url.is_none() {
        "Enter the endpoint's address in Settings.".to_string()
    } else if key_source.is_none() && !spec.key_optional {
        match spec.env_vars.first() {
            Some(variable) => format!(
                "Add an API key in Settings, or set {variable} before \
                 starting the app."
            ),
            None => "Add an API key in Settings.".to_string(),
        }
    } else if model.is_none() {
        "Choose a model in Settings.".to_string()
    } else {
        String::new()
    };
    ProviderStatus {
        id: spec.id.to_string(),
        name: spec.name.to_string(),
        key_source,
        key_optional: spec.key_optional,
        env_vars: spec.env_vars.iter().map(|v| v.to_string()).collect(),
        model,
        default_model: spec.default_model.map(str::to_string),
        base_url,
        default_base_url: spec.default_base_url.map(str::to_string),
        ok: note.is_empty(),
        note,
    }
}

pub fn statuses(settings: &Settings, keys: &Keys) -> Vec<ProviderStatus> {
    PROVIDERS
        .iter()
        .map(|spec| status(spec, settings, keys))
        .collect()
}

/// The name of a custom endpoint in messages to the user: the host part of its
/// address.
fn host_of(base_url: &str) -> String {
    let rest = base_url
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(base_url);
    rest.split('/').next().unwrap_or(rest).to_string()
}

/// Builds the client for a provider from the saved key and Settings. Fails with
/// the provider's status note when something it needs is missing.
pub fn provider(
    spec: &ProviderSpec,
    settings: &Settings,
    keys: &Keys,
) -> Result<Arc<dyn Provider>> {
    let status = status(spec, settings, keys);
    if !status.ok {
        return Err(AppError::new(
            "provider_not_ready",
            format!("{} is not set up. {}", spec.name, status.note),
        ));
    }
    let key = keys
        .find(spec.id, spec.env_vars)
        .map(|(key, _)| key)
        .unwrap_or_default();
    let model = status.model.unwrap_or_default();
    let base_url = status.base_url;
    Ok(match spec.id {
        "api-anthropic" => {
            Arc::new(Anthropic::new(key, Some(model), base_url)?)
        }
        "api-google" => Arc::new(Google::new(key, model, base_url)?),
        "api-openai" => Arc::new(OpenAi::new("OpenAI", key, model, base_url)?),
        _ => {
            let label = base_url
                .as_deref()
                .map(host_of)
                .unwrap_or_else(|| "the endpoint".to_string());
            Arc::new(OpenAi::new(&label, key, model, base_url)?)
        }
    })
}

/// A provider that is listed but cannot run a job yet. Its note says what is
/// missing.
struct NotReady {
    info: AgentInfo,
}

#[async_trait]
impl Backend for NotReady {
    fn info(&self) -> AgentInfo {
        self.info.clone()
    }

    async fn run(
        &self,
        _turn: &Turn,
        _cancel: &CancellationToken,
        _on_event: &(dyn Fn(AgentEvent) + Send + Sync),
    ) -> Result<TurnOutcome> {
        Err(AppError::new(
            "provider_not_ready",
            format!("{} is not set up. {}", self.info.name, self.info.note),
        ))
    }
}

/// One entry in the list of agents for every provider, usable or not.
pub fn backends(settings: &Settings, keys: &Keys) -> Vec<Arc<dyn Backend>> {
    PROVIDERS
        .iter()
        .map(|spec| {
            let status = status(spec, settings, keys);
            let mut info = AgentInfo {
                id: spec.id.to_string(),
                name: spec.name.to_string(),
                kind: "api".to_string(),
                path: None,
                // The model stands where a command-line agent shows its
                // version.
                version: status.model.clone(),
                ok: status.ok,
                note: status.note.clone(),
                supports_resume: true,
                verified: true,
                default_model: None,
                limits: String::new(),
            };
            match provider(spec, settings, keys) {
                Ok(client) => {
                    Arc::new(ApiBackend::new(info, client)) as Arc<dyn Backend>
                }
                Err(error) => {
                    info.ok = false;
                    if info.note.is_empty() {
                        info.note = error.message;
                    }
                    Arc::new(NotReady { info })
                }
            }
        })
        .collect()
}

/// Sends one very small request to find out whether the key, the model and the
/// address work. Returns the name of the model that answered.
pub async fn check(
    spec: &ProviderSpec,
    settings: &Settings,
    keys: &Keys,
) -> Result<String> {
    let client = provider(spec, settings, keys)?;
    let mut conversation = client.start(
        "You are answering a connection test.".to_string(),
        Vec::new(),
        None,
    );
    let reply = conversation
        .send(
            vec![UserPart::Text(
                "Reply with the single word: ready".to_string(),
            )],
            &CancellationToken::new(),
        )
        .await?;
    if let StopReason::Refusal(why) = reply.stop {
        return Err(AppError::new(
            "api_refused",
            format!(
                "{} answered, but declined the test request. {why}",
                spec.name
            ),
        ));
    }
    Ok(reply
        .model
        .or_else(|| status(spec, settings, keys).model)
        .unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::api::keys::MemoryKeyStore;
    use crate::agents::api::testing::{Canned, MockServer};
    use serde_json::json;

    fn keys() -> Keys {
        Keys::new(Box::new(MemoryKeyStore::default()))
    }

    /// The status of one provider, with the environment variables of the real
    /// providers ignored so a key on the developer's machine cannot change the
    /// result.
    fn status_of(id: &str, settings: &Settings, keys: &Keys) -> ProviderStatus {
        let real = spec(id).unwrap();
        let isolated = ProviderSpec {
            id: real.id,
            name: real.name,
            env_vars: &[],
            default_model: real.default_model,
            default_base_url: real.default_base_url,
            key_optional: real.key_optional,
        };
        status(&isolated, settings, keys)
    }

    #[test]
    fn each_provider_says_what_it_still_needs() {
        let keys = keys();
        let mut settings = Settings::default();
        let anthropic = status_of("api-anthropic", &settings, &keys);
        assert!(!anthropic.ok && anthropic.note.starts_with("Add an API key"));
        assert_eq!(anthropic.model.as_deref(), Some("claude-opus-5-5"));

        keys.save("api-anthropic", "sk-a").unwrap();
        let anthropic = status_of("api-anthropic", &settings, &keys);
        assert_eq!(
            (anthropic.ok, anthropic.key_source),
            (true, Some(KeySource::Saved))
        );

        keys.save("api-openai", "sk-o").unwrap();
        assert_eq!(
            status_of("api-openai", &settings, &keys).note,
            "Choose a model in Settings."
        );
        settings
            .models
            .insert("api-openai".into(), " gpt-x ".into());
        let openai = status_of("api-openai", &settings, &keys);
        assert_eq!((openai.ok, openai.model.as_deref()), (true, Some("gpt-x")));

        assert_eq!(
            status_of("api-compatible", &settings, &keys).note,
            "Enter the endpoint's address in Settings."
        );
        settings.api_base_urls.insert(
            "api-compatible".into(),
            "http://localhost:11434/v1".into(),
        );
        assert_eq!(
            status_of("api-compatible", &settings, &keys).note,
            "Choose a model in Settings."
        );
        settings
            .models
            .insert("api-compatible".into(), "llama".into());
        assert!(
            status_of("api-compatible", &settings, &keys).ok,
            "a local endpoint needs no key"
        );
    }

    #[test]
    fn every_provider_is_listed_as_an_agent_and_only_ready_ones_are_usable() {
        let keys = keys();
        let mut settings = Settings::default();
        settings.api_base_urls.insert(
            "api-compatible".into(),
            "http://localhost:11434/v1".into(),
        );
        settings
            .models
            .insert("api-compatible".into(), "llama".into());
        let listed: Vec<AgentInfo> = backends(&settings, &keys)
            .iter()
            .map(|b| b.info())
            .collect();
        assert_eq!(
            listed.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(),
            vec![
                "api-anthropic",
                "api-openai",
                "api-google",
                "api-compatible"
            ]
        );
        let compatible = &listed[3];
        assert_eq!(
            (
                compatible.ok,
                compatible.kind.as_str(),
                compatible.version.as_deref()
            ),
            (true, "api", Some("llama"))
        );
        assert_eq!(host_of("http://localhost:11434/v1"), "localhost:11434");
    }

    #[tokio::test]
    async fn the_connection_test_sends_one_small_request_without_tools() {
        let chunk = json!({
            "model": "llama-3",
            "choices": [{
                "index": 0,
                "delta": { "content": "ready" },
                "finish_reason": "stop"
            }]
        });
        let server = MockServer::start(vec![
            Canned::sse_with_done(&[chunk]),
            Canned::error(401, json!({ "error": { "message": "bad key" } })),
        ])
        .await;
        let keys = keys();
        let mut settings = Settings::default();
        settings
            .api_base_urls
            .insert("api-compatible".into(), server.url.clone());
        settings
            .models
            .insert("api-compatible".into(), "llama".into());
        let spec = spec("api-compatible").unwrap();
        assert_eq!(check(spec, &settings, &keys).await.unwrap(), "llama-3");
        assert!(server.recorded()[0].body.get("tools").is_none());
        assert_eq!(
            check(spec, &settings, &keys).await.unwrap_err().code,
            "api_key_rejected"
        );
    }
}
