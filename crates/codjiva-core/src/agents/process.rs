//! Runs an agent program and reads its output line by line.
//!
//! The program is started directly, never through a shell, so no argument is
//! ever interpreted. It gets its own process group, and cancelling stops the
//! whole group: agent programs are often small launchers that start the real
//! work in a child process.

use crate::agents::definition::SpawnSpec;
use crate::error::{AppError, Result};
use std::collections::{BTreeMap, VecDeque};
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio_util::sync::CancellationToken;

/// A single line of output longer than this is dropped. Agents print whole
/// files they write as one line of JSON, so the limit is generous.
const MAX_LINE_BYTES: usize = 32 * 1024 * 1024;

/// How many lines of the program's error output are kept for error messages.
const STDERR_TAIL_LINES: usize = 40;

/// On cancel, the program is first asked to stop, so an agent can end its turn
/// cleanly. If it is still running after this long it is told to terminate, and
/// after the second wait it is killed.
const INTERRUPT_WAIT: Duration = Duration::from_secs(5);
const TERMINATE_WAIT: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessOutcome {
    /// `None` when the program was ended by a signal.
    pub exit_code: Option<i32>,
    pub cancelled: bool,
    /// True when the program printed nothing for the idle limit and was stopped
    /// for it.
    pub idle_timed_out: bool,
    /// The last lines the program wrote to its error output.
    pub stderr_tail: String,
}

impl ProcessOutcome {
    pub fn succeeded(&self) -> bool {
        self.exit_code == Some(0) && !self.cancelled && !self.idle_timed_out
    }
}

/// Starts `program` as `spec` describes and calls `on_line` for every line it
/// prints, until it exits, `cancel` is triggered, or it stays silent for
/// `idle_limit`.
pub async fn run_lines(
    program: &Path,
    spec: &SpawnSpec,
    base_env: &BTreeMap<String, String>,
    idle_limit: Duration,
    cancel: &CancellationToken,
    mut on_line: impl FnMut(&str),
) -> Result<ProcessOutcome> {
    let mut command = Command::new(program);
    command
        .args(&spec.args)
        .current_dir(&spec.cwd)
        .env_clear()
        .envs(base_env)
        .envs(&spec.env)
        .stdin(if spec.stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    // Keeps a console window from flashing up when the app, which has no
    // console, starts a command-line program on Windows.
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);

    let mut child = command.spawn().map_err(|e| {
        AppError::new(
            "agent_start_failed",
            format!("Could not start {}.", program.display()),
        )
        .with_detail(e)
    })?;

    // The prompt is written from its own task. A large prompt could otherwise
    // fill the pipe while the program is not reading yet, and block this task
    // before it starts reading output.
    if let (Some(text), Some(mut stdin)) =
        (spec.stdin.clone(), child.stdin.take())
    {
        tokio::spawn(async move {
            let _ = stdin.write_all(text.as_bytes()).await;
            let _ = stdin.shutdown().await;
        });
    }

    let stderr = child.stderr.take();
    let stderr_task = tokio::spawn(async move {
        let mut tail: VecDeque<String> = VecDeque::new();
        if let Some(stderr) = stderr {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if tail.len() == STDERR_TAIL_LINES {
                    tail.pop_front();
                }
                tail.push_back(line);
            }
        }
        tail.into_iter().collect::<Vec<_>>().join("\n")
    });

    let mut reader = BufReader::with_capacity(
        64 * 1024,
        child.stdout.take().expect("stdout was piped"),
    );
    let mut buffer: Vec<u8> = Vec::new();
    let mut cancelled = false;
    let mut idle_timed_out = false;
    loop {
        buffer.clear();
        tokio::select! {
            _ = cancel.cancelled() => { cancelled = true; break; }
            read = tokio::time::timeout(
                idle_limit,
                reader.read_until(b'\n', &mut buffer),
            ) => match read {
                Err(_) => { idle_timed_out = true; break; }
                Ok(Ok(0)) | Ok(Err(_)) => break,
                Ok(Ok(_)) => {
                    if buffer.len() <= MAX_LINE_BYTES {
                        let line = String::from_utf8_lossy(&buffer);
                        let line = line.trim_end_matches(['\n', '\r']);
                        if !line.is_empty() {
                            on_line(line);
                        }
                    }
                }
            }
        }
    }

    if cancelled || idle_timed_out {
        stop(&mut child).await;
    }
    let status = child.wait().await.ok();
    end_group(&child);
    let stderr_tail = stderr_task.await.unwrap_or_default();
    Ok(ProcessOutcome {
        exit_code: status.and_then(|s| s.code()),
        cancelled,
        idle_timed_out,
        stderr_tail,
    })
}

