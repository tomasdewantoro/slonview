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
    std::env::var("SLONVIEW_TEST_URL")
        .unwrap_or_else(|_| "postgres://tomas@localhost/slonview_fixture".into())
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
        search: None,
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
    let mut r = f
        .engine
        .run_sql("psql", f.conn, sql, 100_000)
        .await
        .unwrap();
    r.pop().unwrap().rows
}

#[tokio::test]
async fn connect_reports_server_info() {
    let f = fixture().await;
    let profile = f.engine.profiles.get(f.conn).unwrap();
    let info = f.engine.test_connection(&profile, None).await.unwrap();
    assert!(info.version.starts_with("PostgreSQL"));
    assert_eq!(info.database, profile.database);
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
    let err = f
        .engine
        .test_connection(&profile, Some("wrong"))
        .await
        .unwrap_err();
    assert!(matches!(err, AppError::Auth { .. }), "{err:?}");
    profile.port = 1;
    let err = f.engine.test_connection(&profile, None).await.unwrap_err();
    assert!(matches!(err, AppError::Connect { .. }), "{err:?}");
    let err = f
        .engine
        .list_schema_tree(uuid::Uuid::new_v4())
        .await
        .unwrap_err();
    assert_eq!(err, AppError::NotConnected);
}

#[tokio::test]
async fn schema_tree_lists_fixture_relations() {
    let f = fixture().await;
    let tree = f.engine.list_schema_tree(f.conn).await.unwrap().schemas;
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
    assert_eq!(
        find("Sales Data", "Weird \"Name\" Table").unwrap().kind,
        RelationKind::Table
    );
    assert_eq!(
        find("public", "paid_orders").unwrap().kind,
        RelationKind::View
    );
    assert_eq!(
        find("public", "order_totals").unwrap().kind,
        RelationKind::MaterializedView
    );
    let events = find("public", "events").unwrap();
    assert_eq!(events.kind, RelationKind::PartitionedTable);
    assert!(
        events.est_rows > 4000 && events.size_bytes > 0,
        "{events:?}"
    );
    assert!(find("public", "events_2024").is_none());
    assert!(
        tree.iter()
            .all(|s| !s.name.starts_with("pg_") && s.name != "information_schema")
    );
    let public: Vec<_> = tree[0].relations.iter().map(|r| r.name.clone()).collect();
    let mut sorted = public.clone();
    sorted.sort();
    assert_eq!(public, sorted);
}

#[tokio::test]
async fn schema_tree_lists_fixture_functions() {
    let f = fixture().await;
    let tree = f.engine.list_schema_tree(f.conn).await.unwrap().schemas;
    let funcs = |schema: &str| {
        tree.iter()
            .find(|s| s.name == schema)
            .unwrap()
            .functions
            .clone()
    };
    let public = funcs("public");
    fn sig(fi: &FunctionInfo) -> (&str, &str, Option<&str>, FunctionKind, &str) {
        (
            fi.name.as_str(),
            fi.args.as_str(),
            fi.result.as_deref(),
            fi.kind,
            fi.language.as_str(),
        )
    }
    let got: Vec<_> = public.iter().map(sig).collect();
    assert_eq!(
        got,
        vec![
            (
                "archive_orders",
                "IN p_before timestamp with time zone, INOUT p_moved bigint",
                None,
                FunctionKind::Procedure,
                "plpgsql"
            ),
            (
                "comma_join",
                "text",
                Some("text"),
                FunctionKind::Aggregate,
                "internal"
            ),
            (
                "customer_label",
                "p_id bigint",
                Some("text"),
                FunctionKind::Function,
                "plpgsql"
            ),
            (
                "customers_email_check",
                "",
                Some("trigger"),
                FunctionKind::Function,
                "plpgsql"
            ),
            (
                "forbid_truncate",
                "",
                Some("trigger"),
                FunctionKind::Function,
                "plpgsql"
            ),
            (
                "order_total",
                "p_customer bigint",
                Some("numeric"),
                FunctionKind::Function,
                "sql"
            ),
            (
                "order_total",
                "p_customer bigint, p_status order_status",
                Some("numeric"),
                FunctionKind::Function,
                "sql"
            ),
            (
                "text_concat_step",
                "acc text, val text",
                Some("text"),
                FunctionKind::Function,
                "sql"
            ),
        ]
    );
    assert!(public.iter().all(|fi| fi.schema == "public" && fi.oid > 0));
    let sales = funcs("Sales Data");
    assert_eq!(
        sales.iter().map(sig).collect::<Vec<_>>(),
        vec![
            (
                "Weird Audit Fn",
                "",
                Some("trigger"),
                FunctionKind::Function,
                "plpgsql"
            ),
            (
                "Weird Total",
                "\"Region Code\" text, include_tax boolean",
                Some("TABLE(\"Region\" text, total numeric)"),
                FunctionKind::Function,
                "sql"
            ),
        ]
    );
    assert!(
        tree.iter()
            .all(|s| s.functions.iter().all(|fi| fi.schema == s.name))
    );
}

#[tokio::test]
async fn schema_tree_lists_sequences_types_triggers_extensions() {
    let f = fixture().await;
    let tree = f.engine.list_schema_tree(f.conn).await.unwrap();
    let schema = |name: &str| {
        tree.schemas
            .iter()
            .find(|s| s.name == name)
            .unwrap()
            .clone()
    };
    let public = schema("public");
    let sales = schema("Sales Data");

    let seqs: Vec<_> = public
        .sequences
        .iter()
        .map(|s| {
            (
                s.name.as_str(),
                s.data_type.as_str(),
                s.readable,
                s.last_value.as_deref(),
            )
        })
        .collect();
    assert_eq!(
        seqs,
        vec![
            ("all_types_id_seq", "integer", true, Some("5")),
            ("customers_id_seq", "bigint", true, Some("1000")),
            ("invoice_number_seq", "integer", true, Some("1010")),
            ("orders_id_seq", "bigint", true, Some("1000000")),
        ]
    );
    let ticket = &sales.sequences[0];
    assert_eq!(
        (
            ticket.name.as_str(),
            ticket.last_value.as_deref(),
            ticket.oid > 0
        ),
        ("Ticket Seq", None, true)
    );

    let types: Vec<_> = public
        .types
        .iter()
        .map(|t| (t.name.as_str(), t.kind, t.detail.as_str()))
        .collect();
    assert_eq!(
        types,
        vec![
            (
                "money_range",
                TypeKind::Composite,
                "low numeric(12,2), high numeric(12,2), currency text"
            ),
            (
                "order_status",
                TypeKind::Enum,
                "pending, paid, shipped, cancelled"
            ),
            (
                "positive_amount",
                TypeKind::Domain,
                "numeric(12,2) NOT NULL CHECK (VALUE >= 0::numeric)"
            ),
        ]
    );
    assert_eq!(sales.types.len(), 1);
    assert_eq!(
        (sales.types[0].name.as_str(), sales.types[0].detail.as_str()),
        ("Region Kind", "north, south's, East West")
    );

    let trig = |t: &TriggerInfo| {
        (
            t.table.clone(),
            t.name.clone(),
            t.timing,
            t.events.clone(),
            t.for_each_row,
            t.enabled,
            t.function.clone(),
        )
    };
    assert_eq!(
        public.triggers.iter().map(trig).collect::<Vec<_>>(),
        vec![
            (
                "customers".into(),
                "customers_email_check".into(),
                TriggerTiming::Before,
                vec![TriggerEvent::Insert, TriggerEvent::Update],
                true,
                true,
                "public.customers_email_check".into()
            ),
            (
                "events".into(),
                "events_audit".into(),
                TriggerTiming::After,
                vec![TriggerEvent::Insert],
                true,
                true,
                "\"Sales Data\".\"Weird Audit Fn\"".into()
            ),
            (
                "orders".into(),
                "orders_no_truncate".into(),
                TriggerTiming::Before,
                vec![TriggerEvent::Truncate],
                false,
                false,
                "public.forbid_truncate".into()
            ),
        ],
        "no internal FK triggers, no partition clones"
    );
    assert_eq!(
        sales.triggers.iter().map(trig).collect::<Vec<_>>(),
        vec![(
            "Weird \"Name\" Table".into(),
            "Weird Audit".into(),
            TriggerTiming::After,
            vec![TriggerEvent::Insert, TriggerEvent::Delete],
            true,
            true,
            "\"Sales Data\".\"Weird Audit Fn\"".into()
        )]
    );
    assert!(
        tree.schemas
            .iter()
            .all(|s| s.sequences.iter().all(|x| x.schema == s.name)
                && s.types.iter().all(|x| x.schema == s.name)
                && s.triggers.iter().all(|x| x.schema == s.name))
    );

    let plpgsql = tree
        .extensions
        .iter()
        .find(|e| e.name == "plpgsql")
        .unwrap();
    assert_eq!(
        (plpgsql.version.as_str(), plpgsql.schema.as_str()),
        ("1.0", "pg_catalog")
    );
    let names: Vec<_> = tree.extensions.iter().map(|e| e.name.clone()).collect();
    let mut sorted = names.clone();
    sorted.sort();
    assert_eq!(names, sorted);
}

