import { describe, expect, it } from "vitest";
import type { SavedQuery } from "../bindings/SavedQuery";
import { formatAge } from "./ActivityTab";
import { filterSaved, firstLine } from "./sql/SavedPanel";

const q = (name: string, sql: string): SavedQuery => ({ id: name, connId: null, name, sql, createdAt: "", updatedAt: "" });

describe("saved queries panel", () => {
  it("first non-empty line of the SQL", () => {
    expect(firstLine("\n\n  SELECT *\nFROM orders")).toBe("SELECT *");
    expect(firstLine("")).toBe("");
  });

  it("search matches name or SQL, case-insensitively, keeping order", () => {
    const list = [q("Alpha", "select 1"), q("Beta", "SELECT * FROM Orders"), q("Gamma orders", "select 2")];
    expect(filterSaved(list, "  ").map((x) => x.name)).toEqual(["Alpha", "Beta", "Gamma orders"]);
    expect(filterSaved(list, "ORDERS").map((x) => x.name)).toEqual(["Beta", "Gamma orders"]);
    expect(filterSaved(list, "alp").map((x) => x.name)).toEqual(["Alpha"]);
    expect(filterSaved(list, "nothing")).toEqual([]);
  });
});

describe("activity ages", () => {
  it("formats compactly across ranges", () => {
    expect(formatAge(null)).toBe("");
    expect(formatAge(-5)).toBe("0 ms");
    expect(formatAge(850)).toBe("850 ms");
    expect(formatAge(12_340)).toBe("12.3 s");
    expect(formatAge(245_000)).toBe("4 min 05 s");
    expect(formatAge(7_380_000)).toBe("2 h 03 min");
    expect(formatAge(3 * 86_400_000 + 4 * 3_600_000)).toBe("3 d 4 h");
  });
});
