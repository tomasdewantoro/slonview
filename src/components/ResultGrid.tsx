// Canvas data grid shared by table browsing and SQL results.
import "@glideapps/glide-data-grid/dist/index.css";
import {
  CompactSelection,
  DataEditor,
  GridCellKind,
  type DataEditorRef,
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
import type { ForeignKeyTarget } from "../bindings/ForeignKeyTarget";
import { serializeRows, type CopyFormat } from "../lib/format";
import { useColorScheme } from "./useColorScheme";
import type { PageRequest } from "../bindings/PageRequest";
import { useColumnCopy } from "./edit/useColumnCopy";
import { appStore } from "../store/app";
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
  /** Whole-column table copy streams all matching rows, not just loaded pages. */
  copyPage?: PageRequest;
  resultTruncated?: boolean;
  onEditCell?: (cell: CellRef) => void;
  onSelectedRows?: (rows: number[]) => void;
  rowChanges?: ReadonlyMap<number, "modified" | "new" | "deleted">;
  /** Opens the row a foreign-key cell points at; enables the menu item, ⌘-click and the header mark. */
  onFollowReference?: (target: ForeignKeyTarget, value: string) => void;
  /** Extra right-click items for a row (after the built-in ones). */
  rowMenuItems?: (row: number) => MenuItem[];
  /** Moves the selection to this cell and scrolls it into view whenever the object changes. */
  focusCell?: CellRef | null;
}

const NEAR_END_ROWS = 100;
const HEADER_HEIGHT = 34;
const ROW_HEIGHT = 24;
const DISPLAY_CHARS = 300;

const NUMERIC_TYPE = /^(smallint|integer|bigint|numeric|decimal|real|double precision|money|oid)\b/;

export const isNumericType = (typeName: string) => NUMERIC_TYPE.test(typeName) && !typeName.endsWith("[]");

const CHAR_PX = 7.3;
const WIDTH_SAMPLE_ROWS = 200;

/** Initial width from type and name; users resize from there. Untyped columns (SQL results)
 *  are sized from the header and a sample of their values. */
