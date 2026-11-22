import { LoaderCircle, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { errorMessage } from "../api";
import type { ConnProfile } from "../bindings/ConnProfile";
import { appStore, useApp } from "../store/app";
import { ConnectionDialog, profileColor } from "./ConnectionDialog";
import { ConfirmDialog } from "./Dialog";
import { ContextMenu } from "./ContextMenu";

export function ColorDot({ color, className = "" }: { color: string | null; className?: string }) {
  const shown = profileColor(color);
  return (
    <span
      aria-hidden
      className={`inline-block size-2.5 shrink-0 rounded-full ${shown ? "" : "border border-border-strong"} ${className}`}
      style={shown ? { background: shown } : undefined}
    />
  );
}

/** Saved profiles. Enter or double-click connects. */
export function ConnectionList() {
  const profiles = useApp((s) => s.profiles);
  const selected = useApp((s) => s.selectedProfileId);
  const conns = useApp((s) => s.conns);
  const [editing, setEditing] = useState<ConnProfile | "new" | null>(null);
  const [deleting, setDeleting] = useState<ConnProfile | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; profile: ConnProfile } | null>(null);
  const { selectProfile, connect, deleteProfile, pushToast } = appStore.getState();

  const move = (delta: number) => {
    if (profiles.length === 0) return;
    const i = profiles.findIndex((p) => p.id === selected);
    const next = profiles[Math.max(0, Math.min(profiles.length - 1, i < 0 ? 0 : i + delta))];
    selectProfile(next.id);
    document.getElementById(`conn-${next.id}`)?.focus();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 items-center justify-between border-b border-border px-3">
        <span className="text-xs font-semibold text-muted">Connections</span>
        <button className="icon-btn" aria-label="New connection" title="New connection" onClick={() => setEditing("new")}>
          <Plus size={15} />
        </button>
      </div>
      <ul
        role="listbox"
        aria-label="Saved connections"
        className="min-h-0 flex-1 overflow-auto py-1"
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            move(1);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            move(-1);
          } else if (e.key === "Enter" && selected) {
            void connect(selected);
          } else if ((e.key === "Backspace" || e.key === "Delete") && e.metaKey && selected) {
            setDeleting(profiles.find((p) => p.id === selected) ?? null);
          }
        }}
      >
        {profiles.map((p) => {
          const isSel = p.id === selected;
          const state = conns[p.id]?.status ?? null;
          return (
            <li
              key={p.id}
              id={`conn-${p.id}`}
              role="option"
              aria-selected={isSel}
              tabIndex={isSel || (!selected && p === profiles[0]) ? 0 : -1}
              onClick={() => selectProfile(p.id)}
              onDoubleClick={() => void connect(p.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                selectProfile(p.id);
                setMenu({ x: e.clientX, y: e.clientY, profile: p });
              }}
              className={`group mx-1.5 flex items-center gap-2.5 rounded-md px-2 py-1.5 outline-none ${
                isSel ? "bg-accent-soft" : "hover:bg-surface-2"
              } focus-visible:ring-2 focus-visible:ring-focus-ring`}
            >
              <ColorDot color={p.color} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate font-medium">{p.name}</span>
                  {!p.readOnly && <span className="badge-write">WRITE</span>}
                </div>
                <div className="truncate font-mono text-[11px] text-muted">
                  {p.user}@{p.host}:{p.port}/{p.database}
                </div>
              </div>
              {state === "connecting" && <LoaderCircle size={14} className="animate-spin text-muted" aria-label="Connecting" />}
              {state === "failed" && <span className="text-[11px] text-error">failed</span>}
              {state === "connected" && <span className="text-[11px] text-muted">open</span>}
              <div className="hidden items-center group-hover:flex">
                <button className="icon-btn" aria-label={`Edit ${p.name}`} onClick={() => setEditing(p)}>
                  <Pencil size={13} />
                </button>
                <button className="icon-btn" aria-label={`Delete ${p.name}`} onClick={() => setDeleting(p)}>
                  <Trash2 size={13} />
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      {profiles.length === 0 && (
        <div className="px-4 pb-6 text-xs text-muted">
          <p className="text-pretty">No saved connections.</p>
          <button className="btn mt-2" onClick={() => setEditing("new")}>
            <Plus size={13} aria-hidden /> Add connection
          </button>
        </div>
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: "Connect", shortcut: "↵", onSelect: () => void connect(menu.profile.id) },
            { label: "Activity", disabled: conns[menu.profile.id]?.status !== "connected", onSelect: () => appStore.getState().openActivity(menu.profile.id) },
            { label: "Edit…", onSelect: () => setEditing(menu.profile) },
            { separator: true },
            { label: "Delete…", onSelect: () => setDeleting(menu.profile) },
          ]}
        />
      )}
      {editing && (
        <ConnectionDialog
          key={editing === "new" ? "new" : editing.id}
          existing={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title="Delete connection"
          message={
            <>
              Delete <b>{deleting.name}</b>? Its saved password is removed from this computer’s password store. This can't be undone.
            </>
          }
          confirmLabel="Delete"
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            const target = deleting;
            setDeleting(null);
            deleteProfile(target.id).catch((e) => pushToast("error", `Couldn't delete ${target.name}: ${errorMessage(e)}`));
          }}
        />
      )}
    </div>
  );
}
