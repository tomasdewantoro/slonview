//! Catalog queries. All use the extended protocol with schema/table names bound as
//! parameters, so no identifier quoting is involved.
use tokio_postgres::Client;
use tokio_postgres::types::Oid;

use crate::model::{
    Column, ColumnDetail, ForeignKeyInfo, IndexInfo, Relation, RelationKind, SchemaNode, TableDescription,
};
use crate::{AppError, AppResult};

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

fn db_err(e: tokio_postgres::Error) -> AppError {
    crate::conn::map_query_error(e, false)
}

pub(crate) async fn schema_tree(client: &Client) -> AppResult<Vec<SchemaNode>> {
    let sql = format!(
        "SELECT n.nspname::text, c.relname::text, c.relkind::text, {STATS_COLUMNS}
         FROM pg_namespace n
         LEFT JOIN pg_class c ON c.relnamespace = n.oid
              AND c.relkind IN ('r', 'v', 'm', 'p', 'f') AND NOT c.relispartition
         WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
           AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp%'
         ORDER BY n.nspname <> 'public', n.nspname, c.relname"
    );
    let rows = client.query(&sql, &[]).await.map_err(db_err)?;
    let mut out: Vec<SchemaNode> = Vec::new();
    for row in rows {
        let schema: String = row.get(0);
        if out.last().is_none_or(|n| n.name != schema) {
            out.push(SchemaNode { name: schema.clone(), relations: Vec::new() });
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
