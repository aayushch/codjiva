//! A scope: the part of one file that a discussion or a visual is about.
//!
//! The user selects lines in the source view and starts a discussion about
//! them, or makes a visual of them. The selection is kept as a [`Scope`]. The
//! file can change afterwards, so a scope does not only hold line numbers. It
//! is anchored in one of two ways:
//!
//!   - To a definition, when the selection is a whole function, type or other
//!     definition. [`Scope::symbol`] then holds the definition's name, and the
//!     scope follows the definition wherever it moves in the file.
//!   - To its lines, for any other selection. The scope is found again by the
//!     text of those lines.
//!
//! [`locate`] says where a scope is in the file as it is now, and whether its
//! code has changed since the scope was made (see [`ScopeState`]).

use crate::error::{AppError, Result};
use crate::nav::{self, Extent, Kind};
use crate::workspace::{hash_bytes, Workspace};
use serde::{Deserialize, Serialize};

/// The longest scope id, in characters.
const MAX_ID_CHARS: usize = 40;

/// A part of one file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scope {
    /// A short name for the scope that is unique within its file and never
    /// changes: lower-case letters, digits and underscores. A discussion and
    /// a visual of the same selection have the same id.
    pub id: String,
    /// The file, relative to the workspace root.
    pub path: String,
    /// The name of the definition the scope is anchored to, with the name of
    /// what it belongs to in front where it has one, such as `Queue.Push`.
    /// `None` for a scope that is anchored to its lines.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub symbol: Option<String>,
    /// The first and the last line when the scope was made, counted from 1.
    pub start_line: u32,
    pub end_line: u32,
    /// The hash of the text of those lines when the scope was made.
    pub text_hash: String,
}

/// How the code of a scope compares with the code it was made for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScopeState {
    /// The same text on the same lines.
    Same,
    /// The same text on other lines.
    Moved,
    /// The definition is still there and its text is different. Only a scope
    /// that is anchored to a definition can be in this state.
    Changed,
    /// The definition, or the text of the lines, is no longer in the file.
    Lost,
}

impl ScopeState {
    /// True when the code is not what the scope was made for, so that a
    /// visual of the scope no longer shows the code as it is.
    pub fn is_stale(self) -> bool {
        matches!(self, ScopeState::Changed | ScopeState::Lost)
    }
}

/// Where a scope is in its file now. For a scope that is [`ScopeState::Lost`]
/// the lines are the ones it was made on, brought inside the file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Located {
    pub start_line: u32,
    pub end_line: u32,
    pub state: ScopeState,
}

/// The name a scope uses for a definition: `Owner.name`, or `name` alone for
/// a definition that belongs to nothing.
fn label_of(extent: &Extent) -> String {
    match &extent.container {
        Some(owner) => format!("{owner}.{}", extent.name),
        None => extent.name.clone(),
    }
}

/// The hash of lines `start` to `end` of `lines`, counted from 1, or `None`
/// when the file does not have those lines. Line breaks are hashed as `\n`,
/// so a file that is saved with other line endings keeps its hashes.
fn hash_of(lines: &[&str], start: u32, end: u32) -> Option<String> {
    let (first, last) = (start as usize, end as usize);
    if first == 0 || last < first || last > lines.len() {
        return None;
    }
    Some(hash_bytes(lines[first - 1..last].join("\n").as_bytes()))
}

/// The text of lines `start` to `end` of `text`, counted from 1, joined with
/// `\n`. Lines the text does not have are left out.
pub fn lines_of(text: &str, start: u32, end: u32) -> String {
    text.lines()
        .skip(start.saturating_sub(1) as usize)
        .take((end + 1).saturating_sub(start.max(1)) as usize)
        .collect::<Vec<_>>()
        .join("\n")
}

