//! Which kind of artifact suits a file.
//!
//! Six kinds of artifact can be made of one file, see [`KINDS`]. Which of
//! them explains a file best depends on what the file is, and a user who has
//! not read the file yet cannot know. [`ask`] puts the question to an agent:
//! the agent is given the file with a list of what it defines, and answers
//! with the six kinds in order, each with one sentence of reason.
//!
//! An answer is kept in the workspace's `.codjiva/suggestions` folder with
//! the hash of the file it was given for. [`cached`] returns it for as long
//! as the file has that content, so the question is asked once for each
//! version of a file.
//!
//! The agent draws nothing in this turn. It gets the same permissions as in
//! a job, and the folder it may write to is an empty folder that is deleted
//! afterwards. The agent is asked to give its answer as its reply. Some
//! agents write it to a file in that folder all the same, so the answer is
//! read from there when the reply holds none (see [`answer_in_files`]).

use crate::agents::{AgentEvent, Backend, Turn};
use crate::error::{AppError, Result};
use crate::workspace::{hash_bytes, Workspace};
use crate::{lang, nav, prompts, util};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

/// The kinds of artifact that can be made of one file, as the answer names
/// them.
pub const KINDS: [&str; 6] = [
    "visual",
    "film",
    "stepthrough",
    "schema",
    "lanes",
    "structure",
];

/// The agent is stopped when it has not answered after this long.
const TIME_LIMIT: Duration = Duration::from_secs(120);

/// At most this much of the file is put in the question. A longer file is
/// cut at the end of a line, and the question says so.
const MAX_TEXT_BYTES: usize = 24_000;

/// At most this many definitions and this many imports are listed.
const MAX_OUTLINE: usize = 200;
const MAX_IMPORTS: usize = 40;

/// The longest reason that is kept, in characters.
const MAX_REASON_CHARS: usize = 240;

/// One kind with the reason the agent gave for its place in the order.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ranked {
    /// One of [`KINDS`].
    pub kind: String,
    pub reason: String,
}

/// The answer to which kind suits a file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    /// The file the answer is about, relative to the workspace root.
    pub path: String,
    /// The kinds, best first. A kind the agent left out is not listed.
    pub ranked: Vec<Ranked>,
    /// The name of the agent that answered, and the model where it is known.
    pub agent: String,
    pub model: Option<String>,
    pub created_at: String,
    /// The hash of the file's content when the question was asked.
    pub source_hash: String,
}

/// Where the answer for the file at `rel` is kept. The file name is made
/// from the hash of the path, so that any path gives a valid name.
fn cache_path(ws: &Workspace, rel: &str) -> PathBuf {
    let hash = hash_bytes(rel.as_bytes());
    let name = hash.trim_start_matches("sha256:");
    ws.dot_dir()
        .join("suggestions")
        .join(format!("{}.json", &name[..24.min(name.len())]))
}

/// The kept answer for the file at `rel`, or `None` when the question was
/// never asked for it, and when the file has changed since it was asked.
pub fn cached(ws: &Workspace, rel: &str) -> Option<Suggestion> {
    let kept: Suggestion = util::read_json(&cache_path(ws, rel)).ok()??;
    let now = ws.hash_file(rel)?;
    (kept.path == rel && kept.source_hash == now).then_some(kept)
}

