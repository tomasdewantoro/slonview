import { LoaderCircle } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { api } from "../api";
import type { TableDescription } from "../bindings/TableDescription";
import { useApp, type StructureTab as StructureTabInfo } from "../store/app";
import { formatBytes } from "../store/queries";
import { ErrorPanel } from "./ErrorPanel";

const KIND_LABEL: Record<TableDescription["kind"], string> = {
  table: "Table",
  view: "View",
  "materialized-view": "Materialized view",
  "partitioned-table": "Partitioned table",
  "foreign-table": "Foreign table",
};

type State = { state: "loading" } | { state: "ok"; desc: TableDescription } | { state: "error"; error: unknown };

function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="mb-5">
      <h3 className="mb-1.5 flex items-baseline gap-2 text-xs font-semibold text-muted">
        {title}
        {count !== undefined && <span className="font-normal text-faint tabular-nums">{count}</span>}
      </h3>
      {children}
    </section>
  );
}

const th = "border-b border-border px-2.5 py-1 text-left text-[11px] font-semibold text-muted";
const td = "border-b border-border px-2.5 py-1 align-top";

export function StructureTab({ tab, connId }: { tab: StructureTabInfo; connId: string }) {
  const nonce = useApp((s) => s.structureNonce[tab.id] ?? 0);
  const [st, setSt] = useState<State>({ state: "loading" });

  useEffect(() => {
    let live = true;
    setSt({ state: "loading" });
    api
      .describeTable(connId, tab.schema, tab.table)
      .then((desc) => live && setSt({ state: "ok", desc }))
      .catch((error) => live && setSt({ state: "error", error }));
    return () => {
      live = false;
    };
  }, [connId, tab.schema, tab.table, nonce]);

  if (st.state === "loading")
    return (
      <div className="flex items-center gap-2 p-4 text-muted">
        <LoaderCircle size={14} className="animate-spin" aria-hidden /> Loading structure…
      </div>
    );
  if (st.state === "error") return <ErrorPanel error={st.error} />;

  const d = st.desc;
  return (
    <div className="min-h-0 flex-1 overflow-auto px-5 py-4 select-text">
      <header className="mb-4 flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h2 className="font-mono text-sm font-semibold text-balance">
          {d.schema}.{d.name}
        </h2>
        <span className="text-xs text-muted">{KIND_LABEL[d.kind]}</span>
        <span className="text-xs text-muted tabular-nums">~{d.estRows < 0 ? "?" : d.estRows.toLocaleString()} rows (estimate)</span>
        <span className="text-xs text-muted tabular-nums">{formatBytes(d.sizeBytes)} total</span>
      </header>

      <Section title="Columns" count={d.columns.length}>
        <table className="w-full border-collapse border-t border-border text-xs">
          <thead>
            <tr>
              <th className={`${th} w-8 text-right`}>#</th>
              <th className={th}>Name</th>
              <th className={th}>Type</th>
              <th className={th}>Nullable</th>
              <th className={th}>Default</th>
              <th className={th}>Comment</th>
            </tr>
          </thead>
          <tbody>
            {d.columns.map((c, i) => (
              <tr key={c.name} className="hover:bg-surface-2">
                <td className={`${td} text-right text-faint tabular-nums`}>{i + 1}</td>
                <td className={`${td} font-mono`}>
                  {c.name}
                  {c.isPk && <span className="ml-1.5 rounded-sm bg-warn-soft px-1 text-[10px] font-semibold text-warn">PK</span>}
                </td>
                <td className={`${td} font-mono text-muted`}>{c.typeName}</td>
                <td className={`${td} ${c.nullable ? "text-muted" : ""}`}>{c.nullable ? "null" : "not null"}</td>
                <td className={`${td} font-mono break-all text-muted`}>{c.default ?? ""}</td>
                <td className={`${td} text-muted`}>{c.comment ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      {d.viewDefinition !== null && (
        <Section title="Definition">
          <pre className="overflow-auto rounded-md border border-border bg-surface p-3 font-mono text-xs leading-relaxed">{d.viewDefinition.trim()}</pre>
        </Section>
      )}

      {(d.kind !== "view" || d.indexes.length > 0) && (
        <Section title="Indexes" count={d.indexes.length}>
          {d.indexes.length === 0 ? (
            <p className="text-xs text-muted">No indexes.</p>
          ) : (
            <table className="w-full border-collapse border-t border-border text-xs">
              <tbody>
                {d.indexes.map((ix) => (
                  <tr key={ix.name} className="hover:bg-surface-2">
                    <td className={`${td} w-56 font-mono`}>
                      {ix.name}
                      {ix.isPrimary ? (
                        <span className="ml-1.5 text-[10px] font-semibold text-warn">PRIMARY</span>
                      ) : (
                        ix.isUnique && <span className="ml-1.5 text-[10px] font-semibold text-muted">UNIQUE</span>
                      )}
                    </td>
                    <td className={`${td} font-mono break-all text-muted`}>{ix.definition}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>
      )}

      {(d.kind !== "view" || d.foreignKeys.length > 0) && (
        <Section title="Foreign keys" count={d.foreignKeys.length}>
          {d.foreignKeys.length === 0 ? (
            <p className="text-xs text-muted">No foreign keys.</p>
          ) : (
            <table className="w-full border-collapse border-t border-border text-xs">
              <tbody>
                {d.foreignKeys.map((fk) => (
                  <tr key={fk.name} className="hover:bg-surface-2">
                    <td className={`${td} w-56 font-mono`}>{fk.name}</td>
                    <td className={`${td} font-mono break-all text-muted`}>{fk.definition}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>
      )}
    </div>
  );
}
