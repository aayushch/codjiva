//! The `codjiva://` URL scheme, which serves built artifacts to the sandboxed
//! frame.
//!
//! The frame that shows an artifact has no access to the app. It can only load
//! pages from this scheme, and every page is sent with a policy that blocks all
//! network requests.
//!
//! Paths:
//!   - `/reference/film`: the reference film bundled with the app.
//!   - `/reference/visual`: the still visual of the reference plant.
//!   - `/artifact/<id>/<version>`: a built version of an artifact of the open
//!     workspace.

use crate::AppState;
use codjiva_core::artifacts;
use codjiva_core::reference;
use tauri::http::{Response, StatusCode};

fn page(html: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", "text/html; charset=utf-8")
        .header(
            "Content-Security-Policy",
            codjiva_build::CONTENT_SECURITY_POLICY,
        )
        .header("Cache-Control", "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .body(html.as_bytes().to_vec())
        .expect("a response with fixed headers is valid")
}

fn not_found() -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::NOT_FOUND)
        .header("Content-Type", "text/plain; charset=utf-8")
        .body(b"Not found".to_vec())
        .expect("a response with fixed headers is valid")
}

/// Reads the page of `artifact/<id>/<version>` from the open workspace. The id
/// and the version number are checked by the artifact store, so no other file
/// can be reached through this path.
fn artifact_page(state: &AppState, rest: &str) -> Option<String> {
    let (id, version) = rest.split_once('/')?;
    let version: u32 = version.parse().ok()?;
    let workspace = state.workspace().ok()?;
    artifacts::read_page(&workspace, id, version).ok()
}

/// Answers one request. `path` is the path part of the requested URL.
pub fn respond(state: &AppState, path: &str) -> Response<Vec<u8>> {
    let path = path.trim_matches('/');
    match path {
        "reference/film" => page(reference::film_html()),
        "reference/visual" => page(reference::visual_html()),
        _ => match path
            .strip_prefix("artifact/")
            .and_then(|rest| artifact_page(state, rest))
        {
            Some(html) => page(&html),
            None => not_found(),
        },
    }
}
