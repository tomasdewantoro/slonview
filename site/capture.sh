#!/usr/bin/env bash
# Regenerates site/assets/{table,sql}-{light,dark}.png from the real UI in headless Chromium.
# Never opens a window. Needs the seeded `slonview_fixture` DB on local Postgres.
set -Eeuo pipefail
cd "$(dirname "$0")/.."
source "$HOME/.cargo/env" 2>/dev/null || true

export SLONVIEW_E2E_DIR=$(mktemp -d /tmp/slonview-site-data.XXXXXX)
LOG=$(mktemp -d /tmp/slonview-site-logs.XXXXXX)
cargo build -q -p slonview --example e2e_bridge
./target/debug/examples/e2e_bridge >"$LOG/bridge.log" 2>&1 &
BRIDGE_PID=$!
VITE_BRIDGE=1 node node_modules/vite/bin/vite.js --port 1450 --strictPort >"$LOG/vite.log" 2>&1 &
VITE_PID=$!
cleanup() {
  kill "$BRIDGE_PID" "$VITE_PID" 2>/dev/null || true
  wait "$BRIDGE_PID" "$VITE_PID" 2>/dev/null || true
  rm -rf "$SLONVIEW_E2E_DIR"
}
trap cleanup EXIT

for _ in $(seq 100); do
  if curl -s -o /dev/null -XPOST http://127.0.0.1:1499/invoke/list_profiles && curl -s -o /dev/null http://localhost:1450/; then break; fi
  sleep 0.2
done

node site/capture.mjs
