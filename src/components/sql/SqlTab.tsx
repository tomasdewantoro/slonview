// SQL editor tab. Owned by WP-FE-SQL. Rendered by App for tabs with kind "sql".
import { useCallback, useEffect, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";
import { History, ListVideo, LoaderCircle, Play, Square } from "lucide-react";
import { api, isAppError, newRequestId } from "../../api";
import type { SchemaNode } from "../../bindings/SchemaNode";
import { formatElapsed } from "../../lib/sqlResult";
import { pgPositionToOffset, statementAt } from "../../lib/sqlSplit";
import { HistoryPanel } from "./HistoryPanel";
import { ResultsPanel, type RunOutcome } from "./ResultsPanel";
import { clearSqlError, markSqlError, SqlEditor, type RunMode } from "./SqlEditor";

export interface SqlTabProps {
  tabId: string;
  connId: string;
  /** For autocomplete; may be empty while loading. */
  schema: SchemaNode[];
  /** Initial SQL when the tab is created (e.g. "SELECT * FROM ..."). */
  initialSql?: string;
}

const MAX_ROWS_OPTIONS = [1000, 10000, 100000];
const MAX_ROWS_KEY = "slonview.sql.maxRows";
const SPLIT_KEY = "slonview.sql.split";

interface Running {
  requestId: string;
  startedAt: number;
}

/** Where the executed text sits in the editor, so an error position can be mapped back. */
interface Executed {
  text: string;
  /** Doc offset of `text[0]`, or null when the text did not come from the editor (history run). */
  docOffset: number | null;
  /** Full doc at run time; the error is only marked if the doc is unchanged. */
  doc: string;
}

function storedNumber(key: string, fallback: number, valid: (n: number) => boolean): number {
  const n = Number(localStorage.getItem(key));
  return valid(n) ? n : fallback;
}

export function SqlTab({ tabId, connId, schema, initialSql }: SqlTabProps) {
  const viewRef = useRef<EditorView | null>(null);
  const [running, setRunning] = useState<Running | null>(null);
  const runningRef = useRef<Running | null>(null);
  const [now, setNow] = useState(0);
  const [outcome, setOutcome] = useState<RunOutcome | null>(null);
  const [maxRows, setMaxRows] = useState(() => storedNumber(MAX_ROWS_KEY, 10000, (n) => MAX_ROWS_OPTIONS.includes(n)));
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyVersion, setHistoryVersion] = useState(0);
  const [split, setSplit] = useState(() => storedNumber(SPLIT_KEY, 0.45, (n) => n >= 0.1 && n <= 0.9));
  const splitRef = useRef<HTMLDivElement>(null);
  const runCounter = useRef(0);

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, [running]);

  // Cancel an in-flight query when the tab closes.
  useEffect(
    () => () => {
      if (runningRef.current) api.cancelQuery(runningRef.current.requestId).catch(() => {});
    },
    [],
  );

  const execute = useCallback(
    async (executed: Executed) => {
      if (runningRef.current || executed.text.trim() === "") return;
      const run: Running = { requestId: newRequestId(), startedAt: Date.now() };
      const runId = ++runCounter.current;
      runningRef.current = run;
      setRunning(run);
      setNow(run.startedAt);
      if (viewRef.current) clearSqlError(viewRef.current);
      try {
        const results = await api.runSql(run.requestId, connId, executed.text, maxRows);
        setOutcome({ kind: "results", runId, results, maxRows });
      } catch (e) {
        const error = isAppError(e) ? e : e instanceof Error ? e : new Error(String(e));
        setOutcome({ kind: "error", runId, error });
        const view = viewRef.current;
        if (
          view &&
          "kind" in error &&
          (error.kind === "sql" || error.kind === "invalid") &&
          error.position != null &&
          executed.docOffset !== null &&
          view.state.doc.toString() === executed.doc
        ) {
          const from = executed.docOffset + pgPositionToOffset(executed.text, error.position);
          const tokenEnd = /^[\p{L}\p{N}_$]+/u.exec(executed.doc.slice(from))?.[0].length ?? 1;
          markSqlError(view, from, Math.min(from + Math.max(tokenEnd, 1), executed.doc.length));
        }
      } finally {
        runningRef.current = null;
        setRunning(null);
        setHistoryVersion((v) => v + 1);
      }
    },
    [connId, maxRows],
  );

  const runFromEditor = useCallback(
    (mode: RunMode) => {
      const view = viewRef.current;
      if (!view) return;
      const doc = view.state.doc.toString();
      const sel = view.state.selection.main;
      if (mode === "all") {
        execute({ text: doc, docOffset: 0, doc });
      } else if (!sel.empty) {
        execute({ text: doc.slice(sel.from, sel.to), docOffset: sel.from, doc });
      } else {
        const stmt = statementAt(doc, sel.head);
        if (stmt) execute({ text: stmt.text, docOffset: stmt.start, doc });
      }
    },
    [execute],
  );

  const cancel = useCallback(() => {
    if (!runningRef.current) return false;
    api.cancelQuery(runningRef.current.requestId).catch(() => {});
    return true;
  }, []);

  const insertSql = useCallback((sql: string) => {
    const view = viewRef.current;
    if (!view) return;
    const sel = view.state.selection.main;
    if (!sel.empty) {
      view.dispatch(view.state.replaceSelection(sql));
    } else {
      const doc = view.state.doc;
      const sep = doc.length === 0 ? "" : doc.toString().endsWith("\n") ? "\n" : "\n\n";
      const insert = sep + sql;
      view.dispatch({
        changes: { from: doc.length, insert },
        selection: { anchor: doc.length + sep.length, head: doc.length + insert.length },
        scrollIntoView: true,
      });
    }
    view.focus();
  }, []);

  const startDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const container = splitRef.current;
    if (!container) return;
    e.preventDefault();
    const rect = container.getBoundingClientRect();
    const divider = e.currentTarget;
    divider.setPointerCapture(e.pointerId);
    let latest = split;
    const move = (ev: PointerEvent) => {
      latest = Math.min(0.9, Math.max(0.1, (ev.clientY - rect.top) / rect.height));
      setSplit(latest);
    };
    const up = () => {
      divider.removeEventListener("pointermove", move);
      divider.removeEventListener("pointerup", up);
      divider.removeEventListener("pointercancel", up);
      localStorage.setItem(SPLIT_KEY, String(latest));
    };
    divider.addEventListener("pointermove", move);
    divider.addEventListener("pointerup", up);
    divider.addEventListener("pointercancel", up);
  };

  const toolbarButton =
    "flex h-6 items-center gap-1 rounded px-2 hover:bg-neutral-200 focus-visible:outline-2 focus-visible:outline-blue-500 disabled:opacity-40 disabled:hover:bg-transparent dark:hover:bg-neutral-800";

  return (
    <div className="flex h-full min-h-0 bg-white text-[13px] text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-9 shrink-0 items-center gap-1 border-b border-neutral-200 bg-neutral-50 px-2 dark:border-neutral-800 dark:bg-neutral-900">
          <button
            type="button"
            className={toolbarButton}
            disabled={!!running}
            onClick={() => runFromEditor("cursor")}
            title="Run selection or statement at cursor (⌘↵)"
          >
            <Play className="size-3.5 text-emerald-600 dark:text-emerald-400" />
            Run
          </button>
          <button
            type="button"
            className={toolbarButton}
            disabled={!!running}
            onClick={() => runFromEditor("all")}
            title="Run the whole editor (⇧⌘↵)"
          >
            <ListVideo className="size-3.5" />
            Run all
          </button>
          {running && (
            <>
              <button type="button" className={`${toolbarButton} text-red-600 dark:text-red-400`} onClick={cancel} title="Cancel query (Esc)">
                <Square className="size-3.5 fill-current" />
                Cancel
              </button>
              <span className="flex items-center gap-1 px-1 text-neutral-500 tabular-nums">
                <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" />
                {formatElapsed(Math.max(0, now - running.startedAt))}
              </span>
            </>
          )}
          <span className="flex-1" />
          <label className="flex items-center gap-1.5 text-neutral-600 dark:text-neutral-400">
            Max rows
            <select
              value={maxRows}
              onChange={(e) => {
                const n = Number(e.target.value);
                setMaxRows(n);
                localStorage.setItem(MAX_ROWS_KEY, String(n));
              }}
              className="h-6 rounded border border-neutral-300 bg-white px-1 text-neutral-900 tabular-nums focus-visible:outline-2 focus-visible:outline-blue-500 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
            >
              {MAX_ROWS_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n.toLocaleString()}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className={`${toolbarButton} ${historyOpen ? "bg-neutral-200 dark:bg-neutral-800" : ""}`}
            aria-pressed={historyOpen}
            onClick={() => setHistoryOpen((o) => !o)}
          >
            <History className="size-3.5" />
            History
          </button>
        </div>
        <div ref={splitRef} className="flex min-h-0 flex-1 flex-col">
          <div style={{ height: `${split * 100}%` }} className="min-h-0 shrink-0">
            <SqlEditor
              viewRef={viewRef}
              storageKey={`slonview.sql.${tabId}`}
              initialSql={initialSql ?? ""}
              schema={schema}
              onRun={runFromEditor}
              onCancel={cancel}
            />
          </div>
          <div
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize editor and results"
            onPointerDown={startDrag}
            className="h-1 shrink-0 cursor-row-resize border-y border-neutral-200 bg-neutral-100 hover:bg-blue-500/40 dark:border-neutral-800 dark:bg-neutral-900"
          />
          <div className="min-h-0 flex-1">
            <ResultsPanel connId={connId} outcome={outcome} running={!!running} />
          </div>
        </div>
      </div>
      {historyOpen && (
        <HistoryPanel
          connId={connId}
          version={historyVersion}
          onInsert={insertSql}
          onRun={(sql) => execute({ text: sql, docOffset: null, doc: "" })}
          onClose={() => setHistoryOpen(false)}
        />
      )}
    </div>
  );
}
