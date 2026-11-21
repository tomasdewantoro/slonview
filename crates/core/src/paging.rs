//! Browse-mode SQL building: filters, sort, keyset/offset paging, counts, cell
//! lookups and table exports. Every identifier goes through `quote_ident` and every
//! value through `quote_literal`; `raw_where` is the only verbatim input.
use std::fmt::Write;

use crate::ident::{qualified, quote_ident, quote_literal};
use crate::introspect::TableMeta;
use crate::model::{
    CELL_TRUNCATE_CHARS, Cursor, Filter, FilterOp, PageRequest, RelationKind, Sort,
};
use crate::{AppError, AppResult};
use crate::{
    Engine,
    engine::restore_session,
    model::{ColumnCopyChunk, ColumnCopyRequest, ColumnCopySummary},
    query,
};
use futures_util::{TryStreamExt, pin_mut};
use tokio_postgres::SimpleQueryMessage;

/// The `WHERE ...` clause (with leading space) or an empty string, plus the character
/// offset of the verbatim `raw_where` text inside that clause (it is always the last part).
pub(crate) fn where_clause(
    meta: &TableMeta,
    filters: &[Filter],
    raw_where: Option<&str>,
) -> AppResult<(String, Option<usize>)> {
    let mut parts = filters
        .iter()
        .map(|f| filter_sql(meta, f))
        .collect::<AppResult<Vec<_>>>()?;
    let raw = raw_where.map(str::trim).filter(|r| !r.is_empty());
    if let Some(raw) = raw {
        parts.push(format!("({raw})"));
    }
    if parts.is_empty() {
        return Ok((String::new(), None));
    }
    let clause = format!(" WHERE {}", parts.join(" AND "));
    // `({raw})` closes the clause: raw starts raw + ")" characters before the end.
    let raw_at = raw.map(|r| clause.chars().count() - r.chars().count() - 1);
    Ok((clause, raw_at))
}

/// Where the verbatim raw WHERE text sits in a generated statement, so a Postgres error
/// position (1-based characters in the whole statement) can be reported relative to the
/// expression the user typed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct RawSpan {
    /// 0-based character offset of the raw text in the statement.
    pub start: usize,
    pub chars: usize,
}

impl RawSpan {
    fn new(prefix: &str, clause_offset: Option<usize>, raw_where: Option<&str>) -> Option<Self> {
        let raw = raw_where.map(str::trim).filter(|r| !r.is_empty())?;
        Some(Self {
            start: prefix.chars().count() + clause_offset?,
            chars: raw.chars().count(),
        })
    }

    /// The same span after `prefix` is prepended to the statement.
    pub(crate) fn shifted(self, prefix: &str) -> Self {
        Self {
            start: self.start + prefix.chars().count(),
            ..self
        }
    }

    /// Rewrites a SQL error position into the raw expression; positions in generated
    /// SQL mean nothing to the user and are dropped.
    pub(crate) fn relocate(span: Option<Self>, mut e: AppError) -> AppError {
        if let AppError::Sql { position, .. } = &mut e
            && let Some(p) = *position
        {
            let p0 = p as usize - 1;
            *position = span
                .filter(|s| p0 >= s.start && p0 <= s.start + s.chars)
                .map(|s| (p0 - s.start + 1) as u32);
        }
        e
    }
}

fn filter_sql(meta: &TableMeta, f: &Filter) -> AppResult<String> {
    let col = quote_ident(&meta.column(&f.column)?.name);
    let value = || {
        f.value
            .as_deref()
            .ok_or_else(|| AppError::invalid(format!("filter on {:?} needs a value", f.column)))
    };
    let cmp =
        |op: &str| -> AppResult<String> { Ok(format!("{col} {op} {}", quote_literal(value()?))) };
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
                return Err(AppError::invalid(format!(
                    "IN filter on {:?} needs at least one value",
                    f.column
                )));
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
    /// Index of each sort key followed by unique PK tie-breakers in the select list.
    pub pk_indexes: Vec<usize>,
    pub raw_span: Option<RawSpan>,
}

