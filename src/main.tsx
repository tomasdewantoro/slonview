import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

// Dev-only backends for UI work and headless E2E without the Tauri shell. The conditions are
// build-time constants, so production bundles drop the imports entirely.
if (import.meta.env.VITE_MOCK === "1") {
  const { installMockBackend } = await import("./dev/mockBackend");
  installMockBackend();
} else if (import.meta.env.VITE_BRIDGE === "1") {
  const { installBridgeBackend } = await import("./dev/bridgeBackend");
  installBridgeBackend();
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
