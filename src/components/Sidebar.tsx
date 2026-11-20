import {
  ChevronDown,
  ChevronRight,
  Eye,
  Layers,
  LoaderCircle,
  RefreshCw,
  Search,
  SquareStack,
  Table2,
  Unplug,
  Globe,
  X,
  type LucideIcon,
} from "lucide-react";
import { forwardRef, useMemo, useState } from "react";
import type { Relation } from "../bindings/Relation";
import type { RelationKind } from "../bindings/RelationKind";
import type { SchemaNode } from "../bindings/SchemaNode";
import { appStore, useApp } from "../store/app";
import { formatBytes, formatCount, selectSql } from "../store/queries";
import { ColorDot, ConnectionList } from "./ConnectionList";
import { ContextMenu } from "./ContextMenu";
import { ErrorPanel } from "./ErrorPanel";

const KIND: Record<RelationKind, { icon: LucideIcon; label: string }> = {
  table: { icon: Table2, label: "table" },
  view: { icon: Eye, label: "view" },
  "materialized-view": { icon: Layers, label: "materialized view" },
  "partitioned-table": { icon: SquareStack, label: "partitioned table" },
  "foreign-table": { icon: Globe, label: "foreign table" },
};

/** Case-insensitive substring match on "schema.name"; schemas whose name matches keep all relations. */
export function filterTree(tree: SchemaNode[], query: string): SchemaNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return tree;
  const out: SchemaNode[] = [];
  for (const s of tree) {
    const relations = s.relations.filter((r) => `${s.name}.${r.name}`.toLowerCase().includes(q));
    if (relations.length) out.push({ ...s, relations });
  }
  return out;
}

export const Sidebar = forwardRef<HTMLInputElement>(function Sidebar(_props, searchRef) {
  const conn = useApp((s) => s.conn);
  const profile = useApp((s) => s.profiles.find((p) => p.id === s.conn?.profileId));
  if (!conn || conn.status === "failed" || !profile) {
    return (
      <aside className="flex w-full flex-col bg-side">
        <ConnectionList />
      </aside>
    );
  }
  return (
    <aside className="flex w-full flex-col bg-side">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line pr-1.5 pl-3">
        <ColorDot color={profile.color} />
        <span className="min-w-0 flex-1 truncate font-semibold" title={`${profile.user}@${profile.host}:${profile.port}/${profile.database}`}>
          {profile.name}
        </span>
        {profile.readOnly ? (
          <span className="rounded-sm border border-line px-1 text-[10px] leading-4 text-muted" title="Session is read-only">
            READ-ONLY
          </span>
        ) : (
          <span className="rounded-sm bg-danger px-1 text-[10px] leading-4 font-semibold text-white" title="Writes are allowed on this connection">
            WRITE
          </span>
        )}
        <button className="icon-btn" aria-label="Disconnect" title="Disconnect" onClick={() => void appStore.getState().disconnect()}>
          <Unplug size={14} />
        </button>
      </div>
      {conn.status === "connecting" ? (
        <div className="flex items-center gap-2 p-3 text-muted">
          <LoaderCircle size={14} className="animate-spin" aria-hidden /> Connecting to {profile.host}…
        </div>
      ) : (
        <SchemaTree ref={searchRef} />
      )}
    </aside>
  );
});

