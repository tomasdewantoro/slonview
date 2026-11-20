//! Profiles, URL/pgpass parsing, and connection lifecycle.
use pgview_core::model::{ConnId, ConnProfile, ParsedConn, ServerInfo};
use pgview_core::{connurl, AppError, AppResult};
use serde_json::Value;
use tauri::ipc::{CommandArg, CommandItem, InvokeBody, InvokeError};
use tauri::{Runtime, State};

use crate::state::AppState;

/// `save_profile`'s `password` argument. Tauri's `Option<T>` cannot tell a missing key
/// from `null`, so this reads the raw invoke payload:
/// key absent (JS `undefined`) = keep, `null` = delete, string = set.
#[derive(Debug, PartialEq)]
pub enum PasswordUpdate {
    Keep,
    Clear,
    Set(String),
}

impl PasswordUpdate {
    fn from_json(value: Option<&Value>) -> Result<Self, String> {
        match value {
            None => Ok(Self::Keep),
            Some(Value::Null) => Ok(Self::Clear),
            Some(Value::String(s)) => Ok(Self::Set(s.clone())),
            Some(other) => Err(format!("password must be a string or null, got {other}")),
        }
    }
}

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
    engine.profiles.load()
}

#[tauri::command]
pub async fn save_profile(
    engine: State<'_, AppState>,
    profile: ConnProfile,
    password: PasswordUpdate,
) -> AppResult<Vec<ConnProfile>> {
    if profile.name.trim().is_empty() {
        return Err(AppError::invalid("connection name is required"));
    }
    let id = profile.id;
    let profiles = engine.profiles.upsert(profile)?;
    match password {
        PasswordUpdate::Keep => {}
        PasswordUpdate::Clear => engine.secrets.delete(id)?,
        PasswordUpdate::Set(p) => engine.secrets.set(id, &p)?,
    }
    Ok(profiles)
}

#[tauri::command]
pub async fn delete_profile(engine: State<'_, AppState>, id: ConnId) -> AppResult<Vec<ConnProfile>> {
    match engine.disconnect(id).await {
        Ok(()) | Err(AppError::NotConnected) => {}
        Err(e) => return Err(e),
    }
    engine.secrets.delete(id)?;
    engine.profiles.delete(id)
}

#[tauri::command]
pub async fn parse_conn_url(url: String) -> AppResult<ParsedConn> {
    connurl::parse_conn_url(&url)
}

#[tauri::command]
pub async fn import_pgpass() -> AppResult<Vec<ParsedConn>> {
    connurl::read_pgpass()
}

#[tauri::command]
pub async fn test_connection(
    engine: State<'_, AppState>,
    profile: ConnProfile,
    password: Option<String>,
) -> AppResult<ServerInfo> {
    engine.test_connection(&profile, password.as_deref()).await
}

#[tauri::command]
pub async fn connect(engine: State<'_, AppState>, conn_id: ConnId) -> AppResult<ServerInfo> {
    engine.connect(conn_id).await
}

#[tauri::command]
pub async fn disconnect(engine: State<'_, AppState>, conn_id: ConnId) -> AppResult<()> {
    engine.disconnect(conn_id).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn password_update_tristate() {
        let args = json!({ "a": null, "b": "s3cret", "c": 5 });
        assert_eq!(PasswordUpdate::from_json(args.get("missing")), Ok(PasswordUpdate::Keep));
        assert_eq!(PasswordUpdate::from_json(args.get("a")), Ok(PasswordUpdate::Clear));
        assert_eq!(PasswordUpdate::from_json(args.get("b")), Ok(PasswordUpdate::Set("s3cret".into())));
        assert!(PasswordUpdate::from_json(args.get("c")).is_err());
    }
}
