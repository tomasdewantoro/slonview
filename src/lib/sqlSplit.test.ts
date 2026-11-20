import { describe, expect, it } from "vitest";
import { pgPositionToOffset, splitStatements, statementAt } from "./sqlSplit";

const texts = (sql: string) => splitStatements(sql).map((s) => s.text);

describe("splitStatements", () => {
  it("splits on semicolons and trims", () => {
    expect(texts("select 1;  select 2 ;\n\nselect 3")).toEqual(["select 1", "select 2", "select 3"]);
  });

  it("ignores semicolons inside quotes and identifiers", () => {
    expect(texts(`select ';' as "a;b"; select 'it''s;'`)).toEqual([`select ';' as "a;b"`, `select 'it''s;'`]);
  });

  it("handles E'' strings with escaped quotes", () => {
    expect(texts(`select E'a\\';b'; select 2`)).toEqual([`select E'a\\';b'`, "select 2"]);
  });

  it("treats backslash literally in standard strings", () => {
    expect(texts(`select 'a\\'; select 2`)).toEqual([`select 'a\\'`, "select 2"]);
  });

  it("does not treat identifier ending in e as E-string prefix", () => {
    expect(texts(`select name'x;' ; select 2`)).toEqual([`select name'x;'`, "select 2"]);
  });

  it("handles dollar-quoted bodies with and without tags", () => {
    const fn = `create function f() returns int as $$ begin; return 1; end; $$ language plpgsql`;
    const tagged = `do $body$ begin perform 1; raise notice '$$'; end $body$`;
    expect(texts(`${fn}; ${tagged}; select 3`)).toEqual([fn, tagged, "select 3"]);
  });

  it("does not treat $1 parameters or identifiers with $ as dollar quotes", () => {
    expect(texts("select $1; select a$b$ from t; select 3")).toEqual(["select $1", "select a$b$ from t", "select 3"]);
  });

  it("ignores semicolons in line and nested block comments", () => {
    const sql = "-- a; b\nselect 1 /* x; /* y; */ z; */ + 1; /* only; comment */ ; select 2 -- tail;";
    expect(texts(sql)).toEqual(["select 1 /* x; /* y; */ z; */ + 1", "select 2"]);
  });

  it("excludes leading comments from statement start", () => {
    const sql = "-- header\nselect 1";
    expect(splitStatements(sql)).toEqual([{ start: 10, end: 18, text: "select 1" }]);
  });

  it("returns nothing for empty or comment-only input", () => {
    expect(texts("")).toEqual([]);
    expect(texts("  ;; -- x\n /* y */")).toEqual([]);
  });

  it("tolerates unterminated quotes", () => {
    expect(texts("select 'abc; select 2")).toEqual(["select 'abc; select 2"]);
  });

  it("handles unicode", () => {
    expect(texts("select '日本;語' as 名前; select '🙂'")).toEqual(["select '日本;語' as 名前", "select '🙂'"]);
  });
});

describe("statementAt", () => {
  const sql = "select 1;\nselect ';' ;\n\n-- note\n\nselect 3";
  // offsets: "select 1;" 0-9, "\n" 9, "select ';' ;" 10-22

  it("finds the statement under the cursor", () => {
    expect(statementAt(sql, 3)?.text).toBe("select 1");
    expect(statementAt(sql, 17)?.text).toBe("select ';'");
    expect(statementAt(sql, sql.length)?.text).toBe("select 3");
  });

  it("cursor right after ; belongs to that statement", () => {
    expect(statementAt(sql, 9)?.text).toBe("select 1");
  });

  it("cursor at start of the next line belongs to the next statement", () => {
    expect(statementAt(sql, 10)?.text).toBe("select ';'");
  });

  it("cursor in a comment between statements belongs to the following statement's segment", () => {
    expect(statementAt(sql, sql.indexOf("note"))?.text).toBe("select 3");
  });

  it("cursor after the trailing ; falls back to the previous statement", () => {
    const s = "select 1;\n\n";
    expect(statementAt(s, s.length)?.text).toBe("select 1");
  });

  it("cursor inside a dollar-quoted body selects the whole function", () => {
    const s = "select 0;\ncreate function f() returns void as $$ begin; perform 1; end $$ language plpgsql;\nselect 2";
    const st = statementAt(s, s.indexOf("perform"));
    expect(st?.text.startsWith("create function")).toBe(true);
    expect(st?.text.endsWith("plpgsql")).toBe(true);
    expect(st?.start).toBe(10);
  });

  it("returns null for empty input", () => {
    expect(statementAt("", 0)).toBeNull();
    expect(statementAt("  -- c", 2)).toBeNull();
  });
});

describe("pgPositionToOffset", () => {
  it("is identity minus one for BMP text", () => {
    expect(pgPositionToOffset("select foo", 8)).toBe(7);
  });

  it("counts astral characters as one", () => {
    const t = "select '🙂', bogus";
    expect(t.slice(pgPositionToOffset(t, 13))).toBe("bogus");
  });

  it("clamps past the end", () => {
    expect(pgPositionToOffset("ab", 10)).toBe(2);
  });
});
