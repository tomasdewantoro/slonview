// App state: profiles, every open connection (each with its own schema tree), one tab strip
// holding the tabs of all open connections, and per-tab table data.
// Vanilla store + hook so tests can create isolated instances.
import { createStore, type StoreApi } from "zustand/vanilla";
import { useStore } from "zustand";
import { api, errorMessage, isAppError, newRequestId } from "../api";
import type { Column } from "../bindings/Column";
import type { ConnProfile } from "../bindings/ConnProfile";
import type { Cursor } from "../bindings/Cursor";
import type { ExtensionInfo } from "../bindings/ExtensionInfo";
import type { FunctionInfo } from "../bindings/FunctionInfo";
import type { ForeignKeyTarget } from "../bindings/ForeignKeyTarget";
import type { ObjectKind } from "../bindings/ObjectKind";
import type { SchemaNode } from "../bindings/SchemaNode";
import type { ServerInfo } from "../bindings/ServerInfo";
import { buildPageRequest, filtersToRequest, normalizeRawWhere, type TableQuery } from "./queries";
import type { ReferencingKey } from "../bindings/ReferencingKey";

export type ConnStatus = "connecting" | "connected" | "failed";

/** One open connection (keyed by profile id): its session state and its schema tree. */
export interface ConnState {
  profileId: string;
  status: ConnStatus;
  server: ServerInfo | null;
  tree: SchemaNode[];
  treeLoading: boolean;
  treeError: unknown | null;
  /** Installed extensions, loaded with the tree. */
  extensions: ExtensionInfo[];
  /** This connection's most recently active tab; restored when the connection is switched to. */
  activeTabId: string | null;
}

/** How a sidebar item opens: a preview tab (replaced by the next preview) or a pinned one. */
export type OpenMode = "preview" | "pinned";

interface TabBase {
  id: string;
  title: string;
  /** Profile id of the connection the tab belongs to; every request from the tab uses it. */
  connId: string;
  /** Preview tab (VS Code model): at most one per connection; the next preview open replaces it. */
  preview: boolean;
}

export interface TableTab extends TabBase {
  kind: "table";
  query: TableQuery;
}

export interface StructureTab extends TabBase {
  kind: "structure";
  schema: string;
  table: string;
}

export interface SqlTabInfo extends TabBase {
  kind: "sql";
  initialSql?: string;
  /** Object the tab shows (`fn:<oid>`, `obj:<kind>:<oid>`); a repeat open activates it instead of refetching. */
  source?: string;
  /** Saved query the tab was opened from or last saved as; ⌘S updates it in place. */
  savedQueryId?: string;
}

/** Server activity (pg_stat_activity) of the tab's connection; at most one per connection. */
export interface ActivityTab extends TabBase {
  kind: "activity";
}

