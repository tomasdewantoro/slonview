//! Browse-mode SQL building: filters, sort, keyset/offset paging, counts, cell
//! lookups and table exports. Every identifier goes through `quote_ident` and every
//! value through `quote_literal`; `raw_where` is the only verbatim input.
use std::fmt::Write;

use crate::ident::{qualified, quote_ident, quote_literal};
use crate::introspect::TableMeta;
use crate::model::{CELL_TRUNCATE_CHARS, Cursor, Filter, FilterOp, PageRequest, RelationKind, Sort};
use crate::{AppError, AppResult};

/// The `WHERE ...` clause (with leading space) or an empty string.
pub(crate) fn where_clause(meta: &TableMeta, filters: &[Filter], raw_where: Option<&str>) -> AppResult<String> {
    let mut parts = filters.iter().map(|f| filter_sql(meta, f)).collect::<AppResult<Vec<_>>>()?;
    if let Some(raw) = raw_where.map(str::trim).filter(|r| !r.is_empty()) {
        parts.push(format!("({raw})"));
    }
    Ok(if parts.is_empty() { String::new() } else { format!(" WHERE {}", parts.join(" AND ")) })
}

fn filter_sql(meta: &TableMeta, f: &Filter) -> AppResult<String> {
    let col = quote_ident(&meta.column(&f.column)?.name);
    let value = || {
        f.value
            .as_deref()
            .ok_or_else(|| AppError::invalid(format!("filter on {:?} needs a value", f.column)))
    };
    let cmp = |op: &str| -> AppResult<String> { Ok(format!("{col} {op} {}", quote_literal(value()?))) };
    match f.op {
        FilterOp::Eq => cmp("="),
        FilterOp::Ne => cmp("<>"),
        FilterOp::Lt => cmp("<"),
        FilterOp::Le => cmp("<="),
        FilterOp::Gt => cmp(">"),
        FilterOp::Ge => cmp(">="),
        FilterOp::Like => Ok(format!("{col}::text LIKE {}", quote_literal(value()?))),
        FilterOp::ILike => Ok(format!("{col}::text ILIKE {}", quote_literal(value()?))),
        FilterOp::IsNull => Ok(format!("{col} IS NULL")),
        FilterOp::IsNotNull => Ok(format!("{col} IS NOT NULL")),
        FilterOp::In => {
            let items: Vec<String> = value()?
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(quote_literal)
                .collect();
            if items.is_empty() {
                return Err(AppError::invalid(format!("IN filter on {:?} needs at least one value", f.column)));
            }
            Ok(format!("{col} IN ({})", items.join(", ")))
        }
    }
}

/// `'value'::type` — compares against the column with the column's own type.
fn typed_literal(value: &str, type_name: &str) -> String {
    format!("{}::{type_name}", quote_literal(value))
}

/// How the page query is positioned.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PageMode {
    Keyset,
    Offset(u64),
}

pub(crate) struct PageQuery {
    pub sql: String,
    pub mode: PageMode,
    /// Index of each PK column in the select list (keyset mode only).
    pub pk_indexes: Vec<usize>,
}

