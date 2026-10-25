#!/usr/bin/env bash
# Measures the release build on this machine: time until the window is mapped,
# until WebKit spawns, and the settled proportional set size of the process.
# Works on X11 and under XWayland; Wayland-only sessions skip the window timing.
#
#   scripts/measure-startup.sh [path/to/mappa] [runs]
set -euo pipefail

APP=${1:-target/release/mappa}
RUNS=${2:-3}
COLD=${COLD:-0}
export DISPLAY=${DISPLAY:-:0}

ms() { echo $(( ($(date +%s%N) - $1) / 1000000 )); }

pss_total() {
  local pid=$1 total=0 p
  for p in "$pid" $(pgrep -P "$pid" 2>/dev/null); do
    local value
    value=$(grep -m1 '^Pss:' "/proc/$p/smaps_rollup" 2>/dev/null | awk '{print $2}' || true)
    total=$((total + ${value:-0}))
  done
  echo $((total / 1024))
}

have_xwininfo=0
command -v xwininfo >/dev/null && have_xwininfo=1

for run in $(seq 1 "$RUNS"); do
  pkill -x "$(basename "$APP")" 2>/dev/null || true
  sleep 0.8
  if [[ $COLD == 1 ]]; then
    # Evict the binary from the page cache; shared libraries stay cached,
    # which is the unprivileged approximation of a cold start.
    python3 -c 'import os, sys
fd = os.open(sys.argv[1], os.O_RDONLY)
os.posix_fadvise(fd, 0, 0, os.POSIX_FADV_DONTNEED)
os.close(fd)' "$APP"
  fi
  start=$(date +%s%N)
  env -u WAYLAND_DISPLAY GDK_BACKEND=x11 "$APP" >/tmp/mappa-startup.log 2>&1 &
  pid=$!
  t_window=""
  t_webkit=""
  for _ in $(seq 1 600); do
    if [ -z "$t_window" ] && [ "$have_xwininfo" = 1 ]; then
      # Capture instead of piping into grep: under pipefail the reader exits
      # early, xwininfo gets SIGPIPE and the pipeline reports failure.
      window_list=$(xwininfo -root -tree 2>/dev/null || true)
      if [[ $window_list == *'("mappa" "Mappa")'* ]]; then
        t_window=$(ms "$start")
      fi
    fi
    if [ -z "$t_webkit" ] && pgrep -P "$pid" -f WebKitWebProcess >/dev/null 2>&1; then
      t_webkit=$(ms "$start")
    fi
    [ -n "$t_window" ] && [ -n "$t_webkit" ] && break
    sleep 0.02
  done
  sleep 5
  echo "run $run: window ${t_window:-n/a} ms, webkit ${t_webkit:-n/a} ms, PSS $(pss_total "$pid") MiB"
  kill "$pid" 2>/dev/null || true
done
