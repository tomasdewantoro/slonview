#!/usr/bin/env bash
# Measures the installed Slonview.app: launch time and idle memory. Opens a real window, so run
# it yourself on a quiet machine; it quits the app at the end.
#
#   scripts/measure-app.sh [/Applications/Slonview.app]
#
# Env: IDLE_SECONDS (default 10), SAMPLE_INTERVAL (default 0.5).
#
# What it reports:
#   - launch: wall time from `open` until the app process exists, and until its RSS settles
#     (changes < 2% over 1 s), a proxy for "window up and idle" that needs no UI scripting;
#   - idle RSS of the app process (median and peak over IDLE_SECONDS);
#   - the same for the app plus the WebKit helper processes (WebContent/Networking/GPU) that
#     appeared during this launch. A WKWebView renders out of process, so the app process alone
#     undercounts. Close Safari and other WebKit apps first or helpers they spawn may be counted.
set -Eeuo pipefail
trap 'echo "measure-app.sh: failed at line $LINENO: $BASH_COMMAND" >&2' ERR

APP=${1:-/Applications/Slonview.app}
IDLE_SECONDS=${IDLE_SECONDS:-10}
SAMPLE_INTERVAL=${SAMPLE_INTERVAL:-0.5}

[[ "$(uname -s)" == Darwin ]] || { echo "macOS only" >&2; exit 1; }
[[ -d "$APP" ]] || { echo "not found: $APP" >&2; exit 1; }

NAME=$(defaults read "$APP/Contents/Info" CFBundleName)
EXE=$(defaults read "$APP/Contents/Info" CFBundleExecutable)
BIN="$APP/Contents/MacOS/$EXE"

if pgrep -f "^$BIN" >/dev/null; then
  echo "$NAME is already running; quit it first." >&2
  exit 1
fi

now_ms() { perl -MTime::HiRes=time -e 'printf "%d\n", time * 1000'; }
# comm needs lexical order, not numeric.
webkit_pids() { pgrep -f 'com\.apple\.WebKit\.(WebContent|Networking|GPU)' | LC_ALL=C sort || true; }
rss_kb() { # pids... -> summed RSS in KiB of those still alive (0 if none)
  if (($# == 0)); then echo 0; return; fi
  local list
  list=$(IFS=,; echo "$*")
  # ps exits 1 if any listed pid has exited (helpers come and go); that is not an error here.
  { ps -o rss= -p "$list" 2>/dev/null || true; } | awk '{ s += $1 } END { print s + 0 }'
}
stats() { # numbers on stdin -> "median peak"
  sort -n | awk '{ v[NR] = $1 } END {
    if (NR == 0) { print "0 0"; exit }
    m = (NR % 2) ? v[(NR + 1) / 2] : (v[NR / 2] + v[NR / 2 + 1]) / 2
    print m, v[NR] }'
}
mib() { awk -v k="$1" 'BEGIN { printf "%.1f MiB", k / 1024 }'; }

before_webkit=$(webkit_pids)
t0=$(now_ms)
open -a "$APP"

pid=""
for _ in $(seq 400); do # up to 20 s
  pid=$(pgrep -f "^$BIN" | head -n 1 || true)
  [[ -n "$pid" ]] && break
  sleep 0.05
done
[[ -n "$pid" ]] || { echo "process did not start within 20 s" >&2; exit 1; }
t_process=$(($(now_ms) - t0))

quit_app() {
  osascript -e "quit app \"$NAME\"" >/dev/null 2>&1 || true
  for _ in $(seq 50); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.1
  done
  echo "warning: $NAME still running after 5 s" >&2
}
trap quit_app EXIT

# Settled = RSS changed by less than 2% across the last 10 samples (1 s at 0.1 s).
window=()
t_settled=""
for _ in $(seq 300); do # up to 30 s
  window+=("$(rss_kb "$pid")")
  if ((${#window[@]} > 10)); then
    window=("${window[@]:1}")
    lo=$(printf '%s\n' "${window[@]}" | sort -n | head -n 1)
    hi=$(printf '%s\n' "${window[@]}" | sort -n | tail -n 1)
    if ((lo > 0 && (hi - lo) * 100 < lo * 2)); then
      t_settled=$(($(now_ms) - t0))
      break
    fi
  fi
  sleep 0.1
done

new_webkit=$(comm -13 <(echo "$before_webkit") <(webkit_pids) | tr '\n' ' ')

samples=$(awk -v s="$IDLE_SECONDS" -v i="$SAMPLE_INTERVAL" 'BEGIN { printf "%d", s / i }')
app_samples=()
total_samples=()
for _ in $(seq "$samples"); do
  app=$(rss_kb "$pid")
  # Word splitting of the helper pid list is intended.
  # shellcheck disable=SC2086
  helpers=$(rss_kb $new_webkit)
  app_samples+=("$app")
  total_samples+=($((app + helpers)))
  sleep "$SAMPLE_INTERVAL"
done

read -r app_median app_peak < <(printf '%s\n' "${app_samples[@]}" | stats)
read -r total_median total_peak < <(printf '%s\n' "${total_samples[@]}" | stats)

echo "app:            $APP ($(defaults read "$APP/Contents/Info" CFBundleShortVersionString))"
echo "bundle size:    $(du -sh "$APP" | cut -f1)"
echo "machine:        $(sysctl -n hw.model), $(sysctl -n machdep.cpu.brand_string), macOS $(sw_vers -productVersion)"
echo "process up:     ${t_process} ms after open"
if [[ -n "$t_settled" ]]; then
  echo "RSS settled:    ${t_settled} ms after open"
else
  echo "RSS settled:    not within 30 s"
fi
echo "idle samples:   $samples x ${SAMPLE_INTERVAL}s"
echo "app process:    median $(mib "$app_median"), peak $(mib "$app_peak")"
echo "app + WebKit:   median $(mib "$total_median"), peak $(mib "$total_peak") (helpers: ${new_webkit:-none})"