/// A role without sequence privileges still gets the tree; unreadable sequences say so.
#[tokio::test]
async fn schema_tree_unreadable_sequence() {
    let ro = fixture_with(|p| p.user = "slonview_ro".into()).await;
    let tree = ro.engine.list_schema_tree(ro.conn).await.unwrap();
    let public = tree.schemas.iter().find(|s| s.name == "public").unwrap();
    let inv = public
        .sequences
        .iter()
        .find(|s| s.name == "invoice_number_seq")
        .unwrap();
    assert!(!inv.readable && inv.last_value.is_none(), "{inv:?}");
    // The definition comes from pg_sequence, which needs no sequence privilege.
    let def = ro
        .engine
        .get_object_definition(ro.conn, ObjectKind::Sequence, inv.oid)
        .await
        .unwrap();
    assert!(
        def.contains("SELECT * FROM public.invoice_number_seq;"),
        "{def}"
    );
}

#[tokio::test]
async fn object_definitions_by_kind() {
    let f = fixture().await;
    let tree = f.engine.list_schema_tree(f.conn).await.unwrap();
    let schema = |name: &str| tree.schemas.iter().find(|s| s.name == name).unwrap();
    let def = |kind: ObjectKind, oid: u32| {
        let engine = f.engine.clone();
        let conn = f.conn;
        async move { engine.get_object_definition(conn, kind, oid).await.unwrap() }
    };
    let seq = |s: &str, n: &str| {
        schema(s)
            .sequences
            .iter()
            .find(|x| x.name == n)
            .unwrap()
            .oid
    };
    let ty = |s: &str, n: &str| schema(s).types.iter().find(|x| x.name == n).unwrap().oid;
    let tg = |s: &str, n: &str| schema(s).triggers.iter().find(|x| x.name == n).unwrap().oid;

    assert_eq!(
        def(ObjectKind::Sequence, seq("public", "invoice_number_seq")).await,
        "-- Sequence public.invoice_number_seq\n\
         --   CREATE SEQUENCE public.invoice_number_seq AS integer\n\
         --     INCREMENT BY 10 MINVALUE 1 MAXVALUE 2147483647 START WITH 1000 CACHE 1 NO CYCLE;\n\
         SELECT * FROM public.invoice_number_seq;\n"
    );
    let owned = def(ObjectKind::Sequence, seq("public", "orders_id_seq")).await;
    assert!(
        owned.contains("--   Owned by public.orders.id\n"),
        "{owned}"
    );
    let quoted = def(ObjectKind::Sequence, seq("Sales Data", "Ticket Seq")).await;
    assert!(
        quoted.ends_with("SELECT * FROM \"Sales Data\".\"Ticket Seq\";\n"),
        "{quoted}"
    );

    assert_eq!(
        def(ObjectKind::Type, ty("public", "order_status")).await,
        "CREATE TYPE public.order_status AS ENUM ('pending', 'paid', 'shipped', 'cancelled');\n"
    );
    assert_eq!(
        def(ObjectKind::Type, ty("Sales Data", "Region Kind")).await,
        "CREATE TYPE \"Sales Data\".\"Region Kind\" AS ENUM ('north', 'south''s', 'East West');\n"
    );
    assert_eq!(
        def(ObjectKind::Type, ty("public", "positive_amount")).await,
        "CREATE DOMAIN public.positive_amount AS numeric(12,2)\n  DEFAULT 0\n  NOT NULL\n  \
         CONSTRAINT positive_amount_check CHECK (VALUE >= 0::numeric);\n\n\
         COMMENT ON DOMAIN public.positive_amount IS 'Money amount, never negative';\n"
    );
    assert_eq!(
        def(ObjectKind::Type, ty("public", "money_range")).await,
        "CREATE TYPE public.money_range AS (\n    low numeric(12,2),\n    high numeric(12,2),\n    currency text COLLATE pg_catalog.\"C\"\n);\n"
    );

    let email = def(ObjectKind::Trigger, tg("public", "customers_email_check")).await;
    assert_eq!(
        email,
        "CREATE TRIGGER customers_email_check BEFORE INSERT OR UPDATE OF email ON public.customers \
         FOR EACH ROW EXECUTE FUNCTION customers_email_check();\n\n\
         -- Trigger function: public.customers_email_check()\n"
    );
    let disabled = def(ObjectKind::Trigger, tg("public", "orders_no_truncate")).await;
    assert!(
        disabled.contains("\nALTER TABLE public.orders DISABLE TRIGGER orders_no_truncate;\n"),
        "{disabled}"
    );
    let weird = def(ObjectKind::Trigger, tg("Sales Data", "Weird Audit")).await;
    assert!(weird.starts_with("CREATE TRIGGER \"Weird Audit\" AFTER INSERT OR DELETE ON \"Sales Data\".\"Weird \"\"Name\"\" Table\""), "{weird}");

    let plpgsql = tree
        .extensions
        .iter()
        .find(|e| e.name == "plpgsql")
        .unwrap()
        .oid;
    assert_eq!(
        def(ObjectKind::Extension, plpgsql).await,
        "-- PL/pgSQL procedural language\nCREATE EXTENSION plpgsql WITH SCHEMA pg_catalog VERSION '1.0';\n"
    );

    for kind in [
        ObjectKind::Sequence,
        ObjectKind::Type,
        ObjectKind::Trigger,
        ObjectKind::Extension,
    ] {
        let err = f
            .engine
            .get_object_definition(f.conn, kind, 4_000_000_000)
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Invalid { .. }), "{kind:?}: {err:?}");
    }
    let int4 = psql_values(&f, "select 'int4'::regtype::oid::text").await[0][0]
        .clone()
        .unwrap()
        .parse()
        .unwrap();
    let err = f
        .engine
        .get_object_definition(f.conn, ObjectKind::Type, int4)
        .await
        .unwrap_err();
    assert!(matches!(err, AppError::Invalid { .. }), "{err:?}");
    let err = f
        .engine
        .get_object_definition(uuid::Uuid::new_v4(), ObjectKind::Type, 1)
        .await
        .unwrap_err();
    assert_eq!(err, AppError::NotConnected);
}

