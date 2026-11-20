// Query history drawer for the SQL editor. Lists api.listHistory newest first.
import { useEffect, useRef, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { Search, Trash2, X } from "lucide-react";
import { api, errorMessage } from "../../api";
import type { HistoryEntry } from "../../bindings/HistoryEntry";
import { formatElapsed, timeAgo } from "../../lib/sqlResult";

interface HistoryPanelProps {
  connId: string;
  /** Bumped by the parent after each run so the list refreshes. */
  version: number;
  onInsert: (sql: string) => void;
  onRun: (sql: string) => void;
  onClose: () => void;
}

/** Delay before a single click inserts, so a double-click does not also insert. */
const CLICK_DELAY_MS = 220;

export function HistoryPanel({ connId, version, onInsert, onRun, onClose }: HistoryPanelProps) {
  const [search, setSearch] = useState("");
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [cleared, setCleared] = useState(0);
  const clickTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    let stale = false;
    const timer = window.setTimeout(() => {
      api
        .listHistory(connId, search.trim() || null, 500)
        .then((list) => {
          if (stale) return;
          setEntries(list);
          setLoadError(null);
        })
        .catch((e) => !stale && setLoadError(errorMessage(e)));
    }, 150);
    return () => {
      stale = true;
      window.clearTimeout(timer);
    };
  }, [connId, search, version, cleared]);

  useEffect(() => () => window.clearTimeout(clickTimer.current), []);

  const clear = async () => {
    const confirmed = await ask("Delete the saved query history for all connections? This cannot be undone.", {
      title: "Clear history",
      kind: "warning",
      okLabel: "Clear history",
      cancelLabel: "Cancel",
    });
    if (!confirmed) return;
    try {
      await api.clearHistory();
      setCleared((n) => n + 1);
    } catch (e) {
      setLoadError(errorMessage(e));
    }
  };

  return (
    <aside className="flex h-full w-96 shrink-0 flex-col border-l border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-900">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-neutral-200 px-2 dark:border-neutral-800">
        <span className="font-medium">History</span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={clear}
          className="flex h-6 items-center gap-1 rounded px-1.5 text-neutral-600 hover:bg-neutral-200 focus-visible:outline-2 focus-visible:outline-blue-500 dark:text-neutral-400 dark:hover:bg-neutral-800"
        >
          <Trash2 className="size-3.5" />
          Clear
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close history"
          className="flex size-6 items-center justify-center rounded text-neutral-600 hover:bg-neutral-200 focus-visible:outline-2 focus-visible:outline-blue-500 dark:text-neutral-400 dark:hover:bg-neutral-800"
        >
          <X className="size-3.5" />
        </button>
      </div>
      <div className="shrink-0 border-b border-neutral-200 p-2 dark:border-neutral-800">
        <label className="flex h-7 items-center gap-1.5 rounded border border-neutral-300 bg-white px-2 focus-within:border-blue-500 dark:border-neutral-700 dark:bg-neutral-950">
          <Search className="size-3.5 shrink-0 text-neutral-400" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search history"
            aria-label="Search history"
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-neutral-400"
          />
        </label>
      </div>
      {loadError && <p className="shrink-0 px-3 py-2 text-pretty text-red-600 dark:text-red-400">{loadError}</p>}
      <ul className="min-h-0 flex-1 overflow-y-auto">
        {entries.length === 0 && !loadError && (
          <li className="px-3 py-6 text-center text-pretty text-neutral-500">
            {search.trim() ? "No queries match this search." : "Queries you run on this connection appear here."}
          </li>
        )}
        {entries.map((entry) => (
          <li key={entry.id}>
            <button
              type="button"
              title={entry.error ?? entry.sql}
              onClick={() => {
                window.clearTimeout(clickTimer.current);
                clickTimer.current = window.setTimeout(() => onInsert(entry.sql), CLICK_DELAY_MS);
              }}
              onDoubleClick={() => {
                window.clearTimeout(clickTimer.current);
                onRun(entry.sql);
              }}
              className="flex w-full flex-col gap-0.5 border-b border-neutral-200 px-3 py-1.5 text-left hover:bg-neutral-200/60 focus-visible:bg-blue-500/10 focus-visible:outline-none dark:border-neutral-800 dark:hover:bg-neutral-800/60"
            >
              <code className="truncate font-mono text-xs text-neutral-900 dark:text-neutral-100">
                {entry.sql.replace(/\s+/g, " ").trim()}
              </code>
              <span className="flex items-center gap-2 text-xs text-neutral-500 tabular-nums">
                <span>{timeAgo(entry.executedAt)}</span>
                <span>{formatElapsed(entry.elapsedMs)}</span>
                {entry.error && (
                  <span className="rounded bg-red-100 px-1 text-red-700 dark:bg-red-950 dark:text-red-300">error</span>
                )}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <p className="shrink-0 border-t border-neutral-200 px-3 py-1.5 text-xs text-neutral-500 dark:border-neutral-800">
        Click to insert · double-click to run
      </p>
    </aside>
  );
}
