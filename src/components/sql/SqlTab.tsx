// SQL editor tab. Owned by WP-FE-SQL. Rendered by App for tabs with kind "sql".
import { useCallback, useEffect, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";
import { History, ListTree, ListVideo, LoaderCircle, Play, Square, WandSparkles } from "lucide-react";
import { api, isAppError, newRequestId } from "../../api";
import type { SchemaNode } from "../../bindings/SchemaNode";
import { isDataModifying } from "../../lib/plan";
import { formatElapsed } from "../../lib/sqlResult";
import { pgPositionToOffset, statementAt } from "../../lib/sqlSplit";
import { appStore, sqlEditorKey, useApp, wasTabDisposed } from "../../store/app";
import { ConfirmDialog } from "../Dialog";
import { HistoryPanel } from "./HistoryPanel";
import { ResultsPanel, type RunOutcome } from "./ResultsPanel";
import { clearSqlError, formatSqlInEditor, markSqlError, SqlEditor, type RunMode } from "./SqlEditor";
import { useColumnIndex } from "./useColumnIndex";

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
const ANALYZE_KEY = "slonview.sql.explainAnalyze";

/** What a request does with the text: run it, or EXPLAIN it (ANALYZE executes and rolls back). */
type Action = { kind: "run" } | { kind: "explain"; analyze: boolean };

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
  const [analyze, setAnalyze] = useState(() => localStorage.getItem(ANALYZE_KEY) === "1");
  /** ANALYZE of a data-modifying statement waiting for confirmation (allow-writes profiles). */
  const [confirmAnalyze, setConfirmAnalyze] = useState<Executed | null>(null);
  const readOnly = useApp((s) => s.profiles.find((p) => p.id === connId)?.readOnly ?? true);
  const columns = useColumnIndex(connId, schema);
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
    async (executed: Executed, action: Action = { kind: "run" }) => {
      if (runningRef.current || executed.text.trim() === "") return;
      appStore.getState().pinTab(tabId);
      const run: Running = { requestId: newRequestId(), startedAt: Date.now() };
      const runId = ++runCounter.current;
      runningRef.current = run;
      setRunning(run);
      setNow(run.startedAt);
      if (viewRef.current) clearSqlError(viewRef.current);
      try {
        if (action.kind === "explain") {
          const result = await api.explain(run.requestId, connId, executed.text, action.analyze);
          setOutcome({ kind: "plan", runId, result });
        } else {
          const results = await api.runSql(run.requestId, connId, executed.text, maxRows);
          setOutcome({ kind: "results", runId, results, maxRows });
        }
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
        if (action.kind === "run") setHistoryVersion((v) => v + 1);
      }
    },
    [connId, maxRows, tabId],
  );

  /** Selection, else the statement at the cursor, else nothing. */
  const editorText = useCallback((): Executed | null => {
    const view = viewRef.current;
    if (!view) return null;
    const doc = view.state.doc.toString();
    const sel = view.state.selection.main;
    if (!sel.empty) return { text: doc.slice(sel.from, sel.to), docOffset: sel.from, doc };
    const stmt = statementAt(doc, sel.head);
    return stmt ? { text: stmt.text, docOffset: stmt.start, doc } : null;
  }, []);

  const runFromEditor = useCallback(
    (mode: RunMode) => {
      const view = viewRef.current;
      if (!view) return;
      if (mode === "all") {
        const doc = view.state.doc.toString();
        execute({ text: doc, docOffset: 0, doc });
      } else {
        const target = editorText();
        if (target) execute(target);
      }
    },
    [execute, editorText],
  );

  const explainFromEditor = useCallback(() => {
    const target = editorText();
    if (!target || runningRef.current) return;
    // Read-only profiles run ANALYZE in a READ ONLY transaction, so a write just fails there.
    if (analyze && !readOnly && isDataModifying(target.text)) setConfirmAnalyze(target);
    else execute(target, { kind: "explain", analyze });
  }, [analyze, readOnly, editorText, execute]);

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
    "flex h-6 items-center gap-1 rounded px-2 hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-focus-ring disabled:opacity-40 disabled:hover:bg-transparent";

  return (
    <div className="flex h-full min-h-0 bg-paper text-[13px] text-ink">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border bg-surface px-2">
          <button
            type="button"
            className={toolbarButton}
            disabled={!!running}
            onClick={() => runFromEditor("cursor")}
            title="Run selection or statement at cursor (⌘↵)"
          >
            <Play className="size-3.5 text-ok" />
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
          <span className="mx-1 h-4 w-px bg-border" aria-hidden />
          <button
            type="button"
            className={toolbarButton}
            disabled={!!running}
            onClick={explainFromEditor}
            title={
              analyze
                ? "Explain analyze: run the selection or statement at cursor, show the plan with actual times, then roll back (⌘E)"
                : "Explain: show the plan for the selection or statement at cursor without running it (⌘E)"
            }
          >
            <ListTree className="size-3.5" />
            Explain
          </button>
          <button
            type="button"
            className={toolbarButton}
            onClick={() => viewRef.current && formatSqlInEditor(viewRef.current)}
            title="Format SQL (⌥⇧F)"
          >
            <WandSparkles className="size-3.5" />
            Format
          </button>
          <label className="flex h-6 items-center gap-1 rounded px-1 text-muted hover:text-ink" title="ANALYZE executes the statement inside a transaction that is always rolled back">
            <input
              type="checkbox"
              checked={analyze}
              onChange={(e) => {
                setAnalyze(e.target.checked);
                localStorage.setItem(ANALYZE_KEY, e.target.checked ? "1" : "0");
              }}
              className="size-3.5 accent-accent focus-visible:outline-2 focus-visible:outline-focus-ring"
            />
            Analyze
          </label>
          {running && (
            <>
              <button type="button" className={`${toolbarButton} text-error`} onClick={cancel} title="Cancel query (Esc)">
                <Square className="size-3.5 fill-current" />
                Cancel
              </button>
              <span className="flex items-center gap-1 px-1 text-muted tabular-nums">
                <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" />
                {formatElapsed(Math.max(0, now - running.startedAt))}
              </span>
            </>
          )}
          <span className="flex-1" />
          <label className="flex items-center gap-1.5 text-muted">
            Max rows
            <select
              value={maxRows}
              onChange={(e) => {
                const n = Number(e.target.value);
                setMaxRows(n);
                localStorage.setItem(MAX_ROWS_KEY, String(n));
              }}
              className="h-6 rounded border border-border-strong bg-paper px-1 text-ink tabular-nums focus-visible:outline-2 focus-visible:outline-focus-ring"
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
            className={`${toolbarButton} ${historyOpen ? "bg-surface-2" : ""}`}
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
              storageKey={sqlEditorKey(tabId)}
              initialSql={initialSql ?? ""}
              schema={schema}
              columns={columns}
              onRun={runFromEditor}
              onExplain={explainFromEditor}
              onCancel={cancel}
              onEdit={() => appStore.getState().pinTab(tabId)}
              keepText={() => !wasTabDisposed(tabId)}
            />
          </div>
          <div
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize editor and results"
            onPointerDown={startDrag}
            className="h-1 shrink-0 cursor-row-resize border-y border-border bg-surface-2 hover:bg-splitter-hover"
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
      {confirmAnalyze && (
        <ConfirmDialog
          title="Run this statement for EXPLAIN ANALYZE?"
          message={
            <>
              ANALYZE runs the statement, then rolls back. Triggers with side effects outside the transaction (for example{" "}
              <code className="font-mono">dblink</code> calls) still fire, and sequence values it uses are not returned.
            </>
          }
          confirmLabel="Run and roll back"
          onCancel={() => setConfirmAnalyze(null)}
          onConfirm={() => {
            const target = confirmAnalyze;
            setConfirmAnalyze(null);
            execute(target, { kind: "explain", analyze: true });
          }}
        />
      )}
    </div>
  );
}
