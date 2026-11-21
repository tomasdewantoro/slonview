#!/usr/bin/env bash
# Times a full-table CSV export of one table: `psql \copy` vs Slonview's export (through the
# dev-only HTTP bridge, which calls the same engine code as the app). Seeds nothing and only
# reads; Slonview's side runs in a read-only session.
#
#   scripts/bench-remote.sh postgres://user:pass@host:5432/db [schema.]table [runs]
#
# Names are taken literally (no SQL quoting) and split at the first dot: `Sales Data.orders`.
#
# Both sides write CSV with a header to a file in a temp directory (deleted at the end), and the
# two files are compared byte for byte. Slonview fsyncs its file at the end and psql does not, so
# the comparison slightly favours psql. Connection setup is excluded on both sides: psql is timed
# inside one session with the server clock around `\copy`, Slonview around the export call on an
# already open connection. The Slonview figure also includes one local HTTP round trip to the
# bridge and the table introspection the export does first (a few ms locally, one or two
# network round trips remotely), which the app pays too. Prints each run and the median.
#
# Needs psql, curl, jq, and cargo (to build the bridge in release mode) unless a bridge is
# already listening at $SLONVIEW_BRIDGE (default http://127.0.0.1:1499/invoke). A password in
# the URL is stored in the OS credential store for the duration of the run (one temporary
# profile) and deleted at the end.
set -Eeuo pipefail
trap 'echo "bench-remote.sh: failed at line $LINENO: $BASH_COMMAND" >&2' ERR

