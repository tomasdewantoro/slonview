// Dev-only E2E bridge (VITE_BRIDGE=1): forwards every invoke to the real Rust engine served by
// `cargo run -p slonview --example e2e_bridge` on 127.0.0.1:1499, so the real frontend runs in a
// headless browser. Plugin calls are faked and observable from the test:
//   window.__clipboard     last text written to the clipboard
//   window.__nextSavePath  path returned by the save dialog (default /tmp/slonview-e2e-export.csv)
//   window.__askAnswer     answer for confirm dialogs (default true)
// Never loaded in production (main.tsx gates the import on a build-time constant).
import { mockIPC } from "@tauri-apps/api/mocks";

const BRIDGE = "http://127.0.0.1:1499/invoke/";

declare global {
  interface Window {
    __clipboard?: string;
    __nextSavePath?: string;
    __askAnswer?: boolean;
    __dialogs?: { cmd: string; args: unknown }[];
  }
}

export function installBridgeBackend(): void {
  mockIPC(async (cmd, payload) => {
    const args = (payload ?? {}) as Record<string, unknown>;
    if (cmd.startsWith("plugin:")) {
      (window.__dialogs ??= []).push({ cmd, args });
      switch (cmd) {
        case "plugin:clipboard-manager|write_text":
          window.__clipboard = String(args.text ?? "");
          return null;
        case "plugin:dialog|save":
          return window.__nextSavePath ?? "/tmp/slonview-e2e-export.csv";
        case "plugin:dialog|ask":
        case "plugin:dialog|confirm":
          return window.__askAnswer ?? true;
        default:
          return null;
      }
    }
    const res = await fetch(BRIDGE + cmd, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    const body: unknown = await res.json();
    if (!res.ok) throw body;
    return body;
  });
}
