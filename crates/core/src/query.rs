//! Ad-hoc SQL execution over the simple query protocol (every value arrives as text).
//! Result column types come from a Parse of the same statement (RowDescription type OIDs
//! and typmods), named with `format_type` through a per-session cache.
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;

use futures_util::{TryStreamExt, pin_mut};
use tokio_postgres::error::SqlState;
use tokio_postgres::{Client, SimpleQueryMessage, Statement};

use crate::conn::CancelGuard;
use crate::model::{Column, QueryResult};
use crate::{AppError, AppResult};

/// `format_type(oid, typmod)` names already looked up on one connected profile.
#[derive(Default)]
pub(crate) struct TypeNames {
    names: Mutex<HashMap<(u32, i32), String>>,
}

impl TypeNames {
    /// Type name per result column of `statement`; one catalog query for any unseen types.
    pub(crate) async fn for_statement(&self, client: &Client, statement: &Statement) -> Result<Vec<String>, tokio_postgres::Error> {
        let keys: Vec<(u32, i32)> = statement.columns().iter().map(|c| (c.type_().oid(), c.type_modifier())).collect();
        let missing: Vec<(u32, i32)> = {
            let names = self.lock();
            let mut missing: Vec<(u32, i32)> = keys.iter().copied().filter(|k| !names.contains_key(k)).collect();
            missing.sort_unstable();
            missing.dedup();
            missing
        };
        if !missing.is_empty() {
            let oids: Vec<u32> = missing.iter().map(|k| k.0).collect();
            let mods: Vec<i32> = missing.iter().map(|k| k.1).collect();
            let rows = client
                .query(
                    "SELECT t.o, t.m, format_type(t.o, t.m) FROM unnest($1::oid[], $2::int4[]) AS t(o, m)",
                    &[&oids, &mods],
                )
                .await?;
            let mut names = self.lock();
            for row in rows {
                let name: Option<String> = row.get(2);
                names.insert((row.get(0), row.get(1)), name.unwrap_or_default());
            }
        }
        let names = self.lock();
        Ok(keys.iter().map(|k| names.get(k).cloned().unwrap_or_default()).collect())
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<(u32, i32), String>> {
        self.names.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// Outside a transaction block this fails harmlessly with 25P01 (no state change).
const DESCRIBE_SAVEPOINT: &str = "SAVEPOINT slonview_describe";

/// Allow-writes mode: result column types for `sql`, or none when the server cannot
/// Parse it on its own (e.g. `$1` placeholders, a piece the splitter could not separate).
/// A failed Parse would abort a transaction the user opened earlier in the script, so
/// inside a transaction block it runs under a savepoint that is rolled back on failure.
/// Only a cancel is reported as an error.
pub(crate) async fn describe_writable(client: &Client, types: &TypeNames, sql: &str, guard: &CancelGuard<'_>) -> AppResult<Vec<String>> {
    let cancelled = |e: &tokio_postgres::Error| e.code() == Some(&SqlState::QUERY_CANCELED);
    let in_transaction = match client.batch_execute(DESCRIBE_SAVEPOINT).await {
        Ok(()) => true,
        Err(e) if e.code() == Some(&SqlState::NO_ACTIVE_SQL_TRANSACTION) => false,
        Err(e) if cancelled(&e) => return Err(guard.map_err(e)),
        // Aborted transaction: the statement itself will report the error.
        Err(_) => return Ok(Vec::new()),
    };
    let described = async {
        let statement = client.prepare(sql).await?;
        types.for_statement(client, &statement).await
    }
    .await;
    if in_transaction {
        let end = if described.is_ok() {
            "RELEASE SAVEPOINT slonview_describe"
        } else {
            "ROLLBACK TO SAVEPOINT slonview_describe; RELEASE SAVEPOINT slonview_describe"
        };
        client.batch_execute(end).await.map_err(|e| guard.map_err(e))?;
    }
    match described {
        Ok(names) => Ok(names),
        Err(e) if cancelled(&e) => Err(guard.map_err(e)),
        Err(_) => Ok(Vec::new()),
    }
}

/// Runs one statement. Normally yields one result; a statement the splitter could
/// not separate yields one result per server-side command. `types` (from a Parse of the
/// same text) names the result columns when its length matches the row description.
pub(crate) async fn run_statement(
    client: &Client,
    statement: &str,
    max_rows: u32,
    types: &[String],
    guard: &CancelGuard<'_>,
) -> AppResult<Vec<QueryResult>> {
    let max_rows = max_rows as usize;
    let mut started = Instant::now();
    let stream = client.simple_query_raw(statement).await.map_err(|e| guard.map_err(e))?;
    pin_mut!(stream);
    let mut results = Vec::new();
    let mut columns: Vec<Column> = Vec::new();
    let mut rows: Vec<Vec<Option<String>>> = Vec::new();
    let mut truncated = false;
    while let Some(msg) = stream.try_next().await.map_err(|e| guard.map_err(e))? {
        match msg {
            SimpleQueryMessage::RowDescription(cols) => {
                let typed = cols.len() == types.len();
                columns = cols
                    .iter()
                    .enumerate()
                    .map(|(i, c)| Column {
                        name: c.name().to_owned(),
                        type_name: if typed { types[i].clone() } else { String::new() },
                        nullable: true,
                        is_pk: false,
                    })
                    .collect();
            }
            SimpleQueryMessage::Row(row) => {
                if rows.len() < max_rows {
                    rows.push((0..row.len()).map(|i| row.get(i).map(str::to_owned)).collect());
                } else {
                    truncated = true;
                }
            }
            SimpleQueryMessage::CommandComplete(n) => {
                let returns_rows = !columns.is_empty();
                results.push(QueryResult {
                    statement: statement.to_owned(),
                    columns: std::mem::take(&mut columns),
                    rows: std::mem::take(&mut rows),
                    rows_affected: if returns_rows { None } else { Some(n) },
                    truncated: std::mem::take(&mut truncated),
                    elapsed_ms: started.elapsed().as_millis() as u64,
                });
                started = Instant::now();
            }
            _ => {}
        }
    }
    Ok(results)
}

/// Server Parse is authoritative about command boundaries. A post-execution
/// check alone is too late if a mis-split piece contains COMMIT followed by writes.
/// Returns the prepared statement so callers can reuse its row description.
pub(crate) async fn require_single_statement(client: &Client, sql: &str, guard: &CancelGuard<'_>) -> AppResult<Statement> {
    client.prepare(sql).await.map_err(|e| guard.map_err(e))
}

const READ_ONLY_STATE: &str = "SELECT current_setting('transaction_read_only'), extract(epoch FROM now())::text";
pub(crate) const READ_ONLY_GUARD_ERROR: &str =
    "Read-only guard: statement left the read-only transaction; it was rolled back.";

/// The SELECT acquires a snapshot, preventing subsequent SET TRANSACTION READ
/// WRITE (including SET transaction_read_only / set_config) from upgrading it.
pub(crate) async fn begin_read_only(client: &Client, guard: &CancelGuard<'_>) -> AppResult<String> {
    client.batch_execute("BEGIN TRANSACTION READ ONLY").await.map_err(|e| guard.map_err(e))?;
    read_only_state(client, guard).await
}

async fn read_only_state(client: &Client, guard: &CancelGuard<'_>) -> AppResult<String> {
    let messages = client.simple_query(READ_ONLY_STATE).await.map_err(|e| guard.map_err(e))?;
    for message in messages {
        if let SimpleQueryMessage::Row(row) = message {
            if row.get(0) == Some("on") && let Some(start) = row.get(1) {
                return Ok(start.to_owned());
            }
            break;
        }
    }
    Err(AppError::internal(READ_ONLY_GUARD_ERROR))
}

pub(crate) async fn verify_read_only(client: &Client, start: &str, guard: &CancelGuard<'_>) -> AppResult<()> {
    if read_only_state(client, guard).await? != start {
        return Err(AppError::internal(READ_ONLY_GUARD_ERROR));
    }
    Ok(())
}