usage() { echo "usage: $0 postgres://... [schema.]table [runs]" >&2; exit 2; }
(($# >= 2)) || usage
URL=$1
TABLE_ARG=$2
RUNS=${3:-3}
[[ "$RUNS" =~ ^[1-9][0-9]*$ ]] || usage

cd "$(dirname "$0")/.."
for tool in psql curl jq; do
  command -v "$tool" >/dev/null || { echo "missing: $tool" >&2; exit 1; }
done

if [[ "$TABLE_ARG" == *.* ]]; then
  SCHEMA=${TABLE_ARG%%.*}
  TABLE=${TABLE_ARG#*.}
else
  SCHEMA=public
  TABLE=$TABLE_ARG
fi
qi() { local s=${1//\"/\"\"}; printf '"%s"' "$s"; }
QUALIFIED="$(qi "$SCHEMA").$(qi "$TABLE")"

B=${SLONVIEW_BRIDGE:-http://127.0.0.1:1499/invoke}
OUT=$(mktemp -d)
BRIDGE_PID=""
PROFILE_ID=""

call() { # command, json args -> HTTP status; body in $OUT/body
  curl -s -o "$OUT/body" -w '%{http_code}' -XPOST "$B/$1" -H 'content-type: application/json' -d "$2"
}
must() { # command, json args
  local status
  status=$(call "$1" "$2")
  [[ "$status" == 200 ]] || { echo "bridge $1 failed ($status): $(cat "$OUT/body")" >&2; exit 1; }
}
cleanup() {
  if [[ -n "$PROFILE_ID" ]]; then
    call disconnect "{\"connId\":\"$PROFILE_ID\"}" >/dev/null || true
    call delete_profile "{\"id\":\"$PROFILE_ID\"}" >/dev/null || true
  fi
  if [[ -n "$BRIDGE_PID" ]]; then
    kill "$BRIDGE_PID" 2>/dev/null || true
    wait "$BRIDGE_PID" 2>/dev/null || true
  fi
  rm -rf "$OUT"
}
trap cleanup EXIT

bridge_up() { curl -s -o /dev/null -XPOST "$B/list_profiles"; }
if ! bridge_up; then
  echo "building the e2e bridge (release)..." >&2
  cargo build -q --release -p slonview --example e2e_bridge
  SLONVIEW_E2E_DIR="$OUT/bridge-data" ./target/release/examples/e2e_bridge >"$OUT/bridge.log" 2>&1 &
  BRIDGE_PID=$!
  for _ in $(seq 100); do
    bridge_up && break
    sleep 0.1
  done
  bridge_up || { echo "bridge did not start:" >&2; cat "$OUT/bridge.log" >&2; exit 1; }
fi

median() { sort -n | awk '{ v[NR] = $1 } END { print (NR % 2) ? v[(NR + 1) / 2] : (v[NR / 2] + v[NR / 2 + 1]) / 2 }'; }
now_ms() { perl -MTime::HiRes=time -e 'printf "%d\n", time * 1000'; }

PSQL=(psql "$URL" -X -q -A -t -v ON_ERROR_STOP=1)

# Server and connection facts, as psql sees them (same URL as Slonview).
read -r -d '' FACTS_SQL <<'SQL' || true
SELECT current_setting('server_version'),
       CASE WHEN inet_server_addr() IS NULL THEN 'Unix socket'
            WHEN host(inet_server_addr()) IN ('127.0.0.1', '::1') THEN 'TCP loopback'
            ELSE 'TCP ' || host(inet_server_addr()) END,
       coalesce((SELECT CASE WHEN ssl THEN 'TLS ' || version ELSE 'no TLS' END
                 FROM pg_stat_ssl WHERE pid = pg_backend_pid()), 'no TLS')
SQL
IFS='|' read -r PG_VERSION CONN_KIND CONN_TLS < <("${PSQL[@]}" -c "$FACTS_SQL")
ROWS=$("${PSQL[@]}" -c "SELECT count(*) FROM $QUALIFIED")

case "$(uname -s)" in
  Darwin) MACHINE="$(sysctl -n hw.model), $(sysctl -n machdep.cpu.brand_string), macOS $(sw_vers -productVersion)" ;;
  Linux) MACHINE="$(cat /sys/devices/virtual/dmi/id/product_name 2>/dev/null || echo unknown), $(uname -r)" ;;
  *) MACHINE="$(uname -sm)" ;;
esac

echo "table:       $SCHEMA.$TABLE ($ROWS rows)"
echo "PostgreSQL:  $PG_VERSION"
echo "connection:  $CONN_KIND, $CONN_TLS"
echo "machine:     $MACHINE"
echo "runs:        $RUNS"
echo

# psql: one session, server clock around \copy.
psql_ms=()
for i in $(seq "$RUNS"); do
  ms=$("${PSQL[@]}" <<SQL | awk 'NR == 1 { a = $1 } NR == 2 { printf "%d\n", ($1 - a) * 1000 }'
SELECT extract(epoch FROM clock_timestamp());
\copy (SELECT * FROM $QUALIFIED) TO '$OUT/psql.csv' WITH (FORMAT csv, HEADER true)
SELECT extract(epoch FROM clock_timestamp());
SQL
  )
  psql_ms+=("$ms")
  echo "psql \\copy  run $i: ${ms} ms"
done

# Slonview: temporary read-only profile from the same URL, connect once, export N times.
must parse_conn_url "$(jq -nc --arg u "$URL" '{url:$u}')"
PARSED=$(cat "$OUT/body")
PROFILE_ID=$(jq -r .profile.id <<<"$PARSED")
must save_profile "$(jq -c '{profile:(.profile + {name:"bench-remote", readOnly:true, statementTimeoutMs:0}), password:.password}' <<<"$PARSED")"
must connect "{\"connId\":\"$PROFILE_ID\"}"

slon_ms=()
for i in $(seq "$RUNS"); do
  src=$(jq -nc --arg c "$PROFILE_ID" --arg s "$SCHEMA" --arg t "$TABLE" \
    --arg p "$OUT/slonview.csv" \
    '{requestId:"bench",source:{kind:"table",connId:$c,schema:$s,table:$t,filters:[],rawWhere:null,sort:[]},path:$p}')
  t0=$(now_ms)
  must export_csv "$src"
  ms=$(($(now_ms) - t0))
  exported=$(cat "$OUT/body")
  [[ "$exported" == "$ROWS" ]] || echo "warning: Slonview exported $exported rows, count(*) says $ROWS" >&2
  slon_ms+=("$ms")
  echo "Slonview    run $i: ${ms} ms"
done

echo
echo "median psql \\copy: $(printf '%s\n' "${psql_ms[@]}" | median) ms"
echo "median Slonview:   $(printf '%s\n' "${slon_ms[@]}" | median) ms"
if cmp -s "$OUT/psql.csv" "$OUT/slonview.csv"; then
  echo "output:            byte-identical ($(wc -c <"$OUT/psql.csv" | tr -d ' ') bytes)"
else
  echo "output:            DIFFERENT (psql $(wc -c <"$OUT/psql.csv" | tr -d ' ') bytes, Slonview $(wc -c <"$OUT/slonview.csv" | tr -d ' ') bytes)"
fi
