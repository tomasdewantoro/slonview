//! SQL editor history.
use pgview_core::model::{ConnId, HistoryEntry};
use pgview_core::AppResult;
use tauri::State;

use crate::state::AppState;

const DEFAULT_HISTORY_LIMIT: u32 = 200;

#[tauri::command]
pub async fn list_history(
    engine: State<'_, AppState>,
    conn_id: Option<ConnId>,
    search: Option<String>,
    limit: Option<u32>,
) -> AppResult<Vec<HistoryEntry>> {
    let limit = limit.unwrap_or(DEFAULT_HISTORY_LIMIT) as usize;
    engine.history.list(conn_id, search.as_deref(), limit)
}

#[tauri::command]
pub async fn clear_history(engine: State<'_, AppState>) -> AppResult<()> {
    engine.history.clear()
}
