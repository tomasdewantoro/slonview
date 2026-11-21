import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Check, ChevronDown, ChevronUp, Copy, LoaderCircle, X } from "lucide-react";
import { useEffect, useState, type KeyboardEvent } from "react";
import { api, errorMessage } from "../api";
import type { Column } from "../bindings/Column";
import type { ForeignKeyTarget } from "../bindings/ForeignKeyTarget";
import { referencingLinks } from "../lib/referencing";
import type { ReferencingState } from "../store/app";

interface Props {
  connId: string;
  schema: string;
  table: string;
  columns: Column[];
  rows: (string | null)[][];
  /** Absolute row index shown. */
  row: number;
  /** Column indexes of server-truncated cells in this row. */
  truncatedCols: ReadonlySet<number>;
  /** Keys pointing at this table; undefined for views (nothing can reference them). */
  referencing?: ReferencingState;
  onMove: (row: number) => void;
  onClose: () => void;
  /** Opens `target` filtered to `value` (foreign key either way); undefined while edits are pending. */
  onOpenRows?: (target: ForeignKeyTarget, value: string) => void;
}

type Full = { state: "loading" } | { state: "ok"; value: string | null } | { state: "error"; message: string };

const relName = (t: ForeignKeyTarget) => (t.schema === "public" ? t.table : `${t.schema}.${t.table}`);

