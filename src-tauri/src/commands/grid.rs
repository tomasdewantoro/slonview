use crate::{ops, state::AppState};
use slonview_core::model::{
    CellRequest, ColumnCopyChunk, ColumnCopyRequest, ColumnCopySummary, ConnId, EditInfo,
    EditRequest, EditValue,
};
use slonview_core::{AppError, AppResult};
use tauri::{State, ipc::Channel};

#[tauri::command]
pub async fn stream_columns(
    engine: State<'_, AppState>,
    request_id: String,
    req: ColumnCopyRequest,
    on_chunk: Channel<ColumnCopyChunk>,
) -> AppResult<ColumnCopySummary> {
    ops::stream_columns(&engine, &request_id, &req, |chunk| {
        on_chunk
            .send(chunk)
            .map_err(|e| AppError::internal(e.to_string()))
    })
    .await
}

#[tauri::command]
pub async fn edit_info(
    engine: State<'_, AppState>,
    conn_id: ConnId,
    schema: String,
    table: String,
) -> AppResult<EditInfo> {
    ops::edit_info(&engine, conn_id, &schema, &table).await
}

#[tauri::command]
pub async fn get_edit_row(
    engine: State<'_, AppState>,
    req: CellRequest,
) -> AppResult<Vec<EditValue>> {
    ops::get_edit_row(&engine, &req).await
}

#[tauri::command]
pub async fn review_edits(engine: State<'_, AppState>, req: EditRequest) -> AppResult<Vec<String>> {
    ops::review_edits(&engine, &req).await
}

#[tauri::command]
pub async fn apply_edits(
    engine: State<'_, AppState>,
    request_id: String,
    req: EditRequest,
) -> AppResult<u32> {
    ops::apply_edits(&engine, &request_id, &req).await
}
