import { Plus, X } from "lucide-react";
import { useState } from "react";
import type { Column } from "../bindings/Column";
import type { FilterOp } from "../bindings/FilterOp";
import { FILTER_OPS, isNullOp, type FilterRow } from "../store/queries";

interface Props {
  columns: Column[];
  filters: FilterRow[];
  rawWhere: string;
  /** Called with the edited draft when the user applies (Enter / Apply / removing a row). */
  onApply: (filters: FilterRow[], rawWhere: string) => void;
}

const newRow = (column: string): FilterRow => ({ id: crypto.randomUUID(), column, op: "=", value: "" });

/** Rows of `column op value`, AND-ed, plus a raw WHERE expression. Edits are a draft until applied. */
export function FilterBar({ columns, filters, rawWhere, onApply }: Props) {
  // Draft is re-seeded from props whenever the applied state changes (e.g. tab switch).
  const [seed, setSeed] = useState({ filters, rawWhere });
  const [draft, setDraft] = useState(filters);
  const [raw, setRaw] = useState(rawWhere);
  if (seed.filters !== filters || seed.rawWhere !== rawWhere) {
    setSeed({ filters, rawWhere });
    setDraft(filters);
    setRaw(rawWhere);
  }

  const dirty = draft !== filters || raw !== rawWhere;
  const apply = (rows = draft, r = raw) => onApply(rows, r);
  const update = (id: string, patch: Partial<FilterRow>) => setDraft((d) => d.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  const onEnter = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      apply();
    }
  };

  return (
    <div className="shrink-0 border-b border-line bg-side px-2 py-1.5" onKeyDown={onEnter}>
      {draft.map((f) => (
        <div key={f.id} className="mb-1 flex items-center gap-1.5">
          <label className="sr-only" htmlFor={`fc-${f.id}`}>
            Column
          </label>
          <select id={`fc-${f.id}`} className="field h-6 w-44 font-mono text-xs" value={f.column} onChange={(e) => update(f.id, { column: e.target.value })}>
            {!columns.some((c) => c.name === f.column) && <option value={f.column}>{f.column || "column"}</option>}
            {columns.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
          </select>
          <label className="sr-only" htmlFor={`fo-${f.id}`}>
            Operator
          </label>
          <select id={`fo-${f.id}`} className="field h-6 w-28 font-mono text-xs" value={f.op} onChange={(e) => update(f.id, { op: e.target.value as FilterOp })}>
            {FILTER_OPS.map((op) => (
              <option key={op} value={op}>
                {op}
              </option>
            ))}
          </select>
          {!isNullOp(f.op) && (
            <input
              aria-label="Value"
              className="field h-6 min-w-0 flex-1 font-mono text-xs"
              value={f.value}
              placeholder={f.op === "IN" ? "a, b, c" : f.op.includes("LIKE") ? "%pattern%" : "value"}
              onChange={(e) => update(f.id, { value: e.target.value })}
              autoFocus={f.value === "" && f === draft[draft.length - 1]}
              spellCheck={false}
            />
          )}
          {isNullOp(f.op) && <span className="flex-1" />}
          <button
            className="icon-btn"
            aria-label="Remove filter"
            onClick={() => {
              const rows = draft.filter((x) => x.id !== f.id);
              setDraft(rows);
              apply(rows);
            }}
          >
            <X size={13} />
          </button>
        </div>
      ))}
      <div className="flex items-center gap-1.5">
        <button className="btn h-6 px-2 text-xs" onClick={() => setDraft((d) => [...d, newRow(columns[0]?.name ?? "")])} disabled={columns.length === 0}>
          <Plus size={12} aria-hidden /> Filter
        </button>
        <span className="pl-1 font-mono text-xs text-faint">WHERE</span>
        <input
          aria-label="Raw WHERE expression"
          className="field h-6 min-w-0 flex-1 font-mono text-xs"
          placeholder="raw SQL condition, e.g. amount > 100 AND note IS NOT NULL"
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          spellCheck={false}
        />
        <button className={`btn h-6 px-2.5 text-xs ${dirty ? "btn-primary" : ""}`} onClick={() => apply()} disabled={!dirty}>
          Apply
        </button>
      </div>
    </div>
  );
}
