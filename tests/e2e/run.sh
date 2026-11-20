#!/usr/bin/env bash
# Headless end-to-end run: real Rust engine (dev-only HTTP bridge) + real React UI in headless
# Chromium. Never opens a window. Fresh profile/history dir per run; stops both servers on exit.
#
#   tests/e2e/run.sh            # bridge smoke + full UI suite
#
# Prereqs: seeded `slonview_fixture` (tests/fixtures/seed.sql) on local Postgres via /tmp socket,
# `pnpm install`, a Chromium headless shell (set CHROME=... if not the Playwright cache one).
set -euo pipefail
cd "$(dirname "$0")/../.."
source "$HOME/.cargo/env" 2>/dev/null || true

export SLONVIEW_E2E_DIR=$(mktemp -d /tmp/slonview-e2e-data.XXXXXX)
export SLONVIEW_E2E_SHOTS=${SLONVIEW_E2E_SHOTS:-/tmp/slonview-e2e}
mkdir -p "$SLONVIEW_E2E_SHOTS"

cargo build -q -p slonview --example e2e_bridge
./target/debug/examples/e2e_bridge >"$SLONVIEW_E2E_SHOTS/bridge.log" 2>&1 &
BRIDGE_PID=$!
# Run vite's entry point in this process tree (no pnpm/shim wrapper) so killing $VITE_PID stops it.
VITE_BRIDGE=1 node node_modules/vite/bin/vite.js --port 1450 --strictPort >"$SLONVIEW_E2E_SHOTS/vite.log" 2>&1 &
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

tests/e2e/bridge-smoke.sh
node tests/e2e/ui.e2e.mjs
