//! Artifacts on disk: the visuals and films kept under `.codjiva/artifacts/`.
//!
//!   - `artifacts/<artifactId>/`
//!     - `artifact.json`: what the artifact is and which version is shown.
//!     - `v1/`
//!       - `manifest.json`: everything about this version: sources and their
//!         hashes, agent, checks.
//!       - `model.json`: the agent's analysis of the code.
//!       - `src/`: the sources the agent wrote.
//!       - `index.html`: the page the app built from them.
//!       - `validation.json`: the last self-test report.
//!     - `v2/` ...
//!
//! Versions are only ever added. Regenerating an artifact adds a version; it
//! never replaces one.

use crate::error::{AppError, Result};
use crate::util;
use crate::workspace::{hash_bytes, Workspace};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

pub const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ArtifactKind {
    Visual,
    Film,
    Pipeline,
}

impl ArtifactKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ArtifactKind::Visual => "visual",
            ArtifactKind::Film => "film",
            ArtifactKind::Pipeline => "pipeline",
        }
    }
}

/// The contents of `artifact.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactMeta {
    pub schema_version: u32,
    pub id: String,
    pub kind: ArtifactKind,
    pub subject: Vec<String>,
    pub title: String,
    pub created_at: String,
    pub current_version: u32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Companion {
    pub path: String,
    #[serde(default)]
    pub why: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentRecord {
    /// The agent's id, such as `claude-code`.
    pub kind: String,
    pub version: Option<String>,
    pub model: Option<String>,
    /// The agent's session, kept so a later fix can continue the same
    /// conversation.
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ValidationRecord {
    /// True when the last self-test found no errors.
    pub passed: bool,
    /// How many times the result was sent back to the agent to be fixed.
    pub iterations: u32,
    pub errors: u32,
    pub warnings: u32,
}

/// The contents of a version's `manifest.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub schema_version: u32,
    pub artifact_id: String,
    pub version: u32,
    pub kind: ArtifactKind,
    pub title: String,
    pub subject: Vec<String>,
    #[serde(default)]
    pub companions: Vec<Companion>,
    /// The content hash of every source file this version was made from, by
    /// path. An artifact is stale when a file's current hash differs from the
    /// one recorded here.
    pub sources: BTreeMap<String, String>,
    /// What the user asked this version to show, in their words.
    #[serde(default)]
    pub instructions: String,
    pub agent: AgentRecord,
    pub prompt_version: String,
    pub runtime_version: String,
    /// The length of a film in seconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_sec: Option<f64>,
    #[serde(default)]
    pub chapters: Vec<Value>,
    #[serde(default)]
    pub ports: Vec<Value>,
    pub validation: ValidationRecord,
    pub created_at: String,
    /// The version this one was derived from, for a regeneration or a fix.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<u32>,
    /// The user's feedback that produced this version, for a fix.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub feedback: Option<String>,
    /// What the job cost, where the agent reports it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
    /// For a pipeline: whether it is a `visual` or a `film`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub form: Option<String>,
    /// For a pipeline: the artifacts it joins, in flow order, and the joins
    /// between them.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub parts: Vec<crate::compose::Part>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub joins: Vec<crate::compose::Join>,
}

/// One version, as the interface lists it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionSummary {
    pub version: u32,
    pub created_at: String,
    pub passed: bool,
    pub errors: u32,
    pub warnings: u32,
    pub instructions: String,
    pub agent: String,
    pub model: Option<String>,
    pub parent: Option<u32>,
}

/// One artifact, as the interface lists it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactSummary {
    pub id: String,
    pub kind: ArtifactKind,
    pub title: String,
    pub subject: Vec<String>,
    pub current_version: u32,
    pub versions: Vec<VersionSummary>,
    /// Every source file the current version was made from.
    pub sources: Vec<String>,
    /// True when a source file has changed, or is gone, since the current
    /// version was made.
    pub stale: bool,
    /// The source files that changed.
    pub stale_sources: Vec<String>,
    pub duration_sec: Option<f64>,
    pub ports: Vec<Value>,
    /// For a pipeline: whether its current version is a `visual` or a `film`,
    /// and its parts.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub form: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub parts: Vec<crate::compose::Part>,
}

