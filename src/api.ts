// Single IPC surface between React and Rust. Command names and argument keys must
// match `src-tauri/src/commands/*.rs` exactly (Tauri converts camelCase args to snake_case).
import { invoke } from "@tauri-apps/api/core";
import type { AppError } from "./bindings/AppError";
import type { CellRequest } from "./bindings/CellRequest";
import type { ConnProfile } from "./bindings/ConnProfile";
import type { ExportSource } from "./bindings/ExportSource";
import type { HistoryEntry } from "./bindings/HistoryEntry";
import type { Page } from "./bindings/Page";
import type { PageRequest } from "./bindings/PageRequest";
import type { ParsedConn } from "./bindings/ParsedConn";
import type { QueryResult } from "./bindings/QueryResult";
import type { SchemaNode } from "./bindings/SchemaNode";
import type { ServerInfo } from "./bindings/ServerInfo";
import type { TableDescription } from "./bindings/TableDescription";
import type { Filter } from "./bindings/Filter";

export function isAppError(e: unknown): e is AppError {
  return typeof e === "object" && e !== null && "kind" in e;
}

export function errorMessage(e: unknown): string {
  if (isAppError(e)) {
    switch (e.kind) {
      case "cancelled":
        return "Query cancelled";
      case "timeout":
        return "Query timed out";
      case "notConnected":
        return "Not connected";
      case "sql":
        return [e.message, e.detail, e.hint ? `Hint: ${e.hint}` : null].filter(Boolean).join("\n");
      default:
        return e.message;
    }
  }
  return e instanceof Error ? e.message : String(e);
}

export const newRequestId = (): string => crypto.randomUUID();

export const api = {
  // Profiles (TOML on disk; passwords in macOS Keychain)
  listProfiles: () => invoke<ConnProfile[]>("list_profiles"),
  /** password: undefined = keep stored password, null = delete it, string = set it. */
  saveProfile: (profile: ConnProfile, password: string | null | undefined) =>
    invoke<ConnProfile[]>("save_profile", { profile, password }),
  deleteProfile: (id: string) => invoke<ConnProfile[]>("delete_profile", { id }),
  parseConnUrl: (url: string) => invoke<ParsedConn>("parse_conn_url", { url }),
  importPgpass: () => invoke<ParsedConn[]>("import_pgpass"),

  // Connections. testConnection uses the unsaved profile + password from the form.
  testConnection: (profile: ConnProfile, password: string | null) =>
    invoke<ServerInfo>("test_connection", { profile, password }),
  connect: (connId: string) => invoke<ServerInfo>("connect", { connId }),
  disconnect: (connId: string) => invoke<void>("disconnect", { connId }),

  // Schema
  listSchemaTree: (connId: string) => invoke<SchemaNode[]>("list_schema_tree", { connId }),
  describeTable: (connId: string, schema: string, table: string) =>
    invoke<TableDescription>("describe_table", { connId, schema, table }),
  /** `CREATE OR REPLACE …` text; aggregates get an SQL comment block instead. */
  getFunctionDefinition: (connId: string, oid: number) => invoke<string>("get_function_definition", { connId, oid }),

  // Data
  fetchPage: (requestId: string, req: PageRequest) => invoke<Page>("fetch_page", { requestId, req }),
  countExact: (requestId: string, connId: string, schema: string, table: string, filters: Filter[], rawWhere: string | null) =>
    invoke<number>("count_exact", { requestId, connId, schema, table, filters, rawWhere }),
  getCell: (req: CellRequest) => invoke<string | null>("get_cell", { req }),

  // SQL editor. Runs every statement in `sql`; one QueryResult per statement.
  runSql: (requestId: string, connId: string, sql: string, maxRows?: number) =>
    invoke<QueryResult[]>("run_sql", { requestId, connId, sql, maxRows: maxRows ?? null }),
  cancelQuery: (requestId: string) => invoke<void>("cancel_query", { requestId }),

  // Export: streams to `path` in Rust. Returns rows written (excluding header).
  exportCsv: (requestId: string, source: ExportSource, path: string) =>
    invoke<number>("export_csv", { requestId, source, path }),

  // History (JSONL, newest first)
  listHistory: (connId: string | null, search: string | null, limit?: number) =>
    invoke<HistoryEntry[]>("list_history", { connId, search, limit: limit ?? null }),
  clearHistory: () => invoke<void>("clear_history"),
};
