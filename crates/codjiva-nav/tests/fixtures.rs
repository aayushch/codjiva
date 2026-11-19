//! Navigation on the fixture workspaces of the repository. Each check names
//! a place in a file by a piece of its code, asks about the name at that
//! place, and compares where the answer leads.

use codjiva_nav::{
    lookup, references, Basis, Group, Index, Lookup, Reference, RefsEvent, Role,
};
use ignore::WalkBuilder;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

/// A workspace with its index.
struct Workspace {
    root: PathBuf,
    index: Arc<Index>,
}

impl Workspace {
    fn open(root: &Path) -> Workspace {
        let root = root.canonicalize().unwrap();
        let mut files: Vec<String> = WalkBuilder::new(&root)
            .hidden(false)
            .build()
            .flatten()
            .filter(|item| item.file_type().is_some_and(|kind| kind.is_file()))
            .filter_map(|item| {
                let rel = item.path().strip_prefix(&root).ok()?;
                Some(rel.to_string_lossy().replace('\\', "/"))
            })
            .collect();
        files.sort();
        let index = Index::new(&root);
        index.refresh(files);
        Workspace { root, index }
    }

    fn fixture(name: &str) -> Workspace {
        Workspace::open(
            &Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../fixtures")
                .join(name),
        )
    }

    /// The line, counted from 1, and the UTF-16 column of the first
    /// character of `code` in `file`. `code` must be in the file.
    fn place(&self, file: &str, code: &str) -> (u32, u32) {
        let text = fs::read_to_string(self.root.join(file)).unwrap();
        let at = text
            .find(code)
            .unwrap_or_else(|| panic!("{file} does not contain {code:?}"));
        let line_start = text[..at].rfind('\n').map_or(0, |i| i + 1);
        (
            text[..at].matches('\n').count() as u32 + 1,
            text[line_start..at].encode_utf16().count() as u32,
        )
    }

    /// What is known about the name that starts `code` in `file`.
    fn at(&self, file: &str, code: &str) -> Option<Lookup> {
        let (line, column) = self.place(file, code);
        lookup(&self.index, file, line, column, false)
    }

    /// The same, asking for prototypes before bodies.
    fn declaration_at(&self, file: &str, code: &str) -> Option<Lookup> {
        let (line, column) = self.place(file, code);
        lookup(&self.index, file, line, column, true)
    }

    /// Every reference to the name that starts `code` in `file`, and the
    /// last report of the search.
    fn references(
        &self,
        file: &str,
        code: &str,
    ) -> (Vec<Reference>, RefsEvent) {
        let (line, column) = self.place(file, code);
        let mut found = Vec::new();
        let mut last = None;
        references(
            &self.index,
            file,
            line,
            column,
            &AtomicBool::new(false),
            &mut |event| match event {
                RefsEvent::Found { references } => found.extend(references),
                done => last = Some(done),
            },
        );
        (found, last.expect("the search reports that it ended"))
    }
}

/// The definitions of an answer as `path:line`, in the order of the answer.
fn places(found: &Lookup) -> Vec<String> {
    found
        .definitions
        .iter()
        .map(|one| format!("{}:{}", one.path, one.line))
        .collect()
}

/// Checks that the answer is certain and that its first definition is at
/// `place`, written as `path:line`.
#[track_caller]
fn leads_to(found: Option<Lookup>, place: &str) {
    let found = found.expect("there is a name at that place");
    assert!(found.certain, "{} is not certain: {found:#?}", found.name);
    assert_eq!(places(&found)[0], place, "{found:#?}");
}

