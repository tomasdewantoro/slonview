//! Streams a query's rows straight into a file: CSV through `COPY (...) TO STDOUT`, JSON through
//! the simple query protocol one row at a time (the connection reads the next row only after the
//! previous one is written, so memory stays flat whatever the row count).
use std::path::Path;

use futures_util::{TryStreamExt, pin_mut};
use tokio::io::{AsyncWriteExt, BufWriter};
use tokio_postgres::types::Type;
use tokio_postgres::{Client, SimpleQueryMessage};

use crate::conn::CancelGuard;
use crate::model::ExportFormat;
use crate::{AppError, AppResult};

/// Writes `select`'s rows to `path` in `format`; returns data rows written. `types` are the
/// result column types (JSON only; from the prepared statement). A failed export removes the
/// partial file.
pub(crate) async fn export_to_file(
    client: &Client,
    select: &str,
    format: ExportFormat,
    types: &[Type],
    path: &Path,
    guard: &CancelGuard<'_>,
) -> AppResult<u64> {
    let result = match format {
        ExportFormat::Csv => copy_inner(client, select, path, guard).await,
        ExportFormat::Json => json_inner(client, select, types, path, guard).await,
    };
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

async fn create(path: &Path) -> AppResult<BufWriter<tokio::fs::File>> {
    let file = tokio::fs::File::create(path)
        .await
        .map_err(|e| io_err(path, e))?;
    Ok(BufWriter::with_capacity(1 << 20, file))
}

fn io_err(path: &Path, e: std::io::Error) -> AppError {
    AppError::internal(format!("writing {}: {e}", path.display()))
}

async fn finish(mut out: BufWriter<tokio::fs::File>, path: &Path) -> AppResult<()> {
    out.flush().await.map_err(|e| io_err(path, e))?;
    out.into_inner()
        .sync_all()
        .await
        .map_err(|e| io_err(path, e))
}

/// Postgres sends one CopyData message per CSV row (embedded newlines included),
/// so rows = messages - 1 header.
async fn copy_inner(
    client: &Client,
    select: &str,
    path: &Path,
    guard: &CancelGuard<'_>,
) -> AppResult<u64> {
    let copy = copy_sql(select);
    let stream = client
        .copy_out(copy.as_str())
        .await
        .map_err(|e| guard.map_err(e))?;
    pin_mut!(stream);
    let mut out = create(path).await?;
    let mut messages = 0u64;
    while let Some(chunk) = stream.try_next().await.map_err(|e| guard.map_err(e))? {
        out.write_all(&chunk).await.map_err(|e| io_err(path, e))?;
        messages += 1;
    }
    finish(out, path).await?;
    Ok(messages.saturating_sub(1))
}

/// `[` newline, one object per line separated by `,` newline, then `]`. Keys are the column
/// names in column order.
async fn json_inner(
    client: &Client,
    select: &str,
    types: &[Type],
    path: &Path,
    guard: &CancelGuard<'_>,
) -> AppResult<u64> {
    let stream = client
        .simple_query_raw(select)
        .await
        .map_err(|e| guard.map_err(e))?;
    pin_mut!(stream);
    let mut out = create(path).await?;
    out.write_all(b"[").await.map_err(|e| io_err(path, e))?;
    let kinds: Vec<JsonKind> = types.iter().map(JsonKind::of).collect();
    let mut keys: Vec<Vec<u8>> = Vec::new();
    let mut line = Vec::with_capacity(4096);
    let mut rows = 0u64;
    while let Some(message) = stream.try_next().await.map_err(|e| guard.map_err(e))? {
        match message {
            SimpleQueryMessage::RowDescription(columns) => {
                keys = columns
                    .iter()
                    .map(|c| {
                        let mut k = json_string(c.name());
                        k.push(b':');
                        k
                    })
                    .collect();
            }
            SimpleQueryMessage::Row(row) => {
                line.clear();
                line.extend_from_slice(if rows == 0 { b"\n{" } else { b",\n{" });
                for (i, key) in keys.iter().enumerate() {
                    if i > 0 {
                        line.push(b',');
                    }
                    line.extend_from_slice(key);
                    let kind = kinds.get(i).copied().unwrap_or(JsonKind::Text);
                    write_value(&mut line, kind, row.get(i));
                }
                line.push(b'}');
                out.write_all(&line).await.map_err(|e| io_err(path, e))?;
                rows += 1;
            }
            _ => {}
        }
    }
    out.write_all(if rows == 0 { b"]\n" } else { b"\n]\n" })
        .await
        .map_err(|e| io_err(path, e))?;
    finish(out, path).await?;
    Ok(rows)
}

/// How a column's Postgres text output becomes a JSON value.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum JsonKind {
    /// JSON string (every type not listed below).
    Text,
    /// smallint/integer/bigint/oid: a JSON number when exactly representable as f64.
    Integer,
    /// numeric: a JSON number when at most 15 significant digits and inside the f64 range.
    Numeric,
    /// real/double precision: a JSON number unless NaN or ±Infinity.
    Float,
    /// boolean: true/false.
    Bool,
    /// json/jsonb: embedded as JSON.
    Json,
}

