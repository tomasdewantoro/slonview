import { save } from "@tauri-apps/plugin-dialog";
import { Ban, FileDown, Filter, LoaderCircle, PanelRight, RefreshCw, Sigma, TableProperties } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage, newRequestId } from "../api";
import { appStore, emptyTableData, useApp, type TableTab as TableTabInfo } from "../store/app";
import { buildPageRequest, filtersToRequest, nextSort, normalizeRawWhere } from "../store/queries";
import { CellInspector } from "./CellInspector";
import { ErrorPanel } from "./ErrorPanel";
import { FilterBar } from "./FilterBar";
import { ResultGrid, type CellRef } from "./ResultGrid";
import { useRowEdits } from "./edit/useRowEdits";
import { AddRowDialog, CellEditDialog, ReviewChanges } from "./edit/EditDialogs";

const EMPTY = emptyTableData();

export function TableTab({ tab, connId }: { tab: TableTabInfo; connId: string }) {
  const data = useApp((s) => s.tableData[tab.id]) ?? EMPTY;
  const { ensureLoaded, loadMore, setTableQuery, cancelTable, countRows, refreshTab, openStructure } = appStore.getState();
  const [showFilters, setShowFilters] = useState(tab.query.filters.length > 0 || tab.query.rawWhere !== "");
  const [selected, setSelected] = useState<CellRef | null>(null);
  const [inspecting, setInspecting] = useState<CellRef | null>(null);
  const shiftDown = useRef(false);
  const [exporting, setExporting] = useState(false);
  const readOnly = useApp(s => s.conn?.server?.readOnly !== false);
  const [selectedRows, setSelectedRows] = useState<number[]>([]);
  const edits = useRowEdits(connId, tab.query.schema, tab.query.table, data.columns, data.rows, data.truncated, readOnly, () => refreshTab(tab.id));

  // Streams the whole relation (current filters and sort) to disk in Rust; the grid's loaded rows don't matter.
  const exportCsv = async () => {
    const q = tab.query;
    const path = await save({ defaultPath: `${q.table}.csv`, filters: [{ name: "CSV", extensions: ["csv"] }] });
    if (!path) return;
    setExporting(true);
    const { pushToast } = appStore.getState();
    try {
      const source = {
        kind: "table" as const,
        connId,
        schema: q.schema,
        table: q.table,
        filters: filtersToRequest(q.filters),
        rawWhere: normalizeRawWhere(q.rawWhere),
        sort: q.sort,
      };
      const rows = await api.exportCsv(newRequestId(), source, path);
      pushToast("info", `Exported ${rows.toLocaleString()} ${rows === 1 ? "row" : "rows"} to ${path}`);
    } catch (e) {
      pushToast("error", `Export failed: ${errorMessage(e)}`);
    } finally {
      setExporting(false);
    }
  };

  useEffect(() => ensureLoaded(tab.id), [tab.id, ensureLoaded]);

  // Data replaced (refresh / new filter / sort): inspector + selection refer to old rows.
  const firstRows = data.rows.length > 0 ? data.rows[0] : null;
  useEffect(() => {
    setInspecting(null);
    setSelected(null);
  }, [data.columns, firstRows]);

  const truncatedSet = useMemo(() => new Set(data.truncated.map(([r, c]) => `${r}:${c}`)), [data.truncated]);

  const onSortColumn = useCallback(
    (column: string) => { if (!edits.count) setTableQuery(tab.id, { sort: nextSort(tab.query.sort, column, shiftDown.current) }); },
    [setTableQuery, tab.id, tab.query.sort, edits.count],
  );
  const onNearEnd = useCallback(() => { if (!edits.count) void loadMore(tab.id); }, [loadMore, tab.id, edits.count]);

  const loaded = data.rows.length;
  const hasMore = data.nextCursor !== null;
  const activeFilters = tab.query.filters.length + (tab.query.rawWhere.trim() ? 1 : 0);

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      onMouseDownCapture={(e) => {
        shiftDown.current = e.shiftKey;
      }}
    >
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
        {!readOnly && <>
          <button className="btn h-6 px-2 text-xs" disabled={!!edits.reason || edits.busy || data.loading} title={edits.reason ?? "Add a row; database defaults are preserved"} onClick={edits.openAdd}>Add row</button>
          <button className="btn h-6 px-2 text-xs" disabled={!!edits.reason || edits.busy || data.loading || !selectedRows.length} title={edits.reason ?? "Stage deletion of selected rows"} onClick={() => void edits.remove(selectedRows)}>Delete rows</button>
        </>}
        <button
          className={`btn h-6 px-2 text-xs ${showFilters ? "bg-surface-2" : ""}`}
          onClick={() => setShowFilters((v) => !v)}
          aria-pressed={showFilters}
          title="Toggle filters"
        >
          <Filter size={12} aria-hidden /> Filters
          {activeFilters > 0 && <span className="rounded-full bg-accent px-1.5 text-[10px] leading-4 text-accent-fg tabular-nums">{activeFilters}</span>}
        </button>
        <button className="btn h-6 px-2 text-xs" onClick={() => openStructure(tab.query.schema, tab.query.table)}>
          <TableProperties size={12} aria-hidden /> Structure
        </button>
        <span className="flex-1" />
        <span className="px-1 text-xs text-muted tabular-nums" aria-live="polite">
          {data.counting ? (
            <span className="flex items-center gap-1">
              <LoaderCircle size={11} className="animate-spin" aria-hidden /> counting…
            </span>
          ) : data.exactCount !== null ? (
            `${data.exactCount.toLocaleString()} rows`
          ) : data.countError ? (
            <span className="text-error" title={errorMessage(data.countError)}>
              count failed
            </span>
          ) : null}
        </span>
        <button
          className="btn h-6 px-2 text-xs"
          onClick={() => void countRows(tab.id)}
          disabled={data.counting || data.columns.length === 0}
          title="Run count(*) with the current filters"
        >
          <Sigma size={12} aria-hidden /> Count rows
        </button>
        {data.loading ? (
          <button className="btn h-6 px-2 text-xs" onClick={() => cancelTable(tab.id)}>
            <Ban size={12} aria-hidden /> Cancel
          </button>
        ) : (
          <button className="btn h-6 px-2 text-xs" onClick={() => refreshTab(tab.id)} title="Refresh (⌘R)">
            <RefreshCw size={12} aria-hidden /> Refresh
          </button>
        )}
        <button
          className="btn h-6 px-2 text-xs"
          onClick={() => void exportCsv()}
          disabled={exporting || data.columns.length === 0}
          title="Export every row matching the current filters and sort to CSV"
        >
          {exporting ? <LoaderCircle size={12} className="animate-spin" aria-hidden /> : <FileDown size={12} aria-hidden />} Export CSV
        </button>
        <button
          className={`icon-btn ${inspecting ? "bg-surface-2 text-ink" : ""}`}
          aria-label="Toggle cell inspector"
          aria-pressed={inspecting !== null}
          title="Cell inspector (double-click or ↵ on a cell)"
          disabled={!inspecting && !selected}
          onClick={() => setInspecting((cur) => (cur ? null : selected))}
        >
          <PanelRight size={14} />
        </button>
      </div>
      {edits.count > 0 && <div className="flex shrink-0 items-center gap-3 border-b border-border bg-surface px-3 py-2 text-xs">
        <span>{edits.count} pending changes</span><span className="text-accent">Modified</span><span className="text-warn">New</span><span className="text-error line-through">Deleted</span>
        <span className="flex-1" /><button className="btn" disabled={edits.busy} onClick={edits.discard}>Discard</button><button className="btn btn-primary" disabled={edits.busy} onClick={() => void edits.reviewChanges()}>Review changes</button>
      </div>}
      {edits.error && !edits.review && <p role="alert" className="shrink-0 border-b border-border bg-error-soft px-3 py-2 text-xs text-error">{edits.error}</p>}
      {showFilters && (
        <FilterBar
          columns={data.columns}
          filters={tab.query.filters}
          rawWhere={tab.query.rawWhere}
          onApply={(filters, rawWhere) => { if (!edits.count) setTableQuery(tab.id, { filters, rawWhere }); else appStore.getState().pushToast("info", "Apply or discard pending changes before changing filters."); }}
        />
      )}
      {data.error != null && <ErrorPanel error={data.error} onRetry={() => refreshTab(tab.id)} />}
      <div className="flex min-h-0 flex-1">
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          {data.columns.length > 0 ? (
            <ResultGrid
              columns={data.columns}
              rows={edits.rows}
              truncated={data.truncated}
              loading={data.loading || !hasMore || edits.count > 0 || edits.busy}
              onNearEnd={onNearEnd}
              onSortColumn={onSortColumn}
              sort={tab.query.sort}
              onSelectCell={(c) => {
                setSelected(c);
                if (c && inspecting) setInspecting(c);
              }}
              onOpenCell={setInspecting}
              insertTarget={{ schema: tab.query.schema, table: tab.query.table }}
              copyPage={buildPageRequest(connId, tab.query, null)}
              rowChanges={edits.rowChanges}
              onSelectedRows={setSelectedRows}
              onEditCell={!readOnly && !edits.reason && !data.loading ? c => void edits.start(c) : undefined}
            />
          ) : (
            data.loading && (
              <div className="flex items-center gap-2 p-4 text-muted">
                <LoaderCircle size={14} className="animate-spin" aria-hidden /> Loading {tab.title}…
              </div>
            )
          )}
          {!data.loading && data.error == null && data.columns.length > 0 && loaded === 0 && (
            <div className="pointer-events-none absolute inset-x-0 top-20 text-center text-muted">
              {activeFilters ? "No rows match these filters." : "This table is empty."}
            </div>
          )}
          {data.cancelled && !data.loading && (
            <div className="shrink-0 border-t border-border bg-surface px-3 py-1 text-xs text-muted">
              Load cancelled.{" "}
              <button className="text-accent" onClick={() => (loaded ? void loadMore(tab.id) : refreshTab(tab.id))}>
                Resume
              </button>
            </div>
          )}
        </div>
        {inspecting && data.rows[inspecting.row] && (
          <CellInspector
            connId={connId}
            schema={tab.query.schema}
            table={tab.query.table}
            columns={data.columns}
            row={data.rows[inspecting.row]}
            col={inspecting.col}
            truncated={truncatedSet.has(`${inspecting.row}:${inspecting.col}`)}
            onClose={() => setInspecting(null)}
          />
        )}
      </div>
      {edits.editor && <CellEditDialog key={`${edits.editor.cell.row}:${edits.editor.cell.col}`} column={data.columns[edits.editor.cell.col]} value={edits.editor.value} onSave={edits.saveCell} onClose={edits.closeEditor} />}
      {edits.adding && <AddRowDialog connId={connId} schema={tab.query.schema} table={tab.query.table} blocked={edits.info?.blockedColumns ?? []} onSave={edits.add} onClose={edits.closeAdd} />}
      {edits.review && <ReviewChanges sql={edits.review} busy={edits.busy} error={edits.error} onApply={() => void edits.apply()} onClose={edits.closeReview} />}
    </div>
  );
}
