//! Sequences, types, triggers and extensions: the sidebar's extra object groups (loaded by
//! `introspect::schema_tree` in its single pipelined round trip) and their definitions.
//! Oids are bound as parameters; identifiers and literals are quoted server-side
//! (`format('%I')`, `quote_literal`), so no client-side quoting is involved.
use std::fmt::Write as _;

use tokio_postgres::types::Oid;
use tokio_postgres::{Client, Row};

use crate::introspect::db_err;
use crate::model::{
    ConnId, ExtensionInfo, ObjectKind, SequenceInfo, TriggerEvent, TriggerInfo, TriggerTiming,
    TypeInfo, TypeKind,
};
use crate::{AppError, AppResult};

/// Sequences in shown schemas. `last_value` is read only where the session may (the same
/// privilege test `pg_sequences` uses), so an unreadable sequence never fails the whole tree.
pub(crate) fn sequences_sql(schema_filter: &str) -> String {
    format!(
        "SELECT c.oid, n.nspname::text, c.relname::text, format_type(s.seqtypid, NULL),
                has_sequence_privilege(c.oid, 'SELECT,USAGE'),
                CASE WHEN has_sequence_privilege(c.oid, 'SELECT,USAGE') THEN pg_sequence_last_value(c.oid)::text END
         FROM pg_sequence s
         JOIN pg_class c ON c.oid = s.seqrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE {schema_filter}
         ORDER BY c.relname"
    )
}

/// Enums, domains and standalone composite types (`CREATE TYPE … AS (…)`), not table row types.
pub(crate) fn types_sql(schema_filter: &str) -> String {
    format!(
        "SELECT t.oid, n.nspname::text, t.typname::text, t.typtype::text, coalesce(CASE t.typtype
           WHEN 'e' THEN (SELECT string_agg(e.enumlabel::text, ', ' ORDER BY e.enumsortorder)
                          FROM pg_enum e WHERE e.enumtypid = t.oid)
           WHEN 'd' THEN concat_ws(' ', format_type(t.typbasetype, t.typtypmod),
                          CASE WHEN t.typnotnull THEN 'NOT NULL' END,
                          (SELECT string_agg(pg_get_constraintdef(k.oid, true), ' ' ORDER BY k.conname)
                           FROM pg_constraint k WHERE k.contypid = t.oid AND k.contype = 'c'))
           ELSE (SELECT string_agg(format('%I %s', a.attname, format_type(a.atttypid, a.atttypmod)), ', ' ORDER BY a.attnum)
                 FROM pg_attribute a WHERE a.attrelid = t.typrelid AND a.attnum > 0 AND NOT a.attisdropped)
         END, '')
         FROM pg_type t
         JOIN pg_namespace n ON n.oid = t.typnamespace
         LEFT JOIN pg_class c ON c.oid = t.typrelid
         WHERE {schema_filter} AND (t.typtype IN ('e', 'd') OR (t.typtype = 'c' AND c.relkind = 'c'))
         ORDER BY t.typname"
    )
}

/// User triggers (no internal FK/constraint triggers) on tables and views in shown schemas.
/// Partitions are hidden in the tree, and so are the trigger clones on them.
pub(crate) fn triggers_sql(schema_filter: &str) -> String {
    format!(
        "SELECT t.oid, n.nspname::text, c.relname::text, t.tgname::text, t.tgtype::int4, t.tgenabled::text,
                format('%I.%I', pn.nspname, p.proname)
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_proc p ON p.oid = t.tgfoid
         JOIN pg_namespace pn ON pn.oid = p.pronamespace
         WHERE {schema_filter} AND NOT t.tgisinternal AND NOT c.relispartition
         ORDER BY c.relname, t.tgname"
    )
}

pub(crate) const EXTENSIONS_SQL: &str =
    "SELECT e.oid, e.extname::text, e.extversion, n.nspname::text
     FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
     ORDER BY e.extname";

/// Column 1 of every tree query is the schema name.
pub(crate) fn row_schema(row: &Row) -> String {
    row.get(1)
}

pub(crate) fn sequence(row: Row) -> AppResult<SequenceInfo> {
    Ok(SequenceInfo {
        oid: row.get::<_, Oid>(0),
        schema: row.get(1),
        name: row.get(2),
        data_type: row.get(3),
        readable: row.get(4),
        last_value: row.get(5),
    })
}

