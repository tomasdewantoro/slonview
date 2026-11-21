// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { api } from "../../api";
import type { Column } from "../../bindings/Column";
import { useRowEdits } from "./useRowEdits";
vi.mock("../../api", () => ({ api: { editInfo: vi.fn(), getEditRow: vi.fn(), reviewEdits: vi.fn(), applyEdits: vi.fn() }, errorMessage: (e: unknown) => String(e), newRequestId: () => "request" }));
vi.mock("../../store/app", () => ({ appStore: { getState: () => ({ pushToast: vi.fn() }) } }));
const columns: Column[] = [{ name: "id", typeName: "integer", isPk: true, nullable: false }, { name: "note", typeName: "text", isPk: false, nullable: true }];
const rows = [["1", "visible original"]];
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.editInfo).mockResolvedValue({ disabledReason: null, blockedColumns: [] });
  vi.mocked(api.getEditRow).mockResolvedValue([{ column: "id", value: "1" }, { column: "note", value: "concurrent change" }]);
  vi.mocked(api.reviewEdits).mockResolvedValue(["UPDATE from Rust;"]);
  vi.mocked(api.applyEdits).mockResolvedValue(1);
});
it("preserves visible originals, distinguishes NULL, reviews Rust SQL and refreshes after apply", async () => {
  const refresh = vi.fn();
  const { result } = renderHook(() => useRowEdits("c", "public", "t", columns, rows, [], false, refresh));
  await waitFor(() => expect(result.current.reason).toBeNull());
  await act(() => result.current.start({ row: 0, col: 1 }));
  expect(result.current.editor?.value).toBe("visible original");
  act(() => result.current.saveCell(null));
  expect(result.current.rows[0][1]).toBeNull();
  expect(result.current.rowChanges.get(0)).toBe("modified");
  await act(() => result.current.reviewChanges());
  expect(api.reviewEdits).toHaveBeenCalledWith(expect.objectContaining({ changes: [{ kind: "update", original: [{ column: "id", value: "1" }, { column: "note", value: "visible original" }], values: [{ column: "note", value: null }] }] }));
  expect(result.current.review).toEqual(["UPDATE from Rust;"]);
  await act(() => result.current.apply());
  expect(refresh).toHaveBeenCalledOnce();
  expect(result.current.count).toBe(0);
});
it("new rows remain contiguous when one pending insert is removed", async () => {
  const { result } = renderHook(() => useRowEdits("c", "public", "t", columns, rows, [], false, vi.fn()));
  await waitFor(() => expect(result.current.reason).toBeNull());
  act(() => { result.current.add([{ column: "id", value: "2" }]); result.current.add([{ column: "id", value: "3" }]); });
  await act(() => result.current.remove([1]));
  expect(result.current.rows).toEqual([["1", "visible original"], ["3", null]]);
  expect(result.current.rowChanges.get(1)).toBe("new");
  act(() => result.current.discard());
  expect(result.current.rows).toBe(rows);
});
it("read-only profiles cannot start editing or deleting", async () => {
  const { result } = renderHook(() => useRowEdits("c", "public", "t", columns, rows, [], true, vi.fn()));
  await act(() => result.current.start({ row: 0, col: 1 }));
  await act(() => result.current.remove([0]));
  expect(result.current.editor).toBeNull();
  expect(result.current.count).toBe(0);
  expect(api.getEditRow).not.toHaveBeenCalled();
  expect(api.editInfo).not.toHaveBeenCalled();
});