export type Tab = TableTab | StructureTab | SqlTabInfo | ActivityTab;

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
  /** Estimated rows matching the current query, from the first page; null = unknown or all loaded. */
  estRows: number | null;
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
  /** Open connections in the order they were opened. */
  conns: Record<string, ConnState>;
  /** Connection the sidebar shows; follows the active tab. */
  activeConnId: string | null;
  /** Sidebar shows the saved-connection list ("Open another connection…") instead of the schema tree. */
  connectionPicker: boolean;
  /** Tabs of every open connection, in strip order. */
  tabs: Tab[];
  activeTabId: string | null;
  tableData: Record<string, TableData>;
  /** Bumped by refresh on structure and activity tabs so the tab refetches. */
  structureNonce: Record<string, number>;
  toasts: Toast[];

  /** Loads profiles and reopens the connections that were open last time. */
  init(): Promise<void>;
  loadProfiles(): Promise<void>;
  saveProfile(profile: ConnProfile, password: string | null | undefined): Promise<void>;
  deleteProfile(id: string): Promise<void>;
  selectProfile(id: string | null): void;
  /** Opens a connection next to the others and shows it in the sidebar; an open one is only switched to. */
  connect(id: string): Promise<void>;
  /** Closes one connection (default: the sidebar's) and its tabs; the tabs stay saved for the next connect. */
  disconnect(id?: string): Promise<void>;
  /** Shows a connection in the sidebar and activates its last active tab. */
  setActiveConn(id: string): void;
  setConnectionPicker(open: boolean): void;
  /** Reloads a connection's schema tree (default: the sidebar's). */
  loadTree(connId?: string): Promise<void>;
  /** Sets a connection's session time zone and reloads its table tabs. */
  setTimeZone(connId: string, timeZone: string | null): Promise<void>;

  /** Sidebar opens (on the sidebar's connection) take a mode; explicit commands default to pinned. */
  openTable(schema: string, table: string, mode?: OpenMode): void;
  /**
   * Opens rows of a relation filtered to `column = value`, as a pinned table tab on `connId`
   * (following a foreign key from a cell, or listing the rows that reference one). A tab already
   * showing exactly that filter is reused; other tabs of the relation are left untouched.
   */
  openRowsWhere(connId: string, target: ForeignKeyTarget, value: string): void;
  openStructure(schema: string, table: string, mode?: OpenMode): void;
  /** New pinned SQL tab on the sidebar's connection; `title` defaults to "Query N". */
  openSql(initialSql?: string, title?: string): void;
  /** SQL tab holding the function's definition (one fetch per function at a time); errors become a toast. */
  openFunction(fn: FunctionInfo, mode?: OpenMode): Promise<void>;
  /** SQL tab holding a sequence/type/trigger/extension definition; errors become a toast. */
  openObject(kind: ObjectKind, oid: number, name: string, title: string, mode?: OpenMode): Promise<void>;
  /** Turns a preview tab into a normal one, in place. No-op for pinned tabs. */
  pinTab(id: string): void;
  closeTab(id: string): void;
  /** Activates a tab and switches the sidebar to the tab's connection. */
  activateTab(id: string): void;
  activateTabIndex(index: number): void;
  refreshTab(id: string): void;

  setTableQuery(tabId: string, patch: Partial<Pick<TableQuery, "filters" | "rawWhere" | "search" | "sort">>): void;
  ensureLoaded(tabId: string): void;
  loadFirst(tabId: string): Promise<void>;
  loadMore(tabId: string): Promise<void>;
  cancelTable(tabId: string): void;
  countRows(tabId: string): Promise<void>;

  pushToast(kind: Toast["kind"], message: string): void;
  dismissToast(id: number): void;

  // v0.3.0 navigation
  /** Foreign keys pointing at a relation, by `referencingCacheKey`; loaded once per relation. */
  referencing: Record<string, ReferencingState>;
  /** Loads the keys pointing at `schema.table` unless they are cached or loading. */
  loadReferencing(connId: string, schema: string, table: string, force?: boolean): void;
  // v0.3.0 tools
  /** Opens (or activates) the Activity tab of a connection (default: the sidebar's), pinned. */
  openActivity(connId?: string): void;
  /** New pinned SQL tab on the sidebar's connection holding a saved query, titled with its name. */
  openSavedQuery(query: { id: string; name: string; sql: string }): void;
  /** Links a SQL tab to saved query `saved` (its title follows the name), or unlinks it (null: the query was deleted). */
  setTabSavedQuery(tabId: string, saved: { id: string; name: string } | null): void;
}

/** `seq` identifies the load, so a response from before a sidebar refresh can't land on a newer load. */
export type ReferencingState = { status: "loading"; seq: number } | { status: "ok"; keys: ReferencingKey[] } | { status: "error"; error: unknown };

export const referencingCacheKey = (connId: string, schema: string, table: string) => `${connId}\u0000${schema}\u0000${table}`;

/** Connections to reopen on start: `{ ids, active }`. */
const OPEN_CONNS_KEY = "slonview.openConns";
/** Single last connection, written before several connections could be open. Read once, then removed. */
const LEGACY_LAST_CONN_KEY = "slonview.lastConn";
const tabsKey = (connId: string) => `slonview.tabs.${connId}`;

interface PersistedTabs {
  tabs: Tab[];
  activeTabId: string | null;
}

interface PersistedConns {
  ids: string[];
  active: string | null;
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
    estRows: null,
    exactCount: null,
    countRequestId: null,
    counting: false,
    countError: null,
  };
}

function isTab(t: unknown): t is Omit<Tab, "connId"> {
  if (typeof t !== "object" || t === null) return false;
  const o = t as Record<string, unknown>;
  if (typeof o.id !== "string" || typeof o.title !== "string") return false;
  if (o.kind === "table") {
    const q = o.query as Record<string, unknown> | undefined;
    return !!q && typeof q.schema === "string" && typeof q.table === "string" && Array.isArray(q.filters) && Array.isArray(q.sort);
  }
  if (o.kind === "structure") return typeof o.schema === "string" && typeof o.table === "string";
  return o.kind === "sql" || o.kind === "activity";
}

