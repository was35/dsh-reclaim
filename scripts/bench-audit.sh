#!/bin/sh
#
# Boot a real host over a real session store, and time what a panel open costs.
#
# WHY THIS EXISTS
# `scripts/verify-host.sh` boots a host over an EMPTY throwaway home, which is
# what its assertions need. The audit speed-up needs the opposite: a store with
# enough real sessions in it that "how long does an open take" has an answer.
# This script is that loop.
#
# READ-ONLY AGAINST THE REAL HOME — the one promise that matters here
# The real store is only ever READ (`cp -R` out of it). Everything the host then
# writes — session locks, the projection cache, the quarantine — lands in
# $BENCH_HOME, which is thrown away. Two guards enforce it:
#   * $BENCH_HOME may not be inside the real home (same guard verify-host.sh
#     uses), and
#   * session lock files are NOT copied: a copied lock is another process's lock
#     at another time, and handing the liveness probe a fiction would change
#     what gets graded, which is not something a benchmark may do.
#
# WHY A COPY AND NOT THE REAL HOME ITSELF
# Booting a host against ~/.dsh is a write, not a read: the host takes session
# locks, advances the projection cache and rewrites storages on its way up. The
# store is copied byte for byte instead, so the measured store is real and the
# real one is untouched.
#
# Usage:
#   sh scripts/bench-audit.sh                      # current working tree, preview on
#   LABEL=before PLUGIN_DIR=/tmp/old scripts/bench-audit.sh
#   PLUGIN_DIR=/tmp/old PREVIEW=0 sh scripts/bench-audit.sh
#   KEEP_HOME=1 sh scripts/bench-audit.sh
#
# Output: one line of JSON on stdout (see scripts/bench-audit.mjs); the running
# narrative goes to stderr.
#
set -eu

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
DSH_BIN=${DSH_BIN:-/usr/local/bin/dsh}
PORT=${PORT:-19401}
PROFILE=${PROFILE:-web}
LABEL=${LABEL:-after}
PLUGIN_DIR=${PLUGIN_DIR:-$REPO_ROOT}
SOURCE_HOME=${SOURCE_HOME:-${HOME}/.dsh}
BENCH_HOME=${BENCH_HOME:-/tmp/dsh-reclaim-bench-${LABEL}}
PREVIEW=${PREVIEW:-1}
KEEP_HOME=${KEEP_HOME:-0}

# Guard 1: never operate on the real home.
REAL_HOME=${HOME}/.dsh
case "$BENCH_HOME" in
  "$REAL_HOME"|"$REAL_HOME"/*)
    echo "REFUSING: BENCH_HOME ($BENCH_HOME) is inside the real DSH home ($REAL_HOME)." >&2
    exit 2
    ;;
esac
: "${BENCH_HOME:?BENCH_HOME must not be empty}"
[ -x "$DSH_BIN" ] || { echo "FATAL: no dsh at $DSH_BIN" >&2; exit 2; }
[ -d "$SOURCE_HOME/sessions" ] || { echo "FATAL: no session store at $SOURCE_HOME/sessions" >&2; exit 2; }
[ -d "$PLUGIN_DIR/lib" ] || { echo "FATAL: $PLUGIN_DIR does not look like this plugin" >&2; exit 2; }

BOOT_LOG="$BENCH_HOME.boot.log"
COOKIE_JAR="$BENCH_HOME.cookies"
HOST_PID=

cleanup() {
  if [ -n "$HOST_PID" ]; then
    kill "$HOST_PID" 2>/dev/null || true
    sleep 1
    kill -9 "$HOST_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

echo "== bench: label=$LABEL  plugin=$PLUGIN_DIR" >&2
echo "== store: $SOURCE_HOME (read-only) → $BENCH_HOME (throwaway)" >&2

rm -rf "$BENCH_HOME" "$BOOT_LOG" "$COOKIE_JAR"
mkdir -p "$BENCH_HOME"

echo "-- 1/4 copy the store (the real home is only read)" >&2
for tree in sessions attachments cache storages; do
  [ -d "$SOURCE_HOME/$tree" ] || continue
  cp -R "$SOURCE_HOME/$tree" "$BENCH_HOME/$tree"
done
# See the header: a lock belongs to the process that took it.
find "$BENCH_HOME/sessions" -name 'session.lock' -delete 2>/dev/null || true
copied_logs=$(find "$BENCH_HOME/sessions" -name 'session.v*.jsonl.zstd' | wc -l | tr -d ' ')
copied_bytes=$(du -sk "$BENCH_HOME/sessions" | awk '{print $1 * 1024}')
echo "   copied: $copied_logs log file(s), $copied_bytes bytes" >&2

export DSH_HOME="$BENCH_HOME"

echo "-- 2/4 init the '$PROFILE' profile and install the plugin" >&2
"$DSH_BIN" --profile "$PROFILE" --dump-config >/dev/null 2>&1 || {
  echo "FATAL: profile '$PROFILE' does not exist. 'web' and 'desktop' are shipped." >&2
  exit 2
}
"$DSH_BIN" plugin --profile "$PROFILE" add "file:$PLUGIN_DIR" >/dev/null 2>&1

echo "-- 3/4 boot" >&2
"$DSH_BIN" --profile "$PROFILE" --port "$PORT" --no-open >"$BOOT_LOG" 2>&1 &
HOST_PID=$!

TOKEN=
waited=0
while [ "$waited" -lt 90 ]; do
  TOKEN=$(sed -n 's/.*token=\([A-Za-z0-9_.-]*\).*/\1/p' "$BOOT_LOG" | head -1)
  [ -n "$TOKEN" ] && break
  sleep 1
  waited=$((waited + 1))
done

if [ -z "$TOKEN" ]; then
  echo "FAIL: the host never printed a token after ${waited}s" >&2
  cat "$BOOT_LOG" >&2
  exit 1
fi

# A dead bundle entry does not stop the host, so it has to be asserted: without
# this the bench would happily time a plugin that never mounted.
if grep -q "did not activate" "$BOOT_LOG"; then
  echo "FAIL: the host booted with an inactive entry:" >&2
  grep -A2 -B2 "did not activate" "$BOOT_LOG" >&2
  exit 1
fi

curl -sS -c "$COOKIE_JAR" -L -o /dev/null "http://127.0.0.1:$PORT/?token=$TOKEN"

echo "-- 4/4 measure" >&2
if [ "$PREVIEW" = "1" ]; then
  node "$REPO_ROOT/scripts/bench-audit.mjs" --port "$PORT" --jar "$COOKIE_JAR" --label "$LABEL" --preview
else
  node "$REPO_ROOT/scripts/bench-audit.mjs" --port "$PORT" --jar "$COOKIE_JAR" --label "$LABEL"
fi

cleanup
HOST_PID=

if [ "$KEEP_HOME" = "1" ]; then
  echo "kept: $BENCH_HOME" >&2
else
  rm -rf "$BENCH_HOME"
fi