#[tokio::test]
async fn function_definitions_by_kind() {
    let f = fixture().await;
    let tree = f.engine.list_schema_tree(f.conn).await.unwrap().schemas;
    let oid = |schema: &str, name: &str, args: &str| {
        tree.iter()
            .find(|s| s.name == schema)
            .and_then(|s| {
                s.functions
                    .iter()
                    .find(|fi| fi.name == name && fi.args == args)
            })
            .unwrap_or_else(|| panic!("{schema}.{name}({args}) missing"))
            .oid
    };
    let def = |o: u32| {
        let engine = f.engine.clone();
        let conn = f.conn;
        async move { engine.get_function_definition(conn, o).await }
    };

    let plpgsql = def(oid("public", "customer_label", "p_id bigint"))
        .await
        .unwrap();
    assert!(
        plpgsql.starts_with("CREATE OR REPLACE FUNCTION public.customer_label(p_id bigint)"),
        "{plpgsql}"
    );
    assert!(plpgsql.contains("LANGUAGE plpgsql") && plpgsql.contains("SELECT name INTO v_name"));

    let one = def(oid("public", "order_total", "p_customer bigint"))
        .await
        .unwrap();
    let two = def(oid(
        "public",
        "order_total",
        "p_customer bigint, p_status order_status",
    ))
    .await
    .unwrap();
    assert!(
        one.starts_with("CREATE OR REPLACE FUNCTION public.order_total(p_customer bigint)\n"),
        "{one}"
    );
    assert!(two.contains("p_status order_status") && !one.contains("p_status"));

    let proc = def(oid(
        "public",
        "archive_orders",
        "IN p_before timestamp with time zone, INOUT p_moved bigint",
    ))
    .await
    .unwrap();
    assert!(
        proc.starts_with("CREATE OR REPLACE PROCEDURE public.archive_orders("),
        "{proc}"
    );

    let quoted = def(oid(
        "Sales Data",
        "Weird Total",
        "\"Region Code\" text, include_tax boolean",
    ))
    .await
    .unwrap();
    assert!(
        quoted.starts_with("CREATE OR REPLACE FUNCTION \"Sales Data\".\"Weird Total\"("),
        "{quoted}"
    );

    let agg = def(oid("public", "comma_join", "text")).await.unwrap();
    assert_eq!(
        agg,
        "-- Aggregate function public.comma_join(text)\n\
         -- Returns: text\n\
         --\n\
         -- pg_get_functiondef does not support aggregates; details from pg_aggregate:\n\
         --   KIND      = normal\n\
         --   SFUNC     = text_concat_step(text,text)\n\
         --   STYPE     = text\n\
         --   FINALFUNC = (none)\n\
         --   INITCOND  = ''\n"
    );

    // A built-in window function (not in the tree, but any pg_proc oid is accepted).
    let row_number = psql_values(&f, "select 'row_number()'::regprocedure::oid::text").await;
    let window = def(row_number[0][0].as_deref().unwrap().parse().unwrap())
        .await
        .unwrap();
    assert!(
        window.starts_with("CREATE OR REPLACE FUNCTION pg_catalog.row_number()"),
        "{window}"
    );
    assert!(window.contains("WINDOW"), "{window}");

    let err = def(4_000_000_000).await.unwrap_err();
    assert!(matches!(err, AppError::Invalid { .. }), "{err:?}");
    let err = f
        .engine
        .get_function_definition(uuid::Uuid::new_v4(), 1)
        .await
        .unwrap_err();
    assert_eq!(err, AppError::NotConnected);
}

#[tokio::test]
async fn describe_orders() {
    let f = fixture().await;
    let d = f
        .engine
        .describe_table(f.conn, "public", "orders")
        .await
        .unwrap();
    assert_eq!(d.kind, RelationKind::Table);
    let id = &d.columns[0];
    assert_eq!(
        (
            id.name.as_str(),
            id.type_name.as_str(),
            id.is_pk,
            id.nullable
        ),
        ("id", "bigint", true, false)
    );
    assert!(id.default.as_deref().unwrap().starts_with("nextval("));
    let amount = d.columns.iter().find(|c| c.name == "amount").unwrap();
    assert_eq!(amount.type_name, "numeric(12,2)");
    assert!(
        d.columns
            .iter()
            .find(|c| c.name == "note")
            .unwrap()
            .nullable
    );
    assert!(d.columns.iter().filter(|c| c.is_pk).count() == 1);
    let names: HashSet<_> = d.indexes.iter().map(|i| i.name.as_str()).collect();
    assert_eq!(
        names,
        HashSet::from(["orders_pkey", "orders_status_idx", "orders_created_at_idx"])
    );
    assert!(d.indexes[0].is_primary && d.indexes[0].definition.contains("USING btree (id)"));
    assert_eq!(d.foreign_keys.len(), 1);
    assert_eq!(
        d.foreign_keys[0].definition,
        "FOREIGN KEY (customer_id) REFERENCES customers(id)"
    );
    assert!(d.view_definition.is_none());

    let v = f
        .engine
        .describe_table(f.conn, "public", "paid_orders")
        .await
        .unwrap();
    assert_eq!(v.kind, RelationKind::View);
    assert!(v.view_definition.unwrap().contains("'paid'"));
    let m = f
        .engine
        .describe_table(f.conn, "public", "order_totals")
        .await
        .unwrap();
    assert!(m.view_definition.is_some());
    let err = f
        .engine
        .describe_table(f.conn, "public", "nope")
        .await
        .unwrap_err();
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
    assert_eq!(
        p1.next_cursor,
        Some(Cursor::Keyset {
            values: vec![Some("500".into())]
        })
    );
    req.cursor = p1.next_cursor;
    let p2 = f.engine.fetch_page("p2", &req).await.unwrap();
    assert_eq!(p2.rows[0][0].as_deref(), Some("501"));
    assert!(p2.sql.contains("> ('500'::bigint)"), "{}", p2.sql);
}

#[tokio::test]
async fn page_columns_report_single_column_foreign_keys() {
    let f = fixture().await;
    let orders = f
        .engine
        .fetch_page("fk1", &page_req(f.conn, "public", "orders"))
        .await
        .unwrap();
    let by_name = |p: &Page, n: &str| p.columns.iter().find(|c| c.name == n).unwrap().clone();
    assert_eq!(
        by_name(&orders, "customer_id").references,
        Some(ForeignKeyTarget {
            schema: "public".into(),
            table: "customers".into(),
            column: "id".into(),
        })
    );
    assert_eq!(by_name(&orders, "id").references, None);

    let links = f
        .engine
        .fetch_page("fk2", &page_req(f.conn, "public", "fk_links"))
        .await
        .unwrap();
    // Quoted schema/table/column names come back raw (unquoted), ready to use as a filter target.
    assert_eq!(
        by_name(&links, "weird_id").references,
        Some(ForeignKeyTarget {
            schema: "Sales Data".into(),
            table: "Weird \"Name\" Table".into(),
            column: "Id".into(),
        })
    );
    // A two-column key can't be followed from one cell.
    assert_eq!(by_name(&links, "tenant").references, None);
    assert_eq!(by_name(&links, "item").references, None);

    // Following the reference = filtering the target on the value: exactly one row.
    let value = links.rows[4][1].clone().unwrap();
    let mut target = page_req(f.conn, "Sales Data", "Weird \"Name\" Table");
    target.filters = vec![Filter {
        column: "Id".into(),
        op: FilterOp::Eq,
        value: Some(value.clone()),
    }];
    let hit = f.engine.fetch_page("fk3", &target).await.unwrap();
    assert_eq!(hit.rows.len(), 1);
    assert_eq!(hit.rows[0][0], Some(value));
}

#[tokio::test]
async fn first_page_carries_row_estimate() {
    let f = fixture().await;
    // Unfiltered: reltuples, available instantly (seed.sql ends with ANALYZE).
    let mut req = page_req(f.conn, "public", "orders");
    let p1 = f.engine.fetch_page("e1", &req).await.unwrap();
    let est = p1.est_rows.expect("estimate for a 1M-row table");
    assert!((900_000..=1_100_000).contains(&est), "{est}");
    // Later pages don't repeat it.
    req.cursor = p1.next_cursor;
    assert_eq!(
        f.engine.fetch_page("e2", &req).await.unwrap().est_rows,
        None
    );

    // Filtered: the planner's estimate, within a factor of two of the real count.
    let mut filtered = page_req(f.conn, "public", "orders");
    filtered.filters = vec![Filter {
        column: "status".into(),
        op: FilterOp::Eq,
        value: Some("paid".into()),
    }];
    let est = f
        .engine
        .fetch_page("e3", &filtered)
        .await
        .unwrap()
        .est_rows
        .expect("planner estimate");
    let real: i64 = psql_values(&f, "SELECT count(*) FROM orders WHERE status = 'paid'").await[0]
        [0]
    .as_deref()
    .unwrap()
    .parse()
    .unwrap();
    assert!(
        est > real / 2 && est < real * 2,
        "estimate {est}, real {real}"
    );

    // Raw WHERE: user text is never handed to EXPLAIN.
    filtered.raw_where = Some("amount > 10".into());
    assert_eq!(
        f.engine.fetch_page("e4", &filtered).await.unwrap().est_rows,
        None
    );

    // Fits in one page: nothing to estimate.
    let small = f
        .engine
        .fetch_page("e5", &page_req(f.conn, "public", "fk_links"))
        .await
        .unwrap();
    assert!(small.next_cursor.is_none() && small.est_rows.is_none());

    // View: no reltuples, the planner estimates it.
    let view = f
        .engine
        .fetch_page("e6", &page_req(f.conn, "public", "paid_orders"))
        .await
        .unwrap();
    assert!(
        view.est_rows.is_some_and(|n| n > 500),
        "{:?}",
        view.est_rows
    );

    // Partitioned parent: leaves summed.
    let events = f
        .engine
        .fetch_page("e7", &page_req(f.conn, "public", "events"))
        .await
        .unwrap();
    assert_eq!(events.est_rows, Some(5000));
}

