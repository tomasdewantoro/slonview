import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Page } from "../bindings/Page";
import type { PageRequest } from "../bindings/PageRequest";
import type { StoreApi } from "zustand/vanilla";
import { api } from "../api";
import { createAppStore, readPersistedConns, readPersistedTabs, referencingCacheKey, sqlEditorKey, statusConnId, tabReadOnly, wasTabDisposed, type AppState } from "./app";

const CONN = "c1";
/** Second profile on the same database with writes allowed. */
const CONN2 = "c2";

function page(rows: string[][], more: boolean, sql = "SELECT 1"): Page {
  return {
    columns: [{ name: "id", typeName: "integer", nullable: false, isPk: true, references: null }],
    rows,
    truncated: [[0, 0]],
    nextCursor: more ? { kind: "offset", offset: rows.length } : null,
    sql,
    elapsedMs: 1,
    estRows: null,
  };
}

interface Pending {
  requestId: string;
  req: PageRequest;
  resolve: (p: Page) => void;
  reject: (e: unknown) => void;
}

const profile = (id: string, name: string, readOnly: boolean, color: string | null) => ({
  id, name, host: "localhost", port: 5432, database: "db", user: "u", ssl: "disable", readOnly, color, statementTimeoutMs: 0, timeZone: null, sslRootCert: null, ssh: null,
});
const PROFILES = [profile(CONN, "local", true, null), profile(CONN2, "local (writes)", false, "#22a06b")];

interface Ipc {
  pending: Pending[];
  cancelled: string[];
  /** connId → read-only flag of the open session. */
  sessions: Map<string, boolean>;
  disconnected: string[];
  /** Pending get_function_definition / get_object_definition calls. */
  definitions: { cmd: string; oid: number; resolve: (sql: string) => void }[];
  /** list_referencing calls as `schema.table`. */
  referencing: string[];
  /** When set, list_referencing stays pending until the test resolves it. */
  holdReferencing: boolean;
  heldReferencing: ((keys: unknown[]) => void)[];
}

/** IPC mock where fetch_page and definition calls stay pending until the test resolves them, in any order. */
function installIpc(): Ipc {
  const pending: Pending[] = [];
  const cancelled: string[] = [];
  const definitions: Ipc["definitions"] = [];
  const sessions = new Map<string, boolean>();
  const disconnected: string[] = [];
  const referencing: string[] = [];
  const heldReferencing: Ipc["heldReferencing"] = [];
  const ipc = { holdReferencing: false };
  mockIPC((cmd, args) => {
    const a = args as Record<string, any>;
    switch (cmd) {
      case "list_profiles":
        return PROFILES;
      case "connect": {
        const p = PROFILES.find((x) => x.id === a.connId)!;
        sessions.set(p.id, p.readOnly);
        return { version: "PostgreSQL 18", database: "db", user: "u", readOnly: p.readOnly };
      }
      case "disconnect":
        sessions.delete(a.connId);
        disconnected.push(a.connId);
        return null;
      case "run_sql": {
        // Mirrors the engine: each request runs on its own profile's session, in that session's mode.
        const readOnly = sessions.get(a.connId);
        if (readOnly === undefined) throw { kind: "notConnected" };
        if (readOnly && /^\s*(insert|update|delete)/i.test(a.sql))
          throw { kind: "sql", code: "25006", message: "cannot execute DELETE in a read-only transaction", detail: null, hint: null, position: null };
        return [{ statement: a.sql, columns: [], rows: [], rowsAffected: 1, truncated: false, elapsedMs: 1 }];
      }
      case "list_schema_tree":
        return { schemas: [], extensions: [] };
      case "cancel_query":
        cancelled.push(a.requestId);
        return null;
      case "fetch_page":
        return new Promise((resolve, reject) => pending.push({ requestId: a.requestId, req: a.req, resolve, reject }));
      case "get_function_definition":
      case "get_object_definition":
        return new Promise((resolve) => definitions.push({ cmd, oid: a.oid, resolve }));
      case "list_referencing":
        referencing.push(`${a.schema}.${a.table}`);
        if (ipc.holdReferencing) return new Promise((resolve) => heldReferencing.push(resolve));
        return [{ constraintName: "orders_customer_id_fkey", schema: "public", table: "orders", columns: ["customer_id"], referencedColumns: ["id"] }];
      default:
        throw new Error(`unexpected ${cmd}`);
    }
  });
  return Object.assign(ipc, { pending, cancelled, definitions, sessions, disconnected, referencing, heldReferencing });
}

