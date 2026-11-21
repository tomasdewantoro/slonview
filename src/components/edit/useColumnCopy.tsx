import { useEffect, useRef, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { api, errorMessage, newRequestId } from "../../api";
import type { Column } from "../../bindings/Column";
import type { PageRequest } from "../../bindings/PageRequest";
import { serializeRows, type CopyFormat } from "../../lib/format";
import { appStore } from "../../store/app";

export function useColumnCopy(page?: PageRequest) {
  const [progress, setProgress] = useState<string | null>(null);
  const request = useRef<string | null>(null);
  const cancelled = useRef(false);
  const cancel = () => {
    cancelled.current = true;
    if (request.current) void api.cancelQuery(request.current);
  };
  useEffect(() => () => { cancel(); }, []);
  const copy = async (format: CopyFormat, columns: Column[]) => {
    if (!page || request.current) return;
    const id = newRequestId();
    request.current = id;
    cancelled.current = false;
    setProgress("Counting values…");
    try {
      const count = await api.countExact(id, page.connId, page.schema, page.table, page.filters, page.rawWhere);
      if (cancelled.current) return;
      if (count > 100_000 && !await ask(`This copies ${Math.min(count, 1_000_000).toLocaleString()} values per column and may use a large amount of memory. The limit is 1,000,000 rows. Continue?`, { title: "Copy large column", kind: "warning" })) return;
      if (cancelled.current) return;
      setProgress("Copying 0 rows…");
      const rows: (string | null)[][] = [];
      const summary = await api.streamColumns(id, { page, columns: columns.map(c => c.name) }, chunk => {
        if (cancelled.current) return;
        for (const row of chunk.rows) rows.push(row);
        setProgress(`Copying ${rows.length.toLocaleString()} / ${Math.min(count, 1_000_000).toLocaleString()} rows…`);
      });
      if (cancelled.current) return;
      setProgress("Writing clipboard…");
      await writeText(serializeRows(format, columns, rows, { schema: page.schema, table: page.table }));
      appStore.getState().pushToast("info", `Copied ${summary.count.toLocaleString()} rows${summary.capped ? "; capped at 1,000,000 rows" : ""}.`);
    } catch (e) {
      if (!cancelled.current) appStore.getState().pushToast("error", `Copy failed: ${errorMessage(e)}`);
    } finally { request.current = null; setProgress(null); }
  };
  return { copy, progress, cancel };
}