#[tokio::test]
async fn estimate_respects_read_only_and_leaves_no_trace() {
    // EXPLAIN without ANALYZE never runs the statement; on a read-only session it must succeed.
    let f = fixture().await;
    let mut req = page_req(f.conn, "public", "orders");
    req.filters = vec![Filter {
        column: "amount".into(),
        op: FilterOp::Gt,
        value: Some("100".into()),
    }];
    let p = f.engine.fetch_page("ro", &req).await.unwrap();
    assert!(p.est_rows.is_some());
    // The session is still usable and still read-only afterwards.
    let err = f
        .engine
        .run_sql("ro2", f.conn, "DELETE FROM orders WHERE id = -1", 10)
        .await
        .unwrap_err();
    assert!(format!("{err:?}").contains("25006"), "{err:?}");
}

#[tokio::test]
async fn filter_and_sort_match_direct_sql() {
    let f = fixture().await;
    let mut req = page_req(f.conn, "public", "orders");
    req.filters = vec![Filter {
        column: "status".into(),
        op: FilterOp::Eq,
        value: Some("paid".into()),
    }];
    req.sort = vec![Sort {
        column: "created_at".into(),
        desc: true,
    }];
    let p1 = f.engine.fetch_page("f1", &req).await.unwrap();
    let expected = psql_values(
        &f,
        "SELECT id::text FROM orders WHERE status = 'paid' ORDER BY created_at DESC, id LIMIT 1000",
    )
    .await;
    let got: Vec<_> = p1.rows.iter().map(|r| r[0].clone()).collect();
    let want: Vec<_> = expected.iter().map(|r| r[0].clone()).collect();
    assert_eq!(got, want[..500]);
    assert!(matches!(p1.next_cursor, Some(Cursor::Keyset { .. })));
    req.cursor = p1.next_cursor;
    let p2 = f.engine.fetch_page("f2", &req).await.unwrap();
    let got2: Vec<_> = p2.rows.iter().map(|r| r[0].clone()).collect();
    assert_eq!(got2, want[500..]);

    let n = f
        .engine
        .count_exact(
            "c",
            f.conn,
            "public",
            "orders",
            &req.filters,
            None,
            Some("amount > 500"),
        )
        .await
        .unwrap();
    let want_n = psql_values(
        &f,
        "SELECT count(*) FROM orders WHERE status = 'paid' AND amount > 500",
    )
    .await;
    assert_eq!(Some(n.to_string()), want_n[0][0]);

    // IN / LIKE / IS NULL / raw where.
    req.sort.clear();
    req.cursor = None;
    req.filters = vec![
        Filter {
            column: "status".into(),
            op: FilterOp::In,
            value: Some("paid, shipped".into()),
        },
        Filter {
            column: "note".into(),
            op: FilterOp::IsNull,
            value: None,
        },
    ];
    req.raw_where = Some("id < 100".into());
    let p = f.engine.fetch_page("f3", &req).await.unwrap();
    let ids: Vec<_> = p.rows.iter().map(|r| r[0].clone().unwrap()).collect();
    assert_eq!(ids, ["10", "30", "50", "70", "90"]);
    assert!(p.next_cursor.is_none());

    req.filters = vec![Filter {
        column: "missing".into(),
        op: FilterOp::Eq,
        value: Some("1".into()),
    }];
    assert!(matches!(
        f.engine.fetch_page("f4", &req).await.unwrap_err(),
        AppError::Invalid { .. }
    ));
    req.filters.clear();
    req.raw_where = Some("nonsense_col = 1".into());
    let err = f.engine.fetch_page("f5", &req).await.unwrap_err();
    assert!(
        matches!(err, AppError::Sql { ref code, .. } if code == "42703"),
        "{err:?}"
    );
}

#[tokio::test]
async fn weird_names_page_and_sort() {
    let f = fixture().await;
    let mut req = page_req(f.conn, "Sales Data", "Weird \"Name\" Table");
    req.limit = 100;
    let rows = fetch_all(&f, req.clone()).await;
    assert_eq!(rows.len(), 250);
    assert_eq!(rows[249][0].as_deref(), Some("250"));
    req.sort = vec![Sort {
        column: "Column With Space".into(),
        desc: true,
    }];
    req.filters = vec![Filter {
        column: "ünïcödé".into(),
        op: FilterOp::Like,
        value: Some("ü2%".into()),
    }];
    let p = f.engine.fetch_page("w", &req).await.unwrap();
    assert_eq!(p.rows[0][1].as_deref(), Some("value 29"));
    assert_eq!(
        p.columns
            .iter()
            .map(|c| c.name.as_str())
            .collect::<Vec<_>>(),
        ["Id", "Column With Space", "select", "ünïcödé"]
    );
    let cell = CellRequest {
        conn_id: f.conn,
        schema: "Sales Data".into(),
        table: "Weird \"Name\" Table".into(),
        pk_columns: vec!["Id".into()],
        pk_values: vec![Some("7".into())],
        column: "select".into(),
    };
    assert_eq!(
        f.engine.get_cell(&cell).await.unwrap().as_deref(),
        Some("kw 7")
    );
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

    let p = f
        .engine
        .fetch_page("v", &page_req(f.conn, "public", "paid_orders"))
        .await
        .unwrap();
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
    let p = f
        .engine
        .fetch_page("t", &page_req(f.conn, "public", "all_types"))
        .await
        .unwrap();
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
    assert!(matches!(
        f.engine.get_cell(&cell).await.unwrap_err(),
        AppError::Invalid { .. }
    ));
}

#[tokio::test]
async fn read_only_blocks_writes() {
    let f = fixture().await;
    let err = f
        .engine
        .run_sql("ro", f.conn, "DELETE FROM orders", 10)
        .await
        .unwrap_err();
    assert!(
        matches!(err, AppError::Sql { ref code, .. } if code == "25006"),
        "{err:?}"
    );
    // A user SET of read-only off must not leak into later calls on the pooled session.
    let r = f
        .engine
        .run_sql("ro2", f.conn, "SET default_transaction_read_only = off; SET statement_timeout = 0; SHOW statement_timeout", 10)
        .await
        .unwrap();
    assert_eq!(r[2].rows[0][0].as_deref(), Some("0"));
    for i in 0..6 {
        let r = f
            .engine
            .run_sql(
                &format!("ro3-{i}"),
                f.conn,
                "SHOW default_transaction_read_only",
                10,
            )
            .await
            .unwrap();
        assert_eq!(r[0].rows[0][0].as_deref(), Some("on"));
    }
}

/// Several connections open at once: each request runs on its own profile's session and mode.
#[tokio::test]
async fn read_only_and_writable_sessions_coexist() {
    let f = fixture().await;
    let mut writable = f.engine.profiles.get(f.conn).unwrap();
    writable.id = uuid::Uuid::new_v4();
    writable.name = "writable twin".into();
    writable.read_only = false;
    if let Some(pw) = f.engine.secrets.get(f.conn).unwrap() {
        f.engine.secrets.set(writable.id, &pw).unwrap();
    }
    f.engine.profiles.upsert(writable.clone()).unwrap();
    assert!(!f.engine.connect(writable.id).await.unwrap().read_only);

    let write = "UPDATE scratch_insert_target SET note = note WHERE false";
    let err = f
        .engine
        .run_sql("coexist-ro", f.conn, write, 10)
        .await
        .unwrap_err();
    assert!(
        matches!(err, AppError::Sql { ref code, .. } if code == "25006"),
        "{err:?}"
    );
    let ok = f
        .engine
        .run_sql("coexist-rw", writable.id, write, 10)
        .await
        .unwrap();
    assert_eq!(ok[0].rows_affected, Some(0));
    // Closing one connection leaves the other's session open, still read-only.
    f.engine.disconnect(writable.id).await.unwrap();
    let r = f
        .engine
        .run_sql(
            "coexist-ro2",
            f.conn,
            "SHOW default_transaction_read_only",
            10,
        )
        .await
        .unwrap();
    assert_eq!(r[0].rows[0][0].as_deref(), Some("on"));
    assert!(matches!(
        f.engine
            .run_sql("coexist-gone", writable.id, "SELECT 1", 10)
            .await
            .unwrap_err(),
        AppError::NotConnected
    ));
}

