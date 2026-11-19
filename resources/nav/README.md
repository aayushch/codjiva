# Navigation queries

These files tell Codjiva's code navigation what to look for in each language. The crate
`crates/codjiva-nav` compiles them into the app. They are written in the query language of
tree-sitter, the parser library that reads the source files.

Each language has up to three files. The table in `crates/codjiva-nav/src/grammar.rs` says which
folders a language reads; TypeScript, for example, reads `ecma/` and then `typescript/`.

## `definitions.scm`: what a file defines

Each pattern captures the name of a definition as `@name`, and the whole definition under a
capture that says what kind of thing it is:

- `@definition.<kind>`: a definition. The kinds are `function`, `method`, `class`, `struct`,
  `interface`, `trait`, `enum`, `type`, `constant`, `variable`, `field`, `enumerator`,
  `namespace`, `module` and `macro`.
- `@declaration.<kind>`: the same thing announced without its body, such as a function
  prototype in a C header.
- `@container`: a block that is not a definition itself but gives the definitions inside it a
  container, such as an `impl` block in Rust. `@name` is then the container's name.
- `@parent`: the name of the container when the code writes it next to the name, as in
  `LogWriter::append` or in the receiver of a Go method.
- `@name.type`: in the same pattern as `@name`, the type of the name where the code does not write
  it as a type, as `Meter` in `const meter = new Meter()`. A type that is written next to a field or
  a variable needs no capture: navigation reads it from the part of the definition that the parser
  calls `type`. Navigation uses the type to find the members of that field or variable, and to
  offer the definition of the type.
- `@base`: in a pattern of its own together with `@name`, the name of something that `@name` derives
  from: a base class, an implemented interface, a struct embedded in a Go struct, or the trait of a
  Rust `impl Trait for Type`. Such a pattern has no `@definition` capture. A class with two base
  classes is matched twice. Navigation uses it to find a member in a base class.

A definition inside a function body is left out of the workspace index. The local rules below
find it instead.

## `uses.scm`: how a name is used

Each pattern captures a name under one of these:

- `@call`: the name is called.
- `@type`: the name stands where a type is expected.
- `@member`: the name is a member of something, as `write` in `sink.write()`. A local variable
  of the same name is never meant by it. `@qualifier` in the same pattern captures what the
  member belongs to (`sink` in the example).

## `locals.scm`: names that belong to one function

- `@local`: a name defined inside a function: a parameter or a local variable. It is visible in
  the innermost block that contains it.
- `@local.outer`: a name that is visible one block further out than where it is written, such
  as the name of a nested function.
- `@local.type`: in the same pattern as `@local`, the type the code gives the name. Navigation
  uses it to find the members of a variable.

The blocks themselves are listed per language in `grammar.rs`, as `scopes`.

## Adding a language

1. Add the language's tree-sitter parser crate to the workspace `Cargo.toml` and to
   `crates/codjiva-nav/Cargo.toml`.
2. Add a row for it to `GRAMMARS` in `crates/codjiva-nav/src/grammar.rs`: its file extensions, its
   family, its query files and its `scopes`. Take its extensions out of the `PLAIN` list in the same
   file, which names the languages that are read as text.
3. Write the three query files in a folder of their own here. The node kinds a query may name are
   listed in the parser crate, in `src/node-types.json`.
4. Run `cargo test -p codjiva-nav`. The test `every_query_file_fits_its_parser` fails with the place
   of the mistake when a query names something the parser does not have.
5. Try the result on real code without starting the app:
   `cargo run -p codjiva-nav --example nav -- <folder> at <file> "<a piece of code>"`.
6. Add a test with a few definitions of the language to `crates/codjiva-nav/src/syntax.rs`, next to
   the ones for the other languages.

Each parser adds between about 0.2 and 7 MB to the app, so a language is worth adding when its
files are common in the workspaces people open.
