//! What the name at a place is, and where it is defined.

use crate::grammar::family_of;
use crate::imports;
use crate::index::{Found, Index, Parsed};
use crate::syntax::{Analysis, Kind, Role, Syntax, CALL, MEMBER, TYPE};
use crate::text::{
    dir_of, shared_folders, simple_name, stem_of, type_words, word_at, Lines,
    WordFinder,
};
use serde::Serialize;
use std::cell::OnceCell;
use std::collections::{HashMap, HashSet};
use tree_sitter::Node;

/// At most this many definitions are returned for one name.
const MAX_DEFINITIONS: usize = 100;

/// Before an answer is given, at most this many of the files it names are
/// checked for changes. The files of the best candidates are checked first.
const MAX_CHECKED_FILES: usize = 200;

/// The most imported files whose own imports are looked at.
const MAX_FOLLOWED: usize = 16;

/// When the code does not say which class a field belongs to, the field's
/// type is taken from every field of that name, but only if they have at
/// most this many different types between them.
const MAX_GUESSED_TYPES: usize = 3;

/// At most this many definitions are listed for the type of a name.
const MAX_TYPE_TARGETS: usize = 4;

/// How an answer was found. See the crate's documentation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Basis {
    Scope,
    Name,
    Text,
}

/// How close a definition is to the place the name was clicked. A closer
/// group is listed first, in this order.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize,
)]
#[serde(rename_all = "lowercase")]
pub enum Group {
    /// The name is a parameter or a local variable, and this is the place
    /// in the same function that defines it.
    Scope,
    /// The code says what the name belongs to, and this definition belongs
    /// to that owner. `sink.write()` and `Meter::add` name the owner. A
    /// name inside a method of a C++ or Java class can belong to that class
    /// without anything in front of it.
    Owner,
    /// This definition belongs to something the owner derives from, such as
    /// a base class.
    Inherited,
    /// Defined in the file the name was clicked in.
    File,
    /// Defined in a file that the file imports.
    Imported,
    /// Defined in another file of the same folder.
    Folder,
    /// Defined anywhere else in the workspace.
    Elsewhere,
}

/// A range of characters on one line.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Span {
    pub line: u32,
    pub column: u32,
    pub end_column: u32,
}

/// One place that defines a name.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub path: String,
    pub line: u32,
    pub column: u32,
    pub end_column: u32,
    pub kind: Kind,
    pub container: Option<String>,
    /// True for a definition without its body, such as a prototype in a C
    /// header.
    pub declaration: bool,
    pub group: Group,
    /// The line of code, for showing it in a list.
    pub text: String,
}

/// What is known about the name at one place.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Lookup {
    pub name: String,
    /// Where the name stands in the file it was clicked in.
    pub line: u32,
    pub column: u32,
    pub end_column: u32,
    pub basis: Basis,
    pub role: Role,
    /// Every place in the same file where the name means the same thing,
    /// the clicked place included.
    pub occurrences: Vec<Span>,
    /// The places that define the name, best first.
    pub definitions: Vec<Target>,
    /// How many entries at the start of `definitions` are the ones the code
    /// around the name points to. The entries after them only have the same
    /// name. Equal to the length of `definitions` when nothing tells them
    /// apart.
    pub likely: usize,
    /// The type the code gives the name, as written, when the workspace
    /// defines that type. For example `plant::Reading` for a variable
    /// declared as `const plant::Reading last = ...`.
    pub type_name: Option<String>,
    /// The places that define that type. Empty when `type_name` is `None`.
    pub types: Vec<Target>,
    /// True when the first entry of `definitions` is the one definition the
    /// name can mean, so the interface can go there without asking. False
    /// when several definitions are equally likely, and when there is none.
    pub certain: bool,
    /// True while the workspace is still being indexed. The answer is then
    /// complete but took a search to find.
    pub indexing: bool,
}

/// The name the user pointed at and what the file says about it.
struct Subject<'a> {
    path: &'a str,
    family: &'static str,
    name: String,
    role: Role,
    /// How the name is used at this place, as the flags of `syntax.rs`.
    flags: u8,
    /// What the name may belong to, see [`owners_of`].
    owners: Vec<Owner>,
}