function defaultWidth(c: Column, rows: (string | null)[][], index: number): number {
  const t = c.typeName;
  if (t === "") {
    let chars = c.name.length;
    for (let r = 0; r < Math.min(rows.length, WIDTH_SAMPLE_ROWS); r++) {
      chars = Math.max(chars, Math.min(rows[r][index]?.length ?? 4, 60));
    }
    return Math.min(420, Math.max(60, Math.ceil(chars * CHAR_PX) + 24));
  }
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

/** Brand tokens the canvas needs as concrete colours (canvas can't resolve CSS variables). */
const PALETTE_TOKENS = {
  bg: "--sv-paper",
  header: "--sv-grid-header",
  headerFg: "--sv-grid-header-fg",
  headerHover: "--sv-surface-2",
  text: "--sv-ink",
  muted: "--sv-muted",
  faint: "--sv-faint",
  nullFg: "--sv-null-fg",
  border: "--sv-border",
  accent: "--sv-accent",
  accentFg: "--sv-accent-fg",
  accentFgMuted: "--sv-accent-fg-muted",
  selection: "--sv-selection",
  modified: "--sv-accent-soft",
  added: "--sv-warn-soft",
  error: "--sv-error",
  selectionFgMuted: "--sv-selection-fg-muted",
  pk: "--sv-warn",
  mono: "--sv-font-mono",
} as const;

type Palette = Record<keyof typeof PALETTE_TOKENS, string>;

/** Reads the current values of the grid's tokens (src/styles/tokens.css); they switch with the OS appearance. */
function readPalette(): Palette {
  const css = getComputedStyle(document.documentElement);
  const out = {} as Palette;
  for (const [key, name] of Object.entries(PALETTE_TOKENS)) out[key as keyof Palette] = css.getPropertyValue(name).trim();
  return out;
}

function gridTheme(p: Palette): Partial<Theme> {
  return {
    accentColor: p.accent,
    // Opaque selection fill, so text contrast on a selection is what the tokens specify.
    accentLight: p.selection,
    accentFg: p.accentFg,
    textDark: p.text,
    textMedium: p.muted,
    textLight: p.faint,
    textHeader: p.headerFg,
    textHeaderSelected: p.accentFg,
    bgCell: p.bg,
    bgCellMedium: p.headerHover,
    bgHeader: p.header,
    // surface-2, not border: faint type names and the PK marker stay ≥ 4.5:1 on a hovered header.
    bgHeaderHasFocus: p.headerHover,
    bgHeaderHovered: p.headerHover,
    borderColor: p.border,
    horizontalBorderColor: p.border,
    headerBottomBorderColor: p.border,
    fontFamily: p.mono,
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
  copyPage,
  resultTruncated,
  onEditCell,
  onSelectedRows,
  rowChanges,
  onFollowReference,
  rowMenuItems,
  focusCell,
}: ResultGridProps) {
  const scheme = useColorScheme();
  // Re-read on appearance change; the token values themselves switch in CSS.
  const palette = useMemo(readPalette, [scheme]);
  const theme = useMemo(() => gridTheme(palette), [palette]);
  const [selection, setSelection] = useState<GridSelection>(emptySelection);
  const editorRef = useRef<DataEditorRef>(null);
  useEffect(() => {
    if (!focusCell) return;
    const { col, row } = focusCell;
    setSelection({ current: { cell: [col, row], range: { x: col, y: row, width: 1, height: 1 }, rangeStack: [] }, columns: CompactSelection.empty(), rows: CompactSelection.empty() });
    editorRef.current?.scrollTo(col, row);
  }, [focusCell]);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [widths, setWidths] = useState<Record<string, number>>({});
  const columnCopy = useColumnCopy(copyPage);

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

  // Default widths are fixed per column set: sampled from the rows present when the columns
  // appear, so later page appends never make columns jump.
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const defaults = useMemo(
    () => columns.map((c, i) => defaultWidth(c, rowsRef.current, i)),
    // Recompute only when the column set changes (rows are read through the ref).
    [columnsKey],
  );

  const gridColumns: GridColumn[] = useMemo(
    () =>
      columns.map((c, i) => ({
        id: String(i),
        title: c.name,
        width: widths[c.name] ?? defaults[i] ?? 140,
      })),
    [columns, widths, defaults],
  );

  const numericCols = useMemo(() => columns.map((c) => isNumericType(c.typeName)), [columns]);

  const nullTheme = useMemo<Partial<Theme>>(() => ({ textDark: palette.nullFg, baseFontStyle: "italic 12px" }), [palette]);

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
        ctx.fillStyle = isSelected ? palette.accentFg : palette.pk;
        ctx.font = `600 10px ${palette.mono}`;
        ctx.fillText("PK", x, midY);
        x += ctx.measureText("PK").width + 6;
      }
      if (c.references && onFollowReference) {
        ctx.fillStyle = isSelected ? palette.accentFg : palette.accent;
        ctx.font = `600 11px ${palette.mono}`;
        ctx.fillText("→", x, midY);
        x += ctx.measureText("→").width + 6;
      }
      const s = sortIndex.get(c.name);
      let sortLabel = "";
      if (s) sortLabel = (s.desc ? "▼" : "▲") + ((sort?.length ?? 0) > 1 ? String(s.order) : "");
      ctx.font = `10px ${palette.mono}`;
      const sortW = sortLabel ? ctx.measureText(sortLabel).width + 6 : 0;
      ctx.font = `600 12px ${palette.mono}`;
      ctx.fillStyle = isSelected ? palette.accentFg : palette.text;
      const avail = right - sortW - x;
      let name = c.name;
      if (ctx.measureText(name).width > avail) {
        while (name.length > 1 && ctx.measureText(name + "…").width > avail) name = name.slice(0, -1);
        name += "…";
      }
      ctx.fillText(name, x, midY);
      const nameW = ctx.measureText(name).width;
      ctx.font = `11px ${palette.mono}`;
      ctx.fillStyle = isSelected ? palette.accentFgMuted : palette.faint;
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
        ctx.font = `10px ${palette.mono}`;
        ctx.fillStyle = isSelected ? palette.accentFg : palette.accent;
        ctx.textAlign = "right";
        ctx.fillText(sortLabel, right, midY);
      }
      ctx.restore();
    },
    [columns, palette, sortIndex, sort, onFollowReference],
  );

  // NULL cells inside a selection switch to selection-fg-muted (null-fg is too faint on the selection fill).
  // Glide sets the text colour in drawPrep and caches it across cells, so restore it after drawing.
  // Truncated cells: paint a "…" marker over the right edge so it shows even when the text overflows.
  const drawCell: DrawCellCallback = useCallback(
    (args, drawContent) => {
      const change = rowChanges?.get(args.row);
      if (change && !args.highlighted) {
        args.ctx.save();
        args.ctx.fillStyle = change === "new" ? palette.added : change === "deleted" ? palette.bg : palette.modified;
        args.ctx.fillRect(args.rect.x, args.rect.y, args.rect.width, args.rect.height);
        args.ctx.restore();
      }
      const { ctx } = args;
      if (args.highlighted && args.cell.kind === GridCellKind.Text && args.cell.themeOverride === nullTheme) {
        const prev = ctx.fillStyle;
        ctx.fillStyle = palette.selectionFgMuted;
        drawContent();
        ctx.fillStyle = prev;
      } else {
        drawContent();
      }
      if (change) {
        ctx.save();
        ctx.strokeStyle = change === "deleted" ? palette.error : change === "new" ? palette.pk : palette.accent;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(args.rect.x + 2, args.rect.y + (change === "deleted" ? args.rect.height / 2 : args.rect.height - 2));
        ctx.lineTo(args.rect.x + args.rect.width - 2, args.rect.y + (change === "deleted" ? args.rect.height / 2 : args.rect.height - 2));
        ctx.stroke();
        ctx.restore();
      }
      if (!truncatedSet.has(args.row * colCount + args.col)) return;
      const { rect } = args;
      const w = 18;
      ctx.save();
      ctx.fillStyle = args.highlighted ? palette.selection : palette.bg;
      ctx.fillRect(rect.x + rect.width - w - 2, rect.y + 1, w + 1, rect.height - 2);
      ctx.fillStyle = args.highlighted ? palette.bg : palette.selection;
      ctx.fillRect(rect.x + rect.width - w, rect.y + 3, w - 3, rect.height - 6);
      ctx.fillStyle = palette.accent;
      ctx.font = `600 12px ${palette.mono}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("…", rect.x + rect.width - w / 2 - 1, rect.y + rect.height / 2);
      ctx.restore();
    },
    [truncatedSet, colCount, palette, nullTheme, rowChanges],
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
      onSelectedRows?.(s.rows.toArray());
    },
    [onSelectCell, onSelectedRows],
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
      if (selection.columns.length > 0 && copyPage) {
        await columnCopy.copy(format, selection.columns.toArray().map(i => columns[i]));
        return;
      }
      if (!block || block.rowIdx.length === 0) return;
      const cols = block.cols.map((i) => columns[i]);
      const data = block.rowIdx.map((r) => block.cols.map((c) => rows[r][c]));
      try {
        await writeText(serializeRows(format, cols, data, insertTarget));
        if (selection.columns.length > 0 && resultTruncated) appStore.getState().pushToast("info", `Copied ${rows.length.toLocaleString()} held result rows. This SQL result was truncated at its max rows; rerun with a higher limit or export the query for all rows.`);
      } catch (e) {
        console.error("copy failed", e);
      }
    },
    [selectedBlock, columns, rows, insertTarget, selection.columns, copyPage, columnCopy.copy, resultTruncated],
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
    if (onEditCell) menuItems.push({ label: "Edit cell", onSelect: () => onEditCell({ col, row }) });
  }
  if (onFollowReference && selection.current) {
    const [col, row] = selection.current.cell;
    const target = columns[col]?.references;
    const value = rows[row]?.[col];
    // A server-truncated value is not the real key; it would match nothing.
    if (target && value != null && !truncatedSet.has(row * colCount + col)) {
      const where = target.schema === "public" ? target.table : `${target.schema}.${target.table}`;
      menuItems.push({ separator: true }, { label: `Open referenced row → ${where}`, shortcut: "⌘-click", onSelect: () => onFollowReference(target, value) });
    }
  }
  if (rowMenuItems && selection.current) {
    const extra = rowMenuItems(selection.current.cell[1]);
    if (extra.length) menuItems.push({ separator: true }, ...extra);
  }

  const containerStyle = { "--gdg-font-family": "var(--sv-font-mono)" } as CSSProperties;

  return (
    <div className="relative min-h-0 flex-1" style={containerStyle}>
      <DataEditor
        ref={editorRef}
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
        columnSelect="multi"
        rangeSelect="multi-rect"
        gridSelection={selection}
        onGridSelectionChange={onGridSelectionChange}
        onVisibleRegionChanged={trackRegion}
        onHeaderClicked={(colIndex, e) => {
          if (!onSortColumn || e.ctrlKey || e.metaKey) return;
          e.preventDefault();
          onSortColumn(columns[colIndex].name);
        }}
        onHeaderContextMenu={(col, e) => {
          e.preventDefault();
          setSelection({ columns: CompactSelection.fromSingleSelection(col), rows: CompactSelection.empty() });
          setMenu({ x: e.bounds.x + e.localEventX, y: e.bounds.y + e.localEventY });
        }}
        drawHeader={drawHeader}
        drawCell={drawCell}
        onCellActivated={([col, row]) => (onEditCell ?? onOpenCell)?.({ col, row })}
        onCellClicked={([col, row], e) => {
          const target = columns[col]?.references;
          const value = rows[row]?.[col];
          if (!onFollowReference || !target || value == null || truncatedSet.has(row * colCount + col) || !(e.metaKey || e.ctrlKey)) return;
          e.preventDefault();
          onFollowReference(target, value);
        }}
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
      {columnCopy.progress && <div role="status" className="absolute inset-x-0 bottom-0 flex items-center justify-between border-t border-border bg-surface px-3 py-2 text-xs"><span>{columnCopy.progress}</span><button className="btn" onClick={columnCopy.cancel}>Cancel copy</button></div>}
    </div>
  );
}
