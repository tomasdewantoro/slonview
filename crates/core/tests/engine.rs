//! Integration tests against the seeded fixture DB (tests/fixtures/seed.sql).
//! `SLONVIEW_TEST_URL` overrides the default `postgres://tomas@localhost/slonview_fixture`.
use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, Instant};

use slonview_core::config::ProfileStore;
use slonview_core::connurl::parse_conn_url;
use slonview_core::history::HistoryStore;
use slonview_core::model::*;
use slonview_core::secrets::{MemorySecretStore, SecretStore};
use slonview_core::{AppError, Engine};
use tempfile::TempDir;

struct Fixture {
    engine: Arc<Engine>,
    conn: ConnId,
    _dir: TempDir,
}

fn test_url() -> String {
    std::env::var("SLONVIEW_TEST_URL").unwrap_or_else(|_| "postgres://tomas@localhost/slonview_fixture".into())
}

async fn fixture_with(edit: impl FnOnce(&mut ConnProfile)) -> Fixture {
    let dir = TempDir::new().unwrap();
    let parsed = parse_conn_url(&test_url()).unwrap();
    let mut profile = parsed.profile;
    edit(&mut profile);
    let secrets: Arc<dyn SecretStore> = Arc::new(MemorySecretStore::default());
    if let Some(pw) = &parsed.password {
        secrets.set(profile.id, pw).unwrap();
    }
    let profiles = ProfileStore::new(dir.path().join("connections.toml"));
    profiles.upsert(profile.clone()).unwrap();
    let engine = Arc::new(Engine::new(profiles, secrets, HistoryStore::new(dir.path().join("history.jsonl"))));
    engine.connect(profile.id).await.unwrap();
    Fixture { engine, conn: profile.id, _dir: dir }
}

async fn fixture() -> Fixture {
    fixture_with(|_| {}).await
}

fn page_req(conn: ConnId, schema: &str, table: &str) -> PageRequest {
    PageRequest {
        conn_id: conn,
        schema: schema.into(),
        table: table.into(),
        filters: vec![],
        raw_where: None,
        sort: vec![],
        cursor: None,
        limit: 500,
    }
}

/// Pages through a whole relation; returns all rows.
async fn fetch_all(f: &Fixture, mut req: PageRequest) -> Vec<Vec<Option<String>>> {
    let mut rows = Vec::new();
    loop {
        let page = f.engine.fetch_page("all", &req).await.unwrap();
        rows.extend(page.rows);
        match page.next_cursor {
            Some(c) => req.cursor = Some(c),
            None => return rows,
        }
    }
}

async fn psql_values(f: &Fixture, sql: &str) -> Vec<Vec<Option<String>>> {
    let mut r = f.engine.run_sql("psql", f.conn, sql, 100_000).await.unwrap();
    r.pop().unwrap().rows
}

#[tokio::test]
async fn connect_reports_server_info() {
    let f = fixture().await;
    let profile = f.engine.profiles.get(f.conn).unwrap();
    let info = f.engine.test_connection(&profile, None).await.unwrap();
    assert!(info.version.starts_with("PostgreSQL"));
    assert_eq!(info.database, "slonview_fixture");
    assert!(info.read_only);
    let again = f.engine.connect(f.conn).await.unwrap();
    assert!(again.read_only);
}

#[tokio::test]
async fn bad_credentials_and_hosts_map_to_typed_errors() {
    let f = fixture().await;
    let mut profile = f.engine.profiles.get(f.conn).unwrap();
    // Local trust auth accepts any password, so an unknown role is the portable auth failure.
    profile.user = "slonview_core_db_no_such_role".into();
    profile.ssl = SslMode::Disable;
    let err = f.engine.test_connection(&profile, Some("wrong")).await.unwrap_err();
    assert!(matches!(err, AppError::Auth { .. }), "{err:?}");
    profile.port = 1;
    let err = f.engine.test_connection(&profile, None).await.unwrap_err();
    assert!(matches!(err, AppError::Connect { .. }), "{err:?}");
    let err = f.engine.list_schema_tree(uuid::Uuid::new_v4()).await.unwrap_err();
    assert_eq!(err, AppError::NotConnected);
}

