//! App-wide settings and the list of recently opened workspaces. Both are small
//! JSON files in the operating system's configuration folder for the app.

use crate::error::Result;
use crate::names::{APPLICATION, ORGANISATION, QUALIFIER};
use crate::util;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// How many recent workspaces are remembered.
const RECENT_LIMIT: usize = 12;

/// The folder the app keeps its own files in. The environment variable
/// `CODJIVA_CONFIG_DIR` overrides the operating system's location; tests and
/// automated checks use it so they never touch the user's real settings.
pub fn config_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("CODJIVA_CONFIG_DIR") {
        return PathBuf::from(dir);
    }
    directories::ProjectDirs::from(QUALIFIER, ORGANISATION, APPLICATION)
        .map(|dirs| dirs.config_dir().to_path_buf())
        .unwrap_or_else(|| PathBuf::from(".codjiva-config"))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FilmLength {
    Short,
    Standard,
    Deep,
}

impl FilmLength {
    /// The target length of a film in real seconds.
    pub fn seconds(self) -> u32 {
        match self {
            FilmLength::Short => 60,
            FilmLength::Standard => 180,
            FilmLength::Deep => 300,
        }
    }
}

/// How much effort a model spends on thinking before it writes. More effort
/// takes longer and costs more.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Effort {
    Low,
    Medium,
    High,
}

impl Effort {
    /// The word agents and providers use for this level.
    pub fn as_str(self) -> &'static str {
        match self {
            Effort::Low => "low",
            Effort::Medium => "medium",
            Effort::High => "high",
        }
    }

    /// The level a word names, or `None` for any other word.
    pub fn parse(word: &str) -> Option<Effort> {
        [Effort::Low, Effort::Medium, Effort::High]
            .into_iter()
            .find(|level| level.as_str() == word)
    }
}

/// What Settings says about thinking effort.
#[derive(
    Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize,
)]
#[serde(rename_all = "lowercase")]
pub enum EffortSetting {
    /// The app chooses by the kind of job. A still visual is drawn at low
    /// effort, which is enough for one picture and keeps the wait short. A film
    /// and a pipeline are made at medium effort, because they have to stay
    /// consistent over many scenes or several parts.
    #[default]
    Auto,
    /// Nothing is asked for, so the agent or provider uses its own default.
    Agent,
    Low,
    Medium,
    High,
}

/// Which colours the app's window uses. The visuals and films shown in it are
/// drawn in the same theme.
#[derive(
    Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize,
)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    /// Light or dark, whichever the operating system is set to.
    #[default]
    System,
    Light,
    Dark,
}

/// Reads the effort setting. A settings file that holds `null` for it means
/// "leave it to the agent".
fn effort_setting<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<EffortSetting, D::Error> {
    Ok(Option::<EffortSetting>::deserialize(deserializer)?
        .unwrap_or(EffortSetting::Agent))
}

/// The panels around the editor area as the user left them: which are open, and
/// their sizes in pixels. The window is laid out from this when the app starts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Layout {
    pub sidebar_open: bool,
    pub sidebar_width: u32,
    pub inspector_open: bool,
    pub inspector_width: u32,
    /// The height the user dragged the job panel to. `None` means the height
    /// the app chooses by the kind of job.
    pub dock_height: Option<u32>,
    pub library_open: bool,
    /// The height the user dragged the library to. `None` means as tall as its
    /// list needs.
    pub library_height: Option<u32>,
    /// The height the user dragged the strip of panels under a step-through
    /// to. `None` means the height the step-through's own page starts with.
    pub step_panel_height: Option<u32>,
}

impl Default for Layout {
    fn default() -> Self {
        Layout {
            sidebar_open: true,
            sidebar_width: 280,
            inspector_open: true,
            inspector_width: 320,
            dock_height: None,
            library_open: true,
            library_height: None,
            step_panel_height: None,
        }
    }
}

