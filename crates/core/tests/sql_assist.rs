//! Integration tests for SQL editor assistance: result column types, `list_columns` and
//! EXPLAIN. Runs against the seeded fixture DB (`SLONVIEW_TEST_URL` overrides
//! `postgres://tomas@localhost/slonview_fixture`). Scratch tables are created and dropped here.
use std::sync::Arc;
use std::time::{Duration, Instant};

use slonview_core::config::ProfileStore;
use slonview_core::connurl::parse_conn_url;
use slonview_core::explain::PlanNode;
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

async fn fixture(read_only: bool) -> Fixture {
    let url = std::env::var("SLONVIEW_TEST_URL")
        .unwrap_or_else(|_| "postgres://tomas@localhost/slonview_fixture".into());
    let dir = TempDir::new().unwrap();
    let parsed = parse_conn_url(&url).unwrap();
    let mut profile = parsed.profile;
    profile.read_only = read_only;
    let secrets: Arc<dyn SecretStore> = Arc::new(MemorySecretStore::default());
    if let Some(pw) = &parsed.password {
        secrets.set(profile.id, pw).unwrap();
    }
    let profiles = ProfileStore::new(dir.path().join("connections.toml"));
    profiles.upsert(profile.clone()).unwrap();
    let engine = Arc::new(Engine::new(
        profiles,
        secrets,
        HistoryStore::new(dir.path().join("history.jsonl")),
    ));
    engine.connect(profile.id).await.unwrap();
    Fixture {
        engine,
        conn: profile.id,
        _dir: dir,
    }
}

async fn sql(f: &Fixture, text: &str) -> Vec<QueryResult> {
    f.engine.run_sql("t", f.conn, text, 1000).await.unwrap()
}

fn types(r: &QueryResult) -> Vec<&str> {
    r.columns.iter().map(|c| c.type_name.as_str()).collect()
}

const TYPED_SELECT: &str =
    "SELECT 1::int AS i, 'x'::text AS t, now() AS ts, 1.5::numeric(5,2) AS n, ARRAY[1,2] AS a";
const EXPECTED: [&str; 5] = [
    "integer",
    "text",
    "timestamp with time zone",
    "numeric(5,2)",
    "integer[]",
];

#[tokio::test]
async fn sql_results_carry_column_types_in_both_modes() {
    for read_only in [true, false] {
        let f = fixture(read_only).await;
        let r = sql(&f, TYPED_SELECT).await;
        assert_eq!(types(&r[0]), EXPECTED, "read_only={read_only}");
        assert_eq!(r[0].rows[0][3].as_deref(), Some("1.50"));
        // Cached names are reused; a table query mixes cached and new types.
        let r = sql(&f, &format!("{TYPED_SELECT}; SELECT id, amount, status, created_at FROM orders ORDER BY id LIMIT 1")).await;
        assert_eq!(types(&r[0]), EXPECTED);
        assert_eq!(
            types(&r[1]),
            [
                "bigint",
                "numeric(12,2)",
                "order_status",
                "timestamp with time zone"
            ]
        );
        assert_eq!(
            types(&sql(&f, "SELECT 'a'::varchar(10), 'b'::char(3), NULL").await[0]),
            ["character varying(10)", "character(3)", "text"]
        );
    }
}

#[tokio::test]
async fn writable_mode_falls_back_to_untyped_without_breaking_scripts() {
    let f = fixture(false).await;
    let r = sql(&f, "SHOW statement_timeout").await;
    assert_eq!(types(&r[0]), ["text"]);
    // PostgreSQL treats the emoji as an identifier letter, our splitter as a boundary that
    // starts a $x$ body, so this piece holds two server commands: Parse fails (no types),
    // the simple-query run still works. Inside the user's own transaction the failed Parse
    // must not abort it: the INSERT afterwards must succeed and be visible.
    let r = sql(
        &f,
        "BEGIN; CREATE TEMP TABLE typed_tx (a int); SELECT 1 AS a😀$x$; SELECT 2 AS b😀$x$; INSERT INTO typed_tx VALUES (7) RETURNING a; SELECT a, a::text FROM typed_tx",
    )
    .await;
    assert_eq!(r.len(), 6, "{r:?}");
    assert_eq!(r[2].rows[0][0].as_deref(), Some("1"));
    assert_eq!(types(&r[2]), [""]);
    assert_eq!(types(&r[3]), [""]);
    assert_eq!(types(&r[4]), ["integer"]);
    assert_eq!(types(&r[5]), ["integer", "text"]);
    assert_eq!(r[5].rows, vec![vec![Some("7".into()), Some("7".into())]]);
}

