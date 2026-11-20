import { Ban, Filter, LoaderCircle, PanelRight, RefreshCw, Sigma, TableProperties } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { errorMessage } from "../api";
import { appStore, emptyTableData, useApp, type TableTab as TableTabInfo } from "../store/app";
import { nextSort } from "../store/queries";
import { CellInspector } from "./CellInspector";
import { ErrorPanel } from "./ErrorPanel";
import { FilterBar } from "./FilterBar";
import { ResultGrid, type CellRef } from "./ResultGrid";

const EMPTY = emptyTableData();

export function TableTab({ tab, connId }: { tab: TableTabInfo; connId: string }) {
  const data = useApp((s) => s.tableData[tab.id]) ?? EMPTY;
  const { ensureLoaded, loadMore, setTableQuery, cancelTable, countRows, refreshTab, openStructure } = appStore.getState();
  const [showFilters, setShowFilters] = useState(tab.query.filters.length > 0 || tab.query.rawWhere !== "");
  const [selected, setSelected] = useState<CellRef | null>(null);
  const [inspecting, setInspecting] = useState<CellRef | null>(null);
  const shiftDown = useRef(false);

  useEffect(() => ensureLoaded(tab.id), [tab.id, ensureLoaded]);

  // Data replaced (refresh / new filter / sort): inspector + selection refer to old rows.
  const firstRows = data.rows.length > 0 ? data.rows[0] : null;
  useEffect(() => {
    setInspecting(null);
    setSelected(null);
  }, [data.columns, firstRows]);

  const truncatedSet = useMemo(() => new Set(data.truncated.map(([r, c]) => `${r}:${c}`)), [data.truncated]);

  const onSortColumn = useCallback(
    (column: string) => setTableQuery(tab.id, { sort: nextSort(tab.query.sort, column, shiftDown.current) }),
    [setTableQuery, tab.id, tab.query.sort],
  );
  const onNearEnd = useCallback(() => void loadMore(tab.id), [loadMore, tab.id]);

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
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-line px-2">
        <button
          className={`btn h-6 px-2 text-xs ${showFilters ? "bg-hover" : ""}`}
          onClick={() => setShowFilters((v) => !v)}
          aria-pressed={showFilters}
          title="Toggle filters"
        >
          <Filter size={12} aria-hidden /> Filters
          {activeFilters > 0 && <span className="rounded-full bg-accent px-1.5 text-[10px] leading-4 text-white tabular-nums">{activeFilters}</span>}
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
            <span className="text-danger" title={errorMessage(data.countError)}>
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
          className={`icon-btn ${inspecting ? "bg-hover text-fg" : ""}`}
          aria-label="Toggle cell inspector"
          aria-pressed={inspecting !== null}
          title="Cell inspector (double-click or ↵ on a cell)"
          disabled={!inspecting && !selected}
          onClick={() => setInspecting((cur) => (cur ? null : selected))}
        >
          <PanelRight size={14} />
        </button>
      </div>
      {showFilters && (
        <FilterBar
          columns={data.columns}
          filters={tab.query.filters}
          rawWhere={tab.query.rawWhere}
          onApply={(filters, rawWhere) => setTableQuery(tab.id, { filters, rawWhere })}
        />
      )}
      {data.error != null && <ErrorPanel error={data.error} onRetry={() => refreshTab(tab.id)} />}
      <div className="flex min-h-0 flex-1">
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          {data.columns.length > 0 ? (
            <ResultGrid
              columns={data.columns}
              rows={data.rows}
              truncated={data.truncated}
              loading={data.loading || !hasMore}
              onNearEnd={onNearEnd}
              onSortColumn={onSortColumn}
              sort={tab.query.sort}
              onSelectCell={(c) => {
                setSelected(c);
                if (c && inspecting) setInspecting(c);
              }}
              onOpenCell={setInspecting}
              insertTarget={{ schema: tab.query.schema, table: tab.query.table }}
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
            <div className="shrink-0 border-t border-line bg-side px-3 py-1 text-xs text-muted">
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
    </div>
  );
}
