import { describe, expect, it } from "vitest";
import type { SchemaNode } from "../bindings/SchemaNode";
import { MatchTier, matchTier, quickOpenItems, rankQuickOpen } from "./quickOpen";

const rel = (schema: string, name: string) => ({ schema, name, kind: "table" as const, estRows: 0, sizeBytes: 0 });

function node(name: string, relations: string[], extra: Partial<SchemaNode> = {}): SchemaNode {
  return { name, relations: relations.map((r) => rel(name, r)), functions: [], sequences: [], types: [], triggers: [], ...extra };
}

const names = (tree: SchemaNode[], q: string, limit?: number) => rankQuickOpen(quickOpenItems(tree, []), q, limit).map((i) => `${i.schema}.${i.name}`);

describe("matchTier", () => {
  it("ranks prefix, word start, substring, subsequence", () => {
    expect(matchTier("orders", "ord")).toBe(MatchTier.Prefix);
    expect(matchTier("paid_orders", "ord")).toBe(MatchTier.WordStart);
    expect(matchTier("Weird \"Name\" Table", "table")).toBe(MatchTier.WordStart);
    expect(matchTier("orderTotals", "tot")).toBe(MatchTier.WordStart);
    expect(matchTier("reorder", "ord")).toBe(MatchTier.Substring);
    expect(matchTier("order_totals", "ot")).toBe(MatchTier.Substring);
    expect(matchTier("customers", "cst")).toBe(MatchTier.Subsequence);
    expect(matchTier("customers", "xyz")).toBeNull();
    expect(matchTier("customers", "srem")).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(matchTier("Orders", "oRD")).toBe(MatchTier.Prefix);
    expect(matchTier("all_types", "TYPES")).toBe(MatchTier.WordStart);
  });

  it("prefers a later word-start occurrence over an earlier substring one", () => {
    expect(matchTier("aorders_orders", "orders")).toBe(MatchTier.WordStart);
  });
});

describe("rankQuickOpen", () => {
  it("orders by tier, then shorter name, then public first", () => {
    const tree = [node("public", ["orders", "paid_orders", "reorder", "order_totals", "o_r_d"]), node("audit", ["orders"])];
    expect(names(tree, "ord")).toEqual(["public.orders", "audit.orders", "public.order_totals", "public.paid_orders", "public.reorder", "public.o_r_d"]);
  });

  it("matches every object kind and qualified names", () => {
    const tree: SchemaNode[] = [
      node("public", ["orders"], {
        functions: [{ oid: 1, schema: "public", name: "order_count", args: "", result: "bigint", kind: "function", language: "sql" }],
        sequences: [{ oid: 2, schema: "public", name: "orders_id_seq", dataType: "bigint", readable: true, lastValue: null }],
        types: [{ oid: 3, schema: "public", name: "order_status", kind: "enum", detail: "a, b" }],
        triggers: [{ oid: 4, schema: "public", table: "orders", name: "audit", timing: "after", events: ["insert"], forEachRow: true, enabled: true, function: "f" }],
      }),
      node("Sales Data", ["Weird \"Name\" Table"]),
    ];
    const items = quickOpenItems(tree, [{ oid: 5, name: "uuid-ossp", version: "1.1", schema: "public" }]);
    expect(rankQuickOpen(items, "order").map((i) => i.kind)).toEqual(["relation", "function", "type", "trigger", "sequence"]);
    expect(rankQuickOpen(items, "ossp").map((i) => i.name)).toEqual(["uuid-ossp"]);
    expect(rankQuickOpen(items, "sales.weird").map((i) => i.name)).toEqual(["Weird \"Name\" Table"]);
    expect(rankQuickOpen(items, "").length).toBe(items.length);
  });

  it("caps the result list", () => {
    const tree = [node("public", Array.from({ length: 80 }, (_, i) => `t${i}`))];
    expect(names(tree, "t")).toHaveLength(50);
    expect(names(tree, "t", 5)).toEqual(["public.t0", "public.t1", "public.t2", "public.t3", "public.t4"]);
  });
});
