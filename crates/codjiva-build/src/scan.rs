//! Static checks on the JavaScript and CSS an agent writes.
//!
//! Agent code may only draw. It must not reach the network, keep time by
//! itself, or produce a different picture on different runs. This module finds
//! the constructs that would let it, and reports each with its file and line so
//! the agent can be told exactly what to remove.
//!
//! The JavaScript is split into tokens first. That keeps a forbidden word
//! inside a label, such as a machine named "Date parser", from being mistaken
//! for a use of the `Date` object.

use crate::{Diagnostic, Severity};

/// The kinds of token the scanner tells apart. Whitespace is skipped and
/// produces no token.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Comment,
    /// A single- or double-quoted string, including its quotes.
    Str,
    /// One literal piece of a template string. Code inside `${ }` is tokenized
    /// normally.
    Template,
    Regex,
    Ident,
    Number,
    Punct,
}

#[derive(Debug, Clone, Copy)]
pub struct Token {
    pub kind: Kind,
    /// Byte offsets into the source: `start` is inclusive, `end` is exclusive.
    pub start: usize,
    pub end: usize,
}

/// Words after which a `/` starts a regular expression instead of meaning
/// division.
const REGEX_AFTER_WORDS: &[&str] = &[
    "return",
    "typeof",
    "case",
    "in",
    "of",
    "delete",
    "void",
    "throw",
    "new",
    "else",
    "do",
    "instanceof",
    "yield",
    "await",
];

struct Lexer<'a> {
    src: &'a str,
    bytes: &'a [u8],
    pos: usize,
    tokens: Vec<Token>,
}

fn is_ident_start(b: u8) -> bool {
    b.is_ascii_alphabetic() || b == b'_' || b == b'$' || b >= 0x80
}

fn is_ident_part(b: u8) -> bool {
    is_ident_start(b) || b.is_ascii_digit()
}

impl<'a> Lexer<'a> {
    fn push(&mut self, kind: Kind, start: usize) {
        self.tokens.push(Token {
            kind,
            start,
            end: self.pos,
        });
    }

    /// Returns true when a `/` at the current position starts a regular
    /// expression. That is the case at the start of the code, after an operator
    /// or opening bracket, and after keywords such as `return`. After a name, a
    /// number or a closing bracket, `/` is a division.
    fn regex_allowed(&self) -> bool {
        let Some(prev) =
            self.tokens.iter().rev().find(|t| t.kind != Kind::Comment)
        else {
            return true;
        };
        let text = &self.src[prev.start..prev.end];
        match prev.kind {
            Kind::Punct => !matches!(text, ")" | "]" | "}"),
            Kind::Ident => REGEX_AFTER_WORDS.contains(&text),
            _ => false,
        }
    }

    /// Reads code until the end of the source. When `inside_template` is true
    /// it instead stops at the `}` that closes a `${` expression, leaving that
    /// `}` consumed.
    fn code(&mut self, inside_template: bool) {
        let mut depth = 0usize;
        while self.pos < self.bytes.len() {
            let b = self.bytes[self.pos];
            let next = self.bytes.get(self.pos + 1).copied();
            let start = self.pos;
            if b.is_ascii_whitespace() {
                self.pos += 1;
            } else if b == b'/' && next == Some(b'/') {
                while self.pos < self.bytes.len()
                    && self.bytes[self.pos] != b'\n'
                {
                    self.pos += 1;
                }
                self.push(Kind::Comment, start);
            } else if b == b'/' && next == Some(b'*') {
                self.pos += 2;
                while self.pos < self.bytes.len()
                    && !(self.bytes[self.pos] == b'*'
                        && self.bytes.get(self.pos + 1) == Some(&b'/'))
                {
                    self.pos += 1;
                }
                self.pos = (self.pos + 2).min(self.bytes.len());
                self.push(Kind::Comment, start);
            } else if b == b'\'' || b == b'"' {
                self.pos += 1;
                while self.pos < self.bytes.len()
                    && self.bytes[self.pos] != b
                    && self.bytes[self.pos] != b'\n'
                {
                    if self.bytes[self.pos] == b'\\' {
                        self.pos += 1;
                    }
                    self.pos += 1;
                }
                self.pos = (self.pos + 1).min(self.bytes.len());
                self.push(Kind::Str, start);
            } else if b == b'`' {
                self.pos += 1;
                self.template();
            } else if b == b'/' && self.regex_allowed() {
                self.pos += 1;
                let mut in_class = false;
                while self.pos < self.bytes.len() {
                    let c = self.bytes[self.pos];
                    if c == b'\\' {
                        self.pos += 2;
                        continue;
                    }
                    if c == b'\n' {
                        break;
                    }
                    if c == b'[' {
                        in_class = true;
                    } else if c == b']' {
                        in_class = false;
                    } else if c == b'/' && !in_class {
                        self.pos += 1;
                        break;
                    }
                    self.pos += 1;
                }
                while self.pos < self.bytes.len()
                    && self.bytes[self.pos].is_ascii_alphabetic()
                {
                    self.pos += 1;
                }
                self.pos = self.pos.min(self.bytes.len());
                self.push(Kind::Regex, start);
            } else if is_ident_start(b) {
                while self.pos < self.bytes.len()
                    && is_ident_part(self.bytes[self.pos])
                {
                    self.pos += 1;
                }
                self.push(Kind::Ident, start);
            } else if b.is_ascii_digit() {
                while self.pos < self.bytes.len()
                    && (is_ident_part(self.bytes[self.pos])
                        || self.bytes[self.pos] == b'.')
                {
                    self.pos += 1;
                }
                self.push(Kind::Number, start);
            } else {
                self.pos += 1;
                self.push(Kind::Punct, start);
                if b == b'{' {
                    depth += 1;
                } else if b == b'}' {
                    if depth == 0 && inside_template {
                        return;
                    }
                    depth = depth.saturating_sub(1);
                }
            }
        }
    }

