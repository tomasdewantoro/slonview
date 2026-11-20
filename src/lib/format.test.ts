import { describe, expect, it } from "vitest";
import type { Column } from "../bindings/Column";
import { quoteLiteral, serializeRows } from "./format";

const col = (name: string): Column => ({ name, typeName: "text", nullable: true, isPk: false });
const cols = [col("id"), col("note")];

describe("serializeRows tsv", () => {
  it("writes header and plain rows", () => {
    expect(serializeRows("tsv", cols, [["1", "a"], ["2", "b"]])).toBe("id\tnote\n1\ta\n2\tb");
  });

  it("NULL is empty, text 'NULL' stays literal, empty string is empty", () => {
    expect(serializeRows("tsv", cols, [[null, "NULL"], ["", null]])).toBe("id\tnote\n\tNULL\n\t");
  });

  it("quotes values with tab, newline or double quote", () => {
    expect(serializeRows("tsv", cols, [["a\tb", 'say "hi"'], ["x\ny", "r\rz"]])).toBe(
      'id\tnote\n"a\tb"\t"say ""hi"""\n"x\ny"\t"r\rz"',
    );
  });

  it("keeps unicode and commas untouched", () => {
    expect(serializeRows("tsv", cols, [["日本", "a,b 🙂"]])).toBe("id\tnote\n日本\ta,b 🙂");
  });

  it("quotes column names that need it", () => {
    expect(serializeRows("tsv", [col('we"ird')], [])).toBe('"we""ird"');
  });
});

describe("serializeRows csv", () => {
  it("follows RFC 4180 with CRLF rows", () => {
    expect(serializeRows("csv", cols, [["1", "a,b"], ["2", 'q"uote']])).toBe('id,note\r\n1,"a,b"\r\n2,"q""uote"');
  });

  it("distinguishes NULL, empty string and 'NULL'", () => {
    expect(serializeRows("csv", cols, [[null, ""], ["NULL", null]])).toBe('id,note\r\n,""\r\nNULL,');
  });

  it("quotes embedded newlines and keeps backslashes", () => {
    expect(serializeRows("csv", cols, [["line1\nline2", "c:\\dir"]])).toBe('id,note\r\n"line1\nline2",c:\\dir');
  });

  it("keeps unicode", () => {
    expect(serializeRows("csv", cols, [["ü", "🙂"]])).toBe("id,note\r\nü,🙂");
  });
});

describe("serializeRows json", () => {
  it("emits objects with string values and nulls, pretty printed", () => {
    const out = serializeRows("json", cols, [["1", null], ["2", "NULL"]]);
    expect(JSON.parse(out)).toEqual([
      { id: "1", note: null },
      { id: "2", note: "NULL" },
    ]);
    expect(out).toBe('[\n  {\n    "id": "1",\n    "note": null\n  },\n  {\n    "id": "2",\n    "note": "NULL"\n  }\n]');
  });

  it("escapes quotes, newlines, backslashes", () => {
    const v = 'a"b\nc\\d 🙂';
    expect(JSON.parse(serializeRows("json", [col("x")], [[v]]))).toEqual([{ x: v }]);
  });

  it("empty selection is an empty array", () => {
    expect(serializeRows("json", cols, [])).toBe("[]");
  });
});

describe("serializeRows insert", () => {
  it("uses result as the default target", () => {
    expect(serializeRows("insert", cols, [["1", "a"]])).toBe(`INSERT INTO result ("id", "note") VALUES ('1', 'a');`);
  });

  it("quotes schema/table/column identifiers", () => {
    const out = serializeRows("insert", [col('Weird "Col"')], [["x"]], { schema: "Sales Data", table: 'Weird "Name" Table' });
    expect(out).toBe(`INSERT INTO "Sales Data"."Weird ""Name"" Table" ("Weird ""Col""") VALUES ('x');`);
  });

  it("NULL vs 'NULL' vs empty string, one statement per row", () => {
    expect(serializeRows("insert", cols, [[null, "NULL"], ["", "it's"]])).toBe(
      `INSERT INTO result ("id", "note") VALUES (NULL, 'NULL');\nINSERT INTO result ("id", "note") VALUES ('', 'it''s');`,
    );
  });

  it("uses E'' with doubled backslashes when a backslash is present", () => {
    expect(quoteLiteral("c:\\dir's")).toBe(`E'c:\\\\dir''s'`);
  });

  it("keeps newlines and unicode inside literals", () => {
    expect(quoteLiteral("a\nb 🙂")).toBe("'a\nb 🙂'");
  });
});
