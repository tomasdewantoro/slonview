//! SQL editor history.
use slonview_core::model::{ConnId, HistoryEntry};
use slonview_core::AppResult;
use tauri::State;

use crate::ops;
use crate::state::AppState;

#[tauri::command]
pub async fn list_history(
    engine: State<'_, AppState>,
    conn_id: Option<ConnId>,
    search: Option<String>,
    limit: Option<u32>,
) -> AppResult<Vec<HistoryEntry>> {
    ops::list_history(&engine, conn_id, search.as_deref(), limit).await
}

#[tauri::command]
pub async fn clear_history(engine: State<'_, AppState>) -> AppResult<()> {
    ops::clear_history(&engine).await
}
