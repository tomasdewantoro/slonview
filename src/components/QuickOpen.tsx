import { ListOrdered, Puzzle, Search, Zap, ZapOff, type LucideIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { ExtensionInfo } from "../bindings/ExtensionInfo";
import type { SchemaNode } from "../bindings/SchemaNode";
import { quickOpenItems, rankQuickOpen, type QuickOpenItem } from "../lib/quickOpen";
import { appStore, functionTitle, relationTitle, useApp } from "../store/app";
import { FUNCTION_KIND, KIND, TYPE_KIND } from "./Sidebar";

const NO_TREE: SchemaNode[] = [];
const NO_EXTENSIONS: ExtensionInfo[] = [];

/** Sidebar icon and label of an item's kind. */
function kindOf(item: QuickOpenItem): { icon: LucideIcon; label: string } {
  switch (item.kind) {
    case "relation":
      return KIND[item.relation.kind];
    case "function":
      return FUNCTION_KIND[item.fn.kind];
    case "sequence":
      return { icon: ListOrdered, label: "sequence" };
    case "type":
      return TYPE_KIND[item.type.kind];
    case "trigger":
      return item.trigger.enabled ? { icon: Zap, label: "trigger" } : { icon: ZapOff, label: "disabled trigger" };
    case "extension":
      return { icon: Puzzle, label: "extension" };
  }
}

/** Opens an item pinned, as a double-click in the sidebar does; `structure` opens a relation's Structure tab. */
function openItem(item: QuickOpenItem, structure: boolean) {
  const s = appStore.getState();
  const title = relationTitle(item.schema, item.name);
  switch (item.kind) {
    case "relation":
      if (structure) s.openStructure(item.schema, item.name, "pinned");
      else s.openTable(item.schema, item.name, "pinned");
      return;
    case "function":
      void s.openFunction(item.fn, "pinned");
      return;
    case "sequence":
      void s.openObject("sequence", item.sequence.oid, item.name, title, "pinned");
      return;
    case "type":
      void s.openObject("type", item.type.oid, item.name, title, "pinned");
      return;
    case "trigger":
      void s.openObject("trigger", item.trigger.oid, item.trigger.name, relationTitle(item.schema, item.trigger.name), "pinned");
      return;
    case "extension":
      void s.openObject("extension", item.extension.oid, item.name, item.name, "pinned");
      return;
  }
}

/** ⌘P palette over the sidebar connection's loaded schema tree. */
export function QuickOpen({ connId, onClose }: { connId: string; onClose: () => void }) {
  const tree = useApp((s) => s.conns[connId]?.tree ?? NO_TREE);
  const extensions = useApp((s) => s.conns[connId]?.extensions ?? NO_EXTENSIONS);
  const profileName = useApp((s) => s.profiles.find((p) => p.id === connId)?.name ?? "connection");
  const items = useMemo(() => quickOpenItems(tree, extensions), [tree, extensions]);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const results = useMemo(() => rankQuickOpen(items, query), [items, query]);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Captured during the first render: by the time effects run, autoFocus has moved focus already.
  const [previous] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  useEffect(() => {
    // Unmounting removes the dialog without close(), so return focus to where it was ourselves.
    const d = dialogRef.current;
    if (d && !d.open) d.showModal();
    return () => previous?.focus();
  }, [previous]);
  useEffect(() => setActive(0), [query]);
  useLayoutEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = (item: QuickOpenItem | undefined, structure: boolean) => {
    if (!item) return;
    onClose();
    openItem(item, structure);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    // App shortcuts listen on window; keep keys typed here from reaching the grid or the editor.
    e.stopPropagation();
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (results.length) setActive((i) => (i + (e.key === "ArrowDown" ? 1 : results.length - 1)) % results.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = results[active];
      choose(item, e.metaKey && item?.kind === "relation");
    }
  };

  const optionId = (i: number) => `quick-open-option-${i}`;

  return (
    <dialog
      ref={dialogRef}
      aria-label={`Quick open: ${profileName}`}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === dialogRef.current) onClose();
      }}
      onKeyDown={onKeyDown}
      className="mx-auto mt-[12dvh] mb-auto w-[560px] max-w-[calc(100vw-32px)] overflow-hidden rounded-[var(--sv-radius-dialog)] border border-border bg-raised p-0 text-ink shadow-xl backdrop:bg-scrim"
    >
      <div className="flex items-center gap-2 border-b border-border px-3">
        <Search size={14} className="shrink-0 text-faint" aria-hidden />
        <input
          autoFocus
          role="combobox"
          aria-label="Find a table, view, function or other object"
          aria-expanded="true"
          aria-controls="quick-open-list"
          aria-activedescendant={results.length ? optionId(active) : undefined}
          aria-autocomplete="list"
          className="h-11 min-w-0 flex-1 bg-transparent text-sm"
          // The dialog itself shows focus; the global :focus-visible ring would box the text.
          style={{ outline: "none" }}
          placeholder="Go to table, view, function…"
          value={query}
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className="shrink-0 text-[11px] text-faint">{profileName}</span>
      </div>
      <ul id="quick-open-list" ref={listRef} role="listbox" aria-label="Matching objects" className="max-h-[min(420px,55dvh)] overflow-auto py-1">
        {results.map((item, i) => {
          const k = kindOf(item);
          const Icon = k.icon;
          const selected = i === active;
          const name = item.kind === "function" ? functionTitle({ schema: "public", name: item.name, args: item.fn.args }, 48) : item.name;
          return (
            <li
              key={item.key}
              id={optionId(i)}
              data-index={i}
              role="option"
              aria-selected={selected}
              className={`mx-1 flex h-7 cursor-default items-center gap-2 rounded-md px-2 ${selected ? "bg-accent text-accent-fg" : "hover:bg-surface-2"}`}
              onMouseMove={() => setActive(i)}
              onClick={(e) => choose(item, e.metaKey && item.kind === "relation")}
            >
              <Icon size={13} className={`shrink-0 ${selected ? "text-accent-fg" : "text-faint"}`} aria-label={k.label} />
              <span className="min-w-0 truncate font-mono text-xs">{name}</span>
              {item.schema !== "public" && <span className={`shrink-0 truncate text-[11px] ${selected ? "text-accent-fg-muted" : "text-muted"}`}>{item.schema}</span>}
              <span className="flex-1" />
              <span className={`shrink-0 text-[11px] ${selected ? "text-accent-fg-muted" : "text-faint"}`}>{k.label}</span>
            </li>
          );
        })}
        {results.length === 0 && <li className="px-3 py-3 text-xs text-muted">{items.length === 0 ? "The schema tree is still loading." : `Nothing matches “${query.trim()}”.`}</li>}
      </ul>
      <div className="flex gap-4 border-t border-border px-3 py-1.5 text-[11px] text-faint">
        <span>↑↓ move</span>
        <span>↵ open</span>
        <span>⌘↵ structure</span>
        <span>esc close</span>
      </div>
    </dialog>
  );
}
