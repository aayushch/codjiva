//! Discussions: questions the user asks about code or about a visual of it,
//! and the answers an agent gives.
//!
//! A discussion is a [`Thread`]. It is about one of two things:
//!
//!   - a visual, film or view of a whole file, folder or pipeline. The thread
//!     then holds that artifact's id.
//!   - a part of one file. The thread then holds that part as a
//!     [`Scope`]. Visuals that are made of the same part share the scope's
//!     id, so the thread and those visuals are shown together.
//!
//! Each thread is one file in the workspace's `.codjiva/threads` folder. The
//! folder is shared with a team exactly when the `.codjiva` folder is tracked
//! by git.
//!
//! [`ask`] puts one question to an agent and adds the question and the answer
//! to the thread. The agent draws nothing in that turn. It gets the same
//! permissions as in a job, and the folder it may write to is an empty folder
//! that is deleted afterwards.
//!
//! The same conversation. Where the agent can continue a conversation, a
//! question continues the one the thread already has. The first question
//! about a visual continues the conversation that drew the visual, so the
//! agent has already read the code. A turn that cannot be continued, for
//! example because the conversation was made on another computer, is asked
//! again as a new conversation that is given the text of the thread.
//!
//! Notes. An answer may end with a block that puts notes on parts of the
//! visual on screen (see [`Note`]). The notes are kept with the answer. The
//! interface sends them to the visual, which draws them without being built
//! again.

use crate::agents::{AgentEvent, AgentInfo, Backend, Turn};
use crate::artifacts::{self, ArtifactKind};
use crate::env::run_capture;
use crate::error::{AppError, Result};
use crate::jobs::{self, Claim};
use crate::scope::{self, Located, Scope};
use crate::workspace::Workspace;
use crate::{prompts, util};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

pub const SCHEMA_VERSION: u32 = 1;

/// The agent is stopped when it has not answered after this long.
const TIME_LIMIT: Duration = Duration::from_secs(300);

/// At most this much of a scope's code is put in the question. Longer code
/// is cut at the end of a line. The agent can read the file for the rest.
const MAX_CODE_BYTES: usize = 16_000;

/// At most this many parts of a visual are listed in the question.
const MAX_PARTS: usize = 150;

/// At most this many notes are kept from one answer, and the longest text of
/// one note in characters.
const MAX_NOTES: usize = 6;
const MAX_NOTE_CHARS: usize = 240;

/// The longest title of a thread, in characters.
const MAX_TITLE_CHARS: usize = 80;

/// How long after the start of its chapter a note of a film is shown, when
/// the agent named only the chapter.
const NOTE_INTO_CHAPTER: f64 = 0.3;

/// Who wrote a message.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    User,
    Agent,
}

/// What a note is for. The visual draws each kind differently.
#[derive(
    Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize,
)]
#[serde(rename_all = "lowercase")]
pub enum NoteKind {
    /// An explanation.
    #[default]
    Note,
    /// Something a reader should be careful about.
    Flag,
    /// The part is made to stand out and nothing more is said.
    Emphasis,
}

/// A note an answer puts on the visual that was on screen.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    /// Unique within the workspace: the thread's id, the number of the
    /// answer and the number of the note in it.
    pub id: String,
    /// The artifact the note is drawn on.
    pub artifact_id: String,
    /// For a visual or a view: the id of the node the note is on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub part: Option<String>,
    /// For a film: the moment the note is shown at, in real seconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time: Option<f64>,
    #[serde(default)]
    pub kind: NoteKind,
    pub text: String,
}

/// A place in the code that an answer names and that exists. `text` is the
/// place as the answer writes it, such as `handler.go:42`, so the interface
/// can find it in the answer and make it a link.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnswerRef {
    pub text: String,
    pub path: String,
    pub line: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end: Option<u32>,
}

/// What the user was looking at when they asked.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct About {
    /// The visual on screen and its version.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artifact_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<u32>,
    /// The id of the part that was selected in it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub part: Option<String>,
    /// Where a film was, in real seconds, and the title of that chapter.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chapter: Option<String>,
}

/// One question or one answer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub role: Role,
    pub text: String,
    pub created_at: String,
    /// For a question: the name of the person who asked, as git knows it.
    /// For an answer: the name of the agent.
    #[serde(default)]
    pub author: String,
    /// For an answer: the model, where the agent reports it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// For a question: what the user was looking at.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub about: Option<About>,
    /// For an answer: the places in the code it names that exist.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub refs: Vec<AnswerRef>,
    /// For an answer: the notes it puts on the visual.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub notes: Vec<Note>,
}

/// The agent conversation a thread continues.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    /// The agent's id, such as `claude-code`.
    pub agent: String,
    pub session_id: String,
}

/// One discussion, as its file holds it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    pub schema_version: u32,
    pub id: String,
    /// The first question, shortened.
    pub title: String,
    /// The file the thread belongs to, relative to the workspace root. A
    /// folder ends with a slash. Empty for a thread about a pipeline.
    pub path: String,
    /// The part of the file the thread is about. `None` for a thread about a
    /// visual of a whole file, folder or pipeline.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<Scope>,
    /// The artifact the thread is about, for a thread without a scope.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifact_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    /// The conversation the next question continues, when the agent of that
    /// question is the same and can continue one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<Session>,
    pub messages: Vec<Message>,
}

/// A thread as the interface gets it: the thread, and where its scope is in
/// the file now.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadView {
    #[serde(flatten)]
    pub thread: Thread,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope_now: Option<Located>,
}

/// One question, as the interface sends it.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AskRequest {
    /// The thread to add to. `None` starts a new thread.
    pub thread_id: Option<String>,
    /// For a new thread: the file it belongs to, and what it is about. A
    /// thread about a part of a file gives `scope`. Any other thread gives
    /// the artifact in `about`.
    pub path: String,
    pub scope: Option<Scope>,
    /// The user's words.
    pub text: String,
    /// What the user was looking at.
    pub about: About,
}

/// What a question reports while its agent works.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AskEvent {
    /// An agent is about to be asked. `continues` is true when it continues
    /// an earlier conversation.
    Started { agent: String, continues: bool },
    /// Prose from the agent. What it writes after its last use of a tool is
    /// its answer.
    Text { text: String },
    /// The agent used a tool, for example to read a file.
    Tool { name: String, summary: String },
    /// Something the user should know, such as that the earlier conversation
    /// could not be continued.
    Notice { text: String },
}

/// How a question is asked: with which model and effort, and whether the
/// agent may load the user's own setup for it (see `Turn::customizations`).
#[derive(Debug, Clone, Default)]
pub struct AskOptions {
    pub model: Option<String>,
    pub effort: Option<String>,
    pub customizations: bool,
}

