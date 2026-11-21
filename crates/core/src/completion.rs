//! Catalog data for SQL editor autocomplete: every column of every relation in one query.
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::model::ConnId;
use crate::AppResult;

/// One column of a table, view, materialized view, partitioned or foreign table.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ColumnRef {
    pub schema: String,
    pub table: String,
    pub name: String,
    /// `format_type(atttypid, atttypmod)`, e.g. "numeric(12,2)".
    pub type_name: String,
}

/// Same relations and schemas as the sidebar tree (introspect.rs `schema_tree`).
const COLUMNS_SQL: &str = "
    SELECT n.nspname::text, c.relname::text, a.attname::text, format_type(a.atttypid, a.atttypmod)
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'v', 'm', 'p', 'f') AND NOT c.relispartition
      AND a.attnum > 0 AND NOT a.attisdropped
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp%'
    ORDER BY n.nspname, c.relname, a.attnum";

impl crate::engine::Engine {
    /// All columns in the database, ordered by schema, relation and attnum.
    pub async fn list_columns(&self, conn_id: ConnId) -> AppResult<Vec<ColumnRef>> {
        let (_, client) = self.client(conn_id).await?;
        let rows = client.query(COLUMNS_SQL, &[]).await.map_err(|e| crate::conn::map_query_error(e, false))?;
        Ok(rows
            .into_iter()
            .map(|row| ColumnRef { schema: row.get(0), table: row.get(1), name: row.get(2), type_name: row.get(3) })
            .collect())
    }
}
