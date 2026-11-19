//! Reading files and converting between the two ways a position is counted.
//!
//! The interface names a position as a line, counted from 1, and a column in
//! UTF-16 code units, counted from 0. The parser names it as a byte offset
//! into the text. [`Lines`] converts between the two.

use memchr::memmem::Finder;
use std::fs;
use std::ops::Range;
use std::path::Path;
use std::time::UNIX_EPOCH;

/// A file larger than this is not read for navigation. It is the same size
/// from which the source view stops showing a file in full.
pub const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;

/// The line of code sent with a result is cut to this many characters.
const PREVIEW_CHARS: usize = 300;

/// The size in bytes and the modification time in nanoseconds of a file. Two
/// equal stamps are taken to mean that the file has not changed.
pub type Stamp = (u64, u128);

pub fn stamp_of(path: &Path) -> Option<Stamp> {
    let meta = fs::metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }
    let modified = meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |since| since.as_nanos());
    Some((meta.len(), modified))
}

/// Reads a file as text, the way the source view reads it: bytes that are not
/// valid UTF-8 are replaced. Returns `None` for a file that cannot be read, is
/// larger than [`MAX_FILE_BYTES`], or holds a NUL byte in its first 8 KB and
/// so is not text.
pub fn read_text(path: &Path) -> Option<String> {
    let meta = fs::metadata(path).ok()?;
    if meta.len() > MAX_FILE_BYTES {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    if bytes.iter().take(8192).any(|b| *b == 0) {
        return None;
    }
    Some(match String::from_utf8(bytes) {
        Ok(text) => text,
        Err(error) => String::from_utf8_lossy(error.as_bytes()).into_owned(),
    })
}

/// True for a file that looks generated or minified: it is large and its
/// lines are a thousand characters long on average. Parsing such a file is
/// slow and nobody navigates in it.
pub fn looks_minified(text: &str) -> bool {
    const LARGE: usize = 64 * 1024;
    const AVERAGE_LINE: usize = 1000;
    text.len() > LARGE
        && memchr::memchr_iter(b'\n', text.as_bytes()).count()
            < text.len() / AVERAGE_LINE
}

/// The lines of a text, for converting positions.
pub struct Lines<'a> {
    text: &'a str,
    /// The byte offset at which each line starts.
    starts: Vec<usize>,
}

impl<'a> Lines<'a> {
    pub fn new(text: &'a str) -> Lines<'a> {
        let mut starts = vec![0];
        starts.extend(
            memchr::memchr_iter(b'\n', text.as_bytes()).map(|at| at + 1),
        );
        Lines { text, starts }
    }

    /// The text of the line with index `row`, counted from 0, without the line
    /// break that ends it.
    pub fn line(&self, row: usize) -> &'a str {
        let Some(start) = self.starts.get(row).copied() else {
            return "";
        };
        let end = self
            .starts
            .get(row + 1)
            .map_or(self.text.len(), |next| next - 1);
        &self.text[start..end]
    }

    /// The byte offset at which the line with index `row` starts.
    pub fn start_of(&self, row: usize) -> usize {
        self.starts.get(row).copied().unwrap_or(self.text.len())
    }

    /// The index of the line that holds the byte at `offset`, counted from 0.
    pub fn row_of(&self, offset: usize) -> usize {
        self.starts.partition_point(|start| *start <= offset) - 1
    }

    /// The byte offset of the position the interface names with `line`,
    /// counted from 1, and `column`, in UTF-16 code units. Returns `None` for
    /// a line the text does not have. A column past the end of the line gives
    /// the end of the line.
    pub fn offset_of(&self, line: u32, column: u32) -> Option<usize> {
        let row = (line as usize).checked_sub(1)?;
        let start = *self.starts.get(row)?;
        let text = self.line(row);
        let mut units = 0u32;
        for (at, c) in text.char_indices() {
            if units >= column {
                return Some(start + at);
            }
            units += c.len_utf16() as u32;
        }
        Some(start + text.len())
    }

    /// The place of the bytes `range`, which must lie within one line, as the
    /// interface names it: the line counted from 1, and the columns of its
    /// first character and of the character after its last, in UTF-16 code
    /// units.
    pub fn place_of(&self, range: Range<usize>) -> (u32, u32, u32) {
        let row = self.row_of(range.start);
        let start = self.starts[row];
        let text = self.line(row);
        let units = |until: usize| {
            let until = until.saturating_sub(start).min(text.len());
            text.get(..until)
                .map_or(0, |before| before.encode_utf16().count() as u32)
        };
        (row as u32 + 1, units(range.start), units(range.end))
    }

