//! CSV export, streamed to disk in Rust.
use std::path::Path;

use pgview_core::model::{ExportSource, RequestId};
use pgview_core::{AppError, AppResult};
use tauri::State;

use crate::state::AppState;

#[tauri::command]
pub async fn export_csv(
    engine: State<'_, AppState>,
    request_id: RequestId,
    source: ExportSource,
    path: String,
) -> AppResult<u64> {
    if path.trim().is_empty() {
        return Err(AppError::invalid("export path is required"));
    }
    engine.export_csv(&request_id, &source, Path::new(&path)).await
}
