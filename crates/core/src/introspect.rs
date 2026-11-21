//! Catalog queries. All use the extended protocol with schema/table names bound as
//! parameters, so no identifier quoting is involved.
use std::collections::HashMap;
use std::fmt::Write as _;

use tokio_postgres::Client;
use tokio_postgres::types::Oid;

use crate::model::{
    Column, ColumnDetail, ForeignKeyInfo, FunctionInfo, FunctionKind, IndexInfo, Relation, RelationKind, SchemaNode,
    SchemaTree, TableDescription,
};
use crate::objects;
use crate::{AppError, AppResult};

/// Schemas shown in the tree (`n` = pg_namespace).
const SCHEMA_FILTER: &str = "n.nspname NOT IN ('pg_catalog', 'information_schema')
           AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp%'";

/// Estimated rows and total size; partitioned parents aggregate their leaf partitions.
const STATS_COLUMNS: &str = "
    CASE WHEN c.relkind = 'p' THEN (
        SELECT CASE WHEN bool_and(l.reltuples < 0) THEN -1 ELSE sum(greatest(l.reltuples, 0))::bigint END
        FROM pg_partition_tree(c.oid) t JOIN pg_class l ON l.oid = t.relid WHERE t.isleaf)
      ELSE c.reltuples::bigint END,
    CASE WHEN c.relkind = 'p' THEN (
        SELECT sum(pg_total_relation_size(t.relid))::bigint FROM pg_partition_tree(c.oid) t WHERE t.isleaf)
      ELSE pg_total_relation_size(c.oid) END";

fn relation_kind(relkind: &str) -> AppResult<RelationKind> {
    Ok(match relkind {
        "r" => RelationKind::Table,
        "v" => RelationKind::View,
        "m" => RelationKind::MaterializedView,
        "p" => RelationKind::PartitionedTable,
        "f" => RelationKind::ForeignTable,
        other => return Err(AppError::internal(format!("unexpected relkind {other:?}"))),
    })
}

fn function_kind(prokind: &str) -> AppResult<FunctionKind> {
    Ok(match prokind {
        "f" => FunctionKind::Function,
        "p" => FunctionKind::Procedure,
        "a" => FunctionKind::Aggregate,
        "w" => FunctionKind::Window,
        other => return Err(AppError::internal(format!("unexpected prokind {other:?}"))),
    })
}

pub(crate) fn db_err(e: tokio_postgres::Error) -> AppError {
    crate::conn::map_query_error(e, false)
}

pub(crate) async fn schema_tree(client: &Client) -> AppResult<SchemaTree> {
    let relations_sql = format!(
        "SELECT n.nspname::text, c.relname::text, c.relkind::text, {STATS_COLUMNS}
         FROM pg_namespace n
         LEFT JOIN pg_class c ON c.relnamespace = n.oid
              AND c.relkind IN ('r', 'v', 'm', 'p', 'f') AND NOT c.relispartition
         WHERE {SCHEMA_FILTER}
         ORDER BY n.nspname <> 'public', n.nspname, c.relname"
    );
    // Extension-owned functions are included on purpose (e.g. uuid-ossp's uuid_generate_*).
    let functions_sql = format!(
        "SELECT p.oid, n.nspname::text, p.proname::text, pg_get_function_identity_arguments(p.oid) AS args,
                CASE WHEN p.prokind <> 'p' THEN pg_get_function_result(p.oid) END,
                p.prokind::text, l.lanname::text
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         JOIN pg_language l ON l.oid = p.prolang
         WHERE {SCHEMA_FILTER}
         ORDER BY p.proname, args"
    );
    let (sequences_sql, types_sql, triggers_sql) = (
        objects::sequences_sql(SCHEMA_FILTER),
        objects::types_sql(SCHEMA_FILTER),
        objects::triggers_sql(SCHEMA_FILTER),
    );
    // All queries are pipelined on the one connection: a single round trip of latency.
    let (rel_rows, fn_rows, seq_rows, type_rows, trigger_rows, ext_rows) = futures_util::try_join!(
        client.query(&relations_sql, &[]),
        client.query(&functions_sql, &[]),
        client.query(&sequences_sql, &[]),
        client.query(&types_sql, &[]),
        client.query(&triggers_sql, &[]),
        client.query(objects::EXTENSIONS_SQL, &[]),
    )
    .map_err(db_err)?;
    let mut out: Vec<SchemaNode> = Vec::new();
    for row in rel_rows {
        let schema: String = row.get(0);
        if out.last().is_none_or(|n| n.name != schema) {
            out.push(SchemaNode {
                name: schema.clone(),
                relations: Vec::new(),
                functions: Vec::new(),
                sequences: Vec::new(),
                types: Vec::new(),
                triggers: Vec::new(),
            });
        }
        let Some(name) = row.get::<_, Option<String>>(1) else {
            continue; // schema without relations
        };
        let relkind: String = row.get(2);
        out.last_mut().expect("pushed above").relations.push(Relation {
            schema,
            name,
            kind: relation_kind(&relkind)?,
            est_rows: row.get::<_, Option<i64>>(3).unwrap_or(-1),
            size_bytes: row.get::<_, Option<i64>>(4).unwrap_or(0),
        });
    }
    let index: HashMap<String, usize> = out.iter().enumerate().map(|(i, n)| (n.name.clone(), i)).collect();
    for row in fn_rows {
        let schema: String = row.get(1);
        // A schema created between the two snapshots is simply skipped until the next refresh.
        let Some(&i) = index.get(&schema) else { continue };
        let prokind: String = row.get(5);
        out[i].functions.push(FunctionInfo {
            oid: row.get::<_, Oid>(0),
            schema,
            name: row.get(2),
            args: row.get(3),
            result: row.get(4),
            kind: function_kind(&prokind)?,
            language: row.get(6),
        });
    }
    // Same rule for the other groups: rows of an unknown schema are skipped.
    for row in seq_rows {
        if let Some(&i) = index.get(&objects::row_schema(&row)) {
            out[i].sequences.push(objects::sequence(row)?);
        }
    }
    for row in type_rows {
        if let Some(&i) = index.get(&objects::row_schema(&row)) {
            out[i].types.push(objects::type_info(row)?);
        }
    }
    for row in trigger_rows {
        if let Some(&i) = index.get(&objects::row_schema(&row)) {
            out[i].triggers.push(objects::trigger(row)?);
        }
    }
    let extensions = ext_rows.into_iter().map(objects::extension).collect::<AppResult<_>>()?;
    Ok(SchemaTree { schemas: out, extensions })
}

