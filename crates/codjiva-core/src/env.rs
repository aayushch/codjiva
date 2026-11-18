//! The environment agent programs are started with.
//!
//! An app started from the Dock or a desktop launcher gets a minimal
//! environment. Its PATH lacks the folders where package managers install
//! command-line tools, and variables the user set in their shell profile, such
//! as API keys, are missing. So the app asks the user's login shell for its
//! environment once at start, and starts agents with that.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Folders, relative to the user's home, where agent programs are commonly
/// installed. They are added to the end of PATH when they exist and are not
/// already on it.
#[cfg(unix)]
const EXTRA_HOME_DIRS: &[&str] = &[
    ".local/bin",
    ".cargo/bin",
    ".npm-global/bin",
    "Library/pnpm/bin",
    ".bun/bin",
];
#[cfg(unix)]
const EXTRA_DIRS: &[&str] = &["/opt/homebrew/bin", "/usr/local/bin"];
#[cfg(windows)]
const EXTRA_HOME_DIRS: &[&str] = &[
    ".local/bin",
    ".cargo/bin",
    "AppData/Roaming/npm",
    "AppData/Local/pnpm",
    ".bun/bin",
];
#[cfg(windows)]
const EXTRA_DIRS: &[&str] = &[];

/// The file extensions Windows tries when a program is named without one.
#[cfg(windows)]
const DEFAULT_PATHEXT: &str = ".EXE;.CMD;.BAT;.COM";

#[derive(Debug, Clone, Default)]
pub struct ShellEnv {
    vars: BTreeMap<String, String>,
}

impl ShellEnv {
    /// Reads the environment agents should run in: this process's own
    /// variables, overlaid with the login shell's on macOS and Linux, with the
    /// usual install folders added to PATH. It can take a few seconds, because
    /// it starts a shell that reads the user's profile.
    pub fn capture() -> ShellEnv {
        let mut vars: BTreeMap<String, String> = std::env::vars().collect();
        // Windows spells the variable `Path`. One spelling is kept so a child
        // never gets both.
        if let Some(path) = vars.remove("Path") {
            vars.entry("PATH".to_string()).or_insert(path);
        }
        if let Some(shell_vars) = login_shell_env() {
            vars.extend(shell_vars);
        }
        let mut env = ShellEnv { vars };
        env.add_install_dirs();
        env
    }

    /// Builds an environment from explicit variables. Tests use it.
    pub fn from_vars(
        vars: impl IntoIterator<Item = (String, String)>,
    ) -> ShellEnv {
        ShellEnv {
            vars: vars.into_iter().collect(),
        }
    }

    pub fn vars(&self) -> &BTreeMap<String, String> {
        &self.vars
    }

    pub fn get(&self, name: &str) -> Option<&str> {
        self.vars.get(name).map(String::as_str)
    }

    fn add_install_dirs(&mut self) {
        let home = self
            .get("HOME")
            .or_else(|| self.get("USERPROFILE"))
            .map(PathBuf::from);
        let mut dirs: Vec<PathBuf> =
            std::env::split_paths(self.get("PATH").unwrap_or("")).collect();
        let mut candidates: Vec<PathBuf> =
            EXTRA_DIRS.iter().map(PathBuf::from).collect();
        if let Some(home) = home {
            candidates.extend(EXTRA_HOME_DIRS.iter().map(|d| home.join(d)));
        }
        for dir in candidates {
            if dir.is_dir() && !dirs.contains(&dir) {
                dirs.push(dir);
            }
        }
        if let Ok(joined) = std::env::join_paths(dirs) {
            self.vars.insert(
                "PATH".to_string(),
                joined.to_string_lossy().into_owned(),
            );
        }
    }

    /// Finds a program by name on PATH and returns its full path. A `name` that
    /// contains a path separator is taken as a path and returned if it is an
    /// executable file.
    pub fn find_program(&self, name: &str) -> Option<PathBuf> {
        if name.contains('/') || name.contains('\\') {
            let path = PathBuf::from(name);
            return is_executable(&path).then_some(path);
        }
        std::env::split_paths(self.get("PATH").unwrap_or(""))
            .flat_map(|dir| {
                executable_names(name, self.get("PATHEXT"))
                    .into_iter()
                    .map(move |file| dir.join(file))
            })
            .find(|candidate| is_executable(candidate))
    }
}

#[cfg(unix)]
fn executable_names(name: &str, _pathext: Option<&str>) -> Vec<String> {
    vec![name.to_string()]
}

