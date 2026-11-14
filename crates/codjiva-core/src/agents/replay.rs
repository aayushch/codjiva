//! A backend that plays back a recorded agent session instead of calling an agent.
//!
//! Tests and the app's self-check use it to run the whole job pipeline without spending anything,
//! and it makes work on the interface repeatable. A recording is a folder:
//!
//!   <recording>/turn-1/stdout.jsonl   the agent's output for the first turn, one line per event
//!   <recording>/turn-1/files/         what the agent wrote, relative to the version folder
//!   <recording>/turn-2/...            the same for the first fix turn, and so on
//!
//! Each turn prints its recorded lines, then copies its files into the version folder. A job
//! that needs more turns than were recorded gets the last recorded turn again.

use crate::agents::{parser_named, AgentEvent, AgentInfo, Backend, Turn, TurnOutcome};
use crate::error::{AppError, Result};
use async_trait::async_trait;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

pub struct ReplayBackend {
    recording: PathBuf,
    /// The pause between two recorded lines, so the interface shows progress as it would live.
    line_delay: Duration,
    /// How many turns have been played for each version folder.
    turns_played: Mutex<HashMap<PathBuf, usize>>,
}

impl ReplayBackend {
    pub fn new(recording: &Path, line_delay: Duration) -> ReplayBackend {
        ReplayBackend { recording: recording.to_path_buf(), line_delay, turns_played: Mutex::new(HashMap::new()) }
    }
}

/// Copies every file under `from` to the same relative path under `to`.
fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    if !from.is_dir() {
        return Ok(());
    }
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

#[async_trait]
impl Backend for ReplayBackend {
    fn info(&self) -> AgentInfo {
        AgentInfo {
            id: "replay".into(),
            name: "Recorded session".into(),
            kind: "replay".into(),
            path: Some(self.recording.to_string_lossy().into_owned()),
            version: None,
            ok: self.recording.join("turn-1").is_dir(),
            note: "Plays back a recorded agent session. Nothing is sent to an agent.".into(),
            supports_resume: true,
            verified: true,
            default_model: None,
            limits: String::new(),
        }
    }

    async fn run(&self, turn: &Turn, cancel: &CancellationToken, on_event: &(dyn Fn(AgentEvent) + Send + Sync)) -> Result<TurnOutcome> {
        let number = {
            let mut played = self.turns_played.lock().expect("the replay counter lock is not poisoned");
            let count = played.entry(turn.artifact_dir.clone()).or_insert(0);
            *count += 1;
            *count
        };
        // The highest recorded turn that is not above the one asked for.
        let dir = (1..=number).rev().map(|n| self.recording.join(format!("turn-{n}"))).find(|d| d.is_dir())
            .ok_or_else(|| AppError::new("bad_recording", format!("The recording {} has no turn-1 folder.", self.recording.display())))?;

        let mut parser = parser_named("claude-stream-json")?;
        let mut outcome = TurnOutcome::default();
        let lines = std::fs::read_to_string(dir.join("stdout.jsonl")).unwrap_or_default();
        for line in lines.lines().filter(|l| !l.trim().is_empty()) {
            tokio::select! {
                _ = cancel.cancelled() => { outcome.cancelled = true; return Ok(outcome); }
                _ = tokio::time::sleep(self.line_delay) => {}
            }
            for event in parser.parse_line(line) {
                match &event {
                    AgentEvent::SessionStarted { session_id, model } => {
                        outcome.session_id = Some(session_id.clone());
                        outcome.model = model.clone();
                    }
                    AgentEvent::Finished { error } => outcome.error = error.clone(),
                    _ => {}
                }
                on_event(event);
            }
        }
        copy_tree(&dir.join("files"), &turn.artifact_dir).map_err(|e| AppError::io("copy the recorded files", e))?;
        if !parser.finished() {
            on_event(AgentEvent::Finished { error: None });
        }
        Ok(outcome)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    fn turn(dir: &Path) -> Turn {
        Turn {
            workspace_root: dir.to_path_buf(), dot_dir: dir.join(".codjiva"), artifact_dir: dir.join(".codjiva/artifacts/a/v1"), job_dir: dir.join("job"),
            system_prompt_path: dir.join("s.md"), user_prompt_path: dir.join("u.md"), user_prompt: String::new(), resume_session: None, model: None, effort: None,
            max_budget_usd: None, log_path: dir.join("log"),
        }
    }

    #[tokio::test]
    async fn plays_each_turn_in_order_and_repeats_the_last_one() {
        let dir = tempfile::tempdir().unwrap();
        let rec = dir.path().join("rec");
        for (n, text) in [(1, "first"), (2, "second")] {
            let t = rec.join(format!("turn-{n}"));
            std::fs::create_dir_all(t.join("files/src")).unwrap();
            std::fs::write(t.join("stdout.jsonl"), format!("{{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"s{n}\"}}\n{{\"type\":\"assistant\",\"message\":{{\"content\":[{{\"type\":\"text\",\"text\":\"{text}\"}}]}}}}\n")).unwrap();
            std::fs::write(t.join("files/src/plant.js"), text).unwrap();
        }
        let backend = ReplayBackend::new(&rec, Duration::ZERO);
        assert!(backend.info().ok);
        let said = StdMutex::new(Vec::new());
        let collect = |e: AgentEvent| { if let AgentEvent::Text(t) = e { said.lock().unwrap().push(t); } };
        let t = turn(dir.path());
        for expected in ["first", "second", "second"] {
            let outcome = backend.run(&t, &CancellationToken::new(), &collect).await.unwrap();
            assert!(outcome.error.is_none());
            assert_eq!(std::fs::read_to_string(t.artifact_dir.join("src/plant.js")).unwrap(), expected);
        }
        assert_eq!(*said.lock().unwrap(), vec!["first", "second", "second"]);
    }

    #[tokio::test]
    async fn cancelling_stops_the_playback() {
        let dir = tempfile::tempdir().unwrap();
        let t1 = dir.path().join("rec/turn-1");
        std::fs::create_dir_all(&t1).unwrap();
        std::fs::write(t1.join("stdout.jsonl"), "{\"type\":\"x\"}\n".repeat(50)).unwrap();
        let backend = ReplayBackend::new(&dir.path().join("rec"), Duration::from_millis(100));
        let cancel = CancellationToken::new();
        let trigger = cancel.clone();
        tokio::spawn(async move { tokio::time::sleep(Duration::from_millis(150)).await; trigger.cancel(); });
        let outcome = backend.run(&turn(dir.path()), &cancel, &|_| {}).await.unwrap();
        assert!(outcome.cancelled);
    }
}
