// Quick open (⌘P): every object of the loaded schema tree as one flat list, and the fuzzy ranking
// over it. Pure, so the palette needs no server round trip and the ranking is unit-tested.
import type { ExtensionInfo } from "../bindings/ExtensionInfo";
import type { FunctionInfo } from "../bindings/FunctionInfo";
import type { Relation } from "../bindings/Relation";
import type { SchemaNode } from "../bindings/SchemaNode";
import type { SequenceInfo } from "../bindings/SequenceInfo";
import type { TriggerInfo } from "../bindings/TriggerInfo";
import type { TypeInfo } from "../bindings/TypeInfo";

export type QuickOpenItem =
  | { kind: "relation"; key: string; name: string; schema: string; relation: Relation }
  | { kind: "function"; key: string; name: string; schema: string; fn: FunctionInfo }
  | { kind: "sequence"; key: string; name: string; schema: string; sequence: SequenceInfo }
  | { kind: "type"; key: string; name: string; schema: string; type: TypeInfo }
  | { kind: "trigger"; key: string; name: string; schema: string; trigger: TriggerInfo }
  | { kind: "extension"; key: string; name: string; schema: string; extension: ExtensionInfo };

export const QUICK_OPEN_LIMIT = 50;

/** Flattens the tree in sidebar order: per schema relations, functions, sequences, types, triggers; then extensions. */
export function quickOpenItems(tree: SchemaNode[], extensions: ExtensionInfo[]): QuickOpenItem[] {
  const out: QuickOpenItem[] = [];
  for (const s of tree) {
    for (const r of s.relations) out.push({ kind: "relation", key: `r:${r.schema}.${r.name}`, name: r.name, schema: r.schema, relation: r });
    for (const f of s.functions) out.push({ kind: "function", key: `f:${f.oid}`, name: f.name, schema: f.schema, fn: f });
    for (const q of s.sequences) out.push({ kind: "sequence", key: `s:${q.oid}`, name: q.name, schema: q.schema, sequence: q });
    for (const t of s.types) out.push({ kind: "type", key: `t:${t.oid}`, name: t.name, schema: t.schema, type: t });
    // Triggers are named after their table, as in the sidebar, so "orders" finds the triggers on it too.
    for (const t of s.triggers) out.push({ kind: "trigger", key: `g:${t.oid}`, name: `${t.table}.${t.name}`, schema: t.schema, trigger: t });
  }
  for (const e of extensions) out.push({ kind: "extension", key: `e:${e.oid}`, name: e.name, schema: e.schema, extension: e });
  return out;
}

/** Match quality, best (lowest) first. */
export const MatchTier = { Prefix: 0, WordStart: 1, Substring: 2, Subsequence: 3 } as const;
export type MatchTier = (typeof MatchTier)[keyof typeof MatchTier];

const isWordStart = (s: string, i: number) => i === 0 || /[^a-z0-9]/i.test(s[i - 1]) || (/[a-z]/.test(s[i - 1]) && /[A-Z]/.test(s[i]));

/**
 * How `query` matches `text`, case-insensitively, or null for no match: prefix, then the query
 * starting at a word start (after `_`, `.`, a space, or a lower-to-upper case change), then
 * anywhere, then as a subsequence (its characters in order, gaps allowed).
 */
export function matchTier(text: string, query: string): MatchTier | null {
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  if (q === "") return MatchTier.Prefix;
  if (t.startsWith(q)) return MatchTier.Prefix;
  let substring = false;
  for (let i = t.indexOf(q); i >= 0; i = t.indexOf(q, i + 1)) {
    if (isWordStart(text, i)) return MatchTier.WordStart;
    substring = true;
  }
  if (substring) return MatchTier.Substring;
  let j = 0;
  for (let i = 0; i < t.length && j < q.length; i++) if (t[i] === q[j]) j++;
  return j === q.length ? MatchTier.Subsequence : null;
}

/**
 * Items matching `query`, ranked by tier, then shorter name, then schema `public` first, then
 * name and schema (so the order is stable). A query with a dot also matches `schema.name`.
 * At most `limit` results.
 */
export function rankQuickOpen(items: QuickOpenItem[], query: string, limit = QUICK_OPEN_LIMIT): QuickOpenItem[] {
  const q = query.trim();
  const scored: { item: QuickOpenItem; tier: MatchTier }[] = [];
  for (const item of items) {
    let tier = matchTier(item.name, q);
    if (q.includes(".")) {
      const qualified = matchTier(`${item.schema}.${item.name}`, q);
      if (qualified !== null && (tier === null || qualified < tier)) tier = qualified;
    }
    if (tier !== null) scored.push({ item, tier });
  }
  scored.sort(
    (a, b) =>
      a.tier - b.tier ||
      a.item.name.length - b.item.name.length ||
      Number(b.item.schema === "public") - Number(a.item.schema === "public") ||
      a.item.name.localeCompare(b.item.name) ||
      a.item.schema.localeCompare(b.item.schema),
  );
  return scored.slice(0, limit).map((s) => s.item);
}