impl JsonKind {
    pub(crate) fn of(ty: &Type) -> Self {
        match *ty {
            Type::INT2 | Type::INT4 | Type::INT8 | Type::OID => Self::Integer,
            Type::NUMERIC => Self::Numeric,
            Type::FLOAT4 | Type::FLOAT8 => Self::Float,
            Type::BOOL => Self::Bool,
            Type::JSON | Type::JSONB => Self::Json,
            _ => Self::Text,
        }
    }
}

/// Appends one value (`None` = SQL NULL). Anything that doesn't fit its kind falls back to a
/// JSON string of the Postgres text, so no value is ever lost or altered.
pub(crate) fn write_value(out: &mut Vec<u8>, kind: JsonKind, value: Option<&str>) {
    let Some(v) = value else {
        out.extend_from_slice(b"null");
        return;
    };
    let verbatim = match kind {
        JsonKind::Text => false,
        JsonKind::Integer => is_json_number(v) && fits_f64_exactly(v),
        JsonKind::Numeric => is_json_number(v) && fits_f64_exactly(v),
        JsonKind::Float => is_json_number(v),
        JsonKind::Json => serde_json::from_str::<serde::de::IgnoredAny>(v).is_ok(),
        JsonKind::Bool => {
            match v {
                "t" => out.extend_from_slice(b"true"),
                "f" => out.extend_from_slice(b"false"),
                _ => out.extend_from_slice(&json_string(v)),
            }
            return;
        }
    };
    if verbatim {
        out.extend_from_slice(v.as_bytes());
    } else {
        out.extend_from_slice(&json_string(v));
    }
}

fn json_string(s: &str) -> Vec<u8> {
    serde_json::to_vec(s).expect("serializing a str cannot fail")
}

/// RFC 8259 number grammar: `-? (0 | [1-9][0-9]*) (. [0-9]+)? ([eE] [+-]? [0-9]+)?`.
/// Rejects NaN, Infinity, and forms like `.5`, `1.`, `+1`, `01`.
fn is_json_number(s: &str) -> bool {
    let b = s.as_bytes();
    let mut i = 0;
    let digits = |i: &mut usize| {
        let start = *i;
        while *i < b.len() && b[*i].is_ascii_digit() {
            *i += 1;
        }
        *i - start
    };
    if b.first() == Some(&b'-') {
        i += 1;
    }
    match b.get(i) {
        Some(b'0') => i += 1,
        Some(c) if c.is_ascii_digit() => {
            digits(&mut i);
        }
        _ => return false,
    }
    if b.get(i) == Some(&b'.') {
        i += 1;
        if digits(&mut i) == 0 {
            return false;
        }
    }
    if matches!(b.get(i), Some(b'e' | b'E')) {
        i += 1;
        if matches!(b.get(i), Some(b'+' | b'-')) {
            i += 1;
        }
        if digits(&mut i) == 0 {
            return false;
        }
    }
    i == b.len()
}

