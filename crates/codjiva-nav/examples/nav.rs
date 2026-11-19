//! Asks the navigation crate about a folder from the command line, for
//! trying a query file or a ranking rule without starting the app.
//!
//!   nav <folder> at <file> <text> [nth]   what the name at the nth place
//!                                          (from 0) of <text> in <file> is
//!   nav <folder> refs <file> <text> [nth] where that name is used
//!   nav <folder> find <query>             definitions by name
//!
//! `<text>` is a piece of the file's code. The name looked up is the one
//! its first character belongs to.

use codjiva_nav::{lookup, references, Index, RefsEvent, Target};
use ignore::WalkBuilder;
use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [folder, command, rest @ ..] = args.as_slice() else {
        eprintln!("usage: nav <folder> at|refs|find ...");
        std::process::exit(2);
    };
    let root = Path::new(folder).canonicalize().expect("the folder exists");
    let files: Vec<String> = WalkBuilder::new(&root)
        .hidden(false)
        .build()
        .flatten()
        .filter(|item| item.file_type().is_some_and(|kind| kind.is_file()))
        .filter_map(|item| {
            let rel = item.path().strip_prefix(&root).ok()?;
            Some(rel.to_string_lossy().replace('\\', "/"))
        })
        .collect();
    let index = Index::new(&root);
    let began = Instant::now();
    index.refresh(files.clone());
    eprintln!("indexed {} files in {:?}", files.len(), began.elapsed());
    // The line and column of the nth place of `text` in `file`.
    let place = |file: &str, text: &str, nth: usize| -> (u32, u32) {
        let content = std::fs::read_to_string(root.join(file))
            .expect("the file can be read");
        let at = content
            .match_indices(text)
            .nth(nth)
            .expect("the text is in the file")
            .0;
        let line_start = content[..at].rfind('\n').map_or(0, |i| i + 1);
        (
            content[..at].matches('\n').count() as u32 + 1,
            content[line_start..at].encode_utf16().count() as u32,
        )
    };
    let nth =
        |rest: &[String]| rest.get(2).and_then(|n| n.parse().ok()).unwrap_or(0);
    match (command.as_str(), rest) {
        ("at", [file, text, ..]) => {
            let (line, column) = place(file, text, nth(rest));
            let began = Instant::now();
            match lookup(&index, file, line, column, false) {
                None => println!("nothing to navigate from at {line}:{column}"),
                Some(found) => {
                    println!(
                        "{} at {}:{} is a {:?}, found by {:?}, {} places in \
                         this file, {} ({:?})",
                        found.name,
                        found.line,
                        found.column,
                        found.role,
                        found.basis,
                        found.occurrences.len(),
                        if found.certain {
                            "certain"
                        } else {
                            "not certain"
                        },
                        began.elapsed(),
                    );
                    let show = |one: &Target, name: &str| {
                        println!(
                            "  {:?} {:?}{} {}{}  {}:{}  {}",
                            one.group,
                            one.kind,
                            if one.declaration { " prototype" } else { "" },
                            one.container
                                .as_ref()
                                .map(|c| format!("{c}."))
                                .unwrap_or_default(),
                            name,
                            one.path,
                            one.line,
                            one.text.trim(),
                        );
                    };
                    // A line of dashes separates the definitions the code
                    // points to from those that only have the same name.
                    for (at, one) in found.definitions.iter().enumerate() {
                        if at == found.likely {
                            println!("  ----");
                        }
                        show(one, &found.name);
                    }
                    if let Some(type_name) = &found.type_name {
                        println!("its type is {type_name}");
                        for one in &found.types {
                            show(one, "");
                        }
                    }
                }
            }
        }
        ("refs", [file, text, ..]) => {
            let (line, column) = place(file, text, nth(rest));
            let began = Instant::now();
            let cancel = AtomicBool::new(false);
            references(&index, file, line, column, &cancel, &mut |event| {
                match event {
                    RefsEvent::Found { references } => {
                        for one in references {
                            println!(
                                "  {:?}  {}:{}:{}  {}",
                                one.role,
                                one.path,
                                one.line,
                                one.column,
                                one.text.trim()
                            );
                        }
                    }
                    RefsEvent::Done {
                        total,
                        files,
                        exact,
                        truncated,
                    } => println!(
                        "{total} references in {files} files{}{} ({:?})",
                        if exact { ", exact" } else { "" },
                        if truncated { ", cut short" } else { "" },
                        began.elapsed(),
                    ),
                }
            });
        }
        ("find", [query, ..]) => {
            for hit in index.search(query, 30) {
                println!(
                    "  {:?} {}{}  {}:{}",
                    hit.kind,
                    hit.container.map(|c| format!("{c}.")).unwrap_or_default(),
                    hit.name,
                    hit.path,
                    hit.line
                );
            }
        }
        _ => eprintln!("usage: nav <folder> at|refs|find ..."),
    }
}
