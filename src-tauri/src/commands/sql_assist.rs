//! SQL editor assistance: column autocomplete data and EXPLAIN plans.
use slonview_core::completion::ColumnRef;
use slonview_core::explain::ExplainResult;
use slonview_core::model::{ConnId, RequestId};
use slonview_core::AppResult;
use tauri::State;

use crate::ops;
use crate::state::AppState;

#[tauri::command]
pub async fn list_columns(engine: State<'_, AppState>, conn_id: ConnId) -> AppResult<Vec<ColumnRef>> {
    ops::list_columns(&engine, conn_id).await
}

#[tauri::command]
pub async fn explain(
    engine: State<'_, AppState>,
    request_id: RequestId,
    conn_id: ConnId,
    sql: String,
    analyze: bool,
) -> AppResult<ExplainResult> {
    ops::explain(&engine, &request_id, conn_id, &sql, analyze).await
}