/// The question about the file at `rel` with the content `text`: the file's
/// facts, what it imports, what it defines, and the text itself.
fn question(rel: &str, text: &str) -> String {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    let language = lang::of_file_name(name).map_or("unknown", |l| l.label);
    let outline: Vec<String> = nav::definitions_of(rel, text.to_string())
        .into_iter()
        .take(MAX_OUTLINE)
        .map(|def| {
            let kind = format!("{:?}", def.kind).to_lowercase();
            let prototype = if def.declaration { " (prototype)" } else { "" };
            match def.container {
                Some(owner) => format!(
                    "{} {kind} {owner}.{}{prototype}",
                    def.line, def.name
                ),
                None => format!("{} {kind} {}{prototype}", def.line, def.name),
            }
        })
        .collect();
    let imports: Vec<String> = nav::imports::imported_specifiers(text)
        .into_iter()
        .take(MAX_IMPORTS)
        .map(|one| format!("- `{one}`"))
        .collect();
    // A long file is cut at the end of the last line that fits.
    let (shown, cut) = if text.len() <= MAX_TEXT_BYTES {
        (text, String::new())
    } else {
        let mut end = MAX_TEXT_BYTES;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        let end = text[..end].rfind('\n').map_or(end, |at| at + 1);
        (&text[..end], text[..end].lines().count().to_string())
    };
    let mut values = prompts::Values::new();
    values.insert("path", rel.to_string());
    values.insert("language", language.to_string());
    values.insert("lines", text.lines().count().to_string());
    values.insert("imports", imports.join("\n"));
    values.insert("outline", outline.join("\n"));
    values.insert("cut", cut);
    values.insert("text", shown.to_string());
    prompts::user_suggest(&values)
}

/// Reads the kinds and their reasons out of what the agent wrote.
///
/// The agent is asked for one JSON object with a list called `ranked`. Some
/// agents put words or a code fence around it, and some report their answer
/// twice. So every `{` of the text is tried as the start of an object, and
/// the last object that has a `ranked` list is used.
///
/// An entry is dropped when its kind is not one of [`KINDS`], and when the
/// kind was already listed. Returns `None` when no entry is left.
fn parse(text: &str) -> Option<Vec<Ranked>> {
    let mut found: Option<Vec<Value>> = None;
    for (at, _) in text.match_indices('{') {
        let mut values = serde_json::Deserializer::from_str(&text[at..])
            .into_iter::<Value>();
        let Some(Ok(value)) = values.next() else {
            continue;
        };
        if let Some(list) = value.get("ranked").and_then(Value::as_array) {
            found = Some(list.clone());
        }
    }
    let mut ranked: Vec<Ranked> = Vec::new();
    for entry in found? {
        let Some(kind) = entry.get("kind").and_then(Value::as_str) else {
            continue;
        };
        let kind = kind.trim().to_lowercase();
        if !KINDS.contains(&kind.as_str())
            || ranked.iter().any(|one| one.kind == kind)
        {
            continue;
        }
        let reason = entry.get("reason").and_then(Value::as_str).unwrap_or("");
        let reason = reason.split_whitespace().collect::<Vec<_>>().join(" ");
        ranked.push(Ranked {
            kind,
            reason: reason.chars().take(MAX_REASON_CHARS).collect(),
        });
    }
    (!ranked.is_empty()).then_some(ranked)
}

/// Reads the answer from the files the agent wrote, for an agent that put its
/// answer in a file and not in its reply.
///
/// `dir` is the folder the agent was allowed to write to. Every file in it
/// whose name ends in `.json` is tried, in the order of their names, and the
/// first one [`parse`] can read is used. Folders inside `dir` are not looked
/// into. Returns `None` when no file holds an answer.
fn answer_in_files(dir: &std::path::Path) -> Option<Vec<Ranked>> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_file() && path.extension().is_some_and(|e| e == "json")
        })
        .collect();
    files.sort();
    files
        .iter()
        .filter_map(|file| std::fs::read_to_string(file).ok())
        .find_map(|text| parse(&text))
}

