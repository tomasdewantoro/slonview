//! Profiles, URL/pgpass parsing, and connection lifecycle.
use slonview_core::model::{ConnId, ConnProfile, ParsedConn, ServerInfo};
use slonview_core::AppResult;
use tauri::ipc::{CommandArg, CommandItem, InvokeBody, InvokeError};
use tauri::{Runtime, State};

use crate::ops::{self, PasswordUpdate};
use crate::state::AppState;

/// Tauri's `Option<T>` cannot tell a missing key from `null`, so this reads the raw payload.
impl<'de, R: Runtime> CommandArg<'de, R> for PasswordUpdate {
    fn from_command(command: CommandItem<'de, R>) -> Result<Self, InvokeError> {
        match command.message.payload() {
            InvokeBody::Json(args) => Self::from_json(args.get(command.key))
                .map_err(|e| InvokeError::from(format!("command {}: {e}", command.name))),
            InvokeBody::Raw(_) => {
                Err(InvokeError::from(format!("command {} expects JSON arguments", command.name)))
            }
        }
    }
}

#[tauri::command]
pub async fn list_profiles(engine: State<'_, AppState>) -> AppResult<Vec<ConnProfile>> {
    ops::list_profiles(&engine).await
}

#[tauri::command]
pub async fn save_profile(
    engine: State<'_, AppState>,
    profile: ConnProfile,
    password: PasswordUpdate,
) -> AppResult<Vec<ConnProfile>> {
    ops::save_profile(&engine, profile, password).await
}

#[tauri::command]
pub async fn delete_profile(engine: State<'_, AppState>, id: ConnId) -> AppResult<Vec<ConnProfile>> {
    ops::delete_profile(&engine, id).await
}

#[tauri::command]
pub async fn parse_conn_url(url: String) -> AppResult<ParsedConn> {
    ops::parse_conn_url(&url).await
}

#[tauri::command]
pub async fn import_pgpass() -> AppResult<Vec<ParsedConn>> {
    ops::import_pgpass().await
}

#[tauri::command]
pub async fn test_connection(
    engine: State<'_, AppState>,
    profile: ConnProfile,
    password: Option<String>,
) -> AppResult<ServerInfo> {
    ops::test_connection(&engine, &profile, password.as_deref()).await
}

#[tauri::command]
pub async fn connect(engine: State<'_, AppState>, conn_id: ConnId) -> AppResult<ServerInfo> {
    ops::connect(&engine, conn_id).await
}

#[tauri::command]
pub async fn disconnect(engine: State<'_, AppState>, conn_id: ConnId) -> AppResult<()> {
    ops::disconnect(&engine, conn_id).await
}
