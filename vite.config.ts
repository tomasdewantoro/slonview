/// <reference types="vitest/config" />
import { configDefaults } from "vitest/config";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(() => ({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**", "**/crates/**", "**/target/**", "**/.worktrees/**"] },
  },
  // Git worktrees under .worktrees/ hold other branches' copies of src; never collect them.
  test: { environment: "jsdom", exclude: [...configDefaults.exclude, ".worktrees/**"] },
}));