#[tokio::test]
async fn list_columns_covers_every_relation_kind() {
    let f = fixture(true).await;
    let cols = f.engine.list_columns(f.conn).await.unwrap();
    let has = |schema: &str, table: &str, name: &str, ty: &str| {
        cols.iter()
            .any(|c| c.schema == schema && c.table == table && c.name == name && c.type_name == ty)
    };
    assert!(has("public", "orders", "amount", "numeric(12,2)"));
    assert!(has("public", "orders", "customer_id", "bigint"));
    assert!(
        cols.iter()
            .any(|c| c.schema == "public" && c.table == "paid_orders"),
        "views included"
    );
    assert!(
        cols.iter().any(|c| c.schema == "Sales Data"),
        "quoted schema included"
    );
    assert!(
        cols.iter()
            .all(|c| c.schema != "pg_catalog" && c.schema != "information_schema")
    );
    // attnum order within a relation.
    let orders: Vec<&str> = cols
        .iter()
        .filter(|c| c.schema == "public" && c.table == "orders")
        .map(|c| c.name.as_str())
        .collect();
    assert_eq!(orders[..2], ["id", "customer_id"]);
    assert!(matches!(
        f.engine.list_columns(uuid::Uuid::nil()).await,
        Err(AppError::NotConnected)
    ));
}

fn find<'a>(node: &'a PlanNode, pred: &dyn Fn(&PlanNode) -> bool) -> Option<&'a PlanNode> {
    if pred(node) {
        return Some(node);
    }
    node.children.iter().find_map(|c| find(c, pred))
}

#[tokio::test]
async fn explain_plan_only_and_analyze() {
    let f = fixture(true).await;
    let r = f
        .engine
        .explain("e1", f.conn, "SELECT * FROM orders WHERE id = 5", false)
        .await
        .unwrap();
    assert!(!r.analyzed);
    let scan = find(&r.plan, &|n| n.node_type.contains("Scan")).expect("a scan node");
    assert!(
        scan.relation
            .as_deref()
            .unwrap_or("")
            .starts_with("public.orders"),
        "{scan:?}"
    );
    assert_eq!(scan.actual_rows, None);
    assert!(r.execution_time_ms.is_none());
    assert!(r.raw_json.contains("\"Plan\""));

    let r = f
        .engine
        .explain("e2", f.conn, "-- leading comment\nSELECT o.status, count(*) FROM orders o JOIN customers c ON c.id = o.customer_id GROUP BY 1;", true)
        .await
        .unwrap();
    assert!(r.analyzed);
    assert!(r.execution_time_ms.is_some());
    assert!(r.plan.actual_total_time.is_some() && r.plan.actual_loops == Some(1.0));
    assert!(
        find(&r.plan, &|n| n.shared_hit_blocks.is_some()).is_some(),
        "BUFFERS reported"
    );
    assert!(
        find(&r.plan, &|n| n.relation.as_deref()
            == Some("public.customers c"))
        .is_some()
    );
}

#[tokio::test]
async fn explain_analyze_rolls_back_writes() {
    let f = fixture(false).await;
    sql(&f, "DROP TABLE IF EXISTS explain_scratch; CREATE TABLE explain_scratch (id int PRIMARY KEY, v text); INSERT INTO explain_scratch SELECT g, 'v' FROM generate_series(1, 10) g").await;
    let count = || async {
        sql(
            &f,
            "SELECT count(*), count(*) FILTER (WHERE v = 'changed') FROM explain_scratch",
        )
        .await[0]
            .rows[0]
            .clone()
    };
    assert_eq!(count().await, vec![Some("10".into()), Some("0".into())]);
    for stmt in [
        "INSERT INTO explain_scratch SELECT g, 'new' FROM generate_series(11, 20) g",
        "UPDATE explain_scratch SET v = 'changed'",
        "DELETE FROM explain_scratch",
    ] {
        let r = f.engine.explain("w", f.conn, stmt, true).await.unwrap();
        let rows = r
            .plan
            .children
            .first()
            .and_then(|c| c.actual_rows)
            .or(r.plan.actual_rows);
        assert!(r.analyzed && rows.is_some(), "{stmt}: {r:?}");
        assert_eq!(
            count().await,
            vec![Some("10".into()), Some("0".into())],
            "{stmt} was rolled back"
        );
    }
    // A user-written COMMIT cannot ride along: multiple commands are refused before running.
    let err = f
        .engine
        .explain("m", f.conn, "DELETE FROM explain_scratch; COMMIT", true)
        .await
        .unwrap_err();
    assert!(matches!(err, AppError::Invalid { .. }), "{err:?}");
    let err = f
        .engine
        .explain(
            "m2",
            f.conn,
            "SELECT 1 AS a😀$x$; COMMIT; DELETE FROM explain_scratch; SELECT 1 AS a😀$x$",
            true,
        )
        .await
        .unwrap_err();
    assert!(
        matches!(err, AppError::Invalid { .. } | AppError::Sql { .. }),
        "{err:?}"
    );
    assert_eq!(count().await, vec![Some("10".into()), Some("0".into())]);
    sql(&f, "DROP TABLE explain_scratch").await;
}

