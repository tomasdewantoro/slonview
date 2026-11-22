// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "../api";
import type { Activity } from "../bindings/Activity";
import { ActivityTab } from "./ActivityTab";
vi.mock("../api", () => ({ api: { listActivity: vi.fn() }, errorMessage: (e: unknown) => String(e) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn() }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(api.listActivity).mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("auto-refresh skips ticks while a list request is still running", async () => {
  let finish!: (rows: Activity[]) => void;
  vi.mocked(api.listActivity).mockResolvedValueOnce([]).mockReturnValueOnce(new Promise<Activity[]>((r) => (finish = r))).mockResolvedValue([]);
  render(<ActivityTab tab={{ id: "t", title: "Activity", connId: "c", preview: false, kind: "activity" }} connId="c" />);
  await act(async () => {});
  expect(api.listActivity).toHaveBeenCalledTimes(1);

  fireEvent.click(screen.getByLabelText("Auto-refresh"));
  await act(async () => vi.advanceTimersByTime(2000));
  expect(api.listActivity).toHaveBeenCalledTimes(2); // slow request starts
  await act(async () => vi.advanceTimersByTime(6000));
  expect(api.listActivity).toHaveBeenCalledTimes(2); // three ticks skipped while it runs

  await act(async () => finish([]));
  await act(async () => vi.advanceTimersByTime(2000));
  expect(api.listActivity).toHaveBeenCalledTimes(3); // resumes once it settles
});
