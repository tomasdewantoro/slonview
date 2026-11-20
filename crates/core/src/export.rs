//! Streams `COPY (...) TO STDOUT` CSV straight into a file.
use std::path::Path;

use futures_util::{TryStreamExt, pin_mut};
use tokio::io::{AsyncWriteExt, BufWriter};
use tokio_postgres::Client;

use crate::conn::CancelGuard;
use crate::{AppError, AppResult};

/// Writes CSV (with header) for `select` to `path`; returns data rows written.
/// Postgres sends one CopyData message per CSV row (embedded newlines included),
/// so rows = messages - 1 header. A failed export removes the partial file.
pub(crate) async fn copy_to_file(client: &Client, select: &str, path: &Path, guard: &CancelGuard<'_>) -> AppResult<u64> {
    let result = copy_inner(client, select, path, guard).await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(path).await;
    }
    result
}

/// Text placed before the caller's SELECT; error positions shift by its length.
pub(crate) const COPY_PREFIX: &str = "COPY (";

/// The exact COPY statement sent for `select`; also used for the server-side Parse check.
pub(crate) fn copy_sql(select: &str) -> String {
    format!("{COPY_PREFIX}{select}) TO STDOUT WITH (FORMAT csv, HEADER true)")
}

async fn copy_inner(client: &Client, select: &str, path: &Path, guard: &CancelGuard<'_>) -> AppResult<u64> {
    let io_err = |e: std::io::Error| AppError::internal(format!("writing {}: {e}", path.display()));
    let copy = copy_sql(select);
    let stream = client.copy_out(copy.as_str()).await.map_err(|e| guard.map_err(e))?;
    pin_mut!(stream);
    let mut out = BufWriter::with_capacity(1 << 20, tokio::fs::File::create(path).await.map_err(io_err)?);
    let mut messages = 0u64;
    while let Some(chunk) = stream.try_next().await.map_err(|e| guard.map_err(e))? {
        out.write_all(&chunk).await.map_err(io_err)?;
        messages += 1;
    }
    out.flush().await.map_err(io_err)?;
    out.into_inner().sync_all().await.map_err(io_err)?;
    Ok(messages.saturating_sub(1))
}