#[tokio::test]
async fn schema_tree_lists_fixture_relations() {
    let f = fixture().await;
    let tree = f.engine.list_schema_tree(f.conn).await.unwrap();
    assert_eq!(tree[0].name, "public");
    let find = |schema: &str, name: &str| {
        tree.iter()
            .find(|s| s.name == schema)
            .and_then(|s| s.relations.iter().find(|r| r.name == name))
            .cloned()
    };
    let orders = find("public", "orders").unwrap();
    assert_eq!(orders.kind, RelationKind::Table);
    assert!(orders.est_rows > 900_000 && orders.size_bytes > 0);
    assert_eq!(find("Sales Data", "Weird \"Name\" Table").unwrap().kind, RelationKind::Table);
    assert_eq!(find("public", "paid_orders").unwrap().kind, RelationKind::View);
    assert_eq!(find("public", "order_totals").unwrap().kind, RelationKind::MaterializedView);
    let events = find("public", "events").unwrap();
    assert_eq!(events.kind, RelationKind::PartitionedTable);
    assert!(events.est_rows > 4000 && events.size_bytes > 0, "{events:?}");
    assert!(find("public", "events_2024").is_none());
    assert!(tree.iter().all(|s| !s.name.starts_with("pg_") && s.name != "information_schema"));
    let public: Vec<_> = tree[0].relations.iter().map(|r| r.name.clone()).collect();
    let mut sorted = public.clone();
    sorted.sort();
    assert_eq!(public, sorted);
}

#[tokio::test]
async fn describe_orders() {
    let f = fixture().await;
    let d = f.engine.describe_table(f.conn, "public", "orders").await.unwrap();
    assert_eq!(d.kind, RelationKind::Table);
    let id = &d.columns[0];
    assert_eq!((id.name.as_str(), id.type_name.as_str(), id.is_pk, id.nullable), ("id", "bigint", true, false));
    assert!(id.default.as_deref().unwrap().starts_with("nextval("));
    let amount = d.columns.iter().find(|c| c.name == "amount").unwrap();
    assert_eq!(amount.type_name, "numeric(12,2)");
    assert!(d.columns.iter().find(|c| c.name == "note").unwrap().nullable);
    assert!(d.columns.iter().filter(|c| c.is_pk).count() == 1);
    let names: HashSet<_> = d.indexes.iter().map(|i| i.name.as_str()).collect();
    assert_eq!(names, HashSet::from(["orders_pkey", "orders_status_idx", "orders_created_at_idx"]));
    assert!(d.indexes[0].is_primary && d.indexes[0].definition.contains("USING btree (id)"));
    assert_eq!(d.foreign_keys.len(), 1);
    assert_eq!(d.foreign_keys[0].definition, "FOREIGN KEY (customer_id) REFERENCES customers(id)");
    assert!(d.view_definition.is_none());

    let v = f.engine.describe_table(f.conn, "public", "paid_orders").await.unwrap();
    assert_eq!(v.kind, RelationKind::View);
    assert!(v.view_definition.unwrap().contains("'paid'"));
    let m = f.engine.describe_table(f.conn, "public", "order_totals").await.unwrap();
    assert!(m.view_definition.is_some());
    let err = f.engine.describe_table(f.conn, "public", "nope").await.unwrap_err();
    assert!(matches!(err, AppError::Invalid { .. }));
}

#[tokio::test]
async fn orders_keyset_paging() {
    let f = fixture().await;
    let mut req = page_req(f.conn, "public", "orders");
    let p1 = f.engine.fetch_page("p1", &req).await.unwrap();
    assert_eq!(p1.rows.len(), 500);
    assert_eq!(p1.rows[0][0].as_deref(), Some("1"));
    assert_eq!(p1.columns.len(), 6);
    assert!(p1.columns[0].is_pk && p1.columns[2].type_name == "order_status");
    assert_eq!(p1.next_cursor, Some(Cursor::Keyset { values: vec![Some("500".into())] }));
    req.cursor = p1.next_cursor;
    let p2 = f.engine.fetch_page("p2", &req).await.unwrap();
    assert_eq!(p2.rows[0][0].as_deref(), Some("501"));
    assert!(p2.sql.contains("> ('500'::bigint)"), "{}", p2.sql);
}