/// `CREATE OR REPLACE …` text for functions, procedures and window functions. Aggregates,
/// which `pg_get_functiondef` rejects, get an SQL comment block built from `pg_aggregate`.
pub(crate) async fn function_definition(client: &Client, oid: Oid) -> AppResult<String> {
    let row = client
        .query_opt(
            "SELECT p.prokind::text,
                    CASE WHEN p.prokind <> 'a' THEN pg_get_functiondef(p.oid) END,
                    format('%I.%I', n.nspname, p.proname), pg_get_function_identity_arguments(p.oid),
                    pg_get_function_result(p.oid), a.aggtransfn::regprocedure::text,
                    format_type(a.aggtranstype, NULL), NULLIF(a.aggfinalfn, 0)::regprocedure::text,
                    a.agginitval, a.aggkind::text, NULLIF(a.aggsortop, 0)::regoperator::text
             FROM pg_proc p
             JOIN pg_namespace n ON n.oid = p.pronamespace
             LEFT JOIN pg_aggregate a ON a.aggfnoid = p.oid
             WHERE p.oid = $1",
            &[&oid],
        )
        .await
        .map_err(db_err)?
        .ok_or_else(|| AppError::invalid(format!("function with oid {oid} not found (it may have been dropped)")))?;
    let prokind: String = row.get(0);
    if prokind != "a" {
        return row
            .get::<_, Option<String>>(1)
            .ok_or_else(|| AppError::internal(format!("pg_get_functiondef returned no text for oid {oid}")));
    }
    let name: String = row.get(2);
    let args: String = row.get(3);
    let result: Option<String> = row.get(4);
    let comment = |s: &str| s.replace('\n', "\n--     ");
    let mut out = String::new();
    let _ = writeln!(out, "-- Aggregate function {name}({args})");
    let _ = writeln!(out, "-- Returns: {}", result.as_deref().unwrap_or("unknown"));
    out.push_str("--\n-- pg_get_functiondef does not support aggregates; details from pg_aggregate:\n");
    let kind = match row.get::<_, Option<String>>(9).as_deref() {
        Some("o") => "ordered-set",
        Some("h") => "hypothetical-set",
        _ => "normal",
    };
    let _ = writeln!(out, "--   KIND      = {kind}");
    if let Some(sfunc) = row.get::<_, Option<String>>(5) {
        let _ = writeln!(out, "--   SFUNC     = {sfunc}");
    }
    if let Some(stype) = row.get::<_, Option<String>>(6) {
        let _ = writeln!(out, "--   STYPE     = {stype}");
    }
    let finalfunc = row.get::<_, Option<String>>(7);
    let _ = writeln!(out, "--   FINALFUNC = {}", finalfunc.as_deref().unwrap_or("(none)"));
    let initcond = row.get::<_, Option<String>>(8);
    let _ = writeln!(out, "--   INITCOND  = {}", initcond.map_or("(null)".to_owned(), |c| format!("'{}'", comment(&c))));
    if let Some(sortop) = row.get::<_, Option<String>>(10) {
        let _ = writeln!(out, "--   SORTOP    = {sortop}");
    }
    Ok(out)
}

/// What paging/export/cell lookups need to know about a relation.
pub(crate) struct TableMeta {
    pub kind: RelationKind,
    pub columns: Vec<ColumnDetail>,
    /// Primary-key column names in key order; empty when there is none.
    pub pk: Vec<String>,
}

