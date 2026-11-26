//! Code navigation: where a name is defined and where it is used.
//!
//! The source view asks three questions about a name the user clicked.
//! [`lookup`] answers "what is this name and where is it defined".
//! [`references`] answers "where else is it used". [`Index::search`] answers
//! "which definitions have a name like this", for going to a symbol by name.
//!
//! How exact the answers are. This crate reads the code's structure with
//! tree-sitter parsers and does not know the types of expressions. That gives
//! three levels, and every answer says which one it is, as its [`Basis`]:
//!
//!   - `scope`: the name is a parameter or a local variable. Its definition is
//!     found by walking outwards through the blocks around the use, which is
//!     exact.
//!   - `name`: the name is defined somewhere else. Every definition with that
//!     name in the workspace is a candidate, and the candidates are ranked by
//!     how close they are to the use. See [`Group`]. Two things the index
//!     keeps make this ranking better than a comparison of names: what each
//!     class derives from, and the type written next to a field or a
//!     variable. With them a member is found in the class of the code that
//!     uses it, in a base class of that class, and in the type of the field
//!     or variable in front of it.
//!   - `text`: the file's language has no parser here. Definitions are found
//!     with a regular expression and uses by searching for the word.
//!
//! Nothing here runs code of the workspace, starts another program, writes a
//! file or uses the network.
//!
//! Positions. A line is counted from 1. A column is counted from 0 in UTF-16
//! code units, which is how a JavaScript string indexes the text of a line, so
//! the interface can use the numbers as they are.

mod grammar;
pub mod imports;
mod index;
mod lookup;
mod plain;
mod refs;
mod syntax;
mod text;

pub use grammar::{family_of, has_grammar};
pub use index::{
    definitions_of, extents_of, Extent, Index, IndexedDef, SymbolHit,
};
pub use lookup::{lookup, Basis, Group, Lookup, Span, Target};
pub use refs::{references, Reference, RefsEvent};
pub use syntax::{Kind, Role};