#[tokio::test]
async fn filter_and_sort_match_direct_sql() {
    let f = fixture().await;
    let mut req = page_req(f.conn, "public", "orders");
    req.filters = vec![Filter { column: "status".into(), op: FilterOp::Eq, value: Some("paid".into()) }];
    req.sort = vec![Sort { column: "created_at".into(), desc: true }];
    let p1 = f.engine.fetch_page("f1", &req).await.unwrap();
    let expected = psql_values(
        &f,
        "SELECT id::text FROM orders WHERE status = 'paid' ORDER BY created_at DESC, id LIMIT 1000",
    )
    .await;
    let got: Vec<_> = p1.rows.iter().map(|r| r[0].clone()).collect();
    let want: Vec<_> = expected.iter().map(|r| r[0].clone()).collect();
    assert_eq!(got, want[..500]);
    assert_eq!(p1.next_cursor, Some(Cursor::Offset { offset: 500 }));
    req.cursor = p1.next_cursor;
    let p2 = f.engine.fetch_page("f2", &req).await.unwrap();
    let got2: Vec<_> = p2.rows.iter().map(|r| r[0].clone()).collect();
    assert_eq!(got2, want[500..]);

    let n = f.engine.count_exact("c", f.conn, "public", "orders", &req.filters, Some("amount > 500")).await.unwrap();
    let want_n = psql_values(&f, "SELECT count(*) FROM orders WHERE status = 'paid' AND amount > 500").await;
    assert_eq!(Some(n.to_string()), want_n[0][0]);

    // IN / LIKE / IS NULL / raw where.
    req.sort.clear();
    req.cursor = None;
    req.filters = vec![
        Filter { column: "status".into(), op: FilterOp::In, value: Some("paid, shipped".into()) },
        Filter { column: "note".into(), op: FilterOp::IsNull, value: None },
    ];
    req.raw_where = Some("id < 100".into());
    let p = f.engine.fetch_page("f3", &req).await.unwrap();
    let ids: Vec<_> = p.rows.iter().map(|r| r[0].clone().unwrap()).collect();
    assert_eq!(ids, ["10", "30", "50", "70", "90"]);
    assert!(p.next_cursor.is_none());

    req.filters = vec![Filter { column: "missing".into(), op: FilterOp::Eq, value: Some("1".into()) }];
    assert!(matches!(f.engine.fetch_page("f4", &req).await.unwrap_err(), AppError::Invalid { .. }));
    req.filters.clear();
    req.raw_where = Some("nonsense_col = 1".into());
    let err = f.engine.fetch_page("f5", &req).await.unwrap_err();
    assert!(matches!(err, AppError::Sql { ref code, .. } if code == "42703"), "{err:?}");
}

#[tokio::test]
async fn weird_names_page_and_sort() {
    let f = fixture().await;
    let mut req = page_req(f.conn, "Sales Data", "Weird \"Name\" Table");
    req.limit = 100;
    let rows = fetch_all(&f, req.clone()).await;
    assert_eq!(rows.len(), 250);
    assert_eq!(rows[249][0].as_deref(), Some("250"));
    req.sort = vec![Sort { column: "Column With Space".into(), desc: true }];
    req.filters = vec![Filter { column: "ünïcödé".into(), op: FilterOp::Like, value: Some("ü2%".into()) }];
    let p = f.engine.fetch_page("w", &req).await.unwrap();
    assert_eq!(p.rows[0][1].as_deref(), Some("value 29"));
    assert_eq!(p.columns.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["Id", "Column With Space", "select", "ünïcödé"]);
    let cell = CellRequest {
        conn_id: f.conn,
        schema: "Sales Data".into(),
        table: "Weird \"Name\" Table".into(),
        pk_columns: vec!["Id".into()],
        pk_values: vec![Some("7".into())],
        column: "select".into(),
    };
    assert_eq!(f.engine.get_cell(&cell).await.unwrap().as_deref(), Some("kw 7"));
}

#[tokio::test]
async fn composite_pk_keyset_covers_all_rows() {
    let f = fixture().await;
    let mut req = page_req(f.conn, "public", "composite_pk");
    req.limit = 500;
    let rows = fetch_all(&f, req).await;
    assert_eq!(rows.len(), 1200);
    let unique: HashSet<_> = rows.iter().map(|r| (r[0].clone(), r[1].clone())).collect();
    assert_eq!(unique.len(), 1200);
}

#[tokio::test]
async fn no_pk_and_views_offset_paging() {
    let f = fixture().await;
    let rows = fetch_all(&f, page_req(f.conn, "public", "no_pk")).await;
    assert_eq!(rows.len(), 1200);
    let unique: HashSet<_> = rows.iter().map(|r| r[1].clone()).collect();
    assert_eq!(unique.len(), 1200);

    let p = f.engine.fetch_page("v", &page_req(f.conn, "public", "paid_orders")).await.unwrap();
    assert_eq!(p.rows.len(), 500);
    assert_eq!(p.next_cursor, Some(Cursor::Offset { offset: 500 }));
    let mut req = page_req(f.conn, "public", "order_totals");
    req.limit = 400;
    assert_eq!(fetch_all(&f, req).await.len(), 1000);
    let mut req = page_req(f.conn, "public", "events");
    req.limit = 2000;
    assert_eq!(fetch_all(&f, req).await.len(), 5000);
}

