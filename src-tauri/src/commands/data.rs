//! Table browsing: pages, exact counts, full cell values.
use pgview_core::model::{CellRequest, ConnId, Filter, Page, PageRequest, RequestId};
use pgview_core::AppResult;
use tauri::State;

use crate::state::AppState;

#[tauri::command]
pub async fn fetch_page(engine: State<'_, AppState>, request_id: RequestId, req: PageRequest) -> AppResult<Page> {
    engine.fetch_page(&request_id, &req).await
}

#[tauri::command]
pub async fn count_exact(
    engine: State<'_, AppState>,
    request_id: RequestId,
    conn_id: ConnId,
    schema: String,
    table: String,
    filters: Vec<Filter>,
    raw_where: Option<String>,
) -> AppResult<i64> {
    engine.count_exact(&request_id, conn_id, &schema, &table, &filters, raw_where.as_deref()).await
}

#[tauri::command]
pub async fn get_cell(engine: State<'_, AppState>, req: CellRequest) -> AppResult<Option<String>> {
    engine.get_cell(&req).await
}
