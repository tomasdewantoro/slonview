// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "../api";
import type { Column } from "../bindings/Column";
import { RecordView } from "./RecordView";
vi.mock("../api", () => ({ api: { getCell: vi.fn() }, errorMessage: (e: unknown) => String(e) }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn() }));

const columns: Column[] = [
  { name: "id", typeName: "integer", isPk: true, nullable: false, references: null },
  { name: "body", typeName: "text", isPk: false, nullable: true, references: null },
];
const rows = [["1", "preview of row one"], ["2", "preview of row two"]];
const view = (row: number) => <RecordView connId="c" schema="public" table="t" columns={columns} rows={rows} row={row} truncatedCols={new Set([1])} onMove={() => {}} onClose={() => {}} />;

afterEach(cleanup);

function deferred() {
  let resolve!: (v: string) => void;
  const promise = new Promise<string>((r) => (resolve = r));
  return { promise, resolve };
}

it("a full value that arrives after moving to the next row is not shown on that row", async () => {
  const slow = deferred();
  vi.mocked(api.getCell).mockReturnValueOnce(slow.promise);
  const { rerender } = render(view(0));
  fireEvent.click(screen.getByText("First 2,048 characters. Show full value"));
  expect(api.getCell).toHaveBeenCalledWith(expect.objectContaining({ pkValues: ["1"], column: "body" }));
  rerender(view(1));
  await act(async () => slow.resolve("FULL VALUE OF ROW ONE"));
  expect(screen.queryByText("FULL VALUE OF ROW ONE")).toBeNull();
  expect(screen.getByText("preview of row two")).toBeTruthy();
  expect(screen.getByText("First 2,048 characters. Show full value")).toBeTruthy();
});

it("a full value fetched by Copy is not shown on the next row", async () => {
  const slow = deferred();
  vi.mocked(api.getCell).mockReturnValueOnce(slow.promise);
  const { rerender } = render(view(0));
  fireEvent.click(screen.getByLabelText("Copy body"));
  rerender(view(1));
  await act(async () => slow.resolve("FULL VALUE OF ROW ONE"));
  expect(screen.queryByText("FULL VALUE OF ROW ONE")).toBeNull();
  expect(screen.getByText("preview of row two")).toBeTruthy();
});

it("on the same row the full value replaces the preview", async () => {
  vi.mocked(api.getCell).mockResolvedValueOnce("FULL VALUE OF ROW ONE");
  render(view(0));
  await act(async () => fireEvent.click(screen.getByText("First 2,048 characters. Show full value")));
  expect(screen.getByText("FULL VALUE OF ROW ONE")).toBeTruthy();
});