/** Flush pending promise callbacks (mockIPC + store awaits settle within a few microtask hops). */
async function tick() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("table tab requests", () => {
  let ipc: Ipc;
  beforeEach(() => {
    ipc = installIpc();
  });
  afterEach(() => clearMocks());

  async function connectedStore() {
    const store = createAppStore(window.localStorage);
    window.localStorage.clear();
    await store.getState().loadProfiles();
    await store.getState().connect(CONN);
    return store;
  }

  it("drops a stale response and cancels the superseded request", async () => {
    const store = await connectedStore();
    store.getState().openTable("public", "orders");
    const tabId = store.getState().activeTabId!;
    void store.getState().loadFirst(tabId);
    await tick();
    store.getState().setTableQuery(tabId, { rawWhere: "id > 5" });
    await tick();

    expect(ipc.pending).toHaveLength(2);
    const [first, second] = ipc.pending;
    expect(ipc.cancelled).toEqual([first.requestId]);
    expect(second.req.rawWhere).toBe("id > 5");

    // Newer response arrives first, then the stale one: the stale one must not overwrite it.
    second.resolve(page([["6"]], false, "new"));
    await tick();
    first.resolve(page([["1"], ["2"]], true, "old"));
    await tick();

    const d = store.getState().tableData[tabId];
    expect(d.rows).toEqual([["6"]]);
    expect(d.sql).toBe("new");
    expect(d.loading).toBe(false);
  });

  it("appends pages with the cursor and offsets truncated indexes", async () => {
    const store = await connectedStore();
    store.getState().openTable("public", "orders");
    const tabId = store.getState().activeTabId!;
    void store.getState().loadFirst(tabId);
    await tick();
    ipc.pending[0].resolve(page([["1"], ["2"]], true));
    await tick();

    void store.getState().loadMore(tabId);
    void store.getState().loadMore(tabId); // ignored while loading
    await tick();
    expect(ipc.pending).toHaveLength(2);
    expect(ipc.pending[1].req.cursor).toEqual({ kind: "offset", offset: 2 });
    ipc.pending[1].resolve(page([["3"]], false));
    await tick();

    const d = store.getState().tableData[tabId];
    expect(d.rows).toEqual([["1"], ["2"], ["3"]]);
    expect(d.truncated).toEqual([
      [0, 0],
      [2, 0],
    ]);
    expect(d.nextCursor).toBeNull();
  });

  it("ignores the result of a user-cancelled load", async () => {
    const store = await connectedStore();
    store.getState().openTable("public", "orders");
    const tabId = store.getState().activeTabId!;
    void store.getState().loadFirst(tabId);
    await tick();
    store.getState().cancelTable(tabId);
    expect(ipc.cancelled).toEqual([ipc.pending[0].requestId]);
    ipc.pending[0].reject({ kind: "cancelled" });
    await tick();
    const d = store.getState().tableData[tabId];
    expect(d.loading).toBe(false);
    expect(d.cancelled).toBe(true);
    expect(d.error).toBeNull();
  });

  it("shows an error only for the current request", async () => {
    const store = await connectedStore();
    store.getState().openTable("public", "orders");
    const tabId = store.getState().activeTabId!;
    void store.getState().loadFirst(tabId);
    await tick();
    const err = { kind: "sql", code: "42601", message: "syntax error", detail: null, hint: null, position: 3 };
    ipc.pending[0].reject(err);
    await tick();
    expect(store.getState().tableData[tabId].error).toEqual(err);
  });

  it("sends the search with pages and counts and keeps it with the tab", async () => {
    const store = await connectedStore();
    store.getState().openTable("public", "orders");
    const tabId = store.getState().activeTabId!;
    store.getState().setTableQuery(tabId, { search: " o'brien " });
    await tick();
    expect(ipc.pending[ipc.pending.length - 1].req.search).toBe("o'brien");
    const saved = JSON.parse(window.localStorage.getItem(`slonview.tabs.${CONN}`)!);
    expect(saved.tabs[0].query.search).toBe(" o'brien ");
    store.getState().setTableQuery(tabId, { search: "" });
    await tick();
    expect(ipc.pending[ipc.pending.length - 1].req.search).toBeNull();
  });

  it("opens rows filtered to a value as a pinned tab and reuses it", async () => {
    const store = await connectedStore();
    const target = { schema: "public", table: "orders", column: "customer_id" };
    store.getState().openRowsWhere(CONN, target, "7");
    const tabs = () => store.getState().tabs;
    expect(tabs()).toHaveLength(1);
    const t = tabs()[0];
    expect(t.kind === "table" && t.query.filters.map((f) => [f.column, f.op, f.value])).toEqual([["customer_id", "=", "7"]]);
    expect(t.preview).toBe(false);
    store.getState().openRowsWhere(CONN, target, "7");
    expect(tabs()).toHaveLength(1);
    store.getState().openRowsWhere(CONN, target, "8");
    expect(tabs()).toHaveLength(2);
  });

  it("loads referencing keys once per relation and forgets them on a sidebar refresh", async () => {
    const store = await connectedStore();
    store.getState().loadReferencing(CONN, "public", "customers");
    store.getState().loadReferencing(CONN, "public", "customers");
    await tick();
    store.getState().loadReferencing(CONN, "public", "customers");
    expect(ipc.referencing).toEqual(["public.customers"]);
    const st = store.getState().referencing[referencingCacheKey(CONN, "public", "customers")];
    expect(st.status === "ok" && st.keys.map((k) => k.table)).toEqual(["orders"]);
    store.getState().loadReferencing(CONN, "public", "customers", true);
    await tick();
    expect(ipc.referencing).toHaveLength(2);
    await store.getState().loadTree(CONN);
    expect(store.getState().referencing).toEqual({});
    store.getState().loadReferencing("not-connected", "public", "customers");
    expect(ipc.referencing).toHaveLength(2);
  });

  it("a referencing response from before a sidebar refresh never lands on a newer load", async () => {
    const store = await connectedStore();
    const key = referencingCacheKey(CONN, "public", "customers");
    const fk = (table: string) => ({ constraintName: `${table}_fkey`, schema: "public", table, columns: ["customer_id"], referencedColumns: ["id"] });
    ipc.holdReferencing = true;
    store.getState().loadReferencing(CONN, "public", "customers");
    await tick();
    await store.getState().loadTree(CONN); // forgets the in-flight load
    store.getState().loadReferencing(CONN, "public", "customers");
    await tick();
    expect(ipc.heldReferencing).toHaveLength(2);
    const [stale, fresh] = ipc.heldReferencing;
    stale([fk("old_orders")]);
    await tick();
    expect(store.getState().referencing[key].status).toBe("loading");
    fresh([fk("orders")]);
    await tick();
    const st = store.getState().referencing[key];
    expect(st.status === "ok" && st.keys.map((k) => k.table)).toEqual(["orders"]);
  });
});

