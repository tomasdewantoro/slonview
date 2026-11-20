//! Facade used by the Tauri layer. Owns connection pools and the cancel registry.
//! All methods are async and safe to call concurrently from many commands.
use std::sync::Arc;

use crate::config::ProfileStore;
use crate::history::HistoryStore;
use crate::model::*;
use crate::secrets::SecretStore;
use crate::AppResult;

pub struct Engine {
    pub profiles: ProfileStore,
    pub secrets: Arc<dyn SecretStore>,
    pub history: HistoryStore,
    // WP-CORE-B adds private fields: pools by ConnId, cancel tokens by RequestId,
    // set of user-cancelled RequestIds (to map 57014 to Cancelled vs Timeout).
}

impl Engine {
    pub fn new(profiles: ProfileStore, secrets: Arc<dyn SecretStore>, history: HistoryStore) -> Self {
        let _ = (profiles, secrets, history);
        todo!("WP-CORE-B")
    }

    /// Connect with an unsaved profile + password; runs `SELECT version()`; closes after.
    pub async fn test_connection(&self, profile: &ConnProfile, password: Option<&str>) -> AppResult<ServerInfo> {
        let _ = (profile, password);
        todo!("WP-CORE-B")
    }

    /// Load profile + Keychain password, build pool (max 4), verify with one query.
    /// Reconnecting replaces any existing pool for this id.
    pub async fn connect(&self, conn_id: ConnId) -> AppResult<ServerInfo> {
        let _ = conn_id;
        todo!("WP-CORE-B")
    }

    pub async fn disconnect(&self, conn_id: ConnId) -> AppResult<()> {
        let _ = conn_id;
        todo!("WP-CORE-B")
    }

    pub async fn list_schema_tree(&self, conn_id: ConnId) -> AppResult<Vec<SchemaNode>> {
        let _ = conn_id;
        todo!("WP-CORE-B")
    }

    pub async fn describe_table(&self, conn_id: ConnId, schema: &str, table: &str) -> AppResult<TableDescription> {
        let _ = (conn_id, schema, table);
        todo!("WP-CORE-B")
    }

    pub async fn fetch_page(&self, request_id: &str, req: &PageRequest) -> AppResult<Page> {
        let _ = (request_id, req);
        todo!("WP-CORE-B")
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
        let _ = (request_id, conn_id, schema, table, filters, raw_where);
        todo!("WP-CORE-B")
    }

    /// Full untruncated text value of one cell; Ok(None) = SQL NULL.
    pub async fn get_cell(&self, req: &CellRequest) -> AppResult<Option<String>> {
        let _ = req;
        todo!("WP-CORE-B")
    }

    /// Runs all statements in `sql` on one pooled client (so SET/BEGIN persist within
    /// the call). Stops at the first error. Appends one HistoryEntry (success or error).
    pub async fn run_sql(&self, request_id: &str, conn_id: ConnId, sql: &str, max_rows: u32) -> AppResult<Vec<QueryResult>> {
        let _ = (request_id, conn_id, sql, max_rows);
        todo!("WP-CORE-B")
    }

    /// No-op if request_id unknown or already finished.
    pub async fn cancel_query(&self, request_id: &str) -> AppResult<()> {
        let _ = request_id;
        todo!("WP-CORE-B")
    }

    /// Streams rows to a CSV file (header row first). Returns data rows written.
    pub async fn export_csv(&self, request_id: &str, source: &ExportSource, path: &std::path::Path) -> AppResult<u64> {
        let _ = (request_id, source, path);
        todo!("WP-CORE-B")
    }
}
