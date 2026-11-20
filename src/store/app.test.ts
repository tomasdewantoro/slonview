import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Page } from "../bindings/Page";
import type { PageRequest } from "../bindings/PageRequest";
import { createAppStore, readPersistedTabs } from "./app";

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
}

/** IPC mock where fetch_page calls stay pending until the test resolves them, in any order. */
function installIpc(): Ipc {
  const pending: Pending[] = [];
  const cancelled: string[] = [];
  mockIPC((cmd, args) => {
    const a = args as Record<string, any>;
    switch (cmd) {
      case "list_profiles":
        return [{ id: CONN, name: "local", host: "localhost", port: 5432, database: "db", user: "u", ssl: "disable", readOnly: true, color: null, statementTimeoutMs: 0, timeZone: null }];
      case "connect":
        return { version: "PostgreSQL 18", database: "db", user: "u", readOnly: true };
      case "list_schema_tree":
        return [];
      case "cancel_query":
        cancelled.push(a.requestId);
        return null;
      case "fetch_page":
        return new Promise((resolve, reject) => pending.push({ requestId: a.requestId, req: a.req, resolve, reject }));
      default:
        throw new Error(`unexpected ${cmd}`);
    }
  });
  return { pending, cancelled };
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