pub(crate) fn type_info(row: Row) -> AppResult<TypeInfo> {
    let typtype: String = row.get(3);
    let kind = match typtype.as_str() {
        "e" => TypeKind::Enum,
        "d" => TypeKind::Domain,
        "c" => TypeKind::Composite,
        other => return Err(AppError::internal(format!("unexpected typtype {other:?}"))),
    };
    Ok(TypeInfo {
        oid: row.get::<_, Oid>(0),
        schema: row.get(1),
        name: row.get(2),
        kind,
        detail: row.get(4),
    })
}

// pg_trigger.tgtype bits (src/include/catalog/pg_trigger.h).
const TRIGGER_TYPE_ROW: i32 = 1 << 0;
const TRIGGER_TYPE_BEFORE: i32 = 1 << 1;
const TRIGGER_TYPE_INSERT: i32 = 1 << 2;
const TRIGGER_TYPE_DELETE: i32 = 1 << 3;
const TRIGGER_TYPE_UPDATE: i32 = 1 << 4;
const TRIGGER_TYPE_TRUNCATE: i32 = 1 << 5;
const TRIGGER_TYPE_INSTEAD: i32 = 1 << 6;

pub(crate) fn trigger(row: Row) -> AppResult<TriggerInfo> {
    let tgtype: i32 = row.get(4);
    let timing = if tgtype & TRIGGER_TYPE_INSTEAD != 0 {
        TriggerTiming::InsteadOf
    } else if tgtype & TRIGGER_TYPE_BEFORE != 0 {
        TriggerTiming::Before
    } else {
        TriggerTiming::After
    };
    let events = [
        (TRIGGER_TYPE_INSERT, TriggerEvent::Insert),
        (TRIGGER_TYPE_UPDATE, TriggerEvent::Update),
        (TRIGGER_TYPE_DELETE, TriggerEvent::Delete),
        (TRIGGER_TYPE_TRUNCATE, TriggerEvent::Truncate),
    ]
    .into_iter()
    .filter(|(bit, _)| tgtype & bit != 0)
    .map(|(_, e)| e)
    .collect();
    Ok(TriggerInfo {
        oid: row.get::<_, Oid>(0),
        schema: row.get(1),
        table: row.get(2),
        name: row.get(3),
        timing,
        events,
        for_each_row: tgtype & TRIGGER_TYPE_ROW != 0,
        enabled: row.get::<_, String>(5) != "D",
        function: row.get(6),
    })
}

pub(crate) fn extension(row: Row) -> AppResult<ExtensionInfo> {
    Ok(ExtensionInfo {
        oid: row.get::<_, Oid>(0),
        name: row.get(1),
        version: row.get(2),
        schema: row.get(3),
    })
}

fn not_found(what: &str, oid: Oid) -> AppError {
    AppError::invalid(format!(
        "{what} with oid {oid} not found (it may have been dropped)"
    ))
}

/// Definition comment plus a runnable `SELECT * FROM <seq>;`.
async fn sequence_definition(client: &Client, oid: Oid) -> AppResult<String> {
    let row = client
        .query_opt(
            "SELECT format('%I.%I', n.nspname, c.relname), format_type(s.seqtypid, NULL), s.seqincrement, s.seqmin,
                    s.seqmax, s.seqstart, s.seqcache, s.seqcycle, c.relpersistence::text,
                    (SELECT format('%I.%I.%I', dn.nspname, dc.relname, a.attname) || CASE d.deptype WHEN 'i' THEN ' (identity column)' ELSE '' END
                     FROM pg_depend d
                     JOIN pg_class dc ON dc.oid = d.refobjid
                     JOIN pg_namespace dn ON dn.oid = dc.relnamespace
                     JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
                     WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid
                       AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')
                     LIMIT 1)
             FROM pg_sequence s
             JOIN pg_class c ON c.oid = s.seqrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE c.oid = $1",
            &[&oid],
        )
        .await
        .map_err(db_err)?
        .ok_or_else(|| not_found("sequence", oid))?;
    let name: String = row.get(0);
    let unlogged = if row.get::<_, String>(8) == "u" {
        "UNLOGGED "
    } else {
        ""
    };
    let cycle = if row.get::<_, bool>(7) {
        "CYCLE"
    } else {
        "NO CYCLE"
    };
    let mut out = String::new();
    let _ = writeln!(out, "-- Sequence {name}");
    let _ = writeln!(
        out,
        "--   CREATE {unlogged}SEQUENCE {name} AS {}",
        row.get::<_, String>(1)
    );
    let _ = writeln!(
        out,
        "--     INCREMENT BY {} MINVALUE {} MAXVALUE {} START WITH {} CACHE {} {cycle};",
        row.get::<_, i64>(2),
        row.get::<_, i64>(3),
        row.get::<_, i64>(4),
        row.get::<_, i64>(5),
        row.get::<_, i64>(6),
    );
    if let Some(owner) = row.get::<_, Option<String>>(9) {
        let _ = writeln!(out, "--   Owned by {owner}");
    }
    let _ = writeln!(out, "SELECT * FROM {name};");
    Ok(out)
}

