import { describe, expect, it } from "vitest";
import type { ColumnRef } from "../bindings/ColumnRef";
import { buildColumnIndex, columnCompletion, resolveTable, tableReferences, type ColumnCompletion } from "./sqlColumns";

const col = (schema: string, table: string, name: string, typeName = "text"): ColumnRef => ({ schema, table, name, typeName });
const index = buildColumnIndex([
  col("public", "orders", "id", "bigint"),
  col("public", "orders", "customer_id", "bigint"),
  col("public", "orders", "status"),
  col("public", "customers", "id", "bigint"),
  col("public", "customers", "name"),
  col("Sales Data", "Region Totals", "Region Code"),
  col("Sales Data", "Region Totals", "total", "numeric"),
  col("audit", "events", "at", "timestamptz"),
  col("audit", "orders", "audit_id", "bigint"),
]);
const names = (r: ColumnCompletion | null) => r?.columns.map((c) => `${c.table}.${c.name}`);
/** Completion with the cursor at `|`. */
const at = (sql: string) => columnCompletion(index, sql.replace("|", ""), sql.indexOf("|"));

describe("tableReferences", () => {
  it("reads FROM lists, joins and aliases", () => {
    expect(tableReferences('SELECT * FROM orders o JOIN public.customers AS c ON c.id = o.customer_id, "Sales Data"."Region Totals" rt WHERE 1=1')).toEqual([
      { schema: null, table: "orders", alias: "o" },
      { schema: "public", table: "customers", alias: "c" },
      { schema: "Sales Data", table: "Region Totals", alias: "rt" },
    ]);
  });

  it("folds unquoted names, keeps quoted ones, ignores keywords as aliases", () => {
    expect(tableReferences("select 1 from ORDERS where x = 1")).toEqual([{ schema: null, table: "orders", alias: null }]);
    expect(tableReferences('select 1 from "ORDERS" left join customers on true')).toEqual([
      { schema: null, table: "ORDERS", alias: null },
      { schema: null, table: "customers", alias: null },
    ]);
  });

  it("covers UPDATE / INSERT INTO / DELETE FROM and skips functions, strings and comments", () => {
    expect(tableReferences("UPDATE orders o SET status = 'from x'")).toEqual([{ schema: null, table: "orders", alias: "o" }]);
    expect(tableReferences("insert into audit.events (at) values (now())")).toEqual([{ schema: "audit", table: "events", alias: null }]);
    expect(tableReferences("delete from only orders -- from customers\n")).toEqual([{ schema: null, table: "orders", alias: null }]);
    expect(tableReferences("select * from generate_series(1, 3) g, orders")).toEqual([{ schema: null, table: "orders", alias: null }]);
    expect(tableReferences("select * from (select id from customers) c join orders o on true, audit.events e where x in (select 1)")).toEqual([
      { schema: null, table: "customers", alias: null },
      { schema: null, table: "orders", alias: "o" },
      { schema: "audit", table: "events", alias: "e" },
    ]);
    expect(tableReferences("select $$ from customers $$, x from orders")).toEqual([{ schema: null, table: "orders", alias: null }]);
  });
});

describe("resolveTable", () => {
  it("prefers public for unqualified names, then the first schema holding the table", () => {
    expect(resolveTable(index, null, "orders")?.[0].schema).toBe("public");
    expect(resolveTable(index, null, "events")?.[0].schema).toBe("audit");
    expect(resolveTable(index, "audit", "orders")?.map((c) => c.name)).toEqual(["audit_id"]);
    expect(resolveTable(index, "nope", "orders")).toBeNull();
  });
});

describe("columnCompletion", () => {
  it("resolves an alias before the dot", () => {
    const r = at("SELECT o.| FROM orders o");
    expect(r).toMatchObject({ from: 9, qualified: true });
    expect(names(r)).toEqual(["orders.id", "orders.customer_id", "orders.status"]);
  });

  it("keeps the typed prefix start and works with joins and later aliases", () => {
    const sql = "SELECT c.na| FROM orders o JOIN customers c ON c.id = o.customer_id";
    const r = at(sql);
    expect(r?.from).toBe(sql.indexOf("na"));
    expect(names(r)).toEqual(["customers.id", "customers.name"]);
  });

  it("resolves bare table names and schema.table paths, quoted or not", () => {
    expect(names(at("select orders.| from orders"))).toEqual(["orders.id", "orders.customer_id", "orders.status"]);
    expect(names(at("select audit.orders.| from audit.orders"))).toEqual(["orders.audit_id"]);
    expect(names(at('select "Sales Data"."Region Totals".| from x'))).toEqual(["Region Totals.Region Code", "Region Totals.total"]);
    expect(names(at("select rt.| from \"Sales Data\".\"Region Totals\" AS rt"))).toEqual(["Region Totals.Region Code", "Region Totals.total"]);
  });

  it("an alias shadows a table of the same name", () => {
    expect(names(at("select customers.| from orders customers"))).toEqual(["orders.id", "orders.customer_id", "orders.status"]);
  });

  it("offers every referenced table's columns for a bare word", () => {
    const r = at("SELECT st| FROM orders o JOIN customers c ON true");
    expect(r?.qualified).toBe(false);
    expect(names(r)).toEqual(["orders.id", "orders.customer_id", "orders.status", "customers.id", "customers.name"]);
  });

  it("offers no columns where a table name is expected", () => {
    expect(at("SELECT * FROM orders o JOIN cu|")).toBeNull();
    expect(at("SELECT * FROM or|")).toBeNull();
  });

  it("leaves schema-only paths, unknown names and positions inside strings to other sources", () => {
    expect(at("select * from audit.|")).toBeNull();
    expect(at("select x.| from orders")).toBeNull();
    expect(at("select '|' from orders")).toBeNull();
    expect(at("SELECT | FROM orders")).toBeNull();
  });
});
