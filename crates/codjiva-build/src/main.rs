//! Command-line front end of the artifact builder.
//!
//!   - `codjiva-build <source folder> <output.html>`: build an artifact.
//!   - `codjiva-build --api-doc`: print the runtime API reference agents read.
//!   - `codjiva-build --runtime-js`: print the runtime script that gets
//!     inlined.

use std::path::Path;
use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        ["--api-doc"] => {
            print!("{}", codjiva_build::runtime::runtime_api_doc());
            ExitCode::SUCCESS
        }
        ["--runtime-js"] => {
            print!("{}", codjiva_build::runtime::runtime_js());
            ExitCode::SUCCESS
        }
        [src, out] => build(Path::new(src), Path::new(out)),
        _ => {
            eprintln!(
                "usage: codjiva-build <source folder> <output.html>\n       \
                 codjiva-build --api-doc\n       codjiva-build --runtime-js"
            );
            ExitCode::from(2)
        }
    }
}

fn build(src: &Path, out: &Path) -> ExitCode {
    match codjiva_build::build_dir(src) {
        Ok(built) => {
            for warning in &built.warnings {
                eprintln!("{warning}");
            }
            if let Err(e) = std::fs::write(out, &built.html) {
                eprintln!("could not write {}: {e}", out.display());
                return ExitCode::FAILURE;
            }
            println!(
                "built {:?} \"{}\": {} bytes -> {}",
                built.kind,
                built.title,
                built.html.len(),
                out.display()
            );
            ExitCode::SUCCESS
        }
        Err(failure) => {
            for diagnostic in &failure.diagnostics {
                eprintln!("{diagnostic}");
            }
            eprintln!("{failure}");
            ExitCode::FAILURE
        }
    }
}