/**
 * Tabs saved for a connection. Every tab gets `connId` set to the connection it was saved under
 * (the storage key), so tabs saved before several connections could be open load correctly.
 */
export function readPersistedTabs(storage: Storage, connId: string): PersistedTabs {
  try {
    const raw = storage.getItem(tabsKey(connId));
    if (!raw) return { tabs: [], activeTabId: null };
    const parsed = JSON.parse(raw) as { tabs?: unknown; activeTabId?: unknown };
    // Tabs saved before preview tabs existed have no flag and load pinned; at most one stays a preview.
    let previewSeen = false;
    const tabs = (Array.isArray(parsed.tabs) ? parsed.tabs.filter(isTab) : []).map((t): Tab => {
      const preview = t.preview === true && !previewSeen;
      previewSeen ||= preview;
      return { ...t, connId, preview } as Tab;
    });
    const activeTabId = tabs.some((t) => t.id === parsed.activeTabId) ? (parsed.activeTabId as string) : (tabs[0]?.id ?? null);
    return { tabs, activeTabId };
  } catch {
    return { tabs: [], activeTabId: null };
  }
}

/** Connections that were open last time, oldest first, and the one the sidebar showed. */
export function readPersistedConns(storage: Storage): PersistedConns {
  try {
    const raw = storage.getItem(OPEN_CONNS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PersistedConns>;
      const ids = Array.isArray(parsed.ids) ? parsed.ids.filter((x): x is string => typeof x === "string") : [];
      return { ids, active: typeof parsed.active === "string" && ids.includes(parsed.active) ? parsed.active : (ids[ids.length - 1] ?? null) };
    }
  } catch {
    // Fall through to the legacy key.
  }
  const last = storage.getItem(LEGACY_LAST_CONN_KEY);
  return last ? { ids: [last], active: last } : { ids: [], active: null };
}

/** localStorage key of a SQL tab's editor text. */
export const sqlEditorKey = (tabId: string) => `slonview.sql.${tabId}`;

/** Tabs closed or replaced this session. Their editors must not write text back on unmount. */
const disposedTabs = new Set<string>();
export function wasTabDisposed(tabId: string): boolean {
  return disposedTabs.has(tabId);
}

/** Tab title for a function: `name(args)`, schema-qualified outside public, args shortened to fit a tab. */
export function functionTitle(fn: Pick<FunctionInfo, "schema" | "name" | "args">, maxArgs = 32): string {
  const args = fn.args.length > maxArgs ? `${fn.args.slice(0, maxArgs - 1).trimEnd()}…` : fn.args;
  return `${relationTitle(fn.schema, fn.name)}(${args})`;
}

export function relationTitle(schema: string, table: string): string {
  return schema === "public" ? table : `${schema}.${table}`;
}

/** Connection state of a tab, or undefined when the tab is gone or its connection closed. */
export function tabConn(s: Pick<AppState, "conns">, tab: Pick<Tab, "connId"> | undefined): ConnState | undefined {
  return tab ? s.conns[tab.connId] : undefined;
}

/** True unless the tab's own session reports writes allowed: each tab follows its connection's mode. */
export function tabReadOnly(s: Pick<AppState, "conns">, tab: Pick<Tab, "connId">): boolean {
  return tabConn(s, tab)?.server?.readOnly !== false;
}

export function activeTab(s: Pick<AppState, "tabs" | "activeTabId">): Tab | undefined {
  return s.tabs.find((t) => t.id === s.activeTabId);
}

/** Connection the status bar describes: the active tab's, else the sidebar's. */
export function statusConnId(s: Pick<AppState, "tabs" | "activeTabId" | "activeConnId">): string | null {
  return activeTab(s)?.connId ?? s.activeConnId;
}

const isCancelled = (e: unknown) => isAppError(e) && e.kind === "cancelled";
const ignore = () => {};

