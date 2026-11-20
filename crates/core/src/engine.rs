//! Facade used by the Tauri layer. Owns connection pools and the cancel registry.
//! All methods are async and safe to call concurrently from many commands.
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::Instant;

use deadpool_postgres::{Object, Pool};
use tokio_postgres::{Client, SimpleQueryMessage};

use crate::config::ProfileStore;
use crate::conn::{self, CancelRegistry};
use crate::history::{self, HistoryStore};
use crate::introspect;
use crate::model::*;
use crate::paging::{self, PageMode};
use crate::secrets::SecretStore;
use crate::split::split_statements;
use crate::{AppError, AppResult, export, query};

/// One connected profile.
struct Session {
    profile: ConnProfile,
    pool: Pool,
}

pub struct Engine {
    pub profiles: ProfileStore,
    pub secrets: Arc<dyn SecretStore>,
    pub history: HistoryStore,
    sessions: RwLock<HashMap<ConnId, Arc<Session>>>,
    cancels: CancelRegistry,
}

impl Engine {
    pub fn new(profiles: ProfileStore, secrets: Arc<dyn SecretStore>, history: HistoryStore) -> Self {
        Self { profiles, secrets, history, sessions: RwLock::default(), cancels: CancelRegistry::default() }
    }

    /// Connect with an unsaved profile + password; runs `SELECT version()`; closes after.
    pub async fn test_connection(&self, profile: &ConnProfile, password: Option<&str>) -> AppResult<ServerInfo> {
        let (client, _) = conn::open_client(profile, password).await?;
        client
            .batch_execute(&conn::session_setup_sql(profile))
            .await
            .map_err(conn::map_connect_error)?;
        server_info(&client).await
    }

    /// Load profile + Keychain password, build pool (max 4), verify with one query.
    /// Reconnecting replaces any existing pool for this id.
    pub async fn connect(&self, conn_id: ConnId) -> AppResult<ServerInfo> {
        let profile = self.profiles.get(conn_id)?;
        let password = self.secrets.get(conn_id)?;
        self.connect_with(profile, password.as_deref()).await
    }

    async fn connect_with(&self, profile: ConnProfile, password: Option<&str>) -> AppResult<ServerInfo> {
        // A standalone probe settles which TLS mode works (Prefer may fall back to plain).
        let (probe, ssl) = conn::open_client(&profile, password).await?;
        drop(probe);
        let pool = conn::build_pool(&profile, password, ssl)?;
        let info = {
            let client = pool.get().await.map_err(conn::map_pool_error)?;
            server_info(&client).await?
        };
        let session = Arc::new(Session { profile, pool });
        let previous = self.sessions_write().insert(session.profile.id, session);
        if let Some(old) = previous {
            old.pool.close();
        }
        Ok(info)
    }

    pub async fn disconnect(&self, conn_id: ConnId) -> AppResult<()> {
        if let Some(session) = self.sessions_write().remove(&conn_id) {
            session.pool.close();
        }
        Ok(())
    }

    pub async fn list_schema_tree(&self, conn_id: ConnId) -> AppResult<Vec<SchemaNode>> {
        let (_, client) = self.client(conn_id).await?;
        introspect::schema_tree(&client).await
    }

    pub async fn describe_table(&self, conn_id: ConnId, schema: &str, table: &str) -> AppResult<TableDescription> {
        let (_, client) = self.client(conn_id).await?;
        introspect::describe(&client, schema, table).await
    }

