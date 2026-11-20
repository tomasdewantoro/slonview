// SQL editor tab. Owned by WP-FE-SQL. Rendered by App for tabs with kind "sql".
import type { SchemaNode } from "../../bindings/SchemaNode";

export interface SqlTabProps {
  tabId: string;
  connId: string;
  /** For autocomplete; may be empty while loading. */
  schema: SchemaNode[];
  /** Initial SQL when the tab is created (e.g. "SELECT * FROM ..."). */
  initialSql?: string;
}

export function SqlTab(_props: SqlTabProps) {
  return null;
}