/// `CREATE TYPE … AS ENUM`, `CREATE DOMAIN …` or `CREATE TYPE … AS (…)`, plus its comment.
async fn type_definition(client: &Client, oid: Oid) -> AppResult<String> {
    // Collation clauses are emitted only where they differ from the underlying type's default.
    let row = client
        .query_opt(
            "SELECT t.typtype::text, format('%I.%I', n.nspname, t.typname),
                    (SELECT string_agg(quote_literal(e.enumlabel), ', ' ORDER BY e.enumsortorder)
                     FROM pg_enum e WHERE e.enumtypid = t.oid),
                    format_type(t.typbasetype, t.typtypmod),
                    (SELECT format('%I.%I', cn.nspname, co.collname)
                     FROM pg_collation co JOIN pg_namespace cn ON cn.oid = co.collnamespace
                     WHERE co.oid = t.typcollation AND t.typcollation <> bt.typcollation),
                    t.typdefault, t.typnotnull,
                    (SELECT string_agg(format('CONSTRAINT %I %s', k.conname, pg_get_constraintdef(k.oid, true)), E'\\n' ORDER BY k.conname)
                     FROM pg_constraint k WHERE k.contypid = t.oid AND k.contype = 'c'),
                    (SELECT string_agg(format('%I %s', a.attname, format_type(a.atttypid, a.atttypmod))
                                       || coalesce(' COLLATE ' || (
                                            SELECT format('%I.%I', cn.nspname, co.collname)
                                            FROM pg_collation co JOIN pg_namespace cn ON cn.oid = co.collnamespace
                                            JOIN pg_type at ON at.oid = a.atttypid
                                            WHERE co.oid = a.attcollation AND a.attcollation <> at.typcollation), ''),
                                       E',\\n' ORDER BY a.attnum)
                     FROM pg_attribute a WHERE a.attrelid = t.typrelid AND a.attnum > 0 AND NOT a.attisdropped),
                    quote_literal(obj_description(t.oid, 'pg_type'))
             FROM pg_type t
             JOIN pg_namespace n ON n.oid = t.typnamespace
             LEFT JOIN pg_type bt ON bt.oid = t.typbasetype
             WHERE t.oid = $1",
            &[&oid],
        )
        .await
        .map_err(db_err)?
        .ok_or_else(|| not_found("type", oid))?;
    let typtype: String = row.get(0);
    let name: String = row.get(1);
    let indent = |s: &str, by: &str| {
        s.lines()
            .map(|l| format!("{by}{l}"))
            .collect::<Vec<_>>()
            .join("\n")
    };
    let mut out = String::new();
    let object = match typtype.as_str() {
        "e" => {
            let labels = row.get::<_, Option<String>>(2).unwrap_or_default();
            let _ = writeln!(out, "CREATE TYPE {name} AS ENUM ({labels});");
            "TYPE"
        }
        "d" => {
            let _ = write!(out, "CREATE DOMAIN {name} AS {}", row.get::<_, String>(3));
            if let Some(collation) = row.get::<_, Option<String>>(4) {
                let _ = write!(out, "\n  COLLATE {collation}");
            }
            if let Some(default) = row.get::<_, Option<String>>(5) {
                let _ = write!(out, "\n  DEFAULT {default}");
            }
            if row.get::<_, bool>(6) {
                out.push_str("\n  NOT NULL");
            }
            if let Some(checks) = row.get::<_, Option<String>>(7) {
                let _ = write!(out, "\n{}", indent(&checks, "  "));
            }
            out.push_str(";\n");
            "DOMAIN"
        }
        "c" => {
            let attrs = row.get::<_, Option<String>>(8).unwrap_or_default();
            let _ = writeln!(
                out,
                "CREATE TYPE {name} AS (\n{}\n);",
                indent(&attrs, "    ")
            );
            "TYPE"
        }
        other => {
            return Err(AppError::invalid(format!(
                "type {name} is not an enum, domain or composite type ({other:?})"
            )));
        }
    };
    if let Some(comment) = row.get::<_, Option<String>>(9) {
        let _ = writeln!(out, "\nCOMMENT ON {object} {name} IS {comment};");
    }
    Ok(out)
}