#[tokio::test]
async fn read_only_preflights_transaction_and_maintenance_commands() {
    let f = fixture().await;
    let writable = fixture_with(|p| p.read_only = false).await;
    for command in [
        "BEGIN READ WRITE",
        "START TRANSACTION",
        "COMMIT",
        "END",
        "ROLLBACK",
        "ABORT",
        "PREPARE TRANSACTION 'x'",
        "COMMIT PREPARED 'x'",
        "ROLLBACK PREPARED 'x'",
        "SET TRANSACTION READ WRITE",
        "SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE",
        "VACUUM orders",
        "CREATE DATABASE ro_guard_db",
        "DROP DATABASE ro_guard_db",
        "CREATE TABLESPACE ro_guard_space LOCATION '/tmp'",
        "DROP TABLESPACE ro_guard_space",
        "ALTER SYSTEM SET work_mem = '8MB'",
        "CREATE INDEX CONCURRENTLY x ON orders(id)",
        "CREATE UNIQUE INDEX CONCURRENTLY x ON orders(id)",
        "REINDEX TABLE CONCURRENTLY orders",
        "LOCK TABLE orders IN ACCESS EXCLUSIVE MODE",
    ] {
        let sql =
            format!("SELECT 'ñ';  /* comment */ {command}; CREATE TABLE ro_guard_escape(a int)");
        let err = f
            .engine
            .run_sql("preflight", f.conn, &sql, 10)
            .await
            .unwrap_err();
        // `/* comment */ …` starts at char 14 (1-based), after "SELECT 'ñ';" (11 chars) and two spaces.
        assert!(
            matches!(err, AppError::Invalid { position: Some(14), ref message } if message.contains("Read-only mode:") && message.contains("Allow writes")),
            "{command}: {err:?}"
        );
    }
    for script in [
        "BEGIN READ WRITE; CREATE TABLE ro_guard_escape(a int); COMMIT",
        "BEGIN READ ONLY; SET TRANSACTION READ WRITE; CREATE TABLE ro_guard_escape(a int); COMMIT",
        "COMMIT; BEGIN READ WRITE; CREATE TABLE ro_guard_escape(a int); COMMIT",
        "SET default_transaction_read_only = off; COMMIT; CREATE TABLE ro_guard_escape(a int)",
    ] {
        assert!(matches!(
            f.engine
                .run_sql("escape", f.conn, script, 10)
                .await
                .unwrap_err(),
            AppError::Invalid { .. }
        ));
    }
    assert_eq!(
        psql_values(&writable, "SELECT to_regclass('ro_guard_escape')::text").await[0][0],
        None
    );
    assert!(
        f.engine
            .history
            .list(Some(f.conn), Some("ro_guard_escape"), 100)
            .unwrap()
            .iter()
            .all(|h| h.error.is_some())
    );
}

#[tokio::test]
async fn read_only_snapshot_and_guc_changes_cannot_enable_writes() {
    let f = fixture().await;
    for script in [
        "SET default_transaction_read_only = off; DELETE FROM scratch_insert_target",
        "SET transaction_read_only = off; DELETE FROM scratch_insert_target",
        "SELECT set_config('transaction_read_only','off',true); DELETE FROM scratch_insert_target",
    ] {
        let err = f
            .engine
            .run_sql("guc", f.conn, script, 10)
            .await
            .unwrap_err();
        assert!(
            matches!(err, AppError::Sql { ref code, .. } if code == "25006" || code == "25001"),
            "{err:?}"
        );
        assert_eq!(
            psql_values(&f, "SHOW transaction_read_only").await[0][0].as_deref(),
            Some("on")
        );
    }
    f.engine
        .run_sql(
            "setconfig",
            f.conn,
            "SELECT set_config('default_transaction_read_only','off',false)",
            10,
        )
        .await
        .unwrap();
    let err = f
        .engine
        .run_sql("later", f.conn, "DELETE FROM scratch_insert_target", 10)
        .await
        .unwrap_err();
    assert!(
        matches!(err, AppError::Sql { ref code, .. } if code == "25006"),
        "{err:?}"
    );
    let r = f
        .engine
        .run_sql(
            "savepoints",
            f.conn,
            "SAVEPOINT a; SELECT 1; ROLLBACK TO SAVEPOINT a; RELEASE a; SELECT 2",
            10,
        )
        .await
        .unwrap();
    assert_eq!(r.len(), 5);
    assert_eq!(r[1].rows[0][0].as_deref(), Some("1"));
    assert_eq!(r[4].rows[0][0].as_deref(), Some("2"));
    let err = f
        .engine
        .run_sql("nextval", f.conn, "SELECT nextval('orders_id_seq')", 10)
        .await
        .unwrap_err();
    assert!(
        matches!(err, AppError::Sql { ref code, .. } if code == "25006"),
        "{err:?}"
    );
}

#[tokio::test]
async fn writable_explicit_transaction_still_commits() {
    let f = fixture_with(|p| p.read_only = false).await;
    let sql = "BEGIN; CREATE TABLE ro_guard_writable(a int); INSERT INTO ro_guard_writable VALUES (1); COMMIT";
    assert_eq!(
        f.engine
            .run_sql("write-tx", f.conn, sql, 10)
            .await
            .unwrap()
            .len(),
        4
    );
    assert_eq!(
        psql_values(&f, "SELECT count(*) FROM ro_guard_writable").await[0][0].as_deref(),
        Some("1")
    );
    f.engine
        .run_sql("cleanup", f.conn, "DROP TABLE ro_guard_writable", 10)
        .await
        .unwrap();
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
        let source = ExportSource::Table {
            conn_id: f.conn,
            schema: "public".into(),
            table: "scratch_insert_target".into(),
            filters: vec![],
            raw_where: Some(raw.into()),
            search: None,
            sort: vec![],
        };
        let errors = [
            f.engine.fetch_page("raw-page", &req).await.unwrap_err(),
            f.engine
                .count_exact(
                    "raw-count",
                    f.conn,
                    "public",
                    "scratch_insert_target",
                    &[],
                    None,
                    Some(raw),
                )
                .await
                .unwrap_err(),
            f.engine
                .export_rows("raw-export", &source, ExportFormat::Csv, &path)
                .await
                .unwrap_err(),
        ];
        for err in errors {
            assert!(
                matches!(err, AppError::Invalid { .. } | AppError::Sql { .. }),
                "{err:?}"
            );
        }
        assert!(!path.exists());
        assert_eq!(
            psql_values(&verifier, "SELECT count(*) FROM scratch_insert_target").await,
            before
        );
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
    req.raw_where =
        Some("set_config('default_transaction_read_only', 'off', false) IS NOT NULL".into());
    // More pages than the pool size (4), so every pooled session has run the expression.
    for i in 0..6 {
        f.engine
            .fetch_page(&format!("guc-{i}"), &req)
            .await
            .unwrap();
    }
    // Every pooled session must still default to read-only. Probe through the pool with a
    // count whose Raw WHERE is true only while the session default is still on.
    for i in 0..6 {
        let n = f
            .engine
            .count_exact(
                &format!("probe-{i}"),
                f.conn,
                "public",
                "no_pk",
                &[],
                None,
                Some("current_setting('default_transaction_read_only') = 'on'"),
            )
            .await
            .unwrap();
        assert_eq!(
            n, 1200,
            "pooled session {i} lost default_transaction_read_only"
        );
    }
    req.raw_where = Some("nextval('orders_id_seq') > 0".into());
    let err = f.engine.fetch_page("nextval", &req).await.unwrap_err();
    assert!(
        matches!(err, AppError::Sql { ref code, .. } if code == "25006"),
        "{err:?}"
    );
    let err = f
        .engine
        .count_exact(
            "nextval-count",
            f.conn,
            "public",
            "no_pk",
            &[],
            None,
            Some("nextval('orders_id_seq') > 0"),
        )
        .await
        .unwrap_err();
    assert!(
        matches!(err, AppError::Sql { ref code, .. } if code == "25006"),
        "{err:?}"
    );
    assert_eq!(
        psql_values(&verifier, "SELECT last_value::text FROM orders_id_seq").await,
        seq_before
    );
}

