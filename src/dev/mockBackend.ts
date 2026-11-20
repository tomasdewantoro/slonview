// Dev-only fake backend (VITE_MOCK=1). Implements every api.ts command over mockIPC so the
// UI can be developed and screenshotted without the Rust engine. Never loaded in production.
import { mockIPC } from "@tauri-apps/api/mocks";
import type { AppError } from "../bindings/AppError";
import type { Column } from "../bindings/Column";
import type { ColumnDetail } from "../bindings/ColumnDetail";
import type { ConnProfile } from "../bindings/ConnProfile";
import type { Filter } from "../bindings/Filter";
import type { HistoryEntry } from "../bindings/HistoryEntry";
import type { Page } from "../bindings/Page";
import type { PageRequest } from "../bindings/PageRequest";
import type { ParsedConn } from "../bindings/ParsedConn";
import type { QueryResult } from "../bindings/QueryResult";
import type { RelationKind } from "../bindings/RelationKind";
import type { SchemaNode } from "../bindings/SchemaNode";
import type { TableDescription } from "../bindings/TableDescription";

const TRUNCATE = 2048;

interface MockTable {
  schema: string;
  name: string;
  kind: RelationKind;
  columns: ColumnDetail[];
  rowCount: number;
  sizeBytes: number;
  /** Deterministic row generator: row i of the unfiltered, PK-ordered table. */
  row(i: number): (string | null)[];
  indexes?: TableDescription["indexes"];
  foreignKeys?: TableDescription["foreignKeys"];
  viewDefinition?: string;
  broken?: boolean;
}

const col = (name: string, typeName: string, opts: Partial<ColumnDetail> = {}): ColumnDetail => ({
  name,
  typeName,
  nullable: true,
  isPk: false,
  default: null,
  comment: null,
  ...opts,
});

const STATUSES = ["pending", "paid", "shipped", "refunded", "cancelled"];
const CITIES = ["Prague", "Brno", "Ostrava", "Plzeň", "Liberec", "Olomouc"];
const day0 = Date.UTC(2024, 0, 1);

function pgTimestamp(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace(/\.\d+Z$/, "+00");
}

const longText = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(60);

