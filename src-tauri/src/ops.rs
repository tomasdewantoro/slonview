//! Command bodies as plain async fns over `&Engine`. The `#[tauri::command]` wrappers in
//! `commands/*` only extract arguments and call these, so tests and the dev-only E2E bridge
//! (`examples/e2e_bridge.rs`) exercise exactly the code the app runs.
use std::path::Path;

use slonview_core::model::{
    CellRequest, ConnId, ConnProfile, ExportSource, Filter, HistoryEntry, Page, PageRequest, ParsedConn,
    QueryResult, RequestId, SchemaNode, ServerInfo, TableDescription, DEFAULT_SQL_MAX_ROWS,
};
use slonview_core::{connurl, AppError, AppResult, Engine};
use serde_json::Value;

const DEFAULT_HISTORY_LIMIT: u32 = 200;

/// `save_profile`'s `password` argument. A plain `Option<T>` cannot tell a missing key
/// from `null`, so it is read from the raw JSON args:
/// key absent (JS `undefined`) = keep, `null` = delete, string = set.
#[derive(Debug, PartialEq)]
pub enum PasswordUpdate {
    Keep,
    Clear,
    Set(String),
}

impl PasswordUpdate {
    pub fn from_json(value: Option<&Value>) -> Result<Self, String> {
        match value {
            None => Ok(Self::Keep),
            Some(Value::Null) => Ok(Self::Clear),
            Some(Value::String(s)) => Ok(Self::Set(s.clone())),
            Some(other) => Err(format!("password must be a string or null, got {other}")),
        }
    }
}

// Profiles and connections

pub async fn list_profiles(engine: &Engine) -> AppResult<Vec<ConnProfile>> {
    engine.profiles.load()
}

/// Trims `time_zone`; blank means server default (None). Validity is left to Postgres,
/// which rejects unknown names on connect.
fn normalize_profile(mut profile: ConnProfile) -> ConnProfile {
    profile.time_zone = profile.time_zone.map(|tz| tz.trim().to_owned()).filter(|tz| !tz.is_empty());
    profile
}

pub async fn save_profile(engine: &Engine, profile: ConnProfile, password: PasswordUpdate) -> AppResult<Vec<ConnProfile>> {
    if profile.name.trim().is_empty() {
        return Err(AppError::invalid("connection name is required"));
    }
    let profile = normalize_profile(profile);
    let id = profile.id;
    let profiles = engine.profiles.upsert(profile)?;
    match password {
        PasswordUpdate::Keep => {}
        PasswordUpdate::Clear => engine.secrets.delete(id)?,
        PasswordUpdate::Set(p) => engine.secrets.set(id, &p)?,
    }
    Ok(profiles)
}

pub async fn delete_profile(engine: &Engine, id: ConnId) -> AppResult<Vec<ConnProfile>> {
    match engine.disconnect(id).await {
        Ok(()) | Err(AppError::NotConnected) => {}
        Err(e) => return Err(e),
    }
    engine.secrets.delete(id)?;
    engine.profiles.delete(id)
}

pub async fn parse_conn_url(url: &str) -> AppResult<ParsedConn> {
    connurl::parse_conn_url(url)
}

pub async fn import_pgpass() -> AppResult<Vec<ParsedConn>> {
    connurl::read_pgpass()
}

pub async fn test_connection(engine: &Engine, profile: &ConnProfile, password: Option<&str>) -> AppResult<ServerInfo> {
    engine.test_connection(&normalize_profile(profile.clone()), password).await
}

pub async fn connect(engine: &Engine, conn_id: ConnId) -> AppResult<ServerInfo> {
    engine.connect(conn_id).await
}

pub async fn disconnect(engine: &Engine, conn_id: ConnId) -> AppResult<()> {
    engine.disconnect(conn_id).await
}

// Schema

pub async fn list_schema_tree(engine: &Engine, conn_id: ConnId) -> AppResult<Vec<SchemaNode>> {
    engine.list_schema_tree(conn_id).await
}

pub async fn describe_table(engine: &Engine, conn_id: ConnId, schema: &str, table: &str) -> AppResult<TableDescription> {
    engine.describe_table(conn_id, schema, table).await
}

// Data

pub async fn fetch_page(engine: &Engine, request_id: &RequestId, req: &PageRequest) -> AppResult<Page> {
    engine.fetch_page(request_id, req).await
}