/// Everything the interface needs to show one version.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactDetail {
    pub manifest: Manifest,
    /// The version's `visual.json` or `film.json`.
    pub definition: Option<Value>,
    pub model: Option<Value>,
    pub validation: Option<Value>,
    /// The size of the built page.
    pub bytes: u64,
}

/// Turns a path into a short name that is safe as a folder name: lower-case
/// letters, digits and underscores, at most 60 characters.
fn slug(path: &str) -> String {
    let mut out = String::new();
    for c in path.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('_') {
            out.push('_');
        }
    }
    let trimmed = out.trim_matches('_');
    // A long path keeps its end, which holds the file name.
    let start = trimmed.len().saturating_sub(60);
    trimmed[start..].trim_matches('_').to_string()
}

/// The id of the artifact of `kind` for a set of subject files. The same kind
/// and files always give the same id, in any order, so regenerating adds a
/// version to the same artifact.
pub fn artifact_id(kind: ArtifactKind, subject: &[String]) -> String {
    let mut sorted: Vec<&str> = subject.iter().map(String::as_str).collect();
    sorted.sort_unstable();
    let hash = hash_bytes(sorted.join("\n").as_bytes());
    let short = &hash["sha256:".len().."sha256:".len() + 6];
    format!(
        "{}-{}-{}",
        kind.as_str(),
        slug(subject.first().map(String::as_str).unwrap_or("")),
        short
    )
}

/// An id is used as a folder name, so anything that is not one of ours is
/// refused before it reaches the file system.
fn check_id(id: &str) -> Result<()> {
    let ok = !id.is_empty()
        && id.len() <= 120
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok {
        Ok(())
    } else {
        Err(AppError::new(
            "bad_artifact_id",
            "That is not a valid artifact id.",
        ))
    }
}

pub fn artifacts_dir(ws: &Workspace) -> PathBuf {
    ws.dot_dir().join("artifacts")
}

pub fn artifact_dir(ws: &Workspace, id: &str) -> Result<PathBuf> {
    check_id(id)?;
    Ok(artifacts_dir(ws).join(id))
}

pub fn version_dir(ws: &Workspace, id: &str, version: u32) -> Result<PathBuf> {
    Ok(artifact_dir(ws, id)?.join(format!("v{version}")))
}

/// The version numbers that exist for an artifact, in order. A version exists
/// once its folder does, whether or not its job has finished.
fn version_numbers(ws: &Workspace, id: &str) -> Result<Vec<u32>> {
    let mut numbers: Vec<u32> = fs::read_dir(artifact_dir(ws, id)?)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .strip_prefix('v')
                .and_then(|n| n.parse().ok())
        })
        .collect();
    numbers.sort_unstable();
    Ok(numbers)
}

/// The number the next version of an artifact gets.
pub fn next_version(ws: &Workspace, id: &str) -> Result<u32> {
    Ok(version_numbers(ws, id)?.last().copied().unwrap_or(0) + 1)
}

pub fn read_manifest(
    ws: &Workspace,
    id: &str,
    version: u32,
) -> Result<Manifest> {
    util::read_json(&version_dir(ws, id, version)?.join("manifest.json"))?
        .ok_or_else(|| {
            AppError::new(
                "not_found",
                "That version of the artifact does not exist.",
            )
        })
}

pub fn read_meta(ws: &Workspace, id: &str) -> Result<ArtifactMeta> {
    util::read_json(&artifact_dir(ws, id)?.join("artifact.json"))?.ok_or_else(
        || AppError::new("not_found", "That artifact does not exist."),
    )
}

/// Records a finished version: writes its manifest and makes it the version
/// that is shown.
pub fn commit_version(ws: &Workspace, manifest: &Manifest) -> Result<()> {
    let id = &manifest.artifact_id;
    util::write_json(
        &version_dir(ws, id, manifest.version)?.join("manifest.json"),
        manifest,
    )?;
    let meta = match read_meta(ws, id) {
        Ok(mut meta) => {
            meta.current_version = manifest.version;
            meta.title = manifest.title.clone();
            meta
        }
        Err(_) => ArtifactMeta {
            schema_version: SCHEMA_VERSION,
            id: id.clone(),
            kind: manifest.kind,
            subject: manifest.subject.clone(),
            title: manifest.title.clone(),
            created_at: manifest.created_at.clone(),
            current_version: manifest.version,
        },
    };
    util::write_json(&artifact_dir(ws, id)?.join("artifact.json"), &meta)?;
    write_index(ws)
}

