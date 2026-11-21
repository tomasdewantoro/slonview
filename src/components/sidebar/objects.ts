// Labels and actions for the sidebar's Sequences, Types, Triggers and Extensions groups.
import { api, errorMessage } from "../../api";
import type { ExtensionInfo } from "../../bindings/ExtensionInfo";
import type { ObjectKind } from "../../bindings/ObjectKind";
import type { SequenceInfo } from "../../bindings/SequenceInfo";
import type { TriggerInfo } from "../../bindings/TriggerInfo";
import { appStore } from "../../store/app";

/** Last value as shown in the tree: "?" when the role may not read it, "–" before first use. */
export function sequenceValue(s: SequenceInfo): string {
  if (!s.readable) return "?";
  return s.lastValue ?? "–";
}

/** "before insert or update, row" / "after truncate, statement". */
export function triggerSummary(t: TriggerInfo): string {
  const timing = t.timing === "instead-of" ? "instead of" : t.timing;
  return `${timing} ${t.events.join(" or ")}, ${t.forEachRow ? "row" : "statement"}`;
}

/** Case-insensitive substring match on the extension name. */
export function filterExtensions(extensions: ExtensionInfo[], query: string): ExtensionInfo[] {
  const q = query.trim().toLowerCase();
  if (!q) return extensions;
  return extensions.filter((e) => e.name.toLowerCase().includes(q));
}

/** Loads an object's SQL text into a new SQL tab titled `title`; errors become a toast. */
export async function openObject(kind: ObjectKind, oid: number, name: string, title: string): Promise<void> {
  const connectedId = () => {
    const c = appStore.getState().conn;
    return c?.status === "connected" ? c.profileId : null;
  };
  const connId = connectedId();
  if (!connId) return;
  try {
    const sql = await api.getObjectDefinition(connId, kind, oid);
    if (connectedId() === connId) appStore.getState().openSql(sql, title);
  } catch (e) {
    if (connectedId() === connId) appStore.getState().pushToast("error", `Couldn't load the definition of ${name}: ${errorMessage(e)}`);
  }
}