pub fn threads_dir(ws: &Workspace) -> PathBuf {
    ws.dot_dir().join("threads")
}

/// A thread's id is the name of its file, so anything that is not one of
/// ours is refused before it reaches the file system.
fn file_of(ws: &Workspace, id: &str) -> Result<PathBuf> {
    let ok = !id.is_empty()
        && id.len() <= 60
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    if !ok {
        return Err(AppError::new(
            "bad_thread_id",
            "That is not a valid discussion id.",
        ));
    }
    Ok(threads_dir(ws).join(format!("{id}.json")))
}

pub fn read(ws: &Workspace, id: &str) -> Result<Thread> {
    util::read_json(&file_of(ws, id)?)?.ok_or_else(|| {
        AppError::new("not_found", "That discussion does not exist.")
    })
}

fn save(ws: &Workspace, thread: &Thread) -> Result<()> {
    util::write_json(&file_of(ws, &thread.id)?, thread)
}

/// Deletes a thread, and with it the notes its answers put on visuals.
pub fn delete(ws: &Workspace, id: &str) -> Result<()> {
    match std::fs::remove_file(file_of(ws, id)?) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(AppError::io("delete the discussion", e)),
    }
}

fn view(ws: &Workspace, thread: Thread) -> ThreadView {
    let scope_now = thread
        .scope
        .as_ref()
        .map(|scope| scope::locate_in(ws, scope));
    ThreadView { thread, scope_now }
}

/// Every thread of the workspace, the one that was added to last first. A
/// file in the folder that cannot be read as a thread is left out.
pub fn list(ws: &Workspace) -> Vec<ThreadView> {
    let mut found: Vec<Thread> = std::fs::read_dir(threads_dir(ws))
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|e| e == "json"))
        .filter_map(|path| util::read_json(&path).ok().flatten())
        .collect();
    found.sort_by(|a, b| {
        b.updated_at
            .cmp(&a.updated_at)
            .then_with(|| b.id.cmp(&a.id))
    });
    found.into_iter().map(|thread| view(ws, thread)).collect()
}

/// The scopes that the threads and the artifacts of the file at `path`
/// have, each once. [`scope::for_selection`] is given them, so that a second
/// selection of the same code finds the scope of the first.
pub fn scopes_of_file(ws: &Workspace, path: &str) -> Vec<Scope> {
    let mut scopes: Vec<Scope> = Vec::new();
    let from_threads = list(ws).into_iter().filter_map(|one| one.thread.scope);
    let from_artifacts =
        artifacts::list(ws).into_iter().filter_map(|one| one.scope);
    for found in from_threads.chain(from_artifacts) {
        if found.path == path && !scopes.iter().any(|one| one.id == found.id) {
            scopes.push(found);
        }
    }
    scopes
}

/// Records the conversation that the next question of a thread continues.
/// A job that was started from a thread calls this when it has finished, so
/// that a later question knows what the job drew.
pub fn set_session(
    ws: &Workspace,
    id: &str,
    agent: &str,
    session_id: &str,
) -> Result<()> {
    let mut thread = read(ws, id)?;
    thread.session = Some(Session {
        agent: agent.to_string(),
        session_id: session_id.to_string(),
    });
    save(ws, &thread)
}

/// The conversation of `thread` that `agent` can continue, if there is one.
pub fn session_for(thread: &Thread, agent: &AgentInfo) -> Option<String> {
    thread
        .session
        .as_ref()
        .filter(|session| session.agent == agent.id && agent.supports_resume)
        .map(|session| session.session_id.clone())
}

