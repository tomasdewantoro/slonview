import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Page } from "../bindings/Page";
import type { PageRequest } from "../bindings/PageRequest";
import type { StoreApi } from "zustand/vanilla";
import { createAppStore, readPersistedTabs, sqlEditorKey, wasTabDisposed, type AppState } from "./app";

const CONN = "c1";

function page(rows: string[][], more: boolean, sql = "SELECT 1"): Page {
  return {
    columns: [{ name: "id", typeName: "integer", nullable: false, isPk: true }],
    rows,
    truncated: [[0, 0]],
    nextCursor: more ? { kind: "offset", offset: rows.length } : null,
    sql,
    elapsedMs: 1,
  };
}

interface Pending {
  requestId: string;
  req: PageRequest;
  resolve: (p: Page) => void;
  reject: (e: unknown) => void;
}

interface Ipc {
  pending: Pending[];
  cancelled: string[];
  /** Pending get_function_definition / get_object_definition calls. */
  definitions: { cmd: string; oid: number; resolve: (sql: string) => void }[];
}

/** IPC mock where fetch_page and definition calls stay pending until the test resolves them, in any order. */
function installIpc(): Ipc {
  const pending: Pending[] = [];
  const cancelled: string[] = [];
  const definitions: Ipc["definitions"] = [];
  mockIPC((cmd, args) => {
    const a = args as Record<string, any>;
    switch (cmd) {
      case "list_profiles":
        return [{ id: CONN, name: "local", host: "localhost", port: 5432, database: "db", user: "u", ssl: "disable", readOnly: true, color: null, statementTimeoutMs: 0, timeZone: null }];
      case "connect":
        return { version: "PostgreSQL 18", database: "db", user: "u", readOnly: true };
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
      default:
        throw new Error(`unexpected ${cmd}`);
    }
  });
  return { pending, cancelled, definitions };
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
    expect(s.conn?.status).toBe("connected");
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
