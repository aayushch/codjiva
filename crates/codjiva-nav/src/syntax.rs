//! One parsed file: what it defines, how each name in it is used, and which
//! names belong to one function.
//!
//! [`parse`] reads a file with its language's parser. [`Syntax::analyse`]
//! then runs the three queries of that language (see
//! `resources/nav/README.md`) and returns their findings as an [`Analysis`].

use crate::grammar::Grammar;
use crate::text::{simple_name, Lines};
use regex::Regex;
use serde::Serialize;
use std::collections::HashMap;
use std::ops::{ControlFlow, Range};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tree_sitter::{
    Node, ParseOptions, ParseState, Parser, Point, QueryCursor,
    Range as TreeRange, StreamingIterator, Tree,
};

/// Parsing one file is given up after this long, so that a file the parser
/// handles badly cannot hold up an answer.
const PARSE_LIMIT: Duration = Duration::from_secs(2);

/// What kind of thing a definition is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Function,
    Method,
    Class,
    Struct,
    Interface,
    Trait,
    Enum,
    Type,
    Constant,
    Variable,
    Field,
    Enumerator,
    Namespace,
    Module,
    Macro,
}

impl Kind {
    /// The kind a capture such as `definition.function` names. `name` is the
    /// part after the dot.
    fn named(name: &str) -> Option<Kind> {
        Some(match name {
            "function" => Kind::Function,
            "method" => Kind::Method,
            "class" => Kind::Class,
            "struct" => Kind::Struct,
            "interface" => Kind::Interface,
            "trait" => Kind::Trait,
            "enum" => Kind::Enum,
            "type" => Kind::Type,
            "constant" => Kind::Constant,
            "variable" => Kind::Variable,
            "field" => Kind::Field,
            "enumerator" => Kind::Enumerator,
            "namespace" => Kind::Namespace,
            "module" => Kind::Module,
            "macro" => Kind::Macro,
            _ => return None,
        })
    }

    /// True for a kind whose definitions have members: a function defined
    /// inside one of these is a method.
    pub fn has_members(self) -> bool {
        matches!(
            self,
            Kind::Class
                | Kind::Struct
                | Kind::Interface
                | Kind::Trait
                | Kind::Enum
                | Kind::Type
        )
    }

    /// True for a kind that gives the definitions inside it a container.
    fn contains_others(self) -> bool {
        self.has_members() || matches!(self, Kind::Namespace | Kind::Module)
    }

    /// True for a kind that can be called: a function, or a type that is
    /// built by calling its name.
    pub fn is_callable(self) -> bool {
        matches!(
            self,
            Kind::Function
                | Kind::Method
                | Kind::Macro
                | Kind::Class
                | Kind::Struct
                | Kind::Type
        )
    }

    /// True for a kind that can stand where a type is expected, or before
    /// `::` or a dot as the owner of something.
    pub fn is_type(self) -> bool {
        self.contains_others()
    }

    /// A number for the kind, for storing it in one byte.
    pub fn code(self) -> u8 {
        self as u8
    }

    pub fn from_code(code: u8) -> Kind {
        const ALL: [Kind; 15] = [
            Kind::Function,
            Kind::Method,
            Kind::Class,
            Kind::Struct,
            Kind::Interface,
            Kind::Trait,
            Kind::Enum,
            Kind::Type,
            Kind::Constant,
            Kind::Variable,
            Kind::Field,
            Kind::Enumerator,
            Kind::Namespace,
            Kind::Module,
            Kind::Macro,
        ];
        ALL.get(code as usize).copied().unwrap_or(Kind::Variable)
    }
}

/// What one occurrence of a name is, for the list of references.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    /// The place that defines the name.
    Definition,
    /// A place that announces the name without its body, such as a prototype.
    Declaration,
    /// The name is called.
    Call,
    /// The name stands where a type is expected.
    Type,
    /// Any other use in parsed code.
    Use,
    /// The word was found in a file that is not parsed, so nothing is known
    /// about how it is used there.
    Text,
}

/// One definition in a file.
#[derive(Debug, Clone)]
pub struct Def {
    pub name: String,
    pub kind: Kind,
    /// True for a definition without its body, such as a prototype in a C
    /// header.
    pub declaration: bool,
    /// The name of the class, namespace or other definition this one is
    /// inside, if any.
    pub container: Option<String>,
    /// The bytes of the name.
    pub name_range: Range<usize>,
    /// The bytes of the whole definition.
    pub range: Range<usize>,
    /// True for a definition inside a function body. Such a definition is
    /// not listed in the workspace index.
    pub nested: bool,
    /// The bytes of the type the code gives the name, for a field or a
    /// variable whose type is written next to it.
    pub type_range: Option<Range<usize>>,
}

/// How a name is used at one place, as flags that can be combined.
pub const CALL: u8 = 1;
pub const TYPE: u8 = 2;
pub const MEMBER: u8 = 4;

