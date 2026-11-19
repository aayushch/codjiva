//! Where a name is used.
//!
//! For a parameter or a local variable the answer is exact: the uses inside
//! its function. For any other name, no list of uses is kept. The files of
//! the same language family are searched for the word, and each file that
//! holds it is parsed to drop the hits that are not this name: a word in a
//! comment or in quotes, and a local variable that happens to have the same
//! name. What remains is every use of the name, whatever it belongs to,
//! because the types that would tell two things of one name apart are not
//! known here.

use crate::grammar::family_of;
use crate::index::{Index, Parsed};
use crate::lookup::{pointed_at, Named, Pointed};
use crate::syntax::Role;
use crate::text::{read_text, shared_folders, Lines, WordFinder};
use rayon::prelude::*;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};

/// The search stops after this many references.
pub const MAX_REFERENCES: usize = 2000;

/// This many files are searched between two reports of results. Files are
/// searched in the order of their distance from the file the name was
/// clicked in, so the nearest results are reported first.
const FILES_PER_REPORT: usize = 256;

/// One place where the name stands.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reference {
    pub path: String,
    pub line: u32,
    pub column: u32,
    pub end_column: u32,
    pub role: Role,
    /// The line of code, for showing it in a list.
    pub text: String,
}

/// What a search for references reports while it runs.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum RefsEvent {
    /// More references, in the order they should be listed.
    #[serde(rename_all = "camelCase")]
    Found { references: Vec<Reference> },
    /// The search has ended. `total` is the number of references reported
    /// and `files` the number of files they are in. `exact` is true when
    /// the name is local to a function, so the list is all of its uses and
    /// nothing else. `truncated` is true when the search stopped at
    /// [`MAX_REFERENCES`] and there may be more.
    #[serde(rename_all = "camelCase")]
    Done {
        total: usize,
        files: usize,
        exact: bool,
        truncated: bool,
    },
}

/// The references to `name` in one file that has been read: every whole
/// word that is the name, except where the parser says it is not a name, and
/// except where it refers to a local variable of the file.
fn in_file(path: &str, parsed: &Parsed, name: &str) -> Vec<Reference> {
    let text = parsed.text();
    let finder = WordFinder::new(name);
    let starts: Vec<usize> = finder.find(text.as_bytes()).collect();
    if starts.is_empty() {
        return Vec::new();
    }
    let lines = Lines::new(text);
    let analysed = parsed.analysed();
    starts
        .into_iter()
        .filter_map(|start| {
            let range = start..start + name.len();
            let role = match analysed {
                Some((syntax, analysis)) if syntax.covers(start) => {
                    let node = syntax.name_covering(range.clone())?;
                    if syntax.local_of(analysis, node).is_some() {
                        return None;
                    }
                    syntax.role_of(analysis, node)
                }
                _ => Role::Text,
            };
            let (line, column, end_column) = lines.place_of(range);
            Some(Reference {
                path: path.to_string(),
                line,
                column,
                end_column,
                role,
                text: lines.preview(line as usize - 1),
            })
        })
        .collect()
}

/// Finds the references to the name at `line` and `column` of the file at
/// `path`, and hands them to `report` as they are found, nearest first. The
/// last report is always [`RefsEvent::Done`].
///
/// The search can take seconds in a large workspace. Setting `cancel` to
/// true from another thread ends it early; `Done` is still reported.
pub fn references(
    index: &Index,
    path: &str,
    line: u32,
    column: u32,
    cancel: &AtomicBool,
    report: &mut dyn FnMut(RefsEvent),
) {
    let done = |total, files, exact, truncated| RefsEvent::Done {
        total,
        files,
        exact,
        truncated,
    };
    let (Some(family), Some(parsed)) = (family_of(path), index.parsed(path))
    else {
        return report(done(0, 0, false, false));
    };
    let text = parsed.text();
    let name = match pointed_at(&parsed, line, column) {
        Pointed::Nothing => return report(done(0, 0, false, false)),
        Pointed::Word(range) => text[range].to_string(),
        Pointed::Name(Named {
            syntax,
            analysis,
            node,
        }) => {
            let name = syntax.text_of(node).to_string();
            if let Some(local) = syntax.local_of(analysis, node) {
                // A local name is used only inside its own function.
                let lines = Lines::new(text);
                let found: Vec<Reference> = WordFinder::new(&name)
                    .find(text.as_bytes())
                    .filter_map(|start| {
                        syntax.name_covering(start..start + name.len())
                    })
                    .filter(|other| {
                        syntax.local_of(analysis, *other).is_some_and(
                            |theirs| theirs.name_range == local.name_range,
                        )
                    })
                    .map(|other| {
                        let (line, column, end_column) =
                            lines.place_of(other.byte_range());
                        Reference {
                            path: path.to_string(),
                            line,
                            column,
                            end_column,
                            role: syntax.role_of(analysis, other),
                            text: lines.preview(line as usize - 1),
                        }
                    })
                    .collect();
                let total = found.len();
                report(RefsEvent::Found { references: found });
                return report(done(total, 1, true, false));
            }
            name
        }
    };

    let files = index.files();
    let mut candidates: Vec<&String> = files
        .iter()
        .filter(|file| family_of(file) == Some(family))
        .collect();
    // The file itself first, then files that share more folders with it.
    candidates.sort_by(|a, b| {
        (a.as_str() != path)
            .cmp(&(b.as_str() != path))
            .then(shared_folders(b, path).cmp(&shared_folders(a, path)))
            .then(a.cmp(b))
    });
    let finder = WordFinder::new(&name);
    let mut total = 0;
    let mut files_with = 0;
    for batch in candidates.chunks(FILES_PER_REPORT) {
        if cancel.load(Ordering::SeqCst) {
            break;
        }
        let found: Vec<Vec<Reference>> = index.pool().install(|| {
            batch
                .par_iter()
                .map(|file| {
                    // The file on screen is parsed already. Every other
                    // file is parsed only if it holds the word at all.
                    if file.as_str() == path {
                        return in_file(file, &parsed, &name);
                    }
                    read_text(&index.root().join(file))
                        .filter(|text| finder.is_in(text.as_bytes()))
                        .map(|text| {
                            in_file(file, &Parsed::new(file, text), &name)
                        })
                        .unwrap_or_default()
                })
                .collect()
        });
        let mut references = Vec::new();
        for of_file in found {
            if of_file.is_empty() {
                continue;
            }
            files_with += 1;
            references.extend(of_file);
        }
        let room = MAX_REFERENCES - total;
        let truncated = references.len() > room;
        references.truncate(room);
        total += references.len();
        if !references.is_empty() {
            report(RefsEvent::Found { references });
        }
        if truncated || total >= MAX_REFERENCES {
            return report(done(total, files_with, false, true));
        }
    }
    report(done(total, files_with, false, false))
}
