//! The index: every definition of the workspace, by name.
//!
//! [`Index::refresh`] reads the code files of the workspace and keeps what
//! each of them defines. Going to a definition then looks the name up here
//! and does not have to read the workspace again.
//!
//! Two more things are kept, because they say which of several definitions
//! with one name is meant. The first is what each class derives from, so
//! that a member can be found in a base class ([`Index::supers_of`]). The
//! second is the type written next to a field or a variable, so that the
//! members of `sink` in `sink.write()` can be looked for in that type.
//!
//! Keeping the index right. Each file is recorded with its size and
//! modification time. A refresh reads only the files whose size or time is
//! no longer the recorded one. Before an answer is given, the files it names
//! are checked the same way with [`Index::make_current`], so an answer never
//! comes from an old version of a file even when no refresh has run since the
//! file changed.
//!
//! Very large workspaces. Above [`INDEX_FILE_LIMIT`] code files no index is
//! kept. A name is then looked up with [`Index::definitions_by_search`],
//! which searches the files for the name and parses the ones that hold it.
//! The same search answers while the first refresh is still running.

use crate::grammar::{family_of, grammar_of};
use crate::imports::FileNames;
use crate::plain;
use crate::syntax::{self, Analysis, Kind, Syntax};
use crate::text::{
    looks_minified, read_text, shared_folders, stamp_of, type_text, Lines,
    Stamp, WordFinder,
};
use rayon::prelude::*;
use serde::Serialize;
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock, RwLock};

/// A workspace with more code files than this gets no index.
pub const INDEX_FILE_LIMIT: usize = 100_000;

/// A refresh adds the results of at most this many files to the index
/// before it lets go of the index's lock, so that answers are not held up.
const MERGE_GROUP: usize = 256;

/// [`Index::supers_of`] returns at most this many names, and follows a chain
/// of base classes at most this many steps.
const MAX_SUPERS: usize = 48;
const MAX_SUPER_STEPS: u8 = 12;

/// How many parsed files are remembered. They are the files the user looked
/// at last, so that a second click in the same file does not parse it again.
const PARSED_KEPT: usize = 32;

/// One definition as the index records it. `line` is counted from 1, and
/// `column` and `end_column` are the UTF-16 columns of the name.
#[derive(Debug, Clone, PartialEq)]
pub struct IndexedDef {
    pub name: String,
    pub container: Option<String>,
    pub kind: Kind,
    pub declaration: bool,
    pub line: u32,
    pub column: u32,
    pub end_column: u32,
    /// The type the code gives the name, as written, for a field or a
    /// variable whose type is written next to it.
    pub of_type: Option<String>,
}

/// What the index records about one file.
#[derive(Debug, Clone, Default)]
pub struct FileFacts {
    pub defs: Vec<IndexedDef>,
    /// What each class or similar in the file derives from, as pairs of its
    /// name and the name of one thing it derives from.
    pub bases: Vec<(String, String)>,
}

/// A definition found for a name, with the file it is in.
#[derive(Debug, Clone)]
pub struct Found {
    pub path: Arc<str>,
    pub def: IndexedDef,
}

/// One result of a search for definitions by name.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SymbolHit {
    pub name: String,
    pub kind: Kind,
    pub container: Option<String>,
    pub path: String,
    pub line: u32,
    pub column: u32,
    pub end_column: u32,
}

/// A file that has been read, and parsed when its language has a parser.
pub struct Parsed {
    content: Content,
    analysis: OnceLock<Analysis>,
}

enum Content {
    Syntax(Syntax),
    Text(String),
}

impl Parsed {
    /// Reads `text` as the file at `path`. A file whose language has no
    /// parser, and a file the parser gives up on, is kept as text only.
    pub fn new(path: &str, text: String) -> Parsed {
        let content = match grammar_of(path) {
            Some(grammar) if !looks_minified(&text) => {
                // `parse` takes the text and returns it inside the syntax
                // tree, so it is copied for the case that parsing fails.
                match syntax::parse(grammar, text.clone()) {
                    Some(syntax) => Content::Syntax(syntax),
                    None => Content::Text(text),
                }
            }
            _ => Content::Text(text),
        };
        Parsed {
            content,
            analysis: OnceLock::new(),
        }
    }

