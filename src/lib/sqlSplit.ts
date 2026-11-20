// Lexical PostgreSQL statement splitter for the SQL editor (run statement at cursor).
// Understands '' strings, E'' strings (backslash escapes), "" identifiers, $tag$ bodies,
// -- line comments and nested /* */ comments. Assumes standard_conforming_strings = on.

export interface SqlStatement {
  /** Offset of the first character that is not whitespace or comment. */
  start: number;
  /** Offset just past the last non-whitespace/comment character (terminating `;` excluded). */
  end: number;
  text: string;
}

interface Segment {
  /** Raw segment bounds: from previous `;` (exclusive) through this `;` (inclusive). */
  from: number;
  to: number;
  stmt: SqlStatement | null;
}

const isIdentChar = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}_$]/u.test(c);
const DOLLAR_TAG = /^\$([\p{L}_][\p{L}\p{N}_]*)?\$/u;

function segments(sql: string): Segment[] {
  const out: Segment[] = [];
  let segFrom = 0;
  let codeStart = -1;
  let codeEnd = -1;
  const n = sql.length;
  let i = 0;

  const markCode = (from: number, to: number) => {
    if (codeStart < 0) codeStart = from;
    codeEnd = to;
  };
  const close = (to: number) => {
    out.push({
      from: segFrom,
      to,
      stmt: codeStart < 0 ? null : { start: codeStart, end: codeEnd, text: sql.slice(codeStart, codeEnd) },
    });
    segFrom = to;
    codeStart = -1;
    codeEnd = -1;
  };

  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === ";") {
      i += 1;
      close(i);
    } else if (c === "-" && next === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl < 0 ? n : nl;
    } else if (c === "/" && next === "*") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth += 1;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth -= 1;
          i += 2;
        } else i += 1;
      }
    } else if (c === "'" || c === '"') {
      const from = i;
      const escapes = c === "'" && (sql[i - 1] === "E" || sql[i - 1] === "e") && !isIdentChar(sql[i - 2]);
      i += 1;
      while (i < n) {
        if (escapes && sql[i] === "\\") i += 2;
        else if (sql[i] === c) {
          if (sql[i + 1] === c) i += 2;
          else {
            i += 1;
            break;
          }
        } else i += 1;
      }
      i = Math.min(i, n);
      markCode(from, i);
    } else if (c === "$" && !isIdentChar(sql[i - 1])) {
      const m = DOLLAR_TAG.exec(sql.slice(i, i + 64));
      if (m) {
        const from = i;
        const close = sql.indexOf(m[0], i + m[0].length);
        i = close < 0 ? n : close + m[0].length;
        markCode(from, i);
      } else {
        markCode(i, i + 1);
        i += 1;
      }
    } else if (/\s/.test(c)) {
      i += 1;
    } else {
      markCode(i, i + 1);
      i += 1;
    }
  }
  if (segFrom < n || out.length === 0) close(n);
  return out;
}

/** All non-empty statements in order. Comment-only and empty segments are dropped. */
export function splitStatements(sql: string): SqlStatement[] {
  return segments(sql).flatMap((s) => (s.stmt ? [s.stmt] : []));
}

/**
 * Statement containing `pos` (a document offset). A cursor right after a `;` belongs to the
 * statement that semicolon terminates. A cursor in an empty segment (blank lines / comments
 * between statements, or after the last `;`) picks the previous statement, else the next one.
 */
export function statementAt(sql: string, pos: number): SqlStatement | null {
  const segs = segments(sql);
  const idx = segs.findIndex((s) => pos >= s.from && pos <= s.to);
  if (idx < 0) return null;
  if (segs[idx].stmt) return segs[idx].stmt;
  for (let j = idx - 1; j >= 0; j--) if (segs[j].stmt) return segs[j].stmt;
  for (let j = idx + 1; j < segs.length; j++) if (segs[j].stmt) return segs[j].stmt;
  return null;
}

/**
 * Converts a Postgres error position (1-based, counted in characters/code points) within
 * `text` to a 0-based UTF-16 offset within `text`. Clamped to the text length.
 */
export function pgPositionToOffset(text: string, position: number): number {
  let offset = 0;
  let chars = 1;
  while (chars < position && offset < text.length) {
    const cp = text.codePointAt(offset)!;
    offset += cp > 0xffff ? 2 : 1;
    chars += 1;
  }
  return Math.min(offset, text.length);
}
