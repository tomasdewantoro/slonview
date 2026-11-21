import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Check, Copy, LoaderCircle, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api, errorMessage } from "../api";
import type { Column } from "../bindings/Column";

interface Props {
  connId: string;
  schema: string;
  table: string;
  columns: Column[];
  row: (string | null)[];
  col: number;
  truncated: boolean;
  onClose: () => void;
}

type Full = { state: "loading" } | { state: "ok"; value: string | null } | { state: "error"; message: string };

/** Pretty-print json/jsonb; anything unparsable is shown raw. */
export function formatJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

/** Byte length of a Postgres hex bytea literal ("\x0a0b..."); null when not in hex format. */
export function byteaLength(value: string): number | null {
  return /^\\x[0-9a-fA-F]*$/.test(value) ? (value.length - 2) / 2 : null;
}

export function CellInspector({ connId, schema, table, columns, row, col, truncated, onClose }: Props) {
  const column = columns[col];
  const pkIdx = columns.flatMap((c, i) => (c.isPk ? [i] : []));
  const canFetch = truncated && pkIdx.length > 0;
  const shown = row[col];
  const [full, setFull] = useState<Full | null>(null);
  const [copied, setCopied] = useState(false);

  const pkKey = pkIdx.map((i) => row[i]).join("\u0000");
  useEffect(() => {
    setCopied(false);
    if (!canFetch) {
      setFull(null);
      return;
    }
    let live = true;
    setFull({ state: "loading" });
    api
      .getCell({
        connId,
        schema,
        table,
        pkColumns: pkIdx.map((i) => columns[i].name),
        pkValues: pkIdx.map((i) => row[i]),
        column: column.name,
      })
      .then((value) => live && setFull({ state: "ok", value }))
      .catch((e) => live && setFull({ state: "error", message: errorMessage(e) }));
    return () => {
      live = false;
    };
    // pkKey + column identify the cell; row/columns arrays change identity on every page append.
  }, [connId, schema, table, column?.name, pkKey, canFetch]);

  if (!column) return null;
  const value = full?.state === "ok" ? full.value : shown;
  const isJson = column.typeName === "json" || column.typeName === "jsonb";
  const bytes = value !== null && column.typeName === "bytea" ? byteaLength(value) : null;
  const display = value === null ? null : isJson ? formatJson(value) : value;

  return (
    <aside aria-label="Cell inspector" className="flex w-[360px] shrink-0 flex-col border-l border-border bg-surface">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border pr-1.5 pl-3">
        <span className="min-w-0 truncate font-mono text-xs font-semibold">{column.name}</span>
        <span className="min-w-0 truncate font-mono text-[11px] text-faint">{column.typeName}</span>
        <span className="flex-1" />
        <button
          className="icon-btn"
          aria-label="Copy value"
          title="Copy value"
          disabled={value === null}
          onClick={() => {
            if (value === null) return;
            void writeText(value).then(() => setCopied(true));
          }}
        >
          {copied ? <Check size={14} className="text-ok" /> : <Copy size={14} />}
        </button>
        <button className="icon-btn" aria-label="Close inspector" onClick={onClose}>
          <X size={14} />
        </button>
      </div>
      <div className="flex shrink-0 flex-wrap gap-x-3 border-b border-border px-3 py-1 text-[11px] text-muted tabular-nums">
        {value !== null && <span>{value.length.toLocaleString()} chars</span>}
        {bytes !== null && <span>{bytes.toLocaleString()} bytes</span>}
        {isJson && value !== null && display !== value && <span>formatted</span>}
        {full?.state === "loading" && (
          <span className="flex items-center gap-1">
            <LoaderCircle size={11} className="animate-spin" aria-hidden /> loading full value…
          </span>
        )}
      </div>
      {truncated && pkIdx.length === 0 && (
        <p className="shrink-0 border-b border-border bg-error-soft px-3 py-1.5 text-xs text-pretty">
          Value truncated to 2,048 characters. This relation has no primary key, so the full value can't be fetched here; query it in a SQL tab.
        </p>
      )}
      {full?.state === "error" && (
        <p className="shrink-0 border-b border-border bg-error-soft px-3 py-1.5 text-xs text-error">Couldn't load full value: {full.message}</p>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        {display === null ? (
          <div className="p-3 font-mono text-xs text-null-fg italic">NULL</div>
        ) : (
          <pre className={`p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap ${bytes !== null ? "break-all" : "break-words"}`}>{display}</pre>
        )}
      </div>
    </aside>
  );
}