    pub async fn fetch_page(&self, request_id: &str, req: &PageRequest) -> AppResult<Page> {
        let started = Instant::now();
        let (session, client) = self.client(req.conn_id).await?;
        let meta = introspect::table_meta(&client, &req.schema, &req.table).await?;
        let limit = if req.limit == 0 { DEFAULT_PAGE_LIMIT } else { req.limit };
        let q = paging::page_query(req, &meta, limit)?;
        let guard = self.cancels.register(request_id, client.cancel_token());
        let messages = if q.raw_span.is_some() {
            // User text: same protection as the SQL editor, then reset the pooled session.
            let result = raw_where_query(&client, &session.profile, &q.sql, q.raw_span, &guard).await;
            drop(guard);
            restore_session(client, &session.profile).await;
            result?
        } else {
            let messages = client
                .simple_query(&q.sql)
                .await
                .map_err(|e| guard.map_err(e))?;
            drop(guard);
            messages
        };

        let mut rows = Vec::with_capacity(limit as usize + 1);
        let mut truncated = Vec::new();
        for msg in messages {
            let SimpleQueryMessage::Row(row) = msg else { continue };
            let row_index = rows.len() as u32;
            let mut values = Vec::with_capacity(row.len());
            for (col_index, column) in meta.columns.iter().enumerate() {
                let mut value = row.get(col_index).map(str::to_owned);
                if !column.is_pk
                    && let Some(v) = value.as_mut()
                    && truncate_chars(v, CELL_TRUNCATE_CHARS)
                {
                    truncated.push((row_index, col_index as u32));
                }
                values.push(value);
            }
            rows.push(values);
        }

        let has_more = rows.len() > limit as usize;
        if has_more {
            rows.truncate(limit as usize);
            truncated.retain(|(r, _)| *r < limit);
        }
        let next_cursor = match (has_more, q.mode) {
            (false, _) => None,
            (true, PageMode::Keyset) => {
                let last = rows.last().expect("has_more implies rows");
                Some(Cursor::Keyset { values: q.pk_indexes.iter().map(|&i| last[i].clone()).collect() })
            }
            (true, PageMode::Offset(offset)) => Some(Cursor::Offset { offset: offset + u64::from(limit) }),
        };
        Ok(Page {
            columns: meta.grid_columns(),
            rows,
            truncated,
            next_cursor,
            sql: q.sql,
            elapsed_ms: started.elapsed().as_millis() as u64,
        })
    }

    pub async fn count_exact(
        &self,
        request_id: &str,
        conn_id: ConnId,
        schema: &str,
        table: &str,
        filters: &[Filter],
        raw_where: Option<&str>,
    ) -> AppResult<i64> {
        let (session, client) = self.client(conn_id).await?;
        let meta = introspect::table_meta(&client, schema, table).await?;
        let (sql, raw_span) = paging::count_query(schema, table, &meta, filters, raw_where)?;
        let guard = self.cancels.register(request_id, client.cancel_token());
        let messages = if raw_span.is_some() {
            let result = raw_where_query(&client, &session.profile, &sql, raw_span, &guard).await;
            drop(guard);
            restore_session(client, &session.profile).await;
            result?
        } else {
            client.simple_query(&sql).await.map_err(|e| guard.map_err(e))?
        };
        first_value(&messages)
            .flatten()
            .and_then(|v| v.parse().ok())
            .ok_or_else(|| AppError::internal("count(*) returned no value"))
    }

    /// Full untruncated text value of one cell; Ok(None) = SQL NULL.
    pub async fn get_cell(&self, req: &CellRequest) -> AppResult<Option<String>> {
        let (_, client) = self.client(req.conn_id).await?;
        let meta = introspect::table_meta(&client, &req.schema, &req.table).await?;
        let sql = paging::cell_query(&req.schema, &req.table, &meta, &req.pk_columns, &req.pk_values, &req.column)?;
        let messages = client.simple_query(&sql).await.map_err(|e| conn::map_query_error(e, false))?;
        first_value(&messages).ok_or_else(|| AppError::invalid("row not found (it may have been deleted)"))
    }

    /// Runs all statements in `sql` on one pooled client (so SET/BEGIN persist within
    /// the call). Stops at the first error. Appends one HistoryEntry (success or error).
    pub async fn run_sql(&self, request_id: &str, conn_id: ConnId, sql: &str, max_rows: u32) -> AppResult<Vec<QueryResult>> {
        let started = Instant::now();
        let result = self.run_sql_inner(request_id, conn_id, sql, max_rows).await;
        self.log_history(HistoryEntry {
            id: uuid::Uuid::new_v4(),
            conn_id,
            sql: sql.to_owned(),
            executed_at: history::now_rfc3339(),
            elapsed_ms: started.elapsed().as_millis() as u64,
            error: result.as_ref().err().map(ToString::to_string),
        });
        result
    }

