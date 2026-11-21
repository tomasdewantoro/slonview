// "Format SQL" for the editor: sql-formatter's PostgreSQL dialect, imported tree-shakably.
import { formatDialect, postgresql } from "sql-formatter";

/**
 * Formats `text` as PostgreSQL. Keeps the input's trailing-newline state (the formatter drops it).
 * Throws the formatter's error on input it cannot parse.
 */
export function formatSql(text: string): string {
  const out = formatDialect(text, { dialect: postgresql, keywordCase: "upper", tabWidth: 2, linesBetweenQueries: 1 });
  return /\n\s*$/.test(text) && !out.endsWith("\n") ? `${out}\n` : out;
}
