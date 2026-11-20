// Generic read-only data grid (Glide Data Grid). Owned by WP-FE-BROWSE; used by table
// browsing and by SQL results (WP-FE-SQL). Props are a contract: change only with both owners.
import type { Column } from "../bindings/Column";

export interface CellRef {
  row: number;
  col: number;
}

export interface ResultGridProps {
  columns: Column[];
  /** Postgres text values; null = SQL NULL. */
  rows: (string | null)[][];
  /** [row, col] pairs whose value was truncated server-side (rendered with a trailing "…" marker). */
  truncated?: [number, number][];
  /** Called when the user scrolls within ~100 rows of the end. Grid ignores calls while `loading`. */
  onNearEnd?: () => void;
  loading?: boolean;
  /** Header click; undefined = sorting disabled (SQL results). */
  onSortColumn?: (column: string) => void;
  sort?: { column: string; desc: boolean }[];
  /** Selected cell changed (single cell focus). */
  onSelectCell?: (cell: CellRef | null) => void;
  /** Double-click or Enter on a cell: open inspector. */
  onOpenCell?: (cell: CellRef) => void;
  /** Schema/table for "Copy as INSERT"; when absent INSERT uses table name "result". */
  insertTarget?: { schema: string; table: string };
}

export function ResultGrid(_props: ResultGridProps) {
  return null;
}
