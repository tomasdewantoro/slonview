// App state: profiles, the single active connection, schema tree, tabs and per-tab table data.
// Vanilla store + hook so tests can create isolated instances.
import { createStore, type StoreApi } from "zustand/vanilla";
import { useStore } from "zustand";
import { api, errorMessage, isAppError, newRequestId } from "../api";
import type { Column } from "../bindings/Column";
import type { ConnProfile } from "../bindings/ConnProfile";
import type { Cursor } from "../bindings/Cursor";
import type { FunctionInfo } from "../bindings/FunctionInfo";
import type { Relation } from "../bindings/Relation";
import type { SchemaNode } from "../bindings/SchemaNode";
import type { ServerInfo } from "../bindings/ServerInfo";
import { buildPageRequest, filtersToRequest, normalizeRawWhere, type TableQuery } from "./queries";

export type ConnStatus = "connecting" | "connected" | "failed";

export interface ConnState {
  profileId: string;
  status: ConnStatus;
  server: ServerInfo | null;
}

export interface TableTab {
  id: string;
  kind: "table";
  title: string;
  query: TableQuery;
}

export interface StructureTab {
  id: string;
  kind: "structure";
  title: string;
  schema: string;
  table: string;
}

export interface SqlTabInfo {
  id: string;
  kind: "sql";
  title: string;
  initialSql?: string;
}

export type Tab = TableTab | StructureTab | SqlTabInfo;

/** Runtime (non-persisted) state of a table tab. */
export interface TableData {
  columns: Column[];
  rows: (string | null)[][];
  /** Absolute [row, col] indexes of server-truncated cells. */
  truncated: [number, number][];
  nextCursor: Cursor | null;
  /** Id of the latest fetch; responses carrying any other id are dropped. */
  requestId: string | null;
  loading: boolean;
  error: unknown | null;
  cancelled: boolean;
  sql: string;
  elapsedMs: number;
  exactCount: number | null;
  countRequestId: string | null;
  counting: boolean;
  countError: unknown | null;
}

export interface Toast {
  id: number;
  kind: "error" | "info";
  message: string;
}

export interface AppState {
  profiles: ConnProfile[];
  selectedProfileId: string | null;
  conn: ConnState | null;
  tree: SchemaNode[];
  treeLoading: boolean;
  treeError: unknown | null;
  tabs: Tab[];
  activeTabId: string | null;
  tableData: Record<string, TableData>;
  /** Bumped by refresh on structure tabs so the tab refetches. */
  structureNonce: Record<string, number>;
  toasts: Toast[];

  init(): Promise<void>;
  loadProfiles(): Promise<void>;
  saveProfile(profile: ConnProfile, password: string | null | undefined): Promise<void>;
  deleteProfile(id: string): Promise<void>;
  selectProfile(id: string | null): void;
  connect(id: string): Promise<void>;
  disconnect(): Promise<void>;
  loadTree(): Promise<void>;

  openTable(schema: string, table: string): void;
  openStructure(schema: string, table: string): void;
  /** New SQL tab; `title` defaults to "Query N". */
  openSql(initialSql?: string, title?: string): void;
  /** New SQL tab holding the function's definition; errors become a toast. */
  openFunction(fn: FunctionInfo): Promise<void>;
  closeTab(id: string): void;
  activateTab(id: string): void;
  activateTabIndex(index: number): void;
  refreshTab(id: string): void;

  setTableQuery(tabId: string, patch: Partial<Pick<TableQuery, "filters" | "rawWhere" | "sort">>): void;
  ensureLoaded(tabId: string): void;
  loadFirst(tabId: string): Promise<void>;
  loadMore(tabId: string): Promise<void>;
  cancelTable(tabId: string): void;
  countRows(tabId: string): Promise<void>;

  pushToast(kind: Toast["kind"], message: string): void;
  dismissToast(id: number): void;
}

const LAST_CONN_KEY = "slonview.lastConn";
const tabsKey = (connId: string) => `slonview.tabs.${connId}`;

interface PersistedTabs {
  tabs: Tab[];
  activeTabId: string | null;
}

export function emptyTableData(): TableData {
  return {
    columns: [],
    rows: [],
    truncated: [],
    nextCursor: null,
    requestId: null,
    loading: false,
    error: null,
    cancelled: false,
    sql: "",
    elapsedMs: 0,
    exactCount: null,
    countRequestId: null,
    counting: false,
    countError: null,
  };
}

