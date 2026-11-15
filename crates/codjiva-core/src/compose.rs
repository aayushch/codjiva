//! Composition: joining artifacts where their code meets, into one pipeline.
//!
//! Every artifact records its ports: the points where work crosses the edge of
//! the code it explains. An `out` port of one artifact and an `in` port of
//! another can be joined when they name the same place in the code. This module
//! proposes such joins for the user to confirm, and prepares what a compose job
//! gives its agent.

use crate::artifacts::{self, Manifest};
use crate::error::{AppError, Result};
use crate::workspace::Workspace;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;

/// One port of an artifact, as its analysis recorded it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Port {
    /// `in:` or `out:` followed by a dotted name.
    pub id: String,
    pub dir: String,
    /// The symbol as written in the source: a function, a topic, a table.
    pub symbol: String,
    /// `path:line` of the place in the code.
    #[serde(rename = "ref", default)]
    pub reference: String,
    #[serde(default)]
    pub carries: String,
    #[serde(default)]
    pub kind: String,
    /// Where the port sits on the artifact's own sheet.
    #[serde(default)]
    pub anchor: Option<[f64; 2]>,
}

/// The ports of one artifact's current version, with what the interface shows
/// about it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactPorts {
    pub artifact_id: String,
    pub version: u32,
    pub title: String,
    pub subject: Vec<String>,
    pub ports: Vec<Port>,
}

/// How sure a proposed join is.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize,
)]
#[serde(rename_all = "lowercase")]
pub enum Strength {
    /// Both ports name the same symbol.
    Exact,
    /// Both symbols end in the same name, such as `Store.WriteBatch` and
    /// `WriteBatch(orders)`.
    Name,
    /// The line of code the `out` port points at mentions the `in` port's name.
    Line,
}

/// A join between an `out` port of one artifact and an `in` port of another.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Join {
    pub from_artifact: String,
    pub from_port: String,
    pub to_artifact: String,
    pub to_port: String,
    /// The symbol the work crosses at, taken from the `in` port.
    #[serde(default)]
    pub symbol: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub carries: String,
    /// Why the two ports are joined, as a sentence for the user.
    #[serde(default)]
    pub reason: String,
    /// Set for a join the app proposed. A join the user added by hand has none.
    #[serde(default)]
    pub strength: Option<Strength>,
}

/// The ports recorded in a manifest. An entry that is not a well-formed port is
/// left out.
pub fn ports_of(manifest: &Manifest) -> Vec<Port> {
    manifest
        .ports
        .iter()
        .filter_map(|value| serde_json::from_value::<Port>(value.clone()).ok())
        .collect()
}

/// The ports of the current version of each artifact in `ids`, in the same
/// order.
pub fn artifact_ports(
    ws: &Workspace,
    ids: &[String],
) -> Result<Vec<ArtifactPorts>> {
    ids.iter()
        .map(|id| {
            let version = artifacts::read_meta(ws, id)?.current_version;
            let manifest = artifacts::read_manifest(ws, id, version)?;
            Ok(ArtifactPorts {
                artifact_id: id.clone(),
                version,
                title: manifest.title.clone(),
                subject: manifest.subject.clone(),
                ports: ports_of(&manifest),
            })
        })
        .collect()
}

/// A symbol reduced to what can be compared: without an argument list, without
/// spaces, and without the parentheses of a call. `Submit(o Order)` and `Submit
/// ()` both give `Submit`. A Go method written with its receiver, `(l *Limiter)
/// Allow(customer string)`, gives `Allow`.
fn bare(symbol: &str) -> String {
    let mut rest = symbol.trim();
    // A leading group in parentheses is a receiver, not an argument list.
    while rest.starts_with('(') {
        match rest.find(')') {
            Some(end) => rest = rest[end + 1..].trim_start(),
            None => break,
        }
    }
    let before_arguments = rest.split('(').next().unwrap_or(rest);
    before_arguments
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect()
}

/// The last name in a symbol: `WriteBatch` for `orders.Store.WriteBatch`,
/// `append` for `FileStore::append`, and the whole text for a symbol with no
/// separator, such as a topic.
fn last_name(symbol: &str) -> String {
    let bare = bare(symbol);
    bare.rsplit(['.', ':', '/', '#', '>'])
        .find(|part| !part.is_empty())
        .unwrap_or(&bare)
        .to_string()
}

