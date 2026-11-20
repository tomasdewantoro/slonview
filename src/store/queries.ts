// Pure helpers that turn UI state (filter rows, sort clicks) into backend requests.
import type { Cursor } from "../bindings/Cursor";
import type { Filter } from "../bindings/Filter";
import type { FilterOp } from "../bindings/FilterOp";
import type { PageRequest } from "../bindings/PageRequest";
import type { Sort } from "../bindings/Sort";

export const PAGE_SIZE = 500;

export const FILTER_OPS: FilterOp[] = [
  "=",
  "!=",
  "<",
  "<=",
  ">",
  ">=",
  "LIKE",
  "ILIKE",
  "IN",
  "IS NULL",
  "IS NOT NULL",
];

export const isNullOp = (op: FilterOp): boolean => op === "IS NULL" || op === "IS NOT NULL";

/** One editable row of the filter bar. `value` is ignored for IS NULL / IS NOT NULL. */
export interface FilterRow {
  id: string;
  column: string;
  op: FilterOp;
  value: string;
}

/** The query state of a table tab (persisted with the tab). */
export interface TableQuery {
  schema: string;
  table: string;
  filters: FilterRow[];
  rawWhere: string;
  sort: Sort[];
}

/**
 * Filter rows -> request filters. Rows without a column, and value-taking rows whose value
 * is empty, are skipped (an untouched new row must not filter everything out). IN values are
 * passed as the comma-separated list the backend expects.
 */
export function filtersToRequest(rows: FilterRow[]): Filter[] {
  const out: Filter[] = [];
  for (const r of rows) {
    if (!r.column) continue;
    if (isNullOp(r.op)) {
      out.push({ column: r.column, op: r.op, value: null });
    } else if (r.value !== "") {
      out.push({ column: r.column, op: r.op, value: r.value });
    }
  }
  return out;
}

export function normalizeRawWhere(raw: string): string | null {
  const t = raw.trim();
  return t === "" ? null : t;
}

export function buildPageRequest(connId: string, q: TableQuery, cursor: Cursor | null): PageRequest {
  return {
    connId,
    schema: q.schema,
    table: q.table,
    filters: filtersToRequest(q.filters),
    rawWhere: normalizeRawWhere(q.rawWhere),
    sort: q.sort,
    cursor,
    limit: PAGE_SIZE,
  };
}

/**
 * Header click. Plain click makes `column` the only sort key and cycles it
 * asc -> desc -> none. Shift-click (additive) cycles it in place, keeping the other keys.
 */
export function nextSort(sort: Sort[], column: string, additive: boolean): Sort[] {
  const cur = sort.find((s) => s.column === column);
  const next: Sort | null = !cur ? { column, desc: false } : cur.desc ? null : { column, desc: true };
  if (!additive) return next ? [next] : [];
  if (!cur) return [...sort, next as Sort];
  return next ? sort.map((s) => (s.column === column ? next : s)) : sort.filter((s) => s.column !== column);
}

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function selectSql(schema: string, table: string): string {
  return `SELECT * FROM ${quoteIdent(schema)}.${quoteIdent(table)} LIMIT 100;`;
}

export function formatCount(n: number): string {
  if (n < 0) return "?";
  if (n < 1000) return String(Math.round(n));
  const units: [number, string][] = [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "k"],
  ];
  for (const [base, suffix] of units) {
    if (n >= base) {
      const v = n / base;
      return `${v >= 100 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, "")}${suffix}`;
    }
  }
  return String(n);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["kB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, "")} ${units[i]}`;
}