export function createAppStore(storage: Storage = globalThis.localStorage): StoreApi<AppState> {
  let toastSeq = 0;
  let referencingSeq = 0;

  return createStore<AppState>()((set, get) => {
    const persistTabs = (connId: string) => {
      const conn = get().conns[connId];
      if (conn?.status !== "connected") return;
      const data: PersistedTabs = { tabs: get().tabs.filter((t) => t.connId === connId), activeTabId: conn.activeTabId };
      storage.setItem(tabsKey(connId), JSON.stringify(data));
    };

    const persistConns = () => {
      const { conns, activeConnId } = get();
      // A failed connection stays listed (with its error) but is not retried on the next start.
      const ids = Object.values(conns).filter((c) => c.status !== "failed").map((c) => c.profileId);
      const data: PersistedConns = { ids, active: activeConnId && ids.includes(activeConnId) ? activeConnId : (ids[ids.length - 1] ?? null) };
      storage.setItem(OPEN_CONNS_KEY, JSON.stringify(data));
      storage.removeItem(LEGACY_LAST_CONN_KEY);
    };

    const patchConn = (connId: string, patch: Partial<ConnState>) =>
      set((s) => {
        const cur = s.conns[connId];
        if (!cur) return s;
        return { conns: { ...s.conns, [connId]: { ...cur, ...patch } } };
      });

    /** Makes `tabId` the active tab (or clears it), recording it as its connection's last active tab and showing that connection. */
    const focusTab = (tabId: string | null) => {
      const tab = get().tabs.find((t) => t.id === tabId);
      if (!tab) {
        set({ activeTabId: null });
        return;
      }
      set((s) => ({
        activeTabId: tab.id,
        activeConnId: tab.connId,
        connectionPicker: false,
        selectedProfileId: tab.connId,
        conns: s.conns[tab.connId] ? { ...s.conns, [tab.connId]: { ...s.conns[tab.connId], activeTabId: tab.id } } : s.conns,
      }));
      persistTabs(tab.connId);
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

    const isConnected = (connId: string | null | undefined): connId is string => !!connId && get().conns[connId]?.status === "connected";

    /** The sidebar's connection when it is connected: target of sidebar opens and new SQL tabs. */
    const sidebarConnId = () => {
      const id = get().activeConnId;
      return isConnected(id) ? id : null;
    };

    const cancelInFlight = (d: TableData | undefined) => {
      if (!d) return;
      if (d.loading && d.requestId) api.cancelQuery(d.requestId).catch(ignore);
      if (d.counting && d.countRequestId) api.cancelQuery(d.countRequestId).catch(ignore);
    };

    /** Cancels a tab's requests and forgets its editor text; returns tableData without it. Shared by close and preview replacement. */
    const disposeTab = (id: string): Record<string, TableData> => {
      const { [id]: dropped, ...rest } = get().tableData;
      cancelInFlight(dropped);
      storage.removeItem(sqlEditorKey(id));
      disposedTabs.add(id);
      return rest;
    };

    /** Explicit new tab (Cmd+T, New SQL query): pinned, at the end. */
    const addTab = (tab: Tab) => {
      set((s) => ({ tabs: [...s.tabs, tab] }));
      focusTab(tab.id);
    };

    /** Bumped by every preview open, so a slow definition fetch can tell a newer preview superseded it. */
    let previewSeq = 0;

    /**
     * Opens a sidebar item of `connId` (VS Code preview model). An open tab for the item is
     * activated, and pinned when `mode` is pinned. Otherwise a preview open replaces that
     * connection's preview tab in place; with no preview tab, the new tab goes right after the
     * active one.
     */
    const openItem = (connId: string, matches: (t: Tab) => boolean, make: (id: string) => Tab, mode: OpenMode) => {
      if (mode === "preview") previewSeq++;
      const { tabs, activeTabId } = get();
      const existing = tabs.find((t) => t.connId === connId && matches(t));
      if (existing) {
        if (mode === "pinned" && existing.preview) set({ tabs: tabs.map((t) => (t === existing ? { ...t, preview: false } : t)) });
        focusTab(existing.id);
        return;
      }
      const tab: Tab = { ...make(newRequestId()), connId, preview: mode === "preview" };
      const previewIdx = mode === "preview" ? tabs.findIndex((t) => t.connId === connId && t.preview) : -1;
      if (previewIdx >= 0) {
        const tableData = disposeTab(tabs[previewIdx].id);
        set({ tabs: tabs.map((t, i) => (i === previewIdx ? tab : t)), tableData });
      } else {
        const at = tabs.findIndex((t) => t.id === activeTabId) + 1 || tabs.length;
        set({ tabs: [...tabs.slice(0, at), tab, ...tabs.slice(at)] });
      }
      focusTab(tab.id);
    };

    /** In-flight definition fetches by `connId\0source`. `pinned` records a double-click that arrived meanwhile; `seq` the latest preview open of it. */
    const definitionLoads = new Map<string, { pinned: boolean; seq: number; done: Promise<void> }>();

    /** Opens an object's definition as a SQL tab keyed by `source`; one fetch per source at a time. */
    const openDefinition = (source: string, title: string, name: string, mode: OpenMode, fetch: (connId: string) => Promise<string>): Promise<void> => {
      const connId = sidebarConnId();
      if (!connId) return Promise.resolve();
      const matches = (t: Tab) => t.kind === "sql" && t.source === source;
      const open = get().tabs.find((t) => t.connId === connId && matches(t));
      if (open) {
        openItem(connId, matches, () => open, mode);
        return Promise.resolve();
      }
      if (mode === "preview") previewSeq++;
      const key = `${connId}\u0000${source}`;
      const inflight = definitionLoads.get(key);
      if (inflight) {
        if (mode === "pinned") inflight.pinned = true;
        else inflight.seq = previewSeq;
        return inflight.done;
      }
      const entry = { pinned: mode === "pinned", seq: previewSeq, done: Promise.resolve() };
      definitionLoads.set(key, entry);
      entry.done = (async () => {
        try {
          const sql = await fetch(connId);
          if (!isConnected(connId)) return;
          // A newer preview open (another item clicked meanwhile) wins over this one; a pending pin always opens.
          if (!entry.pinned && entry.seq !== previewSeq) return;
          openItem(connId, matches, (id) => ({ id, kind: "sql", title, initialSql: sql, source, connId, preview: false }), entry.pinned ? "pinned" : "preview");
        } catch (e) {
          if (isConnected(connId)) get().pushToast("error", `Couldn't load the definition of ${name}: ${errorMessage(e)}`);
        } finally {
          definitionLoads.delete(key);
        }
      })();
      return entry.done;
    };

    /** Latest connect attempt per connection; a response for an older attempt is stale. */
    const connectAttempts = new Map<string, number>();
    let attemptSeq = 0;

    /** Opens a connection; `activate` shows it in the sidebar (otherwise only when nothing else is shown). */
    const openConn = async (id: string, activate: boolean) => {
      const prev = get().conns[id];
      if (prev && prev.status !== "failed") {
        if (activate) get().setActiveConn(id);
        return;
      }
      const attempt = ++attemptSeq;
      connectAttempts.set(id, attempt);
      const show = activate || !get().activeConnId || get().activeConnId === id;
      set((s) => ({
        conns: {
          ...s.conns,
          [id]: { profileId: id, status: "connecting", server: null, tree: [], treeLoading: false, treeError: null, extensions: [], activeTabId: null },
        },
        ...(show ? { activeConnId: id, selectedProfileId: id, connectionPicker: false, activeTabId: null } : {}),
      }));
      persistConns();
      const current = () => connectAttempts.get(id) === attempt && get().conns[id]?.status === "connecting";
      try {
        const server = await api.connect(id);
        if (!current()) {
          // Disconnected (or reconnected) while connecting: close the session this attempt opened.
          if (!get().conns[id]) api.disconnect(id).catch(ignore);
          return;
        }
        const restored = readPersistedTabs(storage, id);
        set((s) => {
          // Keep the strip grouped in connection order: restored tabs go before the tabs of later connections.
          const order = Object.keys(s.conns);
          const rank = order.indexOf(id);
          const at = s.tabs.findIndex((t) => order.indexOf(t.connId) > rank);
          const tabs = at < 0 ? [...s.tabs, ...restored.tabs] : [...s.tabs.slice(0, at), ...restored.tabs, ...s.tabs.slice(at)];
          return {
            tabs,
            conns: { ...s.conns, [id]: { ...s.conns[id], status: "connected", server, activeTabId: restored.activeTabId } },
            ...(s.activeConnId === id && !activeTab(s) ? { activeTabId: restored.activeTabId } : {}),
          };
        });
        await get().loadTree(id);
      } catch (e) {
        if (!current()) return;
        patchConn(id, { status: "failed" });
        persistConns();
        const name = get().profiles.find((p) => p.id === id)?.name ?? "connection";
        get().pushToast("error", `Couldn't connect to ${name}: ${errorMessage(e)}`);
      }
    };

    return {
      profiles: [],
      selectedProfileId: null,
      conns: {},
      activeConnId: null,
      connectionPicker: false,
      tabs: [],
      activeTabId: null,
      tableData: {},
      structureNonce: {},
      toasts: [],
      referencing: {},

      async init() {
        await get().loadProfiles();
        const { ids, active } = readPersistedConns(storage);
        const known = ids.filter((id) => get().profiles.some((p) => p.id === id));
        if (known.length === 0) return;
        const shown = active && known.includes(active) ? active : known[known.length - 1];
        // Register every connection first, in saved order, so restored tabs keep that order.
        await Promise.all(known.map((id) => openConn(id, id === shown)));
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

      async setTimeZone(connId, timeZone) {
        if (!isConnected(connId)) return;
        const profiles = await api.setTimeZone(connId, timeZone);
        if (!isConnected(connId)) return;
        set({ profiles });
        // Reload this connection's table tabs in the background; the picker shouldn't wait on slow pages.
        for (const tab of get().tabs) if (tab.kind === "table" && tab.connId === connId) void get().loadFirst(tab.id);
      },

      async deleteProfile(id) {
        if (get().conns[id]) await get().disconnect(id);
        const profiles = await api.deleteProfile(id);
        storage.removeItem(tabsKey(id));
        set((s) => ({ profiles, selectedProfileId: s.selectedProfileId === id ? null : s.selectedProfileId }));
      },

      selectProfile(id) {
        set({ selectedProfileId: id });
      },

      connect(id) {
        return openConn(id, true);
      },

      async disconnect(id) {
        const connId = id ?? get().activeConnId;
        const prev = connId ? get().conns[connId] : undefined;
        if (!connId || !prev) return;
        connectAttempts.delete(connId);
        const { tabs, tableData, structureNonce, activeTabId, activeConnId, conns } = get();
        // Its tabs close like closeTab (requests cancelled, data dropped) but stay saved for the next connect.
        const closing = new Set(tabs.filter((t) => t.connId === connId).map((t) => t.id));
        for (const tabId of closing) cancelInFlight(tableData[tabId]);
        const { [connId]: _closed, ...rest } = conns;
        const remainingTabs = tabs.filter((t) => !closing.has(t.id));
        const keepActiveTab = activeTabId !== null && !closing.has(activeTabId);
        const nextConn = activeConnId === connId ? (keepActiveTab ? remainingTabs.find((t) => t.id === activeTabId)!.connId : (Object.keys(rest).pop() ?? null)) : activeConnId;
        const nextTab = keepActiveTab
          ? activeTabId
          : nextConn
            ? (rest[nextConn].activeTabId ?? remainingTabs.find((t) => t.connId === nextConn)?.id ?? null)
            : null;
        set({
          conns: rest,
          activeConnId: nextConn,
          tabs: remainingTabs,
          activeTabId: nextTab,
          tableData: Object.fromEntries(Object.entries(tableData).filter(([k]) => !closing.has(k))),
          structureNonce: Object.fromEntries(Object.entries(structureNonce).filter(([k]) => !closing.has(k))),
          referencing: Object.fromEntries(Object.entries(get().referencing).filter(([k]) => !k.startsWith(`${connId}\u0000`))),
        });
        if (nextTab) focusTab(nextTab);
        persistConns();
        if (prev.status === "connected") {
          try {
            await api.disconnect(connId);
          } catch (e) {
            get().pushToast("error", `Disconnect failed: ${errorMessage(e)}`);
          }
        }
      },

      setActiveConn(id) {
        const conn = get().conns[id];
        if (!conn) return;
        const tabId = conn.activeTabId ?? get().tabs.find((t) => t.connId === id)?.id ?? null;
        set({ activeConnId: id, selectedProfileId: id, connectionPicker: false });
        if (tabId) focusTab(tabId);
        else set({ activeTabId: null });
        persistConns();
      },

      setConnectionPicker(open) {
        set({ connectionPicker: open });
      },

      async loadTree(id) {
        const connId = id ?? get().activeConnId;
        if (!isConnected(connId)) return;
        patchConn(connId, { treeLoading: true, treeError: null });
        // A sidebar refresh also forgets cached foreign keys: the schema may have changed.
        set((s) => ({ referencing: Object.fromEntries(Object.entries(s.referencing).filter(([k]) => !k.startsWith(`${connId}\u0000`))) }));
        try {
          const { schemas, extensions } = await api.listSchemaTree(connId);
          if (isConnected(connId)) patchConn(connId, { tree: schemas, extensions, treeLoading: false });
        } catch (e) {
          if (isConnected(connId)) patchConn(connId, { treeError: e, treeLoading: false });
        }
      },

      openTable(schema, table, mode = "pinned") {
        const connId = sidebarConnId();
        if (!connId) return;
        openItem(
          connId,
          (t) => t.kind === "table" && t.query.schema === schema && t.query.table === table,
          (id) => ({ id, kind: "table", title: relationTitle(schema, table), query: { schema, table, filters: [], rawWhere: "", sort: [] }, connId, preview: false }),
          mode,
        );
      },

      openRowsWhere(connId, target, value) {
        if (!isConnected(connId)) return;
        const { schema, table, column } = target;
        // A tab already showing exactly this row is reused. Any other tab of the relation is left
        // alone (it may hold the user's own filters or pending edits); a new one opens beside it.
        const isThisRow = (t: Tab) =>
          t.kind === "table" &&
          t.query.schema === schema &&
          t.query.table === table &&
          !t.query.rawWhere.trim() &&
          t.query.filters.length === 1 &&
          t.query.filters[0].column === column &&
          t.query.filters[0].op === "=" &&
          t.query.filters[0].value === value;
        openItem(
          connId,
          isThisRow,
          (id) => ({
            id,
            kind: "table",
            title: relationTitle(schema, table),
            query: { schema, table, filters: [{ id: newRequestId(), column, op: "=", value }], rawWhere: "", sort: [] },
            connId,
            preview: false,
          }),
          "pinned",
        );
        persistTabs(connId);
      },

      openStructure(schema, table, mode = "pinned") {
        const connId = sidebarConnId();
        if (!connId) return;
        openItem(
          connId,
          (t) => t.kind === "structure" && t.schema === schema && t.table === table,
          (id) => ({ id, kind: "structure", title: relationTitle(schema, table), schema, table, connId, preview: false }),
          mode,
        );
      },

      openSql(initialSql, title) {
        const connId = sidebarConnId();
        if (!connId) return;
        const n = get().tabs.filter((t) => t.kind === "sql" && t.connId === connId).length + 1;
        addTab({ id: newRequestId(), kind: "sql", title: title ?? `Query ${n}`, initialSql, connId, preview: false });
      },

      openFunction(fn, mode = "pinned") {
        return openDefinition(`fn:${fn.oid}`, functionTitle(fn), fn.name, mode, (connId) => api.getFunctionDefinition(connId, fn.oid));
      },

      openObject(kind, oid, name, title, mode = "pinned") {
        return openDefinition(`obj:${kind}:${oid}`, title, name, mode, (connId) => api.getObjectDefinition(connId, kind, oid));
      },

      pinTab(id) {
        const tab = get().tabs.find((t) => t.id === id && t.preview);
        if (!tab) return;
        set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, preview: false } : t)) }));
        persistTabs(tab.connId);
      },

      closeTab(id) {
        const { tabs, activeTabId, conns } = get();
        const idx = tabs.findIndex((t) => t.id === id);
        if (idx < 0) return;
        const tab = tabs[idx];
        const nextTabs = tabs.filter((t) => t.id !== id);
        const nextActive = activeTabId === id ? (nextTabs[Math.min(idx, nextTabs.length - 1)]?.id ?? null) : activeTabId;
        const conn = conns[tab.connId];
        set({
          tabs: nextTabs,
          tableData: disposeTab(id),
          conns: conn?.activeTabId === id ? { ...conns, [tab.connId]: { ...conn, activeTabId: nextTabs.find((t) => t.connId === tab.connId)?.id ?? null } } : conns,
        });
        if (nextActive && nextActive !== activeTabId) focusTab(nextActive);
        else if (!nextActive) set({ activeTabId: null });
        persistTabs(tab.connId);
      },

      activateTab(id) {
        if (!get().tabs.some((t) => t.id === id)) return;
        const before = get().activeConnId;
        focusTab(id);
        if (get().activeConnId !== before) persistConns();
      },

      activateTabIndex(index) {
        const t = get().tabs[index];
        if (t) get().activateTab(t.id);
      },

      refreshTab(id) {
        const tab = get().tabs.find((t) => t.id === id);
        if (tab?.kind === "table") void get().loadFirst(id);
        if (tab?.kind === "structure" || tab?.kind === "activity") set((s) => ({ structureNonce: { ...s.structureNonce, [id]: (s.structureNonce[id] ?? 0) + 1 } }));
        if (tab?.kind === "structure") get().loadReferencing(tab.connId, tab.schema, tab.table, true);
      },

      setTableQuery(tabId, patch) {
        const tab = tableTab(tabId);
        if (!tab) return;
        set((s) => ({
          tabs: s.tabs.map((t) => (t.id === tabId && t.kind === "table" ? { ...t, query: { ...t.query, ...patch }, preview: false } : t)),
        }));
        persistTabs(tab.connId);
        void get().loadFirst(tabId);
      },

      ensureLoaded(tabId) {
        if (!get().tableData[tabId]) void get().loadFirst(tabId);
      },

      async loadFirst(tabId) {
        const tab = tableTab(tabId);
        if (!tab || !isConnected(tab.connId)) return;
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
          const page = await api.fetchPage(rid, buildPageRequest(tab.connId, tab.query, null));
          if (!isCurrent(tabId, rid)) return;
          patchData(tabId, {
            columns: page.columns,
            rows: page.rows,
            truncated: page.truncated,
            nextCursor: page.nextCursor,
            sql: page.sql,
            elapsedMs: page.elapsedMs,
            estRows: page.estRows,
            loading: false,
          });
        } catch (e) {
          if (!isCurrent(tabId, rid)) return;
          patchData(tabId, { loading: false, error: isCancelled(e) ? null : e, cancelled: isCancelled(e) });
        }
      },

      async loadMore(tabId) {
        const tab = tableTab(tabId);
        const d = get().tableData[tabId];
        if (!tab || !isConnected(tab.connId) || !d || d.loading || d.error || !d.nextCursor) return;
        const rid = newRequestId();
        const base = d.rows.length;
        patchData(tabId, { requestId: rid, loading: true, cancelled: false });
        try {
          const page = await api.fetchPage(rid, buildPageRequest(tab.connId, tab.query, d.nextCursor));
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
        const d = get().tableData[tabId];
        if (!tab || !isConnected(tab.connId) || !d) return;
        get().pinTab(tabId);
        if (d.counting && d.countRequestId) api.cancelQuery(d.countRequestId).catch(ignore);
        const rid = newRequestId();
        patchData(tabId, { countRequestId: rid, counting: true, countError: null });
        const q = tab.query;
        try {
          const n = await api.countExact(rid, tab.connId, q.schema, q.table, filtersToRequest(q.filters), normalizeRawWhere(q.search ?? ""), normalizeRawWhere(q.rawWhere));
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

      // v0.3.0 navigation
      loadReferencing(connId, schema, table, force = false) {
        if (!isConnected(connId)) return;
        const key = referencingCacheKey(connId, schema, table);
        const cur = get().referencing[key];
        if (cur?.status === "loading" || (cur && !force)) return;
        const seq = ++referencingSeq;
        set((s) => ({ referencing: { ...s.referencing, [key]: { status: "loading", seq } } }));
        const settle = (state: ReferencingState) => {
          // Dropped when the connection closed or the sidebar was refreshed meanwhile (even if a newer load started since).
          const now = get().referencing[key];
          if (now?.status === "loading" && now.seq === seq && isConnected(connId)) set((s) => ({ referencing: { ...s.referencing, [key]: state } }));
        };
        api.listReferencing(connId, schema, table).then(
          (keys) => settle({ status: "ok", keys }),
          (error) => settle({ status: "error", error }),
        );
      },

      // v0.3.0 tools
      openActivity(id) {
        const connId = id ?? sidebarConnId();
        if (!isConnected(connId)) return;
        openItem(connId, (t) => t.kind === "activity", (tabId) => ({ id: tabId, kind: "activity", title: "Activity", connId, preview: false }), "pinned");
        persistTabs(connId);
      },

      openSavedQuery(query) {
        const connId = sidebarConnId();
        if (!connId) return;
        addTab({ id: newRequestId(), kind: "sql", title: query.name, initialSql: query.sql, savedQueryId: query.id, connId, preview: false });
      },

      setTabSavedQuery(tabId, saved) {
        const tab = get().tabs.find((t) => t.id === tabId);
        if (tab?.kind !== "sql") return;
        set((s) => ({
          tabs: s.tabs.map((t) => {
            if (t.id !== tabId || t.kind !== "sql") return t;
            if (!saved) return { ...t, savedQueryId: undefined };
            return { ...t, savedQueryId: saved.id, title: saved.name, preview: false };
          }),
        }));
        persistTabs(tab.connId);
      },
    };
  });
}

export const appStore = createAppStore();

export function useApp<T>(selector: (s: AppState) => T): T {
  return useStore(appStore, selector);
}
