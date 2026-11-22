// "Show rows referencing this": which foreign keys pointing at a table can be followed back from one row.
import type { Column } from "../bindings/Column";
import type { ForeignKeyTarget } from "../bindings/ForeignKeyTarget";
import type { ReferencingKey } from "../bindings/ReferencingKey";

export interface ReferencingLink {
  /** Constraint name; unique per referencing table. */
  key: string;
  /** `Rows in <table> (<column>)`, the table schema-qualified outside `public`. */
  label: string;
  /** The referencing table and column to filter on. */
  target: ForeignKeyTarget;
  value: string;
}

/**
 * One link per single-column key whose referenced column is in `columns` and has a value in
 * `row`. Multi-column keys are left out (one row value can't stand for them here), and so are
 * NULL and server-truncated values, which would match nothing.
 */
export function referencingLinks(keys: ReferencingKey[], columns: Column[], row: (string | null)[], truncatedCols: ReadonlySet<number> = new Set()): ReferencingLink[] {
  const out: ReferencingLink[] = [];
  for (const k of keys) {
    if (k.columns.length !== 1) continue;
    const col = columns.findIndex((c) => c.name === k.referencedColumns[0]);
    const value = col < 0 ? null : row[col];
    if (value == null || truncatedCols.has(col)) continue;
    const table = k.schema === "public" ? k.table : `${k.schema}.${k.table}`;
    out.push({ key: `${k.schema}.${k.table}.${k.constraintName}`, label: `Rows in ${table} (${k.columns[0]})`, target: { schema: k.schema, table: k.table, column: k.columns[0] }, value });
  }
  return out;
}