pub async fn count_exact(
    engine: &Engine,
    request_id: &RequestId,
    conn_id: ConnId,
    schema: &str,
    table: &str,
    filters: &[Filter],
    raw_where: Option<&str>,
) -> AppResult<i64> {
    engine.count_exact(request_id, conn_id, schema, table, filters, raw_where).await
}

pub async fn get_cell(engine: &Engine, req: &CellRequest) -> AppResult<Option<String>> {
    engine.get_cell(req).await
}

// SQL editor

pub async fn run_sql(
    engine: &Engine,
    request_id: &RequestId,
    conn_id: ConnId,
    sql: &str,
    max_rows: Option<u32>,
) -> AppResult<Vec<QueryResult>> {
    engine.run_sql(request_id, conn_id, sql, max_rows.unwrap_or(DEFAULT_SQL_MAX_ROWS)).await
}

pub async fn cancel_query(engine: &Engine, request_id: &RequestId) -> AppResult<()> {
    engine.cancel_query(request_id).await
}

// Export

pub async fn export_csv(engine: &Engine, request_id: &RequestId, source: &ExportSource, path: &str) -> AppResult<u64> {
    if path.trim().is_empty() {
        return Err(AppError::invalid("export path is required"));
    }
    engine.export_csv(request_id, source, Path::new(path)).await
}

// History

pub async fn list_history(
    engine: &Engine,
    conn_id: Option<ConnId>,
    search: Option<&str>,
    limit: Option<u32>,
) -> AppResult<Vec<HistoryEntry>> {
    engine.history.list(conn_id, search, limit.unwrap_or(DEFAULT_HISTORY_LIMIT) as usize)
}

