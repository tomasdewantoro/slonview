//! CSV export, streamed to disk in Rust.
use pgview_core::model::{ExportSource, RequestId};
use pgview_core::AppResult;
use tauri::State;

use crate::ops;
use crate::state::AppState;

#[tauri::command]
pub async fn export_csv(
    engine: State<'_, AppState>,
    request_id: RequestId,
    source: ExportSource,
    path: String,
) -> AppResult<u64> {
    ops::export_csv(&engine, &request_id, &source, &path).await
}