#[tokio::test]
async fn all_types_nulls_and_truncation() {
    let f = fixture().await;
    let p = f.engine.fetch_page("t", &page_req(f.conn, "public", "all_types")).await.unwrap();
    assert_eq!(p.rows.len(), 5);
    assert!(p.rows[1][1..].iter().all(Option::is_none));
    let text_col = p.columns.iter().position(|c| c.name == "c_text").unwrap();
    assert_eq!(p.rows[2][text_col].as_deref(), Some("NULL"));
    assert_eq!(p.rows[0][text_col].as_deref(), Some("hello"));
    let long = p.rows[3][text_col].as_deref().unwrap();
    assert_eq!(long.chars().count(), CELL_TRUNCATE_CHARS);
    assert!(p.truncated.contains(&(3, text_col as u32)));
    let bytea_col = p.columns.iter().position(|c| c.name == "c_bytea").unwrap();
    assert!(p.truncated.contains(&(3, bytea_col as u32)));
    assert!(!p.truncated.iter().any(|(r, _)| *r != 3));
    let jsonb = p.columns.iter().position(|c| c.name == "c_jsonb").unwrap();
    assert!(p.rows[3][jsonb].as_deref().unwrap().contains("🐘"));

    let mut cell = CellRequest {
        conn_id: f.conn,
        schema: "public".into(),
        table: "all_types".into(),
        pk_columns: vec!["id".into()],
        pk_values: vec![Some("4".into())],
        column: "c_text".into(),
    };
    let full = f.engine.get_cell(&cell).await.unwrap().unwrap();
    assert_eq!(full.chars().count(), 10_000);
    cell.pk_values = vec![Some("2".into())];
    assert_eq!(f.engine.get_cell(&cell).await.unwrap(), None);
    cell.pk_values = vec![Some("999".into())];
    assert!(matches!(f.engine.get_cell(&cell).await.unwrap_err(), AppError::Invalid { .. }));
}

#[tokio::test]
async fn read_only_blocks_writes() {
    let f = fixture().await;
    let err = f.engine.run_sql("ro", f.conn, "DELETE FROM orders", 10).await.unwrap_err();
    assert!(matches!(err, AppError::Sql { ref code, .. } if code == "25006"), "{err:?}");
    // A user SET of read-only off must not leak into later calls on the pooled session.
    let r = f
        .engine
        .run_sql("ro2", f.conn, "SET default_transaction_read_only = off; SET statement_timeout = 0; SHOW statement_timeout", 10)
        .await
        .unwrap();
    assert_eq!(r[2].rows[0][0].as_deref(), Some("0"));
    for i in 0..6 {
        let r = f.engine.run_sql(&format!("ro3-{i}"), f.conn, "SHOW default_transaction_read_only", 10).await.unwrap();
        assert_eq!(r[0].rows[0][0].as_deref(), Some("on"));
    }
}

