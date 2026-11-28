//! Everything Codjiva does that is not user interface.
//!
//! The Tauri shell in `ui/src-tauri` is a thin layer over this crate: each
//! command it exposes calls one function here. Keeping the logic free of Tauri
//! means it can be tested without starting an app window.

pub mod agents;
pub mod artifacts;
pub mod blame;
pub mod companions;
pub mod compose;
pub mod env;
pub mod error;
pub mod git_diff;
pub mod git_status;
pub mod guard;
pub mod jobs;
pub mod lang;
pub mod names;
pub mod prompts;
pub mod reference;
pub mod scope;
pub mod settings;
pub mod store;
pub mod suggest;
pub mod threads;
pub mod timing;
pub mod util;
pub mod watch;
pub mod workspace;

/// Code navigation: where a name is defined and where it is used. It is a
/// crate of its own because it compiles the parsers of several languages.
pub use codjiva_nav as nav;
pub use error::{AppError, Result};
