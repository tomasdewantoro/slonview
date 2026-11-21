use slonview_core::model::{ConnId, ConnProfile};
use slonview_core::AppResult;
use tauri::State;
use crate::{ops, state::AppState};

#[tauri::command]
pub async fn set_time_zone(engine: State<'_, AppState>, conn_id: ConnId, time_zone: Option<String>) -> AppResult<Vec<ConnProfile>> {
    ops::set_time_zone(&engine, conn_id, time_zone).await
}
