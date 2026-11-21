// EXPLAIN plan math for PlanView: flattening, exclusive (self) time, slowest node and
// row-estimate misses. Pure; unit tested.
import type { PlanNode } from "../bindings/PlanNode";

/** Estimates off by more than this factor (either direction) are flagged. */
export const MISS_FACTOR = 10;

export interface PlanRow {
  node: PlanNode;
  /** Pre-order index: stable id for the row. */
  index: number;
  depth: number;
  /** Total time across loops (ms): actualTotalTime × loops. Null without ANALYZE. */
  totalMs: number | null;
  /** totalMs minus the children's totalMs, floored at 0. Null without ANALYZE. */
  exclusiveMs: number | null;
  /** totalCost minus the children's totalCost, floored at 0. */
  exclusiveCost: number;
  /** actual/estimated rows per loop (both floored at 1); null without ANALYZE. */
  estimateRatio: number | null;
  /** Estimate off by more than MISS_FACTOR in either direction. */
  estimateMiss: boolean;
}

export interface PlanSummary {
  rows: PlanRow[];
  /** Row index with the most exclusive time (ANALYZE) or exclusive cost (plan only); null if none. */
  hottest: number | null;
  /** Largest exclusiveMs or exclusiveCost, for scaling bars. */
  maxExclusive: number;
}

const nodeTotalMs = (n: PlanNode) => (n.actualTotalTime === null ? null : n.actualTotalTime * (n.actualLoops ?? 1));

export function summarizePlan(root: PlanNode): PlanSummary {
  const rows: PlanRow[] = [];
  const visit = (node: PlanNode, depth: number) => {
    const totalMs = nodeTotalMs(node);
    let exclusiveMs: number | null = null;
    if (totalMs !== null) {
      const childMs = node.children.reduce((sum, c) => sum + (nodeTotalMs(c) ?? 0), 0);
      exclusiveMs = Math.max(0, totalMs - childMs);
    }
    const childCost = node.children.reduce((sum, c) => sum + c.totalCost, 0);
    // Never-executed nodes report loops = 0 and rows = 0: no evidence about the estimate.
    const executed = node.actualRows !== null && (node.actualLoops ?? 0) > 0;
    const estimateRatio = executed ? Math.max(node.actualRows!, 1) / Math.max(node.planRows, 1) : null;
    rows.push({
      node,
      index: rows.length,
      depth,
      totalMs,
      exclusiveMs,
      exclusiveCost: Math.max(0, node.totalCost - childCost),
      estimateRatio,
      estimateMiss: estimateRatio !== null && (estimateRatio > MISS_FACTOR || estimateRatio < 1 / MISS_FACTOR),
    });
    for (const c of node.children) visit(c, depth + 1);
  };
  visit(root, 0);
  const analyzed = rows.some((r) => r.exclusiveMs !== null);
  const weight = (r: PlanRow) => (analyzed ? (r.exclusiveMs ?? 0) : r.exclusiveCost);
  let hottest: number | null = null;
  let maxExclusive = 0;
  for (const r of rows) {
    if (weight(r) > maxExclusive) {
      maxExclusive = weight(r);
      hottest = r.index;
    }
  }
  return { rows, hottest, maxExclusive };
}

/** "×12" / "÷40" style label for an estimate ratio. */
export function ratioLabel(ratio: number): string {
  const factor = ratio >= 1 ? ratio : 1 / ratio;
  const shown = factor >= 100 ? Math.round(factor).toLocaleString() : factor.toFixed(factor >= 10 ? 0 : 1);
  return `${ratio >= 1 ? "×" : "÷"}${shown}`;
}

export function formatMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  if (ms >= 10) return `${ms.toFixed(1)} ms`;
  return `${ms.toFixed(3)} ms`;
}

/** Compact count: 1234 -> "1,234", 1.5e6 -> "1.5M". */
export function formatCount(n: number): string {
  if (n >= 1e7) return `${(n / 1e6).toFixed(0)}M`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  return Math.round(n).toLocaleString();
}

/** Leading statement kinds that change data; ANALYZE of these asks first in allow-writes mode. */
export function isDataModifying(statement: string): boolean {
  const body = statement.replace(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'|"(?:[^"]|"")*"/g, " ");
  const first = /^\s*([A-Za-z]+)/.exec(body)?.[1].toUpperCase() ?? "";
  if (["INSERT", "UPDATE", "DELETE", "MERGE"].includes(first)) return true;
  return first === "WITH" && /\b(insert|update|delete|merge)\b/i.test(body);
}
