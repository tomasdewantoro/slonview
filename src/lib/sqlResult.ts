// Presentation helpers for SQL editor results and history. Pure; unit tested.
import type { QueryResult } from "../bindings/QueryResult";
import type { SchemaNode } from "../bindings/SchemaNode";
import type { SQLNamespace } from "@codemirror/lang-sql";
import { quoteIdent } from "./format";
import { splitStatements } from "./sqlSplit";

/** Leading keyword of a statement, upper-cased, skipping comments and whitespace. */
export function leadingKeyword(statement: string): string {
  const first = splitStatements(statement)[0];
  return (/^[A-Za-z]+/.exec(first?.text ?? "")?.[0] ?? "").toUpperCase();
}

/** Sub-tab label: "Result n" for row-returning statements, else a command tag like "UPDATE 5". */
export function resultLabel(result: QueryResult, index: number): string {
  if (result.columns.length > 0) return `Result ${index + 1}`;
  const keyword = leadingKeyword(result.statement) || "OK";
  return result.rowsAffected === null ? keyword : `${keyword} ${result.rowsAffected}`;
}

/** Message for statements without a result set. */
export function affectedMessage(result: QueryResult): string {
  if (result.rowsAffected === null) return "OK";
  return `${result.rowsAffected.toLocaleString()} ${result.rowsAffected === 1 ? "row" : "rows"} affected`;
}

/**
 * Export re-runs the statement server-side, so only allow a single read-only query:
 * SELECT / TABLE / VALUES, or WITH without data-modifying keywords.
 */
export function isExportable(result: QueryResult): boolean {
  if (result.columns.length === 0 || splitStatements(result.statement).length !== 1) return false;
  const keyword = leadingKeyword(result.statement);
  if (keyword === "SELECT" || keyword === "TABLE" || keyword === "VALUES") return true;
  return keyword === "WITH" && !/\b(insert|update|delete|merge)\b/i.test(result.statement);
}

export function formatElapsed(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

/** Compact relative time ("now", "5m", "3h", "2d") for an RFC 3339 timestamp; dates beyond a week. */
export function timeAgo(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 7 * 86400) return `${Math.floor(seconds / 86400)}d ago`;
  return new Date(then).toLocaleDateString();
}

/**
 * Autocomplete namespace: `{ schema: { table: [] } }` gives schema names, `schema.table`,
 * and (with defaultSchema "public") bare public table names. Columns are not loaded.
 * Keys escape `.` (lang-sql splits dotted keys); names needing quotes get a quoted `apply`.
 */
export function completionNamespace(schema: SchemaNode[]): SQLNamespace {
  const key = (name: string) => name.replace(/\./g, "\\.");
  const apply = (name: string) => (/^[a-z_][a-z_\d$]*$/.test(name) ? undefined : quoteIdent(name));
  return Object.fromEntries(
    schema.map((s) => [
      key(s.name),
      {
        self: { label: s.name, type: "namespace", apply: apply(s.name) },
        children: Object.fromEntries(
          s.relations.map((r) => [
            key(r.name),
            { self: { label: r.name, type: r.kind.includes("table") ? "type" : "class", detail: r.kind, apply: apply(r.name) }, children: [] },
          ]),
        ),
      },
    ]),
  );
}