/// Compares the hashes a manifest recorded with the files as they are now, and
/// returns the paths that differ or no longer exist.
fn changed_sources(ws: &Workspace, manifest: &Manifest) -> Vec<String> {
    manifest
        .sources
        .iter()
        .filter(|(path, hash)| ws.hash_file(path).as_ref() != Some(*hash))
        .map(|(path, _)| path.clone())
        .collect()
}

fn summarise(ws: &Workspace, id: &str) -> Result<ArtifactSummary> {
    let meta = read_meta(ws, id)?;
    let mut versions = Vec::new();
    let mut current: Option<Manifest> = None;
    for number in version_numbers(ws, id)? {
        // A version folder without a manifest belongs to a job that is running
        // or was abandoned.
        let Ok(manifest) = read_manifest(ws, id, number) else {
            continue;
        };
        versions.push(VersionSummary {
            version: number,
            created_at: manifest.created_at.clone(),
            passed: manifest.validation.passed,
            errors: manifest.validation.errors,
            warnings: manifest.validation.warnings,
            instructions: manifest.instructions.clone(),
            agent: manifest.agent.kind.clone(),
            model: manifest.agent.model.clone(),
            parent: manifest.parent,
        });
        if number == meta.current_version {
            current = Some(manifest);
        }
    }
    let current = current.ok_or_else(|| {
        AppError::new("not_found", "The artifact has no finished version.")
    })?;
    let stale_sources = changed_sources(ws, &current);
    Ok(ArtifactSummary {
        id: meta.id,
        kind: meta.kind,
        title: current.title.clone(),
        subject: current.subject.clone(),
        current_version: meta.current_version,
        versions,
        sources: current.sources.keys().cloned().collect(),
        stale: !stale_sources.is_empty(),
        stale_sources,
        duration_sec: current.duration_sec,
        ports: current.ports.clone(),
        form: current.form.clone(),
        parts: current.parts.clone(),
    })
}

/// Lists every artifact of the workspace that has at least one finished
/// version, by title.
pub fn list(ws: &Workspace) -> Vec<ArtifactSummary> {
    let mut found: Vec<ArtifactSummary> = fs::read_dir(artifacts_dir(ws))
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| entry.path().is_dir())
        .filter_map(|entry| {
            summarise(ws, &entry.file_name().to_string_lossy()).ok()
        })
        .collect();
    found.sort_by(|a, b| {
        a.title
            .to_lowercase()
            .cmp(&b.title.to_lowercase())
            .then_with(|| a.id.cmp(&b.id))
    });
    found
}

/// Writes `.codjiva/index.json`, a summary of every artifact for tools that
/// read the folder without the app: which artifacts exist, their current
/// versions, and which artifacts each source file belongs to.
pub fn write_index(ws: &Workspace) -> Result<()> {
    let artifacts = list(ws);
    let mut by_source: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut entries = serde_json::Map::new();
    for a in &artifacts {
        for source in &a.sources {
            by_source
                .entry(source.clone())
                .or_default()
                .push(a.id.clone());
        }
        entries.insert(
            a.id.clone(),
            serde_json::json!({
                "kind": a.kind,
                "title": a.title,
                "current": a.current_version,
                "sources": a.sources,
                "stale": a.stale,
                "ports": a
                    .ports
                    .iter()
                    .filter_map(|p| p.get("id").cloned())
                    .collect::<Vec<_>>(),
            }),
        );
    }
    util::write_json(
        &ws.dot_dir().join("index.json"),
        &serde_json::json!({
            "schemaVersion": SCHEMA_VERSION,
            "artifacts": entries,
            "bySource": by_source
        }),
    )
}

