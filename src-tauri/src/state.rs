//! Builds the shared `Engine` managed by Tauri.
use std::sync::Arc;

use pgview_core::config::{app_data_dir, ProfileStore};
use pgview_core::history::HistoryStore;
use pgview_core::secrets::KeychainStore;
use pgview_core::{AppResult, Engine};

/// Managed state type; commands take `State<'_, AppState>`.
pub type AppState = Arc<Engine>;

/// Engine over `~/Library/Application Support/pgview/{connections.toml,history.jsonl}`
/// with passwords in the macOS Keychain.
pub fn build_engine() -> AppResult<AppState> {
    let dir = app_data_dir()?;
    tracing::info!(dir = %dir.display(), "pgview data directory");
    Ok(Arc::new(Engine::new(
        ProfileStore::new(dir.join("connections.toml")),
        Arc::new(KeychainStore),
        HistoryStore::new(dir.join("history.jsonl")),
    )))
}
