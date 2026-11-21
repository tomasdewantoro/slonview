import { describe, expect, it } from "vitest";
import type { FunctionInfo } from "../bindings/FunctionInfo";
import type { SchemaNode } from "../bindings/SchemaNode";
import { functionTitle } from "../store/app";
import { filterTree, functionSignature } from "./Sidebar";

const fn = (schema: string, name: string, args = "", oid = 1): FunctionInfo => ({
  oid,
  schema,
  name,
  args,
  result: "uuid",
  kind: "function",
  language: "c",
});

const tree: SchemaNode[] = [
  {
    name: "public",
    relations: [{ schema: "public", name: "orders", kind: "table", estRows: 10, sizeBytes: 1 }],
    functions: [
      fn("public", "order_total", "p_customer bigint", 1),
      fn("public", "order_total", "p_customer bigint, p_status text", 2),
      fn("public", "uuid_generate_v4", "", 3),
    ],
  },
  { name: "Sales Data", relations: [], functions: [fn("Sales Data", "Weird Total", '"Region Code" text', 4)] },
  { name: "audit", relations: [{ schema: "audit", name: "log", kind: "table", estRows: 1, sizeBytes: 1 }], functions: [] },
];

describe("filterTree", () => {
  it("returns the tree unchanged for a blank query", () => {
    expect(filterTree(tree, "  ")).toBe(tree);
  });

  it("matches function names case-insensitively and keeps every overload", () => {
    const out = filterTree(tree, "ORDER_TOT");
    expect(out.map((s) => s.name)).toEqual(["public"]);
    expect(out[0].relations).toEqual([]);
    expect(out[0].functions.map((f) => f.oid)).toEqual([1, 2]);
  });

  it("matches relations and functions together", () => {
    const out = filterTree(tree, "order");
    expect(out[0].relations.map((r) => r.name)).toEqual(["orders"]);
    expect(out[0].functions.map((f) => f.oid)).toEqual([1, 2]);
  });

  it("keeps a schema that only has matching functions", () => {
    const out = filterTree(tree, "weird");
    expect(out.map((s) => s.name)).toEqual(["Sales Data"]);
    expect(out[0].functions[0].name).toBe("Weird Total");
  });

  it("a matching schema name keeps all its relations and functions", () => {
    const out = filterTree(tree, "public.");
    expect(out[0].relations).toHaveLength(1);
    expect(out[0].functions).toHaveLength(3);
  });

  it("does not match on argument text", () => {
    expect(filterTree(tree, "p_status")).toEqual([]);
  });
});

describe("function labels", () => {
  it("signature quotes only identifiers that need it", () => {
    expect(functionSignature(tree[0].functions[1])).toBe("public.order_total(p_customer bigint, p_status text)");
    expect(functionSignature(tree[1].functions[0])).toBe('"Sales Data"."Weird Total"("Region Code" text)');
  });

  it("tab title shortens long argument lists", () => {
    expect(functionTitle(fn("public", "uuid_generate_v4"))).toBe("uuid_generate_v4()");
    expect(functionTitle(fn("Sales Data", "f", "a int"))).toBe("Sales Data.f(a int)");
    const long = functionTitle(fn("public", "report", "p_from timestamp with time zone, p_to timestamp with time zone"));
    expect(long).toBe("report(p_from timestamp with time zone…)");
  });
});