/// The messages of a thread as text for a prompt: each as who wrote it and
/// what they wrote, with the notes of an answer left out.
pub fn transcript(thread: &Thread) -> String {
    thread
        .messages
        .iter()
        .map(|message| {
            let who = match message.role {
                Role::User => "User",
                Role::Agent => "Agent",
            };
            format!("{who}: {}", message.text.trim())
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// The name that is recorded with a question: git's `user.name` for the
/// workspace, or the account name of the operating system when git has none
/// or is not installed. Empty when neither is known.
pub fn author(ws: &Workspace) -> String {
    let mut command = std::process::Command::new("git");
    command.args(["config", "user.name"]).current_dir(ws.root());
    let from_git = run_capture(&mut command, Duration::from_secs(3))
        .map(|bytes| String::from_utf8_lossy(&bytes).trim().to_string())
        .filter(|name| !name.is_empty());
    from_git
        .or_else(|| std::env::var("USER").ok())
        .or_else(|| std::env::var("USERNAME").ok())
        .unwrap_or_default()
}

/// The first line of `text` with its white space brought to single spaces,
/// cut to `limit` characters with `…` when it is longer.
fn shortened(text: &str, limit: usize) -> String {
    let line = text.trim().lines().next().unwrap_or("");
    let words = line.split_whitespace().collect::<Vec<_>>().join(" ");
    if words.chars().count() <= limit {
        return words;
    }
    let mut cut: String = words.chars().take(limit - 1).collect();
    cut.push('…');
    cut
}

/// What an answer says once the notes block at its end is taken off, and
/// the entries of that block. An answer without a block is returned as it
/// is, with no entries.
///
/// The block is the last part of the answer that starts with a line of
/// three backticks and the word `notes`. It ends at the next line of three
/// backticks, or at the end of the answer. A block whose content is not a
/// JSON list is taken off and gives no entries.
fn split_notes(answer: &str) -> (String, Vec<Value>) {
    let Some(open) = answer.rfind("```notes") else {
        return (answer.trim().to_string(), Vec::new());
    };
    let body = &answer[open + "```notes".len()..];
    let (inside, after) = match body.find("```") {
        Some(close) => (&body[..close], &body[close + 3..]),
        None => (body, ""),
    };
    let entries = serde_json::from_str::<Value>(inside.trim())
        .ok()
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default();
    let text = format!("{}\n{}", answer[..open].trim_end(), after.trim());
    (text.trim().to_string(), entries)
}

/// What is known about the visual a question is about, for the prompt and
/// for checking the notes of the answer.
struct Shown {
    artifact_id: String,
    version: u32,
    /// True for a film and for a pipeline in film form.
    film: bool,
    word: &'static str,
    /// The ids of the nodes of a visual, with the line that lists each in
    /// the prompt.
    parts: Vec<(String, String)>,
    /// The id, the title and the start in seconds of each chapter of a film.
    chapters: Vec<(String, String, f64)>,
    duration: f64,
}

/// Reads what [`Shown`] holds for the version the user has on screen.
fn shown(ws: &Workspace, about: &About) -> Result<Option<Shown>> {
    let Some(id) = about.artifact_id.as_deref() else {
        return Ok(None);
    };
    let detail = artifacts::detail(ws, id, about.version)?;
    let manifest = &detail.manifest;
    let film = manifest.kind == ArtifactKind::Film
        || manifest.form.as_deref() == Some("film");
    let text = |value: &Value, key: &str| {
        value[key].as_str().unwrap_or_default().to_string()
    };
    let parts = detail
        .definition
        .as_ref()
        .and_then(|definition| definition["nodes"].as_array())
        .into_iter()
        .flatten()
        .filter(|node| node["id"].is_string())
        .map(|node| {
            let place = node["refs"][0]["path"]
                .as_str()
                .zip(node["refs"][0]["line"].as_u64())
                .map(|(path, line)| format!(" (`{path}:{line}`)"))
                .unwrap_or_default();
            (
                text(node, "id"),
                format!(
                    "- `{}`: {}{place}",
                    text(node, "id"),
                    text(node, "label")
                ),
            )
        })
        .collect();
    let chapters = manifest
        .chapters
        .iter()
        .filter(|chapter| chapter["id"].is_string())
        .map(|chapter| {
            (
                text(chapter, "id"),
                text(chapter, "title"),
                chapter["start"].as_f64().unwrap_or(0.0),
            )
        })
        .collect();
    Ok(Some(Shown {
        artifact_id: manifest.artifact_id.clone(),
        version: manifest.version,
        film,
        word: match manifest.kind {
            _ if film => "film",
            ArtifactKind::Visual => "blueprint",
            ArtifactKind::Stepthrough => "step-through",
            ArtifactKind::Pipeline => "pipeline",
            ArtifactKind::Map => "map",
            ArtifactKind::Schema => "schema view",
            ArtifactKind::Lanes => "lanes view",
            ArtifactKind::Structure => "structure view",
            ArtifactKind::Film => "film",
        },
        parts,
        chapters,
        duration: manifest.duration_sec.unwrap_or(0.0),
    }))
}

/// Turns the entries of an answer's notes block into notes on `shown`.
///
/// An entry is dropped when it has no text and is not an `emphasis`. An
/// entry for a visual is dropped when its `part` is not the id of a node.
/// An entry for a film is dropped when it names neither a time nor a
/// chapter of the film. At most [`MAX_NOTES`] are kept. `prefix` starts the
/// id of each note.
fn notes_from(entries: &[Value], shown: &Shown, prefix: &str) -> Vec<Note> {
    let mut notes: Vec<Note> = Vec::new();
    for entry in entries {
        if notes.len() == MAX_NOTES {
            break;
        }
        let kind = match entry["kind"].as_str().unwrap_or("note") {
            "flag" => NoteKind::Flag,
            "emphasis" => NoteKind::Emphasis,
            _ => NoteKind::Note,
        };
        let text: String = entry["text"]
            .as_str()
            .unwrap_or("")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .chars()
            .take(MAX_NOTE_CHARS)
            .collect();
        if text.is_empty() && kind != NoteKind::Emphasis {
            continue;
        }
        let (part, time) = if shown.film {
            let of_chapter = entry["chapter"].as_str().and_then(|id| {
                shown
                    .chapters
                    .iter()
                    .find(|chapter| chapter.0 == id)
                    .map(|chapter| chapter.2 + NOTE_INTO_CHAPTER)
            });
            let Some(time) = entry["time"].as_f64().or(of_chapter) else {
                continue;
            };
            (None, Some(time.clamp(0.0, shown.duration.max(0.0))))
        } else {
            let Some(part) = entry["part"]
                .as_str()
                .filter(|id| shown.parts.iter().any(|one| one.0 == *id))
            else {
                continue;
            };
            (Some(part.to_string()), None)
        };
        notes.push(Note {
            id: format!("{prefix}-{}", notes.len() + 1),
            artifact_id: shown.artifact_id.clone(),
            part,
            time,
            kind,
            text,
        });
    }
    notes
}

/// Finds a `path:line` or a `path:line-line` in a text. The path has a file
/// extension, so that a time such as `12:30` is not taken for a place.
fn place_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"([A-Za-z0-9_@+./\-]*\.[A-Za-z0-9_+]+):(\d+)(?:[-–](\d+))?")
            .expect("the pattern is valid")
    })
}

/// The places in the code that `answer` names and that exist, each once.
///
/// A place exists when its path is a text file of the workspace and the file
/// has that line. A path that is only a file name is also accepted when it
/// is the name of the file at `home`, the file the thread belongs to,
/// because an answer about one file often leaves the folders out.
fn verified_refs(ws: &Workspace, answer: &str, home: &str) -> Vec<AnswerRef> {
    let mut line_counts: BTreeMap<String, Option<u32>> = BTreeMap::new();
    let mut lines_of = |path: &str| -> Option<u32> {
        *line_counts.entry(path.to_string()).or_insert_with(|| {
            ws.read_text(path)
                .ok()
                .map(|content| content.text.lines().count() as u32)
        })
    };
    let mut refs: Vec<AnswerRef> = Vec::new();
    for found in place_pattern().captures_iter(answer) {
        let text = found[0].to_string();
        if refs.iter().any(|one| one.text == text) {
            continue;
        }
        let written = found[1].trim_start_matches("./");
        let Ok(line) = found[2].parse::<u32>() else {
            continue;
        };
        let end = found.get(3).and_then(|end| end.as_str().parse().ok());
        let path = if lines_of(written).is_some() {
            written.to_string()
        } else if !written.contains('/')
            && home.rsplit('/').next() == Some(written)
        {
            home.to_string()
        } else {
            continue;
        };
        if line == 0 || lines_of(&path).is_none_or(|count| line > count) {
            continue;
        }
        refs.push(AnswerRef {
            text,
            path,
            line,
            end: end.filter(|end: &u32| *end > line),
        });
    }
    refs
}