/// How the names of a file are used.
#[derive(Default)]
pub struct Uses {
    /// The flags of a name, by the byte offset at which the name starts. A
    /// name that is not in the map has no flags.
    flags: HashMap<usize, u8>,
    /// For a member, the bytes of what it belongs to: `sink` for `write` in
    /// `sink.write()`. By the byte offset at which the member's name starts.
    qualifiers: HashMap<usize, Range<usize>>,
}

impl Uses {
    pub fn flags(&self, name_start: usize) -> u8 {
        self.flags.get(&name_start).copied().unwrap_or(0)
    }

    pub fn qualifier(&self, name_start: usize) -> Option<Range<usize>> {
        self.qualifiers.get(&name_start).cloned()
    }
}

/// A parameter or a local variable.
#[derive(Debug, Clone)]
pub struct Local {
    pub name_range: Range<usize>,
    /// The bytes of the block the name is visible in.
    pub scope: Range<usize>,
    /// The bytes of the type the code gives the name, where it gives one.
    pub type_range: Option<Range<usize>>,
}

/// The parameters and local variables of a file.
#[derive(Default)]
pub struct Locals {
    /// In the order of the file.
    all: Vec<Local>,
    /// The indexes into `all` of the locals with each name.
    by_name: HashMap<String, Vec<usize>>,
}

/// Everything the three queries find in one file.
pub struct Analysis {
    pub defs: Vec<Def>,
    pub uses: Uses,
    pub locals: Locals,
    /// The bytes and the name of everything that contains other definitions,
    /// smallest first.
    containers: Vec<(Range<usize>, String)>,
    /// What each class or similar derives from, as pairs of its name and the
    /// name of one thing it derives from. A class with two base classes has
    /// two pairs.
    pub bases: Vec<(String, String)>,
}

impl Analysis {
    /// The definition whose name starts at the byte `name_start`, if that
    /// place defines something.
    pub fn def_at(&self, name_start: usize) -> Option<&Def> {
        self.defs
            .iter()
            .find(|def| def.name_range.start == name_start)
    }

    /// The name of the innermost class, namespace or similar that contains
    /// the byte at `offset`.
    pub fn container_at(&self, offset: usize) -> Option<&str> {
        self.containers
            .iter()
            .find(|(range, _)| range.contains(&offset))
            .map(|(_, name)| name.as_str())
    }

    /// The name of the class or similar whose members the code at `offset`
    /// belongs with.
    ///
    /// Inside a function that is not nested in another, this is the
    /// container of that function. That covers a method whose body is
    /// written outside its class, as `void Meter::add(int amount) { ... }`
    /// in C++. Anywhere else it is what [`Analysis::container_at`] returns.
    pub fn owner_around(&self, offset: usize) -> Option<&str> {
        let function = self
            .defs
            .iter()
            .filter(|def| {
                matches!(def.kind, Kind::Function | Kind::Method)
                    && !def.nested
                    && def.range.contains(&offset)
            })
            .min_by_key(|def| def.range.len());
        match function {
            Some(def) => def.container.as_deref(),
            None => self.container_at(offset),
        }
    }
}

/// What [`Syntax::definitions`] finds in a file.
pub struct Defined {
    /// The definitions, in the order of the file.
    pub defs: Vec<Def>,
    /// See `Analysis::containers`.
    containers: Vec<(Range<usize>, String)>,
    /// See `Analysis::bases`.
    pub bases: Vec<(String, String)>,
}

/// A parsed file.
pub struct Syntax {
    pub text: String,
    tree: Tree,
    pub grammar: &'static Grammar,
    /// For a file of markup with `<script>` tags, the bytes between each pair
    /// of tags, which are the only parts that were parsed. Empty for a file
    /// that was parsed as a whole.
    blocks: Vec<Range<usize>>,
}

/// The bytes between each `<script ...>` and `</script>` of a text.
fn script_blocks(text: &str) -> Vec<Range<usize>> {
    static SCRIPT: OnceLock<Regex> = OnceLock::new();
    SCRIPT
        .get_or_init(|| {
            Regex::new(r"(?is)<script\b[^>]*>(.*?)</script\s*>")
                .expect("the pattern is valid")
        })
        .captures_iter(text)
        .filter_map(|found| found.get(1))
        .filter(|code| !code.is_empty())
        .map(|code| code.range())
        .collect()
}