/// Everything about one version. `version` of `None` means the current one.
pub fn detail(
    ws: &Workspace,
    id: &str,
    version: Option<u32>,
) -> Result<ArtifactDetail> {
    let number = match version {
        Some(n) => n,
        None => read_meta(ws, id)?.current_version,
    };
    let dir = version_dir(ws, id, number)?;
    let manifest = read_manifest(ws, id, number)?;
    let read = |name: &str| -> Option<Value> {
        util::read_json(&dir.join(name)).ok().flatten()
    };
    let definition = if manifest.kind == ArtifactKind::Film {
        read("src/film.json")
    } else {
        read("src/visual.json")
    };
    Ok(ArtifactDetail {
        definition,
        model: read("model.json"),
        validation: read("validation.json"),
        bytes: fs::metadata(dir.join("index.html"))
            .map(|m| m.len())
            .unwrap_or(0),
        manifest,
    })
}

/// The built page of a version, for the frame that shows it.
pub fn read_page(ws: &Workspace, id: &str, version: u32) -> Result<String> {
    fs::read_to_string(version_dir(ws, id, version)?.join("index.html"))
        .map_err(|e| AppError::io("read the artifact", e))
}

/// Makes an existing version the one that is shown.
pub fn set_current(ws: &Workspace, id: &str, version: u32) -> Result<()> {
    read_manifest(ws, id, version)?;
    let mut meta = read_meta(ws, id)?;
    meta.current_version = version;
    util::write_json(&artifact_dir(ws, id)?.join("artifact.json"), &meta)?;
    write_index(ws)
}

/// Deletes an artifact and all its versions.
pub fn delete(ws: &Workspace, id: &str) -> Result<()> {
    let dir = artifact_dir(ws, id)?;
    if dir.is_dir() {
        fs::remove_dir_all(&dir)
            .map_err(|e| AppError::io("delete the artifact", e))?;
    }
    write_index(ws)
}

