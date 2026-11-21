// Column autocomplete for the SQL editor: finds the tables a statement references (FROM, JOIN,
// UPDATE, INSERT INTO, with aliases) and resolves `alias.`, `table.` and `schema.table.` paths
// against the catalog columns from `list_columns`. Pure; unit tested.
import type { ColumnRef } from "../bindings/ColumnRef";

/** schema -> table -> columns in attnum order. */
export type ColumnIndex = Map<string, Map<string, ColumnRef[]>>;

export function buildColumnIndex(columns: ColumnRef[]): ColumnIndex {
  const index: ColumnIndex = new Map();
  for (const c of columns) {
    let tables = index.get(c.schema);
    if (!tables) index.set(c.schema, (tables = new Map()));
    let cols = tables.get(c.table);
    if (!cols) tables.set(c.table, (cols = []));
    cols.push(c);
  }
  return index;
}

interface Token {
  kind: "ident" | "punct" | "other";
  /** Identifier name as PostgreSQL sees it: unquoted folded to lower case, quoted verbatim. */
  value: string;
  /** Unquoted identifiers may be keywords. */
  quoted: boolean;
  from: number;
  to: number;
}

const IDENT_START = /[\p{L}_]/u;
const IDENT_PART = /[\p{L}\p{N}_$]/u;
const DOLLAR_TAG = /^\$([\p{L}_][\p{L}\p{N}_]*)?\$/u;

/** Lexes identifiers and punctuation; strings, comments, numbers and dollar bodies become "other". */
function tokenize(sql: string): Token[] {
  const out: Token[] = [];
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const c = sql[i];
    const start = i;
    if (/\s/.test(c)) {
      i++;
    } else if (c === "-" && sql[i + 1] === "-") {
      while (i < n && sql[i] !== "\n") i++;
    } else if (c === "/" && sql[i + 1] === "*") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") (depth++, (i += 2));
        else if (sql[i] === "*" && sql[i + 1] === "/") (depth--, (i += 2));
        else i++;
      }
    } else if (c === "'") {
      const escape = i > 0 && /[eE]/.test(sql[i - 1]) && !IDENT_PART.test(sql[i - 2] ?? "");
      i++;
      while (i < n) {
        if (escape && sql[i] === "\\") i += 2;
        else if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") break;
        else i++;
      }
      i++;
      out.push({ kind: "other", value: "", quoted: false, from: start, to: Math.min(i, n) });
    } else if (c === '"') {
      let value = "";
      i++;
      while (i < n) {
        if (sql[i] === '"' && sql[i + 1] === '"') (value += '"', (i += 2));
        else if (sql[i] === '"') break;
        else value += sql[i++];
      }
      i++;
      out.push({ kind: "ident", value, quoted: true, from: start, to: Math.min(i, n) });
    } else if (c === "$" && DOLLAR_TAG.test(sql.slice(i))) {
      const tag = DOLLAR_TAG.exec(sql.slice(i))![0];
      const end = sql.indexOf(tag, i + tag.length);
      i = end < 0 ? n : end + tag.length;
      out.push({ kind: "other", value: "", quoted: false, from: start, to: i });
    } else if (IDENT_START.test(c)) {
      while (i < n && IDENT_PART.test(sql[i])) i++;
      out.push({ kind: "ident", value: sql.slice(start, i).toLowerCase(), quoted: false, from: start, to: i });
    } else if (c === "." || c === "," || c === "(" || c === ")" || c === ";") {
      i++;
      out.push({ kind: "punct", value: c, quoted: false, from: start, to: i });
    } else {
      i++;
      while (i < n && /[\p{N}.]/u.test(sql[i]) && /\p{N}/u.test(c)) i++;
      out.push({ kind: "other", value: c, quoted: false, from: start, to: i });
    }
  }
  return out;
}

export interface TableRef {
  schema: string | null;
  table: string;
  alias: string | null;
}

/** Words that end a table reference instead of naming its alias. */
const NOT_ALIAS = new Set(
  (
    "where join inner left right full cross outer natural on using group order limit offset having union " +
    "except intersect window set values returning for lateral select fetch default tablesample only from " +
    "as when then else end and or not into do conflict overriding"
  ).split(" "),
);
/** Keywords that end a FROM list (after them a comma no longer separates tables). */
const ENDS_FROM = new Set("where group having order limit offset fetch for window union except intersect returning set values select".split(" "));

const isWord = (t: Token | undefined, word: string) => t?.kind === "ident" && !t.quoted && t.value === word;
const isPunct = (t: Token | undefined, p: string) => t?.kind === "punct" && t.value === p;

