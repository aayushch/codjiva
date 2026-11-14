//! Agent definitions: how to start each command-line agent, as data.
//!
//! The flags of these programs change often. So each one is described by a JSON file instead of
//! code: which program to run, with which arguments, how the prompt is passed in, and which
//! parser reads its output. Definitions are bundled with the app, and a file with the same `id`
//! in the user's `adapters` settings folder replaces the bundled one, so a changed flag can be
//! fixed without a new release.

use crate::error::{AppError, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDefinition {
    /// A stable id such as `claude-code`. Settings and manifests refer to the agent by it.
    pub id: String,
    /// The name shown to users.
    pub name: String,
    /// The program to run, by name (found on PATH) or by path.
    pub program: String,
    #[serde(default)]
    pub version_args: Vec<String>,
    #[serde(default)]
    pub help_args: Vec<String>,
    /// The arguments of every run. Values may contain placeholders, see [`Placeholders`].
    pub args: Vec<String>,
    /// Added when a model is chosen in Settings, or when the definition names a default model.
    #[serde(default)]
    pub model_args: Vec<String>,
    /// The model jobs use when Settings names none. `None` leaves the choice to the program.
    #[serde(default)]
    pub default_model: Option<String>,
    /// Added when Settings names how much effort the model should spend on thinking.
    #[serde(default)]
    pub effort_args: Vec<String>,
    /// Added when a turn continues an earlier session.
    #[serde(default)]
    pub resume_args: Vec<String>,
    /// The complete arguments of a turn that continues an earlier session, for a program whose
    /// way of continuing does not fit after its normal arguments. When this is not empty, it is
    /// used in place of `args` and `resume_args` for such a turn.
    #[serde(default)]
    pub resume_command: Vec<String>,
    /// Added when a spending limit is set in Settings.
    #[serde(default)]
    pub budget_args: Vec<String>,
    /// What to write to the program's standard input, or `None` to leave it closed.
    #[serde(default)]
    pub stdin: Option<String>,
    /// The folder the program runs in.
    pub cwd: String,
    /// The name of the parser that understands the program's output.
    pub parser: String,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// Flags that must appear in the program's help text. A missing one means the installed
    /// version no longer matches this definition, and Settings shows a warning.
    #[serde(default)]
    pub check_flags: Vec<String>,
    #[serde(default)]
    pub supports_resume: bool,
    /// False for a definition that has not been confirmed against the real program. Such an
    /// agent is offered with a warning.
    #[serde(default)]
    pub verified: bool,
    /// What the user should know about how far this agent can be confined, shown in Settings.
    /// Empty for an agent that is confined to the version folder by its own permission rules.
    #[serde(default)]
    pub limits: String,
    #[serde(default)]
    pub install_hint: String,
    #[serde(default)]
    pub login_hint: String,
}

/// The values that placeholders in a definition are replaced with for one turn.
///
///   {workspaceRoot}     absolute path of the workspace
///   {dotDirAbs}         absolute path of the workspace's .codjiva folder
///   {artifactDirAbs}    absolute path of the version folder being written
///   {jobDirAbs}         absolute path of this job's folder under .codjiva/jobs
///   {systemPromptPath}  absolute path of the assembled system prompt file
///   {userPromptPath}    absolute path of the user prompt file
///   {userPromptText}    the user prompt itself
///   {model}             the model chosen in Settings
///   {effort}            the thinking effort chosen in Settings: low, medium or high
///   {sessionId}         the session to continue
///   {maxBudgetUsd}      the spending limit
#[derive(Debug, Clone, Default)]
pub struct Placeholders {
    pub values: BTreeMap<&'static str, String>,
}

impl Placeholders {
    pub fn set(&mut self, name: &'static str, value: impl Into<String>) -> &mut Self {
        self.values.insert(name, value.into());
        self
    }

    /// Replaces every `{name}` in `template` with its value. A placeholder with no value is
    /// left as it is.
    pub fn expand(&self, template: &str) -> String {
        let mut out = template.to_string();
        for (name, value) in &self.values {
            out = out.replace(&format!("{{{name}}}"), value);
        }
        out
    }
}

/// What to start for one turn, fully resolved.
#[derive(Debug, Clone, PartialEq)]
pub struct SpawnSpec {
    pub args: Vec<String>,
    pub stdin: Option<String>,
    pub cwd: String,
    pub env: BTreeMap<String, String>,
}

impl AgentDefinition {
    /// Resolves the definition for one turn. The optional argument groups are included only
    /// when the turn has a model, an effort level, a session to resume, or a budget.
    pub fn spawn_spec(&self, values: &Placeholders) -> SpawnSpec {
        let has = |name: &str| values.values.get(name).is_some_and(|v| !v.is_empty());
        let resumes_with_own_command = has("sessionId") && !self.resume_command.is_empty();
        let base = if resumes_with_own_command { &self.resume_command } else { &self.args };
        let no_arguments = Vec::new();
        let resume_args = if resumes_with_own_command { &no_arguments } else { &self.resume_args };
        let mut args: Vec<String> = base.iter().map(|a| values.expand(a)).collect();
        for (group, needs) in [(&self.model_args, "model"), (&self.effort_args, "effort"), (resume_args, "sessionId"), (&self.budget_args, "maxBudgetUsd")] {
            if values.values.get(needs).is_some_and(|v| !v.is_empty()) {
                args.extend(group.iter().map(|a| values.expand(a)));
            }
        }
        SpawnSpec {
            args,
            stdin: self.stdin.as_ref().map(|s| values.expand(s)),
            cwd: values.expand(&self.cwd),
            env: self.env.iter().map(|(k, v)| (k.clone(), values.expand(v))).collect(),
        }
    }
}

macro_rules! adapter_file {
    ($name:literal) => {
        include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../resources/adapters/", $name))
    };
}

/// The definitions that ship with the app, in the order they are offered. An agent that is
/// installed and comes earlier in this list is used before one that comes later, unless
/// Settings names another.
const BUNDLED: &[&str] = &[
    adapter_file!("claude-code.json"), adapter_file!("codex.json"), adapter_file!("cursor-agent.json"),
    adapter_file!("gemini-cli.json"), adapter_file!("antigravity.json"), adapter_file!("pi.json"),
];

/// Loads every agent definition: the bundled ones, each replaced by a file with the same id in
/// `<config_dir>/adapters/` if there is one, plus any extra definitions found there. A file in
/// that folder that cannot be read is reported and skipped, so one bad file does not hide the
/// other agents.
pub fn load_definitions(config_dir: &Path) -> (Vec<AgentDefinition>, Vec<AppError>) {
    let mut definitions: Vec<AgentDefinition> = BUNDLED.iter().map(|text| serde_json::from_str(text).expect("a bundled adapter definition is valid")).collect();
    let mut problems = Vec::new();
    let Ok(entries) = std::fs::read_dir(config_dir.join("adapters")) else {
        return (definitions, problems);
    };
    let mut files: Vec<_> = entries.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|e| e == "json")).collect();
    files.sort();
    for file in files {
        match read_definition(&file) {
            Ok(custom) => match definitions.iter_mut().find(|d| d.id == custom.id) {
                Some(existing) => *existing = custom,
                None => definitions.push(custom),
            },
            Err(e) => problems.push(e),
        }
    }
    (definitions, problems)
}

