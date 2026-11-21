import { useEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage, newRequestId } from "../../api";
import type { Column } from "../../bindings/Column";
import type { EditInfo } from "../../bindings/EditInfo";
import type { EditValue } from "../../bindings/EditValue";
import type { RowEdit } from "../../bindings/RowEdit";
import { appStore } from "../../store/app";
import type { CellRef } from "../ResultGrid";

export interface PendingRow { row: number; change: RowEdit }
export function useRowEdits(connId: string, schema: string, table: string, columns: Column[], rows: (string | null)[][], truncated: [number, number][], readOnly: boolean, refresh: () => void) {
  const [info, setInfo] = useState<EditInfo | null>(null);
  const [pending, setPending] = useState<PendingRow[]>([]);
  const [editor, setEditor] = useState<{ cell: CellRef; value: string | null } | null>(null);
  const [adding, setAdding] = useState(false);
  const [review, setReview] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const epoch = useRef(0);
  const first = rows[0];
  useEffect(() => {
    epoch.current++;
    setEditor(null); setReview(null); setAdding(false);
    setPending(p => {
      if (p.length) appStore.getState().pushToast("info", "Pending changes cleared because the table was refreshed or its query changed.");
      return [];
    });
  }, [first, connId, schema, table]);
  useEffect(() => {
    let live = true;
    setInfo(null);
    if (!readOnly) api.editInfo(connId, schema, table).then(i => { if (live) setInfo(i); }).catch(e => { if (live) setInfo({ disabledReason: errorMessage(e), blockedColumns: [] }); });
    return () => { live = false; };
  }, [connId, schema, table, readOnly]);
  const reason = readOnly ? "Read-only profile. Turn on Allow writes to edit rows." : info?.disabledReason ?? (!info ? "Loading edit permissions…" : null);
  const fail = (e: unknown) => setError(errorMessage(e));
  const originals = async (row: number) => {
    const current = pending.find(p => p.row === row)?.change;
    if (current && current.kind !== "insert") return current.original;
    const pk = columns.flatMap((c, i) => c.isPk ? [i] : []);
    const full = await api.getEditRow({ connId, schema, table, pkColumns: pk.map(i => columns[i].name), pkValues: pk.map(i => rows[row][i]), column: columns[0].name });
    return full.map(v => {
      const col = columns.findIndex(c => c.name === v.column);
      return { ...v, value: truncated.some(([r, c]) => r === row && c === col) ? v.value : rows[row][col] };
    });
  };
  const start = async (cell: CellRef) => {
    if (reason || busy) return;
    const why = info?.blockedColumns.find(([name]) => name === columns[cell.col].name)?.[1];
    if (why) { setError(`${columns[cell.col].name}: ${why}`); return; }
    const current = pending.find(p => p.row === cell.row)?.change;
    if (current?.kind === "delete") { setError("This row is marked for deletion. Discard changes before editing it."); return; }
    const generation = epoch.current;
    setBusy(true); setError(null);
    try {
      const original = current?.kind === "insert" ? [] : await originals(cell.row);
      if (generation !== epoch.current) return;
      const value = current?.kind === "insert" || current?.kind === "update" ? current.values.find(v => v.column === columns[cell.col].name)?.value : undefined;
      setEditor({ cell, value: value !== undefined ? value : original.find(v => v.column === columns[cell.col].name)?.value ?? null });
      // Keep full originals outside the grid, including values truncated in browse mode.
      if (!current) setPending(p => [...p, { row: cell.row, change: { kind: "update", original, values: [] } }]);
    } catch (e) { fail(e); } finally { setBusy(false); }
  };
  const saveCell = (value: string | null) => {
    if (!editor) return;
    const name = columns[editor.cell.col].name;
    setPending(p => p.map(item => {
      if (item.row !== editor.cell.row || item.change.kind === "delete") return item;
      const values = item.change.values.filter(v => v.column !== name);
      if (item.change.kind === "insert" || item.change.original.find(v => v.column === name)?.value !== value) values.push({ column: name, value });
      return { ...item, change: { ...item.change, values } };
    }));
    setEditor(null); setReview(null);
  };
  const remove = async (selected: number[]) => {
    if (reason || busy) return;
    const generation = epoch.current;
    setBusy(true); setError(null);
    try {
      const next = [...pending];
      for (const row of selected) {
        const idx = next.findIndex(p => p.row === row);
        if (idx >= 0 && next[idx].change.kind === "insert") { next.splice(idx, 1); continue; }
        const original = await originals(row);
        const entry: PendingRow = { row, change: { kind: "delete", original } };
        if (idx < 0) next.push(entry); else next[idx] = entry;
      }
      if (generation === epoch.current) {
        let newIndex = rows.length;
        setPending(next.map(item => item.change.kind === "insert" ? { ...item, row: newIndex++ } : item));
        setReview(null);
      }
    } catch (e) { fail(e); } finally { setBusy(false); }
  };
  const changes = pending.filter(p => p.change.kind !== "update" || p.change.values.length > 0);
  const shownRows = useMemo(() => {
    if (!pending.length) return rows;
    const result = [...rows];
    for (const { row, change } of pending) {
      if (change.kind === "delete") continue;
      const values = change.values;
      const target: (string | null)[] = change.kind === "insert" ? columns.map(() => null) : [...rows[row]];
      for (const v of values) target[columns.findIndex(c => c.name === v.column)] = v.value;
      result[row] = target;
    }
    return result;
  }, [rows, columns, pending]);
  const rowChanges = new Map(changes.map(p => [p.row, p.change.kind === "insert" ? "new" as const : p.change.kind === "delete" ? "deleted" as const : "modified" as const]));
  return {
    info, reason, busy, error, editor, adding, review, rows: shownRows, rowChanges, count: changes.length,
    start, saveCell, remove,
    closeEditor: () => setEditor(null),
    openAdd: () => { setAdding(true); setError(null); }, closeAdd: () => setAdding(false),
    add: (values: EditValue[]) => { setPending(p => [...p, { row: Math.max(rows.length - 1, ...p.map(x => x.row)) + 1, change: { kind: "insert", values } }]); setAdding(false); setReview(null); },
    discard: () => { setPending([]); setReview(null); setError(null); setEditor(null); },
    reviewChanges: async () => { setBusy(true); setError(null); try { setReview(await api.reviewEdits({ connId, schema, table, changes: changes.map(p => p.change) })); } catch (e) { fail(e); } finally { setBusy(false); } },
    closeReview: () => setReview(null),
    apply: async () => { setBusy(true); setError(null); try { const count = await api.applyEdits(newRequestId(), { connId, schema, table, changes: changes.map(p => p.change) }); setPending([]); setReview(null); appStore.getState().pushToast("info", `Applied ${count} changes in one transaction.`); refresh(); } catch (e) { fail(e); } finally { setBusy(false); } },
  };
}
