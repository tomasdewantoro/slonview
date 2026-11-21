use crate::{ops, state::AppState};
use slonview_core::AppResult;
use slonview_core::model::{ConnId, ConnProfile, ServerInfo};
use tauri::State;

#[tauri::command]
pub async fn set_time_zone(
    engine: State<'_, AppState>,
    conn_id: ConnId,
    time_zone: Option<String>,
) -> AppResult<Vec<ConnProfile>> {
    ops::set_time_zone(&engine, conn_id, time_zone).await
}

#[tauri::command]
pub async fn save_ssh_secret(
    engine: State<'_, AppState>,
    id: ConnId,
    passphrase: bool,
    value: Option<String>,
) -> AppResult<()> {
    ops::save_ssh_secret(&engine, id, passphrase, value.as_deref()).await
}

#[tauri::command]
pub async fn test_tunnel_connection(
    engine: State<'_, AppState>,
    profile: ConnProfile,
    password: Option<String>,
    ssh_secret: Option<String>,
) -> AppResult<ServerInfo> {
    ops::test_tunnel_connection(
        &engine,
        &profile,
        password.as_deref(),
        ssh_secret.as_deref(),
    )
    .await
}
