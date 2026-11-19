//! Names a file's language from its name, for display only.
//!
//! This table produces the label shown next to a file and the hint the source
//! viewer uses to colour it. Nothing in this crate behaves differently per
//! language because of it. The one part of the app that reads code by its
//! language is code navigation, in the `codjiva-nav` crate, which has its own
//! table of the languages it can parse.

/// `(extension, label shown to the user, highlighter id)`. The highlighter id
/// is the language name the source viewer's highlighter understands; an empty
/// id means plain text.
const BY_EXTENSION: &[(&str, &str, &str)] = &[
    ("c", "C", "c"),
    ("h", "C/C++ header", "cpp"),
    ("cc", "C++", "cpp"),
    ("cpp", "C++", "cpp"),
    ("cxx", "C++", "cpp"),
    ("hh", "C++ header", "cpp"),
    ("hpp", "C++ header", "cpp"),
    ("hxx", "C++ header", "cpp"),
    ("m", "Objective-C", "objectivec"),
    ("mm", "Objective-C++", "objectivec"),
    ("rs", "Rust", "rust"),
    ("go", "Go", "go"),
    ("java", "Java", "java"),
    ("kt", "Kotlin", "kotlin"),
    ("kts", "Kotlin", "kotlin"),
    ("scala", "Scala", "scala"),
    ("cs", "C#", "csharp"),
    ("fs", "F#", "fsharp"),
    ("vb", "Visual Basic", "vbnet"),
    ("py", "Python", "python"),
    ("pyi", "Python", "python"),
    ("rb", "Ruby", "ruby"),
    ("php", "PHP", "php"),
    ("swift", "Swift", "swift"),
    ("js", "JavaScript", "javascript"),
    ("mjs", "JavaScript", "javascript"),
    ("cjs", "JavaScript", "javascript"),
    ("jsx", "JavaScript", "jsx"),
    ("ts", "TypeScript", "typescript"),
    ("mts", "TypeScript", "typescript"),
    ("cts", "TypeScript", "typescript"),
    ("tsx", "TypeScript", "tsx"),
    ("svelte", "Svelte", "svelte"),
    ("vue", "Vue", "vue"),
    ("dart", "Dart", "dart"),
    ("lua", "Lua", "lua"),
    ("pl", "Perl", "perl"),
    ("pm", "Perl", "perl"),
    ("r", "R", "r"),
    ("jl", "Julia", "julia"),
    ("ex", "Elixir", "elixir"),
    ("exs", "Elixir", "elixir"),
    ("erl", "Erlang", "erlang"),
    ("hs", "Haskell", "haskell"),
    ("ml", "OCaml", "ocaml"),
    ("clj", "Clojure", "clojure"),
    ("zig", "Zig", ""),
    ("nim", "Nim", "nim"),
    ("sql", "SQL", "sql"),
    ("sh", "Shell", "bash"),
    ("bash", "Shell", "bash"),
    ("zsh", "Shell", "bash"),
    ("fish", "Shell", "bash"),
    ("ps1", "PowerShell", "powershell"),
    ("bat", "Batch", "dos"),
    ("cmd", "Batch", "dos"),
    ("html", "HTML", "html"),
    ("htm", "HTML", "html"),
    ("xml", "XML", "xml"),
    ("css", "CSS", "css"),
    ("scss", "SCSS", "scss"),
    ("less", "Less", "less"),
    ("json", "JSON", "json"),
    ("jsonc", "JSON", "json"),
    ("yaml", "YAML", "yaml"),
    ("yml", "YAML", "yaml"),
    ("toml", "TOML", "ini"),
    ("ini", "INI", "ini"),
    ("cfg", "Config", "ini"),
    ("md", "Markdown", "markdown"),
    ("rst", "reStructuredText", ""),
    ("txt", "Text", ""),
    ("proto", "Protocol Buffers", "protobuf"),
    ("graphql", "GraphQL", "graphql"),
    ("gql", "GraphQL", "graphql"),
    ("tf", "Terraform", ""),
    ("cmake", "CMake", "cmake"),
    ("gradle", "Gradle", "gradle"),
    ("rl", "Ragel", ""),
    ("asm", "Assembly", "x86asm"),
    ("s", "Assembly", "x86asm"),
];

/// `(file name, label, highlighter id)` for well-known files that have no
/// telling extension.
const BY_NAME: &[(&str, &str, &str)] = &[
    ("Makefile", "Makefile", "makefile"),
    ("makefile", "Makefile", "makefile"),
    ("GNUmakefile", "Makefile", "makefile"),
    ("CMakeLists.txt", "CMake", "cmake"),
    ("Dockerfile", "Dockerfile", "dockerfile"),
    ("Jenkinsfile", "Groovy", "groovy"),
    ("Gemfile", "Ruby", "ruby"),
    ("Rakefile", "Ruby", "ruby"),
    ("BUILD", "Bazel", "python"),
    ("WORKSPACE", "Bazel", "python"),
];

/// What is known about a file's language from its name alone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Language {
    pub label: &'static str,
    pub highlighter: &'static str,
}

/// Returns the language for a file name, or `None` when the name says nothing.
pub fn of_file_name(name: &str) -> Option<Language> {
    if let Some((_, label, highlighter)) =
        BY_NAME.iter().find(|(n, _, _)| *n == name)
    {
        return Some(Language { label, highlighter });
    }
    let extension =
        name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase())?;
    BY_EXTENSION
        .iter()
        .find(|(e, _, _)| *e == extension)
        .map(|(_, label, highlighter)| Language { label, highlighter })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_languages_by_extension_and_by_file_name() {
        assert_eq!(of_file_name("LogWriter.cpp").unwrap().label, "C++");
        assert_eq!(of_file_name("main.GO").unwrap().label, "Go");
        assert_eq!(of_file_name("CMakeLists.txt").unwrap().label, "CMake");
        assert_eq!(
            of_file_name("Dockerfile").unwrap().highlighter,
            "dockerfile"
        );
        assert!(of_file_name("LICENSE").is_none());
        assert!(of_file_name("data.unknownext").is_none());
    }
}