describe("tab persistence", () => {
  beforeEach(() => {
    installIpc();
    window.localStorage.clear();
  });
  afterEach(() => clearMocks());

  it("restores open tabs and active tab for the connection on reconnect", async () => {
    const a = createAppStore(window.localStorage);
    await a.getState().loadProfiles();
    await a.getState().connect(CONN);
    a.getState().openTable("Sales Data", 'Weird "Name" Table');
    a.getState().openSql("SELECT 1;");
    a.getState().openStructure("public", "orders");
    const tableTab = a.getState().tabs[0];
    a.getState().setTableQuery(tableTab.id, { sort: [{ column: "id", desc: true }] });
    a.getState().activateTab(tableTab.id);

    const b = createAppStore(window.localStorage);
    await b.getState().init();
    const s = b.getState();
    expect(s.conns[CONN]?.status).toBe("connected");
    expect(s.tabs.map((t) => t.kind)).toEqual(["table", "sql", "structure"]);
    expect(s.activeTabId).toBe(tableTab.id);
    const restored = s.tabs[0];
    expect(restored.kind === "table" && restored.query.sort).toEqual([{ column: "id", desc: true }]);
    expect(restored.title).toBe('Sales Data.Weird "Name" Table');
  });

  it("closing the active tab activates its neighbour and persists", async () => {
    const a = createAppStore(window.localStorage);
    await a.getState().loadProfiles();
    await a.getState().connect(CONN);
    a.getState().openTable("public", "a");
    a.getState().openTable("public", "b");
    a.getState().openTable("public", "c");
    const [, b, c] = a.getState().tabs;
    a.getState().activateTab(b.id);
    a.getState().closeTab(b.id);
    expect(a.getState().activeTabId).toBe(c.id);
    expect(readPersistedTabs(window.localStorage, CONN).tabs.map((t) => t.title)).toEqual(["a", "c"]);
  });

  it("ignores corrupt persisted data", () => {
    window.localStorage.setItem(`slonview.tabs.${CONN}`, "{not json");
    expect(readPersistedTabs(window.localStorage, CONN)).toEqual({ tabs: [], activeTabId: null });
    window.localStorage.setItem(`slonview.tabs.${CONN}`, JSON.stringify({ tabs: [{ id: "x", kind: "table", title: "t" }], activeTabId: "x" }));
    expect(readPersistedTabs(window.localStorage, CONN)).toEqual({ tabs: [], activeTabId: null });
  });
});

