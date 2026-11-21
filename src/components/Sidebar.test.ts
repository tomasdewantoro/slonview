import { describe, expect, it } from "vitest";
import type { ExtensionInfo } from "../bindings/ExtensionInfo";
import type { FunctionInfo } from "../bindings/FunctionInfo";
import type { SchemaNode } from "../bindings/SchemaNode";
import type { TriggerInfo } from "../bindings/TriggerInfo";
import { functionTitle } from "../store/app";
import { filterTree, functionSignature } from "./Sidebar";
import { filterExtensions, sequenceValue, triggerSummary } from "./sidebar/objects";

const fn = (schema: string, name: string, args = "", oid = 1): FunctionInfo => ({
  oid,
  schema,
  name,
  args,
  result: "uuid",
  kind: "function",
  language: "c",
});

const trigger = (schema: string, table: string, name: string, oid: number, extra: Partial<TriggerInfo> = {}): TriggerInfo => ({
  oid,
  schema,
  table,
  name,
  timing: "before",
  events: ["insert", "update"],
  forEachRow: true,
  enabled: true,
  function: "public.f",
  ...extra,
});

const empty = { sequences: [], types: [], triggers: [] };

const tree: SchemaNode[] = [
  {
    name: "public",
    relations: [{ schema: "public", name: "orders", kind: "table", estRows: 10, sizeBytes: 1 }],
    functions: [
      fn("public", "order_total", "p_customer bigint", 1),
      fn("public", "order_total", "p_customer bigint, p_status text", 2),
      fn("public", "uuid_generate_v4", "", 3),
    ],
    sequences: [
      { oid: 10, schema: "public", name: "invoice_number_seq", dataType: "integer", readable: true, lastValue: "1010" },
      { oid: 11, schema: "public", name: "secret_seq", dataType: "bigint", readable: false, lastValue: null },
    ],
    types: [
      { oid: 20, schema: "public", name: "order_status", kind: "enum", detail: "pending, paid" },
      { oid: 21, schema: "public", name: "positive_amount", kind: "domain", detail: "numeric NOT NULL" },
    ],
    triggers: [trigger("public", "customers", "email_check", 30)],
  },
  { name: "Sales Data", relations: [], functions: [fn("Sales Data", "Weird Total", '"Region Code" text', 4)], ...empty },
  { name: "audit", relations: [{ schema: "audit", name: "log", kind: "table", estRows: 1, sizeBytes: 1 }], functions: [], ...empty },
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

  it("matches sequences, types and triggers, keeping only matching groups", () => {
    const seq = filterTree(tree, "invoice");
    expect(seq.map((s) => s.name)).toEqual(["public"]);
    expect(seq[0]).toMatchObject({ relations: [], functions: [], types: [], triggers: [] });
    expect(seq[0].sequences.map((x) => x.oid)).toEqual([10]);

    const ty = filterTree(tree, "STATUS");
    expect(ty[0].types.map((t) => t.name)).toEqual(["order_status"]);
    expect(ty[0].sequences).toEqual([]);
  });

  it("matches a trigger by its name or its table", () => {
    expect(filterTree(tree, "email_check")[0].triggers.map((t) => t.oid)).toEqual([30]);
    const byTable = filterTree(tree, "customers");
    expect(byTable[0].triggers.map((t) => t.oid)).toEqual([30]);
    expect(byTable[0].relations).toEqual([]);
  });

  it("keeps a schema whose only match is a type", () => {
    const out = filterTree(tree, "positive");
    expect(out).toHaveLength(1);
    expect(out[0].types.map((t) => t.oid)).toEqual([21]);
  });

  it("a matching schema name keeps every object group", () => {
    const out = filterTree(tree, "public.");
    expect([out[0].sequences.length, out[0].types.length, out[0].triggers.length]).toEqual([2, 2, 1]);
  });
});

describe("filterExtensions", () => {
  const extensions: ExtensionInfo[] = [
    { oid: 1, name: "pg_trgm", version: "1.6", schema: "public" },
    { oid: 2, name: "plpgsql", version: "1.0", schema: "pg_catalog" },
  ];

  it("returns all for a blank query and filters by name otherwise", () => {
    expect(filterExtensions(extensions, " ")).toBe(extensions);
    expect(filterExtensions(extensions, "PLPG").map((e) => e.oid)).toEqual([2]);
    expect(filterExtensions(extensions, "orders")).toEqual([]);
  });
});

describe("object labels", () => {
  it("sequence value shows ? when unreadable and a dash before first use", () => {
    expect(sequenceValue(tree[0].sequences[0])).toBe("1010");
    expect(sequenceValue(tree[0].sequences[1])).toBe("?");
    expect(sequenceValue({ ...tree[0].sequences[0], lastValue: null })).toBe("–");
  });

  it("trigger summary names timing, events and level", () => {
    expect(triggerSummary(tree[0].triggers[0])).toBe("before insert or update, row");
    expect(triggerSummary(trigger("public", "t", "x", 1, { timing: "instead-of", events: ["delete"], forEachRow: false }))).toBe(
      "instead of delete, statement",
    );
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
