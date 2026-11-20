//! Shared DTOs. Every type here is serialized across the Tauri IPC boundary and
//! exported to TypeScript (`src/bindings/`) via ts-rs. Field names are camelCase on the wire.

use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

pub type ConnId = Uuid;
/// Frontend-generated id (uuid string) used for cancellation and stale-response dropping.
pub type RequestId = String;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, Default)]
#[serde(rename_all = "kebab-case")]
#[ts(export)]
pub enum SslMode {
    Disable,
    #[default]
    Prefer,
    Require,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ConnProfile {
    pub id: ConnId,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub user: String,
    pub ssl: SslMode,
    /// When true (default) sessions run `SET default_transaction_read_only = on`.
    pub read_only: bool,
    /// CSS hex color like "#e5484d", purely cosmetic.
    pub color: Option<String>,
    /// Statement timeout in milliseconds; 0 = none. Default 30000.
    pub statement_timeout_ms: u32,
}

/// Result of parsing a `postgres://` URL or a `~/.pgpass` line.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ParsedConn {
    pub profile: ConnProfile,
    pub password: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ServerInfo {
    /// e.g. "PostgreSQL 18.4 (Homebrew) on aarch64-apple-darwin..."
    pub version: String,
    pub database: String,
    pub user: String,
    pub read_only: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export)]
pub enum RelationKind {
    Table,
    View,
    MaterializedView,
    PartitionedTable,
    ForeignTable,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Relation {
    pub schema: String,
    pub name: String,
    pub kind: RelationKind,
    /// `pg_class.reltuples`, -1 when never analyzed.
    #[ts(type = "number")]
    pub est_rows: i64,
    /// `pg_total_relation_size` in bytes.
    #[ts(type = "number")]
    pub size_bytes: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SchemaNode {
    pub name: String,
    pub relations: Vec<Relation>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Column {
    pub name: String,
    /// `format_type(atttypid, atttypmod)`, e.g. "numeric(12,2)", "text[]", "order_status".
    pub type_name: String,
    pub nullable: bool,
    pub is_pk: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ColumnDetail {
    pub name: String,
    pub type_name: String,
    pub nullable: bool,
    pub is_pk: bool,
    pub default: Option<String>,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct IndexInfo {
    pub name: String,
    /// `pg_get_indexdef` output.
    pub definition: String,
    pub is_unique: bool,
    pub is_primary: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ForeignKeyInfo {
    pub name: String,
    /// `pg_get_constraintdef` output, e.g. "FOREIGN KEY (customer_id) REFERENCES customers(id)".
    pub definition: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TableDescription {
    pub schema: String,
    pub name: String,
    pub kind: RelationKind,
    pub columns: Vec<ColumnDetail>,
    pub indexes: Vec<IndexInfo>,
    pub foreign_keys: Vec<ForeignKeyInfo>,
    #[ts(type = "number")]
    pub est_rows: i64,
    #[ts(type = "number")]
    pub size_bytes: i64,
    /// For views/matviews: `pg_get_viewdef`.
    pub view_definition: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum FilterOp {
    #[serde(rename = "=")]
    Eq,
    #[serde(rename = "!=")]
    Ne,
    #[serde(rename = "<")]
    Lt,
    #[serde(rename = "<=")]
    Le,
    #[serde(rename = ">")]
    Gt,
    #[serde(rename = ">=")]
    Ge,
    #[serde(rename = "LIKE")]
    Like,
    #[serde(rename = "ILIKE")]
    ILike,
    #[serde(rename = "IS NULL")]
    IsNull,
    #[serde(rename = "IS NOT NULL")]
    IsNotNull,
    /// `value` is a comma-separated list; each item is quoted as a literal.
    #[serde(rename = "IN")]
    In,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Filter {
    pub column: String,
    pub op: FilterOp,
    /// Ignored for IS NULL / IS NOT NULL. Compared as `col::text op 'value'` is NOT used;
    /// the literal is compared against the column directly so Postgres coerces the type.
    pub value: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Sort {
    pub column: String,
    pub desc: bool,
}

/// Opaque paging position returned by `fetch_page`; frontend passes it back unchanged.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export)]
pub enum Cursor {
    /// Last row's primary-key values as text, in PK column order.
    Keyset { values: Vec<Option<String>> },
    Offset {
        #[ts(type = "number")]
        offset: u64,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PageRequest {
    pub conn_id: ConnId,
    pub schema: String,
    pub table: String,
    pub filters: Vec<Filter>,
    /// Verbatim SQL boolean expression appended with AND; None/empty = unused.
    pub raw_where: Option<String>,
    /// Empty = PK order (keyset paging when a PK exists).
    pub sort: Vec<Sort>,
    /// None = first page.
    pub cursor: Option<Cursor>,
    /// Default 500.
    pub limit: u32,
}

/// Row values are Postgres text output; `None` = SQL NULL. Cells longer than
/// `CELL_TRUNCATE_CHARS` are cut and listed in `truncated` as [rowIndex, colIndex].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Page {
    pub columns: Vec<Column>,
    pub rows: Vec<Vec<Option<String>>>,
    pub truncated: Vec<(u32, u32)>,
    /// None = no more rows.
    pub next_cursor: Option<Cursor>,
    /// The SQL actually executed (shown in the status bar for transparency).
    pub sql: String,
    #[ts(type = "number")]
    pub elapsed_ms: u64,
}

pub const CELL_TRUNCATE_CHARS: usize = 2048;
pub const DEFAULT_PAGE_LIMIT: u32 = 500;
pub const DEFAULT_SQL_MAX_ROWS: u32 = 10_000;

/// Fetch the full (untruncated) value of one cell. Only for relations with a PK;
/// for other relations the frontend shows the truncated value with a notice.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CellRequest {
    pub conn_id: ConnId,
    pub schema: String,
    pub table: String,
    /// PK column names and the row's PK values (text), same order.
    pub pk_columns: Vec<String>,
    pub pk_values: Vec<Option<String>>,
    pub column: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct QueryResult {
    /// The individual statement text this result belongs to.
    pub statement: String,
    /// Empty for statements that return no rows (INSERT/UPDATE/DDL).
    pub columns: Vec<Column>,
    pub rows: Vec<Vec<Option<String>>>,
    /// Command tag row count (e.g. UPDATE 5 -> 5); None for SELECT.
    #[ts(type = "number | null")]
    pub rows_affected: Option<u64>,
    /// True when rows were cut at `max_rows`.
    pub truncated: bool,
    #[ts(type = "number")]
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HistoryEntry {
    pub id: Uuid,
    pub conn_id: ConnId,
    pub sql: String,
    /// RFC 3339 UTC.
    pub executed_at: String,
    #[ts(type = "number")]
    pub elapsed_ms: u64,
    /// None = success.
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export)]
pub enum ExportSource {
    #[serde(rename_all = "camelCase")]
    Table {
        conn_id: ConnId,
        schema: String,
        table: String,
        filters: Vec<Filter>,
        raw_where: Option<String>,
        sort: Vec<Sort>,
    },
    #[serde(rename_all = "camelCase")]
    Sql { conn_id: ConnId, sql: String },
}