/// The text of the line a `path:line` reference points at, or `None` when it
/// cannot be read.
fn referenced_line(ws: &Workspace, reference: &str) -> Option<String> {
    let (path, lines) = reference.rsplit_once(':')?;
    let first: usize = lines.split('-').next()?.parse().ok()?;
    let text = ws.read_text(path).ok()?.text;
    text.lines().nth(first.checked_sub(1)?).map(str::to_string)
}

/// Proposes joins between the artifacts in `parts`: every `out` port against
/// every `in` port of a different artifact. Two artifacts of the same file are
/// never joined to each other, because they show the same code. The strongest
/// proposals come first.
pub fn propose_joins(ws: &Workspace, parts: &[ArtifactPorts]) -> Vec<Join> {
    let mut found: Vec<Join> = Vec::new();
    for from in parts {
        for to in parts {
            if from.artifact_id == to.artifact_id || from.subject == to.subject
            {
                continue;
            }
            for out in from.ports.iter().filter(|p| p.dir == "out") {
                for into in to.ports.iter().filter(|p| p.dir == "in") {
                    let (out_name, in_name) =
                        (last_name(&out.symbol), last_name(&into.symbol));
                    let matched = if bare(&out.symbol)
                        .eq_ignore_ascii_case(&bare(&into.symbol))
                    {
                        Some((
                            Strength::Exact,
                            format!("Both name `{}`.", bare(&into.symbol)),
                        ))
                    } else if out_name.len() >= 3 && out_name == in_name {
                        Some((
                            Strength::Name,
                            format!(
                                "`{}` and `{}` end in the same name.",
                                out.symbol, into.symbol
                            ),
                        ))
                    } else if in_name.len() >= 3
                        && referenced_line(ws, &out.reference)
                            .is_some_and(|line| line.contains(&in_name))
                    {
                        Some((
                            Strength::Line,
                            format!(
                                "The code at {} mentions `{in_name}`.",
                                out.reference
                            ),
                        ))
                    } else {
                        None
                    };
                    if let Some((strength, reason)) = matched {
                        found.push(Join {
                            from_artifact: from.artifact_id.clone(),
                            from_port: out.id.clone(),
                            to_artifact: to.artifact_id.clone(),
                            to_port: into.id.clone(),
                            symbol: into.symbol.clone(),
                            kind: if out.kind.is_empty() {
                                into.kind.clone()
                            } else {
                                out.kind.clone()
                            },
                            carries: if out.carries.is_empty() {
                                into.carries.clone()
                            } else {
                                out.carries.clone()
                            },
                            reason,
                            strength: Some(strength),
                        });
                    }
                }
            }
        }
    }
    found.sort_by(|a, b| {
        a.strength
            .cmp(&b.strength)
            .then_with(|| a.from_artifact.cmp(&b.from_artifact))
            .then_with(|| a.from_port.cmp(&b.from_port))
    });
    found
}

/// One artifact that a pipeline is composed of.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Part {
    /// The short name the pipeline gives this part. It names the folder
    /// `parts/<key>/`.
    pub key: String,
    pub artifact: String,
    pub version: u32,
}

/// Gives every artifact a short key made from the name of its subject file:
/// lower-case letters and digits, starting with a letter. Two files with the
/// same name get a number each.
pub fn part_keys(parts: &[ArtifactPorts]) -> Vec<String> {
    let mut used: BTreeSet<String> = BTreeSet::new();
    parts
        .iter()
        .map(|part| {
            let file = part
                .subject
                .first()
                .map(String::as_str)
                .unwrap_or("part")
                .trim_end_matches('/');
            let stem = file
                .rsplit('/')
                .next()
                .unwrap_or(file)
                .split('.')
                .next()
                .unwrap_or("part");
            let mut key: String = stem
                .chars()
                .filter(char::is_ascii_alphanumeric)
                .map(|c| c.to_ascii_lowercase())
                .collect();
            if !key.starts_with(|c: char| c.is_ascii_lowercase()) {
                key = format!("part{key}");
            }
            let base = key.clone();
            let mut n = 2;
            while !used.insert(key.clone()) {
                key = format!("{base}{n}");
                n += 1;
            }
            key
        })
        .collect()
}

/// The stage every artifact is drawn on, in pixels.
const SHEET: (f64, f64) = (1920.0, 1080.0);
/// The gap left between bays and at the yard's edges, in pixels.
const BAY_GAP: f64 = 50.0;
/// The largest scale a bay is drawn at, so two parts do not fill the yard edge
/// to edge.
const BAY_MAX_SCALE: f64 = 0.46;