/// Stops the program and everything it started.
///
/// The program leads its own process group, so a signal sent to the group
/// reaches the processes it started too. The group is first interrupted, which
/// lets an agent end its turn cleanly. Whatever is still running after the
/// waits is terminated and then killed. That includes processes that outlive
/// the program itself: a shell, for example, starts its background jobs with
/// the interrupt signal ignored.
#[cfg(unix)]
async fn stop(child: &mut Child) {
    let Some(pid) = child.id() else { return };
    let signal_group = |signal: libc::c_int| unsafe {
        libc::killpg(pid as libc::pid_t, signal)
    };
    signal_group(libc::SIGINT);
    let _ = tokio::time::timeout(INTERRUPT_WAIT, child.wait()).await;
    signal_group(libc::SIGTERM);
    let _ = tokio::time::timeout(TERMINATE_WAIT, child.wait()).await;
    signal_group(libc::SIGKILL);
    let _ = child.start_kill();
}

/// Ends any process of the program's group that is still running after the
/// program itself has exited, so a finished job leaves nothing behind.
#[cfg(unix)]
fn end_group(child: &Child) {
    if let Some(pid) = child.id() {
        unsafe { libc::killpg(pid as libc::pid_t, libc::SIGTERM) };
    }
}

#[cfg(windows)]
fn end_group(_child: &Child) {}

/// Stops the program and everything it started. Windows has no signal an app
/// without a console can send to ask politely, so the whole process tree is
/// ended at once.
#[cfg(windows)]
async fn stop(child: &mut Child) {
    if let Some(pid) = child.id() {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(0x0800_0000)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await;
    }
    let _ = tokio::time::timeout(INTERRUPT_WAIT + TERMINATE_WAIT, child.wait())
        .await;
    let _ = child.start_kill();
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::time::Instant;

    fn spec(script: &str, stdin: Option<&str>) -> SpawnSpec {
        SpawnSpec {
            args: vec!["-c".into(), script.into()],
            stdin: stdin.map(str::to_string),
            cwd: "/".into(),
            env: BTreeMap::new(),
        }
    }

    fn base_env() -> BTreeMap<String, String> {
        BTreeMap::from([("PATH".to_string(), "/bin:/usr/bin".to_string())])
    }

    async fn run(
        script: &str,
        stdin: Option<&str>,
        idle: Duration,
        cancel: &CancellationToken,
    ) -> (ProcessOutcome, Vec<String>) {
        let mut lines = Vec::new();
        let outcome = run_lines(
            Path::new("/bin/sh"),
            &spec(script, stdin),
            &base_env(),
            idle,
            cancel,
            |l| lines.push(l.to_string()),
        )
        .await
        .unwrap();
        (outcome, lines)
    }

    #[tokio::test]
    async fn reads_lines_stdin_and_the_exit_code() {
        let (outcome, lines) = run(
            "read x; echo \"got $x\"; echo second; echo oops >&2; exit 3",
            Some("hello\n"),
            Duration::from_secs(10),
            &CancellationToken::new(),
        )
        .await;
        assert_eq!(lines, vec!["got hello", "second"]);
        assert_eq!(
            (outcome.exit_code, outcome.cancelled, outcome.succeeded()),
            (Some(3), false, false)
        );
        assert_eq!(outcome.stderr_tail, "oops");
    }

    #[tokio::test]
    async fn only_the_given_environment_reaches_the_program() {
        std::env::set_var("CODJIVA_TEST_LEAK", "leaked");
        let (_, lines) = run(
            "echo \"[${CODJIVA_TEST_LEAK}]\"",
            None,
            Duration::from_secs(10),
            &CancellationToken::new(),
        )
        .await;
        assert_eq!(lines, vec!["[]"]);
    }

    #[tokio::test]
    async fn cancelling_stops_the_program_and_the_processes_it_started() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("child-survived");
        // The program starts a child that would write the marker after two
        // seconds, then waits.
        let script = format!(
            "(sleep 2; touch {}) & echo started; wait",
            marker.display()
        );
        let cancel = CancellationToken::new();
        let trigger = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(300)).await;
            trigger.cancel();
        });
        let began = Instant::now();
        let (outcome, lines) =
            run(&script, None, Duration::from_secs(30), &cancel).await;
        assert_eq!(lines, vec!["started"]);
        assert!(outcome.cancelled);
        assert!(
            began.elapsed() < Duration::from_secs(5),
            "stopping took {:?}",
            began.elapsed()
        );
        tokio::time::sleep(Duration::from_millis(2500)).await;
        assert!(
            !marker.exists(),
            "a process started by the program outlived the cancel"
        );
    }

    #[tokio::test]
    async fn a_silent_program_is_stopped_at_the_idle_limit() {
        let (outcome, lines) = run(
            "echo one; sleep 30",
            None,
            Duration::from_millis(400),
            &CancellationToken::new(),
        )
        .await;
        assert_eq!(lines, vec!["one"]);
        assert!(outcome.idle_timed_out && !outcome.succeeded());
    }

    #[tokio::test]
    async fn a_program_that_does_not_exist_is_reported() {
        let error = run_lines(
            Path::new("/no/such/program"),
            &spec("", None),
            &base_env(),
            Duration::from_secs(1),
            &CancellationToken::new(),
            |_| {},
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "agent_start_failed");
    }
}