/// Where `scope` is in its file, given the file's content `text`.
///
/// A scope anchored to a definition is looked for by the definition's name.
/// When several definitions have that name, the one that starts nearest to
/// the scope's first line is taken. A scope anchored to its lines is looked
/// for on those lines first, and then on every other run of lines of the same
/// length, of which the nearest is taken.
pub fn locate(scope: &Scope, text: &str) -> Located {
    let lines: Vec<&str> = text.lines().collect();
    let count = lines.len().max(1) as u32;
    let lost = Located {
        start_line: scope.start_line.clamp(1, count),
        end_line: scope.end_line.clamp(1, count),
        state: ScopeState::Lost,
    };
    let distance = |line: u32| line.abs_diff(scope.start_line);

    if let Some(symbol) = &scope.symbol {
        let found = nav::extents_of(&scope.path, text.to_string())
            .into_iter()
            .filter(|extent| &label_of(extent) == symbol)
            .min_by_key(|extent| distance(extent.first_line));
        let Some(extent) = found else {
            return lost;
        };
        let same_text = hash_of(&lines, extent.first_line, extent.last_line)
            .as_ref()
            == Some(&scope.text_hash);
        let same_lines = extent.first_line == scope.start_line
            && extent.last_line == scope.end_line;
        return Located {
            start_line: extent.first_line,
            end_line: extent.last_line,
            state: match (same_text, same_lines) {
                (true, true) => ScopeState::Same,
                (true, false) => ScopeState::Moved,
                (false, _) => ScopeState::Changed,
            },
        };
    }

    if hash_of(&lines, scope.start_line, scope.end_line).as_ref()
        == Some(&scope.text_hash)
    {
        return Located {
            start_line: scope.start_line,
            end_line: scope.end_line,
            state: ScopeState::Same,
        };
    }
    let length = scope.end_line.saturating_sub(scope.start_line);
    let last_start = count.saturating_sub(length);
    (1..=last_start)
        .filter(|start| {
            hash_of(&lines, *start, start + length).as_ref()
                == Some(&scope.text_hash)
        })
        .min_by_key(|start| distance(*start))
        .map_or(lost, |start| Located {
            start_line: start,
            end_line: start + length,
            state: ScopeState::Moved,
        })
}

/// Where `scope` is in its file as the file is on disk. A file that is gone
/// or is not text gives [`ScopeState::Lost`].
pub fn locate_in(ws: &Workspace, scope: &Scope) -> Located {
    match ws.read_text(&scope.path) {
        Ok(content) => locate(scope, &content.text),
        Err(_) => Located {
            start_line: scope.start_line,
            end_line: scope.end_line,
            state: ScopeState::Lost,
        },
    }
}

/// The same scope as `scope`, with its lines and the hash of their text
/// brought up to date with the file's content `text`. A job that reads the
/// code records this, so that the scope counts as unchanged until the code
/// changes again. Returns `None` when the scope is no longer in the file.
pub fn refreshed(scope: &Scope, text: &str) -> Option<Scope> {
    let now = locate(scope, text);
    if now.state == ScopeState::Lost {
        return None;
    }
    let lines: Vec<&str> = text.lines().collect();
    Some(Scope {
        start_line: now.start_line,
        end_line: now.end_line,
        text_hash: hash_of(&lines, now.start_line, now.end_line)?,
        ..scope.clone()
    })
}

/// Turns a name into a scope id: lower-case letters and digits, with one
/// underscore in place of everything else, at most [`MAX_ID_CHARS`] long.
fn id_from(name: &str) -> String {
    let mut out = String::new();
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('_') {
            out.push('_');
        }
    }
    let trimmed = out.trim_matches('_');
    let id: String = trimmed.chars().take(MAX_ID_CHARS).collect();
    if id.is_empty() {
        "scope".to_string()
    } else {
        id
    }
}

/// `wanted` if no scope in `known` has that id, and otherwise `wanted` with
/// the first of `_2`, `_3` and so on that makes it unused.
fn unused_id(wanted: String, known: &[Scope]) -> String {
    let taken = |id: &str| known.iter().any(|one| one.id == id);
    if !taken(&wanted) {
        return wanted;
    }
    (2..)
        .map(|n| format!("{wanted}_{n}"))
        .find(|id| !taken(id))
        .expect("some number is unused")
}

/// The scopes a selection of lines can stand for.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidates {
    /// The selected lines themselves, without blank lines at either end.
    pub lines: Scope,
    /// The smallest definition that holds all of the selected lines, when
    /// there is one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub symbol: Option<Scope>,
    /// True when the selected lines are exactly the lines of `symbol`, so
    /// that the user most likely means the definition.
    pub exact: bool,
}

/// True for a kind of definition that has a body of its own to draw or to
/// discuss. A field, a variable or one value of an enum is part of something
/// larger.
fn has_body(kind: Kind) -> bool {
    !matches!(kind, Kind::Field | Kind::Variable | Kind::Enumerator)
}