/// A first placement for `count` parts: one row, left to right in the order
/// given, every bay the same size, centred below the title band. The agent may
/// move the bays; this spares it the arithmetic and gives the build something
/// valid from the start.
pub fn default_bays(count: usize) -> Vec<([f64; 2], f64)> {
    let n = count.max(1) as f64;
    let scale = (((SHEET.0 - BAY_GAP * (n + 1.0)) / (n * SHEET.0))
        .min(BAY_MAX_SCALE)
        * 100.0)
        .floor()
        / 100.0;
    let width = SHEET.0 * scale;
    let total = n * width + (n - 1.0) * BAY_GAP;
    let left = (SHEET.0 - total) / 2.0;
    // The title band covers the top 110 pixels; the bays are centred in what is
    // left.
    let top = 110.0 + (SHEET.1 - 110.0 - SHEET.1 * scale) / 2.0;
    (0..count)
        .map(|i| {
            (
                [(left + i as f64 * (width + BAY_GAP)).round(), top.round()],
                scale,
            )
        })
        .collect()
}

/// The `pipeline.json` a compose job starts from: the parts with a first
/// placement, and the joins the user confirmed, written with part keys in place
/// of artifact ids.
pub fn pipeline_json(
    title: &str,
    parts: &[Part],
    joins: &[Join],
) -> Result<Value> {
    let key_of = |artifact: &str| {
        parts
            .iter()
            .find(|p| p.artifact == artifact)
            .map(|p| p.key.clone())
            .ok_or_else(|| {
                AppError::new(
                    "bad_request",
                    "A join names an artifact that is not one of the parts.",
                )
            })
    };
    let bays = default_bays(parts.len());
    let parts_json: Vec<Value> = parts
        .iter()
        .zip(&bays)
        .map(|(part, (bay, scale))| {
            serde_json::json!({
                "key": part.key,
                "artifact": part.artifact,
                "version": part.version,
                "bay": bay,
                "scale": scale
            })
        })
        .collect();
    let mut joins_json = Vec::new();
    for join in joins {
        let mut one = serde_json::json!({
            "from": format!(
                "{}#{}",
                key_of(&join.from_artifact)?,
                join.from_port
            ),
            "to": format!(
                "{}#{}",
                key_of(&join.to_artifact)?,
                join.to_port
            )
        });
        for (name, value) in [
            ("kind", &join.kind),
            ("symbol", &join.symbol),
            ("carries", &join.carries),
            ("reason", &join.reason),
        ] {
            if !value.is_empty() {
                one[name] = Value::String(value.clone());
            }
        }
        joins_json.push(one);
    }
    Ok(serde_json::json!({
        "schemaVersion": 1,
        "title": title,
        "parts": parts_json,
        "joins": joins_json
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn port(id: &str, symbol: &str, reference: &str) -> Port {
        Port {
            id: id.into(),
            dir: id.split(':').next().unwrap().into(),
            symbol: symbol.into(),
            reference: reference.into(),
            carries: "an order".into(),
            kind: "call".into(),
            anchor: None,
        }
    }

    fn part(id: &str, subject: &str, ports: Vec<Port>) -> ArtifactPorts {
        ArtifactPorts {
            artifact_id: id.into(),
            version: 1,
            title: id.into(),
            subject: vec![subject.into()],
            ports,
        }
    }

    #[test]
    fn joins_are_proposed_by_symbol_by_name_and_by_the_line_of_code() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("src")).unwrap();
        fs::write(
            dir.path().join("src/handler.go"),
            "package a\n\nfunc flush() {\n\tsink.Persist(batch)\n}\n",
        )
        .unwrap();
        let ws = Workspace::open(dir.path()).unwrap();
        let handler = part(
            "visual-handler",
            "src/handler.go",
            vec![
                port(
                    "in:Handler.Submit",
                    "Submit(o Order)",
                    "src/handler.go:1",
                ),
                port(
                    "out:Store.WriteBatch",
                    "Store.WriteBatch",
                    "src/handler.go:3",
                ),
                port("out:Limiter.Allow", "Limiter.Allow", "src/handler.go:2"),
                port("out:sink", "the sink", "src/handler.go:4"),
            ],
        );
        let store = part(
            "visual-store",
            "src/store.go",
            vec![
                port(
                    "in:Store.WriteBatch",
                    "store.writebatch ()",
                    "src/store.go:9",
                ),
                port("out:disk", "os.WriteFile", "src/store.go:20"),
            ],
        );
        let limiter = part(
            "visual-limiter",
            "src/limiter.go",
            vec![port(
                "in:Allow",
                "(l *Limiter) Allow(customer string)",
                "src/limiter.go:5",
            )],
        );
        let sink = part(
            "visual-sink",
            "src/sink.go",
            vec![port("in:persist", "Sink.Persist", "src/sink.go:3")],
        );
        // A film of the same file as the handler's visual is not joined to it.
        let handler_film = part(
            "film-handler",
            "src/handler.go",
            vec![port(
                "in:Store.WriteBatch",
                "Store.WriteBatch",
                "src/handler.go:3",
            )],
        );

        let joins =
            propose_joins(&ws, &[handler, store, limiter, sink, handler_film]);
        let summary: Vec<(&str, &str, Strength)> = joins
            .iter()
            .map(|j| {
                (
                    j.from_port.as_str(),
                    j.to_artifact.as_str(),
                    j.strength.unwrap(),
                )
            })
            .collect();
        assert_eq!(
            summary,
            vec![
                ("out:Store.WriteBatch", "visual-store", Strength::Exact),
                ("out:Limiter.Allow", "visual-limiter", Strength::Name),
                ("out:sink", "visual-sink", Strength::Line),
            ]
        );
        assert_eq!(joins[0].reason, "Both name `store.writebatch`.");
        assert!(
            joins[2].reason.contains("src/handler.go:4")
                && joins[2].reason.contains("`Persist`")
        );
        assert_eq!(
            (joins[0].carries.as_str(), joins[0].kind.as_str()),
            ("an order", "call")
        );
    }

    #[test]
    fn keys_are_short_unique_and_start_with_a_letter() {
        let parts = [
            part("a", "src/orders/handler.go", vec![]),
            part("b", "lib/Handler.cpp", vec![]),
            part("c", "src/9-lives.ts", vec![]),
            part("d", "internal/orders/", vec![]),
        ];
        assert_eq!(
            part_keys(&parts),
            vec!["handler", "handler2", "part9lives", "orders"]
        );
    }

    #[test]
    fn the_first_placement_fits_the_yard_and_the_pipeline_file_names_parts_by_key(
    ) {
        for count in 2..=6 {
            let bays = default_bays(count);
            let (last, scale) = bays.last().unwrap();
            assert!(
                bays[0].0[0] >= BAY_GAP - 1.0
                    && last[0] + 1920.0 * scale <= 1920.0 - BAY_GAP + 1.0,
                "{count}: {bays:?}"
            );
            assert!(
                bays[0].0[1] >= 110.0
                    && bays[0].0[1] + 1080.0 * scale <= 1080.0,
                "{count}: {bays:?}"
            );
            assert!(bays.windows(2).all(|pair| pair[1].0[0] - pair[0].0[0]
                >= 1920.0 * scale + BAY_GAP - 1.0));
        }
        let parts = vec![
            Part {
                key: "handler".into(),
                artifact: "visual-handler".into(),
                version: 2,
            },
            Part {
                key: "store".into(),
                artifact: "visual-store".into(),
                version: 1,
            },
        ];
        let join = Join {
            from_artifact: "visual-handler".into(),
            from_port: "out:Store.WriteBatch".into(),
            to_artifact: "visual-store".into(),
            to_port: "in:Store.WriteBatch".into(),
            symbol: "Store.WriteBatch".into(),
            kind: "write".into(),
            carries: String::new(),
            reason: "Both name it.".into(),
            strength: Some(Strength::Exact),
        };
        let pipeline =
            pipeline_json("Order to disk", &parts, std::slice::from_ref(&join))
                .unwrap();
        assert_eq!(
            pipeline["joins"][0],
            serde_json::json!({
                "from": "handler#out:Store.WriteBatch",
                "to": "store#in:Store.WriteBatch",
                "kind": "write",
                "symbol": "Store.WriteBatch",
                "reason": "Both name it."
            })
        );
        assert_eq!(pipeline["parts"][1]["key"], "store");
        let (_, problems) = codjiva_build::check_json(
            "pipeline.json",
            &pipeline.to_string(),
            codjiva_build::runtime::PIPELINE_SCHEMA,
        );
        assert!(problems.is_empty(), "{problems:?}");
        let stray = Join {
            to_artifact: "visual-other".into(),
            ..join
        };
        assert_eq!(
            pipeline_json("T", &parts, &[stray]).unwrap_err().code,
            "bad_request"
        );
    }
}