#[test]
fn cpp_a_call_leads_to_the_body_and_the_body_to_its_prototype() {
    let ws = Workspace::fixture("cpp-logbuf");
    // `writer` is declared as a `logbuf::LogWriter`, so `append` is looked
    // for in that class.
    let call = ws.at("src/main.cpp", "append(");
    assert_eq!(call.as_ref().unwrap().definitions[0].group, Group::Owner);
    leads_to(call, "src/LogWriter.cpp:66");
    leads_to(
        ws.declaration_at("src/main.cpp", "append("),
        "include/LogWriter.h:76",
    );
    // From the body the first result is the prototype, and from the
    // prototype the body.
    leads_to(
        ws.at("src/LogWriter.cpp", "append(LogRecord"),
        "include/LogWriter.h:76",
    );
    leads_to(
        ws.at("include/FileSink.h", "write(std"),
        "src/FileSink.cpp:32",
    );
    // A member of this class that is used without `this`.
    leads_to(
        ws.at("src/LogWriter.cpp", "bufferLine(renderLine"),
        "src/LogWriter.cpp:169",
    );
    leads_to(
        ws.at("src/LogWriter.cpp", "sink_.write"),
        "include/LogWriter.h:95",
    );
    // The value of an enum, named with the enum in front.
    leads_to(
        ws.at("include/LogWriter.h", "Info;"),
        "include/LogWriter.h:15",
    );
    // A constant of the file.
    leads_to(
        ws.at("src/LogWriter.cpp", "kSourceSoftLimit &&"),
        "src/LogWriter.cpp:17",
    );
}

#[test]
fn cpp_a_parameter_and_a_local_variable_are_found_exactly() {
    let ws = Workspace::fixture("cpp-logbuf");
    let record = ws.at("src/LogWriter.cpp", "record.source").unwrap();
    assert_eq!(record.basis, Basis::Scope);
    assert_eq!(places(&record), vec!["src/LogWriter.cpp:66"]);
    // Every use of the parameter is inside `append`, which ends before
    // line 100.
    assert!(record.occurrences.len() > 5);
    assert!(record
        .occurrences
        .iter()
        .all(|span| (66..100).contains(&span.line)));

    // `logbuf::FileSink sink(path);` reads like a prototype, and `sink` in
    // `writer(sink, ...)` like a type. Both are the local variable.
    let sink = ws.at("src/main.cpp", "sink, logbuf").unwrap();
    assert_eq!(sink.basis, Basis::Scope);
    assert_eq!(places(&sink), vec!["src/main.cpp:73"]);
}

#[test]
fn go_names_are_found_through_the_type_of_what_they_belong_to() {
    let ws = Workspace::fixture("go-orders");
    let handler = "internal/orders/handler.go";
    leads_to(
        ws.at(handler, "tally(o, Duplicate)"),
        "internal/orders/handler.go:293",
    );
    leads_to(
        ws.at(handler, "Duplicate), nil"),
        "internal/orders/handler.go:66",
    );
    // `o` is an `Order` and `h` a `*Handler`.
    leads_to(
        ws.at(handler, "ID == \"\""),
        "internal/orders/handler.go:34",
    );
    leads_to(
        ws.at(handler, "mode == ModeStopped"),
        "internal/orders/handler.go:89",
    );
    // A function of another package, named with the package in front.
    leads_to(
        ws.at("cmd/intake/main.go", "NewHandler"),
        "internal/orders/handler.go:103",
    );
}

#[test]
fn go_two_equally_likely_definitions_are_both_listed() {
    let ws = Workspace::fixture("go-orders");
    // `h.store` is an interface. Its method and the one implementation
    // have the same name, and nothing here knows which is meant.
    let found = ws.at("internal/orders/handler.go", "WriteBatch").unwrap();
    assert!(!found.certain);
    assert_eq!(found.basis, Basis::Name);
    assert_eq!(
        places(&found),
        vec!["internal/orders/store.go:31", "internal/orders/store.go:55"]
    );
}

#[test]
fn go_references_name_the_definition_and_every_call() {
    let ws = Workspace::fixture("go-orders");
    let (found, done) =
        ws.references("internal/orders/handler.go", "Submit(o Order)");
    let listed: Vec<(String, Role)> = found
        .iter()
        .map(|one| (format!("{}:{}", one.path, one.line), one.role))
        .collect();
    assert_eq!(
        listed,
        vec![
            (
                "internal/orders/handler.go:119".to_string(),
                Role::Definition
            ),
            ("cmd/intake/main.go:64".to_string(), Role::Call),
        ]
    );
    assert!(found[1].text.contains("handler.Submit(o)"));
    assert!(matches!(
        done,
        RefsEvent::Done {
            total: 2,
            files: 2,
            exact: false,
            truncated: false
        }
    ));

    // The uses of a local variable are all in its function, and the list
    // is exact.
    let (found, done) =
        ws.references("internal/orders/handler.go", "o.ID == \"\"");
    assert!(found.len() > 3);
    assert!(found
        .iter()
        .all(|one| one.path == "internal/orders/handler.go"));
    assert!(matches!(done, RefsEvent::Done { exact: true, .. }));
}

