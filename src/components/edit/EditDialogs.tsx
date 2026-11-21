import { useEffect, useState } from "react";
import type { Column } from "../../bindings/Column";
import type { ColumnDetail } from "../../bindings/ColumnDetail";
import type { EditValue } from "../../bindings/EditValue";
import { api, errorMessage } from "../../api";
import { Dialog } from "../Dialog";

export function CellEditDialog({ column, value, onSave, onClose }: { column: Column; value: string | null; onSave: (v: string | null) => void; onClose: () => void }) {
  const [text, setText] = useState(value ?? "");
  const [isNull, setNull] = useState(value === null && column.nullable);
  const json = column.typeName === "json" || column.typeName === "jsonb";
  return <Dialog title={`Edit ${column.name}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={() => onSave(isNull ? null : text)}>Stage change</button></>}>
    <label className="mb-2 block text-xs text-muted" htmlFor="edit-value">{column.name} · {column.typeName}</label>
    {json ? <textarea id="edit-value" autoFocus className="field min-h-40 w-full py-2 font-mono" value={text} disabled={isNull} onChange={e => setText(e.target.value)} /> : <input id="edit-value" autoFocus className="field w-full font-mono" value={text} disabled={isNull} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === "Enter") onSave(isNull ? null : text); }} />}
    <label className="mt-3 flex items-center gap-2"><input type="checkbox" checked={isNull} disabled={!column.nullable} onChange={e => setNull(e.target.checked)} />SQL NULL</label>
    <p className="mt-2 text-xs text-muted">Changes stay pending until you review and apply them.</p>
  </Dialog>;
}

export function AddRowDialog({ connId, schema, table, blocked, onSave, onClose }: { connId: string; schema: string; table: string; blocked: [string, string][]; onSave: (v: EditValue[]) => void; onClose: () => void }) {
  const [columns, setColumns] = useState<ColumnDetail[]>([]);
  const [values, setValues] = useState<Record<string, { mode: "default" | "value" | "null"; value: string }>>({});
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.describeTable(connId, schema, table).then(d => { if (live) setColumns(d.columns); }).catch(e => { if (live) setError(errorMessage(e)); });
    return () => { live = false; };
  }, [connId, schema, table]);
  return <Dialog title="Add row" onClose={onClose} width="w-[640px]" footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!columns.length} onClick={() => onSave(columns.flatMap(c => {
    const v = values[c.name];
    return !v || v.mode === "default" ? [] : [{ column: c.name, value: v.mode === "null" ? null : v.value }];
  }))}>Stage row</button></>}>
    <p className="mb-3 text-xs text-muted">Omitted columns use their database default. Required columns without a default need a value.</p>
    {error && <p role="alert" className="text-error">{error}</p>}
    <div className="space-y-3">{columns.map(c => {
      const why = blocked.find(([name]) => name === c.name)?.[1];
      const v = values[c.name] ?? { mode: "default" as const, value: "" };
      return <div key={c.name} className="grid grid-cols-[1fr_110px] gap-2">
        <label className="text-xs" htmlFor={`add-${c.name}`}>{c.name} <span className="text-muted">{c.typeName}{why ? ` · ${why}` : ""}</span></label>
        <select aria-label={`${c.name} value mode`} className="field" value={v.mode} disabled={!!why} title={why} onChange={e => setValues(s => ({ ...s, [c.name]: { ...v, mode: e.target.value as typeof v.mode } }))}><option value="default">Omit / default</option><option value="value">Value</option>{c.nullable && <option value="null">SQL NULL</option>}</select>
        {v.mode === "value" && (c.typeName === "json" || c.typeName === "jsonb" ? <textarea id={`add-${c.name}`} className="field col-span-2 min-h-24 py-2 font-mono" value={v.value} onChange={e => setValues(s => ({ ...s, [c.name]: { ...v, value: e.target.value } }))} /> : <input id={`add-${c.name}`} className="field col-span-2 font-mono" value={v.value} onChange={e => setValues(s => ({ ...s, [c.name]: { ...v, value: e.target.value } }))} />)}
      </div>;
    })}</div>
  </Dialog>;
}

export function ReviewChanges({ sql, busy, error, onApply, onClose }: { sql: string[]; busy: boolean; error: string | null; onApply: () => void; onClose: () => void }) {
  return <Dialog title="Review changes" onClose={() => { if (!busy) onClose(); }} width="w-[800px]" footer={<><button className="btn" disabled={busy} onClick={onClose}>Back</button><button className="btn btn-primary" disabled={busy} onClick={onApply}>{busy ? "Applying…" : "Apply"}</button></>}>
    <p className="mb-3 text-xs text-muted">{sql.length} changes run in one transaction. If a row changed or was deleted by someone else, nothing is committed.</p>
    {error && <p role="alert" className="mb-3 whitespace-pre-wrap text-error">{error}</p>}
    <pre aria-label="SQL to apply" className="selectable overflow-auto rounded border border-border bg-surface p-3 font-mono text-xs whitespace-pre-wrap">{`BEGIN;\n${sql.join("\n")}\nCOMMIT;`}</pre>
  </Dialog>;
}