fn read_definition(file: &Path) -> Result<AgentDefinition> {
    let text = std::fs::read_to_string(file).map_err(|e| AppError::io("read an adapter definition", e))?;
    serde_json::from_str(&text).map_err(|e| AppError::new("bad_adapter", format!("The adapter definition {} is not valid.", file.display())).with_detail(e))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn values() -> Placeholders {
        let mut v = Placeholders::default();
        v.set("workspaceRoot", "/ws").set("dotDirAbs", "/ws/.codjiva").set("artifactDirAbs", "/ws/.codjiva/artifacts/a/v1").set("systemPromptPath", "/ws/.codjiva/jobs/j1/system.md").set("userPromptText", "Do it.");
        v
    }

    #[test]
    fn every_bundled_definition_loads_names_a_known_parser_and_fills_its_placeholders() {
        let (definitions, problems) = load_definitions(Path::new("/nonexistent"));
        assert!(problems.is_empty());
        assert_eq!(definitions.iter().map(|d| d.id.as_str()).collect::<Vec<_>>(), vec!["claude-code", "codex", "cursor-agent", "gemini-cli", "antigravity", "pi"]);
        let mut v = values();
        v.set("userPromptPath", "/ws/.codjiva/jobs/j1/user-1.md").set("model", "m1").set("effort", "low");
        for definition in &definitions {
            assert!(crate::agents::parser_named(&definition.parser).is_ok(), "{}", definition.id);
            let spec = definition.spawn_spec(&v);
            let all = spec.args.iter().chain(spec.stdin.iter()).chain(spec.env.values()).cloned().collect::<Vec<_>>().join(" ");
            let unfilled = ["{systemPromptPath}", "{userPromptPath}", "{artifactDirAbs}", "{workspaceRoot}", "{dotDirAbs}", "{model}", "{effort}", "{userPromptText}"];
            assert!(!unfilled.iter().any(|name| all.contains(name)), "{}: a placeholder was left unfilled in {all}", definition.id);
            // Every agent is told where its instructions and its task are.
            assert!(all.contains("/ws/.codjiva/jobs/j1/system.md"), "{}", definition.id);
            // Only Claude Code is confined by its own rules; every other definition says so.
            assert_eq!(definition.limits.is_empty(), definition.id == "claude-code", "{}", definition.id);
        }
    }

    #[test]
    fn codex_continues_a_session_with_its_own_command_form() {
        let (definitions, _) = load_definitions(Path::new("/nonexistent"));
        let codex = definitions.iter().find(|d| d.id == "codex").unwrap();
        let mut v = values();
        v.set("userPromptPath", "/ws/.codjiva/jobs/j1/user-2.md").set("model", "gpt-x");
        let first = codex.spawn_spec(&v);
        assert_eq!(first.args[..2], ["exec", "--json"]);
        assert!(first.args.windows(2).any(|w| w == ["--model", "gpt-x"]));
        v.set("sessionId", "thread-9");
        let resumed = codex.spawn_spec(&v);
        assert_eq!(resumed.args[..4], ["exec", "resume", "thread-9", "--json"]);
        assert_eq!(resumed.args.iter().filter(|a| *a == "thread-9").count(), 1);
        assert!(resumed.args.windows(2).any(|w| w == ["--model", "gpt-x"]));

        let cursor = definitions.iter().find(|d| d.id == "cursor-agent").unwrap();
        assert!(cursor.spawn_spec(&v).args.contains(&"--resume=thread-9".to_string()));
    }

    #[test]
    fn claude_code_arguments_for_a_first_turn() {
        let (definitions, problems) = load_definitions(Path::new("/nonexistent"));
        assert!(problems.is_empty());
        let claude = definitions.iter().find(|d| d.id == "claude-code").unwrap();
        let spec = claude.spawn_spec(&values());
        assert_eq!(spec.args[..3], ["-p", "--output-format", "stream-json"]);
        // The agent may write only into the version folder of this job.
        assert!(spec.args.contains(&"Edit(//ws/.codjiva/artifacts/a/v1/**)".to_string()));
        assert!(spec.args.contains(&"Write(//ws/.codjiva/artifacts/a/v1/**)".to_string()));
        assert!(spec.args.windows(2).any(|w| w == ["--append-system-prompt-file", "/ws/.codjiva/jobs/j1/system.md"]));
        assert!(spec.args.windows(2).any(|w| w == ["--tools", "Read,Glob,Grep,Edit,Write"]));
        assert!(!spec.args.iter().any(|a| a == "--model" || a == "--resume" || a == "--max-budget-usd"));
        assert_eq!(spec.stdin.as_deref(), Some("Do it."));
        assert_eq!(spec.cwd, "/ws");
        // The prompt never travels as an argument, where it would be visible to other processes.
        assert!(!spec.args.iter().any(|a| a.contains("Do it.")));
    }

    #[test]
    fn optional_groups_are_added_only_when_their_value_is_set() {
        let (definitions, _) = load_definitions(Path::new("/nonexistent"));
        let mut v = values();
        v.set("model", "sonnet").set("sessionId", "abc").set("maxBudgetUsd", "2.5");
        let spec = definitions[0].spawn_spec(&v);
        for pair in [["--model", "sonnet"], ["--resume", "abc"], ["--max-budget-usd", "2.5"]] {
            assert!(spec.args.windows(2).any(|w| w == pair), "{pair:?}");
        }
    }

    #[test]
    fn a_user_definition_replaces_the_bundled_one_and_a_bad_file_is_reported() {
        let dir = tempfile::tempdir().unwrap();
        let adapters = dir.path().join("adapters");
        std::fs::create_dir(&adapters).unwrap();
        std::fs::write(adapters.join("claude-code.json"), r#"{"id":"claude-code","name":"Mine","program":"/opt/claude","args":["-p"],"cwd":"{workspaceRoot}","parser":"claude-stream-json"}"#).unwrap();
        std::fs::write(adapters.join("broken.json"), "{").unwrap();
        let (definitions, problems) = load_definitions(dir.path());
        assert_eq!(definitions.len(), BUNDLED.len(), "the file replaces a bundled definition and adds none");
        assert_eq!((definitions[0].name.as_str(), definitions[0].program.as_str()), ("Mine", "/opt/claude"));
        assert_eq!(problems.len(), 1);
        assert_eq!(problems[0].code, "bad_adapter");
    }
}
