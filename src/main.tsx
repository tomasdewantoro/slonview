import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

// Dev-only fake backend for UI work without the Rust engine. The condition is a build-time
// constant, so production bundles drop the import entirely.
if (import.meta.env.VITE_MOCK === "1") {
  const { installMockBackend } = await import("./dev/mockBackend");
  installMockBackend();
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
