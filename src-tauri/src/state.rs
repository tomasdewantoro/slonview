//! Builds the shared `Engine` managed by Tauri.
use std::sync::Arc;

use slonview_core::config::{ProfileStore, app_data_dir};
use slonview_core::history::HistoryStore;
use slonview_core::secrets::OsSecretStore;
use slonview_core::{AppResult, Engine};

/// Managed state type; commands take `State<'_, AppState>`.
pub type AppState = Arc<Engine>;

/// Engine over `<platform data dir>/slonview/{connections.toml,history.jsonl}`
/// with passwords in the OS credential store.
pub fn build_engine() -> AppResult<AppState> {
    let dir = app_data_dir()?;
    tracing::info!(dir = %dir.display(), "slonview data directory");
    Ok(Arc::new(Engine::new(
        ProfileStore::new(dir.join("connections.toml")),
        Arc::new(OsSecretStore),
        HistoryStore::new(dir.join("history.jsonl")),
    )))
}
