import { describe, expect, it } from "vitest";
import { activeFilterCount, buildPageRequest, filtersToRequest, formatCount, nextSort, selectSql, type FilterRow } from "./queries";

const row = (column: string, op: FilterRow["op"], value = ""): FilterRow => ({ id: column + op, column, op, value });

describe("filtersToRequest", () => {
  it("maps rows to filters, nulling the value for IS [NOT] NULL", () => {
    expect(
      filtersToRequest([row("status", "=", "paid"), row("note", "IS NULL", "ignored"), row("note", "IS NOT NULL"), row("id", "IN", "1, 2,3")]),
    ).toEqual([
      { column: "status", op: "=", value: "paid" },
      { column: "note", op: "IS NULL", value: null },
      { column: "note", op: "IS NOT NULL", value: null },
      { column: "id", op: "IN", value: "1, 2,3" },
    ]);
  });

  it("skips incomplete rows but keeps whitespace and the literal text NULL", () => {
    expect(filtersToRequest([row("", "=", "x"), row("a", "="), row("b", "=", " "), row("c", "=", "NULL")])).toEqual([
      { column: "b", op: "=", value: " " },
      { column: "c", op: "=", value: "NULL" },
    ]);
  });
});

describe("buildPageRequest", () => {
  it("normalizes raw WHERE and passes sort + cursor", () => {
    const req = buildPageRequest(
      "c",
      { schema: "s", table: "t", filters: [row("a", ">", "1")], rawWhere: "   ", sort: [{ column: "a", desc: true }] },
      { kind: "offset", offset: 500 },
    );
    expect(req).toEqual({
      connId: "c",
      schema: "s",
      table: "t",
      filters: [{ column: "a", op: ">", value: "1" }],
      rawWhere: null,
      search: null,
      sort: [{ column: "a", desc: true }],
      cursor: { kind: "offset", offset: 500 },
      limit: 500,
    });
    expect(buildPageRequest("c", { schema: "s", table: "t", filters: [], rawWhere: " x > 1 ", sort: [] }, null).rawWhere).toBe("x > 1");
  });

  it("passes a trimmed search term; blank or missing means none", () => {
    const q = { schema: "s", table: "t", filters: [], rawWhere: "", sort: [] };
    expect(buildPageRequest("c", { ...q, search: "  o'brien " }, null).search).toBe("o'brien");
    expect(buildPageRequest("c", { ...q, search: "   " }, null).search).toBeNull();
    expect(buildPageRequest("c", q, null).search).toBeNull();
  });
});

describe("activeFilterCount", () => {
  it("counts filter rows plus a raw WHERE and a search", () => {
    const q = { schema: "s", table: "t", filters: [row("a", "=", "1")], rawWhere: "", sort: [] };
    expect(activeFilterCount(q)).toBe(1);
    expect(activeFilterCount({ ...q, rawWhere: " x " })).toBe(2);
    expect(activeFilterCount({ ...q, rawWhere: " x ", search: "y" })).toBe(3);
    expect(activeFilterCount({ ...q, filters: [], search: "  " })).toBe(0);
  });
});

describe("nextSort", () => {
  it("cycles asc -> desc -> none on plain click", () => {
    let s = nextSort([], "a", false);
    expect(s).toEqual([{ column: "a", desc: false }]);
    s = nextSort(s, "a", false);
    expect(s).toEqual([{ column: "a", desc: true }]);
    expect(nextSort(s, "a", false)).toEqual([]);
  });

  it("plain click on another column replaces; shift-click adds and cycles in place", () => {
    const base = [{ column: "a", desc: true }];
    expect(nextSort(base, "b", false)).toEqual([{ column: "b", desc: false }]);
    const two = nextSort(base, "b", true);
    expect(two).toEqual([
      { column: "a", desc: true },
      { column: "b", desc: false },
    ]);
    expect(nextSort(two, "a", true)).toEqual([{ column: "b", desc: false }]);
  });
});

describe("helpers", () => {
  it("quotes identifiers in generated SQL", () => {
    expect(selectSql("Sales Data", 'Weird "Name" Table')).toBe('SELECT * FROM "Sales Data"."Weird ""Name"" Table" LIMIT 100;');
  });

  it("formats row estimates", () => {
    expect([-1, 0, 999, 1000, 1234, 1_234_567, 100_000, 2_500_000_000].map(formatCount)).toEqual(["?", "0", "999", "1k", "1.2k", "1.2M", "100k", "2.5B"]);
  });
});
