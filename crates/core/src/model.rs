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
    VerifyCa,
    VerifyFull,
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
    /// IANA time zone (e.g. "Asia/Jakarta") applied with `SET TIME ZONE` to every
    /// session; None = server default. Absent in older connections.toml files.
    #[serde(default)]
    pub time_zone: Option<String>,
    /// Optional PEM CA bundle, added to the system trust roots.
    #[serde(default)]
    pub ssl_root_cert: Option<String>,
    #[serde(default)]
    pub ssh: Option<SshConfig>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SshConfig {
    pub host: String,
    #[serde(default = "ssh_port")]
    pub port: u16,
    pub user: String,
    pub auth: SshAuth,
}

fn ssh_port() -> u16 {
    22
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "kebab-case")]
#[ts(export)]
pub enum SshAuth {
    Agent,
    Key { path: String },
    Password,
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

/// `list_schema_tree` result: per-schema objects plus database-level extensions (which often
/// live in `pg_catalog`, a schema the tree does not show).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SchemaTree {
    pub schemas: Vec<SchemaNode>,
    /// Installed extensions, ordered by name.
    pub extensions: Vec<ExtensionInfo>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SchemaNode {
    pub name: String,
    pub relations: Vec<Relation>,
    /// Functions, procedures and aggregates, ordered by name then identity arguments.
    pub functions: Vec<FunctionInfo>,
    /// Sequences, ordered by name.
    pub sequences: Vec<SequenceInfo>,
    /// Enum, domain and standalone composite types, ordered by name.
    pub types: Vec<TypeInfo>,
    /// User triggers on this schema's tables (not partitions, not internal FK triggers),
    /// ordered by table then trigger name.
    pub triggers: Vec<TriggerInfo>,
}

/// What `get_object_definition` should describe; `oid` is from the matching catalog.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export)]
pub enum ObjectKind {
    Sequence,
    Type,
    Trigger,
    Extension,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SequenceInfo {
    /// `pg_class.oid`.
    #[ts(type = "number")]
    pub oid: u32,
    pub schema: String,
    pub name: String,
    /// `format_type(seqtypid)`: "smallint", "integer" or "bigint".
    pub data_type: String,
    /// False when the session lacks SELECT/USAGE on the sequence (the UI shows "?").
    pub readable: bool,
    /// `pg_sequence_last_value` as decimal text (bigint does not fit a JS number); None when
    /// unreadable or never used.
    pub last_value: Option<String>,
}

/// `pg_type.typtype`: e / d / c (standalone composite types only, not table row types).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export)]
pub enum TypeKind {
    Enum,
    Domain,
    Composite,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TypeInfo {
    /// `pg_type.oid`.
    #[ts(type = "number")]
    pub oid: u32,
    pub schema: String,
    pub name: String,
    pub kind: TypeKind,
    /// One-line summary: enum labels ("a, b, c"), domain base type plus NOT NULL and
    /// constraints, or composite attributes ("x integer, y text").
    pub detail: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export)]
pub enum TriggerTiming {
    Before,
    After,
    InsteadOf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export)]
pub enum TriggerEvent {
    Insert,
    Update,
    Delete,
    Truncate,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TriggerInfo {
    /// `pg_trigger.oid`.
    #[ts(type = "number")]
    pub oid: u32,
    /// Schema of the table the trigger is on.
    pub schema: String,
    pub table: String,
    pub name: String,
    pub timing: TriggerTiming,
    /// In INSERT, UPDATE, DELETE, TRUNCATE order.
    pub events: Vec<TriggerEvent>,
    /// FOR EACH ROW (true) or FOR EACH STATEMENT.
    pub for_each_row: bool,
    /// False when `tgenabled = 'D'`; replica/always modes count as enabled.
    pub enabled: bool,
    /// Trigger function as `schema.name`, quoted where needed.
    pub function: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ExtensionInfo {
    /// `pg_extension.oid`.
    #[ts(type = "number")]
    pub oid: u32,
    pub name: String,
    pub version: String,
    /// Schema holding the extension's objects.
    pub schema: String,
}

/// `pg_proc.prokind`: f / p / a / w.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export)]
pub enum FunctionKind {
    Function,
    Procedure,
    Aggregate,
    Window,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FunctionInfo {
    /// `pg_proc.oid`; the key for `get_function_definition`.
    #[ts(type = "number")]
    pub oid: u32,
    pub schema: String,
    pub name: String,
    /// `pg_get_function_identity_arguments`, e.g. "a integer, b integer"; empty for none.
    pub args: String,
    /// `pg_get_function_result`, e.g. "uuid" or "TABLE(id integer)"; None for procedures.
    pub result: Option<String>,
    pub kind: FunctionKind,
    /// `pg_language.lanname`, e.g. "sql", "plpgsql", "c", "internal".
    pub language: String,
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
    /// The row this column's value points at, when the column alone is a foreign key.
    /// Multi-column foreign keys are not reported here (one value can't identify the row).
    pub references: Option<ForeignKeyTarget>,
}

/// Target of a single-column foreign key.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ForeignKeyTarget {
    pub schema: String,
    pub table: String,
    pub column: String,
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

/// A foreign key in another (or the same) table that points at a table; `list_referencing` result.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ReferencingKey {
    pub constraint_name: String,
    /// Schema and table holding the foreign key.
    pub schema: String,
    pub table: String,
    /// Referencing columns in key order.
    pub columns: Vec<String>,
    /// Columns of the referenced table, in the same order as `columns`.
    pub referenced_columns: Vec<String>,
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
    /// Search term matched with ILIKE against every text-like column (numeric columns too when
    /// the term is a number); None/blank = unused. Built server-side, never verbatim SQL.
    #[serde(default)]
    pub search: Option<String>,
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
    /// First page only, and only when more rows follow: estimated rows matching the request.
    /// `pg_class.reltuples` when unfiltered, otherwise the planner's estimate (`EXPLAIN`,
    /// nothing is executed). None after the first page, with a raw WHERE, for foreign tables,
    /// or when no estimate is available.
    #[ts(type = "number | null")]
    pub est_rows: Option<i64>,
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
        #[serde(default)]
        search: Option<String>,
        sort: Vec<Sort>,
    },
    #[serde(rename_all = "camelCase")]
    Sql { conn_id: ConnId, sql: String },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ColumnCopyRequest {
    pub page: PageRequest,
    pub columns: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ColumnCopyChunk {
    pub rows: Vec<Vec<Option<String>>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ColumnCopySummary {
    pub count: u32,
    pub capped: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EditInfo {
    pub disabled_reason: Option<String>,
    /// Column name and reason; absent columns are editable.
    pub blocked_columns: Vec<(String, String)>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EditValue {
    pub column: String,
    pub value: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export)]
pub enum RowEdit {
    Update {
        original: Vec<EditValue>,
        values: Vec<EditValue>,
    },
    Insert {
        values: Vec<EditValue>,
    },
    Delete {
        original: Vec<EditValue>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EditRequest {
    pub conn_id: ConnId,
    pub schema: String,
    pub table: String,
    pub changes: Vec<RowEdit>,
}