/// Parses `text` as a file of `grammar`. Returns `None` when the parser gives
/// up, and for a file of markup that holds no `<script>` block.
pub fn parse(grammar: &'static Grammar, text: String) -> Option<Syntax> {
    let mut parser = Parser::new();
    parser.set_language(&grammar.compiled().language).ok()?;
    let mut blocks = Vec::new();
    if grammar.script_blocks {
        blocks = script_blocks(&text);
        if blocks.is_empty() {
            return None;
        }
        let lines = Lines::new(&text);
        let point = |offset: usize| {
            let row = lines.row_of(offset);
            Point::new(row, offset - lines.start_of(row))
        };
        let ranges: Vec<TreeRange> = blocks
            .iter()
            .map(|block| TreeRange {
                start_byte: block.start,
                end_byte: block.end,
                start_point: point(block.start),
                end_point: point(block.end),
            })
            .collect();
        parser.set_included_ranges(&ranges).ok()?;
    }
    let began = Instant::now();
    let mut watch = |_: &ParseState| {
        if began.elapsed() > PARSE_LIMIT {
            ControlFlow::Break(())
        } else {
            ControlFlow::Continue(())
        }
    };
    let bytes = text.as_bytes();
    let tree = parser.parse_with_options(
        &mut |offset, _| &bytes[offset.min(bytes.len())..],
        None,
        Some(ParseOptions::new().progress_callback(&mut watch)),
    )?;
    Some(Syntax {
        text,
        tree,
        grammar,
        blocks,
    })
}

/// True for a syntax node that is a name: a leaf whose kind is some sort of
/// identifier.
fn is_name(node: Node) -> bool {
    let kind = node.kind();
    node.is_named()
        && node.child_count() == 0
        && (kind.ends_with("identifier")
            || kind.ends_with("identifier_pattern"))
}

/// What one walk over the part of a file outside function bodies finds.
/// The definitions query needs both to place a definition, and asking each
/// syntax node for its parents instead is slow in a file with thousands of
/// definitions.
#[derive(Default)]
struct Outline {
    /// The bytes of every block that local names belong to and that is not
    /// inside another such block, in the order of the file. In practice
    /// these are the functions that are not inside a function.
    scopes: Vec<Range<usize>>,
    /// For C and C++: the function each function heading belongs to, by the
    /// byte offset at which the heading starts. A heading is the part that
    /// holds the name and the parameters. The entry holds the bytes of the
    /// whole function, and whether it is a prototype without a body.
    functions: HashMap<usize, (Range<usize>, bool)>,
}

impl Outline {
    /// True when the bytes `range` lie inside a function body, and are not
    /// the whole of that function.
    fn is_nested(&self, range: &Range<usize>) -> bool {
        let after = self.scopes.partition_point(|s| s.start <= range.start);
        after > 0 && {
            let scope = &self.scopes[after - 1];
            range.end <= scope.end && scope != range
        }
    }
}

/// For C and C++. `node` is a function definition or a declaration. Adds to
/// `functions` each function heading it holds directly, which is one for a
/// function, and none for a declaration of something else.
fn note_function_headings(
    node: Node,
    functions: &mut HashMap<usize, (Range<usize>, bool)>,
) {
    let prototype = node.kind() != "function_definition";
    let mut cursor = node.walk();
    for declarator in node.children_by_field_name("declarator", &mut cursor) {
        // The heading can be wrapped, for a function that returns a pointer
        // or a reference.
        let mut inner = Some(declarator);
        while let Some(at) = inner {
            match at.kind() {
                "function_declarator" => {
                    functions.insert(
                        at.start_byte(),
                        (node.byte_range(), prototype),
                    );
                    break;
                }
                "pointer_declarator"
                | "reference_declarator"
                | "parenthesized_declarator"
                | "attributed_declarator"
                | "init_declarator" => {
                    inner =
                        at.child_by_field_name("declarator").or_else(|| {
                            let last = at.named_child_count().saturating_sub(1);
                            at.named_child(last as u32)
                        });
                }
                _ => break,
            }
        }
    }
}