#[test]
fn typescript_an_imported_function_is_found_in_the_file_it_comes_from() {
    let ws = Workspace::fixture("ts-uploader");
    let found = ws.at("src/uploader.ts", "decideRetry(attempts)");
    assert_eq!(
        found.as_ref().unwrap().definitions[0].group,
        Group::Imported
    );
    leads_to(found, "src/retry.ts:44");
    let (references, _) = ws.references("src/retry.ts", "decideRetry");
    let listed: Vec<String> = references
        .iter()
        .map(|one| format!("{}:{}", one.path, one.line))
        .collect();
    assert_eq!(
        listed,
        vec![
            "src/retry.ts:44",
            "src/uploader.ts:4",
            "src/uploader.ts:270"
        ]
    );
}

#[test]
fn python_a_field_and_an_imported_class_are_found() {
    let ws = Workspace::fixture("py-ingest");
    leads_to(
        ws.at("ingest/pipeline.py", "_sink.close()"),
        "ingest/pipeline.py:83",
    );
    leads_to(ws.at("ingest/cli.py", "Pipeline("), "ingest/pipeline.py:74");
}

#[test]
fn words_in_comments_and_in_quotes_lead_nowhere() {
    let ws = Workspace::fixture("go-orders");
    let handler = "internal/orders/handler.go";
    // A word in a comment, a word inside quotes and a keyword.
    assert!(ws.at(handler, "Package orders accepts").is_none());
    assert!(ws.at(handler, "pending bytes over hard budget").is_none());
    assert!(ws.at(handler, "package orders").is_none());
    let (found, done) = ws.references(handler, "Package orders accepts");
    assert!(found.is_empty());
    assert!(matches!(done, RefsEvent::Done { total: 0, .. }));
}

#[test]
fn a_language_without_a_parser_is_navigated_as_text() {
    let dir = tempfile::tempdir().unwrap();
    for (file, text) in [
        (
            "lib/invoice.rb",
            "class Invoice\n  def total\n    lines.sum\n  end\nend\n",
        ),
        (
            "lib/report.rb",
            "require_relative 'invoice'\n\ndef print_report(invoice)\n  puts \
             invoice.total\nend\n",
        ),
    ] {
        let path = dir.path().join(file);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }
    let ws = Workspace::open(dir.path());
    let found = ws.at("lib/report.rb", "total").unwrap();
    assert_eq!(found.basis, Basis::Text);
    assert_eq!(found.role, Role::Text);
    assert_eq!(places(&found), vec!["lib/invoice.rb:2"]);
    let (references, _) = ws.references("lib/report.rb", "total");
    let listed: Vec<(String, Role)> = references
        .iter()
        .map(|one| (format!("{}:{}", one.path, one.line), one.role))
        .collect();
    assert_eq!(
        listed,
        vec![
            ("lib/report.rb:4".to_string(), Role::Text),
            ("lib/invoice.rb:2".to_string(), Role::Text),
        ]
    );
}

#[test]
fn svelte_script_and_markup_both_lead_to_definitions() {
    let dir = tempfile::tempdir().unwrap();
    for (file, text) in [
        (
            "src/Row.svelte",
            "<script lang=\"ts\">\n  import { format } from './format';\n  \
             let { label }: { label: string } = $props();\n  function \
             shown() {\n    return format(label);\n  \
             }\n</script>\n\n<span>{shown()} {format(label)}</span>\n",
        ),
        (
            "src/format.ts",
            "export function format(text: string) {\n  return \
             text.trim();\n}\n",
        ),
    ] {
        let path = dir.path().join(file);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }
    let ws = Workspace::open(dir.path());
    // Inside the script the code is parsed.
    let in_script = ws.at("src/Row.svelte", "format(label);").unwrap();
    assert_eq!(in_script.basis, Basis::Name);
    assert_eq!(places(&in_script), vec!["src/format.ts:1"]);
    // In the markup the name is read as text, and still found.
    let in_markup = ws.at("src/Row.svelte", "format(label)}").unwrap();
    assert_eq!(in_markup.basis, Basis::Text);
    assert_eq!(places(&in_markup), vec!["src/format.ts:1"]);
    leads_to(ws.at("src/Row.svelte", "shown()}"), "src/Row.svelte:4");
    // The uses in the script and in the markup are one list.
    let (references, _) = ws.references("src/format.ts", "format");
    assert_eq!(references.len(), 4, "{references:#?}");
}