    /// Reads a template string after its opening backtick, up to and including
    /// the closing one.
    fn template(&mut self) {
        let mut start = self.pos - 1;
        while self.pos < self.bytes.len() {
            let c = self.bytes[self.pos];
            if c == b'\\' {
                self.pos += 2;
            } else if c == b'`' {
                self.pos += 1;
                self.push(Kind::Template, start);
                return;
            } else if c == b'$' && self.bytes.get(self.pos + 1) == Some(&b'{') {
                self.push(Kind::Template, start);
                self.pos += 2;
                self.code(true);
                start = self.pos;
            } else {
                self.pos += 1;
            }
        }
        self.pos = self.bytes.len();
        self.push(Kind::Template, start);
    }
}

/// Splits JavaScript source into tokens. It never fails: unterminated strings
/// and comments end at the end of the line or of the source.
pub fn tokenize(src: &str) -> Vec<Token> {
    let mut lexer = Lexer {
        src,
        bytes: src.as_bytes(),
        pos: 0,
        tokens: Vec::new(),
    };
    lexer.code(false);
    lexer.tokens
}

/// Returns the source with every comment removed. A block comment becomes one
/// space, so the two tokens around it stay separate, and line breaks inside it
/// are kept so line numbers do not move.
pub fn strip_comments(src: &str) -> String {
    let mut out = String::with_capacity(src.len());
    let mut at = 0;
    for token in tokenize(src) {
        if token.kind != Kind::Comment {
            continue;
        }
        out.push_str(&src[at..token.start]);
        let text = &src[token.start..token.end];
        if text.starts_with("/*") {
            out.push(' ');
            out.extend(text.chars().filter(|c| *c == '\n'));
        }
        at = token.end;
    }
    out.push_str(&src[at..]);
    out
}

fn line_of(src: &str, offset: usize) -> usize {
    src.as_bytes()[..offset.min(src.len())]
        .iter()
        .filter(|b| **b == b'\n')
        .count()
        + 1
}

/// Names agent code must not use, with the reason shown to the agent.
const FORBIDDEN_NAMES: &[(&str, &str)] = &[
    ("fetch", "network requests are not allowed"),
    ("XMLHttpRequest", "network requests are not allowed"),
    ("WebSocket", "network connections are not allowed"),
    ("EventSource", "network connections are not allowed"),
    (
        "import",
        "modules cannot be imported; use only the CJ object",
    ),
    (
        "require",
        "modules cannot be loaded; use only the CJ object",
    ),
    ("eval", "evaluating strings as code is not allowed"),
    ("Function", "building functions from strings is not allowed"),
    (
        "setTimeout",
        "timers are not allowed; render(t) must set everything from t",
    ),
    (
        "setInterval",
        "timers are not allowed; render(t) must set everything from t",
    ),
    (
        "requestAnimationFrame",
        "the runtime owns the frame loop; render(t) must set everything from t",
    ),
    (
        "Date",
        "reading the clock is not allowed; use the t passed to render",
    ),
    (
        "performance",
        "reading the clock is not allowed; use the t passed to render",
    ),
    ("localStorage", "storage is not allowed"),
    ("sessionStorage", "storage is not allowed"),
    ("indexedDB", "storage is not allowed"),
    ("Worker", "workers are not allowed"),
];