/// True when a reader parsing the decimal `s` as an f64 gets the same value back: at most 15
/// significant digits (DBL_DIG) and a finite, non-underflowing magnitude.
fn fits_f64_exactly(s: &str) -> bool {
    let mantissa = s.split(['e', 'E']).next().unwrap_or(s);
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    let significant = digits.trim_start_matches('0').trim_end_matches('0');
    if significant.is_empty() {
        return true; // zero
    }
    if significant.len() > 15 {
        return false;
    }
    matches!(s.parse::<f64>(), Ok(f) if f.is_finite() && f != 0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn value(kind: JsonKind, v: Option<&str>) -> String {
        let mut out = Vec::new();
        write_value(&mut out, kind, v);
        String::from_utf8(out).unwrap()
    }

    fn parsed(kind: JsonKind, v: Option<&str>) -> serde_json::Value {
        serde_json::from_str(&value(kind, v)).unwrap()
    }

    #[test]
    fn null_is_null_for_every_kind() {
        for kind in [
            JsonKind::Text,
            JsonKind::Integer,
            JsonKind::Numeric,
            JsonKind::Float,
            JsonKind::Bool,
            JsonKind::Json,
        ] {
            assert_eq!(value(kind, None), "null");
        }
        // The text 'NULL' is a string, not null.
        assert_eq!(value(JsonKind::Text, Some("NULL")), r#""NULL""#);
    }

    #[test]
    fn text_is_escaped() {
        let tricky = "it's \"quoted\" \\ back\nslash\ttab\u{1}🐘 日本";
        assert_eq!(parsed(JsonKind::Text, Some(tricky)), tricky);
        let raw = value(JsonKind::Text, Some("a\"b\\c\nd"));
        assert_eq!(raw, r#""a\"b\\c\nd""#);
        assert!(!value(JsonKind::Text, Some("x\ny")).contains('\n'));
    }

    #[test]
    fn json_and_jsonb_are_embedded() {
        let v = parsed(
            JsonKind::Json,
            Some(r#"{"a": 1, "nested": {"b": [1, 2, 3]}, "s": "x"}"#),
        );
        assert_eq!(v["nested"]["b"][2], 3);
        assert_eq!(
            parsed(JsonKind::Json, Some(r#""just a string""#)),
            "just a string"
        );
        assert_eq!(parsed(JsonKind::Json, Some("[]")), serde_json::json!([]));
        assert_eq!(
            parsed(JsonKind::Json, Some("null")),
            serde_json::Value::Null
        );
        // Not valid JSON (can't come from Postgres, but never write a broken file).
        assert_eq!(parsed(JsonKind::Json, Some("{oops")), "{oops");
    }

    #[test]
    fn numbers() {
        assert_eq!(value(JsonKind::Integer, Some("-2147483648")), "-2147483648");
        assert_eq!(value(JsonKind::Integer, Some("42")), "42");
        // bigint beyond 2^53 would be rounded by JSON readers: stays a string.
        assert_eq!(
            value(JsonKind::Integer, Some("9223372036854775807")),
            r#""9223372036854775807""#
        );
        assert_eq!(value(JsonKind::Numeric, Some("3.14159")), "3.14159");
        assert_eq!(value(JsonKind::Numeric, Some("-0.000001")), "-0.000001");
        assert_eq!(value(JsonKind::Numeric, Some("0")), "0");
        assert_eq!(value(JsonKind::Numeric, Some("0.000")), "0.000");
        assert_eq!(
            value(JsonKind::Numeric, Some("100000000000000000000")),
            "100000000000000000000"
        );
        assert_eq!(value(JsonKind::Numeric, Some("1.500")), "1.500");
        // More than 15 significant digits loses precision as f64: string.
        assert_eq!(
            value(JsonKind::Numeric, Some("12345678901234567890.123")),
            r#""12345678901234567890.123""#
        );
        assert_eq!(
            value(JsonKind::Numeric, Some("0.1234567890123456")),
            r#""0.1234567890123456""#
        );
        assert_eq!(value(JsonKind::Numeric, Some("NaN")), r#""NaN""#);
        assert_eq!(value(JsonKind::Numeric, Some("Infinity")), r#""Infinity""#);
        let huge = format!("1{}", "0".repeat(400));
        assert_eq!(value(JsonKind::Numeric, Some(&huge)), format!("\"{huge}\""));
        let tiny = format!("0.{}1", "0".repeat(400));
        assert_eq!(value(JsonKind::Numeric, Some(&tiny)), format!("\"{tiny}\""));
    }

    #[test]
    fn floats_keep_nan_and_infinity_as_strings() {
        assert_eq!(value(JsonKind::Float, Some("1.5")), "1.5");
        assert_eq!(value(JsonKind::Float, Some("1e+20")), "1e+20");
        assert_eq!(value(JsonKind::Float, Some("-1.2345e-07")), "-1.2345e-07");
        assert_eq!(
            value(JsonKind::Float, Some("0.30000000000000004")),
            "0.30000000000000004"
        );
        for s in ["NaN", "Infinity", "-Infinity"] {
            assert_eq!(parsed(JsonKind::Float, Some(s)), s);
        }
    }

    #[test]
    fn booleans() {
        assert_eq!(value(JsonKind::Bool, Some("t")), "true");
        assert_eq!(value(JsonKind::Bool, Some("f")), "false");
        assert_eq!(value(JsonKind::Bool, Some("maybe")), r#""maybe""#);
    }

    #[test]
    fn json_number_grammar() {
        for ok in ["0", "-0", "1", "-12.5", "1e5", "1E-5", "2.5e+3"] {
            assert!(is_json_number(ok), "{ok}");
        }
        for bad in [
            "", "-", "01", ".5", "1.", "+1", "1e", "NaN", "1_000", " 1", "0x10",
        ] {
            assert!(!is_json_number(bad), "{bad}");
        }
    }

    #[test]
    fn kinds_from_types() {
        assert_eq!(JsonKind::of(&Type::INT8), JsonKind::Integer);
        assert_eq!(JsonKind::of(&Type::NUMERIC), JsonKind::Numeric);
        assert_eq!(JsonKind::of(&Type::FLOAT4), JsonKind::Float);
        assert_eq!(JsonKind::of(&Type::BOOL), JsonKind::Bool);
        assert_eq!(JsonKind::of(&Type::JSONB), JsonKind::Json);
        assert_eq!(JsonKind::of(&Type::TEXT), JsonKind::Text);
        assert_eq!(JsonKind::of(&Type::INT4_ARRAY), JsonKind::Text);
    }
}