/// Something the name may belong to: a class, a namespace, a module or
/// similar.
struct Owner {
    name: String,
    /// 0 when the code around the name points to this owner itself. Otherwise
    /// the number of steps from such an owner to this one, which it derives
    /// from: 1 for its base class, 2 for the base class of that one.
    steps: u8,
    /// True when the code writes this name in front of the clicked name, as
    /// `orders` in `orders.NewHandler`. Such a name can be a package or a
    /// module, so a definition also belongs to it when its file or its folder
    /// has that name.
    written: bool,
}

/// The types of the field or variable called `name`, as the names in the
/// text of each type (see `type_words`). Used for `name` in `name.member`
/// when `name` is not a local variable.
///
/// `around` is the class the code is in, with what it derives from. If one
/// of those defines `name` with a type, the nearest such definition is used.
/// Otherwise every definition of `name` in the workspace is looked at, and
/// their types are used only if there are at most [`MAX_GUESSED_TYPES`]
/// different ones.
fn types_of_member(
    index: &Index,
    family: &str,
    name: &str,
    around: &[Owner],
) -> Vec<String> {
    if !index.is_ready() {
        return Vec::new();
    }
    let typed: Vec<Found> = index
        .definitions_named(name, family)
        .into_iter()
        .filter(|one| one.def.of_type.is_some())
        .collect();
    let steps_to = |one: &Found| {
        around
            .iter()
            .filter(|owner| one.def.container.as_deref() == Some(&owner.name))
            .map(|owner| owner.steps)
            .min()
    };
    let nearest = typed.iter().filter_map(steps_to).min();
    let mut texts: Vec<&str> = typed
        .iter()
        .filter(|one| nearest.is_none() || steps_to(one) == nearest)
        .filter_map(|one| one.def.of_type.as_deref())
        .collect();
    texts.sort_unstable();
    texts.dedup();
    if nearest.is_none() && texts.len() > MAX_GUESSED_TYPES {
        return Vec::new();
    }
    let mut words: Vec<String> = Vec::new();
    for word in texts.into_iter().flat_map(type_words) {
        if !words.iter().any(|known| known == word) {
            words.push(word.to_string());
        }
    }
    words
}

/// `direct` as owners, followed by everything they derive from.
fn with_supers(
    index: &Index,
    family: &str,
    direct: Vec<(String, bool)>,
) -> Vec<Owner> {
    let mut owners: Vec<Owner> = Vec::new();
    for (name, written) in direct {
        match owners.iter_mut().find(|owner| owner.name == name) {
            Some(known) => known.written |= written,
            None => owners.push(Owner {
                name,
                steps: 0,
                written,
            }),
        }
    }
    let names: Vec<&str> = owners.iter().map(|o| o.name.as_str()).collect();
    let supers = index.supers_of(&names, family);
    owners.extend(supers.into_iter().map(|(name, steps)| Owner {
        name,
        steps,
        written: false,
    }));
    owners
}