/// The type written for a field, a variable or a constant, when the parser
/// gives the definition `node` a part called `type`, as it does in every
/// parsed language. For a function that part is the type it returns, which
/// is not the type of the name, so other kinds have none.
///
/// A query can name the type with the capture `@name.type` instead, for a
/// type that is not written as such, as `Meter` in `const m = new Meter()`.
fn written_type(node: Node<'_>, kind: Kind) -> Option<Node<'_>> {
    matches!(kind, Kind::Field | Kind::Variable | Kind::Constant)
        .then(|| node.child_by_field_name("type"))
        .flatten()
}

impl Syntax {
    pub fn text_of(&self, node: Node) -> &str {
        &self.text[node.byte_range()]
    }

    /// True when the byte at `offset` is in a part of the file that was
    /// parsed. Only a file of markup has parts that were not.
    pub fn covers(&self, offset: usize) -> bool {
        self.blocks.is_empty()
            || self
                .blocks
                .iter()
                .any(|block| block.contains(&offset) || block.end == offset)
    }

    /// The name at the byte `offset`, or directly before it. Returns `None`
    /// when that place is not a name: a keyword, a number, a comment, text in
    /// quotes or punctuation.
    pub fn name_at(&self, offset: usize) -> Option<Node<'_>> {
        if !self.covers(offset) {
            return None;
        }
        let root = self.tree.root_node();
        let at = |offset: usize| {
            root.descendant_for_byte_range(offset, offset)
                .filter(|node| is_name(*node))
        };
        at(offset).or_else(|| offset.checked_sub(1).and_then(at))
    }

    /// The name that covers exactly the bytes `range`, if those bytes are a
    /// name.
    pub fn name_covering(&self, range: Range<usize>) -> Option<Node<'_>> {
        self.name_at(range.start)
            .filter(|node| node.byte_range() == range)
    }

    /// The blocks around `node` that local names can belong to, innermost
    /// first, as byte ranges.
    fn scopes_around(&self, node: Node) -> Vec<Range<usize>> {
        let mut scopes = Vec::new();
        let mut at = node.parent();
        while let Some(parent) = at {
            if self.grammar.scopes.contains(&parent.kind()) {
                scopes.push(parent.byte_range());
            }
            at = parent.parent();
        }
        scopes
    }

    /// Walks the file from its top and stops at every function body. See
    /// [`Outline`].
    fn outline(&self) -> Outline {
        let scopes = &self.grammar.compiled().scope_ids;
        let mut outline = Outline::default();
        let mut cursor = self.tree.walk();
        loop {
            let node = cursor.node();
            let is_scope = scopes.contains(&node.kind_id());
            if is_scope {
                outline.scopes.push(node.byte_range());
            }
            if self.grammar.prototypes
                && matches!(
                    node.kind(),
                    "function_definition" | "declaration" | "field_declaration"
                )
            {
                note_function_headings(node, &mut outline.functions);
            }
            if !is_scope && cursor.goto_first_child() {
                continue;
            }
            while !cursor.goto_next_sibling() {
                if !cursor.goto_parent() {
                    return outline;
                }
            }
        }
    }

    /// Runs the three queries of the file's language over the file.
    pub fn analyse(&self) -> Analysis {
        let defined = self.definitions();
        Analysis {
            defs: defined.defs,
            uses: self.uses(),
            locals: self.locals(),
            containers: defined.containers,
            bases: defined.bases,
        }
    }

    /// What the file defines, what contains other definitions, and what
    /// derives from what.
    ///
    /// Two patterns can match the same name, for example a Go struct, which
    /// is matched as a struct and as a type. The pattern that comes first in
    /// the query file is used. If only the other pattern captures the type
    /// of the name, that type is kept with the definition.
    pub fn definitions(&self) -> Defined {
        let query = &self.grammar.compiled().definitions;
        let names = query.capture_names();
        let mut cursor = QueryCursor::new();
        let mut matches =
            cursor.matches(query, self.tree.root_node(), self.text.as_bytes());
        let outline = self.outline();
        // The definition found for each name, by the byte offset at which the
        // name starts, with the index of the pattern that found it.
        let mut found: HashMap<usize, (usize, Def)> = HashMap::new();
        let mut containers: Vec<(Range<usize>, String)> = Vec::new();
        let mut bases: Vec<(String, String)> = Vec::new();
        while let Some(matched) = matches.next() {
            let mut name = None;
            let mut parent = None;
            let mut whole = None;
            let mut container = None;
            let mut base = None;
            let mut of_type = None;
            for capture in matched.captures() {
                match names[capture.index as usize] {
                    "name" => name = Some(capture.node),
                    "parent" => parent = Some(capture.node),
                    "container" => container = Some(capture.node),
                    "base" => base = Some(capture.node),
                    "name.type" => of_type = Some(capture.node),
                    other => {
                        let (declaration, kind) = match other.split_once('.') {
                            Some(("definition", kind)) => (false, kind),
                            Some(("declaration", kind)) => (true, kind),
                            _ => continue,
                        };
                        if let Some(kind) = Kind::named(kind) {
                            whole = Some((capture.node, kind, declaration));
                        }
                    }
                }
            }
            let Some(name) = name else { continue };
            if let Some(base) = base {
                let derived = simple_name(self.text_of(name));
                let base = simple_name(self.text_of(base));
                if !derived.is_empty() && !base.is_empty() && derived != base {
                    bases.push((derived.to_string(), base.to_string()));
                }
                continue;
            }
            if let Some(container) = container {
                containers.push((
                    container.byte_range(),
                    simple_name(self.text_of(name)).to_string(),
                ));
                continue;
            }
            let Some((node, kind, mut declaration)) = whole else {
                continue;
            };
            let mut range = node.byte_range();
            let mut nested = kind != Kind::Field && outline.is_nested(&range);
            if self.grammar.prototypes
                && matches!(kind, Kind::Function | Kind::Method)
            {
                // `node` is the heading of a function. The definition is
                // the whole function. A heading that the outline does not
                // know is inside a function body, where it is most often a
                // variable built with arguments, as in `FileSink sink(path);`.
                match outline.functions.get(&node.start_byte()) {
                    Some((function, prototype)) => {
                        range = function.clone();
                        declaration = *prototype;
                        nested = outline.is_nested(&range);
                    }
                    None => {
                        declaration = true;
                        nested = true;
                    }
                }
            }
            let def = Def {
                name: self.text_of(name).to_string(),
                kind,
                declaration,
                container: parent
                    .map(|parent| simple_name(self.text_of(parent)))
                    .filter(|parent| !parent.is_empty())
                    .map(str::to_string),
                name_range: name.byte_range(),
                range,
                // A field is never nested: one that is first assigned inside
                // a method, as `self.total = 0` in Python, belongs to the
                // class and not to the method.
                nested,
                type_range: of_type
                    .or_else(|| written_type(node, kind))
                    .map(|node| node.byte_range()),
            };
            match found.get_mut(&def.name_range.start) {
                None => {
                    found.insert(
                        def.name_range.start,
                        (matched.pattern_index, def),
                    );
                }
                Some((pattern, known)) => {
                    if matched.pattern_index < *pattern {
                        let other = std::mem::replace(known, def);
                        *pattern = matched.pattern_index;
                        known.type_range =
                            known.type_range.take().or(other.type_range);
                    } else if known.type_range.is_none() {
                        known.type_range = def.type_range;
                    }
                }
            }
        }
        let mut defs: Vec<Def> =
            found.into_values().map(|(_, def)| def).collect();
        defs.sort_by_key(|def| (def.range.start, def.name_range.start));
        self.place_in_containers(&mut defs, &mut containers);
        // A field that is assigned in several places is one field. A field
        // of something without a name, such as a type written in place as
        // `{ label: string }`, is left out, because nothing can name it.
        let mut fields = std::collections::HashSet::new();
        defs.retain(|def| {
            def.kind != Kind::Field
                || (def.container.is_some()
                    && fields.insert((def.name.clone(), def.container.clone())))
        });
        bases.sort();
        bases.dedup();
        Defined {
            defs,
            containers,
            bases,
        }
    }

    /// Gives each definition the container it is written inside, unless the
    /// code named its container next to it. A function inside a class or a
    /// similar definition becomes a method. Adds every definition that
    /// contains others to `containers`, and sorts `containers` smallest
    /// first.
    fn place_in_containers(
        &self,
        defs: &mut [Def],
        containers: &mut Vec<(Range<usize>, String)>,
    ) {
        // Whether the definitions in each container are its members.
        let mut with_members: HashMap<(usize, usize), bool> = containers
            .iter()
            .map(|(range, _)| ((range.start, range.end), true))
            .collect();
        for def in defs.iter().filter(|def| def.kind.contains_others()) {
            with_members.insert(
                (def.range.start, def.range.end),
                def.kind.has_members(),
            );
            containers.push((def.range.clone(), def.name.clone()));
        }
        containers.sort_by_key(|(range, _)| range.end - range.start);
        // A definition inside a function body is not given a container: it
        // belongs to the function, which is not something other code names.
        for def in defs.iter_mut().filter(|def| !def.nested) {
            let around = containers.iter().find(|(range, _)| {
                range.start <= def.range.start
                    && def.range.end <= range.end
                    && *range != def.range
            });
            let Some((range, name)) = around else {
                continue;
            };
            if def.container.is_none() {
                def.container = Some(name.clone());
            }
            if def.kind == Kind::Function
                && with_members[&(range.start, range.end)]
            {
                def.kind = Kind::Method;
            }
        }
    }

    fn uses(&self) -> Uses {
        let query = &self.grammar.compiled().uses;
        let names = query.capture_names();
        let mut cursor = QueryCursor::new();
        let mut matches =
            cursor.matches(query, self.tree.root_node(), self.text.as_bytes());
        let mut uses = Uses::default();
        while let Some(matched) = matches.next() {
            let mut member = None;
            let mut qualifier = None;
            for capture in matched.captures() {
                let flag = match names[capture.index as usize] {
                    "call" => CALL,
                    "type" => TYPE,
                    "member" => {
                        member = Some(capture.node);
                        MEMBER
                    }
                    "qualifier" => {
                        qualifier = Some(capture.node);
                        continue;
                    }
                    _ => continue,
                };
                *uses.flags.entry(capture.node.start_byte()).or_default() |=
                    flag;
            }
            if let (Some(member), Some(qualifier)) = (member, qualifier) {
                uses.qualifiers
                    .insert(member.start_byte(), qualifier.byte_range());
            }
        }
        uses
    }

    fn locals(&self) -> Locals {
        let query = &self.grammar.compiled().locals;
        let names = query.capture_names();
        let mut cursor = QueryCursor::new();
        let mut matches =
            cursor.matches(query, self.tree.root_node(), self.text.as_bytes());
        let mut found: HashMap<usize, Local> = HashMap::new();
        while let Some(matched) = matches.next() {
            let mut name = None;
            let mut outer = false;
            let mut type_range = None;
            for capture in matched.captures() {
                match names[capture.index as usize] {
                    "local" => name = Some(capture.node),
                    "local.outer" => {
                        name = Some(capture.node);
                        outer = true;
                    }
                    "local.type" => {
                        type_range = Some(capture.node.byte_range())
                    }
                    _ => {}
                }
            }
            let Some(name) = name else { continue };
            // A name with no block around it is defined for the whole file,
            // which makes it a definition of the file and not a local.
            let Some(scope) =
                self.scopes_around(name).into_iter().nth(usize::from(outer))
            else {
                continue;
            };
            let local = Local {
                name_range: name.byte_range(),
                scope,
                type_range,
            };
            // Two patterns can match one name. The one that knows the type
            // is kept.
            match found.get(&local.name_range.start) {
                Some(known) if known.type_range.is_some() => {}
                _ => {
                    found.insert(local.name_range.start, local);
                }
            }
        }
        let mut all: Vec<Local> = found.into_values().collect();
        all.sort_by_key(|local| local.name_range.start);
        let mut by_name: HashMap<String, Vec<usize>> = HashMap::new();
        for (index, local) in all.iter().enumerate() {
            by_name
                .entry(self.text[local.name_range.clone()].to_string())
                .or_default()
                .push(index);
        }
        Locals { all, by_name }
    }

    /// The parameter or local variable that the name `node` refers to, or
    /// `None` when the name is not local to a function.
    ///
    /// The blocks around the name are tried from the innermost outwards. The
    /// first block that defines the name before the place of `node` is used.
    /// If no block does, the first block that defines the name anywhere is
    /// used, because some languages allow a name to be used above the line
    /// that defines it. When a block defines the name more than once, as Go
    /// does with `err :=` on several lines, the first of them is returned, so
    /// that all uses of the name lead to one place.
    pub fn local_of<'a>(
        &self,
        analysis: &'a Analysis,
        node: Node,
    ) -> Option<&'a Local> {
        const LOCAL_KINDS: [&str; 4] = [
            "identifier",
            "shorthand_property_identifier",
            "shorthand_property_identifier_pattern",
            "shorthand_field_identifier",
        ];
        // C++ cannot tell `Gauge gauge(meter);` from the prototype of a
        // function, and the parser reads `meter` there as the name of a
        // type. So in C and C++ a name in the place of a type may be a
        // local too.
        let may_be_local = LOCAL_KINDS.contains(&node.kind())
            || (self.grammar.prototypes && node.kind() == "type_identifier");
        if !may_be_local || analysis.uses.flags(node.start_byte()) & MEMBER != 0
        {
            return None;
        }
        let candidates = analysis.locals.by_name.get(self.text_of(node))?;
        let scopes = self.scopes_around(node);
        for must_come_first in [true, false] {
            for scope in &scopes {
                let first = candidates
                    .iter()
                    .map(|index| &analysis.locals.all[*index])
                    .find(|local| local.scope == *scope);
                if let Some(local) = first {
                    if !must_come_first
                        || local.name_range.start <= node.start_byte()
                    {
                        return Some(local);
                    }
                }
            }
        }
        None
    }

    /// What the name `node` is at its place in the file.
    pub fn role_of(&self, analysis: &Analysis, node: Node) -> Role {
        let start = node.start_byte();
        if let Some(def) = analysis.def_at(start) {
            return if def.declaration {
                Role::Declaration
            } else {
                Role::Definition
            };
        }
        if analysis
            .locals
            .all
            .binary_search_by_key(&start, |local| local.name_range.start)
            .is_ok()
        {
            return Role::Definition;
        }
        let flags = analysis.uses.flags(start);
        if flags & CALL != 0 {
            Role::Call
        } else if flags & TYPE != 0 {
            Role::Type
        } else {
            Role::Use
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::grammar::grammar_of;

    fn parsed(path: &str, text: &str) -> Syntax {
        parse(grammar_of(path).unwrap(), text.to_string()).unwrap()
    }

    /// The definitions of a text as `kind name` or `kind container.name`,
    /// with `(prototype)` after one that has no body and `(nested)` after
    /// one inside a function.
    fn listed(path: &str, text: &str) -> Vec<String> {
        parsed(path, text)
            .definitions()
            .defs
            .iter()
            .map(|def| {
                format!(
                    "{:?} {}{}{}{}",
                    def.kind,
                    def.container
                        .as_ref()
                        .map(|c| format!("{c}."))
                        .unwrap_or_default(),
                    def.name,
                    if def.declaration { " (prototype)" } else { "" },
                    if def.nested { " (nested)" } else { "" },
                )
            })
            .collect()
    }

    #[test]
    fn go_definitions_have_their_kind_and_container() {
        let found = listed(
            "a.go",
            "package a\n\nconst limit = 3\n\nvar ErrFull = \
             errors.New(\"full\")\n\ntype Queue struct {\n\titems \
             []string\n}\n\ntype Sink interface {\n\tWrite(line string) \
             error\n}\n\nfunc (q *Queue) Push(item string) {\n\tcount := \
             len(q.items)\n\t_ = count\n}\n\nfunc New() *Queue { return \
             &Queue{} }\n",
        );
        assert_eq!(
            found,
            vec![
                "Constant limit",
                "Variable ErrFull",
                "Struct Queue",
                "Field Queue.items",
                "Interface Sink",
                "Method Sink.Write",
                "Method Queue.Push",
                "Function New",
            ]
        );
    }

    #[test]
    fn cpp_tells_a_prototype_from_a_definition() {
        let header = listed(
            "Meter.h",
            "#pragma once\nnamespace gauge {\nenum class Unit { Litre, \
             Gallon };\nclass Meter {\npublic:\n    explicit Meter(int \
             start);\n    void add(int amount);\n    int total() const { \
             return total_; }\nprivate:\n    int total_ = 0;\n};\nint \
             parse(const char* text);\n}\n",
        );
        assert_eq!(
            header,
            vec![
                "Namespace gauge",
                "Enum gauge.Unit",
                "Enumerator Unit.Litre",
                "Enumerator Unit.Gallon",
                "Class gauge.Meter",
                "Method Meter.Meter (prototype)",
                "Method Meter.add (prototype)",
                "Method Meter.total",
                "Field Meter.total_",
                "Function gauge.parse (prototype)",
            ]
        );
        let source = listed(
            "Meter.cpp",
            "#include \"Meter.h\"\nnamespace gauge {\nconstexpr int kStep = \
             2;\nvoid Meter::add(int amount) {\n    Meter copy(amount);\n    \
             int twice = amount * kStep;\n    total_ += twice;\n}\nint \
             parse(const char* text) { return 0; }\n}\n",
        );
        assert_eq!(
            source,
            vec![
                "Namespace gauge",
                "Constant gauge.kStep",
                "Method Meter.add",
                "Function copy (prototype) (nested)",
                "Variable twice (nested)",
                "Function gauge.parse",
            ]
        );
    }

    #[test]
    fn python_fields_come_from_the_class_body_and_from_self() {
        let found = listed(
            "meter.py",
            "LIMIT = 3\nstate = {}\n\nclass Meter:\n    unit = \
             \"litre\"\n\n    def __init__(self, start):\n        self.total \
             = start\n        self.total = start + 1\n\n    def add(self, \
             amount):\n        def clamp(v):\n            return v\n        \
             self.total += clamp(amount)\n\ndef make():\n    return \
             Meter(0)\n",
        );
        assert_eq!(
            found,
            vec![
                "Constant LIMIT",
                "Variable state",
                "Class Meter",
                "Field Meter.unit",
                "Method Meter.__init__",
                "Field Meter.total",
                "Method Meter.add",
                "Function clamp (nested)",
                "Function make",
            ]
        );
    }

    #[test]
    fn typescript_and_rust_definitions() {
        let ts = listed(
            "meter.ts",
            "export interface Reading { value: number }\nexport type Unit = \
             'l' | 'g';\nexport enum Mode { Fast, Slow = 2 }\nexport const \
             round = (n: number) => Math.round(n);\nexport class Meter \
             {\n  private total = 0;\n  add(amount: number): void {\n    \
             const next = this.total + amount;\n    this.total = next;\n  \
             }\n}\nexport function make(): Meter { return new Meter(); }\n",
        );
        assert_eq!(
            ts,
            vec![
                "Interface Reading",
                "Field Reading.value",
                "Type Unit",
                "Enum Mode",
                "Enumerator Mode.Fast",
                "Enumerator Mode.Slow",
                "Function round",
                "Class Meter",
                "Field Meter.total",
                "Method Meter.add",
                "Variable next (nested)",
                "Function make",
            ]
        );
        let rust = listed(
            "meter.rs",
            "pub const STEP: u32 = 2;\npub struct Meter { total: u32 \
             }\npub enum Unit { Litre, Gallon }\npub trait Sink { fn \
             write(&self); }\nimpl Meter {\n    pub fn add(&mut self, \
             amount: u32) {\n        let twice = amount * STEP;\n        \
             self.total += twice;\n    }\n}\nfn make() -> Meter { Meter { \
             total: 0 } }\nmod tests { fn helper() {} }\n",
        );
        assert_eq!(
            rust,
            vec![
                "Constant STEP",
                "Struct Meter",
                "Field Meter.total",
                "Enum Unit",
                "Enumerator Unit.Litre",
                "Enumerator Unit.Gallon",
                "Trait Sink",
                "Method Sink.write",
                "Method Meter.add",
                "Function make",
                "Module tests",
                "Function tests.helper",
            ]
        );
    }

    #[test]
    fn java_definitions() {
        let found = listed(
            "Meter.java",
            "package gauge;\npublic class Meter {\n    private int \
             total;\n    public Meter(int start) { this.total = start; \
             }\n    public void add(int amount) { int twice = amount * 2; \
             total += twice; }\n    enum Unit { LITRE, GALLON }\n}\n",
        );
        assert_eq!(
            found,
            vec![
                "Class Meter",
                "Field Meter.total",
                "Method Meter.Meter",
                "Method Meter.add",
                "Enum Meter.Unit",
                "Enumerator Unit.LITRE",
                "Enumerator Unit.GALLON",
            ]
        );
    }

    /// The local a name at `needle`'s `nth` occurrence refers to, as the
    /// text of the line that defines it.
    fn local_line(syntax: &Syntax, needle: &str, nth: usize) -> Option<String> {
        let analysis = syntax.analyse();
        let at = syntax.text.match_indices(needle).nth(nth).unwrap().0;
        let node = syntax.name_at(at)?;
        let local = syntax.local_of(&analysis, node)?;
        let lines = Lines::new(&syntax.text);
        Some(
            lines
                .line(lines.row_of(local.name_range.start))
                .trim()
                .to_string(),
        )
    }

    #[test]
    fn a_local_name_resolves_to_the_block_that_defines_it() {
        let go = parsed(
            "a.go",
            "package a\n\nfunc run(items []string) int {\n\ttotal := \
             0\n\tfor _, item := range items {\n\t\ttotal := \
             len(item)\n\t\t_ = total\n\t}\n\treturn total\n}\n",
        );
        // The use inside the loop refers to the loop's own `total`, and the
        // one after the loop to the function's.
        assert_eq!(
            local_line(&go, "total", 2).as_deref(),
            Some("total := len(item)")
        );
        assert_eq!(local_line(&go, "total", 3).as_deref(), Some("total := 0"));
        assert_eq!(
            local_line(&go, "item)", 0).as_deref(),
            Some("for _, item := range items {")
        );
        // A name that is not local has no answer here.
        assert_eq!(local_line(&go, "len", 0), None);

        let python = parsed(
            "a.py",
            "def run(items):\n    total = 0\n    for item in items:\n        \
             total += item.size\n    return [size for size in items if \
             size]\n",
        );
        assert_eq!(
            local_line(&python, "total", 1).as_deref(),
            Some("total = 0")
        );
        // `size` after the dot is a member and never the local `size`.
        assert_eq!(local_line(&python, "size", 0), None);
        assert!(local_line(&python, "size", 3).is_some());
    }

    #[test]
    fn a_local_knows_the_type_the_code_gives_it() {
        let cpp = parsed(
            "a.cpp",
            "void run(const Meter& meter, Sink* sink) {\n    Gauge \
             gauge(meter);\n    gauge.read();\n}\n",
        );
        let analysis = cpp.analyse();
        let type_of = |needle: &str| {
            let at = cpp.text.rfind(needle).unwrap();
            let local = cpp.local_of(&analysis, cpp.name_at(at)?)?;
            Some(simple_name(&cpp.text[local.type_range.clone()?]).to_string())
        };
        assert_eq!(type_of("gauge.read").as_deref(), Some("Gauge"));
        assert_eq!(type_of("meter)").as_deref(), Some("Meter"));
    }

    #[test]
    fn only_the_script_of_a_svelte_file_is_parsed() {
        let svelte = parsed(
            "Row.svelte",
            "<script lang=\"ts\">\n  let { label }: { label: string } = \
             $props();\n  function pick() { return label; }\n</script>\n\n<\
             button onclick={pick}>{label}</button>\n",
        );
        let names: Vec<String> = svelte
            .definitions()
            .defs
            .iter()
            .map(|def| def.name.clone())
            .collect();
        assert_eq!(names, vec!["label", "pick"]);
        let in_script = svelte.text.find("pick()").unwrap();
        let in_markup = svelte.text.find("{pick}").unwrap() + 1;
        assert!(svelte.name_at(in_script).is_some());
        assert!(svelte.name_at(in_markup).is_none());
    }

    #[test]
    fn a_comment_or_a_string_holds_no_name() {
        let go = parsed(
            "a.go",
            "package a\n\n// run starts it.\nfunc run() { print(\"run\") }\n",
        );
        let comment = go.text.find("run starts").unwrap();
        let string = go.text.find("\"run\"").unwrap() + 1;
        let name = go.text.find("run()").unwrap();
        assert!(go.name_at(comment).is_none());
        assert!(go.name_at(string).is_none());
        assert_eq!(go.text_of(go.name_at(name).unwrap()), "run");
    }
}
