//! CSV and JSON export, streamed to disk in Rust.
use slonview_core::AppResult;
use slonview_core::model::{ExportFormat, ExportSource, RequestId};
use tauri::State;

use crate::ops;
use crate::state::AppState;

/// `format` absent = CSV.
#[tauri::command]
pub async fn export_csv(
    engine: State<'_, AppState>,
    request_id: RequestId,
    source: ExportSource,
    path: String,
    format: Option<ExportFormat>,
) -> AppResult<u64> {
    ops::export_csv(&engine, &request_id, &source, &path, format).await
}