/// The user prompt of one question.
///
/// `thread` is the thread before the question is added. `history` says
/// whether the prompt carries the text of the thread's earlier messages,
/// which it must when the agent does not continue the thread's own
/// conversation.
fn question(
    ws: &Workspace,
    thread: &Thread,
    request: &AskRequest,
    shown: Option<&Shown>,
    history: bool,
) -> String {
    let mut values = prompts::Values::new();
    values.insert("path", thread.path.clone());
    values.insert("question", request.text.trim().to_string());
    if let Some(scope) = &thread.scope {
        if let Ok(content) = ws.read_text(&scope.path) {
            let now = scope::locate(scope, &content.text);
            let mut code =
                scope::lines_of(&content.text, now.start_line, now.end_line);
            if code.len() > MAX_CODE_BYTES {
                let mut end = MAX_CODE_BYTES;
                while !code.is_char_boundary(end) {
                    end -= 1;
                }
                let end = code[..end].rfind('\n').unwrap_or(end);
                code.truncate(end);
                code.push_str("\n… (cut here, read the file for the rest)");
            }
            values.insert("scopeText", code);
            values.insert(
                "scopeLines",
                format!("{}–{}", now.start_line, now.end_line),
            );
            values
                .insert("scopeName", scope.symbol.clone().unwrap_or_default());
        }
    }
    if let Some(shown) = shown {
        let dir = artifacts::version_dir(ws, &shown.artifact_id, shown.version)
            .ok()
            .and_then(|dir| ws.relative(&dir))
            .unwrap_or_default();
        values.insert("artifactDir", dir);
        values.insert("artifactWord", shown.word.to_string());
        if shown.film {
            let chapters: Vec<String> = shown
                .chapters
                .iter()
                .map(|(id, title, start)| {
                    format!("- `{id}`: {title} ({start:.0} s)")
                })
                .collect();
            values.insert("chapters", chapters.join("\n"));
        } else {
            let parts: Vec<&str> = shown
                .parts
                .iter()
                .take(MAX_PARTS)
                .map(|part| part.1.as_str())
                .collect();
            values.insert("parts", parts.join("\n"));
        }
        if let Some(part) = &request.about.part {
            values.insert("selected", part.clone());
        }
        if let Some(time) = request.about.time.filter(|_| shown.film) {
            values.insert("time", format!("{}", (time * 10.0).round() / 10.0));
            values.insert(
                "chapter",
                request.about.chapter.clone().unwrap_or_default(),
            );
        }
    }
    if history && !thread.messages.is_empty() {
        values.insert("history", transcript(thread));
    }
    prompts::user_ask(&values)
}

/// The thread a question is added to: the one `request` names, or a new one
/// that is about the scope or the artifact `request` names.
fn thread_for(ws: &Workspace, request: &AskRequest) -> Result<Thread> {
    if let Some(id) = &request.thread_id {
        return read(ws, id);
    }
    let now = util::now_rfc3339();
    let scope = match &request.scope {
        Some(scope) => {
            let text = ws.read_text(&scope.path)?.text;
            Some(scope::refreshed(scope, &text).ok_or_else(|| {
                AppError::new(
                    "scope_lost",
                    "The selected code is no longer in the file. Select it \
                     again.",
                )
            })?)
        }
        None => None,
    };
    if scope.is_none() && request.about.artifact_id.is_none() {
        return Err(AppError::new(
            "bad_request",
            "The question does not say what it is about.",
        ));
    }
    Ok(Thread {
        schema_version: SCHEMA_VERSION,
        id: jobs::new_job_id().replacen('j', "t", 1),
        title: shortened(&request.text, MAX_TITLE_CHARS),
        path: scope
            .as_ref()
            .map_or(request.path.clone(), |scope| scope.path.clone()),
        artifact_id: match scope {
            Some(_) => None,
            None => request.about.artifact_id.clone(),
        },
        scope,
        created_at: now.clone(),
        updated_at: now,
        session: None,
        messages: Vec::new(),
    })
}

