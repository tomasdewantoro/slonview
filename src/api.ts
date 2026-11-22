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
import type { ObjectKind } from "./bindings/ObjectKind";
import type { SchemaTree } from "./bindings/SchemaTree";
import type { ServerInfo } from "./bindings/ServerInfo";
import type { TableDescription } from "./bindings/TableDescription";
import type { Filter } from "./bindings/Filter";
import { Channel } from "@tauri-apps/api/core";
import type { ColumnCopyChunk } from "./bindings/ColumnCopyChunk";
import type { ColumnCopyRequest } from "./bindings/ColumnCopyRequest";
import type { ColumnCopySummary } from "./bindings/ColumnCopySummary";
import type { EditInfo } from "./bindings/EditInfo";
import type { EditRequest } from "./bindings/EditRequest";
import type { EditValue } from "./bindings/EditValue";
import type { ColumnRef } from "./bindings/ColumnRef";
import type { ExplainResult } from "./bindings/ExplainResult";
import type { ReferencingKey } from "./bindings/ReferencingKey";
import type { ExportFormat } from "./bindings/ExportFormat";
import type { SavedQuery } from "./bindings/SavedQuery";
import type { SavedQueryInput } from "./bindings/SavedQueryInput";
import type { Activity } from "./bindings/Activity";
import type { UpdateStatus } from "./bindings/UpdateStatus";

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
  // Profiles (TOML on disk; passwords in the OS credential store)
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
  /** Schemas with relations, functions, sequences, types and triggers, plus extensions. */
  listSchemaTree: (connId: string) => invoke<SchemaTree>("list_schema_tree", { connId }),
  describeTable: (connId: string, schema: string, table: string) =>
    invoke<TableDescription>("describe_table", { connId, schema, table }),
  /** `CREATE OR REPLACE …` text; aggregates get an SQL comment block instead. */
  getFunctionDefinition: (connId: string, oid: number) => invoke<string>("get_function_definition", { connId, oid }),

  // Data
  fetchPage: (requestId: string, req: PageRequest) => invoke<Page>("fetch_page", { requestId, req }),
  countExact: (requestId: string, connId: string, schema: string, table: string, filters: Filter[], search: string | null, rawWhere: string | null) =>
    invoke<number>("count_exact", { requestId, connId, schema, table, filters, search, rawWhere }),
  getCell: (req: CellRequest) => invoke<string | null>("get_cell", { req }),

  // SQL editor. Runs every statement in `sql`; one QueryResult per statement.
  runSql: (requestId: string, connId: string, sql: string, maxRows?: number) =>
    invoke<QueryResult[]>("run_sql", { requestId, connId, sql, maxRows: maxRows ?? null }),
  cancelQuery: (requestId: string) => invoke<void>("cancel_query", { requestId }),

  // Export: streams to `path` in Rust as CSV (default) or JSON. Returns rows written (excluding header).
  exportCsv: (requestId: string, source: ExportSource, path: string, format: ExportFormat = "csv") =>
    invoke<number>("export_csv", { requestId, source, path, format }),

  // History (JSONL, newest first)
  listHistory: (connId: string | null, search: string | null, limit?: number) =>
    invoke<HistoryEntry[]>("list_history", { connId, search, limit: limit ?? null }),
  clearHistory: () => invoke<void>("clear_history"),

  // Sidebar objects: SQL text (definition, or a runnable query plus comments) for an oid from SchemaTree.
  getObjectDefinition: (connId: string, kind: ObjectKind, oid: number) => invoke<string>("get_object_definition", { connId, kind, oid }),
  streamColumns: streamColumnValues,
  editInfo: (connId: string, schema: string, table: string) => invoke<EditInfo>("edit_info", { connId, schema, table }),
  getEditRow: (req: CellRequest) => invoke<EditValue[]>("get_edit_row", { req }),
  reviewEdits: (req: EditRequest) => invoke<string[]>("review_edits", { req }),
  applyEdits: (requestId: string, req: EditRequest) => invoke<number>("apply_edits", { requestId, req }),
  // SQL assist. listColumns: every column of every relation (autocomplete), one catalog query.
  listColumns: (connId: string) => invoke<ColumnRef[]>("list_columns", { connId }),
  /** EXPLAIN (FORMAT JSON) of one statement; `analyze` runs it. Always rolled back. */
  explain: (requestId: string, connId: string, sql: string, analyze: boolean) =>
    invoke<ExplainResult>("explain", { requestId, connId, sql, analyze }),
  setTimeZone: (connId: string, timeZone: string | null) => invoke<ConnProfile[]>("set_time_zone", { connId, timeZone }),
  saveSshSecret: (id: string, passphrase: boolean, value: string | null) => invoke<void>("save_ssh_secret", { id, passphrase, value }),
  testTunnelConnection: (profile: ConnProfile, password: string | null, sshSecret: string | null) => invoke<ServerInfo>("test_tunnel_connection", { profile, password, sshSecret }),
  // v0.3.0 navigation
  /** Foreign keys in any table that point at `schema.table`, multi-column keys included. */
  listReferencing: (connId: string, schema: string, table: string) => invoke<ReferencingKey[]>("list_referencing", { connId, schema, table }),
  // v0.3.0 tools
  /** This connection's saved queries plus the ones saved for all connections, by name. */
  listSavedQueries: (connId: string) => invoke<SavedQuery[]>("list_saved_queries", { connId }),
  /** Insert (id null) or update by id. */
  saveQuery: (query: SavedQueryInput) => invoke<SavedQuery>("save_query", { query }),
  /** Changes only the name; the stored SQL and scope stay as they are. */
  renameSavedQuery: (id: string, name: string) => invoke<SavedQuery>("rename_saved_query", { id, name }),
  deleteSavedQuery: (id: string) => invoke<void>("delete_saved_query", { id }),
  /** pg_stat_activity for the connection's database; Slonview's own session first. */
  listActivity: (connId: string, includeIdle: boolean) => invoke<Activity[]>("list_activity", { connId, includeIdle }),
  /** pg_cancel_backend, or pg_terminate_backend when `terminate` (refused on read-only connections). */
  signalBackend: (connId: string, pid: number, terminate: boolean) => invoke<boolean>("signal_backend", { connId, pid, terminate }),
  appVersion: () => invoke<string>("app_version"),
  /** The only request that leaves the user's servers: GitHub's latest-release API, on demand. */
  checkForUpdates: () => invoke<UpdateStatus>("check_for_updates"),
  /** Opens an http(s) link in the system browser. */
  openUrl: (url: string) => invoke<void>("open_url", { url }),
};

