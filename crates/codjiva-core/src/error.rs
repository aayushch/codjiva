//! The one error type every command returns.

use serde::Serialize;

/// An error the user interface can show. `code` is a stable, machine-readable name the interface
/// may branch on. `message` is a full sentence for the user. `detail` carries extra technical
/// text, such as the operating system's error, for a "show details" control.
#[derive(Debug, Clone, Serialize, thiserror::Error)]
#[error("{message}")]
pub struct AppError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl AppError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        AppError { code: code.into(), message: message.into(), detail: None }
    }

    pub fn with_detail(mut self, detail: impl ToString) -> Self {
        self.detail = Some(detail.to_string());
        self
    }

    /// Wraps an input/output failure, naming what the app was doing when it happened.
    pub fn io(doing: &str, error: std::io::Error) -> Self {
        let code = match error.kind() {
            std::io::ErrorKind::NotFound => "not_found",
            std::io::ErrorKind::PermissionDenied => "permission_denied",
            _ => "io",
        };
        AppError::new(code, format!("Could not {doing}.")).with_detail(error)
    }
}

pub type Result<T> = std::result::Result<T, AppError>;
