// EXPLAIN result for SqlTab: an indented plan tree with estimates vs actuals, the slowest node
// (by exclusive time, or exclusive cost without ANALYZE) and >10x row-estimate misses marked,
// plus a raw JSON view. Click a node to show its other properties (conditions, sort keys, output).
import { Fragment, useMemo, useState } from "react";
import { ChevronRight, Flame, TriangleAlert } from "lucide-react";
import type { ExplainResult } from "../../bindings/ExplainResult";
import type { PlanNode } from "../../bindings/PlanNode";
import { formatCount, formatMs, MISS_FACTOR, ratioLabel, summarizePlan, type PlanRow } from "../../lib/plan";

function buffers(n: PlanNode): string | null {
  const parts: string[] = [];
  if (n.sharedHitBlocks) parts.push(`hit ${formatCount(n.sharedHitBlocks)}`);
  if (n.sharedReadBlocks) parts.push(`read ${formatCount(n.sharedReadBlocks)}`);
  if (n.sharedDirtiedBlocks) parts.push(`dirtied ${formatCount(n.sharedDirtiedBlocks)}`);
  if (n.sharedWrittenBlocks) parts.push(`written ${formatCount(n.sharedWrittenBlocks)}`);
  if (n.tempReadBlocks || n.tempWrittenBlocks) parts.push(`temp ${formatCount((n.tempReadBlocks ?? 0) + (n.tempWrittenBlocks ?? 0))}`);
  return parts.length ? parts.join(" · ") : null;
}

