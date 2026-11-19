//! The languages navigation can parse, and which language a file is in.
//!
//! A language with a [`Grammar`] is read with its tree-sitter parser and the
//! queries in `resources/nav/`. Every other code file is handled as plain
//! text by `plain.rs`. Adding a language means adding a parser crate, a row to
//! [`GRAMMARS`] and its query files.

use std::sync::OnceLock;
use tree_sitter::{Language, Query};

/// Reads one query file from `resources/nav/` into the program.
macro_rules! query_file {
    ($path:literal) => {
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../resources/nav/",
            $path
        ))
    };
}

/// One language that is parsed.
pub struct Grammar {
    pub id: &'static str,
    /// Languages of the same family can call each other's code, so a name in
    /// one is looked for in all of them: C with C++, and JavaScript with
    /// TypeScript.
    pub family: &'static str,
    extensions: &'static [&'static str],
    language: fn() -> Language,
    /// The query files of each kind. A language can share files with another:
    /// TypeScript reads the files of `ecma/` and then its own.
    definitions: &'static [&'static str],
    uses: &'static [&'static str],
    locals: &'static [&'static str],
    /// The kinds of syntax node that are a block for local names: a function
    /// or something inside one. A parameter or a local variable is visible
    /// in the innermost of these that contains it.
    pub scopes: &'static [&'static str],
    /// True for C and C++, where a function can be announced by a prototype
    /// in one place and defined with its body in another.
    pub prototypes: bool,
    /// True for C++ and Java, where the code of a method can name a member
    /// of its class without `this` in front of it.
    pub bare_members: bool,
    /// True for a file of markup that holds its code between `<script>` tags.
    /// Only the code between those tags is parsed.
    pub script_blocks: bool,
    compiled: OnceLock<Compiled>,
}

/// A grammar's parser and its three queries, ready to use.
pub struct Compiled {
    pub language: Language,
    pub definitions: Query,
    pub uses: Query,
    pub locals: Query,
    /// The numbers the parser gives the kinds of node in `Grammar::scopes`.
    /// Comparing numbers is faster than comparing the names of kinds.
    pub scope_ids: Vec<u16>,
}

impl Grammar {
    /// The parser and queries of this grammar. They are built on first use.
    ///
    /// Panics when a query file does not fit the parser. The test
    /// `every_query_file_fits_its_parser` builds all of them, so that such a
    /// mistake is found when the tests run and not in the app.
    pub fn compiled(&self) -> &Compiled {
        self.compiled.get_or_init(|| {
            let language = (self.language)();
            let build = |what: &str, files: &[&str]| {
                Query::new(&language, &files.join("\n")).unwrap_or_else(
                    |error| panic!("{} {what} query: {error}", self.id),
                )
            };
            let scope_ids = (0..language.node_kind_count() as u16)
                .filter(|id| {
                    language.node_kind_is_named(*id)
                        && language
                            .node_kind_for_id(*id)
                            .is_some_and(|kind| self.scopes.contains(&kind))
                })
                .collect();
            Compiled {
                definitions: build("definitions", self.definitions),
                uses: build("uses", self.uses),
                locals: build("locals", self.locals),
                scope_ids,
                language,
            }
        })
    }
}

fn c() -> Language {
    tree_sitter_c::LANGUAGE.into()
}
fn cpp() -> Language {
    tree_sitter_cpp::LANGUAGE.into()
}
fn go() -> Language {
    tree_sitter_go::LANGUAGE.into()
}
fn java() -> Language {
    tree_sitter_java::LANGUAGE.into()
}
fn javascript() -> Language {
    tree_sitter_javascript::LANGUAGE.into()
}
fn python() -> Language {
    tree_sitter_python::LANGUAGE.into()
}
fn rust() -> Language {
    tree_sitter_rust::LANGUAGE.into()
}
fn typescript() -> Language {
    tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into()
}
fn tsx() -> Language {
    tree_sitter_typescript::LANGUAGE_TSX.into()
}

const C_SCOPES: &[&str] = &[
    "function_definition",
    "compound_statement",
    "for_statement",
    "if_statement",
    "while_statement",
    "switch_statement",
];
const CPP_SCOPES: &[&str] = &[
    "function_definition",
    "compound_statement",
    "for_statement",
    "for_range_loop",
    "if_statement",
    "while_statement",
    "switch_statement",
    "lambda_expression",
    "catch_clause",
];
const ECMA_SCOPES: &[&str] = &[
    "function_declaration",
    "generator_function_declaration",
    "function_expression",
    "generator_function",
    "arrow_function",
    "method_definition",
    "statement_block",
    "for_statement",
    "for_in_statement",
    "catch_clause",
    "class_static_block",
];

const TS_DEFINITIONS: &[&str] = &[
    query_file!("ecma/definitions.scm"),
    query_file!("typescript/definitions.scm"),
];
const TS_LOCALS: &[&str] = &[
    query_file!("ecma/locals.scm"),
    query_file!("typescript/locals.scm"),
];