    pub fn text(&self) -> &str {
        match &self.content {
            Content::Syntax(syntax) => &syntax.text,
            Content::Text(text) => text,
        }
    }

    pub fn syntax(&self) -> Option<&Syntax> {
        match &self.content {
            Content::Syntax(syntax) => Some(syntax),
            Content::Text(_) => None,
        }
    }

    /// The parsed file with what the queries find in it, or `None` for a file
    /// that is kept as text only. The queries run the first time this is
    /// asked for.
    pub fn analysed(&self) -> Option<(&Syntax, &Analysis)> {
        let syntax = self.syntax()?;
        Some((syntax, self.analysis.get_or_init(|| syntax.analyse())))
    }
}

/// What the index records about the file at `path` with the content `text`.
/// Definitions inside function bodies are left out.
pub fn facts_of(path: &str, text: String) -> FileFacts {
    let Some(grammar) = grammar_of(path) else {
        return FileFacts {
            defs: if family_of(path).is_some() {
                plain::definitions(&text)
            } else {
                Vec::new()
            },
            bases: Vec::new(),
        };
    };
    if looks_minified(&text) {
        return FileFacts::default();
    }
    let Some(syntax) = syntax::parse(grammar, text) else {
        return FileFacts::default();
    };
    let lines = Lines::new(&syntax.text);
    let defined = syntax.definitions();
    let defs = defined
        .defs
        .into_iter()
        .filter(|def| !def.nested)
        .map(|def| {
            let (line, column, end_column) = lines.place_of(def.name_range);
            IndexedDef {
                name: def.name,
                container: def.container,
                kind: def.kind,
                declaration: def.declaration,
                line,
                column,
                end_column,
                of_type: def
                    .type_range
                    .and_then(|range| type_text(&syntax.text[range])),
            }
        })
        .collect();
    FileFacts {
        defs,
        bases: defined.bases,
    }
}

/// What the file at `path` with the content `text` defines, as the index
/// records it.
pub fn definitions_of(path: &str, text: String) -> Vec<IndexedDef> {
    facts_of(path, text).defs
}

/// One definition of a file with the lines it covers, for anchoring a
/// selection of code to the definition it belongs to. `first_line` and
/// `last_line` are counted from 1 and include the whole definition, with its
/// body.
#[derive(Debug, Clone, PartialEq)]
pub struct Extent {
    pub name: String,
    pub container: Option<String>,
    pub kind: Kind,
    pub first_line: u32,
    pub last_line: u32,
}

/// The definitions of the file at `path` with the content `text`, each with
/// the lines it covers, in the order of the file.
///
/// Definitions inside function bodies are left out, and so are prototypes,
/// which have no body to cover. A file whose language has no parser gives an
/// empty list, because the end of a definition is then not known.
pub fn extents_of(path: &str, text: String) -> Vec<Extent> {
    let Some(grammar) = grammar_of(path) else {
        return Vec::new();
    };
    if looks_minified(&text) {
        return Vec::new();
    }
    let Some(syntax) = syntax::parse(grammar, text) else {
        return Vec::new();
    };
    let lines = Lines::new(&syntax.text);
    syntax
        .definitions()
        .defs
        .into_iter()
        .filter(|def| !def.nested && !def.declaration)
        .map(|def| {
            // The last byte of the definition decides its last line. The
            // byte after it can already be on the next line.
            let last = def.range.end.saturating_sub(1).max(def.range.start);
            Extent {
                name: def.name,
                container: def.container,
                kind: def.kind,
                first_line: lines.row_of(def.range.start) as u32 + 1,
                last_line: lines.row_of(last) as u32 + 1,
            }
        })
        .collect()
}

/// A definition in the compact form the index stores. `name`, `container`
/// and `of_type` are numbers that stand for strings, see [`Names`].
#[derive(Clone, Copy)]
struct Packed {
    name: u32,
    /// `NONE` when the definition has no container.
    container: u32,
    /// `NONE` when no type is written next to the name.
    of_type: u32,
    line: u32,
    /// The column of the name. A column that does not fit is stored as the
    /// largest number that does. Where the name ends is not stored, because
    /// it follows from the column and the name.
    column: u16,
    /// The number of the kind, see `Kind::code`, with `PROTOTYPE` added for
    /// a definition without its body.
    kind: u8,
}