pub async fn clear_history(engine: &Engine) -> AppResult<()> {
    engine.history.clear()
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use slonview_core::config::ProfileStore;
    use slonview_core::history::HistoryStore;
    use slonview_core::model::{Cursor, FilterOp, Sort};
    use slonview_core::secrets::{MemorySecretStore, SecretStore};
    use serde_json::json;

    use super::*;

    #[test]
    fn password_update_tristate() {
        let args = json!({ "a": null, "b": "s3cret", "c": 5 });
        assert_eq!(PasswordUpdate::from_json(args.get("missing")), Ok(PasswordUpdate::Keep));
        assert_eq!(PasswordUpdate::from_json(args.get("a")), Ok(PasswordUpdate::Clear));
        assert_eq!(PasswordUpdate::from_json(args.get("b")), Ok(PasswordUpdate::Set("s3cret".into())));
        assert!(PasswordUpdate::from_json(args.get("c")).is_err());
    }

    fn engine(dir: &tempfile::TempDir) -> (Engine, Arc<MemorySecretStore>) {
        let secrets = Arc::new(MemorySecretStore::default());
        let engine = Engine::new(
            ProfileStore::new(dir.path().join("connections.toml")),
            secrets.clone(),
            HistoryStore::new(dir.path().join("history.jsonl")),
        );
        (engine, secrets)
    }

    #[tokio::test]
    async fn save_profile_applies_password_update() {
        let dir = tempfile::TempDir::new().unwrap();
        let (engine, secrets) = engine(&dir);
        let mut profile = parse_conn_url("postgres://u@h/db").await.unwrap().profile;
        profile.name = "  ".into();
        assert!(matches!(
            save_profile(&engine, profile.clone(), PasswordUpdate::Keep).await,
            Err(AppError::Invalid { .. })
        ));
        profile.name = "p".into();
        save_profile(&engine, profile.clone(), PasswordUpdate::Set("pw".into())).await.unwrap();
        assert_eq!(secrets.get(profile.id).unwrap().as_deref(), Some("pw"));
        save_profile(&engine, profile.clone(), PasswordUpdate::Keep).await.unwrap();
        assert_eq!(secrets.get(profile.id).unwrap().as_deref(), Some("pw"));
        save_profile(&engine, profile.clone(), PasswordUpdate::Clear).await.unwrap();
        assert_eq!(secrets.get(profile.id).unwrap(), None);
        let toml = std::fs::read_to_string(dir.path().join("connections.toml")).unwrap();
        assert!(!toml.contains("pw"));
        assert_eq!(delete_profile(&engine, profile.id).await.unwrap(), vec![]);
        assert!(matches!(export_csv(&engine, &"r".into(), &ExportSource::Sql { conn_id: profile.id, sql: "select 1".into() }, " ").await, Err(AppError::Invalid { .. })));
    }

    #[tokio::test]
    async fn save_profile_normalizes_time_zone() {
        let dir = tempfile::TempDir::new().unwrap();
        let (engine, _) = engine(&dir);
        let mut profile = parse_conn_url("postgres://u@h/db").await.unwrap().profile;
        profile.time_zone = Some("  Asia/Jakarta \n".into());
        let saved = save_profile(&engine, profile.clone(), PasswordUpdate::Keep).await.unwrap();
        assert_eq!(saved[0].time_zone.as_deref(), Some("Asia/Jakarta"));
        profile.time_zone = Some("   ".into());
        let saved = save_profile(&engine, profile, PasswordUpdate::Keep).await.unwrap();
        assert_eq!(saved[0].time_zone, None);
    }

    /// Every data command against the seeded fixture (tests/fixtures/seed.sql).
    #[tokio::test]
    async fn commands_against_fixture() {
        let url = std::env::var("SLONVIEW_TEST_URL").unwrap_or_else(|_| "postgres://tomas@localhost/slonview_fixture".into());
        let dir = tempfile::TempDir::new().unwrap();
        let (engine, _) = engine(&dir);
        let parsed = parse_conn_url(&url).await.unwrap();
        let mut profile = parsed.profile;
        profile.name = "fixture".into();
        let id = profile.id;
        let password = match parsed.password { Some(p) => PasswordUpdate::Set(p), None => PasswordUpdate::Keep };
        assert_eq!(save_profile(&engine, profile.clone(), password).await.unwrap().len(), 1);
        assert_eq!(list_profiles(&engine).await.unwrap()[0].id, id);
        assert!(test_connection(&engine, &profile, None).await.unwrap().version.contains("PostgreSQL"));
        assert!(matches!(list_schema_tree(&engine, id).await, Err(AppError::NotConnected)));
        connect(&engine, id).await.unwrap();

        let tree = list_schema_tree(&engine, id).await.unwrap();
        assert!(tree.iter().any(|s| s.name == "Sales Data"));
        let desc = describe_table(&engine, id, "public", "orders").await.unwrap();
        assert!(desc.columns.iter().any(|c| c.name == "id" && c.is_pk));

        let req = PageRequest {
            conn_id: id,
            schema: "public".into(),
            table: "orders".into(),
            filters: vec![Filter { column: "status".into(), op: FilterOp::Eq, value: Some("paid".into()) }],
            raw_where: None,
            sort: vec![Sort { column: "id".into(), desc: false }],
            cursor: None,
            limit: 10,
        };
        let page = fetch_page(&engine, &"p".into(), &req).await.unwrap();
        assert_eq!(page.rows.len(), 10);
        assert!(matches!(page.next_cursor, Some(Cursor::Offset { offset: 10 })));
        let n = count_exact(&engine, &"c".into(), id, "public", "orders", &req.filters, None).await.unwrap();
        let psql = run_sql(&engine, &"s".into(), id, "select count(*) from orders where status = 'paid'", None).await.unwrap();
        assert_eq!(psql[0].rows[0][0].as_deref(), Some(n.to_string().as_str()));

        let cell = CellRequest {
            conn_id: id,
            schema: "public".into(),
            table: "orders".into(),
            pk_columns: vec!["id".into()],
            pk_values: vec![page.rows[0][0].clone()],
            column: "status".into(),
        };
        assert_eq!(get_cell(&engine, &cell).await.unwrap().as_deref(), Some("paid"));

        let out = dir.path().join("x.csv");
        let src = ExportSource::Sql { conn_id: id, sql: "select g from generate_series(1,5) g".into() };
        assert_eq!(export_csv(&engine, &"e".into(), &src, out.to_str().unwrap()).await.unwrap(), 5);
        assert_eq!(std::fs::read_to_string(&out).unwrap().lines().count(), 6);

        assert!(cancel_query(&engine, &"nope".into()).await.is_ok());
        let history = list_history(&engine, Some(id), Some("count"), None).await.unwrap();
        assert_eq!(history.len(), 1);
        clear_history(&engine).await.unwrap();
        assert!(list_history(&engine, None, None, None).await.unwrap().is_empty());
        disconnect(&engine, id).await.unwrap();
    }
}