#[tokio::test]
async fn read_only_export_rejects_writes_and_splitter_disagreement() {
    let f = fixture().await;
    let verifier = fixture_with(|p| p.read_only = false).await;
    let before = psql_values(&verifier, "SELECT count(*) FROM scratch_insert_target").await;
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("readonly.csv");
    for sql in [
        "DELETE FROM scratch_insert_target RETURNING *",
        "BEGIN READ WRITE",
        "COMMIT",
        "VACUUM orders",
    ] {
        let source = ExportSource::Sql {
            conn_id: f.conn,
            sql: sql.into(),
        };
        assert!(
            f.engine
                .export_rows("write-export", &source, ExportFormat::Csv, &path)
                .await
                .is_err()
        );
        assert!(!path.exists());
    }
    // PostgreSQL treats non-ASCII bytes (including emoji) as identifier letters;
    // our splitter treats this emoji as a boundary and consumes a dollar body.
    // Server Parse must reject the resulting piece before any command executes.
    let sql = "SELECT 1 AS a😀$tag$; COMMIT; SET default_transaction_read_only=off; COMMIT; DELETE FROM scratch_insert_target; SELECT 1 AS a😀$tag$";
    assert!(
        f.engine
            .run_sql("split-edge", f.conn, sql, 10)
            .await
            .is_err()
    );
    let src = ExportSource::Sql {
        conn_id: f.conn,
        sql: "SELECT 1 AS n".into(),
    };
    assert_eq!(
        f.engine
            .export_rows("good-export", &src, ExportFormat::Csv, &path)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        psql_values(&verifier, "SELECT count(*) FROM scratch_insert_target").await,
        before
    );
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
    let r = f
        .engine
        .run_sql(
            "tx",
            f.conn,
            "BEGIN; CREATE TABLE slonview_core_db_tx (a int)",
            10,
        )
        .await
        .unwrap();
    assert_eq!(r.len(), 2);
    let r = f
        .engine
        .run_sql(
            "tx2",
            f.conn,
            "SELECT to_regclass('slonview_core_db_tx')::text",
            10,
        )
        .await
        .unwrap();
    assert_eq!(r[0].rows[0][0], None);
}

#[tokio::test]
async fn cancel_running_query() {
    let f = fixture().await;
    let engine = f.engine.clone();
    let conn = f.conn;
    let started = Instant::now();
    let task = tokio::spawn(async move {
        engine
            .run_sql("sleepy", conn, "SELECT pg_sleep(30)", 10)
            .await
    });
    tokio::time::sleep(Duration::from_millis(300)).await;
    f.engine.cancel_query("sleepy").await.unwrap();
    let err = task.await.unwrap().unwrap_err();
    assert_eq!(err, AppError::Cancelled);
    assert!(
        started.elapsed() < Duration::from_millis(1300),
        "{:?}",
        started.elapsed()
    );
    f.engine.cancel_query("unknown").await.unwrap();
    // History recorded the failure.
    let h = f
        .engine
        .history
        .list(Some(conn), Some("pg_sleep"), 10)
        .unwrap();
    assert_eq!(h[0].error.as_deref(), Some("query cancelled"));
}

/// A cancel that arrives while the request still waits for a client or reads metadata (before
/// it registers) must still stop it: the query is never sent.
#[tokio::test]
async fn cancel_before_the_request_registers() {
    let f = fixture().await;
    f.engine.cancel_query("early-count").await.unwrap();
    let err = f
        .engine
        .count_exact(
            "early-count",
            f.conn,
            "public",
            "orders",
            &[],
            None,
            Some("pg_sleep(5) IS NOT NULL"),
        )
        .await
        .unwrap_err();
    assert_eq!(err, AppError::Cancelled);
    // The early cancel is used up: the same id runs normally afterwards.
    assert_eq!(
        f.engine
            .count_exact(
                "early-count",
                f.conn,
                "public",
                "customers",
                &[],
                None,
                None
            )
            .await
            .unwrap(),
        1000
    );
}

#[tokio::test]
async fn statement_timeout_maps_to_timeout() {
    let f = fixture_with(|p| p.statement_timeout_ms = 500).await;
    let started = Instant::now();
    let err = f
        .engine
        .run_sql("slow", f.conn, "SELECT pg_sleep(2)", 10)
        .await
        .unwrap_err();
    assert_eq!(err, AppError::Timeout);
    assert!(started.elapsed() < Duration::from_millis(1500));
}

#[tokio::test]
async fn multi_statement_scripts() {
    let f = fixture().await;
    let r = f
        .engine
        .run_sql("m", f.conn, "SELECT 1; SELECT $$a;b$$; select 'x;y'", 10)
        .await
        .unwrap();
    assert_eq!(r.len(), 3);
    assert_eq!(r[0].statement, "SELECT 1");
    assert_eq!(r[1].rows[0][0].as_deref(), Some("a;b"));
    assert_eq!(r[2].rows[0][0].as_deref(), Some("x;y"));
    assert_eq!(r[2].columns[0].name, "?column?");

    let r = f
        .engine
        .run_sql("cap", f.conn, "SELECT generate_series(1, 50)", 10)
        .await
        .unwrap();
    assert_eq!(r[0].rows.len(), 10);
    assert!(r[0].truncated);

    let err = f
        .engine
        .run_sql("bad", f.conn, "SELECT 1;\nSELECT nope", 10)
        .await
        .unwrap_err();
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
        search: None,
        sort: vec![],
    };
    let n = f
        .engine
        .export_rows("e", &source, ExportFormat::Csv, &path)
        .await
        .unwrap();
    assert_eq!(n, 1_000_000);
    let text = std::fs::read_to_string(&path).unwrap();
    assert_eq!(text.lines().count(), 1_000_001);
    assert!(text.starts_with("id,customer_id,status,amount,note,created_at\n1,2,paid,"));

    // Embedded newlines are one row each.
    let path2 = dir.path().join("types.csv");
    let src = ExportSource::Sql {
        conn_id: f.conn,
        sql: "SELECT c_varchar FROM all_types ORDER BY id;".into(),
    };
    assert_eq!(
        f.engine
            .export_rows("e2", &src, ExportFormat::Csv, &path2)
            .await
            .unwrap(),
        5
    );
    let src = ExportSource::Sql {
        conn_id: f.conn,
        sql: "SELECT 1; SELECT 2".into(),
    };
    assert!(matches!(
        f.engine
            .export_rows("e3", &src, ExportFormat::Csv, &path2)
            .await
            .unwrap_err(),
        AppError::Invalid { .. }
    ));
}

#[tokio::test]
async fn cancel_export() {
    let f = fixture().await;
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("slow.csv");
    let engine = f.engine.clone();
    let p = path.clone();
    let src = ExportSource::Sql {
        conn_id: f.conn,
        sql: "SELECT pg_sleep(30)".into(),
    };
    let task =
        tokio::spawn(async move { engine.export_rows("exp", &src, ExportFormat::Csv, &p).await });
    tokio::time::sleep(Duration::from_millis(300)).await;
    f.engine.cancel_query("exp").await.unwrap();
    assert_eq!(task.await.unwrap().unwrap_err(), AppError::Cancelled);
    assert!(!path.exists());
}

#[tokio::test]
async fn disconnect_drops_pool() {
    let f = fixture().await;
    f.engine.disconnect(f.conn).await.unwrap();
    assert_eq!(
        f.engine.list_schema_tree(f.conn).await.unwrap_err(),
        AppError::NotConnected
    );
    f.engine.disconnect(f.conn).await.unwrap();
}

/// `created_at` of orders id 1 (seed: 2023-12-31 17:00:01 UTC), first row in pk order.
async fn first_order_created_at(f: &Fixture) -> String {
    let page = f
        .engine
        .fetch_page("tz", &page_req(f.conn, "public", "orders"))
        .await
        .unwrap();
    let col = page
        .columns
        .iter()
        .position(|c| c.name == "created_at")
        .unwrap();
    assert_eq!(page.columns[col].type_name, "timestamp with time zone");
    assert_eq!(page.rows[0][0].as_deref(), Some("1"));
    page.rows[0][col].clone().unwrap()
}

const TZ_PROBE: &str =
    "SELECT timestamptz '2026-11-20 14:52:33+00'::text, current_setting('TimeZone')";

