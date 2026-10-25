#!/usr/bin/env bash
# Samples the proportional set size of a running Mappa and reports the growth.
#   scripts/measure-leak.sh [minutes] [interval-seconds] [binary]
set -euo pipefail
cd "$(dirname "$0")/.."

MINUTES=${1:-10}
INTERVAL=${2:-30}
APP=${3:-target/release/mappa}
CSV=${CSV:-/tmp/mappa-leak.csv}

pkill -x mappa 2>/dev/null || true
sleep 1
env -u WAYLAND_DISPLAY GDK_BACKEND=x11 "$APP" >/tmp/mappa-leak.log 2>&1 &
sleep 15
pid=$(pgrep -x mappa | head -1)
[[ -n $pid ]] || { echo "app did not start" >&2; exit 1; }

pss() {
  local total=0 p value
  for p in "$pid" $(pgrep -P "$pid" 2>/dev/null); do
    value=$(grep -m1 '^Pss:' "/proc/$p/smaps_rollup" 2>/dev/null | awk '{print $2}' || true)
    total=$((total + ${value:-0}))
  done
  echo $((total / 1024))
}

echo "minute,pss_mib" >"$CSV"
first=""
last=""
runs=$((MINUTES * 60 / INTERVAL))
for i in $(seq 1 "$runs"); do
  value=$(pss)
  minute=$((i * INTERVAL / 60))
  echo "$minute,$value" >>"$CSV"
  [[ -z $first ]] && first=$value
  last=$value
  sleep "$INTERVAL"
done

kill "$pid" 2>/dev/null || true
sleep 2
kill -KILL "$pid" 2>/dev/null || true
growth=$((last - first))
echo "samples: $runs, first ${first} MiB, last ${last} MiB, growth ${growth} MiB"
echo "csv: $CSV"
if (( growth > first / 10 )); then
  echo "WARNING: PSS grew more than 10% — possible leak" >&2
  exit 2
fi
