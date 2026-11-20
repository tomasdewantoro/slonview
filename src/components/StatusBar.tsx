import { LoaderCircle } from "lucide-react";
import { findRelation, useApp } from "../store/app";
import { formatCount } from "../store/queries";

export function StatusBar() {
  const conn = useApp((s) => s.conn);
  const profile = useApp((s) => s.profiles.find((p) => p.id === s.conn?.profileId));
  const tab = useApp((s) => s.tabs.find((t) => t.id === s.activeTabId));
  const data = useApp((s) => (s.activeTabId ? s.tableData[s.activeTabId] : undefined));
  const rel = useApp((s) => (tab?.kind === "table" ? findRelation(s.tree, tab.query.schema, tab.query.table) : undefined));

  let connLabel = "Not connected";
  let dot = "bg-faint";
  if (conn && profile) {
    if (conn.status === "connecting") {
      connLabel = `Connecting to ${profile.name}…`;
      dot = "bg-warn";
    } else if (conn.status === "failed") {
      connLabel = `${profile.name}: connection failed`;
      dot = "bg-danger";
    } else {
      connLabel = `${profile.user}@${profile.host}:${profile.port}/${profile.database}`;
      dot = "bg-ok";
    }
  }
  const version = conn?.server?.version.split(" on ")[0];

  return (
    <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-line bg-side px-3 text-[11px] text-muted tabular-nums">
      {tab?.kind === "table" && data && (
        <>
          <span className="flex shrink-0 items-center gap-1">
            {data.loading && <LoaderCircle size={11} className="animate-spin" aria-hidden />}
            {data.rows.length.toLocaleString()}
            {data.nextCursor ? "+" : ""} {data.rows.length === 1 && !data.nextCursor ? "row" : "rows"} loaded
            {data.exactCount !== null
              ? ` of ${data.exactCount.toLocaleString()}`
              : rel && rel.estRows >= 0 && data.nextCursor && tab.query.filters.length === 0 && !tab.query.rawWhere.trim()
                ? ` of ~${formatCount(rel.estRows)}`
                : ""}
          </span>
          {data.sql && <span className="shrink-0">{data.elapsedMs} ms</span>}
          <span className="min-w-0 flex-1 truncate font-mono" title={data.sql}>
            {data.sql}
          </span>
        </>
      )}
      {tab?.kind !== "table" && <span className="flex-1" />}
      {version && <span className="hidden shrink-0 lg:inline">{version}</span>}
      <span className="flex max-w-80 shrink-0 items-center gap-1.5 truncate" title={conn?.server?.version}>
        <span aria-hidden className={`size-1.5 rounded-full ${dot}`} />
        {connLabel}
      </span>
    </footer>
  );
}
