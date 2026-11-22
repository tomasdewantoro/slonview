//! Table browsing: pages, exact counts, full cell values.
use slonview_core::AppResult;
use slonview_core::model::{CellRequest, ConnId, Filter, Page, PageRequest, RequestId};
use tauri::State;

use crate::ops;
use crate::state::AppState;

#[tauri::command]
pub async fn fetch_page(
    engine: State<'_, AppState>,
    request_id: RequestId,
    req: PageRequest,
) -> AppResult<Page> {
    ops::fetch_page(&engine, &request_id, &req).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn count_exact(
    engine: State<'_, AppState>,
    request_id: RequestId,
    conn_id: ConnId,
    schema: String,
    table: String,
    filters: Vec<Filter>,
    search: Option<String>,
    raw_where: Option<String>,
) -> AppResult<i64> {
    ops::count_exact(
        &engine,
        &request_id,
        conn_id,
        &schema,
        &table,
        &filters,
        search.as_deref(),
        raw_where.as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn get_cell(engine: State<'_, AppState>, req: CellRequest) -> AppResult<Option<String>> {
    ops::get_cell(&engine, &req).await
}