function isTab(t: unknown): t is Tab {
  if (typeof t !== "object" || t === null) return false;
  const o = t as Record<string, unknown>;
  if (typeof o.id !== "string" || typeof o.title !== "string") return false;
  if (o.kind === "table") {
    const q = o.query as Record<string, unknown> | undefined;
    return !!q && typeof q.schema === "string" && typeof q.table === "string" && Array.isArray(q.filters) && Array.isArray(q.sort);
  }
  if (o.kind === "structure") return typeof o.schema === "string" && typeof o.table === "string";
  return o.kind === "sql";
}

export function readPersistedTabs(storage: Storage, connId: string): PersistedTabs {
  try {
    const raw = storage.getItem(tabsKey(connId));
    if (!raw) return { tabs: [], activeTabId: null };
    const parsed = JSON.parse(raw) as Partial<PersistedTabs>;
    const tabs = Array.isArray(parsed.tabs) ? parsed.tabs.filter(isTab) : [];
    const activeTabId = tabs.some((t) => t.id === parsed.activeTabId) ? (parsed.activeTabId as string) : (tabs[0]?.id ?? null);
    return { tabs, activeTabId };
  } catch {
    return { tabs: [], activeTabId: null };
  }
}

/** Tab title for a function: `name(args)`, schema-qualified outside public, args shortened to fit a tab. */
export function functionTitle(fn: Pick<FunctionInfo, "schema" | "name" | "args">, maxArgs = 32): string {
  const args = fn.args.length > maxArgs ? `${fn.args.slice(0, maxArgs - 1).trimEnd()}…` : fn.args;
  return `${relationTitle(fn.schema, fn.name)}(${args})`;
}

export function relationTitle(schema: string, table: string): string {
  return schema === "public" ? table : `${schema}.${table}`;
}

export function findRelation(tree: SchemaNode[], schema: string, table: string): Relation | undefined {
  return tree.find((s) => s.name === schema)?.relations.find((r) => r.name === table);
}

const isCancelled = (e: unknown) => isAppError(e) && e.kind === "cancelled";
const ignore = () => {};

