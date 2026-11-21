// Per-connection column catalog for SQL autocomplete, shared by every SQL tab. Loaded with one
// `list_columns` call per connection and reloaded whenever the store's schema tree is replaced
// (connect and the sidebar's Refresh both call loadTree), so it never outlives a refresh.
import { useEffect, useState } from "react";
import { api } from "../../api";
import type { SchemaNode } from "../../bindings/SchemaNode";
import { buildColumnIndex, type ColumnIndex } from "../../lib/sqlColumns";

interface Entry {
  /** The tree this load belongs to; a different tree means the sidebar was refreshed. */
  tree: SchemaNode[];
  promise: Promise<ColumnIndex>;
}

const cache = new Map<string, Entry>();
const EMPTY: ColumnIndex = new Map();

function load(connId: string, tree: SchemaNode[]): Promise<ColumnIndex> {
  const hit = cache.get(connId);
  if (hit && hit.tree === tree) return hit.promise;
  const promise = api.listColumns(connId).then(buildColumnIndex);
  cache.set(connId, { tree, promise });
  // A failed load is retried on the next refresh instead of being cached.
  promise.catch(() => {
    if (cache.get(connId)?.promise === promise) cache.delete(connId);
  });
  return promise;
}

/** Columns for `connId`; empty until loaded, and while the schema tree is still empty. */
export function useColumnIndex(connId: string, tree: SchemaNode[]): ColumnIndex {
  const [index, setIndex] = useState<ColumnIndex>(EMPTY);
  useEffect(() => {
    if (tree.length === 0) return;
    let live = true;
    load(connId, tree).then(
      (next) => live && setIndex(next),
      // Autocomplete is best-effort: keep the previous columns; the sidebar shows catalog errors.
      () => {},
    );
    return () => {
      live = false;
    };
  }, [connId, tree]);
  return index;
}