const SchemaTree = forwardRef<HTMLInputElement>(function SchemaTree(_props, searchRef) {
  const tree = useApp((s) => s.tree);
  const loading = useApp((s) => s.treeLoading);
  const error = useApp((s) => s.treeError);
  const activeRel = useApp((s) => {
    const t = s.tabs.find((x) => x.id === s.activeTabId);
    if (t?.kind === "table") return `${t.query.schema}\u0000${t.query.table}`;
    if (t?.kind === "structure") return `${t.schema}\u0000${t.table}`;
    return null;
  });
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ x: number; y: number; rel: Relation } | null>(null);
  const filtered = useMemo(() => filterTree(tree, query), [tree, query]);
  const { openTable, openStructure, openSql, loadTree } = appStore.getState();
  const searching = query.trim() !== "";

  const toggle = (name: string) =>
    setCollapsed((cur) => {
      const next = new Set(cur);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  return (
    <>
      <div className="flex shrink-0 items-center gap-1 border-b border-line px-2 py-1.5">
        <div className="relative flex-1">
          <Search size={13} className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-faint" aria-hidden />
          <input
            ref={searchRef}
            className="field h-6 w-full pr-6 pl-7 text-xs"
            placeholder="Filter tables  ⇧⌘F"
            aria-label="Filter tables"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setQuery("");
              if (e.key === "Enter" && filtered[0]?.relations[0]) {
                const r = filtered[0].relations[0];
                openTable(r.schema, r.name);
              }
            }}
            spellCheck={false}
          />
          {query && (
            <button className="absolute top-1/2 right-1 -translate-y-1/2 text-faint hover:text-fg" aria-label="Clear filter" onClick={() => setQuery("")}>
              <X size={13} />
            </button>
          )}
        </div>
        <button className="icon-btn" aria-label="Refresh schema" title="Refresh schema" onClick={() => void loadTree()} disabled={loading}>
          <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
        </button>
      </div>
      <div role="tree" aria-label="Schemas" className="min-h-0 flex-1 overflow-auto py-1 text-[12.5px]">
        {error != null && <ErrorPanel error={error} onRetry={() => void loadTree()} />}
        {loading && tree.length === 0 && <div className="px-3 py-2 text-muted">Loading schemas…</div>}
        {!loading && error == null && filtered.length === 0 && (
          <div className="px-3 py-2 text-xs text-muted">{searching ? `No tables match "${query.trim()}".` : "This database has no user tables."}</div>
        )}
        {filtered.map((s) => {
          const open = searching || !collapsed.has(s.name);
          return (
            <div key={s.name} role="treeitem" aria-expanded={open} aria-selected={false}>
              <button
                className="flex w-full items-center gap-1 px-1.5 py-[3px] text-left text-muted hover:bg-hover"
                onClick={() => toggle(s.name)}
              >
                {open ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
                <span className="truncate font-medium text-fg">{s.name}</span>
                <span className="ml-auto pr-1.5 text-[11px] text-faint tabular-nums">{s.relations.length}</span>
              </button>
              {open && (
                <div role="group">
                  {s.relations.map((r) => {
                    const k = KIND[r.kind];
                    const Icon = k.icon;
                    const active = activeRel === `${r.schema}\u0000${r.name}`;
                    return (
                      <button
                        key={r.name}
                        role="treeitem"
                        aria-selected={active}
                        className={`flex w-full items-center gap-1.5 py-[3px] pr-2 pl-6 text-left ${active ? "bg-accent-soft" : "hover:bg-hover"}`}
                        title={`${k.label} · ${formatBytes(r.sizeBytes)} · ~${r.estRows < 0 ? "never analyzed" : r.estRows.toLocaleString()} rows`}
                        onClick={() => openTable(r.schema, r.name)}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          setMenu({ x: e.clientX, y: e.clientY, rel: r });
                        }}
                      >
                        <Icon size={13} className={r.kind === "table" ? "shrink-0 text-faint" : "shrink-0 text-accent"} aria-label={k.label} />
                        <span className="min-w-0 flex-1 truncate">{r.name}</span>
                        <span className="shrink-0 font-mono text-[11px] text-faint tabular-nums">{formatCount(r.estRows)}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: "Open data", onSelect: () => openTable(menu.rel.schema, menu.rel.name) },
            { label: "Structure", onSelect: () => openStructure(menu.rel.schema, menu.rel.name) },
            { label: "New SQL query", onSelect: () => openSql(selectSql(menu.rel.schema, menu.rel.name)) },
          ]}
        />
      )}
    </>
  );
});