/// Selects cursor columns in full; other columns are cut to
/// `CELL_TRUNCATE_CHARS + 1` chars to detect truncation. Fetches `limit + 1` rows.
/// `limit` is the effective page size (the request's 0 already replaced by the default).
pub(crate) fn page_query(req: &PageRequest, meta: &TableMeta, limit: u32) -> AppResult<PageQuery> {
    let PageRequest {
        schema,
        table,
        filters,
        raw_where,
        sort,
        cursor,
        ..
    } = req;
    let (raw_where, cursor) = (raw_where.as_deref(), cursor.as_ref());
    if meta.columns.is_empty() {
        return Err(AppError::invalid(format!(
            "{schema}.{table} has no columns"
        )));
    }
    let keys = paging_keys(meta, sort)?;
    let select = meta
        .columns
        .iter()
        .map(|c| {
            let q = quote_ident(&c.name);
            if keys.iter().any(|s| s.column == c.name) {
                format!("{q}::text")
            } else {
                format!("left({q}::text, {})", CELL_TRUNCATE_CHARS + 1)
            }
        })
        .collect::<Vec<_>>()
        .join(", ");
    let (mut where_sql, raw_at) = where_clause(meta, filters, raw_where)?;
    let keyset = !meta.pk.is_empty();
    let mut sql = format!("SELECT {select} FROM {}", qualified(schema, table));
    let raw_span = RawSpan::new(&sql, raw_at, raw_where);

    let mode = if keyset {
        if let Some(cursor) = cursor {
            let Cursor::Keyset { values } = cursor else {
                return Err(AppError::invalid("cursor does not match keyset paging"));
            };
            let cond = seek_condition(meta, &keys, values)?;
            where_sql = if where_sql.is_empty() {
                format!(" WHERE {cond}")
            } else {
                format!("{where_sql} AND {cond}")
            };
        }
        PageMode::Keyset
    } else {
        match cursor {
            None => PageMode::Offset(0),
            Some(Cursor::Offset { offset }) => PageMode::Offset(*offset),
            Some(Cursor::Keyset { .. }) => {
                return Err(AppError::invalid("cursor does not match offset paging"));
            }
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
        keys.iter()
            .map(|s| {
                meta.columns
                    .iter()
                    .position(|c| c.name == s.column)
                    .expect("validated sort column")
            })
            .collect()
    } else {
        Vec::new()
    };
    Ok(PageQuery {
        sql,
        mode,
        pk_indexes,
        raw_span,
    })
}

/// Use PostgreSQL's default NULL ordering: ASC NULLS LAST / DESC NULLS FIRST.
fn paging_keys(meta: &TableMeta, sort: &[Sort]) -> AppResult<Vec<Sort>> {
    let mut keys = Vec::with_capacity(sort.len() + meta.pk.len());
    for s in sort {
        meta.column(&s.column)?;
        if keys.iter().any(|k: &Sort| k.column == s.column) {
            return Err(AppError::invalid("duplicate sort column"));
        }
        keys.push(s.clone());
    }
    for pk in &meta.pk {
        if !keys.iter().any(|s| &s.column == pk) {
            keys.push(Sort {
                column: pk.clone(),
                desc: false,
            });
        }
    }
    Ok(keys)
}

fn seek_condition(meta: &TableMeta, keys: &[Sort], values: &[Option<String>]) -> AppResult<String> {
    if values.len() != keys.len() {
        return Err(AppError::invalid(
            "cursor has the wrong number of key values",
        ));
    }
    let mut cols = Vec::with_capacity(keys.len());
    let mut lits = Vec::with_capacity(keys.len());
    let mut nullable = false;
    for (s, value) in keys.iter().zip(values) {
        let c = meta.column(&s.column)?;
        if value.is_none() && !c.nullable {
            return Err(AppError::invalid(
                "cursor contains NULL in a non-nullable key",
            ));
        }
        nullable |= c.nullable;
        cols.push(quote_ident(&s.column));
        lits.push(value.as_deref().map(|v| typed_literal(v, &c.type_name)));
    }
    if !nullable && keys.iter().all(|s| s.desc == keys[0].desc) {
        return Ok(format!(
            "({}) {} ({})",
            cols.join(", "),
            if keys[0].desc { "<" } else { ">" },
            lits.iter()
                .map(|v| v.as_deref().expect("non-nullable key"))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    // Lexicographic OR-chain: earlier keys equal (including NULL), current key follows.
    // Row comparisons alone are wrong for mixed directions and NULL cursor values.
    let mut branches = Vec::with_capacity(keys.len());
    let mut prefix = Vec::with_capacity(keys.len());
    for (i, s) in keys.iter().enumerate() {
        let c = &cols[i];
        let after = match (&lits[i], s.desc) {
            (None, true) => Some(format!("{c} IS NOT NULL")),
            (None, false) => None,
            (Some(v), true) => Some(format!("{c} < {v}")),
            (Some(v), false) if meta.column(&s.column)?.nullable => {
                Some(format!("({c} > {v} OR {c} IS NULL)"))
            }
            (Some(v), false) => Some(format!("{c} > {v}")),
        };
        if let Some(after) = after {
            let mut branch = prefix.clone();
            branch.push(after);
            branches.push(format!("({})", branch.join(" AND ")));
        }
        prefix.push(match &lits[i] {
            Some(v) => format!("{c} = {v}"),
            None => format!("{c} IS NULL"),
        });
    }
    Ok(if branches.is_empty() {
        "FALSE".into()
    } else {
        format!("({})", branches.join(" OR "))
    })
}

impl Engine {
    /// Streams only the requested columns, in the same deterministic order as browsing.
    /// Always read-only, even for writable profiles: a Raw WHERE must not perform writes.
    pub async fn stream_columns(
        &self,
        request_id: &str,
        req: &ColumnCopyRequest,
        mut emit: impl FnMut(ColumnCopyChunk) -> AppResult<()> + Send,
    ) -> AppResult<ColumnCopySummary> {
        const CAP: u32 = 1_000_000;
        let (session, client) = self.client(req.page.conn_id).await?;
        let p = &req.page;
        let meta = crate::introspect::table_meta(&client, &p.schema, &p.table).await?;
        if req.columns.is_empty() {
            return Err(AppError::invalid("Select at least one column"));
        }
        let select = req
            .columns
            .iter()
            .map(|n| {
                meta.column(n)
                    .map(|c| format!("{}::text", quote_ident(&c.name)))
            })
            .collect::<AppResult<Vec<_>>>()?
            .join(", ");
        let rel = qualified(&p.schema, &p.table);
        let mut sql = format!("SELECT {select} FROM {rel}");
        let (clause, raw_at) = where_clause(&meta, &p.filters, p.raw_where.as_deref())?;
        let span = RawSpan::new(&sql, raw_at, p.raw_where.as_deref());
        sql.push_str(&clause);
        sql.push_str(&order_by(&rel, &meta, &p.sort)?);
        let _ = write!(sql, " LIMIT {}", CAP + 1);
        let guard =
            self.cancels
                .register(request_id, client.cancel_token(), session.transport.clone())?;
        let result = async {
            query::require_single_statement(&client, &sql, &guard).await?;
            let start = query::begin_read_only(&client, &guard).await?;
            let stream = client
                .simple_query_raw(&sql)
                .await
                .map_err(|e| guard.map_err(e))?;
            pin_mut!(stream);
            let mut count = 0;
            let mut capped = false;
            let mut rows = Vec::with_capacity(2000);
            while let Some(message) = stream.try_next().await.map_err(|e| guard.map_err(e))? {
                if let SimpleQueryMessage::Row(row) = message {
                    if count == CAP {
                        capped = true;
                        continue;
                    }
                    rows.push(
                        (0..req.columns.len())
                            .map(|i| row.get(i).map(str::to_owned))
                            .collect(),
                    );
                    count += 1;
                    if rows.len() == 2000 {
                        emit(ColumnCopyChunk {
                            rows: std::mem::replace(&mut rows, Vec::with_capacity(2000)),
                        })?;
                    }
                }
            }
            query::verify_read_only(&client, &start, &guard).await?;
            if !rows.is_empty() {
                emit(ColumnCopyChunk { rows })?;
            }
            Ok(ColumnCopySummary { count, capped })
        }
        .await
        .map_err(|e| RawSpan::relocate(span, e));
        drop(guard);
        restore_session(client, &session.profile).await;
        result
    }
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
            RelationKind::Table | RelationKind::MaterializedView => {
                keys.push(format!("{rel}.ctid"))
            }
            RelationKind::PartitionedTable => {
                keys.push(format!("{rel}.tableoid"));
                keys.push(format!("{rel}.ctid"));
            }
            RelationKind::View | RelationKind::ForeignTable => {
                keys.extend(
                    meta.columns
                        .iter()
                        .map(|c| format!("{}::text", col(&c.name))),
                );
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
) -> AppResult<(String, Option<RawSpan>)> {
    let mut sql = format!("SELECT count(*) FROM {}", qualified(schema, table));
    let (where_sql, raw_at) = where_clause(meta, filters, raw_where)?;
    let span = RawSpan::new(&sql, raw_at, raw_where);
    sql.push_str(&where_sql);
    Ok((sql, span))
}

/// `EXPLAIN` (never executed) of the rows a filtered page request would return; the plan's
/// top-level "Plan Rows" is the estimate. Raw WHERE text is not accepted here.
pub(crate) fn estimate_query(
    schema: &str,
    table: &str,
    meta: &TableMeta,
    filters: &[Filter],
) -> AppResult<String> {
    let (where_sql, _) = where_clause(meta, filters, None)?;
    Ok(format!(
        "EXPLAIN (FORMAT JSON) SELECT 1 FROM {}{where_sql}",
        qualified(schema, table)
    ))
}

/// Full-value export of a table: all columns, same filters, user sort (or PK order).
pub(crate) fn export_query(
    schema: &str,
    table: &str,
    meta: &TableMeta,
    filters: &[Filter],
    raw_where: Option<&str>,
    sort: &[Sort],
) -> AppResult<(String, Option<RawSpan>)> {
    let mut sql = format!("SELECT * FROM {}", qualified(schema, table));
    let (where_sql, raw_at) = where_clause(meta, filters, raw_where)?;
    let span = RawSpan::new(&sql, raw_at, raw_where);
    sql.push_str(&where_sql);
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
    Ok((sql, span))
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
        return Err(AppError::invalid(
            "get_cell needs one value per primary-key column",
        ));
    }
    let target = quote_ident(&meta.column(column)?.name);
    let mut conds = Vec::with_capacity(pk_columns.len());
    for (name, value) in pk_columns.iter().zip(pk_values) {
        let col = meta.column(name)?;
        let value = value
            .as_deref()
            .ok_or_else(|| AppError::invalid("primary-key value is NULL"))?;
        conds.push(format!(
            "{} = {}",
            quote_ident(&col.name),
            typed_literal(value, &col.type_name)
        ));
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
            columns: vec![
                col("id", "bigint", true),
                col("status", "order_status", false),
                col("Note \"x\"", "text", false),
            ],
            pk: vec!["id".into()],
            references: Default::default(),
            est_rows: -1,
        }
    }

    fn f(column: &str, op: FilterOp, value: Option<&str>) -> Filter {
        Filter {
            column: column.into(),
            op,
            value: value.map(Into::into),
        }
    }

    fn req(
        table: &str,
        filters: &[Filter],
        raw_where: Option<&str>,
        sort: &[Sort],
        cursor: Option<Cursor>,
    ) -> PageRequest {
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
        let cursor = Cursor::Keyset {
            values: vec![Some("500".into())],
        };
        let filters = [f("status", FilterOp::Eq, Some("paid"))];
        let q = page_query(
            &req("orders", &filters, Some(" id > 3 "), &[], Some(cursor)),
            &orders(),
            10,
        )
        .unwrap();
        assert!(q.sql.ends_with(
            "WHERE \"status\" = 'paid' AND (id > 3) AND (\"id\") > ('500'::bigint) ORDER BY \"public\".\"orders\".\"id\" LIMIT 11"
        ));
    }

    #[test]
    fn sorted_uses_keyset_and_pk_tiebreak() {
        let sort = [Sort {
            column: "status".into(),
            desc: true,
        }];
        let q = page_query(
            &req(
                "orders",
                &[],
                None,
                &sort,
                Some(Cursor::Keyset {
                    values: vec![None, Some("1000".into())],
                }),
            ),
            &orders(),
            500,
        )
        .unwrap();
        assert!(q.sql.ends_with(
            "ORDER BY \"public\".\"orders\".\"status\" DESC, \"public\".\"orders\".\"id\" LIMIT 501"
        ));
        assert!(q.sql.contains("\"status\" IS NOT NULL"));
        assert!(
            q.sql
                .contains("\"status\" IS NULL AND \"id\" > '1000'::bigint")
        );
        assert_eq!(q.pk_indexes, vec![1, 0]);
        assert_eq!(q.mode, PageMode::Keyset);
    }

    #[test]
    fn no_pk_orders_by_ctid_or_columns() {
        let mut meta = TableMeta {
            kind: RelationKind::Table,
            columns: vec![col("a", "integer", false)],
            pk: vec![],
            references: Default::default(),
            est_rows: -1,
        };
        let q = page_query(&req("no_pk", &[], None, &[], None), &meta, 5).unwrap();
        assert!(
            q.sql
                .ends_with("ORDER BY \"public\".\"no_pk\".ctid LIMIT 6")
        );
        meta.kind = RelationKind::View;
        let q = page_query(&req("v", &[], None, &[], None), &meta, 5).unwrap();
        assert!(
            q.sql
                .ends_with("ORDER BY \"public\".\"v\".\"a\"::text LIMIT 6")
        );
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
            w.0,
            " WHERE \"status\" IN ('paid', 'shipped', 'x''y') AND \"Note \"\"x\"\"\"::text ILIKE E'%a\\\\b%' \
             AND \"id\" IS NULL AND \"id\" <> '1'"
        );
    }

    /// Postgres positions point into the generated statement; errors must report them
    /// relative to the raw WHERE text, and drop positions outside it.
    #[test]
    fn raw_where_error_position_is_relative_to_user_text() {
        let m = orders();
        let raw = "  ünï >> AND ";
        let filters = [f("status", FilterOp::Eq, Some("paid"))];
        let sql_err = |position| AppError::Sql {
            code: "42601".into(),
            message: "m".into(),
            detail: None,
            hint: None,
            position,
        };
        let at =
            |sql: &str, needle: &str| sql[..sql.find(needle).unwrap()].chars().count() as u32 + 1;
        let pos = |e: AppError| match e {
            AppError::Sql { position, .. } => position,
            _ => unreachable!(),
        };

        let q = page_query(&req("orders", &filters, Some(raw), &[], None), &m, 5).unwrap();
        assert_eq!(
            pos(RawSpan::relocate(
                q.raw_span,
                sql_err(Some(at(&q.sql, "AND)")))
            )),
            Some(8)
        );
        assert_eq!(pos(RawSpan::relocate(q.raw_span, sql_err(Some(1)))), None);
        assert_eq!(pos(RawSpan::relocate(None, sql_err(Some(3)))), None);

        let (sql, span) = count_query("public", "orders", &m, &filters, Some(raw)).unwrap();
        assert_eq!(
            pos(RawSpan::relocate(span, sql_err(Some(at(&sql, "ünï"))))),
            Some(1)
        );

        let (sql, span) = export_query("public", "orders", &m, &[], Some(raw), &[]).unwrap();
        let copy = format!("COPY ({sql})");
        let span = span.map(|s| s.shifted("COPY ("));
        assert_eq!(
            pos(RawSpan::relocate(span, sql_err(Some(at(&copy, ">>"))))),
            Some(5)
        );
    }

    #[test]
    fn invalid_inputs() {
        let m = orders();
        assert!(matches!(
            where_clause(&m, &[f("nope", FilterOp::Eq, Some("1"))], None),
            Err(AppError::Invalid { .. })
        ));
        assert!(matches!(
            where_clause(&m, &[f("id", FilterOp::Eq, None)], None),
            Err(AppError::Invalid { .. })
        ));
        assert!(matches!(
            where_clause(&m, &[f("id", FilterOp::In, Some(" , "))], None),
            Err(AppError::Invalid { .. })
        ));
        let sort = [Sort {
            column: "nope".into(),
            desc: false,
        }];
        assert!(matches!(
            page_query(&req("t", &[], None, &sort, None), &m, 1),
            Err(AppError::Invalid { .. })
        ));
        let bad = Cursor::Offset { offset: 1 };
        assert!(matches!(
            page_query(&req("t", &[], None, &[], Some(bad)), &m, 1),
            Err(AppError::Invalid { .. })
        ));
    }

    #[test]
    fn cell_and_count_and_export() {
        let m = orders();
        assert_eq!(
            cell_query(
                "public",
                "orders",
                &m,
                &["id".into()],
                &[Some("7".into())],
                "Note \"x\""
            )
            .unwrap(),
            "SELECT \"Note \"\"x\"\"\"::text FROM \"public\".\"orders\" WHERE \"id\" = '7'::bigint LIMIT 2"
        );
        assert_eq!(
            count_query(
                "public",
                "orders",
                &m,
                &[f("status", FilterOp::Eq, Some("paid"))],
                None
            )
            .unwrap(),
            (
                "SELECT count(*) FROM \"public\".\"orders\" WHERE \"status\" = 'paid'".to_owned(),
                None
            )
        );
        assert_eq!(
            export_query("public", "orders", &m, &[], None, &[]).unwrap(),
            (
                "SELECT * FROM \"public\".\"orders\" ORDER BY \"id\"".to_owned(),
                None
            )
        );
    }
}