/// Every parsed language. A file's language is the first row that lists its
/// extension.
static GRAMMARS: [Grammar; 11] = [
    Grammar {
        id: "c",
        family: "c",
        extensions: &["c"],
        language: c,
        definitions: &[query_file!("c/definitions.scm")],
        uses: &[query_file!("c/uses.scm")],
        locals: &[query_file!("c/locals.scm")],
        scopes: C_SCOPES,
        prototypes: true,
        bare_members: false,
        script_blocks: false,
        compiled: OnceLock::new(),
    },
    // A `.h` file is read as C++, which also reads C.
    Grammar {
        id: "cpp",
        family: "c",
        extensions: &["cc", "cpp", "cxx", "h", "hh", "hpp", "hxx"],
        language: cpp,
        definitions: &[
            query_file!("cpp/definitions.scm"),
            query_file!("c/definitions.scm"),
        ],
        uses: &[query_file!("c/uses.scm"), query_file!("cpp/uses.scm")],
        locals: &[query_file!("c/locals.scm"), query_file!("cpp/locals.scm")],
        scopes: CPP_SCOPES,
        prototypes: true,
        bare_members: true,
        script_blocks: false,
        compiled: OnceLock::new(),
    },
    Grammar {
        id: "go",
        family: "go",
        extensions: &["go"],
        language: go,
        definitions: &[query_file!("go/definitions.scm")],
        uses: &[query_file!("go/uses.scm")],
        locals: &[query_file!("go/locals.scm")],
        scopes: &[
            "function_declaration",
            "method_declaration",
            "func_literal",
            "block",
            "if_statement",
            "for_statement",
            "expression_switch_statement",
            "type_switch_statement",
            "select_statement",
            "expression_case",
            "type_case",
            "default_case",
            "communication_case",
        ],
        prototypes: false,
        bare_members: false,
        script_blocks: false,
        compiled: OnceLock::new(),
    },
    Grammar {
        id: "java",
        family: "java",
        extensions: &["java"],
        language: java,
        definitions: &[query_file!("java/definitions.scm")],
        uses: &[query_file!("java/uses.scm")],
        locals: &[query_file!("java/locals.scm")],
        scopes: &[
            "method_declaration",
            "constructor_declaration",
            "compact_constructor_declaration",
            "lambda_expression",
            "block",
            "for_statement",
            "enhanced_for_statement",
            "catch_clause",
            "try_with_resources_statement",
        ],
        prototypes: false,
        bare_members: true,
        script_blocks: false,
        compiled: OnceLock::new(),
    },
    Grammar {
        id: "javascript",
        family: "js",
        extensions: &["js", "mjs", "cjs", "jsx"],
        language: javascript,
        definitions: &[
            query_file!("ecma/definitions.scm"),
            query_file!("javascript/definitions.scm"),
        ],
        uses: &[query_file!("ecma/uses.scm"), query_file!("jsx/uses.scm")],
        locals: &[
            query_file!("ecma/locals.scm"),
            query_file!("javascript/locals.scm"),
        ],
        scopes: ECMA_SCOPES,
        prototypes: false,
        bare_members: false,
        script_blocks: false,
        compiled: OnceLock::new(),
    },
    Grammar {
        id: "python",
        family: "python",
        extensions: &["py", "pyi"],
        language: python,
        definitions: &[query_file!("python/definitions.scm")],
        uses: &[query_file!("python/uses.scm")],
        locals: &[query_file!("python/locals.scm")],
        scopes: &[
            "function_definition",
            "lambda",
            "list_comprehension",
            "set_comprehension",
            "dictionary_comprehension",
            "generator_expression",
        ],
        prototypes: false,
        bare_members: false,
        script_blocks: false,
        compiled: OnceLock::new(),
    },
    Grammar {
        id: "rust",
        family: "rust",
        extensions: &["rs"],
        language: rust,
        definitions: &[query_file!("rust/definitions.scm")],
        uses: &[query_file!("rust/uses.scm")],
        locals: &[query_file!("rust/locals.scm")],
        scopes: &[
            "function_item",
            "closure_expression",
            "block",
            "for_expression",
            "while_expression",
            "if_expression",
            "match_arm",
        ],
        prototypes: false,
        bare_members: false,
        script_blocks: false,
        compiled: OnceLock::new(),
    },
    Grammar {
        id: "typescript",
        family: "js",
        extensions: &["ts", "mts", "cts"],
        language: typescript,
        definitions: TS_DEFINITIONS,
        uses: &[
            query_file!("ecma/uses.scm"),
            query_file!("typescript/uses.scm"),
        ],
        locals: TS_LOCALS,
        scopes: ECMA_SCOPES,
        prototypes: false,
        bare_members: false,
        script_blocks: false,
        compiled: OnceLock::new(),
    },
    Grammar {
        id: "tsx",
        family: "js",
        extensions: &["tsx"],
        language: tsx,
        definitions: TS_DEFINITIONS,
        uses: &[
            query_file!("ecma/uses.scm"),
            query_file!("typescript/uses.scm"),
            query_file!("jsx/uses.scm"),
        ],
        locals: TS_LOCALS,
        scopes: ECMA_SCOPES,
        prototypes: false,
        bare_members: false,
        script_blocks: false,
        compiled: OnceLock::new(),
    },
    // A Svelte or Vue file holds markup with code between `<script>` tags.
    // That code is read as TypeScript, which also reads JavaScript. Names in
    // the markup are handled as plain text.
    Grammar {
        id: "svelte",
        family: "js",
        extensions: &["svelte"],
        language: typescript,
        definitions: TS_DEFINITIONS,
        uses: &[
            query_file!("ecma/uses.scm"),
            query_file!("typescript/uses.scm"),
        ],
        locals: TS_LOCALS,
        scopes: ECMA_SCOPES,
        prototypes: false,
        bare_members: false,
        script_blocks: true,
        compiled: OnceLock::new(),
    },
    Grammar {
        id: "vue",
        family: "js",
        extensions: &["vue"],
        language: typescript,
        definitions: TS_DEFINITIONS,
        uses: &[
            query_file!("ecma/uses.scm"),
            query_file!("typescript/uses.scm"),
        ],
        locals: TS_LOCALS,
        scopes: ECMA_SCOPES,
        prototypes: false,
        bare_members: false,
        script_blocks: true,
        compiled: OnceLock::new(),
    },
];