/// Every setting has a default, and a settings file may leave any of them out.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// The id of the agent or API provider that runs jobs. `None` means "the
    /// first one that is available".
    pub agent: Option<String>,
    /// The model to ask each agent for, by agent id. An agent that is not
    /// listed uses its own default model.
    pub models: BTreeMap<String, String>,
    /// How much effort the model spends on thinking.
    #[serde(deserialize_with = "effort_setting")]
    pub effort: EffortSetting,
    /// The address of each API provider, by provider id, for providers that are
    /// not reached at their usual address. The OpenAI-compatible provider has
    /// no usual address and needs one.
    pub api_base_urls: BTreeMap<String, String>,
    /// Where an agent's program is, by agent id, for programs the app cannot
    /// find by itself.
    pub agent_paths: BTreeMap<String, String>,
    /// How many times a failed self-test is sent back to the agent before the
    /// app gives up. A job makes one round more than this when one of its
    /// reports has only build problems or exceptions, because such a report
    /// cannot list the layout problems yet.
    pub max_fix_iterations: u32,
    /// Whether a command-line agent may load the user's own setup for it:
    /// instruction files such as CLAUDE.md, skills, plugins and hooks. With
    /// false, which is the default, an agent whose definition has `plainArgs`
    /// is started with them, so that a job gets only Codjiva's instructions.
    pub agent_customizations: bool,
    pub film_length: FilmLength,
    pub sound_on_by_default: bool,
    /// Animation seconds per real second in normal playback of new films.
    pub base_playback_speed: f64,
    /// The command that opens a file at a line in the user's editor. `{file}`
    /// and `{line}` are replaced.
    pub external_editor_command: String,
    /// The most companion files a film job may be given.
    pub max_companion_files: u32,
    /// Patterns for files and folders that are never suggested as companions,
    /// written like the lines of a `.gitignore` file. See
    /// `companions::IgnoreList` for the forms.
    pub companion_ignore: Vec<String>,
    pub theme: Theme,
    /// The most a single job may spend, in US dollars, for agents that can
    /// enforce a budget.
    pub max_budget_usd: Option<f64>,
    pub layout: Layout,
    /// Whether the app asks GitHub for a newer version by itself, shortly
    /// after it starts and every two hours. With this off, it asks only when
    /// the user clicks the button in Settings.
    pub check_for_updates: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            agent: None,
            models: BTreeMap::new(),
            effort: EffortSetting::Auto,
            api_base_urls: BTreeMap::new(),
            agent_paths: BTreeMap::new(),
            max_fix_iterations: 3,
            agent_customizations: false,
            film_length: FilmLength::Standard,
            sound_on_by_default: false,
            base_playback_speed: 0.6,
            external_editor_command: "code -g {file}:{line}".to_string(),
            max_companion_files: 12,
            // The usual folders for code that was copied in from other
            // projects.
            companion_ignore: vec![
                "vendor/".to_string(),
                "third_party/".to_string(),
                "node_modules/".to_string(),
            ],
            theme: Theme::System,
            max_budget_usd: None,
            layout: Layout::default(),
            check_for_updates: true,
        }
    }
}

impl Settings {
    pub fn load(dir: &Path) -> Result<Settings> {
        Ok(util::read_json(&dir.join("settings.json"))?.unwrap_or_default())
    }

    pub fn save(&self, dir: &Path) -> Result<()> {
        util::write_json(&dir.join("settings.json"), self)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentWorkspace {
    pub path: String,
    pub name: String,
    pub opened_at: String,
}

/// The recently opened workspaces, most recent first. Folders that no longer
/// exist are left out.
pub fn recent_workspaces(dir: &Path) -> Vec<RecentWorkspace> {
    let list: Vec<RecentWorkspace> = util::read_json(&dir.join("recents.json"))
        .ok()
        .flatten()
        .unwrap_or_default();
    list.into_iter()
        .filter(|r| Path::new(&r.path).is_dir())
        .collect()
}

/// Puts a workspace at the top of the recent list.
pub fn remember_workspace(dir: &Path, path: &str, name: &str) -> Result<()> {
    let mut list = recent_workspaces(dir);
    list.retain(|r| r.path != path);
    list.insert(
        0,
        RecentWorkspace {
            path: path.to_string(),
            name: name.to_string(),
            opened_at: util::now_rfc3339(),
        },
    );
    list.truncate(RECENT_LIMIT);
    util::write_json(&dir.join("recents.json"), &list)
}

/// One file tab of a workspace, as the interface describes it.
///
///   - `path` is what the tab stands for: a file's path inside the workspace,
///     a folder's path with a slash at its end, or the id of a pipeline after
///     the prefix the interface gives pipelines.
///   - `view` is which view of it was showing, such as `visual` or `source`.
///   - `line` is the line the source view was at, when it was at one.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTab {
    pub path: String,
    pub view: String,
    #[serde(default)]
    pub line: Option<u64>,
}

/// What was open in a workspace when the user last used it: the file tabs
/// from left to right, and the `path` of the tab that was on screen. The
/// interface shows them again when the user opens the same folder.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WorkspaceSession {
    pub open_files: Vec<SessionTab>,
    pub selected: Option<String>,
}

/// The sessions of all workspaces, by the path of the workspace folder, as
/// they are kept in `sessions.json`.
fn sessions(dir: &Path) -> BTreeMap<String, WorkspaceSession> {
    util::read_json(&dir.join("sessions.json"))
        .ok()
        .flatten()
        .unwrap_or_default()
}

/// What was open in the workspace at `path` when it was last used. Returns an
/// empty session for a workspace that has none.
pub fn workspace_session(dir: &Path, path: &str) -> WorkspaceSession {
    sessions(dir).remove(path).unwrap_or_default()
}

