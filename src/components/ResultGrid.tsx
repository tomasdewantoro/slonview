// Generic read-only data grid (Glide Data Grid). Owned by WP-FE-BROWSE; used by table
// browsing and by SQL results (WP-FE-SQL). Props are a contract: change only with both owners.
import "@glideapps/glide-data-grid/dist/index.css";
import {
  CompactSelection,
  DataEditor,
  GridCellKind,
  type DrawCellCallback,
  type DrawHeaderCallback,
  type GridCell,
  type GridColumn,
  type GridSelection,
  type Item,
  type Rectangle,
  type Theme,
} from "@glideapps/glide-data-grid";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { Column } from "../bindings/Column";
import { serializeRows, type CopyFormat } from "../lib/format";
import { useColorScheme } from "./useColorScheme";
import { ContextMenu, type MenuItem } from "./ContextMenu";

export interface CellRef {
  row: number;
  col: number;
}

export interface ResultGridProps {
  columns: Column[];
  /** Postgres text values; null = SQL NULL. */
  rows: (string | null)[][];
  /** [row, col] pairs whose value was truncated server-side (rendered with a trailing "…" marker). */
  truncated?: [number, number][];
  /** Called when the user scrolls within ~100 rows of the end. Grid ignores calls while `loading`. */
  onNearEnd?: () => void;
  loading?: boolean;
  /** Header click; undefined = sorting disabled (SQL results). */
  onSortColumn?: (column: string) => void;
  sort?: { column: string; desc: boolean }[];
  /** Selected cell changed (single cell focus). */
  onSelectCell?: (cell: CellRef | null) => void;
  /** Double-click or Enter on a cell: open inspector. */
  onOpenCell?: (cell: CellRef) => void;
  /** Schema/table for "Copy as INSERT"; when absent INSERT uses table name "result". */
  insertTarget?: { schema: string; table: string };
}

const NEAR_END_ROWS = 100;
const HEADER_HEIGHT = 34;
const ROW_HEIGHT = 24;
const MONO = 'ui-monospace, "SF Mono", Menlo, monospace';
const DISPLAY_CHARS = 300;

const NUMERIC_TYPE = /^(smallint|integer|bigint|numeric|decimal|real|double precision|money|oid)\b/;

export const isNumericType = (typeName: string) => NUMERIC_TYPE.test(typeName) && !typeName.endsWith("[]");

/** Initial width from type and name; users resize from there. */
function defaultWidth(c: Column): number {
  const t = c.typeName;
  let w: number;
  if (t === "boolean") w = 70;
  else if (/^(smallint|integer|oid)$/.test(t)) w = 90;
  else if (t === "bigint") w = 110;
  else if (t.startsWith("numeric") || t === "real" || t === "double precision" || t === "money") w = 120;
  else if (t === "uuid") w = 290;
  else if (t === "date") w = 100;
  else if (t.startsWith("timestamp")) w = 200;
  else if (t.startsWith("time") || t === "interval" || t === "inet" || t === "cidr") w = 130;
  else if (t === "json" || t === "jsonb" || t === "text" || t === "bytea" || t.endsWith("[]")) w = 240;
  else if (t.startsWith("character varying")) w = 180;
  else w = 140;
  // Header shows "name type"; keep it readable without resizing.
  const headerChars = c.name.length + t.length + 4;
  return Math.min(420, Math.max(w, headerChars * 7 + 24));
}

interface Palette {
  bg: string;
  bgAlt: string;
  header: string;
  text: string;
  muted: string;
  faint: string;
  border: string;
  accent: string;
  accentLight: string;
  pk: string;
}

const PALETTES: Record<"light" | "dark", Palette> = {
  light: {
    bg: "#ffffff",
    bgAlt: "#f6f7f9",
    header: "#f1f2f4",
    text: "#1c1f24",
    muted: "#5e6570",
    faint: "#a0a6b0",
    border: "#e3e5e9",
    accent: "#2563eb",
    accentLight: "rgba(37, 99, 235, 0.14)",
    pk: "#b7791f",
  },
  dark: {
    bg: "#1b1d21",
    bgAlt: "#202227",
    header: "#24272c",
    text: "#dfe2e7",
    muted: "#9198a3",
    faint: "#5f6670",
    border: "#30343a",
    accent: "#5b8def",
    accentLight: "rgba(91, 141, 239, 0.22)",
    pk: "#e0b45c",
  },
};

