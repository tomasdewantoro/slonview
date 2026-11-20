// Copy/serialize helpers. Owned by WP-FE-SQL; used by ResultGrid's copy actions.
import type { Column } from "../bindings/Column";

export type CopyFormat = "tsv" | "csv" | "json" | "insert";

/**
 * Serialize a rectangular selection. `rows` already sliced to the selection;
 * `columns` matches. NULL handling: tsv/csv -> empty string? No: tsv "\N"-free empty
 * cell for NULL, csv empty unquoted field for NULL and `""` for empty string,
 * json -> null, insert -> NULL. INSERT quotes identifiers with "" and literals with ''
 * (E'' when the value contains a backslash), one statement per row.
 */
export function serializeRows(
  _format: CopyFormat,
  _columns: Column[],
  _rows: (string | null)[][],
  _target?: { schema: string; table: string },
): string {
  throw new Error("WP-FE-SQL");
}