/// Puts the question of `request` to the agent `backend`, adds the question
/// and the answer to its thread, saves the thread and returns it.
///
/// `emit` is called with what the agent does while it works. Triggering
/// `cancel` ends the question early with the error `cancelled`, and so does
/// [`TIME_LIMIT`] with the error `ask_failed`. A question that fails adds
/// nothing to the thread, and a new thread is then not created.
///
/// One question at a time is asked in a thread. A question about a visual
/// is refused with the error `artifact_busy` while a job is making a version
/// of that visual, because both would continue the same conversation.
pub async fn ask(
    ws: &Workspace,
    backend: &dyn Backend,
    options: &AskOptions,
    request: &AskRequest,
    cancel: &CancellationToken,
    emit: &(dyn Fn(AskEvent) + Send + Sync),
) -> Result<ThreadView> {
    let failed = |message: &str| AppError::new("ask_failed", message);
    if request.text.trim().is_empty() {
        return Err(AppError::new("bad_request", "Write a question first."));
    }
    store_ready(ws)?;
    let mut thread = thread_for(ws, request)?;
    let shown = shown(ws, &request.about)?;
    let _thread_claim =
        Claim::take(file_of(ws, &thread.id)?).ok_or_else(|| {
            AppError::new(
                "thread_busy",
                "This discussion is still waiting for an answer.",
            )
        })?;
    let _artifact_claim = match &shown {
        Some(shown) => Some(
            Claim::take(artifacts::artifact_dir(ws, &shown.artifact_id)?)
                .ok_or_else(|| {
                    AppError::new(
                        "artifact_busy",
                        format!(
                            "A new version of this {} is being made. Ask \
                             again when that job has finished.",
                            shown.word
                        ),
                    )
                })?,
        ),
        None => None,
    };

    let agent = backend.info();
    // The thread's own conversation is continued where there is one. The
    // first question about a visual continues the conversation that drew
    // the version on screen.
    let own = session_for(&thread, &agent);
    let of_visual = match (&own, &shown, thread.messages.is_empty()) {
        (None, Some(shown), true) => {
            artifacts::read_manifest(ws, &shown.artifact_id, shown.version)
                .ok()
                .filter(|made| {
                    made.agent.kind == agent.id && agent.supports_resume
                })
                .and_then(|made| made.agent.session_id)
        }
        _ => None,
    };
    let mut resume = own.clone().or(of_visual);
    let mut history = own.is_none();

    // The files of the turn are in a folder of their own, next to the
    // folders of jobs. `out` is the folder the agent may write to.
    let job_dir = ws
        .dot_dir()
        .join("jobs")
        .join(format!("ask-{}", jobs::new_job_id()));
    let out_dir = job_dir.join("out");
    std::fs::create_dir_all(&out_dir)
        .map_err(|e| AppError::io("prepare the question", e))?;
    let system_prompt_path = job_dir.join("system.md");
    util::write_atomic(&system_prompt_path, prompts::system_ask())?;

    emit(AskEvent::Started {
        agent: agent.name.clone(),
        continues: resume.is_some(),
    });
    // The agent's prose. It is cleared whenever the agent uses a tool, so
    // that at the end it holds what the agent wrote after its last tool.
    let said = Mutex::new(String::new());
    let mut timed_out = false;
    let outcome = loop {
        let user_prompt =
            question(ws, &thread, request, shown.as_ref(), history);
        let user_prompt_path = job_dir.join("user.md");
        util::write_atomic(&user_prompt_path, &user_prompt)?;
        let turn = Turn {
            workspace_root: ws.root().to_path_buf(),
            dot_dir: ws.dot_dir(),
            artifact_dir: out_dir.clone(),
            job_dir: job_dir.clone(),
            system_prompt_path: system_prompt_path.clone(),
            user_prompt_path,
            user_prompt,
            resume_session: resume.clone(),
            model: options.model.clone(),
            effort: options.effort.clone(),
            max_budget_usd: None,
            customizations: options.customizations,
            log_path: job_dir.join("agent.log.jsonl"),
        };
        said.lock().expect("the lock is not poisoned").clear();
        let on_event = |event: AgentEvent| match event {
            AgentEvent::Text(text) => {
                let mut said = said.lock().expect("the lock is not poisoned");
                if !said.is_empty() {
                    said.push_str("\n\n");
                }
                said.push_str(text.trim());
                emit(AskEvent::Text { text });
            }
            AgentEvent::ToolUse { name, summary } => {
                said.lock().expect("the lock is not poisoned").clear();
                emit(AskEvent::Tool { name, summary });
            }
            _ => {}
        };
        let run = backend.run(&turn, cancel, &on_event);
        tokio::pin!(run);
        let outcome = tokio::select! {
            outcome = &mut run => outcome,
            _ = tokio::time::sleep(TIME_LIMIT) => {
                timed_out = true;
                cancel.cancel();
                run.await
            }
        };
        let stopped = timed_out
            || cancel.is_cancelled()
            || outcome.as_ref().is_ok_and(|outcome| outcome.cancelled);
        let went_wrong = outcome
            .as_ref()
            .map_or(true, |outcome| outcome.error.is_some());
        // The earlier conversation may no longer exist, or may have been
        // made on another computer. The question is then asked once more
        // as a new conversation that is given the text of the thread.
        if went_wrong && !stopped && resume.is_some() {
            resume = None;
            history = true;
            emit(AskEvent::Notice {
                text: "The earlier conversation could not be continued, so \
                       the agent starts a new one."
                    .into(),
            });
            continue;
        }
        break outcome;
    };
    let said = said.into_inner().expect("the lock is not poisoned");
    // The folder is kept when the turn failed, so that the agent's output
    // in `agent.log.jsonl` can be looked at.
    let outcome = match outcome {
        Err(error) => return Err(error),
        Ok(_) if timed_out => {
            return Err(failed("The agent did not answer in time. Try again."))
        }
        Ok(outcome) if outcome.cancelled || cancel.is_cancelled() => {
            let _ = std::fs::remove_dir_all(&job_dir);
            return Err(AppError::new(
                "cancelled",
                "The question was cancelled.",
            ));
        }
        Ok(outcome) => outcome,
    };
    if let Some(error) = &outcome.error {
        return Err(failed(error));
    }
    let (text, entries) = split_notes(&said);
    let answer_number = thread.messages.len() / 2 + 1;
    let notes = shown.as_ref().map_or(Vec::new(), |shown| {
        notes_from(&entries, shown, &format!("{}-{answer_number}", thread.id))
    });
    let text = match (text.is_empty(), notes.len()) {
        (true, 0) => {
            return Err(failed("The agent gave no answer. Try again."))
        }
        (true, 1) => "I added a note.".to_string(),
        (true, count) => format!("I added {count} notes."),
        (false, _) => text,
    };
    let _ = std::fs::remove_dir_all(&job_dir);

    let now = util::now_rfc3339();
    thread.messages.push(Message {
        role: Role::User,
        text: request.text.trim().to_string(),
        created_at: now.clone(),
        author: author(ws),
        model: None,
        about: Some(About {
            artifact_id: shown.as_ref().map(|one| one.artifact_id.clone()),
            version: shown.as_ref().map(|one| one.version),
            ..request.about.clone()
        }),
        refs: Vec::new(),
        notes: Vec::new(),
    });
    thread.messages.push(Message {
        role: Role::Agent,
        refs: verified_refs(ws, &text, &thread.path),
        text,
        created_at: now.clone(),
        author: agent.name.clone(),
        model: outcome.model.or_else(|| options.model.clone()),
        about: None,
        notes,
    });
    thread.updated_at = now;
    thread.session = outcome
        .session_id
        .or(resume)
        .filter(|_| agent.supports_resume)
        .map(|session_id| Session {
            agent: agent.id.clone(),
            session_id,
        });
    save(ws, &thread)?;
    Ok(view(ws, thread))
}