    async fn run_sql_inner(&self, request_id: &str, conn_id: ConnId, sql: &str, max_rows: u32) -> AppResult<Vec<QueryResult>> {
        let statements = split_statements(sql);
        if statements.is_empty() {
            return Err(AppError::invalid("nothing to run"));
        }
        let (session, client) = self.client(conn_id).await?;
        let guard = self.cancels.register(request_id, client.cancel_token());
        let outcome = async {
            if session.profile.read_only {
                // Preflight the entire script before any user command runs.
                for st in &statements { reject_read_only(st)?; }
            }
            let transaction = if session.profile.read_only {
                Some(query::begin_read_only(&client, &guard).await?)
            } else { None };
            let mut results = Vec::with_capacity(statements.len());
            for st in &statements {
                let result = async {
                    if transaction.is_some() {
                        query::require_single_statement(&client, &st.text, &guard).await?;
                    }
                    let r = query::run_statement(&client, &st.text, max_rows, &guard).await?;
                    if let Some(start) = &transaction {
                        if r.len() > 1 { return Err(AppError::internal(query::READ_ONLY_GUARD_ERROR)); }
                        query::verify_read_only(&client, start, &guard).await?;
                    }
                    Ok(r)
                }.await;
                match result {
                    Ok(mut r) => results.append(&mut r),
                    Err(mut e) => {
                        if let AppError::Sql { position: Some(p), .. } = &mut e {
                            *p += st.char_offset as u32;
                        }
                        return Err(e);
                    }
                }
            }
            Ok(results)
        }.await;
        drop(guard);
        // ROLLBACK always ends the wrapper, including aborted/cancelled runs;
        // RESET ALL and profile setup then clean the pooled session as before.
        restore_session(client, &session.profile).await;
        outcome
    }

    /// No-op if request_id unknown or already finished.
    pub async fn cancel_query(&self, request_id: &str) -> AppResult<()> {
        let Some(token) = self.cancels.begin_cancel(request_id) else {
            return Ok(());
        };
        token
            .cancel_query(conn::tls())
            .await
            .map_err(|e| AppError::Connect { message: format!("sending cancel request: {e}") })
    }

    /// Streams rows to a CSV file (header row first). Returns data rows written.
    pub async fn export_csv(&self, request_id: &str, source: &ExportSource, path: &std::path::Path) -> AppResult<u64> {
        let conn_id = match source {
            ExportSource::Table { conn_id, .. } | ExportSource::Sql { conn_id, .. } => *conn_id,
        };
        let (session, client) = self.client(conn_id).await?;
        // `span` locates the user's own text (raw WHERE, or the whole SQL statement) in `select`.
        let (select, span) = match source {
            ExportSource::Table { schema, table, filters, raw_where, sort, .. } => {
                let meta = introspect::table_meta(&client, schema, table).await?;
                paging::export_query(schema, table, &meta, filters, raw_where.as_deref(), sort)?
            }
            ExportSource::Sql { sql, .. } => {
                let mut statements = split_statements(sql);
                if statements.len() != 1 {
                    return Err(AppError::invalid("export needs exactly one SQL statement"));
                }
                let statement = statements.remove(0);
                if session.profile.read_only { reject_read_only(&statement)?; }
                let span = paging::RawSpan { start: 0, chars: statement.text.chars().count() };
                (statement.text, Some(span))
            }
        };
        let guard = self.cancels.register(request_id, client.cancel_token());
        let result = async {
            // A long export must not hit the interactive statement_timeout.
            client.batch_execute("SET statement_timeout = 0").await.map_err(|e| guard.map_err(e))?;
            let transaction = if session.profile.read_only {
                Some(query::begin_read_only(&client, &guard).await?)
            } else { None };
            let copy = export::copy_sql(&select);
            query::require_single_statement(&client, &copy, &guard).await.map_err(|e| {
                let e = paging::RawSpan::relocate(span.map(|s| s.shifted(export::COPY_PREFIX)), e);
                if matches!(source, ExportSource::Table { .. }) { raw_expression_error(None, e) } else { e }
            })?;
            let rows = export::copy_to_file(&client, &select, path, &guard)
                .await.map_err(|e| paging::RawSpan::relocate(span.map(|s| s.shifted(export::COPY_PREFIX)), e))?;
            if let Some(start) = &transaction
                && let Err(e) = query::verify_read_only(&client, start, &guard).await
            {
                let _ = tokio::fs::remove_file(path).await;
                return Err(e);
            }
            Ok(rows)
        }.await;
        drop(guard);
        restore_session(client, &session.profile).await;
        result
    }

