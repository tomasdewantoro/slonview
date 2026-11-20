//! SQL editor execution and cancellation.
use pgview_core::model::{ConnId, QueryResult, RequestId, DEFAULT_SQL_MAX_ROWS};
use pgview_core::AppResult;
use tauri::State;

use crate::state::AppState;

#[tauri::command]
pub async fn run_sql(
    engine: State<'_, AppState>,
    request_id: RequestId,
    conn_id: ConnId,
    sql: String,
    max_rows: Option<u32>,
) -> AppResult<Vec<QueryResult>> {
    engine.run_sql(&request_id, conn_id, &sql, max_rows.unwrap_or(DEFAULT_SQL_MAX_ROWS)).await
}

#[tauri::command]
pub async fn cancel_query(engine: State<'_, AppState>, request_id: RequestId) -> AppResult<()> {
    engine.cancel_query(&request_id).await
}