/// Stands for "no string" where a number of [`Names`] is expected.
const NONE: u32 = u32::MAX;
const PROTOTYPE: u8 = 0x80;

/// The entries of the files that define one name or once did. Most names
/// are defined in one file, so that case holds the entry itself and needs
/// no list.
#[derive(Default)]
enum Files {
    #[default]
    None,
    One(u32),
    Many(Vec<u32>),
}

impl Files {
    fn add(&mut self, file: u32) {
        match self {
            Files::None => *self = Files::One(file),
            Files::One(first) => *self = Files::Many(vec![*first, file]),
            Files::Many(list) => list.push(file),
        }
    }

    fn as_slice(&self) -> &[u32] {
        match self {
            Files::None => &[],
            Files::One(file) => std::slice::from_ref(file),
            Files::Many(list) => list,
        }
    }
}

/// Every distinct name and container name, each stored once. A definition
/// refers to a string by its number here, which keeps the index small when
/// a name is defined in many files.
#[derive(Default)]
struct Names {
    numbers: HashMap<Arc<str>, u32>,
    strings: Vec<Arc<str>>,
}

impl Names {
    fn number_of(&mut self, text: &str) -> u32 {
        if let Some(number) = self.numbers.get(text) {
            return *number;
        }
        let shared: Arc<str> = Arc::from(text);
        let number = self.strings.len() as u32;
        self.strings.push(Arc::clone(&shared));
        self.numbers.insert(shared, number);
        number
    }
}

/// What the index knows about one file.
struct Entry {
    path: Arc<str>,
    stamp: Stamp,
    defs: Vec<Packed>,
    /// What derives from what in the file: the number of a class's name,
    /// then the number of the name of one thing it derives from.
    bases: Vec<(u32, u32)>,
    /// False once the file is no longer in the workspace. Its number stays
    /// taken, and lists that still name the number skip it.
    present: bool,
}

#[derive(Default)]
struct Inner {
    names: Names,
    entries: Vec<Entry>,
    /// The number of each file's entry in `entries`, by path.
    numbers: HashMap<Arc<str>, u32>,
    /// For each name, by its number, the entries of the files that define it
    /// or say what it derives from, or once did. A reader must check that
    /// the entry still does.
    files_of: Vec<Files>,
}

impl Inner {
    /// Records `facts` about the file at `path`, in place of what was
    /// recorded for it before.
    fn put(&mut self, path: &str, stamp: Stamp, facts: FileFacts) {
        let packed: Vec<Packed> = facts
            .defs
            .iter()
            .map(|def| Packed {
                name: self.names.number_of(&def.name),
                container: def
                    .container
                    .as_ref()
                    .map_or(NONE, |c| self.names.number_of(c)),
                of_type: def
                    .of_type
                    .as_ref()
                    .map_or(NONE, |t| self.names.number_of(t)),
                line: def.line,
                column: def.column.min(u32::from(u16::MAX)) as u16,
                kind: def.kind.code()
                    | if def.declaration { PROTOTYPE } else { 0 },
            })
            .collect();
        let bases: Vec<(u32, u32)> = facts
            .bases
            .iter()
            .map(|(derived, base)| {
                (self.names.number_of(derived), self.names.number_of(base))
            })
            .collect();
        if self.files_of.len() < self.names.strings.len() {
            self.files_of
                .resize_with(self.names.strings.len(), Files::default);
        }
        let number = match self.numbers.get(path) {
            Some(number) => *number,
            None => {
                let shared: Arc<str> = Arc::from(path);
                let number = self.entries.len() as u32;
                self.entries.push(Entry {
                    path: Arc::clone(&shared),
                    stamp,
                    defs: Vec::new(),
                    bases: Vec::new(),
                    present: true,
                });
                self.numbers.insert(shared, number);
                number
            }
        };
        let entry = &mut self.entries[number as usize];
        // The names the file was already listed under need no second
        // listing.
        let named = |defs: &[Packed], bases: &[(u32, u32)]| -> Vec<u32> {
            let defined = defs.iter().map(|def| def.name);
            defined.chain(bases.iter().map(|pair| pair.0)).collect()
        };
        let listed: HashSet<u32> =
            named(&entry.defs, &entry.bases).into_iter().collect();
        let mut added = HashSet::new();
        for name in named(&packed, &bases) {
            if !listed.contains(&name) && added.insert(name) {
                self.files_of[name as usize].add(number);
            }
        }
        entry.stamp = stamp;
        entry.defs = packed;
        entry.bases = bases;
        entry.present = true;
    }

