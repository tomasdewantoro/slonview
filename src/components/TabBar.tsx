import { Plus, SquareTerminal, Table2, TableProperties, X } from "lucide-react";
import { useState } from "react";
import { appStore, useApp, type Tab } from "../store/app";
import { ContextMenu } from "./ContextMenu";

const ICON = { table: Table2, structure: TableProperties, sql: SquareTerminal } as const;
const PREVIEW_HINT = "Preview, double-click to keep open";

export function TabBar() {
  const tabs = useApp((s) => s.tabs);
  const active = useApp((s) => s.activeTabId);
  const connected = useApp((s) => s.conn?.status === "connected");
  const { activateTab, closeTab, openSql, pinTab } = appStore.getState();
  const [menu, setMenu] = useState<{ x: number; y: number; tab: Tab } | null>(null);

  return (
    <div className="flex h-9 shrink-0 items-stretch border-b border-border bg-surface">
      <div role="tablist" aria-label="Open tabs" className="flex min-w-0 flex-1 items-stretch overflow-x-auto">
        {tabs.map((t: Tab, i) => {
          const Icon = ICON[t.kind];
          const isActive = t.id === active;
          return (
            <div
              key={t.id}
              role="tab"
              aria-selected={isActive}
              aria-label={t.preview ? `${t.title}${t.kind === "structure" ? " · structure" : ""} (${PREVIEW_HINT})` : undefined}
              data-preview={t.preview || undefined}
              tabIndex={isActive ? 0 : -1}
              title={`${t.title}${i < 9 ? `  ⌘${i + 1}` : ""}${t.preview ? `\n${PREVIEW_HINT}` : ""}`}
              onMouseDown={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  closeTab(t.id);
                } else if (e.button === 0) activateTab(t.id);
              }}
              onDoubleClick={() => pinTab(t.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, tab: t });
              }}
              className={`group relative flex max-w-56 min-w-28 shrink-0 items-center gap-1.5 border-r border-border pr-1 pl-2.5 ${
                isActive ? "bg-paper text-ink" : "text-muted hover:bg-surface-2"
              }`}
            >
              {isActive && <span aria-hidden className="absolute inset-x-0 bottom-[-1px] h-px bg-paper" />}
              <Icon size={13} className={`shrink-0 ${t.kind === "table" ? "" : "text-accent"}`} aria-hidden />
              <span className={`min-w-0 flex-1 truncate text-[12.5px] ${t.preview ? "italic" : ""}`}>
                {t.title}
                {t.kind === "structure" && <span className="text-faint"> · structure</span>}
              </span>
              <button
                className={`icon-btn size-5 ${isActive ? "" : "opacity-0 group-hover:opacity-100"}`}
                aria-label={`Close ${t.title}`}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => closeTab(t.id)}
              >
                <X size={12} />
              </button>
            </div>
          );
        })}
      </div>
      <button className="icon-btn mx-1 self-center" aria-label="New SQL query" title="New SQL query (⌘T)" disabled={!connected} onClick={() => openSql()}>
        <Plus size={15} />
      </button>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: "Keep open", disabled: !menu.tab.preview, onSelect: () => pinTab(menu.tab.id) },
            { separator: true },
            { label: "Close", shortcut: "⌘W", onSelect: () => closeTab(menu.tab.id) },
          ]}
        />
      )}
    </div>
  );
}