export function PlanView({ result }: { result: ExplainResult }) {
  const [raw, setRaw] = useState(false);
  const [open, setOpen] = useState<Set<number>>(() => new Set());
  const summary = useMemo(() => summarizePlan(result.plan), [result.plan]);
  const analyzed = result.analyzed;
  const misses = summary.rows.filter((r) => r.estimateMiss).length;
  const toggle = (index: number) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(index)) next.add(index);
      return next;
    });

  const th = "sticky top-0 z-10 border-b border-border bg-surface px-2 py-1 text-left font-medium text-muted";
  const num = "px-2 py-1 text-right tabular-nums whitespace-nowrap";

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="plan-view">
      <div className="flex h-8 shrink-0 items-center gap-3 border-b border-border bg-surface px-2 text-xs text-muted tabular-nums">
        <span className="font-medium text-ink">{analyzed ? "EXPLAIN ANALYZE" : "EXPLAIN"}</span>
        <span>{analyzed ? "Executed, then rolled back" : "Plan only, not executed"}</span>
        {result.planningTimeMs !== null && <span>Planning {formatMs(result.planningTimeMs)}</span>}
        {result.executionTimeMs !== null && <span>Execution {formatMs(result.executionTimeMs)}</span>}
        {misses > 0 && (
          <span className="flex items-center gap-1 text-warn">
            <TriangleAlert className="size-3.5" />
            {misses} row {misses === 1 ? "estimate" : "estimates"} off by more than {MISS_FACTOR}×
          </span>
        )}
        <span className="flex-1" />
        <div role="radiogroup" aria-label="Plan view" className="flex rounded border border-border-strong">
          {(["Tree", "JSON"] as const).map((label) => {
            const selected = (label === "JSON") === raw;
            return (
              <button
                key={label}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setRaw(label === "JSON")}
                className={`h-5 px-2 focus-visible:outline-2 focus-visible:outline-focus-ring ${selected ? "bg-surface-2 text-ink" : "text-muted hover:text-ink"}`}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>
      {raw ? (
        <pre className="min-h-0 flex-1 overflow-auto bg-paper p-3 font-mono text-xs text-ink select-text">{result.rawJson}</pre>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto bg-paper">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr>
                <th className={th}>Node</th>
                <th className={`${th} text-right`}>{analyzed ? "Self time" : "Self cost"}</th>
                {analyzed && <th className={`${th} text-right`}>Total time</th>}
                <th className={`${th} text-right`}>Rows est.</th>
                {analyzed && <th className={`${th} text-right`}>Rows actual</th>}
                {analyzed && <th className={`${th} text-right`}>Loops</th>}
                <th className={`${th} text-right`}>Cost</th>
                <th className={th}>Buffers</th>
              </tr>
            </thead>
            <tbody>
              {summary.rows.map((row) => (
                <PlanRowView
                  key={row.index}
                  row={row}
                  analyzed={analyzed}
                  hottest={row.index === summary.hottest}
                  share={summary.maxExclusive > 0 ? (analyzed ? (row.exclusiveMs ?? 0) : row.exclusiveCost) / summary.maxExclusive : 0}
                  open={open.has(row.index)}
                  onToggle={() => toggle(row.index)}
                  num={num}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

interface PlanRowProps {
  row: PlanRow;
  analyzed: boolean;
  hottest: boolean;
  /** This node's exclusive time (or cost) relative to the largest one, 0..1. */
  share: number;
  open: boolean;
  onToggle: () => void;
  num: string;
}

function PlanRowView({ row, analyzed, hottest, share, open, onToggle, num }: PlanRowProps) {
  const n = row.node;
  const hasDetails = n.details.length > 0;
  const colSpan = analyzed ? 8 : 5;
  return (
    <Fragment>
      <tr
        data-node-type={n.nodeType}
        data-hottest={hottest || undefined}
        data-miss={row.estimateMiss || undefined}
        className={`border-b border-border align-top ${hottest ? "bg-accent-soft" : "hover:bg-row-highlight"}`}
      >
        <td className="py-1 pr-2" style={{ paddingLeft: `${8 + row.depth * 16}px` }}>
          <button
            type="button"
            onClick={onToggle}
            disabled={!hasDetails}
            aria-expanded={hasDetails ? open : undefined}
            className="flex max-w-full items-start gap-1 rounded text-left focus-visible:outline-2 focus-visible:outline-focus-ring disabled:cursor-default"
          >
            <ChevronRight
              className={`mt-0.5 size-3 shrink-0 text-muted transition-transform motion-reduce:transition-none ${open ? "rotate-90" : ""} ${hasDetails ? "" : "invisible"}`}
            />
            <span className="min-w-0">
              <span className="font-medium text-ink">{n.nodeType}</span>
              {n.qualifier && <span className="text-muted"> {n.qualifier}</span>}
              {n.relation && <span className="font-mono text-ink"> on {n.relation}</span>}
              {n.indexName && <span className="font-mono text-muted"> using {n.indexName}</span>}
              {hottest && (
                <span className="ml-2 inline-flex items-center gap-0.5 rounded bg-accent px-1 align-[1px] text-[10px] font-semibold text-accent-fg">
                  <Flame className="size-2.5" />
                  {analyzed ? "Slowest" : "Costliest"}
                </span>
              )}
            </span>
          </button>
        </td>
        <td className={num}>
          <span className="flex items-center justify-end gap-1.5">
            <span className="h-1.5 w-12 overflow-hidden rounded-full bg-surface-2" aria-hidden>
              <span className="block h-full rounded-full bg-accent" style={{ width: `${Math.round(share * 100)}%` }} />
            </span>
            {analyzed ? (row.exclusiveMs === null ? "–" : formatMs(row.exclusiveMs)) : row.exclusiveCost.toFixed(2)}
          </span>
        </td>
        {analyzed && <td className={`${num} text-muted`}>{row.totalMs === null ? "–" : formatMs(row.totalMs)}</td>}
        <td className={num}>{formatCount(n.planRows)}</td>
        {analyzed && (
          <td className={num}>
            {n.actualRows === null ? (
              "–"
            ) : (n.actualLoops ?? 0) === 0 ? (
              <span className="text-muted">never executed</span>
            ) : (
              <span className="inline-flex items-center gap-1">
                {row.estimateMiss && row.estimateRatio !== null && (
                  <span
                    className="rounded bg-warn-soft px-1 text-[10px] font-semibold text-warn"
                    title={`Actual rows are ${ratioLabel(row.estimateRatio)} the estimate`}
                  >
                    {ratioLabel(row.estimateRatio)}
                  </span>
                )}
                {formatCount(n.actualRows)}
              </span>
            )}
          </td>
        )}
        {analyzed && <td className={`${num} text-muted`}>{n.actualLoops === null ? "–" : formatCount(n.actualLoops)}</td>}
        <td className={`${num} text-muted`}>{n.totalCost.toFixed(2)}</td>
        <td className="px-2 py-1 whitespace-nowrap text-muted tabular-nums">{buffers(n) ?? ""}</td>
      </tr>
      {open && (
        <tr className="border-b border-border bg-surface">
          <td colSpan={colSpan} className="py-1.5 pr-2" style={{ paddingLeft: `${28 + row.depth * 16}px` }}>
            <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5">
              {n.details.map((d) => (
                <Fragment key={d.key}>
                  <dt className="text-muted">{d.key}</dt>
                  <dd className="font-mono break-words text-ink select-text">{d.value}</dd>
                </Fragment>
              ))}
            </dl>
          </td>
        </tr>
      )}
    </Fragment>
  );
}