/// What the name `node` may belong to, judged from the code around it. A
/// definition that belongs to one of these owners is the most likely one.
/// Empty when the code says nothing about an owner.
///
///   - For a name at the place that defines it, the owner is the container
///     of that definition, so that the prototype and the body of one
///     function are found together.
///   - For `this.total`, `self.total` and `Self::new`, the owner is the
///     class or similar that the place is inside.
///   - For a name with nothing in front of it, in a language where a method
///     can name the members of its class that way (`Grammar::bare_members`),
///     the owner is also the class that the place is inside.
///   - For `meter.add()` where `meter` is a parameter or a local variable
///     with a type written next to it, the owners are the names in that
///     type.
///   - For `meter.add()` where `meter` is a field or a variable of the file,
///     the owners are the names in the type the index records for `meter`,
///     see [`types_of_member`].
///   - For anything in front of the name, as `orders` in
///     `orders.NewHandler` or `Unit` in `Unit::Litre`, that word itself is
///     an owner too: a package, a module, a namespace or a type.
///
/// Everything these owners derive from is added after them, see
/// [`with_supers`].
fn owners_of(
    index: &Index,
    family: &str,
    syntax: &Syntax,
    analysis: &Analysis,
    node: Node,
) -> Vec<Owner> {
    let start = node.start_byte();
    let around = || analysis.owner_around(start).map(str::to_string);
    let mut direct: Vec<(String, bool)> = Vec::new();
    if let Some(container) =
        analysis.def_at(start).and_then(|def| def.container.clone())
    {
        direct.push((container, false));
    }
    let Some(range) = analysis.uses.qualifier(start) else {
        if syntax.grammar.bare_members {
            direct.extend(around().map(|name| (name, false)));
        }
        return with_supers(index, family, direct);
    };
    let written = syntax.text[range.clone()].trim();
    if matches!(written, "this" | "self" | "Self" | "cls") {
        direct.extend(around().map(|name| (name, false)));
        return with_supers(index, family, direct);
    }
    let last = simple_name(written);
    let local = syntax
        .name_covering(range)
        .and_then(|name| syntax.local_of(analysis, name));
    let types: Vec<String> = match local {
        Some(local) => local
            .type_range
            .clone()
            .map(|range| type_words(&syntax.text[range]))
            .unwrap_or_default()
            .into_iter()
            .map(str::to_string)
            .collect(),
        None if last.is_empty() => Vec::new(),
        None => {
            let class = around().map(|name| (name, false));
            let around =
                with_supers(index, family, class.into_iter().collect());
            types_of_member(index, family, last, &around)
        }
    };
    direct.extend(types.into_iter().map(|name| (name, false)));
    if !last.is_empty() {
        direct.push((last.to_string(), true));
    }
    with_supers(index, family, direct)
}

/// The files the file at `path` imports, and for C and C++ the base names
/// of the headers among them. A header's functions are usually defined in a
/// source file of the same base name, which the file does not include, so a
/// definition in such a source file counts as imported too.
struct Imported {
    files: HashSet<String>,
    header_stems: HashSet<String>,
}

fn imported_by(index: &Index, path: &str, text: &str) -> Imported {
    let names = index.file_names();
    let mut imported = Imported {
        files: HashSet::new(),
        header_stems: HashSet::new(),
    };
    let c_family = family_of(path) == Some("c");
    let mut add = |from: &str, text: &str, into: &mut Vec<String>| {
        for specifier in imports::imported_specifiers(text) {
            for file in names.resolve(&specifier, from) {
                if file == path || imported.files.contains(file) {
                    continue;
                }
                if c_family {
                    imported.header_stems.insert(stem_of(file).to_string());
                }
                imported.files.insert(file.clone());
                into.push(file.clone());
            }
        }
    };
    let mut direct = Vec::new();
    add(path, text, &mut direct);
    // One step further: what the imported files import themselves. A C++
    // source file often includes only its own header, and that header
    // includes the rest.
    for file in direct.iter().take(MAX_FOLLOWED) {
        if let Some(text) = crate::text::read_text(&index.root().join(file)) {
            add(file, &text, &mut Vec::new());
        }
    }
    // The header of a source file itself: `LogWriter.cpp` belongs with
    // `LogWriter.h` even where it includes it under another path.
    if c_family {
        imported.header_stems.insert(stem_of(path).to_string());
    }
    imported
}

/// The name of a file up to its first dot: `app` for
/// `src/lib/state/app.svelte.ts`. A module is usually named after its file
/// this way.
fn first_part_of_name(path: &str) -> &str {
    let name = path.rsplit('/').next().unwrap_or(path);
    name.split('.').next().unwrap_or(name)
}

/// How well a definition of this kind suits the way the name is used. A
/// higher number suits better.
fn suits(flags: u8, def_kind: Kind) -> u8 {
    let of_owner =
        matches!(def_kind, Kind::Method | Kind::Field | Kind::Enumerator);
    let kind_fits = if flags & CALL != 0 {
        def_kind.is_callable()
    } else if flags & TYPE != 0 {
        def_kind.is_type()
    } else {
        true
    };
    2 * u8::from(kind_fits) + u8::from((flags & MEMBER != 0) == of_owner)
}

/// A candidate with what it is ranked by.
struct Ranked {
    found: Found,
    group: Group,
    /// For the group `Inherited`, the number of steps from the owner to the
    /// base class this definition belongs to. 0 in every other group.
    steps: u8,
    suits: u8,
}