#[tokio::test]
async fn read_only_preflights_transaction_and_maintenance_commands() {
    let f = fixture().await;
    let writable = fixture_with(|p| p.read_only = false).await;
    for command in [
        "BEGIN READ WRITE", "START TRANSACTION", "COMMIT", "END", "ROLLBACK", "ABORT",
        "PREPARE TRANSACTION 'x'", "COMMIT PREPARED 'x'", "ROLLBACK PREPARED 'x'",
        "SET TRANSACTION READ WRITE", "SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE",
        "VACUUM orders", "CREATE DATABASE ro_guard_db", "DROP DATABASE ro_guard_db",
        "CREATE TABLESPACE ro_guard_space LOCATION '/tmp'", "DROP TABLESPACE ro_guard_space",
        "ALTER SYSTEM SET work_mem = '8MB'", "CREATE INDEX CONCURRENTLY x ON orders(id)",
        "CREATE UNIQUE INDEX CONCURRENTLY x ON orders(id)", "REINDEX TABLE CONCURRENTLY orders",
        "LOCK TABLE orders IN ACCESS EXCLUSIVE MODE",
    ] {
        let sql = format!("SELECT 'ñ';  /* comment */ {command}; CREATE TABLE ro_guard_escape(a int)");
        let err = f.engine.run_sql("preflight", f.conn, &sql, 10).await.unwrap_err();
        // `/* comment */ …` starts at char 14 (1-based), after "SELECT 'ñ';" (11 chars) and two spaces.
        assert!(matches!(err, AppError::Invalid { position: Some(14), ref message } if message.contains("Read-only mode:") && message.contains("Allow writes")), "{command}: {err:?}");
    }
    for script in [
        "BEGIN READ WRITE; CREATE TABLE ro_guard_escape(a int); COMMIT",
        "BEGIN READ ONLY; SET TRANSACTION READ WRITE; CREATE TABLE ro_guard_escape(a int); COMMIT",
        "COMMIT; BEGIN READ WRITE; CREATE TABLE ro_guard_escape(a int); COMMIT",
        "SET default_transaction_read_only = off; COMMIT; CREATE TABLE ro_guard_escape(a int)",
    ] {
        assert!(matches!(f.engine.run_sql("escape", f.conn, script, 10).await.unwrap_err(), AppError::Invalid { .. }));
    }
    assert_eq!(psql_values(&writable, "SELECT to_regclass('ro_guard_escape')::text").await[0][0], None);
    assert!(f.engine.history.list(Some(f.conn), Some("ro_guard_escape"), 100).unwrap().iter().all(|h| h.error.is_some()));
}

#[tokio::test]
async fn read_only_snapshot_and_guc_changes_cannot_enable_writes() {
    let f = fixture().await;
    for script in [
        "SET default_transaction_read_only = off; DELETE FROM scratch_insert_target",
        "SET transaction_read_only = off; DELETE FROM scratch_insert_target",
        "SELECT set_config('transaction_read_only','off',true); DELETE FROM scratch_insert_target",
    ] {
        let err = f.engine.run_sql("guc", f.conn, script, 10).await.unwrap_err();
        assert!(matches!(err, AppError::Sql { ref code, .. } if code == "25006" || code == "25001"), "{err:?}");
        assert_eq!(psql_values(&f, "SHOW transaction_read_only").await[0][0].as_deref(), Some("on"));
    }
    f.engine.run_sql("setconfig", f.conn, "SELECT set_config('default_transaction_read_only','off',false)", 10).await.unwrap();
    let err = f.engine.run_sql("later", f.conn, "DELETE FROM scratch_insert_target", 10).await.unwrap_err();
    assert!(matches!(err, AppError::Sql { ref code, .. } if code == "25006"), "{err:?}");
    let r = f.engine.run_sql("savepoints", f.conn,
        "SAVEPOINT a; SELECT 1; ROLLBACK TO SAVEPOINT a; RELEASE a; SELECT 2", 10).await.unwrap();
    assert_eq!(r.len(), 5);
    assert_eq!(r[1].rows[0][0].as_deref(), Some("1"));
    assert_eq!(r[4].rows[0][0].as_deref(), Some("2"));
    let err = f.engine.run_sql("nextval", f.conn, "SELECT nextval('orders_id_seq')", 10).await.unwrap_err();
    assert!(matches!(err, AppError::Sql { ref code, .. } if code == "25006"), "{err:?}");
}

#[tokio::test]
async fn writable_explicit_transaction_still_commits() {
    let f = fixture_with(|p| p.read_only = false).await;
    let sql = "BEGIN; CREATE TABLE ro_guard_writable(a int); INSERT INTO ro_guard_writable VALUES (1); COMMIT";
    assert_eq!(f.engine.run_sql("write-tx", f.conn, sql, 10).await.unwrap().len(), 4);
    assert_eq!(psql_values(&f, "SELECT count(*) FROM ro_guard_writable").await[0][0].as_deref(), Some("1"));
    f.engine.run_sql("cleanup", f.conn, "DROP TABLE ro_guard_writable", 10).await.unwrap();
}

