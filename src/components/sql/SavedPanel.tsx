// Saved queries for the SQL editor: the Save dialog and the Saved drawer (same layout as HistoryPanel).
import { useEffect, useMemo, useState, type MouseEvent } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Bookmark, Globe, MoreHorizontal, Search, X } from "lucide-react";
import { api, errorMessage } from "../../api";
import type { SavedQuery } from "../../bindings/SavedQuery";
import { appStore } from "../../store/app";
import { ContextMenu } from "../ContextMenu";
import { Dialog } from "../Dialog";

export const SAVED_NAME_MAX = 200;

/** Case-insensitive match on name or SQL text; the list keeps the server's name order. */
export function filterSaved(queries: SavedQuery[], search: string): SavedQuery[] {
  const q = search.trim().toLowerCase();
  if (!q) return queries;
  return queries.filter((s) => s.name.toLowerCase().includes(q) || s.sql.toLowerCase().includes(q));
}

/** First non-empty line of the SQL, for the list. */
export function firstLine(sql: string): string {
  return sql.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
}

interface SaveDialogProps {
  title: string;
  initialName: string;
  initialGlobal: boolean;
  confirmLabel: string;
  /** Hide the "All connections" checkbox (rename keeps the scope). */
  showScope?: boolean;
  onSave: (name: string, global: boolean) => Promise<void>;
  onClose: () => void;
}

export function SaveQueryDialog({ title, initialName, initialGlobal, confirmLabel, showScope = true, onSave, onClose }: SaveDialogProps) {
  const [name, setName] = useState(initialName);
  const [global, setGlobal] = useState(initialGlobal);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = name.trim();
  const tooLong = [...trimmed].length > SAVED_NAME_MAX;

  const submit = async () => {
    if (!trimmed || tooLong || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(trimmed, global);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={title}
      onClose={onClose}
      width="w-[400px]"
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!trimmed || tooLong || busy} onClick={() => void submit()}>
            {confirmLabel}
          </button>
        </>
      }
    >
      <label htmlFor="saved-name" className="mb-1.5 block text-xs text-muted">
        Name
      </label>
      <input
        id="saved-name"
        autoFocus
        className="field w-full"
        value={name}
        maxLength={SAVED_NAME_MAX + 50}
        onChange={(e) => setName(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => {
          if (e.key === "Enter") void submit();
        }}
        spellCheck={false}
      />
      {tooLong && <p className="mt-1.5 text-xs text-error">Names can be at most {SAVED_NAME_MAX} characters.</p>}
      {showScope && (
        <label className="mt-3 flex items-center gap-2">
          <input id="saved-global" type="checkbox" checked={global} onChange={(e) => setGlobal(e.target.checked)} className="size-3.5 accent-accent" />
          All connections
          <span className="text-xs text-muted">(otherwise only this one)</span>
        </label>
      )}
      {error && (
        <p role="alert" className="mt-3 text-pretty text-error">
          {error}
        </p>
      )}
    </Dialog>
  );
}

interface SavedPanelProps {
  connId: string;
  /** Bumped by the parent after each save so the list refreshes. */
  version: number;
  onOpen: (query: SavedQuery) => void;
  /** A query was renamed or deleted (null = deleted), so tabs linked to it can follow. */
  onChanged: (id: string, saved: SavedQuery | null) => void;
  onClose: () => void;
}