    /// The line with index `row` as it is sent with a result: cut to a length
    /// that is reasonable to show in a list.
    pub fn preview(&self, row: usize) -> String {
        let text = self.line(row).trim_end_matches('\r');
        match text.char_indices().nth(PREVIEW_CHARS) {
            Some((cut, _)) => text[..cut].to_string(),
            None => text.to_string(),
        }
    }
}

/// True for a byte that can be part of a name: a letter, a digit, an
/// underscore, or any byte of a character outside ASCII.
pub fn is_word_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_' || byte >= 0x80
}

/// The bytes of the word around `offset`, or `None` when the bytes on both
/// sides of `offset` are not part of a name or the word starts with a digit.
pub fn word_at(text: &str, offset: usize) -> Option<Range<usize>> {
    let bytes = text.as_bytes();
    let offset = offset.min(bytes.len());
    let mut start = offset;
    while start > 0 && is_word_byte(bytes[start - 1]) {
        start -= 1;
    }
    let mut end = offset;
    while end < bytes.len() && is_word_byte(bytes[end]) {
        end += 1;
    }
    (start < end && !bytes[start].is_ascii_digit()).then_some(start..end)
}

/// Finds every place where `word` stands in a text as a whole word, that is,
/// with no name character directly before or after it.
pub struct WordFinder<'w> {
    word: &'w [u8],
    finder: Finder<'w>,
}

impl<'w> WordFinder<'w> {
    pub fn new(word: &'w str) -> WordFinder<'w> {
        WordFinder {
            word: word.as_bytes(),
            finder: Finder::new(word.as_bytes()),
        }
    }

    /// The byte offsets at which the word starts in `text`.
    pub fn find<'t>(
        &'t self,
        text: &'t [u8],
    ) -> impl Iterator<Item = usize> + 't {
        self.finder.find_iter(text).filter(move |at| {
            let before = *at > 0 && is_word_byte(text[at - 1]);
            let after = text
                .get(at + self.word.len())
                .is_some_and(|byte| is_word_byte(*byte));
            !before && !after
        })
    }

    pub fn is_in(&self, text: &[u8]) -> bool {
        self.find(text).next().is_some()
    }
}

/// The last plain name in a piece of code that names a type or the owner of a
/// member: `Order` for `*Order`, `LogWriter` for `const logbuf::LogWriter&`,
/// `process` for `crate::agents::process`, `Stack` for `Stack<T>`. Returns an
/// empty string when the text holds no name.
pub fn simple_name(text: &str) -> &str {
    // What stands in angle or square brackets are type arguments or an index,
    // not part of the name.
    let cut = text.find(['<', '[', '(']).unwrap_or(text.len());
    let head = &text[..cut];
    let end = head
        .rfind(|c: char| c.is_alphanumeric() || c == '_')
        .map_or(0, |at| {
            at + head[at..].chars().next().map_or(1, char::len_utf8)
        });
    let start = head[..end]
        .rfind(|c: char| !(c.is_alphanumeric() || c == '_'))
        .map_or(0, |at| {
            at + head[at..].chars().next().map_or(1, char::len_utf8)
        });
    &head[start..end]
}

/// The longest text of a type that is kept for a definition.
const MAX_TYPE_BYTES: usize = 120;

/// The text of a type as it is kept for a definition: on one line, with
/// single spaces, and without the colon that TypeScript writes in front of
/// a type. Returns `None` for an empty text and for one longer than
/// [`MAX_TYPE_BYTES`], which is most often a type written out in place.
pub fn type_text(text: &str) -> Option<String> {
    let text = text.trim_start().trim_start_matches(':');
    let joined = text.split_whitespace().collect::<Vec<_>>().join(" ");
    (!joined.is_empty() && joined.len() <= MAX_TYPE_BYTES).then_some(joined)
}