describe("preview tabs", () => {
  let ipc: Ipc;
  beforeEach(() => {
    ipc = installIpc();
    window.localStorage.clear();
  });
  afterEach(() => clearMocks());

  async function connectedStore() {
    const store = createAppStore(window.localStorage);
    await store.getState().loadProfiles();
    await store.getState().connect(CONN);
    return store;
  }
  const strip = (store: StoreApi<AppState>) => store.getState().tabs.map((t) => `${t.title}${t.preview ? "*" : ""}`).join(",");

  it("a second click replaces the preview tab in place", async () => {
    const store = await connectedStore();
    store.getState().openTable("public", "a");
    store.getState().openTable("public", "pinned");
    store.getState().openTable("public", "z");
    store.getState().activateTab(store.getState().tabs[0].id);
    store.getState().openTable("public", "orders", "preview");
    expect(strip(store)).toBe("a,orders*,pinned,z");
    store.getState().openTable("public", "customers", "preview");
    expect(strip(store)).toBe("a,customers*,pinned,z");
    expect(store.getState().tabs[store.getState().tabs.findIndex((t) => t.preview)].id).toBe(store.getState().activeTabId);
    expect(store.getState().tabs.filter((t) => t.preview)).toHaveLength(1);
  });

  it("a new preview goes right after the active tab", async () => {
    const store = await connectedStore();
    store.getState().openTable("public", "a");
    store.getState().openTable("public", "b");
    store.getState().activateTab(store.getState().tabs[0].id);
    store.getState().openTable("public", "p", "preview");
    expect(strip(store)).toBe("a,p*,b");
  });

  it("clicking an already pinned item only activates it", async () => {
    const store = await connectedStore();
    store.getState().openTable("public", "orders");
    store.getState().openTable("public", "customers", "preview");
    store.getState().openTable("public", "orders", "preview");
    expect(strip(store)).toBe("orders,customers*");
    expect(store.getState().activeTabId).toBe(store.getState().tabs[0].id);
  });

  it("double-click pins a new item or the open preview, in place", async () => {
    const store = await connectedStore();
    store.getState().openTable("public", "orders", "preview");
    store.getState().openTable("public", "orders", "pinned");
    expect(strip(store)).toBe("orders");
    store.getState().openTable("public", "customers", "preview");
    store.getState().openStructure("public", "orders", "pinned");
    expect(strip(store)).toBe("orders,customers*,orders");
    store.getState().pinTab(store.getState().tabs[1].id);
    expect(strip(store)).toBe("orders,customers,orders");
  });

  it("filters, sort and count pin a preview table tab", async () => {
    const store = await connectedStore();
    store.getState().openTable("public", "orders", "preview");
    const id = store.getState().activeTabId!;
    store.getState().setTableQuery(id, { rawWhere: "id > 1" });
    expect(store.getState().tabs[0].preview).toBe(false);

    store.getState().openTable("public", "customers", "preview");
    const c = store.getState().activeTabId!;
    store.getState().ensureLoaded(c);
    await tick();
    ipc.pending[ipc.pending.length - 1].resolve(page([["1"]], false));
    await tick();
    expect(store.getState().tabs[1].preview).toBe(true);
    void store.getState().countRows(c);
    expect(store.getState().tabs[1].preview).toBe(false);
  });

  it("replacing a preview cancels its requests and drops its data and editor text", async () => {
    const store = await connectedStore();
    store.getState().openTable("public", "orders", "preview");
    const old = store.getState().activeTabId!;
    store.getState().ensureLoaded(old);
    await tick();
    const rid = ipc.pending[0].requestId;
    window.localStorage.setItem(sqlEditorKey(old), "SELECT 1");
    store.getState().openTable("public", "customers", "preview");
    await tick();
    expect(ipc.cancelled).toContain(rid);
    expect(store.getState().tableData[old]).toBeUndefined();
    expect(window.localStorage.getItem(sqlEditorKey(old))).toBeNull();
    expect(wasTabDisposed(old)).toBe(true);
  });

  it("closing a tab removes its editor text", async () => {
    const store = await connectedStore();
    store.getState().openSql("SELECT 1");
    const id = store.getState().activeTabId!;
    window.localStorage.setItem(sqlEditorKey(id), "SELECT 2");
    store.getState().closeTab(id);
    expect(window.localStorage.getItem(sqlEditorKey(id))).toBeNull();
  });

  it("Cmd+T SQL tabs and explicit opens stay pinned", async () => {
    const store = await connectedStore();
    store.getState().openTable("public", "orders", "preview");
    store.getState().openSql();
    store.getState().openTable("public", "a");
    expect(strip(store)).toBe("orders*,Query 1,a");
  });

  it("SQL edits and runs pin a preview definition tab", async () => {
    const store = await connectedStore();
    const fn = { oid: 7, schema: "public", name: "f", args: "", result: "int", kind: "function", language: "sql" } as const;
    const opening = store.getState().openFunction(fn, "preview");
    await tick();
    ipc.definitions[0].resolve("CREATE FUNCTION f()");
    await opening;
    expect(strip(store)).toBe("f()*");
    // SqlTab calls pinTab on the first editor change and before running.
    store.getState().pinTab(store.getState().activeTabId!);
    expect(strip(store)).toBe("f()");
  });

  it("a repeat click on a definition activates it without refetching", async () => {
    const store = await connectedStore();
    const opening = store.getState().openObject("type", 42, "status", "status", "preview");
    await tick();
    ipc.definitions[0].resolve("CREATE TYPE status");
    await opening;
    store.getState().openSql();
    await store.getState().openObject("type", 42, "status", "status", "preview");
    expect(ipc.definitions).toHaveLength(1);
    expect(store.getState().tabs.find((t) => t.id === store.getState().activeTabId)?.title).toBe("status");
  });

  it("a double-click during the fetch makes one pinned tab from one request", async () => {
    const store = await connectedStore();
    const fn = { oid: 9, schema: "public", name: "g", args: "x int", result: "int", kind: "function", language: "sql" } as const;
    const first = store.getState().openFunction(fn, "preview");
    const second = store.getState().openFunction(fn, "pinned");
    await tick();
    expect(ipc.definitions).toHaveLength(1);
    ipc.definitions[0].resolve("CREATE FUNCTION g(x int)");
    await Promise.all([first, second]);
    expect(strip(store)).toBe("g(x int)");
  });

  it("a slow preview definition loses to a newer preview click", async () => {
    const store = await connectedStore();
    const fn = { oid: 3, schema: "public", name: "h", args: "", result: "int", kind: "function", language: "sql" } as const;
    const slow = store.getState().openFunction(fn, "preview");
    store.getState().openTable("public", "orders", "preview");
    await tick();
    ipc.definitions[0].resolve("CREATE FUNCTION h()");
    await slow;
    expect(strip(store)).toBe("orders*");
  });

  it("persists the preview flag; old tabs without it load pinned; at most one preview", async () => {
    const a = await connectedStore();
    a.getState().openTable("public", "orders");
    a.getState().openTable("public", "customers", "preview");
    const b = createAppStore(window.localStorage);
    await b.getState().init();
    expect(strip(b)).toBe("orders,customers*");

    window.localStorage.setItem(
      `slonview.tabs.${CONN}`,
      JSON.stringify({
        tabs: [
          { id: "x", kind: "structure", title: "old", schema: "public", table: "old" },
          { id: "y", kind: "structure", title: "p1", schema: "public", table: "p1", preview: true },
          { id: "z", kind: "structure", title: "p2", schema: "public", table: "p2", preview: true },
        ],
        activeTabId: "x",
      }),
    );
    expect(readPersistedTabs(window.localStorage, CONN).tabs.map((t) => t.preview)).toEqual([false, true, false]);
  });
});