impl TableMeta {
    pub fn column(&self, name: &str) -> AppResult<&ColumnDetail> {
        self.columns
            .iter()
            .find(|c| c.name == name)
            .ok_or_else(|| AppError::invalid(format!("unknown column {name:?}")))
    }

    pub fn grid_columns(&self) -> Vec<Column> {
        self.columns
            .iter()
            .map(|c| Column {
                name: c.name.clone(),
                type_name: c.type_name.clone(),
                nullable: c.nullable,
                is_pk: c.is_pk,
            })
            .collect()
    }
}

struct RelInfo {
    oid: Oid,
    kind: RelationKind,
    est_rows: i64,
    size_bytes: i64,
}

async fn resolve(client: &Client, schema: &str, table: &str) -> AppResult<RelInfo> {
    let sql = format!(
        "SELECT c.oid, c.relkind::text, {STATS_COLUMNS}
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r', 'v', 'm', 'p', 'f')"
    );
    let row = client
        .query_opt(&sql, &[&schema, &table])
        .await
        .map_err(db_err)?
        .ok_or_else(|| AppError::invalid(format!("relation {schema}.{table} not found")))?;
    let relkind: String = row.get(1);
    Ok(RelInfo {
        oid: row.get(0),
        kind: relation_kind(&relkind)?,
        est_rows: row.get::<_, Option<i64>>(2).unwrap_or(-1),
        size_bytes: row.get::<_, Option<i64>>(3).unwrap_or(0),
    })
}

/// Columns in attnum order plus the primary-key column order.
async fn columns(client: &Client, oid: Oid) -> AppResult<(Vec<ColumnDetail>, Vec<String>)> {
    let rows = client
        .query(
            "SELECT a.attname::text, format_type(a.atttypid, a.atttypmod), a.attnotnull,
                    pg_get_expr(d.adbin, d.adrelid), col_description(a.attrelid, a.attnum),
                    array_position(pk.indkey::int2[], a.attnum)
             FROM pg_attribute a
             LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
             LEFT JOIN pg_index pk ON pk.indrelid = a.attrelid AND pk.indisprimary
             WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped
             ORDER BY a.attnum",
            &[&oid],
        )
        .await
        .map_err(db_err)?;
    let mut pk: Vec<(i32, String)> = Vec::new();
    let mut cols = Vec::with_capacity(rows.len());
    for row in rows {
        let name: String = row.get(0);
        let pk_pos: Option<i32> = row.get(5);
        if let Some(pos) = pk_pos {
            pk.push((pos, name.clone()));
        }
        cols.push(ColumnDetail {
            name,
            type_name: row.get(1),
            nullable: !row.get::<_, bool>(2),
            is_pk: pk_pos.is_some(),
            default: row.get(3),
            comment: row.get(4),
        });
    }
    pk.sort_by_key(|(pos, _)| *pos);
    Ok((cols, pk.into_iter().map(|(_, n)| n).collect()))
}

pub(crate) async fn table_meta(client: &Client, schema: &str, table: &str) -> AppResult<TableMeta> {
    let rel = resolve(client, schema, table).await?;
    let (columns, pk) = columns(client, rel.oid).await?;
    Ok(TableMeta { kind: rel.kind, columns, pk })
}

pub(crate) async fn describe(client: &Client, schema: &str, table: &str) -> AppResult<TableDescription> {
    let rel = resolve(client, schema, table).await?;
    let (columns, _) = columns(client, rel.oid).await?;
    let indexes = client
        .query(
            "SELECT ci.relname::text, pg_get_indexdef(i.indexrelid), i.indisunique, i.indisprimary
             FROM pg_index i JOIN pg_class ci ON ci.oid = i.indexrelid
             WHERE i.indrelid = $1
             ORDER BY i.indisprimary DESC, ci.relname",
            &[&rel.oid],
        )
        .await
        .map_err(db_err)?
        .into_iter()
        .map(|r| IndexInfo { name: r.get(0), definition: r.get(1), is_unique: r.get(2), is_primary: r.get(3) })
        .collect();
    let foreign_keys = client
        .query(
            "SELECT conname::text, pg_get_constraintdef(oid)
             FROM pg_constraint WHERE conrelid = $1 AND contype = 'f'
             ORDER BY conname",
            &[&rel.oid],
        )
        .await
        .map_err(db_err)?
        .into_iter()
        .map(|r| ForeignKeyInfo { name: r.get(0), definition: r.get(1) })
        .collect();
    let view_definition = match rel.kind {
        RelationKind::View | RelationKind::MaterializedView => client
            .query_one("SELECT pg_get_viewdef($1::oid, true)", &[&rel.oid])
            .await
            .map_err(db_err)?
            .get(0),
        _ => None,
    };
    Ok(TableDescription {
        schema: schema.to_owned(),
        name: table.to_owned(),
        kind: rel.kind,
        columns,
        indexes,
        foreign_keys,
        est_rows: rel.est_rows,
        size_bytes: rel.size_bytes,
        view_definition,
    })
}
