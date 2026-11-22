//! v0.3.0 tools: saved queries, server activity, and the manual update check.
use slonview_core::AppResult;
use slonview_core::activity::Activity;
use slonview_core::model::ConnId;
use slonview_core::saved::{SavedQuery, SavedQueryInput};
use slonview_core::update::UpdateStatus;
use tauri::State;

use crate::ops;
use crate::state::AppState;

#[tauri::command]
pub async fn list_saved_queries(
    engine: State<'_, AppState>,
    conn_id: ConnId,
) -> AppResult<Vec<SavedQuery>> {
    ops::list_saved_queries(&engine, conn_id).await
}

#[tauri::command]
pub async fn save_query(
    engine: State<'_, AppState>,
    query: SavedQueryInput,
) -> AppResult<SavedQuery> {
    ops::save_query(&engine, query).await
}

#[tauri::command]
pub async fn rename_saved_query(
    engine: State<'_, AppState>,
    id: uuid::Uuid,
    name: String,
) -> AppResult<SavedQuery> {
    ops::rename_saved_query(&engine, id, name).await
}

#[tauri::command]
pub async fn delete_saved_query(engine: State<'_, AppState>, id: uuid::Uuid) -> AppResult<()> {
    ops::delete_saved_query(&engine, id).await
}

#[tauri::command]
pub async fn list_activity(
    engine: State<'_, AppState>,
    conn_id: ConnId,
    include_idle: bool,
) -> AppResult<Vec<Activity>> {
    ops::list_activity(&engine, conn_id, include_idle).await
}

#[tauri::command]
pub async fn signal_backend(
    engine: State<'_, AppState>,
    conn_id: ConnId,
    pid: i32,
    terminate: bool,
) -> AppResult<bool> {
    ops::signal_backend(&engine, conn_id, pid, terminate).await
}

#[tauri::command]
pub async fn app_version() -> String {
    ops::app_version().to_owned()
}

#[tauri::command]
pub async fn check_for_updates() -> AppResult<UpdateStatus> {
    ops::check_for_updates().await
}

#[tauri::command]
pub async fn open_url(url: String) -> AppResult<()> {
    ops::open_url(&url).await
}
