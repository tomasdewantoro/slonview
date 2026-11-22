// Server activity: pg_stat_activity of the tab's connection, with cancel/terminate per session.
import { ask } from "@tauri-apps/plugin-dialog";
import { Ban, CircleStop, LoaderCircle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../api";
import type { Activity } from "../bindings/Activity";
import { appStore, tabReadOnly, useApp, type ActivityTab as ActivityTabInfo } from "../store/app";
import { ErrorPanel } from "./ErrorPanel";

const AUTO_REFRESH_MS = 2000;
const QUERY_PREVIEW_CHARS = 200;

/** Compact age: 850 ms, 12.3 s, 4 min 05 s, 2 h 03 min, 3 d 4 h. */
export function formatAge(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "";
  const v = Math.max(0, ms);
  if (v < 1000) return `${Math.round(v)} ms`;
  if (v < 60_000) return `${(v / 1000).toFixed(1)} s`;
  const s = Math.floor(v / 1000);
  if (s < 3600) return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")} min`;
  return `${Math.floor(s / 86_400)} d ${Math.floor((s % 86_400) / 3600)} h`;
}

/** Ages arrive measured on the server; between refreshes they keep counting from when the list arrived. */
function liveAge(ms: number | null, fetchedAt: number, now: number): number | null {
  return ms === null ? null : ms + Math.max(0, now - fetchedAt);
}

interface Loaded {
  rows: Activity[];
  fetchedAt: number;
}

export function ActivityTab({ tab, connId }: { tab: ActivityTabInfo; connId: string }) {
  const readOnly = useApp((s) => tabReadOnly(s, tab));
  const nonce = useApp((s) => s.structureNonce[tab.id] ?? 0);
  const [includeIdle, setIncludeIdle] = useState(false);
  const [auto, setAuto] = useState(false);
  const [data, setData] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [now, setNow] = useState(() => Date.now());
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    try {
      const rows = await api.listActivity(connId, includeIdle);
      if (mine !== seq.current) return;
      const fetchedAt = Date.now();
      setData({ rows, fetchedAt });
      setNow(fetchedAt);
      setError(null);
    } catch (e) {
      if (mine === seq.current) setError(e);
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [connId, includeIdle]);

  // First load, Show idle changes, and ⌘R / Refresh.
  useEffect(() => {
    void load();
  }, [load, nonce]);

  // Auto-refresh only while the tab is shown (it unmounts when another tab is active) and the window is visible.
  useEffect(() => {
    if (!auto) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, AUTO_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [auto, load]);

  // Ages tick every second between refreshes.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const signal = async (a: Activity, terminate: boolean) => {
    const what = terminate ? "Terminate" : "Cancel";
    const detail = terminate
      ? `Terminate session ${a.pid}${a.user ? ` (${a.user})` : ""}? Its connection closes and any open transaction is rolled back.`
      : `Cancel the running query of session ${a.pid}${a.user ? ` (${a.user})` : ""}? The session stays connected.`;
    const confirmed = await ask(detail, {
      title: terminate ? "Terminate session" : "Cancel query",
      kind: "warning",
      okLabel: terminate ? "Terminate" : "Cancel query",
      cancelLabel: terminate ? "Keep session" : "Keep running",
    });
    if (!confirmed) return;
    const { pushToast } = appStore.getState();
    try {
      const ok = await api.signalBackend(connId, a.pid, terminate);
      pushToast("info", ok ? `${what} sent to session ${a.pid}` : `Session ${a.pid} had already ended`);
    } catch (e) {
      pushToast("error", `${what} failed: ${errorMessage(e)}`);
    }
    void load();
  };

  const rows = data?.rows ?? [];
  const others = rows.filter((a) => !a.isSelf).length;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-2">
        <span className="px-1 text-xs text-muted tabular-nums" aria-live="polite">
          {data ? `${others} other ${others === 1 ? "session" : "sessions"}${includeIdle ? "" : " not idle"}` : ""}
        </span>
        <span className="flex-1" />
        <label className="flex h-6 items-center gap-1.5 text-xs text-muted hover:text-ink">
          <input type="checkbox" checked={includeIdle} onChange={(e) => setIncludeIdle(e.target.checked)} className="size-3.5 accent-accent" />
          Show idle
        </label>
        <label className="flex h-6 items-center gap-1.5 text-xs text-muted hover:text-ink" title="Refresh every 2 seconds while this tab is visible">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} className="size-3.5 accent-accent" />
          Auto-refresh
        </label>
        <button className="btn h-6 px-2 text-xs" onClick={() => void load()} disabled={loading} title="Refresh (⌘R)">
          {loading ? <LoaderCircle size={12} className="animate-spin motion-reduce:animate-none" aria-hidden /> : <RefreshCw size={12} aria-hidden />} Refresh
        </button>
      </div>
      {error != null && <ErrorPanel error={error} onRetry={() => void load()} />}
      <div className="min-h-0 flex-1 overflow-auto">
        <table aria-label="Server activity" className="w-full border-collapse text-[12.5px]">
          <thead className="sticky top-0 z-10 bg-surface text-left text-xs text-muted">
            <tr className="border-b border-border">
              <th className="px-2 py-1.5 text-right font-medium">PID</th>
              <th className="px-2 py-1.5 font-medium">User</th>
              <th className="px-2 py-1.5 font-medium">Application</th>
              <th className="px-2 py-1.5 font-medium">Client</th>
              <th className="px-2 py-1.5 font-medium">State</th>
              <th className="px-2 py-1.5 font-medium">Waiting on</th>
              <th className="px-2 py-1.5 text-right font-medium">Transaction</th>
              <th className="px-2 py-1.5 text-right font-medium">Query</th>
              <th className="w-full px-2 py-1.5 font-medium">SQL</th>
              <th className="px-2 py-1.5">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => {
              const active = a.state === "active";
              return (
                <tr
                  key={a.pid}
                  data-pid={a.pid}
                  data-self={a.isSelf || undefined}
                  className={`border-b border-border align-top ${a.isSelf ? "bg-accent-soft" : "hover:bg-row-highlight"}`}
                >
                  <td className="px-2 py-1 text-right font-mono tabular-nums">{a.pid}</td>
                  <td className="px-2 py-1 whitespace-nowrap">{a.user ?? <span className="text-faint">{a.backendType}</span>}</td>
                  <td className="max-w-40 truncate px-2 py-1" title={a.applicationName}>
                    {a.applicationName}
                    {a.isSelf && <span className="ml-1.5 rounded bg-accent px-1 text-[10px] leading-4 font-medium text-accent-fg" title="The session that ran this list">this session</span>}
                  </td>
                  <td className="px-2 py-1 font-mono whitespace-nowrap text-muted">{a.clientAddr ?? "local"}</td>
                  <td className={`px-2 py-1 whitespace-nowrap ${active ? "text-ok" : a.state?.startsWith("idle in") ? "text-warn" : "text-muted"}`}>{a.state ?? ""}</td>
                  <td className="px-2 py-1 whitespace-nowrap text-muted">{a.waitEvent ?? ""}</td>
                  <td className="px-2 py-1 text-right whitespace-nowrap tabular-nums">{data && formatAge(liveAge(a.xactAgeMs, data.fetchedAt, now))}</td>
                  <td className="px-2 py-1 text-right whitespace-nowrap tabular-nums">{data && active ? formatAge(liveAge(a.queryAgeMs, data.fetchedAt, now)) : ""}</td>
                  <td className="max-w-0 px-2 py-1">
                    <code className="selectable block truncate font-mono text-xs" title={a.query}>
                      {a.query.length > QUERY_PREVIEW_CHARS ? `${a.query.slice(0, QUERY_PREVIEW_CHARS)}…` : a.query}
                    </code>
                  </td>
                  <td className="px-1 py-0.5 whitespace-nowrap">
                    {a.canSignal && (
                      <span className="flex gap-0.5">
                        <button className="icon-btn" aria-label={`Cancel query of session ${a.pid}`} title="Cancel query (pg_cancel_backend)" onClick={() => void signal(a, false)}>
                          <Ban size={13} />
                        </button>
                        {!readOnly && (
                          <button
                            className="icon-btn text-error"
                            aria-label={`Terminate session ${a.pid}`}
                            title="Terminate session (pg_terminate_backend)"
                            onClick={() => void signal(a, true)}
                          >
                            <CircleStop size={13} />
                          </button>
                        )}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {data && others === 0 && (
          <p className="px-3 py-6 text-center text-pretty text-muted">
            {includeIdle ? "No other sessions on this database." : "No other sessions are working right now. Turn on Show idle to list idle ones."}
          </p>
        )}
      </div>
    </div>
  );
}