/// Asks the agent `backend` which kind suits the file at `rel`, keeps the
/// answer and returns it. `model` is the model to ask, or `None` for the
/// agent's own choice. `customizations` says whether the agent may load the
/// user's own setup for it (see `Turn::customizations`).
///
/// The call takes as long as the agent needs to start and to answer, which
/// is a few seconds for most. Triggering `cancel` ends it early with an
/// error, and so does [`TIME_LIMIT`].
pub async fn ask(
    ws: &Workspace,
    backend: &dyn Backend,
    model: Option<String>,
    customizations: bool,
    rel: &str,
    cancel: &CancellationToken,
) -> Result<Suggestion> {
    let failed = |message: &str| AppError::new("suggest_failed", message);
    let content = ws.read_text(rel)?;
    if content.text.trim().is_empty() {
        return Err(failed("That file is empty or is not text."));
    }
    let source_hash = ws
        .hash_file(rel)
        .ok_or_else(|| failed("Could not read that file."))?;

    // The files of the turn are in a folder of their own, next to the
    // folders of jobs. `out` is the folder the agent may write to. The
    // answer is expected in the agent's reply, and is read from a file in
    // `out` only when the reply holds none.
    let job_dir = ws
        .dot_dir()
        .join("jobs")
        .join(format!("suggest-{}", crate::jobs::new_job_id()));
    let out_dir = job_dir.join("out");
    std::fs::create_dir_all(&out_dir)
        .map_err(|e| AppError::io("prepare the question", e))?;
    let user_prompt = question(rel, &content.text);
    let system_prompt_path = job_dir.join("system.md");
    let user_prompt_path = job_dir.join("user.md");
    util::write_atomic(&system_prompt_path, prompts::system_suggest())?;
    util::write_atomic(&user_prompt_path, &user_prompt)?;
    let turn = Turn {
        workspace_root: ws.root().to_path_buf(),
        dot_dir: ws.dot_dir(),
        artifact_dir: out_dir,
        job_dir: job_dir.clone(),
        system_prompt_path,
        user_prompt_path,
        user_prompt,
        resume_session: None,
        model,
        effort: Some("low".to_string()),
        max_budget_usd: None,
        customizations,
        log_path: job_dir.join("agent.log.jsonl"),
    };

    let said = Mutex::new(String::new());
    let mut timed_out = false;
    let outcome = {
        let on_event = |event: AgentEvent| {
            if let AgentEvent::Text(text) = event {
                let mut said = said.lock().expect("the lock is not poisoned");
                said.push_str(&text);
                said.push('\n');
            }
        };
        let run = backend.run(&turn, cancel, &on_event);
        tokio::pin!(run);
        tokio::select! {
            outcome = &mut run => outcome,
            _ = tokio::time::sleep(TIME_LIMIT) => {
                timed_out = true;
                cancel.cancel();
                run.await
            }
        }
    };
    let said = said.into_inner().expect("the lock is not poisoned");
    // The folder is kept when the turn failed, so that the agent's output
    // in `agent.log.jsonl` can be looked at.
    let answer = match outcome {
        Err(error) => Err(error),
        Ok(_) if timed_out => {
            Err(failed("The agent did not answer in time. Try again."))
        }
        Ok(outcome) if outcome.cancelled => {
            Err(AppError::new("cancelled", "The question was cancelled."))
        }
        Ok(outcome) => match (
            outcome.error,
            parse(&said).or_else(|| answer_in_files(&turn.artifact_dir)),
        ) {
            (_, Some(ranked)) => Ok((ranked, outcome.model)),
            (Some(error), None) => Err(failed(&error)),
            (None, None) => {
                Err(failed("The agent's answer could not be read. Try again.")
                    .with_detail(said.chars().take(400).collect::<String>()))
            }
        },
    };
    let (ranked, model_used) = answer?;
    let _ = std::fs::remove_dir_all(&job_dir);

    let suggestion = Suggestion {
        path: rel.to_string(),
        ranked,
        agent: backend.info().name,
        model: model_used.or(turn.model),
        created_at: util::now_rfc3339(),
        source_hash,
    };
    let kept_at = cache_path(ws, rel);
    if let Some(folder) = kept_at.parent() {
        std::fs::create_dir_all(folder)
            .map_err(|e| AppError::io("keep the suggestion", e))?;
    }
    util::write_json(&kept_at, &suggestion)?;
    Ok(suggestion)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::{AgentInfo, TurnOutcome};
    use async_trait::async_trait;
    use std::fs;

    /// An agent that writes `says` as its reply and remembers the turn it
    /// was given. When `writes` is set, it also writes a file with that
    /// name and content into the folder the turn allows it to write to.
    struct Scripted {
        says: String,
        writes: Option<(String, String)>,
        turns: Mutex<Vec<Turn>>,
    }

    impl Scripted {
        fn saying(says: &str) -> Scripted {
            Scripted {
                says: says.to_string(),
                writes: None,
                turns: Mutex::new(Vec::new()),
            }
        }

        fn writing(says: &str, name: &str, content: &str) -> Scripted {
            Scripted {
                writes: Some((name.to_string(), content.to_string())),
                ..Scripted::saying(says)
            }
        }
    }

    #[async_trait]
    impl Backend for Scripted {
        fn info(&self) -> AgentInfo {
            AgentInfo {
                id: "scripted".into(),
                name: "Scripted Agent".into(),
                kind: "replay".into(),
                path: None,
                version: None,
                ok: true,
                note: String::new(),
                supports_resume: false,
                verified: true,
                default_model: None,
                quick_model: Some("small".into()),
                limits: String::new(),
                plain_args: Vec::new(),
                plain_note: String::new(),
            }
        }

        async fn run(
            &self,
            turn: &Turn,
            _cancel: &CancellationToken,
            on_event: &(dyn Fn(AgentEvent) + Send + Sync),
        ) -> Result<TurnOutcome> {
            self.turns.lock().unwrap().push(turn.clone());
            if let Some((name, content)) = &self.writes {
                fs::write(turn.artifact_dir.join(name), content).unwrap();
            }
            on_event(AgentEvent::Text(self.says.clone()));
            Ok(TurnOutcome::default())
        }
    }

    const QUEUE: &str =
        "package queue\n\nimport \"sync\"\n\ntype Queue struct \
                         {\n\tmu    sync.Mutex\n\titems []string\n}\n\nfunc \
                         (q *Queue) Push(item string) {\n\tq.items = \
                         append(q.items, item)\n}\n";

    fn workspace() -> (tempfile::TempDir, Workspace) {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("pkg")).unwrap();
        fs::write(dir.path().join("pkg/queue.go"), QUEUE).unwrap();
        let ws = Workspace::open(dir.path()).unwrap();
        (dir, ws)
    }

    fn kinds(ranked: &[Ranked]) -> Vec<&str> {
        ranked.iter().map(|one| one.kind.as_str()).collect()
    }

    #[test]
    fn an_answer_is_read_with_words_and_a_fence_around_it() {
        let ranked = parse(
            "Here is the ranking.\n```json\n{\"ranked\": [{\"kind\": \
             \"Structure\", \"reason\": \"Queue  keeps\\n items.\"}, \
             {\"kind\": \"visual\", \"reason\": \"Push is short.\"}]}\n```\n",
        )
        .unwrap();
        assert_eq!(kinds(&ranked), ["structure", "visual"]);
        assert_eq!(ranked[0].reason, "Queue keeps items.");
    }

    #[test]
    fn unknown_and_repeated_kinds_are_dropped() {
        let ranked = parse(
            "{\"ranked\": [{\"kind\": \"poster\", \"reason\": \"x\"}, \
             {\"kind\": \"lanes\", \"reason\": \"a\"}, {\"kind\": \"lanes\", \
             \"reason\": \"b\"}, {\"reason\": \"no kind\"}]}",
        )
        .unwrap();
        assert_eq!(kinds(&ranked), ["lanes"]);
        assert_eq!(ranked[0].reason, "a");
    }

    #[test]
    fn the_last_answer_is_used_when_the_agent_reports_it_twice() {
        let once = "{\"ranked\": [{\"kind\": \"schema\", \"reason\": \"r\"}]}";
        let ranked =
            parse(&format!("{{\"note\": 1}}\n{once}\n{once}")).unwrap();
        assert_eq!(kinds(&ranked), ["schema"]);
    }

    #[test]
    fn text_without_a_ranking_gives_nothing() {
        assert!(parse("I think a visual would be best.").is_none());
        assert!(parse("{\"ranked\": []}").is_none());
        assert!(parse("{\"ranked\": [{\"kind\": \"poster\"}]}").is_none());
    }

    #[test]
    fn the_question_holds_the_facts_the_outline_and_the_text() {
        let asked = question("pkg/queue.go", QUEUE);
        assert!(asked.contains("- Path: `pkg/queue.go`"), "{asked}");
        assert!(asked.contains("- Language: Go"), "{asked}");
        assert!(asked.contains("- `sync`"), "{asked}");
        assert!(asked.contains("5 struct Queue"), "{asked}");
        assert!(asked.contains("7 field Queue.items"), "{asked}");
        assert!(asked.contains("10 method Queue.Push"), "{asked}");
        assert!(asked.contains("## The file\n"), "{asked}");
        assert!(asked.contains("q.items = append(q.items, item)"));
    }

    #[test]
    fn a_long_file_is_cut_at_the_end_of_a_line() {
        let line = "// a line of filler text that is repeated many times\n";
        let long = line.repeat(1000);
        let asked = question("notes.go", &long);
        let kept = MAX_TEXT_BYTES / line.len();
        assert!(
            asked.contains(&format!("## The file (its first {kept} lines)")),
            "{}",
            &asked[..400]
        );
        assert!(asked.contains("- Lines: 1000"));
        assert_eq!(asked.matches("a line of filler").count(), kept);
    }

    #[tokio::test]
    async fn an_answer_is_kept_until_the_file_changes() {
        let (dir, ws) = workspace();
        assert!(cached(&ws, "pkg/queue.go").is_none());
        let agent = Scripted::saying(
            "{\"ranked\": [{\"kind\": \"structure\", \"reason\": \"Queue \
             keeps items in order.\"}, {\"kind\": \"visual\", \"reason\": \
             \"Push does one thing.\"}]}",
        );
        let cancel = CancellationToken::new();
        let model = agent.info().quick_model;
        let made = ask(&ws, &agent, model, false, "pkg/queue.go", &cancel)
            .await
            .unwrap();
        assert_eq!(kinds(&made.ranked), ["structure", "visual"]);
        assert_eq!(made.agent, "Scripted Agent");
        assert_eq!(made.model.as_deref(), Some("small"));

        // The agent was asked with the small model and little effort, and
        // was given the file and the guide.
        let turns = agent.turns.lock().unwrap();
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].model.as_deref(), Some("small"));
        assert_eq!(turns[0].effort.as_deref(), Some("low"));
        assert!(turns[0].user_prompt.contains("type Queue struct"));
        // The folder of the turn is removed after a good answer.
        assert!(!turns[0].job_dir.exists());

        assert_eq!(cached(&ws, "pkg/queue.go"), Some(made));
        fs::write(dir.path().join("pkg/queue.go"), format!("{QUEUE}\n// x\n"))
            .unwrap();
        assert!(cached(&ws, "pkg/queue.go").is_none());
    }

    #[tokio::test]
    async fn an_answer_that_cannot_be_read_is_an_error_and_is_not_kept() {
        let (_dir, ws) = workspace();
        let agent = Scripted::saying("A structure view, I would say.");
        let cancel = CancellationToken::new();
        let error = ask(&ws, &agent, None, false, "pkg/queue.go", &cancel)
            .await
            .unwrap_err();
        assert_eq!(error.code, "suggest_failed");
        assert!(cached(&ws, "pkg/queue.go").is_none());
        // The folder of the turn stays, for looking at what the agent
        // wrote.
        let turns = agent.turns.lock().unwrap();
        assert!(turns[0].job_dir.join("user.md").is_file());
    }

    #[tokio::test]
    async fn an_answer_written_to_a_file_is_read_when_the_reply_holds_none() {
        const IN_FILE: &str = "{\"ranked\": [{\"kind\": \"structure\", \
                               \"reason\": \"Queue keeps items.\"}, \
                               {\"kind\": \"visual\", \"reason\": \"Push \
                               is short.\"}]}";
        let (_dir, ws) = workspace();
        let cancel = CancellationToken::new();

        // The reply only says that a file was written.
        let agent = Scripted::writing(
            "Done. The ranking is in ranked.json.",
            "ranked.json",
            IN_FILE,
        );
        let made = ask(&ws, &agent, None, false, "pkg/queue.go", &cancel)
            .await
            .unwrap();
        assert_eq!(kinds(&made.ranked), ["structure", "visual"]);
        assert_eq!(cached(&ws, "pkg/queue.go"), Some(made));
        assert!(!agent.turns.lock().unwrap()[0].job_dir.exists());

        // A reply that holds an answer is used, and the file is not.
        let agent = Scripted::writing(
            "{\"ranked\": [{\"kind\": \"lanes\", \"reason\": \"a\"}]}",
            "ranked.json",
            IN_FILE,
        );
        let made = ask(&ws, &agent, None, false, "pkg/queue.go", &cancel)
            .await
            .unwrap();
        assert_eq!(kinds(&made.ranked), ["lanes"]);

        // A file that holds no ranking is not an answer.
        let agent = Scripted::writing(
            "Done.",
            "notes.json",
            "{\"kinds\": [\"structure\"]}",
        );
        let error = ask(&ws, &agent, None, false, "pkg/queue.go", &cancel)
            .await
            .unwrap_err();
        assert_eq!(error.code, "suggest_failed");
    }

    /// Asks the Claude Code program installed on this computer about a file
    /// of a fixture, with its small model. The run uses the user's own
    /// allowance of that program, so the test only runs when it is asked
    /// for by name:
    ///
    ///   cargo test -p codjiva-core real_claude_code -- --ignored --nocapture
    #[tokio::test]
    #[ignore = "starts the real Claude Code program"]
    async fn the_real_claude_code_ranks_a_fixture_file() {
        use crate::agents::{definition, detect_cli_agents};
        use crate::env::ShellEnv;
        use std::collections::BTreeMap;
        use std::sync::Arc;

        let dir = tempfile::tempdir().unwrap();
        let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../fixtures/go-orders/internal/orders/handler.go");
        fs::create_dir_all(dir.path().join("internal/orders")).unwrap();
        fs::copy(fixture, dir.path().join("internal/orders/handler.go"))
            .unwrap();
        let ws = Workspace::open(dir.path()).unwrap();

        let (definitions, _) = definition::load_definitions(dir.path());
        let env = Arc::new(ShellEnv::capture());
        let agent = detect_cli_agents(&definitions, &env, &BTreeMap::new())
            .into_iter()
            .find(|agent| agent.info().id == "claude-code" && agent.info().ok)
            .expect("Claude Code is installed");
        let model = agent.info().quick_model;
        let cancel = CancellationToken::new();
        let began = std::time::Instant::now();
        let made = ask(
            &ws,
            &agent,
            model,
            false,
            "internal/orders/handler.go",
            &cancel,
        )
        .await
        .unwrap();
        println!("answered in {:?} by {:?}", began.elapsed(), made.model);
        for one in &made.ranked {
            println!("  {}: {}", one.kind, one.reason);
        }
        assert_eq!(made.ranked.len(), KINDS.len());
        assert!(made.ranked.iter().all(|one| !one.reason.is_empty()));
    }
}