    fn sessions_write(&self) -> std::sync::RwLockWriteGuard<'_, HashMap<ConnId, Arc<Session>>> {
        self.sessions.write().unwrap_or_else(|e| e.into_inner())
    }

    async fn client(&self, conn_id: ConnId) -> AppResult<(Arc<Session>, Object)> {
        let session = self
            .sessions
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .get(&conn_id)
            .cloned()
            .ok_or(AppError::NotConnected)?;
        let client = session.pool.get().await.map_err(conn::map_pool_error)?;
        Ok((session, client))
    }

    fn log_history(&self, entry: HistoryEntry) {
        if let Err(e) = self.history.append(&entry) {
            tracing::warn!("failed to append query history: {e}");
        }
    }
}

fn reject_read_only(statement: &crate::split::Statement) -> AppResult<()> {
    if let Some(keyword) = crate::split::read_only_rejection(&statement.text) {
        return Err(AppError::invalid_at(
            format!("Read-only mode: command ({keyword}) is not allowed. Turn on “Allow writes” for this connection to run it."),
            statement.char_offset as u32 + 1,
        ));
    }
    Ok(())
}

fn raw_expression_error(span: Option<paging::RawSpan>, e: AppError) -> AppError {
    let mut e = paging::RawSpan::relocate(span, e);
    if let AppError::Sql { code, message, .. } = &mut e
        && code == "42601" && message.contains("multiple commands")
    {
        *message = "Raw WHERE must be a single expression; multiple SQL commands are not allowed.".into();
    }
    e
}

/// Runs a browse/count query that embeds the user's Raw WHERE text. The server Parse
/// check rejects multi-command text in every mode. In read-only mode the query runs
/// inside a READ ONLY transaction (so a GUC change in the expression can't enable
/// writes); callers always reset the pooled session afterwards.
async fn raw_where_query(
    client: &Client,
    profile: &ConnProfile,
    sql: &str,
    span: Option<paging::RawSpan>,
    guard: &conn::CancelGuard<'_>,
) -> AppResult<Vec<SimpleQueryMessage>> {
    query::require_single_statement(client, sql, guard)
        .await
        .map_err(|e| raw_expression_error(span, e))?;
    if profile.read_only {
        query::begin_read_only(client, guard).await?;
    }
    client
        .simple_query(sql)
        .await
        .map_err(|e| paging::RawSpan::relocate(span, guard.map_err(e)))
}

async fn server_info(client: &Client) -> AppResult<ServerInfo> {
    let row = client
        .query_one(
            "SELECT version(), current_database()::text, current_user::text,
                    current_setting('default_transaction_read_only') = 'on'",
            &[],
        )
        .await
        .map_err(|e| conn::map_query_error(e, false))?;
    Ok(ServerInfo { version: row.get(0), database: row.get(1), user: row.get(2), read_only: row.get(3) })
}

/// Ends any transaction the user left open and undoes their SETs, re-applying the
/// profile's session settings. A session that cannot be reset is dropped from the pool.
async fn restore_session(client: Object, profile: &ConnProfile) {
    let reset = format!("ROLLBACK; RESET ALL; {}", conn::session_setup_sql(profile));
    if let Err(e) = client.batch_execute(&reset).await {
        tracing::warn!("discarding session that failed to reset: {e}");
        drop(Object::take(client));
    }
}

/// First column of the first row: None = no rows, Some(None) = SQL NULL.
fn first_value(messages: &[SimpleQueryMessage]) -> Option<Option<String>> {
    messages.iter().find_map(|m| match m {
        SimpleQueryMessage::Row(row) => Some(row.get(0).map(str::to_owned)),
        _ => None,
    })
}

/// Cuts `s` to `max` chars; returns whether anything was removed.
fn truncate_chars(s: &mut String, max: usize) -> bool {
    match s.char_indices().nth(max) {
        Some((byte, _)) => {
            s.truncate(byte);
            true
        }
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::truncate_chars;

    #[test]
    fn truncates_on_char_boundaries() {
        let mut s = "ñ".repeat(5);
        assert!(!truncate_chars(&mut s, 5));
        assert!(truncate_chars(&mut s, 3));
        assert_eq!(s, "ñññ");
    }
}