describe("several connections", () => {
  let ipc: Ipc;
  beforeEach(() => {
    ipc = installIpc();
    window.localStorage.clear();
  });
  afterEach(() => clearMocks());

  async function twoConns() {
    const store = createAppStore(window.localStorage);
    await store.getState().loadProfiles();
    await store.getState().connect(CONN);
    store.getState().openTable("public", "orders");
    await store.getState().connect(CONN2);
    store.getState().openTable("public", "orders");
    return store;
  }
  const strip = (store: StoreApi<AppState>) => store.getState().tabs.map((t) => `${t.connId}:${t.title}${t.preview ? "*" : ""}`).join(",");

  it("keeps both connections open and tags every tab with its connection", async () => {
    const store = await twoConns();
    const s = store.getState();
    expect(Object.keys(s.conns)).toEqual([CONN, CONN2]);
    expect(Object.values(s.conns).map((c) => c.status)).toEqual(["connected", "connected"]);
    expect(ipc.disconnected).toEqual([]);
    expect(strip(store)).toBe("c1:orders,c2:orders");
    expect(s.activeConnId).toBe(CONN2);
    // Each tab's requests go to its own connection.
    for (const tab of s.tabs) void store.getState().loadFirst(tab.id);
    await tick();
    expect(ipc.pending.map((p) => p.req.connId)).toEqual([CONN, CONN2]);
  });

  it("activating a tab switches the sidebar and status bar to the tab's connection", async () => {
    const store = await twoConns();
    const [first, second] = store.getState().tabs;
    store.getState().activateTab(first.id);
    expect(store.getState().activeConnId).toBe(CONN);
    expect(statusConnId(store.getState())).toBe(CONN);
    // Sidebar opens now target CONN.
    store.getState().openSql();
    expect(store.getState().tabs.find((t) => t.id === store.getState().activeTabId)?.connId).toBe(CONN);
    store.getState().activateTab(second.id);
    expect(store.getState().activeConnId).toBe(CONN2);
    expect(statusConnId(store.getState())).toBe(CONN2);
  });

  it("switching connection in the sidebar restores that connection's last active tab", async () => {
    const store = await twoConns();
    store.getState().openTable("public", "customers");
    const c2Active = store.getState().activeTabId;
    store.getState().setActiveConn(CONN);
    expect(store.getState().tabs.find((t) => t.id === store.getState().activeTabId)?.connId).toBe(CONN);
    store.getState().setActiveConn(CONN2);
    expect(store.getState().activeTabId).toBe(c2Active);
  });

  it("disconnecting one connection closes only its tabs, cancelling their requests", async () => {
    const store = await twoConns();
    store.getState().openSql("SELECT 2");
    const [c1Tab, c2Tab] = store.getState().tabs;
    const sqlTab = store.getState().activeTabId!;
    window.localStorage.setItem(sqlEditorKey(sqlTab), "SELECT 2");
    void store.getState().loadFirst(c1Tab.id);
    void store.getState().loadFirst(c2Tab.id);
    await tick();
    const [c1Req, c2Req] = ipc.pending;
    await store.getState().disconnect(CONN2);
    const s = store.getState();
    expect(strip(store)).toBe("c1:orders");
    expect(Object.keys(s.conns)).toEqual([CONN]);
    expect(s.activeConnId).toBe(CONN);
    expect(s.activeTabId).toBe(c1Tab.id);
    expect(ipc.cancelled).toEqual([c2Req.requestId]);
    expect(ipc.cancelled).not.toContain(c1Req.requestId);
    expect(s.tableData[c2Tab.id]).toBeUndefined();
    expect(s.tableData[c1Tab.id]).toBeDefined();
    expect(ipc.disconnected).toEqual([CONN2]);
    // The closed connection's tabs stay saved for its next connect, editor text included.
    expect(readPersistedTabs(window.localStorage, CONN2).tabs.map((t) => t.title)).toEqual(["orders", "Query 1"]);
    expect(window.localStorage.getItem(sqlEditorKey(sqlTab))).toBe("SELECT 2");
    await store.getState().connect(CONN2);
    expect(strip(store)).toBe("c1:orders,c2:orders,c2:Query 1");
  });

  it("closing the last tab of one connection leaves the other's alone", async () => {
    const store = await twoConns();
    const [c1Tab, c2Tab] = store.getState().tabs;
    store.getState().closeTab(c2Tab.id);
    expect(strip(store)).toBe("c1:orders");
    expect(store.getState().activeTabId).toBe(c1Tab.id);
    expect(store.getState().activeConnId).toBe(CONN);
    expect(readPersistedTabs(window.localStorage, CONN2).tabs).toEqual([]);
    expect(readPersistedTabs(window.localStorage, CONN).tabs.map((t) => t.title)).toEqual(["orders"]);
  });

  it("keeps one preview tab per connection", async () => {
    const store = await twoConns();
    store.getState().setActiveConn(CONN);
    store.getState().openTable("public", "a", "preview");
    store.getState().setActiveConn(CONN2);
    store.getState().openTable("public", "b", "preview");
    expect(strip(store)).toBe("c1:orders,c1:a*,c2:orders,c2:b*");
    // A new preview on CONN2 replaces only CONN2's preview.
    store.getState().openTable("public", "c", "preview");
    expect(strip(store)).toBe("c1:orders,c1:a*,c2:orders,c2:c*");
    // The same item open on the other connection is a separate tab.
    store.getState().openTable("public", "a", "preview");
    expect(strip(store)).toBe("c1:orders,c1:a*,c2:orders,c2:a*");
  });

  it("restores both connections and their tabs on start", async () => {
    const a = await twoConns();
    a.getState().openSql("SELECT 1");
    a.getState().activateTab(a.getState().tabs[0].id);
    expect(readPersistedConns(window.localStorage)).toEqual({ ids: [CONN, CONN2], active: CONN });

    const b = createAppStore(window.localStorage);
    await b.getState().init();
    const s = b.getState();
    expect(Object.keys(s.conns)).toEqual([CONN, CONN2]);
    expect(Object.values(s.conns).every((c) => c.status === "connected")).toBe(true);
    expect(strip(b)).toBe("c1:orders,c2:orders,c2:Query 1");
    expect(s.activeConnId).toBe(CONN);
    expect(s.tabs.find((t) => t.id === s.activeTabId)?.connId).toBe(CONN);
  });

  it("loads tabs saved before multi-connection under the profile they were saved for", async () => {
    // Pre-multi-connection layout: single `lastConn`, tabs without connId.
    window.localStorage.setItem("slonview.lastConn", CONN);
    window.localStorage.setItem(
      `slonview.tabs.${CONN}`,
      JSON.stringify({
        tabs: [
          { id: "x", kind: "table", title: "orders", query: { schema: "public", table: "orders", filters: [], rawWhere: "", sort: [] }, preview: false },
          { id: "y", kind: "sql", title: "Query 1", preview: false },
        ],
        activeTabId: "y",
      }),
    );
    const store = createAppStore(window.localStorage);
    await store.getState().init();
    const s = store.getState();
    expect(Object.keys(s.conns)).toEqual([CONN]);
    expect(s.tabs.map((t) => t.connId)).toEqual([CONN, CONN]);
    expect(s.activeTabId).toBe("y");
    // Migrated to the new key on the first write.
    expect(window.localStorage.getItem("slonview.lastConn")).toBeNull();
    expect(readPersistedConns(window.localStorage)).toEqual({ ids: [CONN], active: CONN });
  });

  it("a failed connection is not reopened on the next start", async () => {
    const store = createAppStore(window.localStorage);
    await store.getState().loadProfiles();
    await store.getState().connect(CONN);
    clearMocks();
    mockIPC((cmd) => {
      if (cmd === "connect") throw { kind: "connect", message: "refused" };
      throw new Error(`unexpected ${cmd}`);
    });
    await store.getState().connect(CONN2);
    expect(store.getState().conns[CONN2].status).toBe("failed");
    expect(readPersistedConns(window.localStorage).ids).toEqual([CONN]);
  });

  it("read-only safety: a write from the read-only tab is refused while the allow-writes one is open", async () => {
    const store = await twoConns();
    const [roTab, rwTab] = store.getState().tabs;
    const s = store.getState();
    expect(s.conns[CONN].server?.readOnly).toBe(true);
    expect(s.conns[CONN2].server?.readOnly).toBe(false);
    expect(tabReadOnly(s, roTab)).toBe(true);
    expect(tabReadOnly(s, rwTab)).toBe(false);
    // Each tab sends its own connId, so the request runs on its own profile's session and mode.
    await expect(api.runSql("r1", roTab.connId, "DELETE FROM orders")).rejects.toMatchObject({ kind: "sql", code: "25006" });
    await expect(api.runSql("r2", rwTab.connId, "DELETE FROM orders")).resolves.toHaveLength(1);
    // Activating the writable tab does not change the read-only tab's mode.
    store.getState().activateTab(rwTab.id);
    expect(tabReadOnly(store.getState(), roTab)).toBe(true);
  });
});