/// Keeps `session` as what is open in the workspace at `path`.
///
/// Sessions are kept only for the workspaces in the recent list, and for
/// `path` itself. The session of a workspace that has left that list is
/// dropped here, so the file does not grow without limit.
pub fn remember_session(
    dir: &Path,
    path: &str,
    session: &WorkspaceSession,
) -> Result<()> {
    let recent: Vec<String> =
        recent_workspaces(dir).into_iter().map(|r| r.path).collect();
    let mut all = sessions(dir);
    all.retain(|known, _| recent.contains(known));
    all.insert(path.to_string(), session.clone());
    util::write_json(&dir.join("sessions.json"), &all)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_session_is_kept_per_workspace_and_dropped_with_its_recent_entry() {
        let config = tempfile::tempdir().unwrap();
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let (pa, pb) = (
            a.path().to_string_lossy().to_string(),
            b.path().to_string_lossy().to_string(),
        );
        assert_eq!(
            workspace_session(config.path(), &pa),
            WorkspaceSession::default()
        );
        let of_a = WorkspaceSession {
            open_files: vec![
                SessionTab {
                    path: "internal/orders/handler.go".into(),
                    view: "source".into(),
                    line: Some(42),
                },
                SessionTab {
                    path: "internal/".into(),
                    view: "map".into(),
                    line: None,
                },
            ],
            selected: Some("internal/orders/handler.go".into()),
        };
        let of_b = WorkspaceSession {
            open_files: vec![SessionTab {
                path: "README.md".into(),
                view: "source".into(),
                line: None,
            }],
            selected: Some("README.md".into()),
        };
        remember_workspace(config.path(), &pa, "a").unwrap();
        remember_session(config.path(), &pa, &of_a).unwrap();
        remember_workspace(config.path(), &pb, "b").unwrap();
        remember_session(config.path(), &pb, &of_b).unwrap();
        assert_eq!(workspace_session(config.path(), &pa), of_a);
        assert_eq!(workspace_session(config.path(), &pb), of_b);

        // The folder of `b` is deleted, so it leaves the recent list. Its
        // session is dropped the next time any session is saved.
        drop(b);
        remember_session(config.path(), &pa, &of_a).unwrap();
        assert_eq!(
            workspace_session(config.path(), &pb),
            WorkspaceSession::default()
        );
        assert_eq!(workspace_session(config.path(), &pa), of_a);
    }

    #[test]
    fn a_partial_settings_file_keeps_the_defaults_for_what_it_omits() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("settings.json"),
            r#"{"maxFixIterations": 5, "filmLength": "deep"}"#,
        )
        .unwrap();
        let settings = Settings::load(dir.path()).unwrap();
        assert_eq!(settings.max_fix_iterations, 5);
        assert!(!settings.agent_customizations);
        assert_eq!(settings.film_length.seconds(), 300);
        assert_eq!(settings.external_editor_command, "code -g {file}:{line}");
        assert_eq!(settings.effort, EffortSetting::Auto);
        assert_eq!(settings.theme, Theme::System);
        assert!(settings.companion_ignore.contains(&"vendor/".to_string()));
        assert_eq!(settings.layout, Layout::default());
        assert!(settings.check_for_updates);
        std::fs::write(dir.path().join("settings.json"), r#"{"effort": null}"#)
            .unwrap();
        assert_eq!(
            Settings::load(dir.path()).unwrap().effort,
            EffortSetting::Agent
        );
        std::fs::write(
            dir.path().join("settings.json"),
            r#"{"effort": "high"}"#,
        )
        .unwrap();
        assert_eq!(
            Settings::load(dir.path()).unwrap().effort,
            EffortSetting::High
        );
    }

    #[test]
    fn settings_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let mut settings = Settings {
            agent: Some("claude-code".into()),
            ..Settings::default()
        };
        settings
            .models
            .insert("claude-code".into(), "sonnet".into());
        settings.companion_ignore = vec!["/gen/".into()];
        settings.theme = Theme::Light;
        settings.save(dir.path()).unwrap();
        assert_eq!(Settings::load(dir.path()).unwrap(), settings);
    }

    #[test]
    fn recents_are_most_recent_first_without_duplicates_or_missing_folders() {
        let config = tempfile::tempdir().unwrap();
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let (pa, pb) = (
            a.path().to_string_lossy().to_string(),
            b.path().to_string_lossy().to_string(),
        );
        remember_workspace(config.path(), &pa, "a").unwrap();
        remember_workspace(config.path(), &pb, "b").unwrap();
        remember_workspace(config.path(), &pa, "a").unwrap();
        let names: Vec<String> = recent_workspaces(config.path())
            .into_iter()
            .map(|r| r.name)
            .collect();
        assert_eq!(names, vec!["a", "b"]);
        drop(b);
        assert_eq!(recent_workspaces(config.path()).len(), 1);
    }
}
