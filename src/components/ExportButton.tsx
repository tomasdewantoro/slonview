// "Export" button with a CSV / JSON menu, shared by the table toolbar and SQL results.
import { ChevronDown, FileDown, LoaderCircle } from "lucide-react";
import { useState } from "react";
import type { ExportFormat } from "../bindings/ExportFormat";
import { ContextMenu } from "./ContextMenu";

/** Save-dialog filter per format. */
export const EXPORT_FILTERS: Record<ExportFormat, { name: string; extensions: string[] }> = {
  csv: { name: "CSV", extensions: ["csv"] },
  json: { name: "JSON", extensions: ["json"] },
};

interface Props {
  busy: boolean;
  disabled: boolean;
  title: string;
  className: string;
  onExport: (format: ExportFormat) => void;
}

export function ExportButton({ busy, disabled, title, className, onExport }: Props) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  return (
    <>
      <button
        className={className}
        disabled={disabled}
        title={title}
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setMenu({ x: r.left, y: r.bottom + 2 });
        }}
      >
        {busy ? <LoaderCircle size={12} className="animate-spin motion-reduce:animate-none" aria-hidden /> : <FileDown size={12} aria-hidden />} Export
        <ChevronDown size={11} aria-hidden />
      </button>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: "CSV", onSelect: () => onExport("csv") },
            { label: "JSON", onSelect: () => onExport("json") },
          ]}
        />
      )}
    </>
  );
}