/** The selected row as a vertical form: one line per column. Read-only; ⌥↑/⌥↓ step through loaded rows. */
export function RecordView({ connId, schema, table, columns, rows, row, truncatedCols, referencing, onMove, onClose, onOpenRows }: Props) {
  const values = rows[row];
  const pkIdx = columns.flatMap((c, i) => (c.isPk ? [i] : []));
  const pkKey = values ? pkIdx.map((i) => values[i]).join("\u0000") : "";
  /** Full values fetched on demand, by column index; reset when the row changes. */
  const [full, setFull] = useState<Record<number, Full>>({});
  const [copied, setCopied] = useState<number | null>(null);
  useEffect(() => {
    setFull({});
    setCopied(null);
  }, [row, pkKey]);

  if (!values) return null;

  const fetchFull = async (col: number): Promise<string | null> => {
    setFull((f) => ({ ...f, [col]: { state: "loading" } }));
    try {
      const value = await api.getCell({ connId, schema, table, pkColumns: pkIdx.map((i) => columns[i].name), pkValues: pkIdx.map((i) => values[i]), column: columns[col].name });
      setFull((f) => ({ ...f, [col]: { state: "ok", value } }));
      return value;
    } catch (e) {
      setFull((f) => ({ ...f, [col]: { state: "error", message: errorMessage(e) } }));
      throw e;
    }
  };

  const copy = async (col: number) => {
    const loaded = full[col];
    let value = loaded?.state === "ok" ? loaded.value : values[col];
    // Copy the real value, not the 2 KB preview, when it can be fetched.
    if (truncatedCols.has(col) && loaded?.state !== "ok" && pkIdx.length > 0) value = await fetchFull(col).catch(() => value);
    if (value === null) return;
    await writeText(value);
    setCopied(col);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (!e.altKey || e.metaKey || e.ctrlKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    e.preventDefault();
    e.stopPropagation();
    const next = row + (e.key === "ArrowUp" ? -1 : 1);
    if (next >= 0 && next < rows.length) onMove(next);
  };

  const links = referencing?.status === "ok" ? referencingLinks(referencing.keys, columns, values, truncatedCols) : [];

  return (
    <aside aria-label="Record view" tabIndex={-1} onKeyDown={onKeyDown} className="flex w-[400px] shrink-0 flex-col border-l border-border bg-surface outline-none">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border pr-1.5 pl-3">
        <span className="text-xs font-semibold">Row {(row + 1).toLocaleString()}</span>
        <span className="text-xs text-faint tabular-nums">of {rows.length.toLocaleString()} loaded</span>
        <span className="flex-1" />
        <button className="icon-btn" aria-label="Previous row" title="Previous row (⌥↑)" disabled={row === 0} onClick={() => onMove(row - 1)}>
          <ChevronUp size={14} />
        </button>
        <button className="icon-btn" aria-label="Next row" title="Next row (⌥↓)" disabled={row >= rows.length - 1} onClick={() => onMove(row + 1)}>
          <ChevronDown size={14} />
        </button>
        <button className="icon-btn" aria-label="Close record view" onClick={onClose}>
          <X size={14} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto select-text">
        <dl aria-label="Columns" className="divide-y divide-border">
          {columns.map((c, i) => {
            const loaded = full[i];
            const value = loaded?.state === "ok" ? loaded.value : values[i];
            const cut = truncatedCols.has(i) && loaded?.state !== "ok";
            const link = c.references && value !== null && !cut && onOpenRows ? c.references : null;
            return (
              <div key={c.name} data-column={c.name} className="group grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)_auto] items-start gap-x-2 px-3 py-1.5 hover:bg-surface-2">
                <dt className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate font-mono text-xs font-semibold" title={c.name}>
                      {c.name}
                    </span>
                    {c.isPk && <span className="shrink-0 rounded-sm bg-warn-soft px-1 text-[10px] font-semibold text-warn">PK</span>}
                  </div>
                  <div className="truncate font-mono text-[11px] text-faint" title={c.typeName}>
                    {c.typeName}
                  </div>
                </dt>
                <dd className="min-w-0 font-mono text-xs leading-relaxed">
                  {value === null ? (
                    <span className="text-null-fg italic">NULL</span>
                  ) : link ? (
                    <button
                      className="text-left break-all text-accent underline-offset-2 hover:underline"
                      title={`Open referenced row in ${relName(link)}`}
                      onClick={() => onOpenRows!(link, value)}
                    >
                      {value} <span aria-hidden>→</span>
                    </button>
                  ) : (
                    <span className="break-words whitespace-pre-wrap">{value}</span>
                  )}
                  {cut && (
                    <div className="mt-0.5 text-[11px] text-muted">
                      {pkIdx.length === 0 ? (
                        "First 2,048 characters; no primary key to fetch the rest."
                      ) : loaded?.state === "loading" ? (
                        <span className="flex items-center gap-1">
                          <LoaderCircle size={11} className="animate-spin" aria-hidden /> loading full value…
                        </span>
                      ) : (
                        <button className="text-accent" onClick={() => void fetchFull(i).catch(() => {})}>
                          First 2,048 characters. Show full value
                        </button>
                      )}
                    </div>
                  )}
                  {loaded?.state === "error" && <div className="mt-0.5 text-[11px] text-error">Couldn't load full value: {loaded.message}</div>}
                </dd>
                <button
                  className="icon-btn opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                  aria-label={`Copy ${c.name}`}
                  title="Copy value"
                  disabled={value === null}
                  onClick={() => void copy(i)}
                >
                  {copied === i ? <Check size={13} className="text-ok" /> : <Copy size={13} />}
                </button>
              </div>
            );
          })}
        </dl>
        {referencing && (
          <section aria-label="Referenced by" className="border-t border-border px-3 py-2">
            <h3 className="mb-1 text-[11px] font-semibold text-muted">Referenced by</h3>
            {referencing.status === "loading" ? (
              <p className="flex items-center gap-1 text-xs text-muted">
                <LoaderCircle size={11} className="animate-spin" aria-hidden /> Loading…
              </p>
            ) : referencing.status === "error" ? (
              <p className="text-xs text-error">{errorMessage(referencing.error)}</p>
            ) : links.length === 0 ? (
              <p className="text-xs text-muted">{referencing.keys.length === 0 ? "No foreign keys point at this table." : "No single-column foreign key can be followed from this row."}</p>
            ) : (
              <ul className="flex flex-col gap-0.5">
                {links.map((l) => (
                  <li key={l.key}>
                    <button className="text-left text-xs text-accent hover:underline disabled:text-muted disabled:no-underline" disabled={!onOpenRows} onClick={() => onOpenRows?.(l.target, l.value)}>
                      {l.label}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
    </aside>
  );
}
