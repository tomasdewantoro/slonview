#!/usr/bin/env bash
# Headless end-to-end run: real Rust engine (dev-only HTTP bridge) + real React UI in headless
# Chromium. Never opens a window. Fresh profile/history dir per run; stops both servers on exit.
#
#   tests/e2e/run.sh            # bridge smoke + full UI suite
#
# Env (all optional, so several runs can share one machine):
#   SLONVIEW_BRIDGE_PORT  bridge port (default 1499)
#   SLONVIEW_UI_PORT      vite port (default 1450)
#   SLONVIEW_FIXTURE_DB   fixture database (default slonview_fixture)
#   SLONVIEW_SCRATCH_DB   scratch database for E2E-09 (default slonview_e2e_scratch)
#   SLONVIEW_RESEED=1     drop and re-create the fixture database from tests/fixtures/seed.sql first
#   SLONVIEW_E2E_SHOTS    screenshot/log dir (default /tmp/slonview-e2e)
#
# Prereqs: local Postgres via the /tmp socket, `pnpm install`, a Chromium headless shell
# (set CHROME=... if not the Playwright cache one).
set -euo pipefail
cd "$(dirname "$0")/../.."
source "$HOME/.cargo/env" 2>/dev/null || true

BRIDGE_PORT=${SLONVIEW_BRIDGE_PORT:-1499}
UI_PORT=${SLONVIEW_UI_PORT:-1450}
export SLONVIEW_FIXTURE_DB=${SLONVIEW_FIXTURE_DB:-slonview_fixture}
export SLONVIEW_SCRATCH_DB=${SLONVIEW_SCRATCH_DB:-slonview_e2e_scratch}
export SLONVIEW_BRIDGE="http://127.0.0.1:$BRIDGE_PORT/invoke"
export SLONVIEW_UI_URL="http://localhost:$UI_PORT/"
export SLONVIEW_E2E_DIR=$(mktemp -d /tmp/slonview-e2e-data.XXXXXX)
export SLONVIEW_E2E_SHOTS=${SLONVIEW_E2E_SHOTS:-/tmp/slonview-e2e}
mkdir -p "$SLONVIEW_E2E_SHOTS"

if [[ "${SLONVIEW_RESEED:-}" == 1 ]]; then
  dropdb -h /tmp --if-exists "$SLONVIEW_FIXTURE_DB"
  createdb -h /tmp "$SLONVIEW_FIXTURE_DB"
  # seed.sql builds timestamptz values from zone-less literals; the tests expect Asia/Jakarta.
  PGTZ=Asia/Jakarta psql -h /tmp -q -X -v ON_ERROR_STOP=1 -d "$SLONVIEW_FIXTURE_DB" -f tests/fixtures/seed.sql >/dev/null
fi

cargo build -q -p slonview --example e2e_bridge
SLONVIEW_BRIDGE_ADDR="127.0.0.1:$BRIDGE_PORT" ./target/debug/examples/e2e_bridge >"$SLONVIEW_E2E_SHOTS/bridge.log" 2>&1 &
BRIDGE_PID=$!
# Run vite's entry point in this process tree (no pnpm/shim wrapper) so killing $VITE_PID stops it.
VITE_BRIDGE=1 VITE_BRIDGE_URL="$SLONVIEW_BRIDGE/" node node_modules/vite/bin/vite.js --port "$UI_PORT" --strictPort >"$SLONVIEW_E2E_SHOTS/vite.log" 2>&1 &
VITE_PID=$!
cleanup() {
  kill "$BRIDGE_PID" "$VITE_PID" 2>/dev/null || true
  wait "$BRIDGE_PID" "$VITE_PID" 2>/dev/null || true
  rm -rf "$SLONVIEW_E2E_DIR"
}
trap cleanup EXIT

for _ in $(seq 100); do
  if curl -s -o /dev/null -XPOST "$SLONVIEW_BRIDGE/list_profiles" && curl -s -o /dev/null "$SLONVIEW_UI_URL"; then break; fi
  sleep 0.2
done

tests/e2e/bridge-smoke.sh
node tests/e2e/ui.e2e.mjs