#[tokio::test]
async fn raw_where_rejects_multiple_server_commands_in_all_modes() {
    let verifier = fixture_with(|p| p.read_only = false).await;
    let before = psql_values(&verifier, "SELECT count(*) FROM scratch_insert_target").await;
    for read_only in [true, false] {
        let f = fixture_with(|p| p.read_only = read_only).await;
        let raw = "true); COMMIT; SET default_transaction_read_only=off; COMMIT; DELETE FROM scratch_insert_target; SELECT (1";
        let mut req = page_req(f.conn, "public", "scratch_insert_target");
        req.raw_where = Some(raw.into());
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("injected.csv");
        let source = ExportSource::Table { conn_id: f.conn, schema: "public".into(), table: "scratch_insert_target".into(),
            filters: vec![], raw_where: Some(raw.into()), sort: vec![] };
        let errors = [
            f.engine.fetch_page("raw-page", &req).await.unwrap_err(),
            f.engine.count_exact("raw-count", f.conn, "public", "scratch_insert_target", &[], Some(raw)).await.unwrap_err(),
            f.engine.export_csv("raw-export", &source, &path).await.unwrap_err(),
        ];
        for err in errors { assert!(matches!(err, AppError::Invalid { .. } | AppError::Sql { .. }), "{err:?}"); }
        assert!(!path.exists());
        assert_eq!(psql_values(&verifier, "SELECT count(*) FROM scratch_insert_target").await, before);
    }
}

#[tokio::test]
async fn read_only_raw_where_cannot_change_session_or_write() {
    // A single-expression Raw WHERE can still call set_config/nextval. In read-only mode
    // it runs inside a READ ONLY transaction and the session is reset afterwards.
    let f = fixture().await;
    let verifier = fixture_with(|p| p.read_only = false).await;
    let seq_before = psql_values(&verifier, "SELECT last_value::text FROM orders_id_seq").await;
    let mut req = page_req(f.conn, "public", "no_pk");
    req.raw_where = Some("set_config('default_transaction_read_only', 'off', false) IS NOT NULL".into());
    // More pages than the pool size (4), so every pooled session has run the expression.
    for i in 0..6 {
        f.engine.fetch_page(&format!("guc-{i}"), &req).await.unwrap();
    }
    // Every pooled session must still default to read-only. Probe through the pool with a
    // count whose Raw WHERE is true only while the session default is still on.
    for i in 0..6 {
        let n = f.engine
            .count_exact(&format!("probe-{i}"), f.conn, "public", "no_pk", &[],
                Some("current_setting('default_transaction_read_only') = 'on'"))
            .await
            .unwrap();
        assert_eq!(n, 1200, "pooled session {i} lost default_transaction_read_only");
    }
    req.raw_where = Some("nextval('orders_id_seq') > 0".into());
    let err = f.engine.fetch_page("nextval", &req).await.unwrap_err();
    assert!(matches!(err, AppError::Sql { ref code, .. } if code == "25006"), "{err:?}");
    let err = f.engine
        .count_exact("nextval-count", f.conn, "public", "no_pk", &[], Some("nextval('orders_id_seq') > 0"))
        .await
        .unwrap_err();
    assert!(matches!(err, AppError::Sql { ref code, .. } if code == "25006"), "{err:?}");
    assert_eq!(psql_values(&verifier, "SELECT last_value::text FROM orders_id_seq").await, seq_before);
}

#[tokio::test]
async fn read_only_export_rejects_writes_and_splitter_disagreement() {
    let f = fixture().await;
    let verifier = fixture_with(|p| p.read_only = false).await;
    let before = psql_values(&verifier, "SELECT count(*) FROM scratch_insert_target").await;
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("readonly.csv");
    for sql in ["DELETE FROM scratch_insert_target RETURNING *", "BEGIN READ WRITE", "COMMIT", "VACUUM orders"] {
        let source = ExportSource::Sql { conn_id: f.conn, sql: sql.into() };
        assert!(f.engine.export_csv("write-export", &source, &path).await.is_err());
        assert!(!path.exists());
    }
    // PostgreSQL treats non-ASCII bytes (including emoji) as identifier letters;
    // our splitter treats this emoji as a boundary and consumes a dollar body.
    // Server Parse must reject the resulting piece before any command executes.
    let sql = "SELECT 1 AS a😀$tag$; COMMIT; SET default_transaction_read_only=off; COMMIT; DELETE FROM scratch_insert_target; SELECT 1 AS a😀$tag$";
    assert!(f.engine.run_sql("split-edge", f.conn, sql, 10).await.is_err());
    let src = ExportSource::Sql { conn_id: f.conn, sql: "SELECT 1 AS n".into() };
    assert_eq!(f.engine.export_csv("good-export", &src, &path).await.unwrap(), 1);
    assert_eq!(psql_values(&verifier, "SELECT count(*) FROM scratch_insert_target").await, before);
}