const tables: MockTable[] = [
  {
    schema: "public",
    name: "orders",
    kind: "table",
    columns: [
      col("id", "bigint", { nullable: false, isPk: true, default: "nextval('orders_id_seq'::regclass)" }),
      col("customer_id", "integer", { nullable: false }),
      col("status", "order_status", { nullable: false, default: "'pending'::order_status" }),
      col("amount", "numeric(12,2)", { nullable: false }),
      col("note", "text", { comment: "Free-form note from support" }),
      col("created_at", "timestamp with time zone", { nullable: false, default: "now()" }),
    ],
    rowCount: 100_000,
    sizeBytes: 9_431_040,
    row: (i) => [
      String(i + 1),
      String(1000 + ((i * 7919) % 5000)),
      STATUSES[i % STATUSES.length],
      ((i * 37) % 100000 / 100 + 5).toFixed(2),
      i % 9 === 0 ? null : i % 13 === 0 ? "NULL" : i % 17 === 0 ? longText : `order note ${i + 1}`,
      pgTimestamp(day0 + i * 61_000),
    ],
    indexes: [
      { name: "orders_pkey", definition: "CREATE UNIQUE INDEX orders_pkey ON public.orders USING btree (id)", isUnique: true, isPrimary: true },
      { name: "orders_status_idx", definition: "CREATE INDEX orders_status_idx ON public.orders USING btree (status)", isUnique: false, isPrimary: false },
      { name: "orders_created_at_idx", definition: "CREATE INDEX orders_created_at_idx ON public.orders USING btree (created_at DESC)", isUnique: false, isPrimary: false },
    ],
    foreignKeys: [{ name: "orders_customer_id_fkey", definition: "FOREIGN KEY (customer_id) REFERENCES customers(id)" }],
  },
  {
    schema: "public",
    name: "customers",
    kind: "table",
    columns: [
      col("id", "integer", { nullable: false, isPk: true }),
      col("name", "text", { nullable: false }),
      col("email", "character varying(255)"),
      col("city", "text"),
    ],
    rowCount: 5000,
    sizeBytes: 524_288,
    row: (i) => [String(1000 + i), `Customer ${1000 + i}`, i % 11 === 0 ? null : `c${1000 + i}@example.com`, CITIES[i % CITIES.length]],
    indexes: [{ name: "customers_pkey", definition: "CREATE UNIQUE INDEX customers_pkey ON public.customers USING btree (id)", isUnique: true, isPrimary: true }],
  },
  {
    schema: "public",
    name: "all_types",
    kind: "table",
    columns: [
      col("id", "integer", { nullable: false, isPk: true }),
      col("c_int", "integer"),
      col("c_numeric", "numeric(10,3)"),
      col("c_text", "text"),
      col("c_bool", "boolean"),
      col("c_uuid", "uuid"),
      col("c_date", "date"),
      col("c_ts", "timestamp with time zone"),
      col("c_interval", "interval"),
      col("c_jsonb", "jsonb"),
      col("c_int_arr", "integer[]"),
      col("c_text_arr", "text[]"),
      col("c_bytea", "bytea"),
      col("c_enum", "order_status"),
      col("c_inet", "inet"),
    ],
    rowCount: 4,
    sizeBytes: 16_384,
    row: (i) =>
      [
        ["1", "42", "3.142", "hello", "t", "0b3c6d0e-4c1f-4a52-9d4e-6f5b8b1e2a10", "2024-02-29", "2024-02-29 13:37:00+00", "1 day 02:03:04",
          '{"a": 1, "tags": ["x", "y"], "nested": {"ok": true, "n": null}}', "{1,2,3}", '{alpha,"with space",NULL}', "\\x deadbeef".replace(" ", ""), "paid", "192.168.0.1/32"],
        ["2", null, null, "NULL", null, null, null, null, null, null, null, null, null, null, null],
        ["3", "-7", "0.000", "", "f", "00000000-0000-0000-0000-000000000000", "1970-01-01", "1970-01-01 00:00:00+00", "00:00:00",
          "[]", "{}", "{}", "\\x", "pending", "::1"],
        ["4", "2147483647", "9999999.999", longText, "t", "ffffffff-ffff-ffff-ffff-ffffffffffff", "9999-12-31", "2038-01-19 03:14:07+00", "-1 years",
          JSON.stringify({ items: Array.from({ length: 80 }, (_, k) => ({ k, label: `item ${k}` })) }), "{2147483647}", '{"quote\\"d"}',
          "\\x" + "0123456789abcdef".repeat(200), "refunded", "10.0.0.0/8"],
      ][i],
    indexes: [{ name: "all_types_pkey", definition: "CREATE UNIQUE INDEX all_types_pkey ON public.all_types USING btree (id)", isUnique: true, isPrimary: true }],
  },
  {
    schema: "public",
    name: "no_pk",
    kind: "table",
    columns: [col("label", "text"), col("payload", "text")],
    rowCount: 3,
    sizeBytes: 8192,
    row: (i) => [`row ${i + 1}`, i === 1 ? longText : `payload ${i + 1}`],
  },
  {
    schema: "public",
    name: "paid_orders",
    kind: "view",
    columns: [col("id", "bigint"), col("amount", "numeric(12,2)"), col("created_at", "timestamp with time zone")],
    rowCount: 20_000,
    sizeBytes: 0,
    row: (i) => [String(i * 5 + 2), ((i * 37) % 100000 / 100 + 5).toFixed(2), pgTimestamp(day0 + i * 305_000)],
    viewDefinition: " SELECT orders.id,\n    orders.amount,\n    orders.created_at\n   FROM orders\n  WHERE orders.status = 'paid'::order_status;",
  },
  {
    schema: "public",
    name: "order_totals",
    kind: "materialized-view",
    columns: [col("status", "order_status"), col("total", "numeric")],
    rowCount: 5,
    sizeBytes: 16_384,
    row: (i) => [STATUSES[i], String(1_000_000 + i * 12345)],
    viewDefinition: " SELECT orders.status,\n    sum(orders.amount) AS total\n   FROM orders\n  GROUP BY orders.status;",
  },
  {
    schema: "public",
    name: "events",
    kind: "partitioned-table",
    columns: [col("id", "bigint", { nullable: false }), col("happened_at", "date", { nullable: false }), col("kind", "text")],
    rowCount: 730,
    sizeBytes: 98_304,
    row: (i) => [String(i + 1), new Date(day0 + i * 86_400_000).toISOString().slice(0, 10), i % 2 ? "click" : "view"],
  },
  {
    schema: "public",
    name: "broken_table",
    kind: "table",
    columns: [col("id", "integer", { isPk: true, nullable: false })],
    rowCount: 10,
    sizeBytes: 8192,
    row: (i) => [String(i)],
    broken: true,
  },
  {
    schema: "Sales Data",
    name: 'Weird "Name" Table',
    kind: "table",
    columns: [col("Id", "integer", { nullable: false, isPk: true }), col("Region Name", "text"), col("Total €", "numeric")],
    rowCount: 12,
    sizeBytes: 16_384,
    row: (i) => [String(i + 1), CITIES[i % CITIES.length], String(1000 * (i + 1))],
  },
  {
    schema: "audit",
    name: "log",
    kind: "table",
    columns: [col("id", "bigint", { nullable: false, isPk: true }), col("at", "timestamp with time zone"), col("payload", "jsonb")],
    rowCount: 1_234_567,
    sizeBytes: 412_000_000,
    row: (i) => [String(i + 1), pgTimestamp(day0 + i * 1000), JSON.stringify({ op: i % 3 ? "UPDATE" : "INSERT", rowId: i })],
  },
];

