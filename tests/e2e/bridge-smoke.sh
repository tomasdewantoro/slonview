#!/usr/bin/env bash
# Engine-level E2E against the dev-only HTTP bridge (src-tauri/examples/e2e_bridge.rs),
# which calls the same `slonview_lib::ops` functions as the Tauri commands.
#
#   SLONVIEW_E2E_DIR=$(mktemp -d) cargo run -p slonview --example e2e_bridge &   # 127.0.0.1:1499
#   tests/e2e/bridge-smoke.sh
#
# Needs the seeded fixture DB (tests/fixtures/seed.sql) on local Postgres, psql, jq, curl.
# Creates one profile + credential-store entry and deletes both at the end.
set -euo pipefail

B=${SLONVIEW_BRIDGE:-http://127.0.0.1:1499/invoke}
PSQL=(psql -h "${PGHOST:-/tmp}" -d slonview_fixture -Atq)
OUT=$(mktemp -d)
pass=0
fail=0

call() { curl -s -o "$OUT/body" -w '%{http_code}' -XPOST "$B/$1" -H 'content-type: application/json' -d "${2:-{\}}"; }
ok() { echo "PASS $1"; pass=$((pass + 1)); }
bad() { echo "FAIL $1: $2"; fail=$((fail + 1)); }
expect() { # name, expected, actual
  if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1" "expected [$2] got [$3]"; fi
}

ID=$(uuidgen | tr 'A-Z' 'a-z')
PROFILE=$(jq -nc --arg id "$ID" '{id:$id,name:"e2e smoke",host:"localhost",port:5432,database:"slonview_fixture",user:(env.USER),ssl:"disable",readOnly:true,color:null,statementTimeoutMs:30000}')
cleanup() {
  call delete_profile "{\"id\":\"$ID\"}" >/dev/null || true
  rm -rf "$OUT"
}
trap cleanup EXIT

# E2E-01: password goes to the OS credential store, never to the TOML.
expect "save_profile" 200 "$(call save_profile "{\"profile\":$PROFILE,\"password\":\"smoke-s3cret\"}")"
kc() { call e2e_keychain_get "{\"id\":\"$ID\"}" >/dev/null; jq -r . "$OUT/body"; }
expect "keychain has password" smoke-s3cret "$(kc)"
expect "save keeps password when key absent" 200 "$(call save_profile "{\"profile\":$PROFILE}")"
expect "keychain still has password" smoke-s3cret "$(kc)"
expect "blank name rejected" invalid "$( call save_profile "{\"profile\":$(jq -c '.name=" "' <<<"$PROFILE")}" >/dev/null; jq -r .kind "$OUT/body")"

# E2E-02: typed connection errors.
call test_connection "{\"profile\":$(jq -c '.port=5999' <<<"$PROFILE"),\"password\":null}" >/dev/null
expect "host down -> connect" connect "$(jq -r .kind "$OUT/body")"
call test_connection "{\"profile\":$(jq -c '.user="nosuchrole"' <<<"$PROFILE"),\"password\":null}" >/dev/null
expect "bad role -> auth" auth "$(jq -r .kind "$OUT/body")"
call list_schema_tree "{\"connId\":\"$ID\"}" >/dev/null
expect "not connected" notConnected "$(jq -r .kind "$OUT/body")"

expect "connect" 200 "$(call connect "{\"connId\":\"$ID\"}")"
req() { jq -nc --arg c "$ID" --arg s "$1" --arg t "$2" --argjson f "${3:-[]}" --argjson w "${4:-null}" --argjson o "${5:-[]}" \
  '{requestId:"r",req:{connId:$c,schema:$s,table:$t,filters:$f,rawWhere:$w,sort:$o,cursor:null,limit:500}}'; }

# E2E-05: quoted schema/table names page and sort.
call fetch_page "$(req 'Sales Data' 'Weird "Name" Table' '[]' null '[{"column":"Column With Space","desc":true}]')" >/dev/null
expect "weird table sorted first row" "$("${PSQL[@]}" -c 'select "Column With Space" from "Sales Data"."Weird ""Name"" Table" order by 1 desc, "Id" limit 1')" "$(jq -r '.rows[0][1]' "$OUT/body")"

# E2E-04: SQL NULL vs text 'NULL'.
call fetch_page "$(req public all_types)" >/dev/null
expect "NULL vs 'NULL'" "null|NULL" "$(jq -r '[.rows[1][3], .rows[2][3]] | map(if . == null then "null" else . end) | join("|")' "$OUT/body")"

# E2E-06: filter + sort matches psql.
F='[{"column":"status","op":"=","value":"paid"}]'
call fetch_page "$(req public orders "$F" null '[{"column":"created_at","desc":true}]')" >/dev/null
expect "filter+sort ids = psql" "$("${PSQL[@]}" -c "select string_agg(id::text, ',') from (select id from orders where status='paid' order by created_at desc, id limit 500) s")" "$(jq -r '[.rows[][0]] | join(",")' "$OUT/body")"
call count_exact "{\"requestId\":\"c\",\"connId\":\"$ID\",\"schema\":\"public\",\"table\":\"orders\",\"filters\":$F,\"rawWhere\":null}" >/dev/null
expect "count = psql" "$("${PSQL[@]}" -c "select count(*) from orders where status='paid'")" "$(cat "$OUT/body")"

# Injection-shaped filter values are literals.
call fetch_page "$(req public all_types '[{"column":"c_text","op":"=","value":"O'"'"'Brien; DROP TABLE orders; --"}]')" >/dev/null
expect "injection value is a literal" 1 "$(jq '.rows | length' "$OUT/body")"

