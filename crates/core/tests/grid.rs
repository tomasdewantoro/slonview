use std::{sync::Arc, time::Instant};
use slonview_core::{Engine, AppError, config::ProfileStore, history::HistoryStore, secrets::MemorySecretStore, connurl::parse_conn_url, model::*};

async fn fixture(writes: bool) -> (Engine, ConnId, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let mut p = parse_conn_url(&std::env::var("SLONVIEW_TEST_URL").unwrap_or_else(|_| "postgres://tomas@localhost/slonview_fixture_grid".into())).unwrap().profile;
    p.read_only = !writes;
    let store = ProfileStore::new(dir.path().join("connections.toml"));
    store.upsert(p.clone()).unwrap();
    let engine = Engine::new(store, Arc::new(MemorySecretStore::default()), HistoryStore::new(dir.path().join("history.jsonl")));
    engine.connect(p.id).await.unwrap();
    (engine, p.id, dir)
}
fn page(id: ConnId) -> PageRequest { PageRequest { conn_id: id, schema: "public".into(), table: "orders".into(), filters: vec![], raw_where: None, sort: vec![], cursor: None, limit: 500 } }
fn value(column: &str, value: Option<&str>) -> EditValue { EditValue { column: column.into(), value: value.map(Into::into) } }
async fn sql(e: &Engine, id: ConnId, sql: &str) -> Vec<Vec<Option<String>>> { e.run_sql("verify", id, sql, 10_000).await.unwrap().pop().unwrap().rows }

#[tokio::test]
async fn sorted_pages_match_order_including_nulls() {
    let (e, id, _dir) = fixture(false).await;
    for sort in [vec![Sort { column: "status".into(), desc: false }, Sort { column: "created_at".into(), desc: true }], vec![Sort { column: "note".into(), desc: false }], vec![Sort { column: "note".into(), desc: true }]] {
        let mut req = page(id); req.sort = sort.clone();
        // Restrict nullable tests to exercise both NULL and non-NULL boundaries within 5k.
        if sort[0].column == "note" { req.raw_where = Some("id <= 5000".into()); }
        let order = sort.iter().map(|s| format!("{} {}", s.column, if s.desc { "DESC" } else { "ASC" })).collect::<Vec<_>>().join(", ");
        let expected = sql(&e, id, &format!("SELECT * FROM orders {} ORDER BY {order}, id LIMIT 5000", if req.raw_where.is_some() { "WHERE id <= 5000" } else { "" })).await;
        let mut got = Vec::new();
        while got.len() < 5000 {
            let p = e.fetch_page("sorted", &req).await.unwrap();
            assert!(!p.sql.contains("OFFSET"));
            got.extend(p.rows);
            req.cursor = p.next_cursor;
            if req.cursor.is_none() { break; }
        }
        assert_eq!(got, expected, "sort {sort:?}");
    }
    let req = PageRequest { table: "no_pk".into(), ..page(id) };
    assert!(matches!(e.fetch_page("keyless", &req).await.unwrap().next_cursor, Some(Cursor::Offset { .. })));
}

#[tokio::test]
async fn streamed_column_uses_filter_sort_and_full_values() {
    let (e, id, _dir) = fixture(false).await;
    let mut req = page(id); req.raw_where = Some("id <= 2501".into()); req.sort = vec![Sort { column: "id".into(), desc: true }];
    let mut got = Vec::new(); let mut chunks = 0;
    let summary = e.stream_columns("copy", &ColumnCopyRequest { page: req, columns: vec!["note".into()] }, |c| { chunks += 1; assert!(c.rows.iter().all(|r| r.len() == 1)); got.extend(c.rows); Ok(()) }).await.unwrap();
    assert_eq!(summary.count, 2501); assert!(!summary.capped); assert_eq!(chunks, 2);
    assert_eq!(got, sql(&e, id, "SELECT note FROM orders WHERE id <= 2501 ORDER BY id DESC").await);
    let mut req = page(id); req.table = "all_types".into();
    let mut got = Vec::new();
    e.stream_columns("full", &ColumnCopyRequest { page: req, columns: vec!["c_text".into()] }, |c| { got.extend(c.rows); Ok(()) }).await.unwrap();
    assert_eq!(got[3][0].as_ref().unwrap().len(), 10_000);
    e.disconnect(id).await.unwrap();
}