/// A workspace in a temporary folder that holds `files`, each given as its
/// path and its content. The folder is removed when the first value of the
/// result is dropped.
fn workspace_of(files: &[(&str, &str)]) -> (tempfile::TempDir, Workspace) {
    let dir = tempfile::tempdir().unwrap();
    for (file, text) in files {
        let path = dir.path().join(file);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }
    let ws = Workspace::open(dir.path());
    (dir, ws)
}

/// A C++ workspace in which three classes have a field called `gauge_`. The
/// class `Pump` gets it from `Machine` through `Device`. The class `Bench`,
/// in a folder next to the file of `Pump`, has a field of the same name
/// that has nothing to do with `Pump`.
const CPP_PLANT: &[(&str, &str)] = &[
    (
        "base/Machine.h",
        "namespace plant {\nstruct Reading {\n    int value;\n};\nclass \
         Valve {\npublic:\n    void open();\n};\nclass Machine \
         {\npublic:\n    void start();\nprotected:\n    Reading \
         gauge_;\n};\nclass Device : public Machine {\npublic:\n    void \
         reset();\n};\n}\n",
    ),
    (
        "base/Machine.cpp",
        "#include \"Machine.h\"\nnamespace plant {\nvoid Machine::start() \
         {}\nvoid Device::reset() {}\nvoid Valve::open() {}\n}\n",
    ),
    (
        "pump/Pump.h",
        "#include \"base/Machine.h\"\nclass Pump : public plant::Device \
         {\npublic:\n    void run();\nprivate:\n    plant::Valve \
         inlet_;\n};\n",
    ),
    (
        "pump/Pump.cpp",
        "#include \"Pump.h\"\nvoid Pump::run() {\n    gauge_.value = \
         0;\n    start();\n    inlet_.open();\n    const plant::Reading \
         last = gauge_;\n    (void)last;\n}\n",
    ),
    (
        "pump/test/Bench.h",
        "struct Dial {};\nclass Door {\npublic:\n    void open();\n};\nclass \
         Bench {\npublic:\n    void start();\n    Dial gauge_;\n};\n",
    ),
];

#[test]
fn cpp_a_member_is_found_in_the_base_class_that_declares_it() {
    let (_dir, ws) = workspace_of(CPP_PLANT);
    // `gauge_` stands in a method of `Pump` with nothing in front of it.
    // `Pump` derives from `Device`, which derives from `Machine`.
    let field = ws.at("pump/Pump.cpp", "gauge_.value").unwrap();
    assert!(field.certain, "{field:#?}");
    assert_eq!(field.likely, 1);
    assert_eq!(
        places(&field),
        vec!["base/Machine.h:13", "pump/test/Bench.h:9"]
    );
    assert_eq!(field.definitions[0].group, Group::Inherited);
    assert_eq!(field.definitions[0].container.as_deref(), Some("Machine"));
    // The type written next to the field is offered too.
    assert_eq!(field.type_name.as_deref(), Some("Reading"));
    assert_eq!(field.types[0].line, 2);

    // A method called without anything in front of it is found the same
    // way, body first.
    let call = ws.at("pump/Pump.cpp", "start()").unwrap();
    assert!(call.certain, "{call:#?}");
    assert_eq!(call.likely, 2);
    assert_eq!(
        places(&call)[..2],
        ["base/Machine.cpp:3", "base/Machine.h:11"]
    );
}

#[test]
fn cpp_a_member_is_found_through_the_type_of_a_field() {
    let (_dir, ws) = workspace_of(CPP_PLANT);
    // `inlet_` is a field of `Pump` declared as a `plant::Valve`, so `open`
    // is looked for in `Valve` and not in `Door`.
    let call = ws.at("pump/Pump.cpp", "open()").unwrap();
    assert_eq!(call.definitions[0].group, Group::Owner);
    leads_to(Some(call), "base/Machine.cpp:5");
    // `value` belongs to `gauge_`, which `Pump` inherits as a `Reading`.
    leads_to(ws.at("pump/Pump.cpp", "value = 0"), "base/Machine.h:3");
}