function gridTheme(p: Palette): Partial<Theme> {
  return {
    accentColor: p.accent,
    accentLight: p.accentLight,
    accentFg: "#ffffff",
    textDark: p.text,
    textMedium: p.muted,
    textLight: p.faint,
    textHeader: p.muted,
    textHeaderSelected: "#ffffff",
    bgCell: p.bg,
    bgCellMedium: p.bgAlt,
    bgHeader: p.header,
    bgHeaderHasFocus: p.border,
    bgHeaderHovered: p.border,
    borderColor: p.border,
    horizontalBorderColor: p.border,
    headerBottomBorderColor: p.border,
    fontFamily: MONO,
    baseFontStyle: "12px",
    headerFontStyle: "600 12px",
    markerFontStyle: "11px",
    editorFontSize: "12px",
    cellHorizontalPadding: 8,
    cellVerticalPadding: 3,
    lineHeight: 1.4,
  };
}

function inRect(r: Rectangle, col: number, row: number) {
  return col >= r.x && col < r.x + r.width && row >= r.y && row < r.y + r.height;
}

const emptySelection: GridSelection = { columns: CompactSelection.empty(), rows: CompactSelection.empty() };

export function ResultGrid({
  columns,
  rows,
  truncated,
  onNearEnd,
  loading,
  onSortColumn,
  sort,
  onSelectCell,
  onOpenCell,
  insertTarget,
}: ResultGridProps) {
  const scheme = useColorScheme();
  const palette = PALETTES[scheme];
  const theme = useMemo(() => gridTheme(palette), [palette]);
  const [selection, setSelection] = useState<GridSelection>(emptySelection);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [widths, setWidths] = useState<Record<string, number>>({});

  // Truncated cells as a Set of row*colCount+col keys: O(1) lookup in getCellContent.
  const colCount = columns.length;
  const truncatedSet = useMemo(() => {
    const s = new Set<number>();
    for (const [r, c] of truncated ?? []) s.add(r * colCount + c);
    return s;
  }, [truncated, colCount]);

  const columnsKey = columns.map((c) => `${c.name}:${c.typeName}`).join("|");
  useEffect(() => {
    setWidths({});
    setSelection(emptySelection);
  }, [columnsKey]);

  const sortIndex = useMemo(() => {
    const m = new Map<string, { desc: boolean; order: number }>();
    (sort ?? []).forEach((s, i) => m.set(s.column, { desc: s.desc, order: i + 1 }));
    return m;
  }, [sort]);

  const gridColumns: GridColumn[] = useMemo(
    () =>
      columns.map((c, i) => ({
        id: String(i),
        title: c.name,
        width: widths[c.name] ?? defaultWidth(c),
      })),
    [columns, widths],
  );

  const numericCols = useMemo(() => columns.map((c) => isNumericType(c.typeName)), [columns]);

  const nullTheme = useMemo<Partial<Theme>>(() => ({ textDark: palette.faint, baseFontStyle: "italic 12px" }), [palette]);

  const getCellContent = useCallback(
    ([col, row]: Item): GridCell => {
      const v = rows[row]?.[col];
      if (v === null || v === undefined) {
        return {
          kind: GridCellKind.Text,
          data: "",
          displayData: "NULL",
          allowOverlay: false,
          readonly: true,
          themeOverride: nullTheme,
          copyData: "",
        };
      }
      let display = v.length > DISPLAY_CHARS ? v.slice(0, DISPLAY_CHARS) : v;
      if (display.includes("\n")) display = display.replace(/\r?\n/g, "↵");
      return {
        kind: GridCellKind.Text,
        data: v,
        displayData: display,
        allowOverlay: false,
        readonly: true,
        contentAlign: numericCols[col] ? "right" : undefined,
        copyData: v,
      };
    },
    [rows, truncatedSet, colCount, numericCols, nullTheme],
  );

  const drawHeader: DrawHeaderCallback = useCallback(
    (args) => {
      const { ctx, rect, columnIndex, isSelected } = args;
      const c = columns[columnIndex];
      if (!c) return;
      const pad = 8;
      let x = rect.x + pad;
      const midY = rect.y + rect.height / 2;
      const right = rect.x + rect.width - pad;
      ctx.save();
      ctx.textBaseline = "middle";
      if (c.isPk) {
        ctx.fillStyle = isSelected ? "#ffffff" : palette.pk;
        ctx.font = `600 10px ${MONO}`;
        ctx.fillText("PK", x, midY);
        x += ctx.measureText("PK").width + 6;
      }
      const s = sortIndex.get(c.name);
      let sortLabel = "";
      if (s) sortLabel = (s.desc ? "▼" : "▲") + ((sort?.length ?? 0) > 1 ? String(s.order) : "");
      ctx.font = `10px ${MONO}`;
      const sortW = sortLabel ? ctx.measureText(sortLabel).width + 6 : 0;
      ctx.font = `600 12px ${MONO}`;
      ctx.fillStyle = isSelected ? "#ffffff" : palette.text;
      const avail = right - sortW - x;
      let name = c.name;
      if (ctx.measureText(name).width > avail) {
        while (name.length > 1 && ctx.measureText(name + "…").width > avail) name = name.slice(0, -1);
        name += "…";
      }
      ctx.fillText(name, x, midY);
      const nameW = ctx.measureText(name).width;
      ctx.font = `11px ${MONO}`;
      ctx.fillStyle = isSelected ? "rgba(255,255,255,0.75)" : palette.faint;
      const typeX = x + nameW + 6;
      const typeAvail = right - sortW - typeX;
      if (typeAvail > 20) {
        let t = c.typeName;
        if (ctx.measureText(t).width > typeAvail) {
          while (t.length > 1 && ctx.measureText(t + "…").width > typeAvail) t = t.slice(0, -1);
          t += "…";
        }
        ctx.fillText(t, typeX, midY);
      }
      if (sortLabel) {
        ctx.font = `10px ${MONO}`;
        ctx.fillStyle = isSelected ? "#ffffff" : palette.accent;
        ctx.textAlign = "right";
        ctx.fillText(sortLabel, right, midY);
      }
      ctx.restore();
    },
    [columns, palette, sortIndex, sort],
  );

  // Truncated cells: paint a "…" marker over the right edge so it shows even when the text overflows.
  const drawCell: DrawCellCallback = useCallback(
    (args, drawContent) => {
      drawContent();
      if (!truncatedSet.has(args.row * colCount + args.col)) return;
      const { ctx, rect } = args;
      const w = 18;
      ctx.save();
      ctx.fillStyle = palette.bg;
      ctx.fillRect(rect.x + rect.width - w - 2, rect.y + 1, w + 1, rect.height - 2);
      ctx.fillStyle = palette.accentLight;
      ctx.fillRect(rect.x + rect.width - w, rect.y + 3, w - 3, rect.height - 6);
      ctx.fillStyle = palette.accent;
      ctx.font = `600 12px ${MONO}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("…", rect.x + rect.width - w / 2 - 1, rect.y + rect.height / 2);
      ctx.restore();
    },
    [truncatedSet, colCount, palette],
  );

  const onVisibleRegionChanged = useCallback(
    (range: Rectangle) => {
      if (!onNearEnd || loading) return;
      if (rows.length > 0 && range.y + range.height >= rows.length - NEAR_END_ROWS) onNearEnd();
    },
    [onNearEnd, loading, rows.length],
  );

  // Scrolling isn't the only way to reach the end: a short first page or a finished load can
  // leave the viewport already near the end without a new visible-region event.
  const lastRegion = useRef<Rectangle | null>(null);
  const trackRegion = useCallback(
    (range: Rectangle) => {
      lastRegion.current = range;
      onVisibleRegionChanged(range);
    },
    [onVisibleRegionChanged],
  );
  useEffect(() => {
    if (!loading && lastRegion.current) onVisibleRegionChanged(lastRegion.current);
  }, [loading, onVisibleRegionChanged]);

  const onGridSelectionChange = useCallback(
    (s: GridSelection) => {
      setSelection(s);
      const cell = s.current?.cell;
      onSelectCell?.(cell ? { col: cell[0], row: cell[1] } : null);
    },
    [onSelectCell],
  );

  /** Rectangular slice for the current selection: row selection = full rows, column selection = full columns. */
  const selectedBlock = useCallback((): { cols: number[]; rowIdx: number[] } | null => {
    if (selection.rows.length > 0) {
      return { cols: columns.map((_, i) => i), rowIdx: selection.rows.toArray().filter((r) => r < rows.length) };
    }
    if (selection.columns.length > 0) {
      return { cols: selection.columns.toArray(), rowIdx: rows.map((_, i) => i) };
    }
    const r = selection.current?.range;
    if (!r) return null;
    const cols = Array.from({ length: r.width }, (_, i) => r.x + i);
    const rowIdx = Array.from({ length: r.height }, (_, i) => r.y + i).filter((x) => x < rows.length);
    return { cols, rowIdx };
  }, [selection, columns, rows]);

  const copy = useCallback(
    async (format: CopyFormat) => {
      const block = selectedBlock();
      if (!block || block.rowIdx.length === 0) return;
      const cols = block.cols.map((i) => columns[i]);
      const data = block.rowIdx.map((r) => block.cols.map((c) => rows[r][c]));
      try {
        await writeText(serializeRows(format, cols, data, insertTarget));
      } catch (e) {
        console.error("copy failed", e);
      }
    },
    [selectedBlock, columns, rows, insertTarget],
  );

  // Cmd+C: our serializer (NULL handling, quoting) instead of Glide's built-in copy.
  const onKeyDown = useCallback(
    (e: { key: string; metaKey: boolean; ctrlKey: boolean; preventDefault(): void; cancel(): void }) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c") {
        e.preventDefault();
        e.cancel();
        void copy("tsv");
      }
    },
    [copy],
  );

  const onCellContextMenu = useCallback(
    ([col, row]: Item, e: { preventDefault(): void; bounds: Rectangle; localEventX: number; localEventY: number }) => {
      e.preventDefault();
      const r = selection.current?.range;
      const inSelection = (r && inRect(r, col, row)) || selection.rows.hasIndex(row) || selection.columns.hasIndex(col);
      if (!inSelection) {
        setSelection({
          current: { cell: [col, row], range: { x: col, y: row, width: 1, height: 1 }, rangeStack: [] },
          columns: CompactSelection.empty(),
          rows: CompactSelection.empty(),
        });
        onSelectCell?.({ col, row });
      }
      setMenu({ x: e.bounds.x + e.localEventX, y: e.bounds.y + e.localEventY });
    },
    [selection, onSelectCell],
  );

  const menuItems: MenuItem[] = [
    { label: "Copy as TSV", shortcut: "⌘C", onSelect: () => void copy("tsv") },
    { label: "Copy as CSV", onSelect: () => void copy("csv") },
    { label: "Copy as JSON", onSelect: () => void copy("json") },
    { label: "Copy as INSERT", onSelect: () => void copy("insert") },
  ];
  if (onOpenCell && selection.current) {
    const [col, row] = selection.current.cell;
    menuItems.push({ separator: true }, { label: "Inspect cell", shortcut: "↵", onSelect: () => onOpenCell({ col, row }) });
  }

  const containerStyle = { "--gdg-font-family": MONO } as CSSProperties;

  return (
    <div className="relative min-h-0 flex-1" style={containerStyle}>
      <DataEditor
        width="100%"
        height="100%"
        columns={gridColumns}
        rows={rows.length}
        getCellContent={getCellContent}
        getCellsForSelection
        theme={theme}
        headerHeight={HEADER_HEIGHT}
        rowHeight={ROW_HEIGHT}
        rowMarkers={{ kind: "clickable-number", width: Math.max(44, String(rows.length).length * 8 + 20) }}
        rowSelect="multi"
        columnSelect={onSortColumn ? "none" : "multi"}
        rangeSelect="multi-rect"
        gridSelection={selection}
        onGridSelectionChange={onGridSelectionChange}
        onVisibleRegionChanged={trackRegion}
        onHeaderClicked={(colIndex, e) => {
          if (!onSortColumn) return;
          e.preventDefault();
          onSortColumn(columns[colIndex].name);
        }}
        drawHeader={drawHeader}
        drawCell={drawCell}
        onCellActivated={([col, row]) => onOpenCell?.({ col, row })}
        onCellContextMenu={onCellContextMenu}
        onKeyDown={onKeyDown}
        onColumnResize={(_c, size, i) => setWidths((w) => ({ ...w, [columns[i].name]: size }))}
        smoothScrollX
        smoothScrollY
        minColumnWidth={50}
        maxColumnWidth={1200}
        overscrollX={40}
        keybindings={{ search: false, copy: false }}
      />
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />}
    </div>
  );
}