/// Selects every column as text: PK columns in full (they feed the keyset cursor),
/// others cut to `CELL_TRUNCATE_CHARS + 1` chars so the caller can detect and flag
/// truncation without a second expression per column. Fetches `limit + 1` rows.
/// `limit` is the effective page size (the request's 0 already replaced by the default).
pub(crate) fn page_query(req: &PageRequest, meta: &TableMeta, limit: u32) -> AppResult<PageQuery> {
    let PageRequest { schema, table, filters, raw_where, sort, cursor, .. } = req;
    let (raw_where, cursor) = (raw_where.as_deref(), cursor.as_ref());
    if meta.columns.is_empty() {
        return Err(AppError::invalid(format!("{schema}.{table} has no columns")));
    }
    let select = meta
        .columns
        .iter()
        .map(|c| {
            let q = quote_ident(&c.name);
            if c.is_pk { format!("{q}::text") } else { format!("left({q}::text, {})", CELL_TRUNCATE_CHARS + 1) }
        })
        .collect::<Vec<_>>()
        .join(", ");
    let mut where_sql = where_clause(meta, filters, raw_where)?;
    let keyset = sort.is_empty() && !meta.pk.is_empty();
    let mut sql = format!("SELECT {select} FROM {}", qualified(schema, table));

    let mode = if keyset {
        if let Some(cursor) = cursor {
            let Cursor::Keyset { values } = cursor else {
                return Err(AppError::invalid("cursor does not match keyset paging"));
            };
            if values.len() != meta.pk.len() {
                return Err(AppError::invalid("cursor has the wrong number of key values"));
            }
            let mut cols = Vec::with_capacity(values.len());
            let mut lits = Vec::with_capacity(values.len());
            for (name, value) in meta.pk.iter().zip(values) {
                let value = value.as_deref().ok_or_else(|| AppError::invalid("cursor contains NULL key"))?;
                cols.push(quote_ident(name));
                lits.push(typed_literal(value, &meta.column(name)?.type_name));
            }
            let cond = format!("({}) > ({})", cols.join(", "), lits.join(", "));
            where_sql = if where_sql.is_empty() { format!(" WHERE {cond}") } else { format!("{where_sql} AND {cond}") };
        }
        PageMode::Keyset
    } else {
        match cursor {
            None => PageMode::Offset(0),
            Some(Cursor::Offset { offset }) => PageMode::Offset(*offset),
            Some(Cursor::Keyset { .. }) => return Err(AppError::invalid("cursor does not match offset paging")),
        }
    };
    sql.push_str(&where_sql);
    sql.push_str(&order_by(&qualified(schema, table), meta, sort)?);
    let _ = write!(sql, " LIMIT {}", u64::from(limit) + 1);
    if let PageMode::Offset(offset) = mode
        && offset > 0
    {
        let _ = write!(sql, " OFFSET {offset}");
    }
    let pk_indexes = if keyset {
        meta.pk
            .iter()
            .map(|n| meta.columns.iter().position(|c| &c.name == n).expect("pk column is a column"))
            .collect()
    } else {
        Vec::new()
    };
    Ok(PageQuery { sql, mode, pk_indexes })
}

/// User sort first, then a deterministic tie-breaker so OFFSET paging is stable:
/// the primary key, else the physical row id for tables, else every column as text.
/// Keys are qualified with the relation name so they bind to the table's columns,
/// not to the same-named `::text` output columns of the select list.
fn order_by(rel: &str, meta: &TableMeta, sort: &[Sort]) -> AppResult<String> {
    let col = |name: &str| format!("{rel}.{}", quote_ident(name));
    let mut keys = Vec::new();
    for s in sort {
        let c = col(&meta.column(&s.column)?.name);
        keys.push(if s.desc { format!("{c} DESC") } else { c });
    }
    if !meta.pk.is_empty() {
        for pk in &meta.pk {
            if !sort.iter().any(|s| &s.column == pk) {
                keys.push(col(pk));
            }
        }
    } else {
        match meta.kind {
            RelationKind::Table | RelationKind::MaterializedView => keys.push(format!("{rel}.ctid")),
            RelationKind::PartitionedTable => {
                keys.push(format!("{rel}.tableoid"));
                keys.push(format!("{rel}.ctid"));
            }
            RelationKind::View | RelationKind::ForeignTable => {
                keys.extend(meta.columns.iter().map(|c| format!("{}::text", col(&c.name))));
            }
        }
    }
    Ok(format!(" ORDER BY {}", keys.join(", ")))
}

pub(crate) fn count_query(
    schema: &str,
    table: &str,
    meta: &TableMeta,
    filters: &[Filter],
    raw_where: Option<&str>,
) -> AppResult<String> {
    Ok(format!("SELECT count(*) FROM {}{}", qualified(schema, table), where_clause(meta, filters, raw_where)?))
}