/** Tables referenced by the statement (subqueries included), in order of appearance. */
export function tableReferences(sql: string): TableRef[] {
  const tokens = tokenize(sql);
  const refs: TableRef[] = [];
  // Per parenthesis depth: whether a comma there separates FROM-list items.
  const inFrom: boolean[] = [false];
  let i = 0;
  /** Reads `[ONLY] name[.name…] [[AS] alias]` at `i`; a function call or subquery reads nothing. */
  const readReference = (insert: boolean) => {
    if (isWord(tokens[i], "only")) i++;
    const first = tokens[i];
    if (first?.kind !== "ident" || (!first.quoted && NOT_ALIAS.has(first.value))) return;
    const parts = [first.value];
    let j = i + 1;
    while (isPunct(tokens[j], ".") && tokens[j + 1]?.kind === "ident") {
      parts.push(tokens[j + 1].value);
      j += 2;
    }
    // FROM generate_series(…) is a function, not a table; INSERT INTO t (cols) is a column list.
    if (isPunct(tokens[j], "(") && !insert) return;
    i = j;
    let alias: string | null = null;
    if (isWord(tokens[i], "as") && tokens[i + 1]?.kind === "ident") {
      alias = tokens[i + 1].value;
      i += 2;
    } else if (tokens[i]?.kind === "ident" && (tokens[i].quoted || !NOT_ALIAS.has(tokens[i].value))) {
      alias = tokens[i].value;
      i++;
    }
    // database.schema.table: keep the last two parts.
    refs.push({ schema: parts.length > 1 ? parts[parts.length - 2] : null, table: parts[parts.length - 1], alias });
  };
  while (i < tokens.length) {
    const t = tokens[i];
    const depth = inFrom.length - 1;
    i++;
    if (isPunct(t, "(")) inFrom.push(false);
    else if (isPunct(t, ")")) {
      if (inFrom.length > 1) inFrom.pop();
    } else if (isPunct(t, ";")) inFrom.splice(0, inFrom.length, false);
    else if (isPunct(t, ",") && inFrom[depth]) readReference(false);
    else if (t.kind === "ident" && !t.quoted) {
      if (t.value === "from") {
        inFrom[depth] = true;
        readReference(false);
      } else if (t.value === "join" || t.value === "update") {
        readReference(false);
      } else if (t.value === "into") {
        readReference(true);
      } else if (ENDS_FROM.has(t.value)) {
        inFrom[depth] = false;
      }
    }
  }
  return refs;
}

/** `public` first, then the first schema (alphabetical) holding the table. */
export function resolveTable(index: ColumnIndex, schema: string | null, table: string): ColumnRef[] | null {
  if (schema !== null) return index.get(schema)?.get(table) ?? null;
  const pub = index.get("public")?.get(table);
  if (pub) return pub;
  for (const name of [...index.keys()].sort()) {
    const cols = index.get(name)!.get(table);
    if (cols) return cols;
  }
  return null;
}

export interface ColumnCompletion {
  /** Offset in `sql` where the typed word starts (the completion replaces from here). */
  from: number;
  columns: ColumnRef[];
  /** True after `qualifier.`: only that relation's columns; false: columns of every referenced table. */
  qualified: boolean;
}

/**
 * Columns to offer at `pos` in `sql` (one statement). After `x.` resolves x as an alias, then as a
 * table; after `s.t.` as schema.table. A bare word offers the columns of every referenced table.
 * Returns null when there is nothing to offer (e.g. `schema.` is left to table completion).
 */
export function columnCompletion(index: ColumnIndex, sql: string, pos: number): ColumnCompletion | null {
  const before = tokenize(sql.slice(0, pos));
  let k = before.length - 1;
  let from = pos;
  const last = before[k];
  if (last && last.to === pos && last.kind === "ident") {
    // An unfinished quoted identifier is left alone.
    if (last.quoted && !sql.slice(last.from, last.to).endsWith('"')) return null;
    from = last.from;
    k--;
  } else if (last && last.to === pos && !(last.kind === "punct" && last.value === ".")) {
    return null;
  }
  const path: string[] = [];
  while (before[k]?.kind === "punct" && before[k].value === "." && before[k - 1]?.kind === "ident" && before[k - 1].to === before[k].from) {
    path.unshift(before[k - 1].value);
    k -= 2;
  }
  const refs = tableReferences(sql);
  if (path.length === 0) {
    if (from === pos) return null;
    // Right after FROM / JOIN / INTO / UPDATE a table name is expected, not a column.
    const prev = before[k];
    if (prev?.kind === "ident" && !prev.quoted && ["from", "join", "into", "update", "table"].includes(prev.value)) return null;
    const columns = refs.flatMap((r) => resolveTable(index, r.schema, r.table) ?? []);
    const seen = new Set<string>();
    const unique = columns.filter((c) => {
      const key = `${c.schema}\0${c.table}\0${c.name}`;
      return seen.has(key) ? false : (seen.add(key), true);
    });
    return unique.length ? { from, columns: unique, qualified: false } : null;
  }
  let columns: ColumnRef[] | null = null;
  if (path.length === 1) {
    const ref = refs.find((r) => r.alias === path[0]) ?? refs.find((r) => !r.alias && r.table === path[0]);
    columns = ref ? resolveTable(index, ref.schema, ref.table) : resolveTable(index, null, path[0]);
  } else {
    columns = resolveTable(index, path[path.length - 2], path[path.length - 1]);
  }
  return columns ? { from, columns, qualified: true } : null;
}