const seedProfiles: ConnProfile[] = [
  {
    id: "7f6c1d7a-0000-4000-8000-000000000001",
    name: "fixture (local)",
    host: "localhost",
    port: 5432,
    database: "slonview_fixture",
    user: "tomas",
    ssl: "disable",
    readOnly: true,
    color: "#3b82f6",
    statementTimeoutMs: 30000,
    timeZone: null,
  },
  {
    id: "7f6c1d7a-0000-4000-8000-000000000002",
    name: "staging",
    host: "db.staging.internal",
    port: 6432,
    database: "app",
    user: "app_rw",
    ssl: "require",
    readOnly: false,
    color: "#e5484d",
    statementTimeoutMs: 30000,
    timeZone: "Asia/Jakarta",
  },
  {
    id: "7f6c1d7a-0000-4000-8000-000000000003",
    name: "unreachable",
    host: "10.255.0.1",
    port: 5432,
    database: "nope",
    user: "nobody",
    ssl: "prefer",
    readOnly: true,
    color: null,
    statementTimeoutMs: 30000,
    timeZone: null,
  },
];

const sortedProfiles = (list: ConnProfile[]) => [...list].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

let profiles = sortedProfiles(seedProfiles);
const passwords = new Map<string, string>([[seedProfiles[1].id, "secret"]]);
const connected = new Set<string>();
const inflight = new Map<string, () => void>();
const history: HistoryEntry[] = [];

const err = (e: AppError) => e;
const version = "PostgreSQL 18.4 (Homebrew) on aarch64-apple-darwin25.0.0, compiled by Apple clang version 17.0.0, 64-bit";

/** Resolves after `ms` unless cancelled via cancel_query, which rejects with Cancelled. */
function delay(requestId: string | null, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      if (requestId) inflight.delete(requestId);
      resolve();
    }, ms);
    if (requestId)
      inflight.set(requestId, () => {
        clearTimeout(t);
        inflight.delete(requestId);
        reject(err({ kind: "cancelled" }));
      });
  });
}

function findTable(schema: string, table: string): MockTable {
  const t = tables.find((x) => x.schema === schema && x.name === table);
  if (!t) throw err({ kind: "sql", code: "42P01", message: `relation "${schema}.${table}" does not exist`, detail: null, hint: null, position: null });
  return t;
}

function requireConn(connId: string) {
  if (!connected.has(connId)) throw err({ kind: "notConnected" });
}

function compare(a: string | null, b: string | null, numeric: boolean): number {
  if (a === null) return b === null ? 0 : 1;
  if (b === null) return -1;
  return numeric ? Number(a) - Number(b) : a < b ? -1 : a > b ? 1 : 0;
}

const NUMERIC = /^(smallint|integer|bigint|numeric|real|double)/;

function matches(v: string | null, f: Filter, numeric: boolean): boolean {
  const val = f.value ?? "";
  switch (f.op) {
    case "IS NULL":
      return v === null;
    case "IS NOT NULL":
      return v !== null;
    case "IN":
      return v !== null && val.split(",").map((x) => x.trim()).includes(v);
    case "LIKE":
    case "ILIKE": {
      if (v === null) return false;
      const re = new RegExp(`^${val.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".")}$`, f.op === "ILIKE" ? "is" : "s");
      return re.test(v);
    }
  }
  if (v === null) return false;
  if (numeric && Number.isNaN(Number(val)))
    throw err({ kind: "sql", code: "22P02", message: `invalid input syntax for type numeric: "${val}"`, detail: null, hint: null, position: null });
  const c = compare(v, val, numeric);
  switch (f.op) {
    case "=":
      return c === 0;
    case "!=":
      return c !== 0;
    case "<":
      return c < 0;
    case "<=":
      return c <= 0;
    case ">":
      return c > 0;
    default:
      return c >= 0;
  }
}

