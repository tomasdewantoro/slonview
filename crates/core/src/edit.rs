//! Reviewed row edits. SQL is generated here, never accepted from the frontend.
use std::collections::HashSet;
use tokio_postgres::{Client, SimpleQueryMessage};
use crate::{AppError, AppResult, Engine, conn, engine::restore_session, ident::{qualified, quote_ident, quote_literal}, introspect::{self, TableMeta}, model::*};

fn writable(read_only: bool, meta: &TableMeta) -> AppResult<()> {
    if read_only { return Err(AppError::invalid("Read-only mode: turn on Allow writes to edit rows.")); }
    if meta.pk.is_empty() { return Err(AppError::invalid("Row editing requires a primary key.")); }
    Ok(())
}

async fn blocked(client: &Client, schema: &str, table: &str) -> AppResult<Vec<(String, String)>> {
    let rows = client.query("SELECT a.attname::text, a.attgenerated <> '', a.attidentity = 'a', a.atttypid = 'bytea'::regtype FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2 AND a.attnum>0 AND NOT a.attisdropped", &[&schema, &table]).await.map_err(|e| conn::map_query_error(e, false))?;
    Ok(rows.iter().filter_map(|r| {
        let reason = if r.get::<_, bool>(1) { "Generated column" } else if r.get::<_, bool>(2) { "Identity-always column" } else if r.get::<_, bool>(3) { "Binary (bytea) column" } else { return None };
        Some((r.get(0), reason.into()))
    }).collect())
}

fn validate_values(meta: &TableMeta, values: &[EditValue]) -> AppResult<()> {
    let mut seen = HashSet::with_capacity(values.len());
    for v in values {
        meta.column(&v.column)?;
        if !seen.insert(&v.column) { return Err(AppError::invalid("Duplicate edit column")); }
    }
    Ok(())
}
fn literal(value: &Option<String>) -> String { value.as_deref().map(quote_literal).unwrap_or_else(|| "NULL".into()) }
fn predicate(meta: &TableMeta, original: &[EditValue], all: bool) -> AppResult<String> {
    validate_values(meta, original)?;
    for pk in &meta.pk {
        if !original.iter().any(|v| &v.column == pk && v.value.is_some()) { return Err(AppError::invalid(format!("Missing original primary key {pk}"))); }
    }
    if all && (original.len() != meta.columns.len() || meta.columns.iter().any(|c| !original.iter().any(|v| v.column == c.name))) {
        return Err(AppError::invalid("Delete requires all original column values"));
    }
    Ok(original.iter().map(|v| {
        // json has no equality operator; compare its exact PostgreSQL text representation.
        let c = meta.column(&v.column).expect("validated column");
        let col = quote_ident(&v.column);
        let col = if c.type_name == "json" { format!("{col}::text") } else { col };
        format!("{col} IS NOT DISTINCT FROM {}", literal(&v.value))
    }).collect::<Vec<_>>().join(" AND "))
}
fn statements(req: &EditRequest, meta: &TableMeta, blocked: &[(String, String)]) -> AppResult<Vec<String>> {
    if req.changes.is_empty() { return Err(AppError::invalid("No pending changes")); }
    let rel = qualified(&req.schema, &req.table);
    req.changes.iter().map(|change| {
        let values = match change { RowEdit::Update { values, .. } | RowEdit::Insert { values } => Some(values), _ => None };
        if let Some(values) = values {
            validate_values(meta, values)?;
            for v in values {
                if let Some((_, why)) = blocked.iter().find(|(n, _)| n == &v.column) { return Err(AppError::invalid(format!("{}: {why}", v.column))); }
            }
        }
        match change {
            RowEdit::Update { original, values } => {
                if values.is_empty() { return Err(AppError::invalid("Update has no values")); }
                for v in values {
                    if !original.iter().any(|o| o.column == v.column) { return Err(AppError::invalid("Update requires the original value of every changed column")); }
                }
                let cond = predicate(meta, original, false)?;
                let sets = values.iter().map(|v| format!("{} = {}", quote_ident(&v.column), literal(&v.value))).collect::<Vec<_>>().join(", ");
                Ok(format!("UPDATE {rel} SET {sets} WHERE {cond};"))
            }
            RowEdit::Insert { values } => {
                let body = if values.is_empty() { "DEFAULT VALUES".into() } else {
                    format!("({}) VALUES ({})", values.iter().map(|v| quote_ident(&v.column)).collect::<Vec<_>>().join(", "), values.iter().map(|v| literal(&v.value)).collect::<Vec<_>>().join(", "))
                };
                Ok(format!("INSERT INTO {rel} {body} RETURNING {};", meta.pk.iter().map(|p| quote_ident(p)).collect::<Vec<_>>().join(", ")))
            }
            RowEdit::Delete { original } => Ok(format!("DELETE FROM {rel} WHERE {};", predicate(meta, original, true)?)),
        }
    }).collect()
}

