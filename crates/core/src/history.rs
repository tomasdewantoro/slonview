//! SQL editor history as JSONL (one HistoryEntry per line), newest appended last.
use std::path::PathBuf;

use crate::model::{ConnId, HistoryEntry};
use crate::AppResult;

pub const HISTORY_KEEP: usize = 1000;

pub struct HistoryStore {
    path: PathBuf,
}

impl HistoryStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }
    /// Append one line. When the file exceeds 2*HISTORY_KEEP lines, rewrite it keeping
    /// the newest HISTORY_KEEP. Corrupt lines are skipped on read, never fatal.
    pub fn append(&self, entry: &HistoryEntry) -> AppResult<()> {
        let _ = entry;
        todo!("WP-CORE-A")
    }
    /// Newest first. `search` = case-insensitive substring on sql.
    pub fn list(&self, conn_id: Option<ConnId>, search: Option<&str>, limit: usize) -> AppResult<Vec<HistoryEntry>> {
        let _ = (conn_id, search, limit);
        todo!("WP-CORE-A")
    }
    pub fn clear(&self) -> AppResult<()> {
        todo!("WP-CORE-A")
    }
}

/// Current UTC time as RFC 3339, for `HistoryEntry::executed_at`.
pub fn now_rfc3339() -> String {
    todo!("WP-CORE-A")
}