/// Makes sure the workspace's `.codjiva` folder exists before a thread is
/// written into it.
fn store_ready(ws: &Workspace) -> Result<()> {
    crate::store::ensure(ws).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::TurnOutcome;
    use crate::artifacts::{AgentRecord, Manifest, ValidationRecord};
    use async_trait::async_trait;
    use serde_json::json;
    use std::fs;

    const QUEUE: &str = "package queue\n\ntype Queue struct {\n\titems \
                         []string\n}\n\nfunc (q *Queue) Push(item string) \
                         {\n\tq.items = append(q.items, item)\n}\n";

    /// An agent that gives its replies in order, one for each turn, and
    /// remembers the turns it was given. A reply that starts with `!` makes
    /// the turn fail with the rest of the reply as the error. The agent can
    /// continue a conversation when `resumes` is true, and every turn
    /// reports the session `s<number of the turn>`.
    struct Scripted {
        replies: Mutex<Vec<String>>,
        turns: Mutex<Vec<Turn>>,
        resumes: bool,
    }

    impl Scripted {
        fn saying(replies: &[&str]) -> Scripted {
            Scripted {
                replies: Mutex::new(
                    replies.iter().rev().map(|one| one.to_string()).collect(),
                ),
                turns: Mutex::new(Vec::new()),
                resumes: true,
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
                supports_resume: self.resumes,
                verified: true,
                default_model: None,
                quick_model: None,
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
            let number = {
                let mut turns = self.turns.lock().unwrap();
                turns.push(turn.clone());
                turns.len()
            };
            let reply = self.replies.lock().unwrap().pop().unwrap_or_default();
            if let Some(error) = reply.strip_prefix('!') {
                return Ok(TurnOutcome {
                    error: Some(error.to_string()),
                    ..TurnOutcome::default()
                });
            }
            on_event(AgentEvent::Text("Let me read the file.".into()));
            on_event(AgentEvent::ToolUse {
                name: "Read".into(),
                summary: "queue.go".into(),
            });
            on_event(AgentEvent::Text(reply));
            Ok(TurnOutcome {
                session_id: Some(format!("s{number}")),
                model: Some("m1".into()),
                ..TurnOutcome::default()
            })
        }
    }

    fn workspace() -> (tempfile::TempDir, Workspace) {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("queue.go"), QUEUE).unwrap();
        let ws = Workspace::open(dir.path()).unwrap();
        (dir, ws)
    }

    /// Saves a version of a visual of `queue.go` with two nodes, made by
    /// the agent `scripted` in the session `drawn`. With `film` it is a
    /// film with two chapters and no nodes. Returns the artifact's id.
    fn artifact(ws: &Workspace, film: bool) -> String {
        let kind = if film {
            ArtifactKind::Film
        } else {
            ArtifactKind::Visual
        };
        let subject = vec!["queue.go".to_string()];
        let id = artifacts::artifact_id(kind, &subject);
        let dir = artifacts::version_dir(ws, &id, 1).unwrap();
        fs::create_dir_all(dir.join("src")).unwrap();
        let definition = json!({
            "title": "Queue",
            "nodes": [
                { "id": "push", "label": "Push", "role": "adds an item",
                  "refs": [{ "path": "queue.go", "line": 7 }],
                  "select": ["push"] },
                { "id": "items", "label": "items", "role": "the list",
                  "select": ["items"] }
            ]
        });
        fs::write(
            dir.join("src").join(kind.definition_file()),
            definition.to_string(),
        )
        .unwrap();
        let manifest = Manifest {
            schema_version: artifacts::SCHEMA_VERSION,
            artifact_id: id.clone(),
            version: 1,
            kind,
            title: "Queue".into(),
            subject,
            companions: vec![],
            sources: BTreeMap::new(),
            instructions: String::new(),
            agent: AgentRecord {
                kind: "scripted".into(),
                session_id: Some("drawn".into()),
                ..AgentRecord::default()
            },
            prompt_version: "1".into(),
            runtime_version: "1.5.0".into(),
            duration_sec: film.then_some(60.0),
            chapters: if film {
                vec![
                    json!({ "id": "intro", "title": "1 · Intro", "start": 0.0 }),
                    json!({ "id": "push", "title": "2 · Push", "start": 20.0 }),
                ]
            } else {
                vec![]
            },
            ports: vec![],
            validation: ValidationRecord::default(),
            created_at: "2026-11-26T10:00:00Z".into(),
            parent: None,
            feedback: None,
            cost_usd: None,
            form: None,
            parts: vec![],
            joins: vec![],
            scope: None,
        };
        artifacts::commit_version(ws, &manifest).unwrap();
        id
    }

    fn about(id: &str) -> About {
        About {
            artifact_id: Some(id.to_string()),
            version: Some(1),
            ..About::default()
        }
    }

    async fn asked(
        ws: &Workspace,
        agent: &Scripted,
        request: &AskRequest,
    ) -> Result<ThreadView> {
        ask(
            ws,
            agent,
            &AskOptions::default(),
            request,
            &CancellationToken::new(),
            &|_| {},
        )
        .await
    }

    #[test]
    fn the_notes_block_is_taken_off_the_answer() {
        let (text, entries) = split_notes(
            "Push appends.\n\n```notes\n[{\"part\": \"push\", \"text\": \
             \"Appends.\"}]\n```\n",
        );
        assert_eq!(text, "Push appends.");
        assert_eq!(entries.len(), 1);
        // An answer without a block is left as it is.
        assert_eq!(
            split_notes(" It returns early. "),
            ("It returns early.".to_string(), vec![])
        );
        // A block that is not a list is taken off and gives nothing.
        let (text, entries) =
            split_notes("Answer.\n```notes\nnot json\n```\nMore.");
        assert_eq!(text, "Answer.\nMore.");
        assert!(entries.is_empty());
        // A block that is never closed runs to the end.
        let (text, entries) = split_notes("A.\n```notes\n[{\"part\": \"x\"}]");
        assert_eq!((text.as_str(), entries.len()), ("A.", 1));
    }

    #[test]
    fn only_places_that_exist_become_references() {
        let (_dir, ws) = workspace();
        let refs = verified_refs(
            &ws,
            "See `queue.go:7` and queue.go:7-9, not `queue.go:400`, \
             `gone.go:1`, the time 12:30 or `./queue.go:3`.",
            "queue.go",
        );
        let found: Vec<(&str, u32, Option<u32>)> = refs
            .iter()
            .map(|one| (one.text.as_str(), one.line, one.end))
            .collect();
        assert_eq!(
            found,
            [
                ("queue.go:7", 7, None),
                ("queue.go:7-9", 7, Some(9)),
                ("./queue.go:3", 3, None)
            ]
        );
        assert!(refs.iter().all(|one| one.path == "queue.go"));

        // A file name alone is the file the thread belongs to.
        fs::create_dir_all(ws.root().join("pkg")).unwrap();
        fs::write(ws.root().join("pkg/list.go"), "package pkg\n").unwrap();
        let refs = verified_refs(&ws, "At list.go:1.", "pkg/list.go");
        assert_eq!(refs[0].path, "pkg/list.go");
        assert!(verified_refs(&ws, "At list.go:1.", "queue.go").is_empty());
    }

    #[tokio::test]
    async fn a_question_about_a_visual_continues_its_conversation_and_keeps_notes(
    ) {
        let (_dir, ws) = workspace();
        let id = artifact(&ws, false);
        let agent = Scripted::saying(&[
            "Push appends at `queue.go:8`.\n\n```notes\n[{\"part\": \
             \"push\", \"kind\": \"flag\", \"text\": \"Never  refuses an \
             item.\"}, {\"part\": \"nowhere\", \"text\": \"x\"}, {\"part\": \
             \"items\", \"kind\": \"emphasis\"}]\n```",
            "It grows without a limit.",
        ]);
        let events = Mutex::new(Vec::new());
        let first = ask(
            &ws,
            &agent,
            &AskOptions::default(),
            &AskRequest {
                path: "queue.go".into(),
                text: "  What does Push do?\nIn detail. ".into(),
                about: About {
                    part: Some("push".into()),
                    ..about(&id)
                },
                ..AskRequest::default()
            },
            &CancellationToken::new(),
            &|event| events.lock().unwrap().push(event),
        )
        .await
        .unwrap();
        let thread = &first.thread;
        assert_eq!(thread.title, "What does Push do?");
        assert_eq!(thread.artifact_id.as_deref(), Some(id.as_str()));
        assert_eq!(thread.messages.len(), 2);
        assert_eq!(thread.messages[0].role, Role::User);
        let answer = &thread.messages[1];
        assert_eq!(answer.text, "Push appends at `queue.go:8`.");
        assert_eq!(answer.author, "Scripted Agent");
        assert_eq!(answer.model.as_deref(), Some("m1"));
        assert_eq!(answer.refs.len(), 1);
        // The note on a part that does not exist is dropped.
        let notes: Vec<(&str, NoteKind, &str)> = answer
            .notes
            .iter()
            .map(|note| {
                (note.part.as_deref().unwrap(), note.kind, note.text.as_str())
            })
            .collect();
        assert_eq!(
            notes,
            [
                ("push", NoteKind::Flag, "Never refuses an item."),
                ("items", NoteKind::Emphasis, "")
            ]
        );
        assert_eq!(answer.notes[0].id, format!("{}-1-1", thread.id));
        assert_eq!(
            events.lock().unwrap().first(),
            Some(&AskEvent::Started {
                agent: "Scripted Agent".into(),
                continues: true
            })
        );

        // The first question continued the conversation that drew the
        // visual, and was told the parts and the selected one.
        {
            let turns = agent.turns.lock().unwrap();
            assert_eq!(turns[0].resume_session.as_deref(), Some("drawn"));
            let prompt = &turns[0].user_prompt;
            assert!(
                prompt.contains("- `push`: Push (`queue.go:7`)"),
                "{prompt}"
            );
            assert!(prompt.contains("selected on screen is `push`"));
            assert!(prompt.contains("has a blueprint of this code"));
            assert!(!prompt.contains("The discussion so far"));
            assert!(!prompt.contains("{{"));
            // The folder of the turn is removed after an answer.
            assert!(!turns[0].job_dir.exists());
        }

        // The second question continues the thread's own conversation.
        let second = asked(
            &ws,
            &agent,
            &AskRequest {
                thread_id: Some(thread.id.clone()),
                text: "Can it overflow?".into(),
                about: about(&id),
                ..AskRequest::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(second.thread.messages.len(), 4);
        assert_eq!(second.thread.session.as_ref().unwrap().session_id, "s2");
        let turns = agent.turns.lock().unwrap();
        assert_eq!(turns[1].resume_session.as_deref(), Some("s1"));
        assert!(!turns[1].user_prompt.contains("The discussion so far"));
        assert_eq!(list(&ws).len(), 1);
        assert_eq!(list(&ws)[0].thread, second.thread);
    }

    #[tokio::test]
    async fn a_conversation_that_cannot_be_continued_is_asked_again_with_the_text(
    ) {
        let (_dir, ws) = workspace();
        let id = artifact(&ws, false);
        let agent = Scripted::saying(&["First answer."]);
        let first = asked(
            &ws,
            &agent,
            &AskRequest {
                path: "queue.go".into(),
                text: "First question".into(),
                about: about(&id),
                ..AskRequest::default()
            },
        )
        .await
        .unwrap();

        // The next turn fails, as it does when the session is not on this
        // computer. The turn after it is a new conversation.
        let agent = Scripted::saying(&["!No conversation found", "Second."]);
        let second = asked(
            &ws,
            &agent,
            &AskRequest {
                thread_id: Some(first.thread.id.clone()),
                text: "Second question".into(),
                about: about(&id),
                ..AskRequest::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(second.thread.messages[3].text, "Second.");
        let turns = agent.turns.lock().unwrap();
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0].resume_session.as_deref(), Some("s1"));
        assert_eq!(turns[1].resume_session, None);
        let prompt = &turns[1].user_prompt;
        assert!(prompt.contains("The discussion so far"), "{prompt}");
        assert!(prompt.contains("User: First question\n\nAgent: First answer."));
    }

    #[tokio::test]
    async fn a_question_about_selected_code_carries_the_code_and_its_scope() {
        let (dir, ws) = workspace();
        let scope = scope::for_selection(&ws, "queue.go", 7, 9, &[])
            .unwrap()
            .symbol
            .unwrap();
        let mut agent = Scripted::saying(&["It appends.", "Yes."]);
        agent.resumes = false;
        let first = asked(
            &ws,
            &agent,
            &AskRequest {
                path: "queue.go".into(),
                scope: Some(scope.clone()),
                text: "What is this?".into(),
                ..AskRequest::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(first.thread.scope.as_ref().unwrap().id, "queue_push");
        assert_eq!(first.thread.artifact_id, None);
        assert_eq!(first.scope_now.unwrap().state, scope::ScopeState::Same);
        // An agent that cannot continue a conversation leaves no session.
        assert_eq!(first.thread.session, None);
        {
            let turns = agent.turns.lock().unwrap();
            let prompt = &turns[0].user_prompt;
            assert!(prompt.contains("`queue.go`, lines 7–9 (Queue.Push)"));
            assert!(prompt.contains("q.items = append(q.items, item)"));
            assert!(!prompt.contains("on screen"));
        }
        assert_eq!(scopes_of_file(&ws, "queue.go"), vec![scope.clone()]);
        assert!(scopes_of_file(&ws, "other.go").is_empty());

        // The code moves down. The next question gets the code where it is
        // now, and the text of the thread, because the agent has no
        // conversation to continue.
        fs::write(dir.path().join("queue.go"), format!("//\n{QUEUE}")).unwrap();
        asked(
            &ws,
            &agent,
            &AskRequest {
                thread_id: Some(first.thread.id.clone()),
                text: "Sure?".into(),
                ..AskRequest::default()
            },
        )
        .await
        .unwrap();
        let turns = agent.turns.lock().unwrap();
        assert!(turns[1].user_prompt.contains("lines 8–10 (Queue.Push)"));
        assert!(turns[1].user_prompt.contains("Agent: It appends."));
        assert_eq!(list(&ws)[0].scope_now.unwrap().start_line, 8);
    }

    #[tokio::test]
    async fn a_note_of_a_film_is_placed_at_a_time() {
        let (_dir, ws) = workspace();
        let id = artifact(&ws, true);
        let agent = Scripted::saying(&[
            "```notes\n[{\"chapter\": \"push\", \"text\": \"Here.\"}, \
             {\"time\": 500, \"text\": \"Late.\"}, {\"chapter\": \"none\", \
             \"text\": \"x\"}]\n```",
        ]);
        let made = asked(
            &ws,
            &agent,
            &AskRequest {
                path: "queue.go".into(),
                text: "Where is Push shown?".into(),
                about: About {
                    time: Some(12.34),
                    chapter: Some("1 · Intro".into()),
                    ..about(&id)
                },
                ..AskRequest::default()
            },
        )
        .await
        .unwrap();
        let answer = &made.thread.messages[1];
        assert_eq!(answer.text, "I added 2 notes.");
        let times: Vec<f64> =
            answer.notes.iter().map(|note| note.time.unwrap()).collect();
        assert_eq!(times, [20.3, 60.0]);
        let turns = agent.turns.lock().unwrap();
        let prompt = &turns[0].user_prompt;
        assert!(prompt.contains("- `push`: 2 · Push (20 s)"), "{prompt}");
        assert!(prompt.contains("at 12.3 seconds of real time, in chapter"));
    }

    #[tokio::test]
    async fn a_question_that_fails_adds_nothing() {
        let (_dir, ws) = workspace();
        let id = artifact(&ws, false);
        let request = AskRequest {
            path: "queue.go".into(),
            text: "Why?".into(),
            about: about(&id),
            ..AskRequest::default()
        };
        // The turn that continues fails, and so does the new conversation.
        let agent = Scripted::saying(&["!gone", "!Not logged in"]);
        let error = asked(&ws, &agent, &request).await.unwrap_err();
        assert_eq!(error.code, "ask_failed");
        assert_eq!(error.message, "Not logged in");
        assert!(list(&ws).is_empty());
        // The folder of the turn stays, for looking at what went wrong.
        assert!(agent.turns.lock().unwrap()[1]
            .job_dir
            .join("user.md")
            .is_file());

        let agent = Scripted::saying(&["  "]);
        let error = asked(&ws, &agent, &request).await.unwrap_err();
        assert_eq!(error.message, "The agent gave no answer. Try again.");

        let empty = AskRequest {
            text: " ".into(),
            ..request.clone()
        };
        assert_eq!(
            asked(&ws, &agent, &empty).await.unwrap_err().code,
            "bad_request"
        );
        let about_nothing = AskRequest {
            about: About::default(),
            ..request
        };
        assert_eq!(
            asked(&ws, &agent, &about_nothing).await.unwrap_err().code,
            "bad_request"
        );
    }

    #[tokio::test]
    async fn a_thread_is_deleted_and_its_session_can_be_replaced() {
        let (_dir, ws) = workspace();
        let id = artifact(&ws, false);
        let agent = Scripted::saying(&["Answer."]);
        let made = asked(
            &ws,
            &agent,
            &AskRequest {
                path: "queue.go".into(),
                text: "Why?".into(),
                about: about(&id),
                ..AskRequest::default()
            },
        )
        .await
        .unwrap();
        let thread_id = made.thread.id;
        set_session(&ws, &thread_id, "scripted", "after-the-job").unwrap();
        let thread = read(&ws, &thread_id).unwrap();
        assert_eq!(
            session_for(&thread, &agent.info()).as_deref(),
            Some("after-the-job")
        );
        let mut other = agent.info();
        other.id = "another".into();
        assert_eq!(session_for(&thread, &other), None);

        delete(&ws, &thread_id).unwrap();
        delete(&ws, &thread_id).unwrap();
        assert!(list(&ws).is_empty());
        assert_eq!(read(&ws, "../x").unwrap_err().code, "bad_thread_id");
    }

    /// Asks the Claude Code program installed on this computer three
    /// questions about a file of a fixture: one about a definition, a second
    /// one in the same discussion, and one about a visual with two parts.
    /// The run uses the user's own allowance of that program, so the test
    /// only runs when it is asked for by name:
    ///
    ///   cargo test -p codjiva-core real_claude_code_answers -- \
    ///     --ignored --nocapture
    #[tokio::test]
    #[ignore = "starts the real Claude Code program"]
    async fn the_real_claude_code_answers_questions_and_adds_notes() {
        use crate::agents::{definition, detect_cli_agents};
        use crate::env::ShellEnv;
        use std::sync::Arc;

        let dir = tempfile::tempdir().unwrap();
        let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../fixtures/go-orders/internal/orders/handler.go");
        fs::copy(fixture, dir.path().join("queue.go")).unwrap();
        let ws = Workspace::open(dir.path()).unwrap();
        let text = ws.read_text("queue.go").unwrap().text;
        let extent = crate::nav::extents_of("queue.go", text)
            .into_iter()
            .find(|one| {
                one.kind.is_callable() && one.last_line > one.first_line + 5
            })
            .expect("the fixture has a definition of several lines");
        let picked = scope::for_selection(
            &ws,
            "queue.go",
            extent.first_line,
            extent.last_line,
            &[],
        )
        .unwrap()
        .symbol
        .unwrap();

        let (definitions, _) = definition::load_definitions(dir.path());
        let env = Arc::new(ShellEnv::capture());
        let agent = detect_cli_agents(&definitions, &env, &BTreeMap::new())
            .into_iter()
            .find(|agent| agent.info().id == "claude-code" && agent.info().ok)
            .expect("Claude Code is installed");
        let options = AskOptions {
            effort: Some("low".into()),
            ..AskOptions::default()
        };
        let cancel = CancellationToken::new();
        let show = |made: &ThreadView| {
            let answer = made.thread.messages.last().unwrap();
            println!("--- answer ({:?})\n{}", answer.model, answer.text);
            println!("refs: {:?}", answer.refs);
            println!("notes: {:?}", answer.notes);
            println!("session: {:?}", made.thread.session);
        };

        let began = std::time::Instant::now();
        let first = ask(
            &ws,
            &agent,
            &options,
            &AskRequest {
                path: "queue.go".into(),
                scope: Some(picked.clone()),
                text: "What is this code for, in two sentences?".into(),
                ..AskRequest::default()
            },
            &cancel,
            &|event| println!("{event:?}"),
        )
        .await
        .unwrap();
        println!("first answer after {:?}", began.elapsed());
        show(&first);
        assert!(first.thread.session.is_some());
        assert!(!first.thread.messages[1].text.contains("```notes"));

        let second = ask(
            &ws,
            &agent,
            &options,
            &AskRequest {
                thread_id: Some(first.thread.id.clone()),
                text: "Which line of it can return an error first?".into(),
                ..AskRequest::default()
            },
            &cancel,
            &|event| println!("{event:?}"),
        )
        .await
        .unwrap();
        println!("second answer after {:?}", began.elapsed());
        show(&second);
        assert!(
            !second.thread.messages[3].refs.is_empty(),
            "the answer names a line that exists"
        );

        let id = artifact(&ws, false);
        let third = ask(
            &ws,
            &agent,
            &options,
            &AskRequest {
                path: "queue.go".into(),
                text: "Mark the part where an order comes in.".into(),
                about: about(&id),
                ..AskRequest::default()
            },
            &cancel,
            &|event| println!("{event:?}"),
        )
        .await
        .unwrap();
        println!("third answer after {:?}", began.elapsed());
        show(&third);
        assert!(
            !third.thread.messages[1].notes.is_empty(),
            "an answer about a part of the visual adds a note"
        );
    }
}