impl Engine {
    pub async fn edit_info(&self, conn_id: ConnId, schema: &str, table: &str) -> AppResult<EditInfo> {
        let (session, client) = self.client(conn_id).await?;
        let meta = introspect::table_meta(&client, schema, table).await?;
        Ok(EditInfo { disabled_reason: writable(session.profile.read_only, &meta).err().map(|e| e.to_string()), blocked_columns: blocked(&client, schema, table).await? })
    }

    /// Full originals for editing/deleting: truncated grid values must never be used as originals.
    pub async fn get_edit_row(&self, req: &CellRequest) -> AppResult<Vec<EditValue>> {
        let (session, client) = self.client(req.conn_id).await?;
        let meta = introspect::table_meta(&client, &req.schema, &req.table).await?;
        writable(session.profile.read_only, &meta)?;
        if req.pk_columns != meta.pk || req.pk_values.len() != meta.pk.len() { return Err(AppError::invalid("Primary key mismatch")); }
        let original = req.pk_columns.iter().zip(&req.pk_values).map(|(column, value)| EditValue { column: column.clone(), value: value.clone() }).collect::<Vec<_>>();
        let cond = predicate(&meta, &original, false)?;
        let sql = format!("SELECT {} FROM {} WHERE {cond}", meta.columns.iter().map(|c| format!("{}::text", quote_ident(&c.name))).collect::<Vec<_>>().join(", "), qualified(&req.schema, &req.table));
        let rows = client.simple_query(&sql).await.map_err(|e| conn::map_query_error(e, false))?;
        rows.iter().find_map(|r| if let SimpleQueryMessage::Row(r) = r {
            Some(meta.columns.iter().enumerate().map(|(i, c)| EditValue { column: c.name.clone(), value: r.get(i).map(str::to_owned) }).collect())
        } else { None }).ok_or_else(|| AppError::invalid("Row no longer exists; refresh the table."))
    }

    pub async fn review_edits(&self, req: &EditRequest) -> AppResult<Vec<String>> {
        let (session, client) = self.client(req.conn_id).await?;
        let meta = introspect::table_meta(&client, &req.schema, &req.table).await?;
        writable(session.profile.read_only, &meta)?;
        statements(req, &meta, &blocked(&client, &req.schema, &req.table).await?)
    }

    pub async fn apply_edits(&self, request_id: &str, req: &EditRequest) -> AppResult<u32> {
        let (session, client) = self.client(req.conn_id).await?;
        let meta = introspect::table_meta(&client, &req.schema, &req.table).await?;
        writable(session.profile.read_only, &meta)?;
        let sql = statements(req, &meta, &blocked(&client, &req.schema, &req.table).await?)?;
        let guard = self.cancels.register(request_id, client.cancel_token(), session.transport.clone());
        let outcome = async {
            client.batch_execute("BEGIN").await.map_err(|e| guard.map_err(e))?;
            for (i, statement) in sql.iter().enumerate() {
                let messages = client.simple_query(statement).await.map_err(|e| guard.map_err(e))?;
                let affected = messages.iter().find_map(|m| if let SimpleQueryMessage::CommandComplete(n) = m { Some(*n) } else { None }).unwrap_or(0);
                if affected != 1 {
                    return Err(AppError::invalid(format!("Change {} ({:?}): row changed or was deleted by someone else; the entire batch was rolled back.", i + 1, req.changes[i])));
                }
            }
            client.batch_execute("COMMIT").await.map_err(|e| guard.map_err(e))?;
            Ok(sql.len() as u32)
        }.await;
        drop(guard);
        restore_session(client, &session.profile).await;
        outcome
    }
}