impl Ranked {
    /// True when nothing that the ranking looks at first tells the two
    /// apart.
    fn ties_with(&self, other: &Ranked) -> bool {
        (self.group, self.steps, self.suits)
            == (other.group, other.steps, other.suits)
    }
}

/// The file a name was clicked in, with what is worked out about it at most
/// once while one question is answered.
struct Origin<'a> {
    index: &'a Index,
    path: &'a str,
    text: &'a str,
    /// What the file imports. Filled the first time a candidate in another
    /// file has to be ranked.
    imported: OnceCell<Imported>,
}

impl<'a> Origin<'a> {
    fn new(index: &'a Index, path: &'a str, text: &'a str) -> Origin<'a> {
        Origin {
            index,
            path,
            text,
            imported: OnceCell::new(),
        }
    }

    fn imported(&self) -> &Imported {
        self.imported
            .get_or_init(|| imported_by(self.index, self.path, self.text))
    }
}

fn rank(
    origin: &Origin,
    subject: &Subject,
    candidates: Vec<Found>,
    prefer_declaration: bool,
) -> Vec<Ranked> {
    let needs_imports = candidates.iter().any(|one| &*one.path != subject.path);
    let imported = needs_imports.then(|| origin.imported());
    let folder = dir_of(subject.path);
    let mut ranked: Vec<Ranked> = candidates
        .into_iter()
        .map(|found| {
            let path = &*found.path;
            let owned = subject
                .owners
                .iter()
                .filter(|owner| {
                    found.def.container.as_deref() == Some(&owner.name)
                        || (owner.written
                            && (first_part_of_name(path) == owner.name
                                || dir_of(path).rsplit('/').next()
                                    == Some(&owner.name)))
                })
                .map(|owner| owner.steps)
                .min();
            let group = if owned == Some(0) {
                Group::Owner
            } else if owned.is_some() {
                Group::Inherited
            } else if path == subject.path {
                Group::File
            } else if imported.as_ref().is_some_and(|imported| {
                imported.files.contains(path)
                    || imported.header_stems.contains(stem_of(path))
            }) {
                Group::Imported
            } else if dir_of(path) == folder {
                Group::Folder
            } else {
                Group::Elsewhere
            };
            Ranked {
                suits: suits(subject.flags, found.def.kind),
                group,
                steps: owned.unwrap_or(0),
                found,
            }
        })
        .collect();
    ranked.sort_by(|a, b| {
        a.group
            .cmp(&b.group)
            .then(a.steps.cmp(&b.steps))
            .then(b.suits.cmp(&a.suits))
            .then(
                (a.found.def.declaration != prefer_declaration)
                    .cmp(&(b.found.def.declaration != prefer_declaration)),
            )
            .then(
                shared_folders(&b.found.path, subject.path)
                    .cmp(&shared_folders(&a.found.path, subject.path)),
            )
            .then(a.found.path.cmp(&b.found.path))
            .then(a.found.def.line.cmp(&b.found.def.line))
    });
    ranked
}

/// How many candidates at the start of `ranked` rank as high as the first.
fn likely(ranked: &[Ranked]) -> usize {
    let same = |one: &&Ranked| one.ties_with(&ranked[0]);
    ranked.iter().take_while(same).count()
}

/// True when the candidates that rank as high as the first are one thing:
/// one definition with a body, with or without prototypes that announce it,
/// or one prototype alone. False when there is no candidate.
fn is_certain(ranked: &[Ranked]) -> bool {
    let top = &ranked[..likely(ranked)];
    let bodies: Vec<&Ranked> = top
        .iter()
        .filter(|one| !one.found.def.declaration)
        .collect();
    match bodies.as_slice() {
        [body] => top
            .iter()
            .all(|one| one.found.def.container == body.found.def.container),
        [] => top.len() == 1,
        _ => false,
    }
}

/// Every definition of the subject's name in its language family, from the
/// index when there is one and from a search otherwise. Files that changed
/// since the index read them are read again first.
fn candidates(index: &Index, subject: &Subject) -> Vec<Found> {
    if !index.is_ready() {
        return index.definitions_by_search(
            &subject.name,
            subject.family,
            subject.path,
        );
    }
    let mut found = index.definitions_named(&subject.name, subject.family);
    // The file the name was clicked in is always checked, because a new
    // definition in it is what the index is most likely to lack.
    let mut paths: Vec<&str> = vec![subject.path];
    let mut order: Vec<&Found> = found.iter().collect();
    order.sort_by_key(|one| {
        std::cmp::Reverse(shared_folders(&one.path, subject.path))
    });
    for one in order {
        if paths.len() >= MAX_CHECKED_FILES {
            break;
        }
        if !paths.contains(&&*one.path) {
            paths.push(&one.path);
        }
    }
    if index.make_current(&paths) {
        found = index.definitions_named(&subject.name, subject.family);
    }
    found
}

/// Reads the line of each target from its file.
fn with_text(index: &Index, mut targets: Vec<Target>) -> Vec<Target> {
    let mut texts: HashMap<String, Option<String>> = HashMap::new();
    for target in &mut targets {
        let text = texts.entry(target.path.clone()).or_insert_with(|| {
            crate::text::read_text(&index.root().join(&target.path))
        });
        if let Some(text) = text {
            target.text = Lines::new(text).preview(target.line as usize - 1);
        }
    }
    targets
}

fn target_of(one: Ranked) -> Target {
    Target {
        path: one.found.path.to_string(),
        line: one.found.def.line,
        column: one.found.def.column,
        end_column: one.found.def.end_column,
        kind: one.found.def.kind,
        container: one.found.def.container,
        declaration: one.found.def.declaration,
        group: one.group,
        text: String::new(),
    }
}

/// The definitions of a name as the answer lists them.
struct Answer {
    targets: Vec<Target>,
    /// See `Lookup::certain`.
    certain: bool,
    /// See `Lookup::likely`.
    likely: usize,
    /// The type written next to the name where it is defined, when the
    /// answer is certain and that definition has one.
    of_type: Option<String>,
}

/// The definitions of `subject`, ranked.
///
/// `at` is the place of the clicked name.
///
/// In C and C++ a function can have a prototype and a body. When the answer
/// is certain, which of the two is listed first is decided here.
///   - Normally it is the body, or the prototype if `prefer_declaration` is
///     true.
///   - When the name was clicked at the very place that would be listed
///     first, the other of the two is listed first instead. So from the
///     body of a function the first result is its prototype, and from the
///     prototype it is the body.
fn definitions(
    origin: &Origin,
    subject: &Subject,
    at: Span,
    prefer_declaration: bool,
) -> Answer {
    let index = origin.index;
    let found = candidates(index, subject);
    let mut ranked = rank(origin, subject, found, prefer_declaration);
    let certain = is_certain(&ranked);
    let mut likely = likely(&ranked);
    let of_type = ranked[..likely]
        .iter()
        .find_map(|one| one.found.def.of_type.clone())
        .filter(|_| certain);
    let here = |one: &Ranked| {
        &*one.found.path == subject.path
            && one.found.def.line == at.line
            && one.found.def.column == at.column
    };
    if certain
        && (here(&ranked[0])
            || ranked[0].found.def.declaration != prefer_declaration)
    {
        let first = &ranked[0].found.def;
        let counterpart = ranked.iter().position(|one| {
            one.found.def.declaration != first.declaration
                && one.found.def.container == first.container
        });
        if let Some(at) = counterpart {
            let other = ranked.remove(at);
            ranked.insert(0, other);
            // The counterpart belongs to the answer wherever it ranked.
            if at >= likely {
                likely += 1;
            }
        }
    }
    ranked.truncate(MAX_DEFINITIONS);
    let targets = ranked.into_iter().map(target_of).collect();
    Answer {
        targets: with_text(index, targets),
        certain,
        likely: likely.min(MAX_DEFINITIONS),
        of_type,
    }
}

/// The places that define the type written as `type_text` next to a name in
/// the file `origin`.
///
/// The names in the type are looked up as a class, a struct or similar, from
/// the last name backwards, and the first name the workspace defines is the
/// answer. The last name is most often the type itself: `Reading` in
/// `plant::Reading`, and `Row` in `std::vector<Row>`. For `Stack<int>` the
/// last name finds nothing, and `Stack` is the answer. The other names of
/// the type are taken as what the type belongs to.
fn type_targets(
    origin: &Origin,
    family: &'static str,
    type_text: &str,
) -> Vec<Target> {
    let (index, path) = (origin.index, origin.path);
    let words = type_words(type_text);
    for word in words.iter().rev() {
        let others = words.iter().filter(|other| *other != word);
        let subject = Subject {
            path,
            family,
            name: word.to_string(),
            role: Role::Type,
            flags: TYPE,
            owners: others
                .map(|other| Owner {
                    name: other.to_string(),
                    steps: 0,
                    written: false,
                })
                .collect(),
        };
        let mut found = candidates(index, &subject);
        found.retain(|one| one.def.kind.has_members());
        let ranked = rank(origin, &subject, found, false);
        if !ranked.is_empty() {
            let top = likely(&ranked).min(MAX_TYPE_TARGETS);
            let targets = ranked.into_iter().take(top).map(target_of);
            return with_text(index, targets.collect());
        }
    }
    Vec::new()
}

/// For a word in text that is not parsed: how the characters around it say
/// it is used, as the flags of `syntax.rs`, and the word it belongs to.
///
/// A `(` directly after the word makes it a call. A `.`, `->` or `::`
/// directly before it makes it a member, and the word in front of that sign
/// is what it belongs to: `app` for `fail` in `app.fail(error)`.
fn read_around(
    text: &str,
    word: std::ops::Range<usize>,
) -> (u8, Option<String>) {
    let mut flags = 0;
    if text[word.end..].starts_with('(') {
        flags |= CALL;
    }
    let before = &text[..word.start];
    let sign = ["?.", "->", "::", "."]
        .iter()
        .find(|sign| before.ends_with(**sign))
        .filter(|_| !before.ends_with(".."));
    let Some(sign) = sign else {
        return (flags, None);
    };
    flags |= MEMBER;
    let owner = word_at(text, before.len() - sign.len())
        .filter(|range| range.end == before.len() - sign.len())
        .map(|range| text[range].to_string());
    (flags, owner)
}

fn span_of(lines: &Lines, range: std::ops::Range<usize>) -> Span {
    let (line, column, end_column) = lines.place_of(range);
    Span {
        line,
        column,
        end_column,
    }
}

/// The name at a place of a parsed file, and what the file's syntax says
/// about it.
pub(crate) struct Named<'a> {
    pub syntax: &'a Syntax,
    pub analysis: &'a Analysis,
    pub node: Node<'a>,
}