/// Full-value export of a table: all columns, same filters, user sort (or PK order).
pub(crate) fn export_query(
    schema: &str,
    table: &str,
    meta: &TableMeta,
    filters: &[Filter],
    raw_where: Option<&str>,
    sort: &[Sort],
) -> AppResult<String> {
    let mut sql = format!("SELECT * FROM {}{}", qualified(schema, table), where_clause(meta, filters, raw_where)?);
    let mut keys = Vec::new();
    for s in sort {
        let col = quote_ident(&meta.column(&s.column)?.name);
        keys.push(if s.desc { format!("{col} DESC") } else { col });
    }
    if keys.is_empty() {
        keys.extend(meta.pk.iter().map(|p| quote_ident(p)));
    }
    if !keys.is_empty() {
        let _ = write!(sql, " ORDER BY {}", keys.join(", "));
    }
    Ok(sql)
}

pub(crate) fn cell_query(
    schema: &str,
    table: &str,
    meta: &TableMeta,
    pk_columns: &[String],
    pk_values: &[Option<String>],
    column: &str,
) -> AppResult<String> {
    if pk_columns.is_empty() || pk_columns.len() != pk_values.len() {
        return Err(AppError::invalid("get_cell needs one value per primary-key column"));
    }
    let target = quote_ident(&meta.column(column)?.name);
    let mut conds = Vec::with_capacity(pk_columns.len());
    for (name, value) in pk_columns.iter().zip(pk_values) {
        let col = meta.column(name)?;
        let value = value.as_deref().ok_or_else(|| AppError::invalid("primary-key value is NULL"))?;
        conds.push(format!("{} = {}", quote_ident(&col.name), typed_literal(value, &col.type_name)));
    }
    Ok(format!(
        "SELECT {target}::text FROM {} WHERE {} LIMIT 2",
        qualified(schema, table),
        conds.join(" AND ")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::ColumnDetail;

    fn col(name: &str, ty: &str, pk: bool) -> ColumnDetail {
        ColumnDetail {
            name: name.into(),
            type_name: ty.into(),
            nullable: !pk,
            is_pk: pk,
            default: None,
            comment: None,
        }
    }

    fn orders() -> TableMeta {
        TableMeta {
            kind: RelationKind::Table,
            columns: vec![col("id", "bigint", true), col("status", "order_status", false), col("Note \"x\"", "text", false)],
            pk: vec!["id".into()],
        }
    }

    fn f(column: &str, op: FilterOp, value: Option<&str>) -> Filter {
        Filter { column: column.into(), op, value: value.map(Into::into) }
    }

    fn req(table: &str, filters: &[Filter], raw_where: Option<&str>, sort: &[Sort], cursor: Option<Cursor>) -> PageRequest {
        PageRequest {
            conn_id: uuid::Uuid::nil(),
            schema: "public".into(),
            table: table.into(),
            filters: filters.to_vec(),
            raw_where: raw_where.map(Into::into),
            sort: sort.to_vec(),
            cursor,
            limit: 0,
        }
    }

    #[test]
    fn first_keyset_page() {
        let q = page_query(&req("orders", &[], None, &[], None), &orders(), 500).unwrap();
        assert_eq!(
            q.sql,
            "SELECT \"id\"::text, left(\"status\"::text, 2049), left(\"Note \"\"x\"\"\"::text, 2049) \
             FROM \"public\".\"orders\" ORDER BY \"public\".\"orders\".\"id\" LIMIT 501"
        );
        assert_eq!(q.mode, PageMode::Keyset);
        assert_eq!(q.pk_indexes, vec![0]);
    }

    #[test]
    fn keyset_cursor_with_filters() {
        let cursor = Cursor::Keyset { values: vec![Some("500".into())] };
        let filters = [f("status", FilterOp::Eq, Some("paid"))];
        let q = page_query(&req("orders", &filters, Some(" id > 3 "), &[], Some(cursor)), &orders(), 10).unwrap();
        assert!(q.sql.ends_with(
            "WHERE \"status\" = 'paid' AND (id > 3) AND (\"id\") > ('500'::bigint) ORDER BY \"public\".\"orders\".\"id\" LIMIT 11"
        ));
    }

    #[test]
    fn sorted_uses_offset_and_pk_tiebreak() {
        let sort = [Sort { column: "status".into(), desc: true }];
        let q = page_query(&req("orders", &[], None, &sort, Some(Cursor::Offset { offset: 1000 })), &orders(), 500)
            .unwrap();
        assert!(q.sql.ends_with(
            "ORDER BY \"public\".\"orders\".\"status\" DESC, \"public\".\"orders\".\"id\" LIMIT 501 OFFSET 1000"
        ));
        assert_eq!(q.mode, PageMode::Offset(1000));
    }

    #[test]
    fn no_pk_orders_by_ctid_or_columns() {
        let mut meta = TableMeta { kind: RelationKind::Table, columns: vec![col("a", "integer", false)], pk: vec![] };
        let q = page_query(&req("no_pk", &[], None, &[], None), &meta, 5).unwrap();
        assert!(q.sql.ends_with("ORDER BY \"public\".\"no_pk\".ctid LIMIT 6"));
        meta.kind = RelationKind::View;
        let q = page_query(&req("v", &[], None, &[], None), &meta, 5).unwrap();
        assert!(q.sql.ends_with("ORDER BY \"public\".\"v\".\"a\"::text LIMIT 6"));
    }

    #[test]
    fn filter_ops() {
        let m = orders();
        let w = where_clause(
            &m,
            &[
                f("status", FilterOp::In, Some("paid, shipped ,,x'y")),
                f("Note \"x\"", FilterOp::ILike, Some("%a\\b%")),
                f("id", FilterOp::IsNull, Some("ignored")),
                f("id", FilterOp::Ne, Some("1")),
            ],
            Some("   "),
        )
        .unwrap();
        assert_eq!(
            w,
            " WHERE \"status\" IN ('paid', 'shipped', 'x''y') AND \"Note \"\"x\"\"\"::text ILIKE E'%a\\\\b%' \
             AND \"id\" IS NULL AND \"id\" <> '1'"
        );
    }

    #[test]
    fn invalid_inputs() {
        let m = orders();
        assert!(matches!(where_clause(&m, &[f("nope", FilterOp::Eq, Some("1"))], None), Err(AppError::Invalid { .. })));
        assert!(matches!(where_clause(&m, &[f("id", FilterOp::Eq, None)], None), Err(AppError::Invalid { .. })));
        assert!(matches!(where_clause(&m, &[f("id", FilterOp::In, Some(" , "))], None), Err(AppError::Invalid { .. })));
        let sort = [Sort { column: "nope".into(), desc: false }];
        assert!(matches!(page_query(&req("t", &[], None, &sort, None), &m, 1), Err(AppError::Invalid { .. })));
        let bad = Cursor::Offset { offset: 1 };
        assert!(matches!(page_query(&req("t", &[], None, &[], Some(bad)), &m, 1), Err(AppError::Invalid { .. })));
    }

    #[test]
    fn cell_and_count_and_export() {
        let m = orders();
        assert_eq!(
            cell_query("public", "orders", &m, &["id".into()], &[Some("7".into())], "Note \"x\"").unwrap(),
            "SELECT \"Note \"\"x\"\"\"::text FROM \"public\".\"orders\" WHERE \"id\" = '7'::bigint LIMIT 2"
        );
        assert_eq!(
            count_query("public", "orders", &m, &[f("status", FilterOp::Eq, Some("paid"))], None).unwrap(),
            "SELECT count(*) FROM \"public\".\"orders\" WHERE \"status\" = 'paid'"
        );
        assert_eq!(
            export_query("public", "orders", &m, &[], None, &[]).unwrap(),
            "SELECT * FROM \"public\".\"orders\" ORDER BY \"id\""
        );
    }
}