#[tokio::test]
async fn writes_allowed_when_not_read_only() {
    let f = fixture_with(|p| p.read_only = false).await;
    let r = f
        .engine
        .run_sql(
            "w",
            f.conn,
            "CREATE TEMP TABLE slonview_core_db_w (a int); INSERT INTO slonview_core_db_w SELECT generate_series(1, 5); \
             UPDATE slonview_core_db_w SET a = a + 1 WHERE a > 2; SELECT count(*) FROM slonview_core_db_w",
            10,
        )
        .await
        .unwrap();
    assert_eq!(r.len(), 4);
    assert_eq!(r[1].rows_affected, Some(5));
    assert_eq!(r[2].rows_affected, Some(3));
    assert_eq!(r[3].rows_affected, None);
    assert_eq!(r[3].rows[0][0].as_deref(), Some("5"));
    // An open transaction is rolled back after the call.
    let r = f.engine.run_sql("tx", f.conn, "BEGIN; CREATE TABLE slonview_core_db_tx (a int)", 10).await.unwrap();
    assert_eq!(r.len(), 2);
    let r = f.engine.run_sql("tx2", f.conn, "SELECT to_regclass('slonview_core_db_tx')::text", 10).await.unwrap();
    assert_eq!(r[0].rows[0][0], None);
}

#[tokio::test]
async fn cancel_running_query() {
    let f = fixture().await;
    let engine = f.engine.clone();
    let conn = f.conn;
    let started = Instant::now();
    let task = tokio::spawn(async move { engine.run_sql("sleepy", conn, "SELECT pg_sleep(30)", 10).await });
    tokio::time::sleep(Duration::from_millis(300)).await;
    f.engine.cancel_query("sleepy").await.unwrap();
    let err = task.await.unwrap().unwrap_err();
    assert_eq!(err, AppError::Cancelled);
    assert!(started.elapsed() < Duration::from_millis(1300), "{:?}", started.elapsed());
    f.engine.cancel_query("unknown").await.unwrap();
    // History recorded the failure.
    let h = f.engine.history.list(Some(conn), Some("pg_sleep"), 10).unwrap();
    assert_eq!(h[0].error.as_deref(), Some("query cancelled"));
}

#[tokio::test]
async fn statement_timeout_maps_to_timeout() {
    let f = fixture_with(|p| p.statement_timeout_ms = 500).await;
    let started = Instant::now();
    let err = f.engine.run_sql("slow", f.conn, "SELECT pg_sleep(2)", 10).await.unwrap_err();
    assert_eq!(err, AppError::Timeout);
    assert!(started.elapsed() < Duration::from_millis(1500));
}

#[tokio::test]
async fn multi_statement_scripts() {
    let f = fixture().await;
    let r = f.engine.run_sql("m", f.conn, "SELECT 1; SELECT $$a;b$$; select 'x;y'", 10).await.unwrap();
    assert_eq!(r.len(), 3);
    assert_eq!(r[0].statement, "SELECT 1");
    assert_eq!(r[1].rows[0][0].as_deref(), Some("a;b"));
    assert_eq!(r[2].rows[0][0].as_deref(), Some("x;y"));
    assert_eq!(r[2].columns[0].name, "?column?");

    let r = f.engine.run_sql("cap", f.conn, "SELECT generate_series(1, 50)", 10).await.unwrap();
    assert_eq!(r[0].rows.len(), 10);
    assert!(r[0].truncated);

    let err = f.engine.run_sql("bad", f.conn, "SELECT 1;\nSELECT nope", 10).await.unwrap_err();
    match err {
        AppError::Sql { code, position, .. } => {
            assert_eq!(code, "42703");
            assert_eq!(position, Some(18)); // 1-based char position of `nope` in the full text
        }
        other => panic!("{other:?}"),
    }
    let h = f.engine.history.list(Some(f.conn), None, 10).unwrap();
    assert!(h[0].error.is_some() && h[1].error.is_none());
}