export function SavedPanel({ connId, version, onOpen, onChanged, onClose }: SavedPanelProps) {
  const [search, setSearch] = useState("");
  const [queries, setQueries] = useState<SavedQuery[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [menu, setMenu] = useState<{ x: number; y: number; query: SavedQuery } | null>(null);
  const [renaming, setRenaming] = useState<SavedQuery | null>(null);

  useEffect(() => {
    let stale = false;
    api
      .listSavedQueries(connId)
      .then((list) => {
        if (stale) return;
        setQueries(list);
        setLoadError(null);
      })
      .catch((e) => !stale && setLoadError(errorMessage(e)));
    return () => {
      stale = true;
    };
  }, [connId, version, reload]);

  const shown = useMemo(() => filterSaved(queries, search), [queries, search]);

  const openMenu = (e: MouseEvent, query: SavedQuery) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, query });
  };

  const remove = async (query: SavedQuery) => {
    const confirmed = await ask(`Delete the saved query “${query.name}”? This cannot be undone.`, {
      title: "Delete saved query",
      kind: "warning",
      okLabel: "Delete",
      cancelLabel: "Cancel",
    });
    if (!confirmed) return;
    try {
      await api.deleteSavedQuery(query.id);
      onChanged(query.id, null);
      setReload((n) => n + 1);
    } catch (e) {
      setLoadError(errorMessage(e));
    }
  };

  const copySql = async (query: SavedQuery) => {
    try {
      await writeText(query.sql);
      appStore.getState().pushToast("info", `Copied the SQL of “${query.name}”`);
    } catch (e) {
      appStore.getState().pushToast("error", `Copy failed: ${errorMessage(e)}`);
    }
  };

  return (
    <aside aria-label="Saved queries" className="flex h-full w-96 shrink-0 flex-col border-l border-border bg-surface">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-2">
        <span className="font-medium">Saved</span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={onClose}
          aria-label="Close saved queries"
          className="flex size-6 items-center justify-center rounded text-muted hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-focus-ring"
        >
          <X className="size-3.5" />
        </button>
      </div>
      <div className="shrink-0 border-b border-border p-2">
        <label className="flex h-7 items-center gap-1.5 rounded border border-border-strong bg-paper px-2 focus-within:border-focus-ring">
          <Search className="size-3.5 shrink-0 text-faint" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search saved queries"
            aria-label="Search saved queries"
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-faint"
          />
        </label>
      </div>
      {loadError && <p className="shrink-0 px-3 py-2 text-pretty text-error">{loadError}</p>}
      <ul className="min-h-0 flex-1 overflow-y-auto">
        {shown.length === 0 && !loadError && (
          <li className="flex flex-col items-center gap-2 px-6 py-6 text-center text-pretty text-muted">
            {search.trim() ? (
              "No saved queries match this search."
            ) : (
              <>
                <Bookmark className="size-4 text-faint" aria-hidden />
                Save the editor's SQL with ⌘S. Queries saved here, or for all connections, appear in this list.
              </>
            )}
          </li>
        )}
        {shown.map((query) => (
          <li key={query.id} className="group relative" onContextMenu={(e) => openMenu(e, query)}>
            <button
              type="button"
              title={query.sql}
              onClick={() => onOpen(query)}
              className="flex w-full flex-col gap-0.5 border-b border-border py-1.5 pr-9 pl-3 text-left hover:bg-row-highlight focus-visible:bg-row-highlight focus-visible:outline-none"
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate font-medium text-ink">{query.name}</span>
                {query.connId === null && <Globe className="size-3 shrink-0 text-faint" aria-label="All connections" />}
              </span>
              <code className="truncate font-mono text-xs text-muted">{firstLine(query.sql) || "(empty)"}</code>
            </button>
            <button
              type="button"
              aria-label={`Actions for ${query.name}`}
              onClick={(e) => openMenu(e, query)}
              className="icon-btn absolute top-1/2 right-1.5 size-6 -translate-y-1/2 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            >
              <MoreHorizontal className="size-3.5" />
            </button>
          </li>
        ))}
      </ul>
      <p className="shrink-0 border-t border-border px-3 py-1.5 text-xs text-muted">Click to open in a new tab · right-click for more</p>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: "Open in new tab", onSelect: () => onOpen(menu.query) },
            { label: "Rename…", onSelect: () => setRenaming(menu.query) },
            { label: "Copy SQL", onSelect: () => void copySql(menu.query) },
            { separator: true },
            { label: "Delete…", onSelect: () => void remove(menu.query) },
          ]}
        />
      )}
      {renaming && (
        <SaveQueryDialog
          title="Rename saved query"
          confirmLabel="Rename"
          initialName={renaming.name}
          initialGlobal={renaming.connId === null}
          showScope={false}
          onClose={() => setRenaming(null)}
          onSave={async (name) => {
            const saved = await api.saveQuery({ id: renaming.id, connId: renaming.connId, name, sql: renaming.sql });
            setRenaming(null);
            onChanged(saved.id, saved);
            setReload((n) => n + 1);
          }}
        />
      )}
    </aside>
  );
}