#[tokio::test]
async fn reviewed_edits_atomic_conflicts_quoting_nulls_and_guards() {
    let (e, id, _dir) = fixture(true).await;
    sql(&e, id, "CREATE TABLE grid_edit_test (id int PRIMARY KEY, note text, data json, computed int GENERATED ALWAYS AS (id+1) STORED, always_id int GENERATED ALWAYS AS IDENTITY, bytes bytea); INSERT INTO grid_edit_test(id,note) VALUES (1,'one'), (2,'two')").await;
    let request = |table: &str, changes| EditRequest { conn_id: id, schema: "public".into(), table: table.into(), changes };
    let first = vec![value("id", Some("1")), value("note", Some("one"))];
    let req = request("grid_edit_test", vec![RowEdit::Update { original: first.clone(), values: vec![value("note", None)] }, RowEdit::Insert { values: vec![value("id", Some("3")), value("note", Some("NULL"))] }]);
    let review = e.review_edits(&req).await.unwrap();
    assert!(review[0].contains("SET \"note\" = NULL")); assert!(review[0].contains("IS NOT DISTINCT FROM 'one'")); assert!(review[1].contains("'NULL'")); assert!(review[1].contains("RETURNING \"id\""));
    assert_eq!(e.apply_edits("apply", &req).await.unwrap(), 2);
    assert_eq!(sql(&e, id, "SELECT note FROM grid_edit_test WHERE id IN (1,3) ORDER BY id").await, vec![vec![None], vec![Some("NULL".into())]]);
    // First statement would succeed, second conflicts; first must roll back.
    let conflict = request("grid_edit_test", vec![RowEdit::Update { original: vec![value("id", Some("3")), value("note", Some("NULL"))], values: vec![value("note", Some("must roll back"))] }, RowEdit::Update { original: first, values: vec![value("note", Some("stale"))] }]);
    let err = e.apply_edits("conflict", &conflict).await.unwrap_err(); assert!(err.to_string().contains("Change 2"));
    assert_eq!(sql(&e, id, "SELECT note FROM grid_edit_test WHERE id=3").await[0][0].as_deref(), Some("NULL"));
    let cell = CellRequest { conn_id: id, schema: "public".into(), table: "grid_edit_test".into(), pk_columns: vec!["id".into()], pk_values: vec![Some("3".into())], column: "note".into() };
    let original = e.get_edit_row(&cell).await.unwrap();
    e.apply_edits("delete", &request("grid_edit_test", vec![RowEdit::Delete { original }])).await.unwrap();
    assert!(sql(&e, id, "SELECT id FROM grid_edit_test WHERE id=3").await.is_empty());
    let info = e.edit_info(id, "public", "grid_edit_test").await.unwrap(); assert_eq!(info.blocked_columns.len(), 3);
    for name in ["computed", "always_id", "bytes"] { assert!(matches!(e.review_edits(&request("grid_edit_test", vec![RowEdit::Insert { values: vec![value(name, Some("1"))] }])).await, Err(AppError::Invalid { .. }))); }
    assert!(matches!(e.apply_edits("no-key", &request("no_pk", vec![RowEdit::Insert { values: vec![] }])).await, Err(AppError::Invalid { .. })));
    let weird = EditRequest { conn_id: id, schema: "Sales Data".into(), table: "Weird \"Name\" Table".into(), changes: vec![RowEdit::Update { original: vec![value("Id", Some("1")), value("Column With Space", Some("value 1"))], values: vec![value("Column With Space", Some("O'Brien\\日本"))] }] };
    assert!(e.review_edits(&weird).await.unwrap()[0].contains("\"Sales Data\".\"Weird \"\"Name\"\" Table\""));
    e.apply_edits("weird", &weird).await.unwrap();
    assert_eq!(sql(&e, id, "SELECT \"Column With Space\" FROM \"Sales Data\".\"Weird \"\"Name\"\" Table\" WHERE \"Id\"=1").await[0][0].as_deref(), Some("O'Brien\\日本"));
    sql(&e, id, "UPDATE \"Sales Data\".\"Weird \"\"Name\"\" Table\" SET \"Column With Space\"='value 1' WHERE \"Id\"=1; DROP TABLE grid_edit_test").await;
    let (ro, ro_id, _rodir) = fixture(false).await;
    let mut req = weird; req.conn_id = ro_id;
    assert!(matches!(ro.apply_edits("readonly", &req).await, Err(AppError::Invalid { .. })));
    assert!(matches!(ro.review_edits(&req).await, Err(AppError::Invalid { .. })));
    e.disconnect(id).await.unwrap(); ro.disconnect(ro_id).await.unwrap();
}