    fn remove(&mut self, path: &str) {
        if let Some(number) = self.numbers.get(path) {
            let entry = &mut self.entries[*number as usize];
            entry.present = false;
            entry.defs = Vec::new();
            entry.bases = Vec::new();
            entry.stamp = (0, 0);
        }
    }

    fn unpack(&self, def: &Packed) -> IndexedDef {
        let name = self.names.strings[def.name as usize].to_string();
        let column = u32::from(def.column);
        IndexedDef {
            end_column: column + name.encode_utf16().count() as u32,
            name,
            container: (def.container != NONE).then(|| {
                self.names.strings[def.container as usize].to_string()
            }),
            of_type: (def.of_type != NONE)
                .then(|| self.names.strings[def.of_type as usize].to_string()),
            kind: Kind::from_code(def.kind & !PROTOTYPE),
            declaration: def.kind & PROTOTYPE != 0,
            line: def.line,
            column,
        }
    }

    /// Every recorded definition with exactly this name.
    fn named(&self, name: &str) -> Vec<Found> {
        let Some(number) = self.names.numbers.get(name) else {
            return Vec::new();
        };
        let mut found = Vec::new();
        let files = self.files_of.get(*number as usize);
        for file in files.map_or(&[][..], Files::as_slice) {
            let entry = &self.entries[*file as usize];
            if !entry.present {
                continue;
            }
            for def in entry.defs.iter().filter(|def| def.name == *number) {
                found.push(Found {
                    path: Arc::clone(&entry.path),
                    def: self.unpack(def),
                });
            }
        }
        found
    }

    /// The names of what the things named `name` derive from directly, in
    /// files of the language family `family`.
    fn bases_of(&self, name: &str, family: &str) -> Vec<&Arc<str>> {
        let Some(number) = self.names.numbers.get(name) else {
            return Vec::new();
        };
        let mut found = Vec::new();
        let files = self.files_of.get(*number as usize);
        for file in files.map_or(&[][..], Files::as_slice) {
            let entry = &self.entries[*file as usize];
            if !entry.present || family_of(&entry.path) != Some(family) {
                continue;
            }
            for (_, base) in entry.bases.iter().filter(|b| b.0 == *number) {
                found.push(&self.names.strings[*base as usize]);
            }
        }
        found
    }
}

/// A refresh that is running, and the list of files for the next one if
/// another was asked for meanwhile.
#[derive(Default)]
struct Refreshing {
    running: bool,
    next: Option<Vec<String>>,
}

pub struct Index {
    root: PathBuf,
    /// The threads that read and parse files. There are half as many as the
    /// computer has cores, so that indexing leaves room for the interface
    /// and for a running job.
    pool: rayon::ThreadPool,
    inner: RwLock<Inner>,
    /// Every file of the workspace as the last refresh was given it, as
    /// paths relative to the root.
    files: RwLock<Arc<Vec<String>>>,
    /// True once a refresh has finished, with or without an index.
    complete: AtomicBool,
    /// True when the workspace has too many code files for an index.
    too_large: AtomicBool,
    /// True once the workspace was closed. A running refresh then stops.
    closed: AtomicBool,
    refreshing: Mutex<Refreshing>,
    /// The files parsed last, newest first, each with the stamp it had when
    /// it was read.
    parsed: Mutex<VecDeque<(String, Stamp, Arc<Parsed>)>>,
    /// The tables that find the files an import names, built from `files`
    /// the first time they are asked for.
    file_names: Mutex<Option<Arc<FileNames>>>,
}

