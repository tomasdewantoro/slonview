use serde::Serialize;
use ts_rs::TS;

/// Every fallible core function and Tauri command returns `Result<T, AppError>`.
/// Serialized as `{ kind: "...", ... }` so the frontend can switch on `kind`.
#[derive(Debug, Clone, PartialEq, Serialize, thiserror::Error, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export)]
pub enum AppError {
    /// Network / TLS / DNS failure reaching the server.
    #[error("connection failed: {message}")]
    Connect { message: String },
    /// Authentication rejected (SQLSTATE 28xxx).
    #[error("authentication failed: {message}")]
    Auth { message: String },
    /// Server-side SQL error.
    #[error("{message}")]
    Sql {
        /// SQLSTATE, e.g. "25006" for read-only transaction.
        code: String,
        message: String,
        detail: Option<String>,
        hint: Option<String>,
        /// 1-based character position in the statement, if reported.
        position: Option<u32>,
    },
    /// Query cancelled by the user (SQLSTATE 57014 after cancel_query).
    #[error("query cancelled")]
    Cancelled,
    /// statement_timeout fired (SQLSTATE 57014 without a user cancel).
    #[error("query timed out")]
    Timeout,
    /// conn_id not connected (frontend must call `connect` first).
    #[error("not connected")]
    NotConnected,
    /// Unknown profile, missing table, bad input from the frontend.
    #[error("{message}")]
    Invalid { message: String },
    #[error("{message}")]
    Internal { message: String },
}

impl AppError {
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::Invalid { message: message.into() }
    }
    pub fn internal(message: impl Into<String>) -> Self {
        Self::Internal { message: message.into() }
    }
}

pub type AppResult<T> = Result<T, AppError>;