/// What stands at a place of a file: a name in parsed code, a word in text
/// that is not parsed, or nothing that can be navigated from.
pub(crate) enum Pointed<'a> {
    Name(Named<'a>),
    Word(std::ops::Range<usize>),
    Nothing,
}

/// Finds what stands at `line` and `column` of a file that has been read.
pub(crate) fn pointed_at(
    parsed: &Parsed,
    line: u32,
    column: u32,
) -> Pointed<'_> {
    let text = parsed.text();
    let Some(offset) = Lines::new(text).offset_of(line, column) else {
        return Pointed::Nothing;
    };
    if let Some((syntax, analysis)) = parsed.analysed() {
        // In a file of markup, a place outside the `<script>` blocks is
        // handled as plain text below.
        if syntax.covers(offset) {
            return match syntax.name_at(offset) {
                Some(node) => Pointed::Name(Named {
                    syntax,
                    analysis,
                    node,
                }),
                None => Pointed::Nothing,
            };
        }
    }
    match word_at(text, offset) {
        Some(range) => Pointed::Word(range),
        None => Pointed::Nothing,
    }
}

/// Answers what the name at `line` and `column` of the file at `path` is and
/// where it is defined. `path` is relative to the workspace root.
///
/// `prefer_declaration` asks for prototypes before bodies where a name has
/// both, which is what "Go to declaration" means in C and C++.
///
/// Returns `None` when there is no name at that place, when the file cannot
/// be read, and for a file that is not code.
pub fn lookup(
    index: &Index,
    path: &str,
    line: u32,
    column: u32,
    prefer_declaration: bool,
) -> Option<Lookup> {
    let family = family_of(path)?;
    let parsed = index.parsed(path)?;
    let text = parsed.text();
    let lines = Lines::new(text);
    let origin = Origin::new(index, path, text);
    match pointed_at(&parsed, line, column) {
        Pointed::Nothing => None,
        Pointed::Name(Named {
            syntax,
            analysis,
            node,
        }) => {
            let name = syntax.text_of(node).to_string();
            let at = span_of(&lines, node.byte_range());
            let role = syntax.role_of(analysis, node);
            let local = syntax.local_of(analysis, node);
            // The other places in the file where the name means the same:
            // those that refer to the same local, or for a name that is
            // not local, those that refer to no local.
            let finder = WordFinder::new(&name);
            let occurrences = finder
                .find(text.as_bytes())
                .filter_map(|start| {
                    syntax.name_covering(start..start + name.len())
                })
                .filter(|other| {
                    let theirs = syntax.local_of(analysis, *other);
                    match (local, theirs) {
                        (Some(mine), Some(theirs)) => {
                            mine.name_range == theirs.name_range
                        }
                        (None, None) => true,
                        _ => false,
                    }
                })
                .map(|other| span_of(&lines, other.byte_range()))
                .collect();
            if let Some(local) = local {
                let defined = span_of(&lines, local.name_range.clone());
                let type_name = local
                    .type_range
                    .clone()
                    .and_then(|range| crate::text::type_text(&text[range]));
                let types = type_name.as_deref().map_or_else(Vec::new, |of| {
                    type_targets(&origin, family, of)
                });
                return Some(Lookup {
                    name,
                    line: at.line,
                    column: at.column,
                    end_column: at.end_column,
                    basis: Basis::Scope,
                    role,
                    occurrences,
                    definitions: vec![Target {
                        path: path.to_string(),
                        line: defined.line,
                        column: defined.column,
                        end_column: defined.end_column,
                        kind: Kind::Variable,
                        container: None,
                        declaration: false,
                        group: Group::Scope,
                        text: lines.preview(defined.line as usize - 1),
                    }],
                    likely: 1,
                    type_name: type_name.filter(|_| !types.is_empty()),
                    types,
                    certain: true,
                    indexing: index.is_indexing(),
                });
            }
            let subject = Subject {
                path,
                family,
                role,
                flags: analysis.uses.flags(node.start_byte()),
                owners: owners_of(index, family, syntax, analysis, node),
                name,
            };
            let answer = definitions(&origin, &subject, at, prefer_declaration);
            let types = answer
                .of_type
                .as_deref()
                .map_or_else(Vec::new, |of| type_targets(&origin, family, of));
            Some(Lookup {
                name: subject.name,
                line: at.line,
                column: at.column,
                end_column: at.end_column,
                basis: Basis::Name,
                role: subject.role,
                occurrences,
                definitions: answer.targets,
                likely: answer.likely,
                type_name: answer.of_type.filter(|_| !types.is_empty()),
                types,
                certain: answer.certain,
                indexing: index.is_indexing(),
            })
        }
        Pointed::Word(range) => {
            let name = text[range.clone()].to_string();
            let (flags, owner) = read_around(text, range.clone());
            let at = span_of(&lines, range);
            let finder = WordFinder::new(&name);
            let occurrences = finder
                .find(text.as_bytes())
                .map(|start| span_of(&lines, start..start + name.len()))
                .collect();
            let subject = Subject {
                path,
                family,
                role: Role::Text,
                flags,
                owners: with_supers(
                    index,
                    family,
                    owner.into_iter().map(|name| (name, true)).collect(),
                ),
                name,
            };
            let answer = definitions(&origin, &subject, at, prefer_declaration);
            Some(Lookup {
                name: subject.name,
                line: at.line,
                column: at.column,
                end_column: at.end_column,
                basis: Basis::Text,
                role: Role::Text,
                occurrences,
                definitions: answer.targets,
                likely: answer.likely,
                type_name: None,
                types: Vec::new(),
                certain: answer.certain,
                indexing: index.is_indexing(),
            })
        }
    }
}