/// Text that must not appear inside a string of agent code, with the reason
/// shown to the agent.
const FORBIDDEN_TEXT: &[(&str, &str)] = &[
    ("https://", "external addresses are not allowed"),
    ("http://", "external addresses are not allowed"),
    ("<script", "scripts cannot be added from markup"),
    ("<link", "external resources cannot be linked"),
    ("<iframe", "frames are not allowed"),
    ("<object", "embedded objects are not allowed"),
    ("<embed", "embedded objects are not allowed"),
    (
        "<text",
        "write words as HTML elements, never as SVG <text>, so they can be \
         measured",
    ),
    ("javascript:", "script addresses are not allowed"),
];

/// The address of the SVG and XHTML namespaces, which contain "http://" but
/// load nothing.
const NAMESPACE_PREFIX: &str = "http://www.w3.org/";

/// Checks one agent-written JavaScript file and returns one diagnostic per
/// forbidden construct.
pub fn scan_js(file: &str, src: &str) -> Vec<Diagnostic> {
    let tokens: Vec<Token> = tokenize(src)
        .into_iter()
        .filter(|t| t.kind != Kind::Comment)
        .collect();
    let text = |t: &Token| &src[t.start..t.end];
    let mut found = Vec::new();
    let mut report = |offset: usize, what: &str, why: &str| {
        found.push(Diagnostic {
            check: "forbidden-token".into(),
            severity: Severity::Error,
            file: file.into(),
            line: Some(line_of(src, offset)),
            message: format!("`{what}` is not allowed: {why}"),
        });
    };

    for (i, token) in tokens.iter().enumerate() {
        match token.kind {
            Kind::Ident => {
                let name = text(token);
                if let Some((_, why)) =
                    FORBIDDEN_NAMES.iter().find(|(n, _)| *n == name)
                {
                    // A name followed by ':' is an object key, such as {
                    // import: 1 }, not a use.
                    let is_key =
                        tokens.get(i + 1).is_some_and(|n| text(n) == ":")
                            && i.checked_sub(1)
                                .and_then(|p| tokens.get(p))
                                .is_some_and(|p| matches!(text(p), "{" | ","));
                    if !is_key {
                        report(token.start, name, why);
                    }
                }
                let after_math = i >= 2
                    && text(&tokens[i - 1]) == "."
                    && text(&tokens[i - 2]) == "Math";
                if name == "random" && after_math {
                    report(
                        tokens[i - 2].start,
                        "Math.random",
                        "it makes frames differ between runs; use CJ.rng(seed)",
                    );
                }
            }
            Kind::Str | Kind::Template => {
                let body = text(token);
                let lower = body.to_ascii_lowercase();
                for (needle, why) in FORBIDDEN_TEXT {
                    let mut from = 0;
                    while let Some(hit) = lower[from..].find(needle) {
                        let at = from + hit;
                        from = at + needle.len();
                        if needle.starts_with("http")
                            && lower[at..].starts_with(NAMESPACE_PREFIX)
                        {
                            continue;
                        }
                        // "<text" must be the SVG element, not the start of a
                        // longer tag name.
                        if *needle == "<text"
                            && lower[from..].starts_with(|c: char| {
                                c.is_ascii_alphanumeric()
                            })
                        {
                            continue;
                        }
                        report(token.start + at, needle, why);
                    }
                }
                if let Some(at) = find_inline_handler(&lower) {
                    report(
                        token.start + at,
                        "on…=",
                        "event handler attributes are not allowed in markup",
                    );
                }
            }
            _ => {}
        }
    }
    found
}

/// Finds an inline event handler attribute such as ` onclick=` in lower-cased
/// markup text. Returns the byte offset of the attribute name.
fn find_inline_handler(lower: &str) -> Option<usize> {
    let bytes = lower.as_bytes();
    let mut i = 0;
    while i + 3 < bytes.len() {
        if bytes[i].is_ascii_whitespace()
            && bytes[i + 1] == b'o'
            && bytes[i + 2] == b'n'
        {
            let mut j = i + 3;
            while j < bytes.len() && bytes[j].is_ascii_lowercase() {
                j += 1;
            }
            if j > i + 3 && bytes.get(j) == Some(&b'=') {
                return Some(i + 1);
            }
        }
        i += 1;
    }
    None
}