/** Row indexes of the filtered + sorted view; null = identity (no filter/sort), avoids materializing 1M ids. */
function viewIndexes(t: MockTable, req: PageRequest): number[] | null {
  if (req.rawWhere?.toLowerCase().includes("syntax"))
    throw err({ kind: "sql", code: "42601", message: 'syntax error at or near "syntax"', detail: null, hint: "Check the raw WHERE expression.", position: 31 });
  if (req.filters.length === 0 && req.sort.length === 0) return null;
  if (t.rowCount > 200_000) throw err({ kind: "timeout" });
  const colIdx = (name: string) => {
    const i = t.columns.findIndex((c) => c.name === name);
    if (i < 0) throw err({ kind: "sql", code: "42703", message: `column "${name}" does not exist`, detail: null, hint: null, position: null });
    return i;
  };
  const fs = req.filters.map((f) => ({ f, i: colIdx(f.column), num: NUMERIC.test(t.columns[colIdx(f.column)].typeName) }));
  const idx: number[] = [];
  for (let r = 0; r < t.rowCount; r++) {
    const row = t.row(r);
    if (fs.every(({ f, i, num }) => matches(row[i], f, num))) idx.push(r);
  }
  const ss = req.sort.map((s) => ({ s, i: colIdx(s.column), num: NUMERIC.test(t.columns[colIdx(s.column)].typeName) }));
  if (ss.length) {
    const cache = new Map<number, (string | null)[]>();
    const get = (r: number) => {
      let row = cache.get(r);
      if (!row) cache.set(r, (row = t.row(r)));
      return row;
    };
    idx.sort((a, b) => {
      for (const { s, i, num } of ss) {
        const c = compare(get(a)[i], get(b)[i], num);
        if (c) return s.desc ? -c : c;
      }
      return a - b;
    });
  }
  return idx;
}

const quote = (s: string) => `"${s.replace(/"/g, '""')}"`;

async function fetchPage(requestId: string, req: PageRequest): Promise<Page> {
  requireConn(req.connId);
  const t = findTable(req.schema, req.table);
  await delay(requestId, t.name === "audit" || t.schema === "audit" ? 900 : 120 + Math.random() * 180);
  if (t.broken)
    throw err({
      kind: "sql",
      code: "42501",
      message: "permission denied for table broken_table",
      detail: "Role slonview_ro lacks SELECT on public.broken_table.",
      hint: "GRANT SELECT ON public.broken_table TO slonview_ro;",
      position: null,
    });
  const ids = viewIndexes(t, req);
  const total = ids ? ids.length : t.rowCount;
  const offset = req.cursor?.kind === "offset" ? req.cursor.offset : req.cursor?.kind === "keyset" ? Number(req.cursor.values[0]) : 0;
  const end = Math.min(total, offset + req.limit);
  const rows: (string | null)[][] = [];
  const truncated: [number, number][] = [];
  for (let k = offset; k < end; k++) {
    const row = t.row(ids ? ids[k] : k).map((v, c) => {
      if (v !== null && v.length > TRUNCATE) {
        truncated.push([k - offset, c]);
        return v.slice(0, TRUNCATE);
      }
      return v;
    });
    rows.push(row);
  }
  const hasPk = t.columns.some((c) => c.isPk);
  const keyset = hasPk && req.sort.length === 0;
  const where = [
    ...req.filters.map((f) => `${quote(f.column)} ${f.op}${f.value !== null && !f.op.startsWith("IS") ? ` '${f.value}'` : ""}`),
    ...(req.rawWhere ? [`(${req.rawWhere})`] : []),
  ];
  const order = req.sort.length ? req.sort.map((s) => `${quote(s.column)}${s.desc ? " DESC" : ""}`).join(", ") : hasPk ? quote(t.columns.find((c) => c.isPk)!.name) : "";
  const sql =
    `SELECT * FROM ${quote(t.schema)}.${quote(t.name)}` +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    (order ? ` ORDER BY ${order}` : "") +
    ` LIMIT ${req.limit}` +
    (!keyset && offset ? ` OFFSET ${offset}` : "");
  const columns: Column[] = t.columns.map(({ name, typeName, nullable, isPk }) => ({ name, typeName, nullable, isPk }));
  return {
    columns,
    rows,
    truncated,
    nextCursor: end < total ? (keyset ? { kind: "keyset", values: [String(end)] } : { kind: "offset", offset: end }) : null,
    sql,
    elapsedMs: Math.round(3 + Math.random() * 40),
  };
}

