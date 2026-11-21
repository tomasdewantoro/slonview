import { describe, expect, it } from "vitest";
import { formatSql } from "./sqlFormat";

describe("formatSql", () => {
  it("breaks a one-liner into clauses with upper-case keywords", () => {
    expect(formatSql("select a,b from t where x=1")).toBe("SELECT\n  a,\n  b\nFROM\n  t\nWHERE\n  x = 1");
  });

  it("keeps a dollar-quoted function body intact", () => {
    const out = formatSql("CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $$ select 1 $$;");
    expect(out).toContain("$$ select 1 $$");
  });

  it("keeps positional parameters", () => {
    const out = formatSql("select * from t where id=$1 and n=$2");
    expect(out).toContain("id = $1");
    expect(out).toContain("n = $2");
  });

  it("keeps a mixed-case quoted identifier byte-for-byte", () => {
    expect(formatSql('select "Weird ""Name""" from t')).toContain('"Weird ""Name"""');
  });

  it("keeps two statements separated by a blank line and the trailing newline", () => {
    expect(formatSql("select 1; select 2;\n")).toBe("SELECT\n  1;\n\nSELECT\n  2;\n");
  });

  it("does not add a trailing newline the input lacked", () => {
    expect(formatSql("select 1;").endsWith("\n")).toBe(false);
  });

  it("throws on psql meta-commands and garbage instead of mangling them", () => {
    expect(() => formatSql("\\dt users")).toThrow();
    expect(() => formatSql("select ((( from")).toThrow();
  });
});
