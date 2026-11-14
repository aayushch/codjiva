//! Timing check against a real, large repository.
//!
//! It only runs when the environment variable `CODJIVA_BIG_REPO` names a folder, and it only
//! reads that folder:
//!
//!   CODJIVA_BIG_REPO=/path/to/repo cargo test -p codjiva-core --test large_repo -- --nocapture

use codjiva_core::workspace::Workspace;
use std::path::Path;
use std::time::{Duration, Instant};

#[test]
fn the_tree_of_a_large_repository_opens_in_under_a_second() {
    let Some(path) = std::env::var_os("CODJIVA_BIG_REPO") else {
        return;
    };
    let began = Instant::now();
    let ws = Workspace::open(Path::new(&path)).expect("the folder opens");
    let top = ws.children("").expect("the root lists");
    let first_dir = top.iter().find(|e| e.rel_path != "node_modules" && format!("{:?}", e.kind) == "Dir");
    let inner = first_dir.map(|d| ws.children(&d.rel_path).expect("a folder lists").len()).unwrap_or(0);
    let listing = began.elapsed();
    println!("root: {} entries, first folder: {} entries, listed in {:?}", top.len(), inner, listing);
    assert!(listing < Duration::from_secs(1), "listing took {listing:?}");

    let began = Instant::now();
    ws.start_indexing();
    while !ws.index_complete() {
        assert!(began.elapsed() < Duration::from_secs(120), "indexing did not finish");
        std::thread::sleep(Duration::from_millis(20));
    }
    let indexing = began.elapsed();
    let began = Instant::now();
    let hits = ws.search_files("esg", 20);
    println!("indexed in {:?}; search for \"esg\" took {:?}; best hits: {:?}", indexing, began.elapsed(), hits.iter().take(3).map(|h| &h.rel_path).collect::<Vec<_>>());
    assert!(began.elapsed() < Duration::from_millis(400), "a search took {:?}", began.elapsed());
}