impl Index {
    /// An empty index for the workspace at `root`. [`Index::refresh`] fills
    /// it.
    pub fn new(root: &Path) -> Arc<Index> {
        let threads = std::thread::available_parallelism()
            .map_or(1, |cores| (cores.get() / 2).max(1));
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(threads)
            .thread_name(|n| format!("codjiva-nav-{n}"))
            .build()
            .expect("the thread pool starts");
        Arc::new(Index {
            root: root.to_path_buf(),
            pool,
            inner: RwLock::default(),
            files: RwLock::default(),
            complete: AtomicBool::new(false),
            too_large: AtomicBool::new(false),
            closed: AtomicBool::new(false),
            refreshing: Mutex::default(),
            parsed: Mutex::default(),
            file_names: Mutex::default(),
        })
    }

    fn inner(&self) -> std::sync::RwLockReadGuard<'_, Inner> {
        self.inner.read().expect("the index lock is not poisoned")
    }

    fn inner_mut(&self) -> std::sync::RwLockWriteGuard<'_, Inner> {
        self.inner.write().expect("the index lock is not poisoned")
    }

    /// Stops a running refresh. Called when the workspace is closed.
    pub fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
    }

    /// True when definitions can be looked up in the index: a refresh has
    /// finished and the workspace was not too large.
    pub fn is_ready(&self) -> bool {
        self.complete.load(Ordering::SeqCst)
            && !self.too_large.load(Ordering::SeqCst)
    }

    /// True while the first refresh has not finished. Answers given
    /// meanwhile come from a search and may take longer.
    pub fn is_indexing(&self) -> bool {
        !self.complete.load(Ordering::SeqCst)
    }

    /// Every file of the workspace, as the last refresh was given it.
    pub fn files(&self) -> Arc<Vec<String>> {
        Arc::clone(&self.files.read().expect("the file list is not poisoned"))
    }

    /// The tables that find the files an import names, for the current list
    /// of files. They are built again after a refresh was given a new list.
    pub fn file_names(&self) -> Arc<FileNames> {
        let files = self.files();
        let mut kept =
            self.file_names.lock().expect("the lock is not poisoned");
        match &*kept {
            Some(names) if Arc::ptr_eq(names.files(), &files) => {
                Arc::clone(names)
            }
            _ => {
                let names = Arc::new(FileNames::new(files));
                *kept = Some(Arc::clone(&names));
                names
            }
        }
    }

    pub fn pool(&self) -> &rayon::ThreadPool {
        &self.pool
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Brings the index in line with the workspace. `files` is every file of
    /// the workspace, as paths relative to the root.
    ///
    /// The call returns when the index is current, which takes a moment for a
    /// large workspace the first time, so it belongs on a background thread.
    /// If a refresh is already running on another thread, this call only
    /// leaves `files` for that refresh to do next, and returns at once.
    pub fn refresh(&self, files: Vec<String>) {
        {
            let mut state =
                self.refreshing.lock().expect("the lock is not poisoned");
            if state.running {
                state.next = Some(files);
                return;
            }
            state.running = true;
        }
        let mut todo = Some(files);
        while let Some(files) = todo {
            self.refresh_once(files);
            let mut state =
                self.refreshing.lock().expect("the lock is not poisoned");
            todo = state.next.take();
            if todo.is_none() {
                state.running = false;
            }
        }
    }

    fn refresh_once(&self, files: Vec<String>) {
        let files = Arc::new(files);
        *self.files.write().expect("the file list is not poisoned") =
            Arc::clone(&files);
        let code: Vec<&String> = files
            .iter()
            .filter(|path| family_of(path).is_some())
            .collect();
        if code.len() > INDEX_FILE_LIMIT {
            *self.inner_mut() = Inner::default();
            self.too_large.store(true, Ordering::SeqCst);
            self.complete.store(true, Ordering::SeqCst);
            return;
        }
        self.too_large.store(false, Ordering::SeqCst);

        // Files that left the workspace are taken out, and the stamp of
        // every other file is compared with the recorded one.
        let listed: HashSet<&str> = code.iter().map(|p| p.as_str()).collect();
        let recorded: HashMap<Arc<str>, Stamp> = {
            let mut inner = self.inner_mut();
            let gone: Vec<Arc<str>> = inner
                .entries
                .iter()
                .filter(|e| e.present && !listed.contains(&*e.path))
                .map(|e| Arc::clone(&e.path))
                .collect();
            for path in gone {
                inner.remove(&path);
            }
            inner
                .entries
                .iter()
                .filter(|e| e.present)
                .map(|e| (Arc::clone(&e.path), e.stamp))
                .collect()
        };
        let changed: Vec<(&String, Stamp)> = self.pool.install(|| {
            code.par_iter()
                .filter_map(|path| {
                    let stamp = stamp_of(&self.root.join(path))?;
                    (recorded.get(path.as_str()) != Some(&stamp))
                        .then_some((*path, stamp))
                })
                .collect()
        });
        // The files are read and parsed on the pool's threads, each as soon
        // as a thread is free. What they define is handed to this thread,
        // which adds it to the index a group at a time, so that the index is
        // locked for writing only briefly and one slow file holds up no
        // other.
        let (parsed, arriving) = std::sync::mpsc::channel();
        std::thread::scope(|scope| {
            scope.spawn(|| {
                self.pool.install(|| {
                    changed.par_iter().for_each_with(
                        parsed,
                        |parsed, (path, stamp)| {
                            if self.closed.load(Ordering::SeqCst) {
                                return;
                            }
                            let facts = read_text(&self.root.join(path))
                                .map(|text| facts_of(path, text))
                                .unwrap_or_default();
                            let _ = parsed.send((*path, *stamp, facts));
                        },
                    );
                });
            });
            while let Ok(first) = arriving.recv() {
                let mut group = vec![first];
                group.extend(arriving.try_iter().take(MERGE_GROUP - 1));
                let mut inner = self.inner_mut();
                for (path, stamp, facts) in group {
                    inner.put(path, stamp, facts);
                }
            }
        });
        if self.closed.load(Ordering::SeqCst) {
            return;
        }
        self.complete.store(true, Ordering::SeqCst);
    }

    /// Reads again each of `paths` whose size or modification time is not
    /// the recorded one, and takes out each that no longer exists. Returns
    /// true when the index changed.
    pub fn make_current(&self, paths: &[&str]) -> bool {
        if !self.is_ready() {
            return false;
        }
        let stale: Vec<(&str, Option<Stamp>)> = {
            let inner = self.inner();
            paths
                .iter()
                .filter_map(|path| {
                    let now = stamp_of(&self.root.join(path));
                    let recorded = inner
                        .numbers
                        .get(*path)
                        .map(|n| &inner.entries[*n as usize])
                        .filter(|entry| entry.present)
                        .map(|entry| entry.stamp);
                    (now != recorded).then_some((*path, now))
                })
                .collect()
        };
        if stale.is_empty() {
            return false;
        }
        for (path, stamp) in stale {
            match stamp {
                Some(stamp) if family_of(path).is_some() => {
                    let facts = read_text(&self.root.join(path))
                        .map(|text| facts_of(path, text))
                        .unwrap_or_default();
                    self.inner_mut().put(path, stamp, facts);
                }
                _ => self.inner_mut().remove(path),
            }
        }
        true
    }

    /// Every definition named `name` that the index records, in files of
    /// the language family `family`.
    pub fn definitions_named(&self, name: &str, family: &str) -> Vec<Found> {
        let mut found = self.inner().named(name);
        found.retain(|one| family_of(&one.path) == Some(family));
        found
    }

    /// Everything that the things named `names` derive from, directly or
    /// through something else, in files of the language family `family`.
    /// Each result has the number of steps it is away: 1 for a direct base
    /// class, 2 for the base class of that one. Nearer results come first.
    ///
    /// Classes are told apart by name only, so two classes with one name
    /// are followed as if they were one. At most [`MAX_SUPERS`] results are
    /// returned. Returns nothing while there is no index.
    pub fn supers_of(&self, names: &[&str], family: &str) -> Vec<(String, u8)> {
        if !self.is_ready() {
            return Vec::new();
        }
        let inner = self.inner();
        let mut seen: HashSet<&str> = names.iter().copied().collect();
        let mut found: Vec<(String, u8)> = Vec::new();
        let mut level: Vec<&str> = names.to_vec();
        for steps in 1..=MAX_SUPER_STEPS {
            let mut next = Vec::new();
            for name in level {
                for base in inner.bases_of(name, family) {
                    if found.len() < MAX_SUPERS && seen.insert(base) {
                        found.push((base.to_string(), steps));
                        next.push(&**base);
                    }
                }
            }
            if next.is_empty() {
                break;
            }
            level = next;
        }
        found
    }

    /// Every definition named `name` in files of the family `family`, found
    /// by searching the files for the name and parsing those that hold it.
    /// It needs no index. Files that share more folders with `near` are
    /// read first.
    pub fn definitions_by_search(
        &self,
        name: &str,
        family: &str,
        near: &str,
    ) -> Vec<Found> {
        let files = self.files();
        let mut candidates: Vec<&String> = files
            .iter()
            .filter(|path| family_of(path) == Some(family))
            .collect();
        candidates
            .sort_by_key(|path| std::cmp::Reverse(shared_folders(path, near)));
        let finder = WordFinder::new(name);
        self.pool.install(|| {
            candidates
                .par_iter()
                .flat_map_iter(|path| {
                    let defs = read_text(&self.root.join(path))
                        .filter(|text| finder.is_in(text.as_bytes()))
                        .map(|text| definitions_of(path, text))
                        .unwrap_or_default();
                    let path: Arc<str> = Arc::from(path.as_str());
                    defs.into_iter()
                        .filter(|def| def.name == name)
                        .map(move |def| Found {
                            path: Arc::clone(&path),
                            def,
                        })
                        .collect::<Vec<_>>()
                })
                .collect()
        })
    }

    /// The file at `path`, read and parsed. A file that was parsed lately
    /// and has not changed since is not read again. Returns `None` for a
    /// file that cannot be read, is too large or is not text.
    pub fn parsed(&self, path: &str) -> Option<Arc<Parsed>> {
        let full = self.root.join(path);
        let stamp = stamp_of(&full)?;
        let mut kept = self.parsed.lock().expect("the lock is not poisoned");
        if let Some(at) =
            kept.iter().position(|(p, s, _)| p == path && *s == stamp)
        {
            let hit = kept.remove(at).expect("the position exists");
            let parsed = Arc::clone(&hit.2);
            kept.push_front(hit);
            return Some(parsed);
        }
        drop(kept);
        let parsed = Arc::new(Parsed::new(path, read_text(&full)?));
        let mut kept = self.parsed.lock().expect("the lock is not poisoned");
        kept.retain(|(p, _, _)| p != path);
        kept.push_front((path.to_string(), stamp, Arc::clone(&parsed)));
        kept.truncate(PARSED_KEPT);
        Some(parsed)
    }

    /// Definitions whose name contains `query`, ignoring case, best first:
    /// a name that equals the query, then names that start with it, then
    /// the others, shorter names first. Returns nothing for an empty query
    /// and while there is no index.
    pub fn search(&self, query: &str, limit: usize) -> Vec<SymbolHit> {
        let query = query.trim();
        if query.is_empty() || !self.is_ready() {
            return Vec::new();
        }
        let wanted = query.to_lowercase();
        let inner = self.inner();
        let mut names: Vec<(u8, usize, u32)> = inner
            .names
            .strings
            .iter()
            .enumerate()
            .filter_map(|(number, name)| {
                let lower = name.to_lowercase();
                let at = lower.find(&wanted)?;
                let rank = if lower.len() == wanted.len() {
                    0
                } else if at == 0 {
                    1
                } else {
                    2
                };
                Some((rank, name.len(), number as u32))
            })
            .collect();
        names.sort_unstable();
        let mut hits = Vec::new();
        for (_, _, number) in names {
            let files = inner.files_of.get(number as usize);
            for file in files.map_or(&[][..], Files::as_slice) {
                let entry = &inner.entries[*file as usize];
                if !entry.present {
                    continue;
                }
                for def in entry.defs.iter().filter(|d| d.name == number) {
                    let def = inner.unpack(def);
                    hits.push(SymbolHit {
                        name: def.name,
                        kind: def.kind,
                        container: def.container,
                        path: entry.path.to_string(),
                        line: def.line,
                        column: def.column,
                        end_column: def.end_column,
                    });
                    if hits.len() >= limit {
                        return hits;
                    }
                }
            }
        }
        hits
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn workspace(files: &[(&str, &str)]) -> (tempfile::TempDir, Arc<Index>) {
        let dir = tempfile::tempdir().unwrap();
        for (rel, text) in files {
            let path = dir.path().join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, text).unwrap();
        }
        let index = Index::new(dir.path());
        index.refresh(files.iter().map(|(rel, _)| rel.to_string()).collect());
        (dir, index)
    }

    fn places(found: &[Found]) -> Vec<String> {
        let mut places: Vec<String> = found
            .iter()
            .map(|one| format!("{}:{}", one.path, one.def.line))
            .collect();
        places.sort();
        places
    }

    #[test]
    fn extents_give_the_lines_of_each_definition_with_its_body() {
        let text = "package a\n\ntype Meter struct {\n\ttotal int\n}\n\nfunc \
                    (m *Meter) Add(n int) {\n\tm.total += n\n}\n\nfunc \
                    Read() int { return 1 }\n";
        let found: Vec<(String, Option<String>, u32, u32)> =
            extents_of("a/meter.go", text.to_string())
                .into_iter()
                .filter(|one| one.kind != Kind::Field)
                .map(|one| {
                    (one.name, one.container, one.first_line, one.last_line)
                })
                .collect();
        assert_eq!(
            found,
            [
                ("Meter".to_string(), None, 3, 5),
                ("Add".to_string(), Some("Meter".to_string()), 7, 9),
                ("Read".to_string(), None, 11, 11),
            ]
        );
        // A language without a parser has no extents.
        assert!(extents_of("notes.txt", "func Read()".to_string()).is_empty());
    }

    #[test]
    fn definitions_are_found_by_name_within_one_language_family() {
        let (_dir, index) = workspace(&[
            ("a/meter.go", "package a\n\nfunc Read() int { return 1 }\n"),
            ("b/gauge.go", "package b\n\nfunc Read() int { return 2 }\n"),
            ("web/meter.ts", "export function Read() { return 3; }\n"),
            ("lib/meter.rb", "def Read\nend\n"),
            ("README.md", "func Read is described here.\n"),
        ]);
        assert!(index.is_ready());
        assert_eq!(
            places(&index.definitions_named("Read", "go")),
            vec!["a/meter.go:3", "b/gauge.go:3"]
        );
        assert_eq!(
            places(&index.definitions_named("Read", "js")),
            vec!["web/meter.ts:1"]
        );
        assert_eq!(
            places(&index.definitions_named("Read", "ruby")),
            vec!["lib/meter.rb:1"]
        );
        // The search that needs no index finds the same.
        assert_eq!(
            places(&index.definitions_by_search("Read", "go", "a/x.go")),
            vec!["a/meter.go:3", "b/gauge.go:3"]
        );
    }

    #[test]
    fn a_changed_file_is_read_again_and_a_deleted_one_is_forgotten() {
        let (dir, index) = workspace(&[
            ("meter.py", "def read():\n    return 1\n"),
            ("gauge.py", "def show():\n    pass\n"),
        ]);
        assert_eq!(
            places(&index.definitions_named("read", "python")),
            vec!["meter.py:1"]
        );
        // The file gets a longer content, so its size differs even when the
        // clock has not moved on.
        fs::write(
            dir.path().join("meter.py"),
            "import os\n\n\ndef read():\n    return 1\n\n\ndef reset():\n    \
             pass\n",
        )
        .unwrap();
        assert!(index.make_current(&["meter.py", "gauge.py"]));
        assert!(!index.make_current(&["meter.py", "gauge.py"]));
        assert_eq!(
            places(&index.definitions_named("read", "python")),
            vec!["meter.py:4"]
        );
        assert_eq!(
            places(&index.definitions_named("reset", "python")),
            vec!["meter.py:8"]
        );

        fs::remove_file(dir.path().join("gauge.py")).unwrap();
        index.refresh(vec!["meter.py".to_string()]);
        assert!(index.definitions_named("show", "python").is_empty());
    }

    #[test]
    fn a_search_ranks_the_exact_name_first() {
        let (_dir, index) = workspace(&[(
            "meter.go",
            "package a\n\nfunc readAll() {}\nfunc Read() {}\nfunc \
             spreadsheet() {}\n",
        )]);
        let names: Vec<String> = index
            .search("read", 10)
            .into_iter()
            .map(|hit| hit.name)
            .collect();
        assert_eq!(names, vec!["Read", "readAll", "spreadsheet"]);
        assert!(index.search("  ", 10).is_empty());
        assert_eq!(index.search("read", 1).len(), 1);
    }
}
