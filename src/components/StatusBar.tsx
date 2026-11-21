import { LoaderCircle } from "lucide-react";
import { appStore, findRelation, useApp } from "../store/app";
import { formatCount } from "../store/queries";
import { useEffect, useRef, useState } from "react";
import { COMMON_TIME_ZONES } from "./ConnectionDialog";
import { errorMessage } from "../api";

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
      dot = "bg-error";
    } else {
      connLabel = `${profile.user}@${profile.host}:${profile.port}/${profile.database}`;
      dot = "bg-ok";
    }
  }
  const version = conn?.server?.version.split(" on ")[0];

  return (
    <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-border bg-surface px-3 text-[11px] text-muted tabular-nums">
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
      {conn?.status === "connected" && profile && <TimeZonePicker key={profile.id} value={profile.timeZone} />}
      <span className="flex max-w-80 shrink-0 items-center gap-1.5 truncate" title={conn?.server?.version}>
        <span aria-hidden className={`size-1.5 rounded-full ${dot}`} />
        {connLabel}
      </span>
    </footer>
  );
}

function TimeZonePicker({ value }: { value: string | null }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const macZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const zones = ["", ...new Set([macZone, ...COMMON_TIME_ZONES, ...(value ? [value] : [])].filter(Boolean))].filter((zone) => (zone || "Server default").toLowerCase().includes(search.toLowerCase()));
  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const outside = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  const choose = async (zone: string) => {
    setBusy(true); setError(null);
    try { await appStore.getState().setTimeZone(zone || null); setOpen(false); trigger.current?.focus(); }
    catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  };
  return <div ref={root} className="relative shrink-0" onKeyDown={(e) => {
    if (!open) return;
    if (e.key === "Escape") { e.stopPropagation(); setOpen(false); trigger.current?.focus(); }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault(); e.stopPropagation();
      const items = [...(root.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [])];
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      items[(index + (e.key === "ArrowDown" ? 1 : items.length - 1) + items.length) % items.length]?.focus();
    }
  }}>
    <button ref={trigger} className="rounded px-1 font-mono hover:bg-surface-2" data-testid="session-tz" title="Change session time zone" aria-label="Change session time zone" aria-expanded={open} aria-haspopup="dialog" onClick={() => { setSearch(""); setError(null); setOpen(!open); }}>{value || "Server default"}</button>
    {open && <div role="dialog" aria-label="Session time zone" className="absolute right-0 bottom-full z-50 mb-2 w-72 rounded-md border border-border bg-raised p-2 text-xs text-ink shadow-xl">
      <label htmlFor="status-tz-search" className="mb-1 block font-semibold">Session time zone</label>
      <input ref={input} id="status-tz-search" className="field w-full" placeholder="Search time zones" value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && zones.length) { e.preventDefault(); void choose(zones[0]); } }} disabled={busy} />
      <div role="listbox" aria-label="Time zones" aria-busy={busy} className="mt-1 max-h-56 overflow-auto">
        {zones.map((zone) => <button key={zone} role="option" aria-selected={(value ?? "") === zone} disabled={busy} className="block w-full rounded px-2 py-1.5 text-left font-mono hover:bg-surface-2 aria-selected:bg-accent-soft" onClick={() => void choose(zone)}>{zone || "Server default"}{zone === macZone ? " (this Mac)" : ""}</button>)}
        {!zones.length && <p className="p-2 text-muted">No matching time zones.</p>}
      </div>
      {busy && <p role="status" className="mt-1 text-muted">Applying time zone…</p>}
      {error && <p role="alert" className="mt-1 text-error">{error}</p>}
    </div>}
  </div>;
}
