import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  AppWindow,
  Braces,
  ChevronDown,
  ChevronRight,
  Eye,
  Layers,
  List,
  ListOrdered,
  LoaderCircle,
  Puzzle,
  RefreshCw,
  Search,
  ShieldCheck,
  Sigma,
  SquareFunction,
  SquareStack,
  Table2,
  Unplug,
  Globe,
  Workflow,
  X,
  Zap,
  ZapOff,
  type LucideIcon,
} from "lucide-react";
import { forwardRef, useMemo, useState, type MouseEvent } from "react";
import { errorMessage } from "../api";
import type { FunctionInfo } from "../bindings/FunctionInfo";
import type { FunctionKind } from "../bindings/FunctionKind";
import type { ObjectKind } from "../bindings/ObjectKind";
import type { Relation } from "../bindings/Relation";
import type { RelationKind } from "../bindings/RelationKind";
import type { SchemaNode } from "../bindings/SchemaNode";
import type { TypeKind } from "../bindings/TypeKind";
import { appStore, relationTitle, useApp } from "../store/app";
import { formatBytes, formatCount, quoteIdent, selectSql } from "../store/queries";
import { ColorDot, ConnectionList } from "./ConnectionList";
import { ContextMenu } from "./ContextMenu";
import { ErrorPanel } from "./ErrorPanel";
import { filterExtensions, openObject, sequenceValue, triggerSummary } from "./sidebar/objects";
import { ObjectRow, TreeGroup } from "./sidebar/TreeGroup";

const KIND: Record<RelationKind, { icon: LucideIcon; label: string }> = {
  table: { icon: Table2, label: "table" },
  view: { icon: Eye, label: "view" },
  "materialized-view": { icon: Layers, label: "materialized view" },
  "partitioned-table": { icon: SquareStack, label: "partitioned table" },
  "foreign-table": { icon: Globe, label: "foreign table" },
};

const FUNCTION_KIND: Record<FunctionKind, { icon: LucideIcon; label: string }> = {
  function: { icon: SquareFunction, label: "function" },
  procedure: { icon: Workflow, label: "procedure" },
  aggregate: { icon: Sigma, label: "aggregate function" },
  window: { icon: AppWindow, label: "window function" },
};

const TYPE_KIND: Record<TypeKind, { icon: LucideIcon; label: string }> = {
  enum: { icon: List, label: "enum" },
  domain: { icon: ShieldCheck, label: "domain" },
  composite: { icon: Braces, label: "composite type" },
};

/** `schema.name(identity args)`: unique among overloads and valid after DROP/ALTER FUNCTION. */
export function functionSignature(f: FunctionInfo): string {
  const ident = (name: string) => (/^[a-z_][a-z0-9_$]*$/.test(name) ? name : quoteIdent(name));
  return `${ident(f.schema)}.${ident(f.name)}(${f.args})`;
}

/**
 * Case-insensitive substring match on "schema.name" for every object (triggers match as
 * "schema.table.trigger"); schemas whose name matches keep everything. Schemas with no match
 * are dropped.
 */
export function filterTree(tree: SchemaNode[], query: string): SchemaNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return tree;
  const out: SchemaNode[] = [];
  for (const s of tree) {
    const matches = (name: string) => `${s.name}.${name}`.toLowerCase().includes(q);
    const node: SchemaNode = {
      ...s,
      relations: s.relations.filter((r) => matches(r.name)),
      functions: s.functions.filter((f) => matches(f.name)),
      sequences: s.sequences.filter((x) => matches(x.name)),
      types: s.types.filter((t) => matches(t.name)),
      triggers: s.triggers.filter((t) => matches(`${t.table}.${t.name}`)),
    };
    if (node.relations.length || node.functions.length || node.sequences.length || node.types.length || node.triggers.length) out.push(node);
  }
  return out;
}