/// `pg_get_triggerdef`, plus the `ALTER TABLE` that reproduces a non-default enabled state.
/// Non-pretty mode, because pretty mode drops the table's schema when it is on the search path.
async fn trigger_definition(client: &Client, oid: Oid) -> AppResult<String> {
    let row = client
        .query_opt(
            "SELECT pg_get_triggerdef(t.oid), t.tgenabled::text, format('%I.%I', n.nspname, c.relname),
                    quote_ident(t.tgname), format('%I.%I()', pn.nspname, p.proname)
             FROM pg_trigger t
             JOIN pg_class c ON c.oid = t.tgrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
             JOIN pg_proc p ON p.oid = t.tgfoid
             JOIN pg_namespace pn ON pn.oid = p.pronamespace
             WHERE t.oid = $1",
            &[&oid],
        )
        .await
        .map_err(db_err)?
        .ok_or_else(|| not_found("trigger", oid))?;
    let table: String = row.get(2);
    let trigger: String = row.get(3);
    let mut out = format!("{};\n", row.get::<_, String>(0));
    let state = match row.get::<_, String>(1).as_str() {
        "D" => Some("DISABLE"),
        "R" => Some("ENABLE REPLICA"),
        "A" => Some("ENABLE ALWAYS"),
        _ => None,
    };
    if let Some(state) = state {
        let _ = writeln!(out, "ALTER TABLE {table} {state} TRIGGER {trigger};");
    }
    let _ = writeln!(out, "\n-- Trigger function: {}", row.get::<_, String>(4));
    Ok(out)
}

/// `CREATE EXTENSION … WITH SCHEMA … VERSION …;` headed by the extension's description.
async fn extension_definition(client: &Client, oid: Oid) -> AppResult<String> {
    let row = client
        .query_opt(
            "SELECT format('CREATE EXTENSION %I WITH SCHEMA %I VERSION %L;', e.extname, n.nspname, e.extversion),
                    obj_description(e.oid, 'pg_extension')
             FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
             WHERE e.oid = $1",
            &[&oid],
        )
        .await
        .map_err(db_err)?
        .ok_or_else(|| not_found("extension", oid))?;
    let mut out = String::new();
    if let Some(description) = row.get::<_, Option<String>>(1) {
        for line in description.lines() {
            let _ = writeln!(out, "-- {line}");
        }
    }
    let _ = writeln!(out, "{}", row.get::<_, String>(0));
    Ok(out)
}

impl crate::engine::Engine {
    /// SQL text for a sidebar object; `oid` comes from the matching `SchemaTree` entry.
    /// Unknown oid = Invalid.
    pub async fn get_object_definition(
        &self,
        conn_id: ConnId,
        kind: ObjectKind,
        oid: u32,
    ) -> AppResult<String> {
        let (_, client) = self.client(conn_id).await?;
        match kind {
            ObjectKind::Sequence => sequence_definition(&client, oid).await,
            ObjectKind::Type => type_definition(&client, oid).await,
            ObjectKind::Trigger => trigger_definition(&client, oid).await,
            ObjectKind::Extension => extension_definition(&client, oid).await,
        }
    }
}