/// Every name in the text of a type, in the order written, without the
/// words that are part of the language: `std`, `unique_ptr`, `plant` and
/// `Valve` for `const std::unique_ptr<plant::Valve>&`. The members of a
/// value of that type belong to one of these names.
pub fn type_words(text: &str) -> Vec<&str> {
    const NOT_NAMES: [&str; 14] = [
        "const", "volatile", "mutable", "static", "struct", "class", "enum",
        "union", "typename", "unsigned", "signed", "mut", "dyn", "readonly",
    ];
    let mut words: Vec<&str> = Vec::new();
    for word in text.split(|c: char| !(c.is_alphanumeric() || c == '_')) {
        let is_name = word
            .chars()
            .next()
            .is_some_and(|first| !first.is_ascii_digit());
        if is_name && !NOT_NAMES.contains(&word) && !words.contains(&word) {
            words.push(word);
        }
    }
    words
}

/// A path without its last extension: `src/a/handler.test.ts` gives
/// `src/a/handler.test`.
pub fn without_extension(path: &str) -> &str {
    let name_start = path.rfind('/').map_or(0, |i| i + 1);
    match path[name_start..].rfind('.') {
        Some(dot) if dot > 0 => &path[..name_start + dot],
        _ => path,
    }
}

/// The folder of a path, or an empty string for a file at the root.
pub fn dir_of(path: &str) -> &str {
    path.rfind('/').map_or("", |i| &path[..i])
}

/// The name of a file without its folder and without its last extension.
pub fn stem_of(path: &str) -> &str {
    let bare = without_extension(path);
    bare.rsplit('/').next().unwrap_or(bare)
}

/// How many leading folders two paths share. Results in files that share
/// more folders with the file the user is in are shown first.
pub fn shared_folders(a: &str, b: &str) -> usize {
    dir_of(a)
        .split('/')
        .zip(dir_of(b).split('/'))
        .take_while(|(x, y)| x == y && !x.is_empty())
        .count()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn positions_convert_both_ways_with_wide_characters() {
        // "é" is two bytes and one UTF-16 unit. The emoji is four bytes and
        // two units.
        let text = "ab\ncafé = x\n😀 name\n";
        let lines = Lines::new(text);
        assert_eq!(lines.line(1), "café = x");
        let x = text.find('x').unwrap();
        assert_eq!(lines.place_of(x..x + 1), (2, 7, 8));
        assert_eq!(lines.offset_of(2, 7), Some(x));
        let name = text.find("name").unwrap();
        assert_eq!(lines.place_of(name..name + 4), (3, 3, 7));
        assert_eq!(lines.offset_of(3, 3), Some(name));
        assert_eq!(lines.offset_of(9, 0), None);
        // A column past the end of a line gives the end of that line.
        assert_eq!(lines.offset_of(1, 40), Some(2));
    }

    #[test]
    fn words_are_found_whole_and_never_inside_a_longer_name() {
        let text = "flush(); reflush(); flush_all(); x.flush";
        let finder = WordFinder::new("flush");
        let found: Vec<usize> = finder.find(text.as_bytes()).collect();
        assert_eq!(found, vec![0, text.len() - 5]);
        assert_eq!(word_at(text, 2), Some(0..5));
        assert_eq!(word_at(text, 5), Some(0..5));
        assert_eq!(word_at(text, 6), None);
        assert_eq!(word_at("x = 42", 5), None);
    }

    #[test]
    fn the_names_in_a_type_are_listed_without_language_words() {
        assert_eq!(
            type_words("const std::unique_ptr<plant::Valve>&"),
            ["std", "unique_ptr", "plant", "Valve"]
        );
        assert_eq!(type_words("map[string]*Order"), ["map", "string", "Order"]);
        assert_eq!(type_words("unsigned char[16]"), ["char"]);
        assert_eq!(
            type_text(" std::map<int,\n   Row> "),
            Some("std::map<int, Row>".to_string())
        );
        assert_eq!(type_text(": Meter | null"), Some("Meter | null".into()));
        assert_eq!(type_text("  "), None);
        assert_eq!(type_text(&"x".repeat(200)), None);
    }

    #[test]
    fn the_plain_name_of_a_type_is_its_last_part_without_arguments() {
        for (text, name) in [
            ("*Order", "Order"),
            ("const logbuf::LogWriter&", "LogWriter"),
            ("crate::agents::process", "process"),
            ("Stack<T>", "Stack"),
            ("list[Sink]", "list"),
            ("o", "o"),
            ("&mut self", "self"),
            ("()", ""),
        ] {
            assert_eq!(simple_name(text), name, "{text}");
        }
    }
}
