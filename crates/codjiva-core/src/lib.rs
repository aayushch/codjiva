//! Everything Codjiva does that is not user interface.
//!
//! The Tauri shell in `ui/src-tauri` is a thin layer over this crate: each command it exposes
//! calls one function here. Keeping the logic free of Tauri means it can be tested without
//! starting an app window.

pub mod agents;
pub mod artifacts;
pub mod companions;
pub mod compose;
pub mod env;
pub mod error;
pub mod guard;
pub mod jobs;
pub mod lang;
pub mod names;
pub mod prompts;
pub mod reference;
pub mod settings;
pub mod store;
pub mod util;
pub mod watch;
pub mod workspace;

pub use error::{AppError, Result};
