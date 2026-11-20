//! Ad-hoc SQL execution over the simple query protocol (every value arrives as text).
use std::time::Instant;

use futures_util::{TryStreamExt, pin_mut};
use tokio_postgres::{Client, SimpleQueryMessage};

use crate::conn::CancelGuard;
use crate::model::{Column, QueryResult};
use crate::AppResult;

/// Runs one statement. Normally yields one result; a statement the splitter could
/// not separate yields one result per server-side command.
pub(crate) async fn run_statement(
    client: &Client,
    statement: &str,
    max_rows: u32,
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
                columns = cols
                    .iter()
                    .map(|c| Column { name: c.name().to_owned(), type_name: String::new(), nullable: true, is_pk: false })
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
