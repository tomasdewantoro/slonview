//! Connection profiles persisted as TOML (no passwords) at
//! `~/Library/Application Support/pgview/connections.toml`.
use std::path::{Path, PathBuf};

use crate::model::{ConnId, ConnProfile};
use crate::AppResult;

/// `~/Library/Application Support/pgview` (created if missing).
pub fn app_data_dir() -> AppResult<PathBuf> {
    todo!("WP-CORE-A")
}

/// A fresh profile with defaults: new v4 id, host "localhost", port 5432,
/// ssl Prefer, read_only true, statement_timeout_ms 30000, color None.
pub fn new_profile() -> ConnProfile {
    todo!("WP-CORE-A")
}

pub struct ProfileStore {
    path: PathBuf,
}

impl ProfileStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }
    pub fn path(&self) -> &Path {
        &self.path
    }
    /// Missing file = empty list. Sorted by name (case-insensitive).
    pub fn load(&self) -> AppResult<Vec<ConnProfile>> {
        todo!("WP-CORE-A")
    }
    pub fn get(&self, id: ConnId) -> AppResult<ConnProfile> {
        let _ = id;
        todo!("WP-CORE-A")
    }
    /// Insert or replace by id; atomic write (tmp file + rename). Returns the new list.
    pub fn upsert(&self, profile: ConnProfile) -> AppResult<Vec<ConnProfile>> {
        let _ = profile;
        todo!("WP-CORE-A")
    }
    pub fn delete(&self, id: ConnId) -> AppResult<Vec<ConnProfile>> {
        let _ = id;
        todo!("WP-CORE-A")
    }
}