/// Works out the scopes that lines `start_line` to `end_line` of the file at
/// `path` can stand for.
///
/// `known` holds the scopes that discussions and visuals of this file already
/// have. A scope of `known` that is on the same lines now is returned in
/// place of a new one, so that a second selection of the same code leads to
/// the discussion and the visuals of the first.
pub fn for_selection(
    ws: &Workspace,
    path: &str,
    start_line: u32,
    end_line: u32,
    known: &[Scope],
) -> Result<Candidates> {
    let text = ws.read_text(path)?.text;
    let lines: Vec<&str> = text.lines().collect();
    let empty = || {
        AppError::new("bad_request", "Select at least one line of code first.")
    };
    if lines.is_empty() {
        return Err(empty());
    }
    let blank = |line: u32| lines[line as usize - 1].trim().is_empty();
    let mut first = start_line.clamp(1, lines.len() as u32);
    let mut last = end_line.clamp(first, lines.len() as u32);
    while first < last && blank(first) {
        first += 1;
    }
    while last > first && blank(last) {
        last -= 1;
    }
    if blank(first) {
        return Err(empty());
    }

    let here: Vec<(&Scope, Located)> = known
        .iter()
        .filter(|one| one.path == path)
        .map(|one| (one, locate(one, &text)))
        .filter(|(_, now)| now.state != ScopeState::Lost)
        .collect();
    let on = |from: u32, to: u32, with_symbol: bool| {
        here.iter()
            .find(|(one, now)| {
                now.start_line == from
                    && now.end_line == to
                    && one.symbol.is_some() == with_symbol
            })
            .map(|(one, _)| (*one).clone())
    };

    let by_lines = on(first, last, false).unwrap_or_else(|| Scope {
        id: unused_id(format!("l{first}_{last}"), known),
        path: path.to_string(),
        symbol: None,
        start_line: first,
        end_line: last,
        text_hash: hash_of(&lines, first, last)
            .expect("the lines are inside the file"),
    });

    let extent = nav::extents_of(path, text.clone())
        .into_iter()
        .filter(|one| one.first_line <= first && one.last_line >= last)
        .filter(|one| {
            has_body(one.kind)
                || (one.first_line == first && one.last_line == last)
        })
        .min_by_key(|one| one.last_line - one.first_line);
    let exact = extent
        .as_ref()
        .is_some_and(|one| one.first_line == first && one.last_line == last);
    let symbol = extent.map(|one| {
        on(one.first_line, one.last_line, true).unwrap_or_else(|| Scope {
            id: unused_id(id_from(&label_of(&one)), known),
            path: path.to_string(),
            symbol: Some(label_of(&one)),
            start_line: one.first_line,
            end_line: one.last_line,
            text_hash: hash_of(&lines, one.first_line, one.last_line)
                .expect("the definition is inside the file"),
        })
    });
    Ok(Candidates {
        lines: by_lines,
        symbol,
        exact,
    })
}