/// Copies a version's self-contained page to `dest`, a path the user chose.
pub fn export(
    ws: &Workspace,
    id: &str,
    version: Option<u32>,
    dest: &std::path::Path,
) -> Result<()> {
    let number = match version {
        Some(n) => n,
        None => read_meta(ws, id)?.current_version,
    };
    fs::copy(version_dir(ws, id, number)?.join("index.html"), dest)
        .map(|_| ())
        .map_err(|e| AppError::io("export the artifact", e))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace() -> (tempfile::TempDir, Workspace) {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("src")).unwrap();
        fs::write(dir.path().join("src/handler.go"), "package a\n").unwrap();
        let ws = Workspace::open(dir.path()).unwrap();
        (dir, ws)
    }

    fn manifest(ws: &Workspace, id: &str, version: u32) -> Manifest {
        Manifest {
            schema_version: SCHEMA_VERSION,
            artifact_id: id.into(),
            version,
            kind: ArtifactKind::Visual,
            title: format!("Handler v{version}"),
            subject: vec!["src/handler.go".into()],
            companions: vec![],
            sources: BTreeMap::from([(
                "src/handler.go".to_string(),
                ws.hash_file("src/handler.go").unwrap(),
            )]),
            instructions: "show limits".into(),
            agent: AgentRecord {
                kind: "claude-code".into(),
                ..AgentRecord::default()
            },
            prompt_version: "1.0.0".into(),
            runtime_version: "1.0.0".into(),
            duration_sec: None,
            chapters: vec![],
            ports: vec![],
            validation: ValidationRecord {
                passed: true,
                iterations: 1,
                errors: 0,
                warnings: 2,
            },
            created_at: "2026-11-14T12:00:00Z".into(),
            parent: None,
            feedback: None,
            cost_usd: Some(0.4),
            form: None,
            parts: vec![],
            joins: vec![],
        }
    }

    #[test]
    fn ids_are_stable_readable_and_independent_of_order() {
        let a = artifact_id(
            ArtifactKind::Film,
            &[
                "internal/orders/handler.go".into(),
                "internal/orders/store.go".into(),
            ],
        );
        assert!(a.starts_with("film-internal_orders_handler_go-"), "{a}");
        assert_eq!(a.len(), "film-internal_orders_handler_go-".len() + 6);
        let same_set = artifact_id(
            ArtifactKind::Film,
            &[
                "internal/orders/handler.go".into(),
                "internal/orders/store.go".into(),
            ],
        );
        assert_eq!(a, same_set);
        assert_ne!(
            a,
            artifact_id(
                ArtifactKind::Visual,
                &[
                    "internal/orders/handler.go".into(),
                    "internal/orders/store.go".into()
                ]
            )
        );
        assert_ne!(
            a,
            artifact_id(
                ArtifactKind::Film,
                &["internal/orders/handler.go".into()]
            )
        );
        let long = artifact_id(
            ArtifactKind::Visual,
            &[format!("{}/file.rs", "deep/".repeat(40))],
        );
        assert!(
            long.len() <= 7 + 60 + 7 && long.contains("file_rs"),
            "{long}"
        );
    }

    #[test]
    fn folder_names_that_are_not_ids_are_refused() {
        let (_dir, ws) = workspace();
        for bad in ["../x", "a/b", "", "a b"] {
            assert_eq!(
                artifact_dir(&ws, bad).unwrap_err().code,
                "bad_artifact_id",
                "{bad:?}"
            );
        }
    }

    #[test]
    fn versions_are_added_listed_and_switched() {
        let (dir, ws) = workspace();
        let id = artifact_id(ArtifactKind::Visual, &["src/handler.go".into()]);
        assert_eq!(next_version(&ws, &id).unwrap(), 1);
        for v in [1, 2] {
            fs::create_dir_all(version_dir(&ws, &id, v).unwrap().join("src"))
                .unwrap();
            fs::write(
                version_dir(&ws, &id, v).unwrap().join("index.html"),
                format!("<html>{v}</html>"),
            )
            .unwrap();
            commit_version(&ws, &manifest(&ws, &id, v)).unwrap();
        }
        // A version folder whose job never finished is not a version.
        fs::create_dir_all(version_dir(&ws, &id, 3).unwrap()).unwrap();
        assert_eq!(next_version(&ws, &id).unwrap(), 4);

        let listed = list(&ws);
        assert_eq!(listed.len(), 1);
        assert_eq!(
            (
                listed[0].current_version,
                listed[0].versions.len(),
                listed[0].title.as_str(),
                listed[0].stale
            ),
            (2, 2, "Handler v2", false)
        );

        set_current(&ws, &id, 1).unwrap();
        assert_eq!(list(&ws)[0].current_version, 1);
        assert_eq!(read_page(&ws, &id, 1).unwrap(), "<html>1</html>");
        assert_eq!(set_current(&ws, &id, 9).unwrap_err().code, "not_found");

        let index: Value = serde_json::from_str(
            &fs::read_to_string(dir.path().join(".codjiva/index.json"))
                .unwrap(),
        )
        .unwrap();
        assert_eq!(index["bySource"]["src/handler.go"][0], id);

        let out = dir.path().join("exported.html");
        export(&ws, &id, None, &out).unwrap();
        assert_eq!(fs::read_to_string(out).unwrap(), "<html>1</html>");

        delete(&ws, &id).unwrap();
        assert!(list(&ws).is_empty());
    }

    #[test]
    fn an_artifact_is_stale_when_a_source_changes_or_disappears() {
        let (dir, ws) = workspace();
        let id = artifact_id(ArtifactKind::Visual, &["src/handler.go".into()]);
        fs::create_dir_all(version_dir(&ws, &id, 1).unwrap()).unwrap();
        commit_version(&ws, &manifest(&ws, &id, 1)).unwrap();
        assert!(!list(&ws)[0].stale);
        fs::write(dir.path().join("src/handler.go"), "package a\n// changed\n")
            .unwrap();
        let after = &list(&ws)[0];
        assert!(after.stale);
        assert_eq!(after.stale_sources, vec!["src/handler.go"]);
        fs::write(dir.path().join("src/handler.go"), "package a\n").unwrap();
        assert!(
            !list(&ws)[0].stale,
            "restoring the file's content clears the stale mark"
        );
        fs::remove_file(dir.path().join("src/handler.go")).unwrap();
        assert!(list(&ws)[0].stale);
    }
}