/// Checks the optional extra.css. It may only use theme tokens, so literal
/// colours, external resources and imports are reported.
pub fn scan_css(file: &str, src: &str) -> Vec<Diagnostic> {
    let mut found = Vec::new();
    let lower = src.to_ascii_lowercase();
    let mut report = |offset: usize, message: String| {
        found.push(Diagnostic {
            check: "extra-css".into(),
            severity: Severity::Error,
            file: file.into(),
            line: Some(line_of(src, offset)),
            message,
        });
    };
    for needle in ["url(", "@import", "http://", "https://", "@font-face"] {
        if let Some(at) = lower.find(needle) {
            report(
                at,
                format!(
                    "`{needle}` is not allowed in extra.css: artifacts load \
                     nothing from outside"
                ),
            );
        }
    }
    for needle in ["rgb(", "rgba(", "hsl(", "hsla("] {
        if let Some(at) = lower.find(needle) {
            report(
                at,
                format!(
                    "`{needle}…)` is a literal colour; use the theme \
                     variables such as var(--main) and color-mix()"
                ),
            );
        }
    }
    let bytes = lower.as_bytes();
    for (i, b) in bytes.iter().enumerate() {
        if *b != b'#' {
            continue;
        }
        let digits = bytes[i + 1..]
            .iter()
            .take_while(|c| c.is_ascii_hexdigit())
            .count();
        let ends = bytes.get(i + 1 + digits).is_none_or(|c| {
            !c.is_ascii_alphanumeric() && *c != b'-' && *c != b'_'
        });
        // A hex colour is # followed by 3, 4, 6 or 8 hex digits and then a
        // non-name character. Selectors such as #stage do not match, because
        // their names are not all hex digits.
        let in_value = lower[..i]
            .rfind([':', '{', ';'])
            .is_some_and(|p| bytes[p] == b':');
        if matches!(digits, 3 | 4 | 6 | 8) && ends && in_value {
            report(
                i,
                "a literal hex colour is not allowed in extra.css; use the \
                 theme variables such as var(--main)"
                    .into(),
            );
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    fn messages(src: &str) -> Vec<String> {
        scan_js("scenes/a.js", src)
            .into_iter()
            .map(|d| format!("{}:{}", d.line.unwrap(), d.message))
            .collect()
    }

    #[test]
    fn reports_fetch_with_its_line() {
        let found = messages("const a = 1;\nconst b = 2;\nfetch('x');\n");
        assert_eq!(found.len(), 1);
        assert!(found[0].starts_with("3:`fetch`"), "{found:?}");
    }

    #[test]
    fn reports_math_random_but_not_other_math() {
        let found =
            messages("const x = Math.sin(1);\nconst y = Math.random();\n");
        assert_eq!(found.len(), 1);
        assert!(found[0].starts_with("2:`Math.random`"), "{found:?}");
    }

    #[test]
    fn ignores_forbidden_words_inside_labels_and_comments() {
        let found = messages(
            "// uses Date and fetch\nconst label = 'Date parser · fetch queue \
             · import()';\nconst t = `eval ${1 + 1} setTimeout`;\n",
        );
        assert!(found.is_empty(), "{found:?}");
    }

    #[test]
    fn finds_forbidden_code_inside_a_template_expression() {
        let found = messages("const s = `a ${Date.now()} b`;\n");
        assert_eq!(found.len(), 1);
        assert!(found[0].contains("`Date`"), "{found:?}");
    }

    #[test]
    fn reports_external_addresses_but_not_the_svg_namespace() {
        let found = messages("const ns = 'http://www.w3.org/2000/svg';\nconst img = '<image href=\"https://example.com/a.png\"/>';\n");
        assert_eq!(found.len(), 1);
        assert!(found[0].starts_with("2:`https://`"), "{found:?}");
    }

    #[test]
    fn reports_svg_text_and_inline_handlers() {
        let found = messages(
            "const a = '<text x=\"1\">hi</text>';\nconst b = '<g \
             onclick=\"x()\"></g>';\nconst c = '<textPath>';\n",
        );
        assert_eq!(found.len(), 2, "{found:?}");
    }

    #[test]
    fn a_slash_after_a_name_is_division_not_a_regex() {
        let tokens = tokenize("const a = b / c; const d = /x\\/y/g.test(e);");
        let regexes = tokens.iter().filter(|t| t.kind == Kind::Regex).count();
        assert_eq!(regexes, 1);
    }

    #[test]
    fn strip_comments_keeps_code_strings_and_line_count() {
        let src = "const a = 1; // one\n/* two\n   lines */const b = '// not \
                   a comment';\n";
        let out = strip_comments(src);
        assert!(!out.contains("one") && !out.contains("two"));
        assert!(out.contains("'// not a comment'"));
        assert_eq!(out.matches('\n').count(), src.matches('\n').count());
    }

    #[test]
    fn css_lint_reports_literal_colours_only() {
        let found = scan_css(
            "extra.css",
            "#stage .v-x { color: var(--main) }\n.v-y { fill: #ff0000 }\n.v-z \
             { background: rgb(1,2,3) }\n",
        );
        assert_eq!(
            found.len(),
            2,
            "{:?}",
            found.iter().map(|d| &d.message).collect::<Vec<_>>()
        );
    }
}