/// What a scope is called where the user reads it: the definition's name, or
/// `lines 4–9`, or `line 4` for a single line.
pub fn title(scope: &Scope, now: Option<&Located>) -> String {
    if let Some(symbol) = &scope.symbol {
        return symbol.clone();
    }
    let (start, end) = now.map_or((scope.start_line, scope.end_line), |now| {
        (now.start_line, now.end_line)
    });
    if start == end {
        format!("line {start}")
    } else {
        format!("lines {start}–{end}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    const QUEUE: &str = "package queue\n\ntype Queue struct {\n\titems \
                         []string\n}\n\nfunc (q *Queue) Push(item string) \
                         {\n\tif item == \"\" {\n\t\treturn\n\t}\n\tq.items \
                         = append(q.items, item)\n}\n";

    fn workspace(text: &str) -> (tempfile::TempDir, Workspace) {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("queue.go"), text).unwrap();
        let ws = Workspace::open(dir.path()).unwrap();
        (dir, ws)
    }

    #[test]
    fn a_selection_of_a_whole_definition_is_anchored_to_its_name() {
        let (_dir, ws) = workspace(QUEUE);
        let found = for_selection(&ws, "queue.go", 7, 12, &[]).unwrap();
        assert!(found.exact);
        let symbol = found.symbol.unwrap();
        assert_eq!(symbol.symbol.as_deref(), Some("Queue.Push"));
        assert_eq!(symbol.id, "queue_push");
        assert_eq!((symbol.start_line, symbol.end_line), (7, 12));
        assert_eq!(found.lines.id, "l7_12");
        assert_eq!(found.lines.symbol, None);
    }

    #[test]
    fn a_selection_inside_a_definition_offers_the_lines_and_the_definition() {
        let (_dir, ws) = workspace(QUEUE);
        // The selection ends on a blank line, which is not part of it.
        let found = for_selection(&ws, "queue.go", 8, 10, &[]).unwrap();
        assert!(!found.exact);
        assert_eq!((found.lines.start_line, found.lines.end_line), (8, 10));
        assert_eq!(found.symbol.unwrap().symbol.as_deref(), Some("Queue.Push"));
        let trimmed = for_selection(&ws, "queue.go", 5, 6, &[]).unwrap();
        assert_eq!((trimmed.lines.start_line, trimmed.lines.end_line), (5, 5));
        assert!(for_selection(&ws, "queue.go", 6, 6, &[]).is_err());
    }

    #[test]
    fn a_scope_on_lines_is_found_again_by_its_text() {
        let (dir, ws) = workspace(QUEUE);
        let scope = for_selection(&ws, "queue.go", 8, 10, &[]).unwrap().lines;
        assert_eq!(locate_in(&ws, &scope).state, ScopeState::Same);

        // Two lines are added above, so the same text is two lines lower.
        let moved =
            QUEUE.replacen("package queue\n", "package queue\n\n//\n", 1);
        fs::write(dir.path().join("queue.go"), &moved).unwrap();
        let now = locate_in(&ws, &scope);
        assert_eq!(
            (now.start_line, now.end_line, now.state),
            (10, 12, ScopeState::Moved)
        );
        // A second selection of the same code gives the same scope.
        let again = for_selection(
            &ws,
            "queue.go",
            10,
            12,
            std::slice::from_ref(&scope),
        )
        .unwrap();
        assert_eq!(again.lines, scope);

        // The text is edited, so the scope is lost.
        fs::write(dir.path().join("queue.go"), moved.replace("\"\"", "\"-\""))
            .unwrap();
        let now = locate_in(&ws, &scope);
        assert_eq!(now.state, ScopeState::Lost);
        assert!(now.state.is_stale());
    }

    #[test]
    fn a_scope_on_a_definition_follows_it_and_says_when_its_text_changed() {
        let (dir, ws) = workspace(QUEUE);
        let scope = for_selection(&ws, "queue.go", 7, 12, &[])
            .unwrap()
            .symbol
            .unwrap();
        let moved =
            QUEUE.replacen("package queue\n", "package queue\n\n//\n", 1);
        fs::write(dir.path().join("queue.go"), &moved).unwrap();
        let now = locate_in(&ws, &scope);
        assert_eq!(
            (now.start_line, now.end_line, now.state),
            (9, 14, ScopeState::Moved)
        );
        assert!(!now.state.is_stale());

        let edited = moved.replace("\"\"", "\"-\"");
        fs::write(dir.path().join("queue.go"), &edited).unwrap();
        let now = locate_in(&ws, &scope);
        assert_eq!(now.state, ScopeState::Changed);
        assert_eq!((now.start_line, now.end_line), (9, 14));
        // Bringing the scope up to date makes the edited text its own.
        let fresh = refreshed(&scope, &edited).unwrap();
        assert_eq!(locate(&fresh, &edited).state, ScopeState::Same);
        assert_eq!(fresh.id, scope.id);

        fs::write(dir.path().join("queue.go"), "package queue\n").unwrap();
        assert_eq!(locate_in(&ws, &scope).state, ScopeState::Lost);
        assert!(refreshed(&scope, "package queue\n").is_none());
    }

    #[test]
    fn a_new_scope_never_takes_the_id_of_another() {
        let (_dir, ws) = workspace(QUEUE);
        let mut old = for_selection(&ws, "queue.go", 8, 10, &[]).unwrap().lines;
        // The older scope has the id of lines 3 to 5 and is somewhere else.
        old.id = "l3_5".into();
        let found = for_selection(&ws, "queue.go", 3, 5, &[old]).unwrap();
        assert_eq!(found.lines.id, "l3_5_2");
    }

    #[test]
    fn a_scope_is_named_by_its_definition_or_its_lines() {
        let (_dir, ws) = workspace(QUEUE);
        let found = for_selection(&ws, "queue.go", 8, 10, &[]).unwrap();
        assert_eq!(title(&found.lines, None), "lines 8–10");
        assert_eq!(title(&found.symbol.unwrap(), None), "Queue.Push");
        let moved = Located {
            start_line: 4,
            end_line: 4,
            state: ScopeState::Moved,
        };
        assert_eq!(title(&found.lines, Some(&moved)), "line 4");
        assert_eq!(
            lines_of(QUEUE, 3, 5),
            "type Queue struct {\n\titems []string\n}"
        );
    }
}
