import { describe, expect, it } from "vitest";
import type { PlanNode } from "../bindings/PlanNode";
import { formatCount, formatMs, isDataModifying, ratioLabel, summarizePlan } from "./plan";

const node = (p: Partial<PlanNode> & Pick<PlanNode, "nodeType">): PlanNode => ({
  relation: null,
  indexName: null,
  qualifier: null,
  startupCost: 0,
  totalCost: 0,
  planRows: 1,
  planWidth: 4,
  actualRows: null,
  actualTotalTime: null,
  actualLoops: null,
  sharedHitBlocks: null,
  sharedReadBlocks: null,
  sharedDirtiedBlocks: null,
  sharedWrittenBlocks: null,
  tempReadBlocks: null,
  tempWrittenBlocks: null,
  details: [],
  children: [],
  ...p,
});

describe("summarizePlan", () => {
  it("computes exclusive time across loops and picks the slowest node", () => {
    // Nested Loop 10 ms total; inner index scan 0.05 ms × 100 loops = 5 ms; outer seq scan 2 ms.
    const plan = node({
      nodeType: "Nested Loop",
      actualTotalTime: 10,
      actualLoops: 1,
      actualRows: 100,
      planRows: 100,
      totalCost: 500,
      children: [
        node({ nodeType: "Seq Scan", actualTotalTime: 2, actualLoops: 1, actualRows: 100, planRows: 100, totalCost: 100 }),
        node({ nodeType: "Index Scan", actualTotalTime: 0.05, actualLoops: 100, actualRows: 1, planRows: 1, totalCost: 300 }),
      ],
    });
    const s = summarizePlan(plan);
    expect(s.rows.map((r) => [r.depth, r.node.nodeType])).toEqual([
      [0, "Nested Loop"],
      [1, "Seq Scan"],
      [1, "Index Scan"],
    ]);
    expect(s.rows[2].totalMs).toBeCloseTo(5);
    expect(s.rows[0].exclusiveMs).toBeCloseTo(3);
    expect(s.rows[1].exclusiveMs).toBeCloseTo(2);
    expect(s.hottest).toBe(2);
    expect(s.maxExclusive).toBeCloseTo(5);
  });

  it("floors exclusive time at zero (parallel children can exceed the parent)", () => {
    const s = summarizePlan(
      node({ nodeType: "Gather", actualTotalTime: 4, actualLoops: 1, actualRows: 1, children: [node({ nodeType: "Parallel Seq Scan", actualTotalTime: 3, actualLoops: 3, actualRows: 1 })] }),
    );
    expect(s.rows[0].exclusiveMs).toBe(0);
    expect(s.hottest).toBe(1);
  });

  it("flags estimate misses beyond 10x either way, ignoring never-executed nodes", () => {
    const s = summarizePlan(
      node({
        nodeType: "Append",
        actualTotalTime: 1,
        actualLoops: 1,
        actualRows: 1000,
        planRows: 100,
        children: [
          node({ nodeType: "Seq Scan", actualTotalTime: 0.5, actualLoops: 1, actualRows: 1001, planRows: 100 }),
          node({ nodeType: "Seq Scan", actualTotalTime: 0.1, actualLoops: 1, actualRows: 0, planRows: 50 }),
          node({ nodeType: "Seq Scan", actualTotalTime: 0, actualLoops: 0, actualRows: 0, planRows: 5000 }),
        ],
      }),
    );
    expect(s.rows.map((r) => r.estimateMiss)).toEqual([false, true, true, false]);
    expect(s.rows[1].estimateRatio).toBeCloseTo(10.01);
    expect(s.rows[2].estimateRatio).toBeCloseTo(1 / 50);
    expect(s.rows[3].estimateRatio).toBeNull();
  });

  it("without ANALYZE uses exclusive cost for the hottest node and flags nothing", () => {
    const s = summarizePlan(
      node({ nodeType: "Sort", totalCost: 120, planRows: 10, children: [node({ nodeType: "Seq Scan", totalCost: 100, planRows: 10 })] }),
    );
    expect(s.rows.map((r) => r.exclusiveCost)).toEqual([20, 100]);
    expect(s.rows.every((r) => r.exclusiveMs === null && !r.estimateMiss)).toBe(true);
    expect(s.hottest).toBe(1);
  });
});

describe("plan formatting", () => {
  it("labels ratios and formats numbers", () => {
    expect(ratioLabel(12.4)).toBe("×12");
    expect(ratioLabel(1 / 40)).toBe("÷40");
    expect(ratioLabel(2.5)).toBe("×2.5");
    expect(ratioLabel(12345)).toBe("×12,345");
    expect(formatMs(0.0421)).toBe("0.042 ms");
    expect(formatMs(25.25)).toBe("25.3 ms");
    expect(formatMs(1500)).toBe("1.50 s");
    expect(formatCount(1234)).toBe("1,234");
    expect(formatCount(1_500_000)).toBe("1.5M");
  });

  it("detects data-modifying statements behind comments and CTEs", () => {
    expect(isDataModifying("-- note\n/* x */ delete from t")).toBe(true);
    expect(isDataModifying("MERGE INTO t USING s ON true WHEN MATCHED THEN DELETE")).toBe(true);
    expect(isDataModifying("with x as (update t set a = 1 returning *) select * from x")).toBe(true);
    expect(isDataModifying("select 'delete' from t")).toBe(false);
    expect(isDataModifying('select "update" from t')).toBe(false);
    expect(isDataModifying("with x as (select 1) select * from x")).toBe(false);
  });
});