export function createAppStore(storage: Storage = globalThis.localStorage): StoreApi<AppState> {
  let toastSeq = 0;

  return createStore<AppState>()((set, get) => {
    const persistTabs = () => {
      const { conn, tabs, activeTabId } = get();
      if (!conn) return;
      const data: PersistedTabs = { tabs, activeTabId };
      storage.setItem(tabsKey(conn.profileId), JSON.stringify(data));
    };

    const patchData = (tabId: string, patch: Partial<TableData>) =>
      set((s) => {
        const cur = s.tableData[tabId];
        if (!cur) return s;
        return { tableData: { ...s.tableData, [tabId]: { ...cur, ...patch } } };
      });

    const isCurrent = (tabId: string, rid: string) => get().tableData[tabId]?.requestId === rid;

    const tableTab = (tabId: string): TableTab | undefined => {
      const t = get().tabs.find((x) => x.id === tabId);
      return t?.kind === "table" ? t : undefined;
    };

    const connectedId = () => {
      const c = get().conn;
      return c?.status === "connected" ? c.profileId : null;
    };

    const cancelInFlight = (d: TableData | undefined) => {
      if (!d) return;
      if (d.loading && d.requestId) api.cancelQuery(d.requestId).catch(ignore);
      if (d.counting && d.countRequestId) api.cancelQuery(d.countRequestId).catch(ignore);
    };

    const addTab = (tab: Tab) => {
      set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }));
      persistTabs();
    };

    return {
      profiles: [],
      selectedProfileId: null,
      conn: null,
      tree: [],
      treeLoading: false,
      treeError: null,
      tabs: [],
      activeTabId: null,
      tableData: {},
      structureNonce: {},
      toasts: [],

      async init() {
        await get().loadProfiles();
        const last = storage.getItem(LAST_CONN_KEY);
        if (last && get().profiles.some((p) => p.id === last)) {
          set({ selectedProfileId: last });
          await get().connect(last);
        }
      },

      async loadProfiles() {
        try {
          const profiles = await api.listProfiles();
          set({ profiles });
        } catch (e) {
          get().pushToast("error", `Couldn't load saved connections: ${errorMessage(e)}`);
        }
      },

      async saveProfile(profile, password) {
        const profiles = await api.saveProfile(profile, password);
        set({ profiles, selectedProfileId: profile.id });
      },

      async deleteProfile(id) {
        if (get().conn?.profileId === id) await get().disconnect();
        const profiles = await api.deleteProfile(id);
        storage.removeItem(tabsKey(id));
        set((s) => ({ profiles, selectedProfileId: s.selectedProfileId === id ? null : s.selectedProfileId }));
      },

      selectProfile(id) {
        set({ selectedProfileId: id });
      },

      async connect(id) {
        const prev = get().conn;
        if (prev?.profileId === id && prev.status !== "failed") return;
        if (prev) {
          Object.values(get().tableData).forEach(cancelInFlight);
          if (prev.status === "connected") api.disconnect(prev.profileId).catch(ignore);
        }
        set({
          conn: { profileId: id, status: "connecting", server: null },
          selectedProfileId: id,
          tree: [],
          treeError: null,
          tabs: [],
          activeTabId: null,
          tableData: {},
          structureNonce: {},
        });
        try {
          const server = await api.connect(id);
          if (get().conn?.profileId !== id) return;
          const restored = readPersistedTabs(storage, id);
          set({ conn: { profileId: id, status: "connected", server }, ...restored });
          storage.setItem(LAST_CONN_KEY, id);
          await get().loadTree();
        } catch (e) {
          if (get().conn?.profileId !== id) return;
          set({ conn: { profileId: id, status: "failed", server: null } });
          const name = get().profiles.find((p) => p.id === id)?.name ?? "connection";
          get().pushToast("error", `Couldn't connect to ${name}: ${errorMessage(e)}`);
        }
      },

      async disconnect() {
        const prev = get().conn;
        if (!prev) return;
        Object.values(get().tableData).forEach(cancelInFlight);
        set({ conn: null, tree: [], treeError: null, tabs: [], activeTabId: null, tableData: {}, structureNonce: {} });
        storage.removeItem(LAST_CONN_KEY);
        if (prev.status === "connected") {
          try {
            await api.disconnect(prev.profileId);
          } catch (e) {
            get().pushToast("error", `Disconnect failed: ${errorMessage(e)}`);
          }
        }
      },

      async loadTree() {
        const connId = connectedId();
        if (!connId) return;
        set({ treeLoading: true, treeError: null });
        try {
          const tree = await api.listSchemaTree(connId);
          if (connectedId() === connId) set({ tree, treeLoading: false });
        } catch (e) {
          if (connectedId() === connId) set({ treeError: e, treeLoading: false });
        }
      },

      openTable(schema, table) {
        const existing = get().tabs.find((t) => t.kind === "table" && t.query.schema === schema && t.query.table === table);
        if (existing) return get().activateTab(existing.id);
        addTab({
          id: newRequestId(),
          kind: "table",
          title: relationTitle(schema, table),
          query: { schema, table, filters: [], rawWhere: "", sort: [] },
        });
      },

      openStructure(schema, table) {
        const existing = get().tabs.find((t) => t.kind === "structure" && t.schema === schema && t.table === table);
        if (existing) return get().activateTab(existing.id);
        addTab({ id: newRequestId(), kind: "structure", title: relationTitle(schema, table), schema, table });
      },

      openSql(initialSql, title) {
        if (!connectedId()) return;
        const n = get().tabs.filter((t) => t.kind === "sql").length + 1;
        addTab({ id: newRequestId(), kind: "sql", title: title ?? `Query ${n}`, initialSql });
      },

      async openFunction(fn) {
        const connId = connectedId();
        if (!connId) return;
        try {
          const sql = await api.getFunctionDefinition(connId, fn.oid);
          if (connectedId() === connId) get().openSql(sql, functionTitle(fn));
        } catch (e) {
          if (connectedId() === connId) get().pushToast("error", `Couldn't load the definition of ${fn.name}: ${errorMessage(e)}`);
        }
      },

      closeTab(id) {
        const { tabs, activeTabId, tableData } = get();
        const idx = tabs.findIndex((t) => t.id === id);
        if (idx < 0) return;
        cancelInFlight(tableData[id]);
        const nextTabs = tabs.filter((t) => t.id !== id);
        const nextActive = activeTabId === id ? (nextTabs[Math.min(idx, nextTabs.length - 1)]?.id ?? null) : activeTabId;
        const { [id]: _dropped, ...rest } = tableData;
        set({ tabs: nextTabs, activeTabId: nextActive, tableData: rest });
        persistTabs();
      },

      activateTab(id) {
        if (!get().tabs.some((t) => t.id === id)) return;
        set({ activeTabId: id });
        persistTabs();
      },

      activateTabIndex(index) {
        const t = get().tabs[index];
        if (t) get().activateTab(t.id);
      },

      refreshTab(id) {
        const tab = get().tabs.find((t) => t.id === id);
        if (tab?.kind === "table") void get().loadFirst(id);
        if (tab?.kind === "structure") set((s) => ({ structureNonce: { ...s.structureNonce, [id]: (s.structureNonce[id] ?? 0) + 1 } }));
      },

      setTableQuery(tabId, patch) {
        set((s) => ({
          tabs: s.tabs.map((t) => (t.id === tabId && t.kind === "table" ? { ...t, query: { ...t.query, ...patch } } : t)),
        }));
        persistTabs();
        void get().loadFirst(tabId);
      },

      ensureLoaded(tabId) {
        if (!get().tableData[tabId]) void get().loadFirst(tabId);
      },

      async loadFirst(tabId) {
        const tab = tableTab(tabId);
        const connId = connectedId();
        if (!tab || !connId) return;
        const prev = get().tableData[tabId];
        if (prev?.loading && prev.requestId) api.cancelQuery(prev.requestId).catch(ignore);
        if (prev?.counting && prev.countRequestId) api.cancelQuery(prev.countRequestId).catch(ignore);
        const rid = newRequestId();
        set((s) => ({
          tableData: {
            ...s.tableData,
            [tabId]: { ...emptyTableData(), columns: prev?.columns ?? [], requestId: rid, loading: true },
          },
        }));
        try {
          const page = await api.fetchPage(rid, buildPageRequest(connId, tab.query, null));
          if (!isCurrent(tabId, rid)) return;
          patchData(tabId, {
            columns: page.columns,
            rows: page.rows,
            truncated: page.truncated,
            nextCursor: page.nextCursor,
            sql: page.sql,
            elapsedMs: page.elapsedMs,
            loading: false,
          });
        } catch (e) {
          if (!isCurrent(tabId, rid)) return;
          patchData(tabId, { loading: false, error: isCancelled(e) ? null : e, cancelled: isCancelled(e) });
        }
      },

      async loadMore(tabId) {
        const tab = tableTab(tabId);
        const connId = connectedId();
        const d = get().tableData[tabId];
        if (!tab || !connId || !d || d.loading || d.error || !d.nextCursor) return;
        const rid = newRequestId();
        const base = d.rows.length;
        patchData(tabId, { requestId: rid, loading: true, cancelled: false });
        try {
          const page = await api.fetchPage(rid, buildPageRequest(connId, tab.query, d.nextCursor));
          if (!isCurrent(tabId, rid)) return;
          const cur = get().tableData[tabId];
          patchData(tabId, {
            rows: cur.rows.concat(page.rows),
            truncated: page.truncated.length
              ? cur.truncated.concat(page.truncated.map(([r, c]): [number, number] => [r + base, c]))
              : cur.truncated,
            nextCursor: page.nextCursor,
            sql: page.sql,
            elapsedMs: page.elapsedMs,
            loading: false,
          });
        } catch (e) {
          if (!isCurrent(tabId, rid)) return;
          patchData(tabId, { loading: false, error: isCancelled(e) ? null : e, cancelled: isCancelled(e) });
        }
      },

      cancelTable(tabId) {
        const d = get().tableData[tabId];
        if (!d?.loading || !d.requestId) return;
        api.cancelQuery(d.requestId).catch(ignore);
        // Drop whatever the cancelled request eventually returns.
        patchData(tabId, { loading: false, requestId: null, cancelled: true });
      },

      async countRows(tabId) {
        const tab = tableTab(tabId);
        const connId = connectedId();
        const d = get().tableData[tabId];
        if (!tab || !connId || !d) return;
        if (d.counting && d.countRequestId) api.cancelQuery(d.countRequestId).catch(ignore);
        const rid = newRequestId();
        patchData(tabId, { countRequestId: rid, counting: true, countError: null });
        const q = tab.query;
        try {
          const n = await api.countExact(rid, connId, q.schema, q.table, filtersToRequest(q.filters), normalizeRawWhere(q.rawWhere));
          if (get().tableData[tabId]?.countRequestId !== rid) return;
          patchData(tabId, { exactCount: n, counting: false });
        } catch (e) {
          if (get().tableData[tabId]?.countRequestId !== rid) return;
          patchData(tabId, { counting: false, countError: isCancelled(e) ? null : e });
        }
      },

      pushToast(kind, message) {
        const id = ++toastSeq;
        set((s) => ({ toasts: [...s.toasts, { id, kind, message }] }));
      },

      dismissToast(id) {
        set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
      },
    };
  });
}

export const appStore = createAppStore();

export function useApp<T>(selector: (s: AppState) => T): T {
  return useStore(appStore, selector);
}
