//! Definitions in a file whose language has no parser here.
//!
//! One regular expression looks for the keywords that most languages put in
//! front of a name they define, such as `class`, `def` or `fun`. It finds
//! less than a parser and can be wrong, for example about a keyword in a
//! sentence of a comment, so answers that come from it are marked as found
//! in text.

use crate::index::IndexedDef;
use crate::syntax::Kind;
use crate::text::Lines;
use regex::Regex;
use std::sync::OnceLock;

/// The definitions the regular expression finds in `text`.
pub fn definitions(text: &str) -> Vec<IndexedDef> {
    static DEFINED: OnceLock<Regex> = OnceLock::new();
    // The keyword, then optionally a receiver in brackets as in Go, then
    // optionally an owner and a dot as in `def self.build` or
    // `fun Meter.add`, then the name.
    let defined = DEFINED.get_or_init(|| {
        Regex::new(
            r"\b(class|struct|interface|protocol|trait|enum|type|typealias|module|namespace|defmodule|object|record|func|fn|fun|def|defp|function|sub|proc|macro)\s+(?:\([^)\n]*\)\s*)?(?:[A-Za-z_][A-Za-z0-9_]*\.)?([A-Za-z_][A-Za-z0-9_]*)",
        )
        .expect("the pattern is valid")
    });
    let lines = Lines::new(text);
    let mut found = Vec::new();
    for matched in defined.captures_iter(text) {
        let (Some(keyword), Some(name)) = (matched.get(1), matched.get(2))
        else {
            continue;
        };
        let row = lines.row_of(name.start());
        // A line that starts as a comment defines nothing.
        let line = lines.line(row).trim_start();
        if ["//", "#", "*", "/*", "--", ";"]
            .iter()
            .any(|mark| line.starts_with(mark))
        {
            continue;
        }
        let kind = match keyword.as_str() {
            "class" | "object" | "record" => Kind::Class,
            "struct" => Kind::Struct,
            "interface" | "protocol" => Kind::Interface,
            "trait" => Kind::Trait,
            "enum" => Kind::Enum,
            "type" | "typealias" => Kind::Type,
            "module" | "namespace" | "defmodule" => Kind::Module,
            "macro" => Kind::Macro,
            _ => Kind::Function,
        };
        let (line, column, end_column) = lines.place_of(name.range());
        found.push(IndexedDef {
            name: name.as_str().to_string(),
            container: None,
            kind,
            declaration: false,
            line,
            column,
            end_column,
            of_type: None,
        });
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keywords_in_front_of_a_name_are_read_as_definitions() {
        let text =
            "# class Legacy is gone\nmodule Billing\n  class Invoice\n    \
                    def self.build(lines)\n    end\n    def total\n    \
                    end\n  end\nend\n";
        let found: Vec<(String, Kind, u32)> = definitions(text)
            .into_iter()
            .map(|def| (def.name, def.kind, def.line))
            .collect();
        assert_eq!(
            found,
            vec![
                ("Billing".to_string(), Kind::Module, 2),
                ("Invoice".to_string(), Kind::Class, 3),
                ("build".to_string(), Kind::Function, 4),
                ("total".to_string(), Kind::Function, 6),
            ]
        );
    }
}