#[tokio::test]
async fn export_csv_table_and_sql() {
    let f = fixture().await;
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("orders.csv");
    let source = ExportSource::Table {
        conn_id: f.conn,
        schema: "public".into(),
        table: "orders".into(),
        filters: vec![],
        raw_where: None,
        sort: vec![],
    };
    let n = f.engine.export_csv("e", &source, &path).await.unwrap();
    assert_eq!(n, 1_000_000);
    let text = std::fs::read_to_string(&path).unwrap();
    assert_eq!(text.lines().count(), 1_000_001);
    assert!(text.starts_with("id,customer_id,status,amount,note,created_at\n1,2,paid,"));

    // Embedded newlines are one row each.
    let path2 = dir.path().join("types.csv");
    let src = ExportSource::Sql { conn_id: f.conn, sql: "SELECT c_varchar FROM all_types ORDER BY id;".into() };
    assert_eq!(f.engine.export_csv("e2", &src, &path2).await.unwrap(), 5);
    let src = ExportSource::Sql { conn_id: f.conn, sql: "SELECT 1; SELECT 2".into() };
    assert!(matches!(f.engine.export_csv("e3", &src, &path2).await.unwrap_err(), AppError::Invalid { .. }));
}

#[tokio::test]
async fn cancel_export() {
    let f = fixture().await;
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("slow.csv");
    let engine = f.engine.clone();
    let p = path.clone();
    let src = ExportSource::Sql { conn_id: f.conn, sql: "SELECT pg_sleep(30)".into() };
    let task = tokio::spawn(async move { engine.export_csv("exp", &src, &p).await });
    tokio::time::sleep(Duration::from_millis(300)).await;
    f.engine.cancel_query("exp").await.unwrap();
    assert_eq!(task.await.unwrap().unwrap_err(), AppError::Cancelled);
    assert!(!path.exists());
}

#[tokio::test]
async fn disconnect_drops_pool() {
    let f = fixture().await;
    f.engine.disconnect(f.conn).await.unwrap();
    assert_eq!(f.engine.list_schema_tree(f.conn).await.unwrap_err(), AppError::NotConnected);
    f.engine.disconnect(f.conn).await.unwrap();
}

/// `created_at` of orders id 1 (seed: 2023-12-31 17:00:01 UTC), first row in pk order.
async fn first_order_created_at(f: &Fixture) -> String {
    let page = f.engine.fetch_page("tz", &page_req(f.conn, "public", "orders")).await.unwrap();
    let col = page.columns.iter().position(|c| c.name == "created_at").unwrap();
    assert_eq!(page.columns[col].type_name, "timestamp with time zone");
    assert_eq!(page.rows[0][0].as_deref(), Some("1"));
    page.rows[0][col].clone().unwrap()
}

const TZ_PROBE: &str = "SELECT timestamptz '2026-11-20 14:52:33+00'::text, current_setting('TimeZone')";

#[tokio::test]
async fn profile_time_zone_applies_to_browse_and_sql() {
    // The fixture server's own default may already be Asia/Jakarta, so UTC proves the
    // zone comes from the profile, not the server.
    for (tz, sql_want, browse_want) in [
        ("UTC", "2026-11-20 14:52:33+00", "2023-12-31 17:00:01+00"),
        ("Asia/Jakarta", "2026-11-20 21:52:33+07", "2024-01-01 00:00:01+07"),
    ] {
        let f = fixture_with(|p| p.time_zone = Some(tz.into())).await;
        assert_eq!(first_order_created_at(&f).await, browse_want, "{tz} browse");
        let want = vec![vec![Some(sql_want.to_owned()), Some(tz.to_owned())]];
        assert_eq!(psql_values(&f, TZ_PROBE).await, want, "{tz} run_sql");
        // A user SET TIME ZONE in one run is undone; the profile zone is re-applied.
        let changed = psql_values(&f, &format!("SET TIME ZONE 'America/New_York'; {TZ_PROBE}")).await;
        assert_eq!(changed[0][1].as_deref(), Some("America/New_York"));
        assert_eq!(psql_values(&f, TZ_PROBE).await, want, "{tz} second run_sql");
        assert_eq!(psql_values(&f, TZ_PROBE).await, want, "{tz} third run_sql");
        assert_eq!(first_order_created_at(&f).await, browse_want, "{tz} browse after run_sql");
    }
}

#[tokio::test]
async fn invalid_time_zone_is_a_typed_connect_error() {
    let f = fixture().await;
    let mut profile = f.engine.profiles.get(f.conn).unwrap();
    profile.time_zone = Some("Nope/Zone".into());
    let want = AppError::Connect { message: "invalid value for parameter \"TimeZone\": \"Nope/Zone\"".into() };
    assert_eq!(f.engine.test_connection(&profile, None).await.unwrap_err(), want);
    f.engine.profiles.upsert(profile.clone()).unwrap();
    assert_eq!(f.engine.connect(profile.id).await.unwrap_err(), want);
}