#[cfg(windows)]
fn executable_names(name: &str, pathext: Option<&str>) -> Vec<String> {
    let mut names = vec![name.to_string()];
    for ext in pathext
        .unwrap_or(DEFAULT_PATHEXT)
        .split(';')
        .filter(|e| !e.is_empty())
    {
        names.push(format!("{name}{}", ext.to_ascii_lowercase()));
        names.push(format!("{name}{ext}"));
    }
    names
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

#[cfg(windows)]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

/// Runs the user's login shell and returns the environment it ends up with.
/// Returns `None` on Windows, where there is no such shell, and when the shell
/// fails or takes too long.
#[cfg(unix)]
fn login_shell_env() -> Option<BTreeMap<String, String>> {
    let shell = std::env::var("SHELL")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "/bin/sh".to_string());
    // An interactive login shell reads every profile file. Some shells refuse
    // `-i` without a terminal, so a plain login shell is tried second.
    for flags in ["-ilc", "-lc"] {
        let output = run_capture(
            Command::new(&shell).args([flags, "env -0"]),
            Duration::from_secs(5),
        );
        if let Some(bytes) = output.filter(|b| !b.is_empty()) {
            let vars = parse_null_separated(&bytes);
            if vars.contains_key("PATH") {
                return Some(vars);
            }
        }
    }
    None
}

#[cfg(windows)]
fn login_shell_env() -> Option<BTreeMap<String, String>> {
    None
}

/// Parses `NAME=value` entries separated by NUL bytes, as `env -0` prints them.
/// Entries for exported shell functions are skipped; their values are code, not
/// settings.
#[cfg(unix)]
fn parse_null_separated(bytes: &[u8]) -> BTreeMap<String, String> {
    bytes
        .split(|b| *b == 0)
        .filter_map(|entry| {
            let text = String::from_utf8_lossy(entry);
            let (name, value) = text.split_once('=')?;
            (!name.is_empty() && !name.starts_with("BASH_FUNC_"))
                .then(|| (name.to_string(), value.to_string()))
        })
        .collect()
}

/// Runs a command and returns what it printed, or `None` when it could not be
/// started, exited with an error, or was still running after `limit`, in which
/// case it is killed.
pub fn run_capture(command: &mut Command, limit: Duration) -> Option<Vec<u8>> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    // The output is read on another thread so a program that prints a lot
    // cannot block on a full pipe while this thread waits for it to exit.
    let reader = std::thread::spawn(move || {
        let mut buffer = Vec::new();
        let _ = std::io::Read::read_to_end(&mut stdout, &mut buffer);
        buffer
    });
    let began = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let output = reader.join().ok()?;
                return status.success().then_some(output);
            }
            Ok(None) if began.elapsed() < limit => {
                std::thread::sleep(Duration::from_millis(20))
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

// The tests are compiled only on Unix. One calls `parse_null_separated`, which
// exists only on Unix. One sets Unix file permissions. One runs `/bin/sh`.
#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn parses_env_output_and_skips_shell_functions() {
        let vars = parse_null_separated(b"PATH=/bin:/usr/bin\0EDITOR=vim -f\0BASH_FUNC_x%%=() { :; }\0EMPTY=\0");
        assert_eq!(vars.get("PATH").unwrap(), "/bin:/usr/bin");
        assert_eq!(vars.get("EDITOR").unwrap(), "vim -f");
        assert_eq!(vars.get("EMPTY").unwrap(), "");
        assert!(!vars.keys().any(|k| k.starts_with("BASH_FUNC")));
    }

    #[test]
    fn finds_an_executable_on_path_and_ignores_plain_files() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let tool = dir.path().join("mytool");
        std::fs::write(&tool, "#!/bin/sh\n").unwrap();
        std::fs::write(dir.path().join("notes"), "text").unwrap();
        std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o755))
            .unwrap();
        let env = ShellEnv::from_vars([(
            "PATH".to_string(),
            dir.path().to_string_lossy().into_owned(),
        )]);
        assert_eq!(env.find_program("mytool"), Some(tool.clone()));
        assert_eq!(env.find_program("notes"), None);
        assert_eq!(env.find_program("absent"), None);
        assert_eq!(env.find_program(&tool.to_string_lossy()), Some(tool));
    }

    #[test]
    fn run_capture_returns_output_and_gives_up_on_a_slow_command() {
        let out = run_capture(
            Command::new("/bin/sh").args(["-c", "printf hello"]),
            Duration::from_secs(5),
        );
        assert_eq!(out.as_deref(), Some(&b"hello"[..]));
        let began = Instant::now();
        assert!(run_capture(
            Command::new("/bin/sh").args(["-c", "sleep 30"]),
            Duration::from_millis(200)
        )
        .is_none());
        assert!(began.elapsed() < Duration::from_secs(5));
    }
}
