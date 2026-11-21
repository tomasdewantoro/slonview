// Bottom half of SqlTab: per-statement result sub-tabs, error panel, CSV export.
import { useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { CircleAlert, FileDown, TriangleAlert } from "lucide-react";
import { api, errorMessage, newRequestId } from "../../api";
import type { AppError } from "../../bindings/AppError";
import type { QueryResult } from "../../bindings/QueryResult";
import { ResultGrid } from "../ResultGrid";
import { affectedMessage, formatElapsed, isExportable, resultLabel } from "../../lib/sqlResult";

/** `runId` identifies the run; result views remount per run so sub-tab and export state reset. */
export type RunOutcome =
  | { kind: "results"; runId: number; results: QueryResult[]; maxRows: number }
  | { kind: "error"; runId: number; error: AppError | Error };

type ExportState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "done"; rows: number; path: string }
  | { kind: "error"; message: string };

interface ResultsPanelProps {
  connId: string;
  outcome: RunOutcome | null;
  running: boolean;
}

export function ResultsPanel({ connId, outcome, running }: ResultsPanelProps) {
  if (!outcome) {
    return (
      <div className="flex h-full items-center justify-center text-pretty text-muted">
        {running ? "Running…" : "Run a query with ⌘↵ (statement at cursor) or ⇧⌘↵ (whole editor)."}
      </div>
    );
  }
  if (outcome.kind === "error") return <ErrorPanel error={outcome.error} />;
  if (outcome.results.length === 0) {
    return <div className="flex h-full items-center justify-center text-muted">The query contained no statements.</div>;
  }
  return <ResultTabs key={outcome.runId} connId={connId} results={outcome.results} maxRows={outcome.maxRows} />;
}

function ResultTabs({ connId, results, maxRows }: { connId: string; results: QueryResult[]; maxRows: number }) {
  const [active, setActive] = useState(results.length - 1);
  const [exportState, setExportState] = useState<ExportState>({ kind: "idle" });
  const result = results[active];

  const exportCsv = async () => {
    const path = await save({ defaultPath: "result.csv", filters: [{ name: "CSV", extensions: ["csv"] }] });
    if (!path) return;
    setExportState({ kind: "running" });
    try {
      const rows = await api.exportCsv(newRequestId(), { kind: "sql", connId, sql: result.statement }, path);
      setExportState({ kind: "done", rows, path });
    } catch (e) {
      setExportState({ kind: "error", message: errorMessage(e) });
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {results.length > 1 && (
        <div role="tablist" className="flex h-8 shrink-0 items-end gap-px overflow-x-auto border-b border-border bg-surface-2 px-1">
          {results.map((r, i) => (
            <button
              key={i}
              type="button"
              role="tab"
              aria-selected={i === active}
              title={r.statement}
              onClick={() => {
                setActive(i);
                setExportState({ kind: "idle" });
              }}
              className={`h-7 shrink-0 rounded-t border border-b-0 px-3 tabular-nums focus-visible:outline-2 focus-visible:outline-focus-ring ${
                i === active
                  ? "border-border bg-paper text-ink"
                  : "border-transparent text-muted hover:text-ink"
              }`}
            >
              {resultLabel(r, i)}
            </button>
          ))}
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col">
        {result.columns.length > 0 ? (
          <ResultGrid columns={result.columns} rows={result.rows} resultTruncated={result.truncated} />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-1">
            <span className="text-sm font-medium text-ink tabular-nums">{affectedMessage(result)}</span>
            <code className="max-w-[80%] truncate font-mono text-xs text-muted">{result.statement}</code>
          </div>
        )}
      </div>
      <div className="flex h-7 shrink-0 items-center gap-3 border-t border-border bg-surface px-2 text-xs text-muted tabular-nums">
        {result.columns.length > 0 && (
          <span>
            {result.rows.length.toLocaleString()} {result.rows.length === 1 ? "row" : "rows"}
          </span>
        )}
        {result.truncated && (
          <span className="flex items-center gap-1 text-warn">
            <TriangleAlert className="size-3.5" />
            Truncated at {maxRows.toLocaleString()} rows
          </span>
        )}
        <span>{formatElapsed(result.elapsedMs)}</span>
        <span className="flex-1" />
        <ExportStatus state={exportState} />
        {isExportable(result) && (
          <button
            type="button"
            onClick={exportCsv}
            disabled={exportState.kind === "running"}
            title="Re-run this statement and stream every row to a CSV file"
            className="flex h-5 items-center gap-1 rounded px-1.5 text-muted hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-focus-ring disabled:opacity-50"
          >
            <FileDown className="size-3.5" />
            Export CSV
          </button>
        )}
      </div>
    </div>
  );
}

function ExportStatus({ state }: { state: ExportState }) {
  switch (state.kind) {
    case "idle":
      return null;
    case "running":
      return <span>Exporting…</span>;
    case "done":
      return (
        <span className="truncate text-ok" title={state.path}>
          Exported {state.rows.toLocaleString()} {state.rows === 1 ? "row" : "rows"}
        </span>
      );
    case "error":
      return (
        <span className="truncate text-error" title={state.message}>
          Export failed: {state.message}
        </span>
      );
  }
}

function ErrorPanel({ error }: { error: AppError | Error }) {
  if ("kind" in error && error.kind === "cancelled") {
    return <div className="flex h-full items-center justify-center text-muted">Query cancelled.</div>;
  }
  const sqlError = "kind" in error && error.kind === "sql" ? error : null;
  const invalidAt = "kind" in error && error.kind === "invalid" && error.position != null ? error.position : null;
  return (
    <div className="h-full overflow-auto p-3">
      <div role="alert" className="flex gap-2 rounded border border-error bg-error-soft p-3 text-ink">
        <CircleAlert className="mt-0.5 size-4 shrink-0 text-error" />
        <div className="min-w-0 space-y-1">
          <p className="font-medium text-pretty whitespace-pre-wrap">{sqlError ? sqlError.message : errorMessage(error)}</p>
          {sqlError?.detail && <p className="text-pretty whitespace-pre-wrap">{sqlError.detail}</p>}
          {sqlError?.hint && <p className="text-pretty whitespace-pre-wrap">Hint: {sqlError.hint}</p>}
          {sqlError && (
            <p className="font-mono text-xs text-error-meta tabular-nums">
              SQLSTATE {sqlError.code}
              {sqlError.position !== null && ` · position ${sqlError.position}`}
            </p>
          )}
          {invalidAt !== null && <p className="font-mono text-xs text-error-meta tabular-nums">position {invalidAt}</p>}
        </div>
      </div>
    </div>
  );
}