function schemaTree(): SchemaNode[] {
  const bySchema = new Map<string, SchemaNode>();
  for (const t of tables) {
    const node = bySchema.get(t.schema) ?? { name: t.schema, relations: [] };
    node.relations.push({ schema: t.schema, name: t.name, kind: t.kind, estRows: t.name === "broken_table" ? -1 : t.rowCount, sizeBytes: t.sizeBytes });
    bySchema.set(t.schema, node);
  }
  return [...bySchema.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function parseUrl(url: string): ParsedConn {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    throw err({ kind: "invalid", message: "Not a valid postgres:// URL", position: null });
  }
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") throw err({ kind: "invalid", message: "URL must start with postgres:// or postgresql://", position: null });
  const database = decodeURIComponent(u.pathname.replace(/^\//, "")) || "postgres";
  const host = u.hostname || "localhost";
  const sslParam = u.searchParams.get("sslmode") ?? "prefer";
  const ssl = sslParam === "disable" ? "disable" : sslParam.startsWith("verify") || sslParam === "require" ? "require" : "prefer";
  return {
    profile: {
      id: crypto.randomUUID(),
      name: `${database}@${host}`,
      host,
      port: u.port ? Number(u.port) : 5432,
      database,
      user: decodeURIComponent(u.username) || "postgres",
      ssl,
      readOnly: true,
      color: null,
      statementTimeoutMs: 30000,
      timeZone: null,
    },
    password: u.password ? decodeURIComponent(u.password) : null,
  };
}

async function testConnection(profile: ConnProfile, password: string | null) {
  await delay(null, 400);
  if (profile.host.startsWith("10.")) throw err({ kind: "connect", message: `could not connect to ${profile.host}:${profile.port}: Operation timed out` });
  if (passwords.has(profile.id) || password !== null) {
    const expected = passwords.get(profile.id);
    if (password !== null && expected !== undefined && password !== expected)
      throw err({ kind: "auth", message: `password authentication failed for user "${profile.user}"` });
  }
  return { version, database: profile.database, user: profile.user, readOnly: profile.readOnly };
}

async function runSql(requestId: string, connId: string, sql: string, maxRows: number | null): Promise<QueryResult[]> {
  requireConn(connId);
  const started = Date.now();
  await delay(requestId, /pg_sleep/i.test(sql) ? 60_000 : 150);
  const entry: HistoryEntry = { id: crypto.randomUUID(), connId, sql, executedAt: new Date().toISOString(), elapsedMs: Date.now() - started, error: null };
  history.unshift(entry);
  const m = /from\s+("?)([\w ]+)\1\s*\.\s*("?)([\w "]+?)\3(\s|;|$)/i.exec(sql) ?? /from\s+("?)(\w+)\1/i.exec(sql);
  const t = m ? tables.find((x) => (m[4] ? x.schema === m[2] && x.name === m[4] : x.name === m[2])) : undefined;
  if (/^\s*(delete|update|insert)/i.test(sql)) {
    const p = profiles.find((x) => x.id === connId);
    if (p?.readOnly) {
      const e = err({ kind: "sql", code: "25006", message: "cannot execute DELETE in a read-only transaction", detail: null, hint: null, position: null });
      entry.error = errorText(e);
      throw e;
    }
    return [{ statement: sql, columns: [], rows: [], rowsAffected: 3, truncated: false, elapsedMs: 4 }];
  }
  if (!t) return [{ statement: sql, columns: [{ name: "?column?", typeName: "integer", nullable: true, isPk: false }], rows: [["1"]], rowsAffected: null, truncated: false, elapsedMs: 1 }];
  const limit = Math.min(t.rowCount, maxRows ?? 10000, 100);
  const rows = Array.from({ length: limit }, (_, i) => t.row(i));
  return [
    {
      statement: sql,
      columns: t.columns.map(({ name, typeName, nullable, isPk }) => ({ name, typeName, nullable, isPk })),
      rows,
      rowsAffected: null,
      truncated: false,
      elapsedMs: Date.now() - started,
    },
  ];
}

function errorText(e: AppError): string {
  return "message" in e ? e.message : e.kind;
}

export function installMockBackend(): void {
  mockIPC(async (cmd, payload) => {
    const a = (payload ?? {}) as Record<string, any>;
    switch (cmd) {
      case "list_profiles":
        return profiles;
      case "save_profile": {
        const raw = a.profile as ConnProfile;
        // Mirrors ops::save_profile: trimmed, blank = server default.
        const p = { ...raw, timeZone: raw.timeZone?.trim() || null };
        profiles = sortedProfiles([...profiles.filter((x) => x.id !== p.id), p]);
        if (a.password === null) passwords.delete(p.id);
        else if (typeof a.password === "string") passwords.set(p.id, a.password);
        return profiles;
      }
      case "delete_profile":
        profiles = profiles.filter((x) => x.id !== a.id);
        passwords.delete(a.id);
        return profiles;
      case "parse_conn_url":
        return parseUrl(a.url);
      case "import_pgpass":
        return [
          parseUrl("postgres://tomas:pw1@localhost:5432/slonview_fixture"),
          parseUrl("postgres://report:hunter2@reports.example.com:5433/analytics?sslmode=require"),
          parseUrl("postgres://postgres@127.0.0.1/postgres"),
        ];
      case "test_connection":
        return testConnection(a.profile, a.password);
      case "connect": {
        const p = profiles.find((x) => x.id === a.connId);
        if (!p) throw err({ kind: "invalid", message: "Unknown connection", position: null });
        const info = await testConnection(p, passwords.get(p.id) ?? null);
        connected.add(p.id);
        return info;
      }
      case "disconnect":
        connected.delete(a.connId);
        return null;
      case "list_schema_tree":
        requireConn(a.connId);
        await delay(null, 150);
        return schemaTree();
      case "describe_table": {
        requireConn(a.connId);
        await delay(null, 120);
        const t = findTable(a.schema, a.table);
        const d: TableDescription = {
          schema: t.schema,
          name: t.name,
          kind: t.kind,
          columns: t.columns,
          indexes: t.indexes ?? [],
          foreignKeys: t.foreignKeys ?? [],
          estRows: t.rowCount,
          sizeBytes: t.sizeBytes,
          viewDefinition: t.viewDefinition ?? null,
        };
        return d;
      }
      case "fetch_page":
        return fetchPage(a.requestId, a.req);
      case "count_exact": {
        requireConn(a.connId);
        const t = findTable(a.schema, a.table);
        await delay(a.requestId, t.rowCount > 500_000 ? 2500 : 400);
        const ids = viewIndexes(t, { connId: a.connId, schema: a.schema, table: a.table, filters: a.filters, rawWhere: a.rawWhere, sort: [], cursor: null, limit: 0 });
        return ids ? ids.length : t.rowCount;
      }
      case "get_cell": {
        const req = a.req as { schema: string; table: string; pkValues: (string | null)[]; column: string };
        requireConn(a.req.connId);
        await delay(null, 80);
        const t = findTable(req.schema, req.table);
        const pk = Number(req.pkValues[0]);
        const rowIdx = t.name === "customers" ? pk - 1000 : pk - 1;
        const c = t.columns.findIndex((x) => x.name === req.column);
        return t.row(rowIdx)[c] ?? null;
      }
      case "run_sql":
        return runSql(a.requestId, a.connId, a.sql, a.maxRows);
      case "cancel_query":
        inflight.get(a.requestId)?.();
        return null;
      case "export_csv":
        await delay(a.requestId, 1500);
        return 100_000;
      case "list_history": {
        const s = (a.search ?? "").toLowerCase();
        return history.filter((h) => (!a.connId || h.connId === a.connId) && h.sql.toLowerCase().includes(s)).slice(0, a.limit ?? 1000);
      }
      case "clear_history":
        history.length = 0;
        return null;
      case "plugin:clipboard-manager|write_text":
        await navigator.clipboard?.writeText(a.text).catch(() => {});
        console.info("[mock clipboard]\n" + a.text);
        return null;
      default:
        if (cmd.startsWith("plugin:")) return null;
        throw err({ kind: "internal", message: `mock backend: unknown command ${cmd}` });
    }
  });
}