#[tokio::test]
async fn page_200_latency() {
    let (e, id, _dir) = fixture(false).await;
    let cursor_row = sql(&e, id, "SELECT status, created_at, id FROM orders ORDER BY status, created_at DESC, id OFFSET 99499 LIMIT 1").await.remove(0);
    let mut req = page(id); req.sort = vec![Sort { column: "status".into(), desc: false }, Sort { column: "created_at".into(), desc: true }]; req.cursor = Some(Cursor::Keyset { values: cursor_row });
    let start = Instant::now(); let p = e.fetch_page("page-200", &req).await.unwrap(); let keyset = start.elapsed();
    let start = Instant::now(); sql(&e, id, "SELECT * FROM orders ORDER BY status, created_at DESC, id LIMIT 501 OFFSET 99500").await; let offset = start.elapsed();
    assert_eq!(p.rows.len(), 500);
    println!("Page 200 (500 rows; status ASC, created_at DESC, id ASC): OFFSET {offset:?}, keyset {keyset:?}; SQL {}", p.sql);
}

#[tokio::test]
async fn column_stream_cap_and_read_only_raw_guard() {
    let (e, id, _dir) = fixture(true).await;
    let mut req = page(id); req.table = "grid_copy_cap".into();
    sql(&e, id, "CREATE VIEW grid_copy_cap AS SELECT g AS id FROM generate_series(1,1000001) g").await;
    let mut count = 0;
    let summary = e.stream_columns("cap", &ColumnCopyRequest { page: req, columns: vec!["id".into()] }, |c| { count += c.rows.len(); Ok(()) }).await.unwrap();
    assert_eq!(count, 1_000_000); assert_eq!(summary.count, 1_000_000); assert!(summary.capped);
    let mut req = page(id); req.table = "scratch_insert_target".into(); req.raw_where = Some("true); COMMIT; DELETE FROM scratch_insert_target; SELECT (true".into());
    assert!(e.stream_columns("injection", &ColumnCopyRequest { page: req, columns: vec!["id".into()] }, |_| Ok(())).await.is_err());
    sql(&e, id, "DROP VIEW grid_copy_cap").await;
    e.disconnect(id).await.unwrap();
}

#[tokio::test]
async fn cancel_column_stream_stops_server() {
    let (e, id, _dir) = fixture(false).await;
    let e = Arc::new(e);
    let mut req = page(id); req.raw_where = Some("pg_sleep(0.001) IS NOT NULL".into());
    let task_engine = e.clone();
    let task = tokio::spawn(async move { task_engine.stream_columns("cancel-column", &ColumnCopyRequest { page: req, columns: vec!["note".into()] }, |_| Ok(())).await });
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    e.cancel_query("cancel-column").await.unwrap();
    assert!(matches!(task.await.unwrap(), Err(AppError::Cancelled)));
    assert_eq!(e.fetch_page("after-cancel", &page(id)).await.unwrap().rows.len(), 500);
    e.disconnect(id).await.unwrap();
}