async function streamColumnValues(requestId: string, req: ColumnCopyRequest, onChunk: (chunk: ColumnCopyChunk) => void): Promise<ColumnCopySummary> {
  if (import.meta.env.VITE_BRIDGE === "1") {
    // Dynamic on purpose (as in main.tsx): VITE_BRIDGE is a build-time constant, so production
    // bundles drop the dev-only bridge module entirely.
    const { BRIDGE } = await import("./dev/bridgeBackend");
    const response = await fetch(`${BRIDGE}stream_columns`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId, req }),
    });
    if (!response.ok) throw await response.json();
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        pending += decoder.decode(value, { stream: !done });
        let end: number;
        while ((end = pending.indexOf("\n")) >= 0) {
          const message = JSON.parse(pending.slice(0, end)) as { chunk?: ColumnCopyChunk; done?: ColumnCopySummary; error?: AppError };
          pending = pending.slice(end + 1);
          if (message.error) throw message.error;
          if (message.chunk) onChunk(message.chunk);
          if (message.done) return message.done;
        }
        if (done) throw new Error("Column stream ended without a result");
      }
    } finally { reader.releaseLock(); }
  }
  const onChunkChannel = new Channel<ColumnCopyChunk>(onChunk);
  return invoke<ColumnCopySummary>("stream_columns", { requestId, req, onChunk: onChunkChannel });
}