describe("v0.3.0 tools: activity and saved-query tabs", () => {
  beforeEach(() => {
    installIpc();
    window.localStorage.clear();
  });
  afterEach(() => clearMocks());

  async function connected() {
    const store = createAppStore(window.localStorage);
    await store.getState().loadProfiles();
    await store.getState().connect(CONN);
    return store;
  }

  it("opens one pinned Activity tab per connection and restores it after a reload", async () => {
    const store = await connected();
    store.getState().openActivity();
    store.getState().openTable("public", "orders", "preview");
    store.getState().openActivity(CONN);
    const activity = store.getState().tabs.filter((t) => t.kind === "activity");
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({ title: "Activity", connId: CONN, preview: false });
    expect(store.getState().activeTabId).toBe(activity[0].id);
    // ⌘R bumps its refresh counter.
    store.getState().refreshTab(activity[0].id);
    expect(store.getState().structureNonce[activity[0].id]).toBe(1);
    expect(readPersistedTabs(window.localStorage, CONN).tabs.map((t) => t.kind)).toContain("activity");
    // Not connected: nothing opens.
    store.getState().openActivity("nope");
    expect(store.getState().tabs.filter((t) => t.kind === "activity")).toHaveLength(1);
  });

  it("a saved query opens in a new pinned tab that remembers its id; rename and delete follow", async () => {
    const store = await connected();
    store.getState().openSavedQuery({ id: "q1", name: "Paid orders", sql: "select 1" });
    store.getState().openSavedQuery({ id: "q1", name: "Paid orders", sql: "select 1" });
    const tabs = store.getState().tabs;
    expect(tabs).toHaveLength(2);
    expect(tabs[0]).toMatchObject({ kind: "sql", title: "Paid orders", initialSql: "select 1", savedQueryId: "q1", preview: false });
    expect(readPersistedTabs(window.localStorage, CONN).tabs[1]).toMatchObject({ savedQueryId: "q1" });

    store.getState().openSql();
    const plain = store.getState().tabs[2];
    store.getState().setTabSavedQuery(plain.id, { id: "q2", name: "Mine" });
    expect(store.getState().tabs[2]).toMatchObject({ title: "Mine", savedQueryId: "q2" });

    store.getState().setTabSavedQuery(plain.id, null);
    const after = store.getState().tabs[2];
    expect(after.kind === "sql" && after.savedQueryId).toBeUndefined();
    expect(after.title).toBe("Mine");
  });
});
