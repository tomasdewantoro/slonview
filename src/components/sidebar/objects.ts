// Labels for the sidebar's Sequences, Types, Triggers and Extensions groups.
import type { ExtensionInfo } from "../../bindings/ExtensionInfo";
import type { SequenceInfo } from "../../bindings/SequenceInfo";
import type { TriggerInfo } from "../../bindings/TriggerInfo";

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
