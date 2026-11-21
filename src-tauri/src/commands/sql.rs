//! SQL editor execution and cancellation.
use slonview_core::AppResult;
use slonview_core::model::{ConnId, QueryResult, RequestId};
use tauri::State;

use crate::ops;
use crate::state::AppState;

#[tauri::command]
pub async fn run_sql(
    engine: State<'_, AppState>,
    request_id: RequestId,
    conn_id: ConnId,
    sql: String,
    max_rows: Option<u32>,
) -> AppResult<Vec<QueryResult>> {
    ops::run_sql(&engine, &request_id, conn_id, &sql, max_rows).await
}

#[tauri::command]
pub async fn cancel_query(engine: State<'_, AppState>, request_id: RequestId) -> AppResult<()> {
    ops::cancel_query(&engine, &request_id).await
}
