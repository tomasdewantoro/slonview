//! Definitions of sidebar objects: sequences, types, triggers and extensions.
use slonview_core::model::{ConnId, ObjectKind};
use slonview_core::AppResult;
use tauri::State;

use crate::ops;
use crate::state::AppState;

#[tauri::command]
pub async fn get_object_definition(
    engine: State<'_, AppState>,
    conn_id: ConnId,
    kind: ObjectKind,
    oid: u32,
) -> AppResult<String> {
    ops::get_object_definition(&engine, conn_id, kind, oid).await
}