/// The extensions of code files that have no grammar here. They are indexed
/// and searched as plain text. Each is its own family, except where two
/// extensions belong to one language.
const PLAIN: &[(&str, &str)] = &[
    ("rb", "ruby"),
    ("php", "php"),
    ("cs", "csharp"),
    ("kt", "kotlin"),
    ("kts", "kotlin"),
    ("swift", "swift"),
    ("scala", "scala"),
    ("dart", "dart"),
    ("lua", "lua"),
    ("pl", "perl"),
    ("pm", "perl"),
    ("r", "r"),
    ("jl", "julia"),
    ("ex", "elixir"),
    ("exs", "elixir"),
    ("erl", "erlang"),
    ("hs", "haskell"),
    ("ml", "ocaml"),
    ("clj", "clojure"),
    ("zig", "zig"),
    ("nim", "nim"),
    ("m", "objc"),
    ("mm", "objc"),
    ("fs", "fsharp"),
    ("vb", "vb"),
    ("groovy", "groovy"),
    ("gradle", "groovy"),
    ("sh", "shell"),
    ("bash", "shell"),
    ("zsh", "shell"),
    ("ps1", "powershell"),
    ("sql", "sql"),
    ("proto", "proto"),
];

fn extension_of(path: &str) -> Option<String> {
    let name = path.rsplit('/').next().unwrap_or(path);
    name.rsplit_once('.')
        .filter(|(stem, _)| !stem.is_empty())
        .map(|(_, extension)| extension.to_ascii_lowercase())
}

/// The grammar for the file at `path`, judged by its extension, or `None`
/// when the file's language is not parsed.
pub fn grammar_of(path: &str) -> Option<&'static Grammar> {
    let extension = extension_of(path)?;
    GRAMMARS
        .iter()
        .find(|grammar| grammar.extensions.contains(&extension.as_str()))
}

/// True when the file at `path` is in a language that is parsed.
pub fn has_grammar(path: &str) -> bool {
    grammar_of(path).is_some()
}

/// The language family of the file at `path`, or `None` for a file that is
/// not code navigation knows about, such as documentation or data. A name is
/// looked for only in files of the same family as the file it was clicked in.
pub fn family_of(path: &str) -> Option<&'static str> {
    if let Some(grammar) = grammar_of(path) {
        return Some(grammar.family);
    }
    let extension = extension_of(path)?;
    PLAIN
        .iter()
        .find(|(known, _)| *known == extension)
        .map(|(_, family)| *family)
}

#[cfg(test)]
pub fn all_grammars() -> &'static [Grammar] {
    &GRAMMARS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_query_file_fits_its_parser() {
        for grammar in all_grammars() {
            grammar.compiled();
        }
    }

    #[test]
    fn a_file_is_given_its_language_by_its_extension() {
        assert_eq!(grammar_of("src/LogWriter.cpp").unwrap().id, "cpp");
        assert_eq!(grammar_of("include/LogWriter.h").unwrap().id, "cpp");
        assert_eq!(grammar_of("a/b/Main.TSX").unwrap().id, "tsx");
        assert_eq!(family_of("ui/App.svelte"), Some("js"));
        assert_eq!(family_of("lib/task.rb"), Some("ruby"));
        assert_eq!(family_of("README.md"), None);
        assert_eq!(family_of(".gitignore"), None);
        assert!(!has_grammar("lib/task.rb"));
    }
}
