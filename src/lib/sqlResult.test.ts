import { describe, expect, it } from "vitest";
import type { QueryResult } from "../bindings/QueryResult";
import { affectedMessage, completionNamespace, isExportable, leadingKeyword, resultLabel, timeAgo } from "./sqlResult";

const result = (statement: string, withColumns: boolean, rowsAffected: number | null = null): QueryResult => ({
  statement,
  columns: withColumns ? [{ name: "a", typeName: "int4", nullable: true, isPk: false, references: null }] : [],
  rows: [],
  rowsAffected,
  truncated: false,
  elapsedMs: 3,
});

describe("sqlResult helpers", () => {
  it("leadingKeyword skips comments", () => {
    expect(leadingKeyword("-- c\n/* x */ update t set a = 1")).toBe("UPDATE");
  });

  it("labels results", () => {
    expect(resultLabel(result("select 1", true), 0)).toBe("Result 1");
    expect(resultLabel(result("update t set a=1", false, 5), 1)).toBe("UPDATE 5");
    expect(resultLabel(result("create table x()", false), 2)).toBe("CREATE");
  });

  it("affected message", () => {
    expect(affectedMessage(result("delete from t", false, 1))).toBe("1 row affected");
    expect(affectedMessage(result("delete from t", false, 0))).toBe("0 rows affected");
    expect(affectedMessage(result("set x = 1", false))).toBe("OK");
  });

  it("only single read-only queries are exportable", () => {
    expect(isExportable(result("select * from orders", true))).toBe(true);
    expect(isExportable(result("with a as (select 1) select * from a", true))).toBe(true);
    expect(isExportable(result("with d as (delete from t returning *) select * from d", true))).toBe(false);
    expect(isExportable(result("insert into t values (1) returning *", true))).toBe(false);
    expect(isExportable(result("update t set a = 1", false, 2))).toBe(false);
  });

  it("timeAgo", () => {
    const now = Date.parse("2026-11-20T12:00:00Z");
    expect(timeAgo("2026-11-20T11:59:30Z", now)).toBe("now");
    expect(timeAgo("2026-11-20T11:55:00Z", now)).toBe("5m ago");
    expect(timeAgo("2026-11-20T09:00:00Z", now)).toBe("3h ago");
    expect(timeAgo("2026-11-18T12:00:00Z", now)).toBe("2d ago");
  });

  it("completion namespace quotes odd names and escapes dots", () => {
    const ns = completionNamespace([
      {
        name: "Sales Data",
        relations: [{ schema: "Sales Data", name: 'Weird "Name" Table', kind: "table", estRows: 0, sizeBytes: 0 }],
        functions: [],
        sequences: [],
        types: [],
        triggers: [],
      },
      { name: "public", relations: [{ schema: "public", name: "a.b", kind: "view", estRows: 0, sizeBytes: 0 }], functions: [], sequences: [], types: [], triggers: [] },
    ]) as Record<string, { self: { label: string; apply?: string }; children: Record<string, { self: { apply?: string } }> }>;
    expect(ns["Sales Data"].self.apply).toBe('"Sales Data"');
    expect(ns["Sales Data"].children['Weird "Name" Table'].self.apply).toBe('"Weird ""Name"" Table"');
    expect(ns.public.self.apply).toBeUndefined();
    expect(ns.public.children["a\\.b"].self.apply).toBe('"a.b"');
  });
});
