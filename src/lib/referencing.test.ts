import { describe, expect, it } from "vitest";
import type { Column } from "../bindings/Column";
import type { ReferencingKey } from "../bindings/ReferencingKey";
import { referencingLinks } from "./referencing";

const col = (name: string): Column => ({ name, typeName: "integer", nullable: true, isPk: name === "id", references: null });
const key = (schema: string, table: string, columns: string[], referencedColumns: string[], constraintName = `${table}_fkey`): ReferencingKey => ({
  constraintName,
  schema,
  table,
  columns,
  referencedColumns,
});

describe("referencingLinks", () => {
  const columns = [col("id"), col("tenant"), col("item")];

  it("offers single-column keys whose referenced column has a value", () => {
    const keys = [key("public", "orders", ["customer_id"], ["id"]), key("Sales Data", "Odd \"T\"", ["ref"], ["id"], "c2")];
    expect(referencingLinks(keys, columns, ["7", "1", "2"])).toEqual([
      { key: "public.orders.orders_fkey", label: "Rows in orders (customer_id)", target: { schema: "public", table: "orders", column: "customer_id" }, value: "7" },
      { key: "Sales Data.Odd \"T\".c2", label: "Rows in Sales Data.Odd \"T\" (ref)", target: { schema: "Sales Data", table: "Odd \"T\"", column: "ref" }, value: "7" },
    ]);
  });

  it("skips multi-column keys, missing columns, NULL and truncated values", () => {
    expect(referencingLinks([key("public", "fk_links", ["tenant", "item"], ["tenant", "item"])], columns, ["1", "2", "3"])).toEqual([]);
    expect(referencingLinks([key("public", "x", ["a"], ["nope"])], columns, ["1", "2", "3"])).toEqual([]);
    expect(referencingLinks([key("public", "x", ["a"], ["id"])], columns, [null, "2", "3"])).toEqual([]);
    expect(referencingLinks([key("public", "x", ["a"], ["id"])], columns, ["1", "2", "3"], new Set([0]))).toEqual([]);
  });
});
