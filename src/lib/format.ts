// Copy/serialize helpers. Owned by WP-FE-SQL; used by ResultGrid's copy actions.
import type { Column } from "../bindings/Column";

export type CopyFormat = "tsv" | "csv" | "json" | "insert";

/**
 * Serialize a rectangular selection. `rows` already sliced to the selection;
 * `columns` matches. Values are Postgres text output; null = SQL NULL.
 *
 * - tsv: header row, tab-separated, rows joined by "\n". Values containing tab, newline,
 *   carriage return or `"` are wrapped in `"` with `""` escaping (Excel/Sheets-compatible).
 *   NULL -> empty cell.
 * - csv: RFC 4180 with header, CRLF row separator. NULL -> empty unquoted field,
 *   empty string -> `""`.
 * - json: pretty (2-space) array of objects keyed by column name; values stay strings,
 *   NULL -> null. Duplicate column names: the last one wins (JSON object semantics).
 * - insert: one `INSERT INTO <target> ("c1", ...) VALUES (...);` per row. Identifiers quoted
 *   with `""` doubling; literals with `''` doubling, `E'...'` with doubled backslashes when the
 *   value contains a backslash; NULL -> NULL. Target defaults to unqualified `result`.
 */
export function serializeRows(
  format: CopyFormat,
  columns: Column[],
  rows: (string | null)[][],
  target?: { schema: string; table: string },
): string {
  switch (format) {
    case "tsv":
      return [columns.map((c) => tsvField(c.name)), ...rows.map((r) => r.map(tsvField))]
        .map((line) => line.join("\t"))
        .join("\n");
    case "csv":
      return [columns.map((c) => csvField(c.name)), ...rows.map((r) => r.map(csvField))]
        .map((line) => line.join(","))
        .join("\r\n");
    case "json":
      return JSON.stringify(
        rows.map((r) => Object.fromEntries(columns.map((c, i) => [c.name, r[i] ?? null]))),
        null,
        2,
      );
    case "insert": {
      const table = target ? `${quoteIdent(target.schema)}.${quoteIdent(target.table)}` : "result";
      const cols = columns.map((c) => quoteIdent(c.name)).join(", ");
      return rows
        .map((r) => `INSERT INTO ${table} (${cols}) VALUES (${r.map(quoteLiteral).join(", ")});`)
        .join("\n");
    }
  }
}

function tsvField(v: string | null): string {
  if (v === null) return "";
  return /[\t\n\r"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function csvField(v: string | null): string {
  if (v === null) return "";
  return v === "" || /[,"\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function quoteLiteral(v: string | null): string {
  if (v === null) return "NULL";
  const body = v.replace(/'/g, "''");
  return v.includes("\\") ? `E'${body.replace(/\\/g, "\\\\")}'` : `'${body}'`;
}