#[tokio::test]
async fn explain_respects_read_only() {
    let writer = fixture(false).await;
    sql(&writer, "DROP TABLE IF EXISTS explain_ro_scratch; CREATE TABLE explain_ro_scratch (id int); INSERT INTO explain_ro_scratch VALUES (1), (2)").await;
    let f = fixture(true).await;
    // Plan-only of a write is allowed (nothing runs) …
    let r = f
        .engine
        .explain("p", f.conn, "DELETE FROM explain_ro_scratch", false)
        .await
        .unwrap();
    assert_eq!(r.plan.node_type, "ModifyTable");
    // … ANALYZE of a write fails inside the READ ONLY transaction.
    let err = f
        .engine
        .explain("a", f.conn, "DELETE FROM explain_ro_scratch", true)
        .await
        .unwrap_err();
    assert!(
        matches!(err, AppError::Sql { ref code, .. } if code == "25006"),
        "{err:?}"
    );
    // Transaction-control and multi-statement text is refused before anything runs.
    for text in ["COMMIT", "BEGIN READ WRITE", "VACUUM explain_ro_scratch"] {
        let err = f.engine.explain("c", f.conn, text, true).await.unwrap_err();
        assert!(matches!(err, AppError::Invalid { .. }), "{text}: {err:?}");
    }
    let err = f
        .engine
        .explain(
            "m",
            f.conn,
            "SELECT 1; DELETE FROM explain_ro_scratch",
            true,
        )
        .await
        .unwrap_err();
    assert!(matches!(err, AppError::Invalid { .. }), "{err:?}");
    // A splitter/server disagreement is caught by the server Parse check.
    let err = f.engine
        .explain("s", f.conn, "SELECT 1 AS a😀$x$; COMMIT; SET default_transaction_read_only=off; DELETE FROM explain_ro_scratch; SELECT 1 AS a😀$x$", true)
        .await
        .unwrap_err();
    assert!(
        matches!(err, AppError::Sql { .. } | AppError::Invalid { .. }),
        "{err:?}"
    );
    // SQL error positions point into the user's text, not the EXPLAIN prefix.
    let err = f
        .engine
        .explain("pos", f.conn, "\n  SELECT nope FROM orders", false)
        .await
        .unwrap_err();
    assert!(
        matches!(
            err,
            AppError::Sql {
                position: Some(11),
                ..
            }
        ),
        "{err:?}"
    );
    assert_eq!(
        sql(&writer, "SELECT count(*) FROM explain_ro_scratch").await[0].rows[0][0].as_deref(),
        Some("2")
    );
    sql(&writer, "DROP TABLE explain_ro_scratch").await;
}

#[tokio::test]
async fn explain_analyze_can_be_cancelled() {
    let f = fixture(true).await;
    let engine = f.engine.clone();
    let conn = f.conn;
    let started = Instant::now();
    let task = tokio::spawn(async move {
        engine
            .explain("slow-explain", conn, "SELECT pg_sleep(30)", true)
            .await
    });
    tokio::time::sleep(Duration::from_millis(300)).await;
    f.engine.cancel_query("slow-explain").await.unwrap();
    assert_eq!(task.await.unwrap().unwrap_err(), AppError::Cancelled);
    assert!(
        started.elapsed() < Duration::from_millis(1500),
        "{:?}",
        started.elapsed()
    );
    // The pooled session is usable afterwards.
    assert_eq!(
        sql(&f, "SELECT 1").await[0].rows[0][0].as_deref(),
        Some("1")
    );
}
