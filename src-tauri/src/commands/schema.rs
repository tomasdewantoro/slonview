//! Schema tree, table description and function definitions.
use slonview_core::model::{ConnId, SchemaNode, TableDescription};
use slonview_core::AppResult;
use tauri::State;

use crate::ops;
use crate::state::AppState;

#[tauri::command]
pub async fn list_schema_tree(engine: State<'_, AppState>, conn_id: ConnId) -> AppResult<Vec<SchemaNode>> {
    ops::list_schema_tree(&engine, conn_id).await
}

#[tauri::command]
pub async fn describe_table(
    engine: State<'_, AppState>,
    conn_id: ConnId,
    schema: String,
    table: String,
) -> AppResult<TableDescription> {
    ops::describe_table(&engine, conn_id, &schema, &table).await
}

#[tauri::command]
pub async fn get_function_definition(engine: State<'_, AppState>, conn_id: ConnId, oid: u32) -> AppResult<String> {
    ops::get_function_definition(&engine, conn_id, oid).await
}