# Raw WHERE syntax error: position relative to the user's expression.
call fetch_page "$(req public all_types '[]' '"c_int >> AND"')" >/dev/null
expect "raw WHERE error position" "sql 10" "$(jq -r '"\(.kind) \(.position)"' "$OUT/body")"

# E2E-07: read-only session blocks writes.
call run_sql "{\"requestId\":\"d\",\"connId\":\"$ID\",\"sql\":\"DELETE FROM orders\",\"maxRows\":null}" >/dev/null
expect "read-only DELETE" "sql 25006" "$(jq -r '"\(.kind) \(.code)"' "$OUT/body")"

# E2E-08: cancel pg_sleep(60) in < 1 s.
(call run_sql "{\"requestId\":\"sleep\",\"connId\":\"$ID\",\"sql\":\"SELECT pg_sleep(60)\",\"maxRows\":null}" >/dev/null; cp "$OUT/body" "$OUT/sleep") &
sleep 1
t0=$(perl -MTime::HiRes=time -e 'printf "%d", time*1000')
call cancel_query '{"requestId":"sleep"}' >/dev/null
wait
t1=$(perl -MTime::HiRes=time -e 'printf "%d", time*1000')
expect "pg_sleep cancelled" cancelled "$(jq -r .kind "$OUT/sleep")"
if (( t1 - t0 < 1000 )); then ok "cancel < 1s ($((t1 - t0)) ms)"; else bad "cancel < 1s" "$((t1 - t0)) ms"; fi

# E2E-11: full-table CSV export.
SRC=$(jq -nc --arg c "$ID" '{kind:"table",connId:$c,schema:"public",table:"orders",filters:[],rawWhere:null,sort:[]}')
call export_csv "{\"requestId\":\"e\",\"source\":$SRC,\"path\":\"$OUT/orders.csv\"}" >/dev/null
expect "export rows" 1000000 "$(cat "$OUT/body")"
expect "export lines" 1000001 "$(wc -l <"$OUT/orders.csv" | tr -d ' ')"

# History records runs.
call list_history "{\"connId\":\"$ID\",\"search\":\"pg_sleep\",\"limit\":null}" >/dev/null
expect "history search" 1 "$(jq 'length' "$OUT/body")"

expect "disconnect" 200 "$(call disconnect "{\"connId\":\"$ID\"}")"
expect "delete_profile" 200 "$(call delete_profile "{\"id\":\"$ID\"}")"
expect "keychain entry removed" null "$(kc)"

echo "passed=$pass failed=$fail"
(( fail == 0 ))