#[test]
fn cpp_the_type_of_a_local_variable_is_offered_with_it() {
    let (_dir, ws) = workspace_of(CPP_PLANT);
    let local = ws.at("pump/Pump.cpp", "last = gauge_").unwrap();
    assert_eq!(local.basis, Basis::Scope);
    assert_eq!(local.type_name.as_deref(), Some("plant::Reading"));
    let types: Vec<String> = local
        .types
        .iter()
        .map(|one| format!("{}:{}", one.path, one.line))
        .collect();
    assert_eq!(types, vec!["base/Machine.h:2"]);
}

#[test]
fn typescript_members_are_found_in_a_base_class_and_through_new() {
    let (_dir, ws) = workspace_of(&[
        (
            "src/base.ts",
            "export class Task {\n  attempts = 0;\n  retry() {\n    \
             this.attempts += 1;\n  }\n}\n",
        ),
        (
            "src/upload.ts",
            "import { Task } from './base';\n\nexport class Upload extends \
             Task {\n  send() {\n    this.retry();\n  }\n}\n\nexport const \
             upload = new Upload();\n",
        ),
        (
            "src/main.ts",
            "import { upload } from './upload';\n\nupload.send();\n",
        ),
        (
            "other/poller.ts",
            "export class Poller {\n  retry() {}\n  send() {}\n}\n",
        ),
    ]);
    let inherited = ws.at("src/upload.ts", "retry()").unwrap();
    assert_eq!(inherited.definitions[0].group, Group::Inherited);
    leads_to(Some(inherited), "src/base.ts:3");
    // `upload` is built with `new Upload()`, so `send` is looked for in
    // `Upload`.
    let through_new = ws.at("src/main.ts", "send()").unwrap();
    assert_eq!(through_new.definitions[0].group, Group::Owner);
    leads_to(Some(through_new), "src/upload.ts:4");
}

#[test]
fn other_languages_follow_what_a_class_derives_from() {
    let (_dir, ws) = workspace_of(&[
        (
            "py/shapes.py",
            "class Shape:\n    def area(self):\n        return 0\n\n\nclass \
             Square(Shape):\n    def describe(self):\n        return \
             self.area()\n\n\nclass Field:\n    def area(self):\n        \
             return 1\n",
        ),
        (
            "java/Shape.java",
            "class Shape {\n    protected int sides;\n}\n\nclass Square \
             extends Shape {\n    int count() {\n        return \
             sides;\n    }\n}\n\nclass Polygon {\n    int sides;\n}\n",
        ),
        (
            "go/shapes.go",
            "package shapes\n\ntype Shape struct{}\n\nfunc (s Shape) Area() \
             int { return 0 }\n\ntype Field struct{}\n\nfunc (f Field) \
             Area() int { return 1 }\n\ntype Square struct {\n\tShape\n}\n\n\
             func describe(sq Square) int {\n\treturn sq.Area()\n}\n",
        ),
        (
            "rust/shapes.rs",
            "trait Shape {\n    fn area(&self) -> u32 {\n        0\n    \
             }\n}\n\nstruct Square;\n\nimpl Shape for Square {}\n\nstruct \
             Field;\n\nimpl Field {\n    fn area(&self) -> u32 {\n        \
             1\n    }\n}\n\nfn describe(square: Square) -> u32 {\n    \
             square.area()\n}\n",
        ),
    ]);
    for (file, code, place) in [
        ("py/shapes.py", "area()", "py/shapes.py:2"),
        ("java/Shape.java", "sides;\n    }", "java/Shape.java:2"),
        ("go/shapes.go", "Area()\n}", "go/shapes.go:5"),
        ("rust/shapes.rs", "area()\n", "rust/shapes.rs:2"),
    ] {
        let found = ws.at(file, code).unwrap();
        assert_eq!(found.definitions[0].group, Group::Inherited, "{file}");
        leads_to(Some(found), place);
    }
}
