import { Plus } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";
import { Sidebar } from "./components/Sidebar";
import { SqlTab } from "./components/sql/SqlTab";
import { StatusBar } from "./components/StatusBar";
import { StructureTab } from "./components/StructureTab";
import { TabBar } from "./components/TabBar";
import { TableTab } from "./components/TableTab";
import { Toasts } from "./components/Toasts";
import type { SchemaNode } from "./bindings/SchemaNode";
import { appStore, useApp } from "./store/app";

/** App-wide shortcuts. Capture phase so they also work while the grid or an editor has focus. */
function useShortcuts(focusSearch: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.altKey || e.ctrlKey) return;
      const s = appStore.getState();
      const key = e.key.toLowerCase();
      let handled = true;
      if (e.shiftKey) {
        if (key === "f") focusSearch();
        else handled = false;
      } else if (key === "w") {
        if (s.activeTabId) s.closeTab(s.activeTabId);
      } else if (key === "t") {
        s.openSql();
      } else if (key === "r") {
        if (s.activeTabId) s.refreshTab(s.activeTabId);
      } else if (/^[1-9]$/.test(e.key)) {
        s.activateTabIndex(Number(e.key) - 1);
      } else {
        handled = false;
      }
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [focusSearch]);
}

function MainArea() {
  const tabs = useApp((s) => s.tabs);
  const activeId = useApp((s) => s.activeTabId);
  const sidebarStatus = useApp((s) => (s.activeConnId ? s.conns[s.activeConnId]?.status : undefined));
  const sidebarConnected = sidebarStatus === "connected";
  const active = tabs.find((t) => t.id === activeId);

  if (tabs.length === 0 && !sidebarConnected) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted">
        {sidebarStatus === "connecting" ? "Connecting…" : "Double-click a connection in the sidebar to open it."}
      </div>
    );
  }

  return (
    <>
      <TabBar />
      {!active && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted">
          {sidebarStatus === "connecting" ? (
            <p>Connecting…</p>
          ) : (
            <>
              <p>Pick a table in the sidebar, or start a query.</p>
              <button className="btn" disabled={!sidebarConnected} onClick={() => appStore.getState().openSql()}>
                <Plus size={13} aria-hidden /> New SQL query <span className="text-faint">⌘T</span>
              </button>
            </>
          )}
        </div>
      )}
      {/* SQL tabs stay mounted so editor contents and results survive tab switches. */}
      {tabs.map((t) =>
        t.kind === "sql" ? (
          <div key={t.id} className={t.id === activeId ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
            <ConnSqlTab tabId={t.id} connId={t.connId} initialSql={t.initialSql} />
          </div>
        ) : null,
      )}
      {active?.kind === "table" && <TableTab key={active.id} tab={active} connId={active.connId} />}
      {active?.kind === "structure" && <StructureTab key={active.id} tab={active} connId={active.connId} />}
    </>
  );
}

const NO_TREE: SchemaNode[] = [];

/** SQL tab bound to its own connection's schema tree (autocomplete). */
function ConnSqlTab({ tabId, connId, initialSql }: { tabId: string; connId: string; initialSql?: string }) {
  const tree = useApp((s) => s.conns[connId]?.tree ?? NO_TREE);
  return <SqlTab tabId={tabId} connId={connId} schema={tree} initialSql={initialSql} />;
}

export default function App() {
  const searchRef = useRef<HTMLInputElement>(null);
  const focusSearch = useCallback(() => {
    searchRef.current?.focus();
    searchRef.current?.select();
  }, []);
  useShortcuts(focusSearch);

  useEffect(() => {
    void appStore.getState().init();
  }, []);

  return (
    <div className="flex h-dvh flex-col">
      <div className="flex min-h-0 flex-1">
        <div className="flex w-[264px] shrink-0 border-r border-border">
          <Sidebar ref={searchRef} />
        </div>
        <main className="flex min-w-0 flex-1 flex-col">
          <MainArea />
        </main>
      </div>
      <StatusBar />
      <Toasts />
    </div>
  );
}
