import { ChevronDown, ChevronRight, type LucideIcon } from "lucide-react";
import type { MouseEvent, ReactNode } from "react";
import type { OpenMode } from "../../store/app";

/**
 * Open mode of a tree item click: a single mouse click previews; the second click of a
 * double-click (`detail` 2+) and Enter/Space (`detail` 0, keyboard users have no double-click) pin.
 */
export function clickMode(e: MouseEvent): OpenMode {
  return e.detail === 1 ? "preview" : "pinned";
}

/** Indentation per depth: group header and its rows. Depth 0 = database level, 1 = inside a schema. */
const PAD = [
  { header: "pl-1.5", row: "pl-6" },
  { header: "pl-6", row: "pl-[43px]" },
] as const;

interface GroupProps {
  label: string;
  /** Accessible name, e.g. "Types in public, 3". */
  ariaLabel: string;
  count: number;
  open: boolean;
  depth: 0 | 1;
  onToggle: () => void;
  children: ReactNode;
}

/** Collapsible object group (Functions, Sequences, …) inside the schema tree. */
export function TreeGroup({ label, ariaLabel, count, open, depth, onToggle, children }: GroupProps) {
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div role="treeitem" aria-expanded={open} aria-selected={false}>
      <button
        className={`flex w-full items-center gap-1.5 py-[3px] pr-2 ${PAD[depth].header} text-left text-muted hover:bg-surface-2`}
        aria-label={ariaLabel}
        onClick={onToggle}
      >
        <Chevron size={13} className="shrink-0" aria-hidden />
        <span className={`min-w-0 flex-1 truncate ${depth === 0 ? "font-medium" : ""}`}>{label}</span>
        <span className="shrink-0 font-mono text-[11px] text-faint tabular-nums">{count}</span>
      </button>
      {open && <div role="group">{children}</div>}
    </div>
  );
}

interface RowProps {
  icon: LucideIcon;
  /** Icon label (object kind) for screen readers. */
  kind: string;
  /** Accent the icon to set this kind apart from the plain default. */
  accent?: boolean;
  name: string;
  /** Faint secondary text after the name. */
  detail?: string;
  /** Monospace right-aligned value (sequence last value, extension version). */
  value?: string;
  title: string;
  depth: 0 | 1;
  /** Click previews, double-click / Enter / Space pins. */
  onOpen: (mode: OpenMode) => void;
  onMenu: (e: MouseEvent) => void;
}

/** One object in a TreeGroup: click opens its SQL tab, right-click opens the context menu. */
export function ObjectRow({ icon: Icon, kind, accent, name, detail, value, title, depth, onOpen, onMenu }: RowProps) {
  return (
    <button
      role="treeitem"
      aria-selected={false}
      className={`flex w-full items-center gap-1.5 py-[3px] pr-2 ${PAD[depth].row} text-left hover:bg-surface-2`}
      title={title}
      onClick={(e) => onOpen(clickMode(e))}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e);
      }}
    >
      <Icon size={13} className={`shrink-0 ${accent ? "text-accent" : "text-faint"}`} aria-label={kind} />
      <span className={detail ? "max-w-[75%] shrink-0 truncate" : "min-w-0 flex-1 truncate"}>{name}</span>
      {detail && <span className="min-w-0 flex-1 truncate text-[11.5px] text-faint">{detail}</span>}
      {value && <span className="max-w-[40%] shrink-0 truncate font-mono text-[11px] text-faint tabular-nums">{value}</span>}
    </button>
  );
}