export const Sidebar = forwardRef<HTMLInputElement>(function Sidebar(_props, searchRef) {
  const conn = useApp((s) => s.conn);
  const profile = useApp((s) => s.profiles.find((p) => p.id === s.conn?.profileId));
  if (!conn || conn.status === "failed" || !profile) {
    return (
      <aside className="flex w-full flex-col bg-surface">
        <ConnectionList />
      </aside>
    );
  }
  return (
    <aside className="flex w-full flex-col bg-surface">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border pr-1.5 pl-3">
        <ColorDot color={profile.color} />
        <span className="min-w-0 flex-1 truncate font-semibold" title={`${profile.user}@${profile.host}:${profile.port}/${profile.database}`}>
          {profile.name}
        </span>
        {profile.readOnly ? (
          <span className="badge-readonly" title="Session is read-only">
            READ-ONLY
          </span>
        ) : (
          <span className="badge-write" title="Writes are allowed on this connection">
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

/** Object to open from a row, the context menu or Enter in the filter. */
interface Openable {
  kind: ObjectKind;
  oid: number;
  name: string;
  title: string;
}

const SchemaTree = forwardRef<HTMLInputElement>(function SchemaTree(_props, searchRef) {
  const tree = useApp((s) => s.tree);
  const extensions = useApp((s) => s.extensions);
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
  /** Expanded object groups, keyed "group\0schema" ("extensions" at the top); collapsed by default. */
  const [groupsOpen, setGroupsOpen] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<Menu | null>(null);
  const filtered = useMemo(() => filterTree(tree, query), [tree, query]);
  const shownExtensions = useMemo(() => filterExtensions(extensions, query), [extensions, query]);
  const { openTable, openStructure, openSql, openFunction, loadTree } = appStore.getState();
  const searching = query.trim() !== "";

  const toggleIn = (set: typeof setCollapsed, name: string) =>
    set((cur) => {
      const next = new Set(cur);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  const groupOpen = (key: string) => searching || groupsOpen.has(key);
  const menuAt = (e: MouseEvent, target: MenuTarget) => setMenu({ x: e.clientX, y: e.clientY, ...target });
  const open = (o: Openable) => void openObject(o.kind, o.oid, o.name, o.title);

  const openFirstMatch = () => {
    for (const s of filtered) {
      const rel = s.relations[0];
      if (rel) return openTable(rel.schema, rel.name);
      if (s.functions[0]) return void openFunction(s.functions[0]);
      const seq = s.sequences[0];
      if (seq) return open({ kind: "sequence", oid: seq.oid, name: seq.name, title: relationTitle(seq.schema, seq.name) });
      const ty = s.types[0];
      if (ty) return open({ kind: "type", oid: ty.oid, name: ty.name, title: relationTitle(ty.schema, ty.name) });
      const tg = s.triggers[0];
      if (tg) return open({ kind: "trigger", oid: tg.oid, name: tg.name, title: relationTitle(tg.schema, tg.name) });
    }
    const ext = shownExtensions[0];
    if (ext) open({ kind: "extension", oid: ext.oid, name: ext.name, title: ext.name });
  };

  return (
    <>
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
        <div className="relative flex-1">
          <Search size={13} className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-faint" aria-hidden />
          <input
            ref={searchRef}
            className="field h-6 w-full pr-6 pl-7 text-xs"
            placeholder="Filter tables, functions, types…  ⇧⌘F"
            aria-label="Filter schema objects"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setQuery("");
              if (e.key === "Enter") openFirstMatch();
            }}
            spellCheck={false}
          />
          {query && (
            <button className="absolute top-1/2 right-1 -translate-y-1/2 text-faint hover:text-ink" aria-label="Clear filter" onClick={() => setQuery("")}>
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
        {!loading && error == null && filtered.length === 0 && shownExtensions.length === 0 && (
          <div className="px-3 py-2 text-xs text-muted">{searching ? `Nothing matches "${query.trim()}".` : "This database has no user tables."}</div>
        )}
        {shownExtensions.length > 0 && (
          <TreeGroup
            label="Extensions"
            ariaLabel={`Extensions, ${shownExtensions.length}`}
            count={shownExtensions.length}
            open={groupOpen("extensions")}
            depth={0}
            onToggle={() => toggleIn(setGroupsOpen, "extensions")}
          >
            {shownExtensions.map((x) => {
              const target: Openable = { kind: "extension", oid: x.oid, name: x.name, title: x.name };
              return (
                <ObjectRow
                  key={x.oid}
                  icon={Puzzle}
                  kind="extension"
                  name={x.name}
                  value={x.version}
                  title={`extension · version ${x.version} · schema ${x.schema}`}
                  depth={0}
                  onOpen={() => open(target)}
                  onMenu={(e) => menuAt(e, { obj: target, label: "Show definition" })}
                />
              );
            })}
          </TreeGroup>
        )}
        {filtered.map((s) => {
          const schemaOpen = searching || !collapsed.has(s.name);
          const key = (group: string) => `${group}\u0000${s.name}`;
          return (
            <div key={s.name} role="treeitem" aria-expanded={schemaOpen} aria-selected={false}>
              <button
                className="flex w-full items-center gap-1 px-1.5 py-[3px] text-left text-muted hover:bg-surface-2"
                onClick={() => toggleIn(setCollapsed, s.name)}
              >
                {schemaOpen ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
                <span className="truncate font-medium text-ink">{s.name}</span>
                {s.relations.length > 0 && <span className="ml-auto pr-1.5 text-[11px] text-faint tabular-nums">{s.relations.length}</span>}
              </button>
              {schemaOpen && (
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
                        className={`flex w-full items-center gap-1.5 py-[3px] pr-2 pl-6 text-left ${active ? "bg-accent-soft" : "hover:bg-surface-2"}`}
                        title={`${k.label} · ${formatBytes(r.sizeBytes)} · ~${r.estRows < 0 ? "never analyzed" : r.estRows.toLocaleString()} rows`}
                        onClick={() => openTable(r.schema, r.name)}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          setMenu({ x: e.clientX, y: e.clientY, rel: r });
                        }}
                      >
                        <Icon size={13} className={r.kind === "table" ? `shrink-0 ${active ? "text-muted" : "text-faint"}` : "shrink-0 text-accent"} aria-label={k.label} />
                        <span className="min-w-0 flex-1 truncate">{r.name}</span>
                        <span className={`shrink-0 font-mono text-[11px] tabular-nums ${active ? "text-muted" : "text-faint"}`}>{formatCount(r.estRows)}</span>
                      </button>
                    );
                  })}
                  {s.functions.length > 0 && (
                    <TreeGroup
                      label="Functions"
                      ariaLabel={`Functions in ${s.name}, ${s.functions.length}`}
                      count={s.functions.length}
                      open={groupOpen(key("functions"))}
                      depth={1}
                      onToggle={() => toggleIn(setGroupsOpen, key("functions"))}
                    >
                      {s.functions.map((f) => {
                        const k = FUNCTION_KIND[f.kind];
                        const returns = f.result == null ? "" : ` → ${f.result}`;
                        return (
                          <ObjectRow
                            key={f.oid}
                            icon={k.icon}
                            kind={k.label}
                            accent={f.kind !== "function"}
                            name={f.name}
                            detail={`(${f.args})`}
                            title={`${k.label} · ${functionSignature(f)}${returns} · ${f.language}`}
                            depth={1}
                            onOpen={() => void openFunction(f)}
                            onMenu={(e) => menuAt(e, { fn: f })}
                          />
                        );
                      })}
                    </TreeGroup>
                  )}
                  {s.sequences.length > 0 && (
                    <TreeGroup
                      label="Sequences"
                      ariaLabel={`Sequences in ${s.name}, ${s.sequences.length}`}
                      count={s.sequences.length}
                      open={groupOpen(key("sequences"))}
                      depth={1}
                      onToggle={() => toggleIn(setGroupsOpen, key("sequences"))}
                    >
                      {s.sequences.map((x) => {
                        const target: Openable = { kind: "sequence", oid: x.oid, name: x.name, title: relationTitle(x.schema, x.name) };
                        const last = x.readable ? (x.lastValue ?? "not used yet") : "? (no SELECT or USAGE privilege)";
                        return (
                          <ObjectRow
                            key={x.oid}
                            icon={ListOrdered}
                            kind="sequence"
                            name={x.name}
                            value={sequenceValue(x)}
                            title={`sequence · ${x.dataType} · last value ${last}`}
                            depth={1}
                            onOpen={() => open(target)}
                            onMenu={(e) => menuAt(e, { obj: target, label: "Open query" })}
                          />
                        );
                      })}
                    </TreeGroup>
                  )}
                  {s.types.length > 0 && (
                    <TreeGroup
                      label="Types"
                      ariaLabel={`Types in ${s.name}, ${s.types.length}`}
                      count={s.types.length}
                      open={groupOpen(key("types"))}
                      depth={1}
                      onToggle={() => toggleIn(setGroupsOpen, key("types"))}
                    >
                      {s.types.map((t) => {
                        const k = TYPE_KIND[t.kind];
                        const target: Openable = { kind: "type", oid: t.oid, name: t.name, title: relationTitle(t.schema, t.name) };
                        return (
                          <ObjectRow
                            key={t.oid}
                            icon={k.icon}
                            kind={k.label}
                            accent={t.kind !== "enum"}
                            name={t.name}
                            detail={t.detail}
                            title={`${k.label} · ${t.detail}`}
                            depth={1}
                            onOpen={() => open(target)}
                            onMenu={(e) => menuAt(e, { obj: target, label: "Show definition" })}
                          />
                        );
                      })}
                    </TreeGroup>
                  )}
                  {s.triggers.length > 0 && (
                    <TreeGroup
                      label="Triggers"
                      ariaLabel={`Triggers in ${s.name}, ${s.triggers.length}`}
                      count={s.triggers.length}
                      open={groupOpen(key("triggers"))}
                      depth={1}
                      onToggle={() => toggleIn(setGroupsOpen, key("triggers"))}
                    >
                      {s.triggers.map((t) => {
                        const target: Openable = { kind: "trigger", oid: t.oid, name: t.name, title: relationTitle(t.schema, t.name) };
                        const summary = `${triggerSummary(t)}${t.enabled ? "" : " · disabled"}`;
                        return (
                          <ObjectRow
                            key={t.oid}
                            icon={t.enabled ? Zap : ZapOff}
                            kind={t.enabled ? "trigger" : "disabled trigger"}
                            name={`${t.table}.${t.name}`}
                            detail={summary}
                            title={`trigger on ${t.table} · ${summary} · executes ${t.function}()`}
                            depth={1}
                            onOpen={() => open(target)}
                            onMenu={(e) => menuAt(e, { obj: target, label: "Show definition" })}
                          />
                        );
                      })}
                    </TreeGroup>
                  )}
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
          items={
            "rel" in menu
              ? [
                  { label: "Open data", onSelect: () => openTable(menu.rel.schema, menu.rel.name) },
                  { label: "Structure", onSelect: () => openStructure(menu.rel.schema, menu.rel.name) },
                  { label: "New SQL query", onSelect: () => openSql(selectSql(menu.rel.schema, menu.rel.name)) },
                ]
              : "fn" in menu
                ? [
                    { label: "Show definition", onSelect: () => void openFunction(menu.fn) },
                    { separator: true },
                    { label: "Copy name", onSelect: () => void copy(menu.fn.name) },
                    { label: "Copy signature", onSelect: () => void copy(functionSignature(menu.fn)) },
                  ]
                : [
                    { label: menu.label, onSelect: () => open(menu.obj) },
                    { separator: true },
                    { label: "Copy name", onSelect: () => void copy(menu.obj.name) },
                  ]
          }
        />
      )}
    </>
  );
});

type MenuTarget = { rel: Relation } | { fn: FunctionInfo } | { obj: Openable; label: string };
type Menu = { x: number; y: number } & MenuTarget;

async function copy(text: string) {
  try {
    await writeText(text);
  } catch (e) {
    appStore.getState().pushToast("error", `Copy failed: ${errorMessage(e)}`);
  }
}