#[tokio::test]
async fn profile_time_zone_applies_to_browse_and_sql() {
    // The fixture server's own default may already be Asia/Jakarta, so UTC proves the
    // zone comes from the profile, not the server.
    for (tz, sql_want, browse_want) in [
        ("UTC", "2026-11-20 14:52:33+00", "2023-12-31 17:00:01+00"),
        (
            "Asia/Jakarta",
            "2026-11-20 21:52:33+07",
            "2024-01-01 00:00:01+07",
        ),
    ] {
        let f = fixture_with(|p| p.time_zone = Some(tz.into())).await;
        assert_eq!(first_order_created_at(&f).await, browse_want, "{tz} browse");
        let want = vec![vec![Some(sql_want.to_owned()), Some(tz.to_owned())]];
        assert_eq!(psql_values(&f, TZ_PROBE).await, want, "{tz} run_sql");
        // A user SET TIME ZONE in one run is undone; the profile zone is re-applied.
        let changed =
            psql_values(&f, &format!("SET TIME ZONE 'America/New_York'; {TZ_PROBE}")).await;
        assert_eq!(changed[0][1].as_deref(), Some("America/New_York"));
        assert_eq!(psql_values(&f, TZ_PROBE).await, want, "{tz} second run_sql");
        assert_eq!(psql_values(&f, TZ_PROBE).await, want, "{tz} third run_sql");
        assert_eq!(
            first_order_created_at(&f).await,
            browse_want,
            "{tz} browse after run_sql"
        );
    }
}

#[tokio::test]
async fn invalid_time_zone_is_a_typed_connect_error() {
    let f = fixture().await;
    let mut profile = f.engine.profiles.get(f.conn).unwrap();
    profile.time_zone = Some("Nope/Zone".into());
    let want = AppError::Connect {
        message: "invalid value for parameter \"TimeZone\": \"Nope/Zone\"".into(),
    };
    assert_eq!(
        f.engine.test_connection(&profile, None).await.unwrap_err(),
        want
    );
    f.engine.profiles.upsert(profile.clone()).unwrap();
    assert_eq!(f.engine.connect(profile.id).await.unwrap_err(), want);
}

#[tokio::test]
async fn list_referencing_reports_keys_pointing_at_a_table() {
    let f = fixture().await;
    let keys = |schema: &'static str, table: &'static str| {
        let engine = f.engine.clone();
        let conn = f.conn;
        async move { engine.list_referencing(conn, schema, table).await.unwrap() }
    };
    let customers = keys("public", "customers").await;
    assert_eq!(customers.len(), 1, "{customers:?}");
    assert_eq!(
        (
            customers[0].schema.as_str(),
            customers[0].table.as_str(),
            customers[0].columns.clone(),
            customers[0].referenced_columns.clone()
        ),
        (
            "public",
            "orders",
            vec!["customer_id".to_owned()],
            vec!["id".to_owned()]
        )
    );
    assert_eq!(customers[0].constraint_name, "orders_customer_id_fkey");

    let composite = keys("public", "composite_pk").await;
    assert_eq!(composite.len(), 1, "{composite:?}");
    assert_eq!(composite[0].table, "fk_links");
    assert_eq!(composite[0].columns, ["tenant", "item"]);
    assert_eq!(composite[0].referenced_columns, ["tenant", "item"]);

    let weird = keys("Sales Data", "Weird \"Name\" Table").await;
    assert_eq!(weird.len(), 1, "{weird:?}");
    assert_eq!(
        (weird[0].schema.as_str(), weird[0].table.as_str()),
        ("public", "fk_links")
    );
    assert_eq!(weird[0].columns, ["weird_id"]);
    assert_eq!(weird[0].referenced_columns, ["Id"]);

    assert!(keys("public", "no_pk").await.is_empty());
    assert!(matches!(
        f.engine
            .list_referencing(f.conn, "public", "nope")
            .await
            .unwrap_err(),
        AppError::Invalid { .. }
    ));
}

#[tokio::test]
async fn search_matches_text_columns_with_literal_wildcards() {
    let f = fixture().await;
    let search = |term: &str| {
        let mut req = page_req(f.conn, "public", "all_types");
        req.search = Some(term.into());
        req
    };
    // A quote in the term is a literal, not SQL.
    let page = f.engine.fetch_page("s1", &search("o'brien")).await.unwrap();
    assert_eq!(page.rows.len(), 1, "{}", page.sql);
    let text = page
        .columns
        .iter()
        .position(|c| c.name == "c_text")
        .unwrap();
    assert!(
        page.rows[0][text]
            .as_deref()
            .unwrap()
            .starts_with("O'Brien")
    );
    assert!(page.sql.contains("ESCAPE"), "{}", page.sql);
    assert_eq!(page.est_rows, None);

    // `%` and `_` match only themselves: the fixture has no such characters in these columns.
    let literal = |ch: &str| {
        format!(
            "SELECT count(*)::text FROM all_types WHERE strpos(concat_ws(chr(1), c_text, c_varchar, \
             c_uuid::text, c_jsonb::text, c_enum::text), '{ch}') > 0"
        )
    };
    for ch in ["%", "_"] {
        let want: usize = psql_values(&f, &literal(ch)).await[0][0]
            .as_deref()
            .unwrap()
            .parse()
            .unwrap();
        let rows = fetch_all(&f, search(ch)).await;
        assert_eq!(rows.len(), want, "search {ch:?}");
    }
    // Unescaped, '%' would match every row with any non-NULL text column.
    let all = fetch_all(&f, page_req(f.conn, "public", "all_types"))
        .await
        .len();
    assert!(fetch_all(&f, search("%")).await.len() < all);

    // Numeric terms also look in numeric columns; count and export honour the search.
    let rows = fetch_all(&f, search("42")).await;
    let int = page.columns.iter().position(|c| c.name == "c_int").unwrap();
    assert!(rows.iter().any(|r| r[int].as_deref() == Some("42")));
    let n = f
        .engine
        .count_exact("s2", f.conn, "public", "all_types", &[], Some("42"), None)
        .await
        .unwrap();
    assert_eq!(n as usize, rows.len());

    let dir = TempDir::new().unwrap();
    let path = dir.path().join("search.csv");
    let source = ExportSource::Table {
        conn_id: f.conn,
        schema: "public".into(),
        table: "orders".into(),
        filters: vec![],
        raw_where: None,
        search: Some("note 12345".into()),
        sort: vec![],
    };
    let exported = f
        .engine
        .export_rows("s3", &source, ExportFormat::Csv, &path)
        .await
        .unwrap();
    let want = f
        .engine
        .count_exact(
            "s4",
            f.conn,
            "public",
            "orders",
            &[],
            Some("note 12345"),
            None,
        )
        .await
        .unwrap();
    assert_eq!(exported as i64, want);
    assert!(want >= 1);
}

// v0.3.0 tools: server activity and signals.

/// Waits until `run` (a pg_sleep tagged with `tag`) shows up as active; returns its pid.
async fn sleeping_pid(f: &Fixture, tag: &str) -> i32 {
    for _ in 0..100 {
        let list = f.engine.list_activity(f.conn, false).await.unwrap();
        if let Some(a) = list.iter().find(|a| a.query.contains(tag)) {
            return a.pid;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("no active session running {tag}");
}

#[tokio::test]
async fn activity_lists_other_sessions_and_cancel_stops_them() {
    // The sleeper runs on its own engine (another connection, like another client).
    let sleeper = fixture().await;
    let f = fixture().await;
    let (engine, conn) = (sleeper.engine.clone(), sleeper.conn);
    let task = tokio::spawn(async move {
        engine
            .run_sql(
                "act-sleep",
                conn,
                "SELECT pg_sleep(30) /* slonview-activity-test */",
                1,
            )
            .await
    });
    let pid = sleeping_pid(&f, "slonview-activity-test").await;

    let list = f.engine.list_activity(f.conn, false).await.unwrap();
    let me = &list[0];
    assert!(me.is_self, "own session listed first");
    assert!(!me.can_signal, "own session can't be signalled");
    let row = list.iter().find(|a| a.pid == pid).unwrap();
    assert_eq!(row.state.as_deref(), Some("active"));
    assert_eq!(row.application_name, "slonview");
    assert!(row.can_signal, "same role may cancel its own backends");
    assert!(row.query_age_ms.unwrap() >= 0.0);
    assert!(row.xact_age_ms.is_some());
    assert!(!row.is_self);
    assert!(
        list.iter()
            .all(|a| a.state.as_deref() != Some("idle") || a.is_self)
    );
    let with_idle = f.engine.list_activity(f.conn, true).await.unwrap();
    assert!(with_idle.len() >= list.len());

    // Read-only connection: cancel (a signal, not a write) is allowed.
    assert!(f.engine.signal_backend(f.conn, pid, false).await.unwrap());
    let err = tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .expect("cancel_backend stops the sleep")
        .unwrap()
        .unwrap_err();
    // Cancelled from another session, so the sleeper's own engine sees it as a timeout-style 57014.
    assert_eq!(err, AppError::Timeout);
    // No such backend any more: Postgres answers false (with a warning), not an error.
    assert!(
        !f.engine
            .signal_backend(f.conn, i32::MAX, false)
            .await
            .unwrap()
    );
}

#[tokio::test]
async fn terminate_refused_on_read_only_and_allowed_with_writes() {
    let sleeper = fixture().await;
    let ro = fixture().await;
    let rw = fixture_with(|p| p.read_only = false).await;
    let (engine, conn) = (sleeper.engine.clone(), sleeper.conn);
    let task = tokio::spawn(async move {
        engine
            .run_sql(
                "term-sleep",
                conn,
                "SELECT pg_sleep(30) /* slonview-terminate-test */",
                1,
            )
            .await
    });
    let pid = sleeping_pid(&ro, "slonview-terminate-test").await;
    match ro.engine.signal_backend(ro.conn, pid, true).await {
        Err(AppError::Invalid { message, .. }) => {
            assert!(message.contains("Allow writes"), "{message}")
        }
        other => panic!("terminate on read-only must be refused: {other:?}"),
    }
    // Still running: nothing was sent.
    assert!(
        ro.engine
            .list_activity(ro.conn, false)
            .await
            .unwrap()
            .iter()
            .any(|a| a.pid == pid)
    );
    assert!(rw.engine.signal_backend(rw.conn, pid, true).await.unwrap());
    assert!(
        tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .unwrap()
            .unwrap()
            .is_err()
    );
}

// v0.3.0 tools: JSON export.

#[tokio::test]
async fn export_json_all_types_parses_with_typed_values() {
    let f = fixture().await;
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("all_types.json");
    let source = ExportSource::Table {
        conn_id: f.conn,
        schema: "public".into(),
        table: "all_types".into(),
        filters: vec![],
        raw_where: None,
        search: None,
        sort: vec![Sort {
            column: "id".into(),
            desc: false,
        }],
    };
    let n = f
        .engine
        .export_rows("json-types", &source, ExportFormat::Json, &path)
        .await
        .unwrap();
    assert_eq!(n, 5);
    let text = std::fs::read_to_string(&path).unwrap();
    let v: serde_json::Value = serde_json::from_str(&text).unwrap();
    let rows = v.as_array().unwrap();
    assert_eq!(rows.len(), 5);
    // One object per line, keys in column order (serde_json's Map sorts, so check the text).
    let first = text.lines().nth(1).unwrap();
    let mut at = 0;
    for key in [
        "id",
        "c_int",
        "c_numeric",
        "c_text",
        "c_varchar",
        "c_bool",
        "c_uuid",
        "c_date",
        "c_ts",
        "c_interval",
        "c_jsonb",
        "c_int_arr",
        "c_text_arr",
        "c_bytea",
        "c_enum",
        "c_inet",
    ] {
        let pos = first[at..]
            .find(&format!("\"{key}\":"))
            .unwrap_or_else(|| panic!("{key} out of order in {first}"));
        at += pos + 1;
    }
    assert_eq!(rows[0].as_object().unwrap().len(), 16);
    let r0 = &rows[0];
    assert_eq!(r0["id"], 1);
    assert_eq!(r0["c_int"], 1);
    // Numeric digits are written verbatim as a JSON number.
    assert!(r0["c_numeric"].is_number());
    assert!(first.contains("\"c_numeric\":3.14159,"), "{first}");
    assert_eq!(r0["c_bool"], true);
    assert_eq!(r0["c_text"], "hello");
    assert_eq!(r0["c_jsonb"]["nested"]["b"], serde_json::json!([1, 2, 3]));
    assert_eq!(r0["c_int_arr"], "{1,2,3}");
    assert_eq!(r0["c_bytea"], "\\xdeadbeef");
    // Row 2: every column NULL except id.
    assert!(
        rows[1]
            .as_object()
            .unwrap()
            .iter()
            .all(|(k, v)| k == "id" || v.is_null())
    );
    // Row 3: text 'NULL' is a string; bool false; minimum int.
    assert_eq!(rows[2]["c_text"], "NULL");
    assert_eq!(rows[2]["c_bool"], false);
    assert_eq!(rows[2]["c_int"], -2147483648i64);
    assert_eq!(rows[2]["c_jsonb"], serde_json::json!([]));
    // Row 4: embedded tab/newline, emoji and quotes inside jsonb, 1e20 numeric.
    assert_eq!(rows[3]["c_varchar"], "tab\tand newline\nhere");
    assert_eq!(rows[3]["c_jsonb"]["emoji"], "🐘");
    assert_eq!(rows[3]["c_jsonb"]["quote"], "it's \"quoted\"");
    assert_eq!(rows[3]["c_numeric"].as_f64(), Some(1e20));
    assert_eq!(rows[3]["c_ts"], "infinity");
    // Row 5: injection-shaped text and unicode stay exact; jsonb scalar string.
    assert_eq!(rows[4]["c_text"], "O'Brien; DROP TABLE orders; --");
    assert_eq!(rows[4]["c_varchar"], "unicode ñ 日本");
    assert_eq!(rows[4]["c_jsonb"], "just a string");

    // Values that don't fit f64 stay strings; floats keep NaN/Infinity as strings.
    let path2 = dir.path().join("numbers.json");
    let src = ExportSource::Sql {
        conn_id: f.conn,
        sql: "SELECT 12345678901234567890.123::numeric AS big, 9223372036854775807::int8 AS i8, \
              'NaN'::float8 AS nan, '-Infinity'::float4 AS ninf, 1.5::float8 AS f, NULL::int AS n"
            .into(),
    };
    assert_eq!(
        f.engine
            .export_rows("json-num", &src, ExportFormat::Json, &path2)
            .await
            .unwrap(),
        1
    );
    let v: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path2).unwrap()).unwrap();
    assert_eq!(
        v,
        serde_json::json!([{ "big": "12345678901234567890.123", "i8": "9223372036854775807",
                             "nan": "NaN", "ninf": "-Infinity", "f": 1.5, "n": null }])
    );

    // Empty result: an empty array.
    let src = ExportSource::Sql {
        conn_id: f.conn,
        sql: "SELECT 1 AS a WHERE false".into(),
    };
    assert_eq!(
        f.engine
            .export_rows("json-empty", &src, ExportFormat::Json, &path2)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&std::fs::read_to_string(&path2).unwrap())
            .unwrap(),
        serde_json::json!([])
    );

    // Same statement rules as CSV: several statements and writes on read-only are refused.
    for sql in [
        "SELECT 1; SELECT 2",
        "DELETE FROM scratch_insert_target RETURNING *",
    ] {
        let src = ExportSource::Sql {
            conn_id: f.conn,
            sql: sql.into(),
        };
        assert!(
            f.engine
                .export_rows("json-bad", &src, ExportFormat::Json, &path2)
                .await
                .is_err()
        );
    }
}

#[tokio::test]
async fn export_json_orders_streams_a_million_rows() {
    let f = fixture().await;
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("orders.json");
    let source = ExportSource::Table {
        conn_id: f.conn,
        schema: "public".into(),
        table: "orders".into(),
        filters: vec![],
        raw_where: None,
        search: None,
        sort: vec![],
    };
    let n = f
        .engine
        .export_rows("json-orders", &source, ExportFormat::Json, &path)
        .await
        .unwrap();
    assert_eq!(n, 1_000_000);
    let v: serde_json::Value =
        serde_json::from_reader(std::io::BufReader::new(std::fs::File::open(&path).unwrap()))
            .unwrap();
    let rows = v.as_array().unwrap();
    assert_eq!(rows.len(), 1_000_000);
    assert_eq!(rows[0]["id"], 1);
    assert_eq!(rows[0]["customer_id"], 2);
    assert!(rows[0]["amount"].is_number());
    assert_eq!(rows[999_999]["id"], 1_000_000);
}

#[tokio::test]
async fn cancel_json_export_removes_the_file() {
    let f = fixture().await;
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("slow.json");
    let engine = f.engine.clone();
    let p = path.clone();
    let src = ExportSource::Sql {
        conn_id: f.conn,
        sql: "SELECT g, pg_sleep(0.01) FROM generate_series(1, 3000) g".into(),
    };
    let task = tokio::spawn(async move {
        engine
            .export_rows("exp-json", &src, ExportFormat::Json, &p)
            .await
    });
    tokio::time::sleep(Duration::from_millis(500)).await;
    f.engine.cancel_query("exp-json").await.unwrap();
    assert_eq!(task.await.unwrap().unwrap_err(), AppError::Cancelled);
    assert!(!path.exists());
}
