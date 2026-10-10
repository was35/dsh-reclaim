#!/bin/sh
#
# Boot-and-probe — the only loop that exercises the REAL host.
#
# WHY IT EXISTS
# The unit loop (`npm test`) runs the plugin's modules against a test double for
# `@deepseek-ai/dsh-home-paths` (test/hooks/peer-double.mjs), because that
# host-provided package is unresolvable outside a running host. A double can
# prove the plugin's own logic; it cannot prove the plugin MOUNTS, that the host
# accepts its manifest and bundle patch, or that the real services are present.
# Only this loop can. It is also the regression check for anything touching
# lib/index.js, lib/routes.js or cordis.patch.yml.
#
# ISOLATION — what makes this safe to run at any time
# Everything happens under $DSH_HOME, which defaults to a throwaway directory.
# The real DSH home is refused outright, so the live desktop profile cannot be
# reached even by accident. Measured: after a run, `~/.dsh/profiles` still holds
# only the profiles it held before, no global `web` profile appears, and no
# plugin is installed globally. Removing $VERIFY_HOME undoes the whole run.
#
# Usage:
#   sh scripts/verify-host.sh            # throwaway home, removed on success
#   KEEP_HOME=1 sh scripts/verify-host.sh # keep it (reusable for other plugins)
#   VERIFY_HOME=/path PORT=19400 sh scripts/verify-host.sh
#
# A custom PROFILE name needs a TEMPLATE, because the host only knows how to
# create the profiles it ships. `web` and `desktop` are shipped and must NOT be
# given a template (the host rejects that outright: "profile ... is shipped and
# cannot be a custom profile target"); any other name must say what to clone:
#   TEMPLATE=web PROFILE=desktop-clone sh scripts/verify-host.sh
#
set -eu

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
DSH_BIN=${DSH_BIN:-/usr/local/bin/dsh}
PORT=${PORT:-19399}
VERIFY_HOME=${VERIFY_HOME:-/tmp/dsh-reclaim-verify}
PROFILE=${PROFILE:-web}
TEMPLATE=${TEMPLATE:-}
KEEP_HOME=${KEEP_HOME:-0}

# The one guard that matters: never operate on the real home.
REAL_HOME=${HOME}/.dsh
case "$VERIFY_HOME" in
  "$REAL_HOME"|"$REAL_HOME"/*)
    echo "REFUSING: VERIFY_HOME ($VERIFY_HOME) is inside the real DSH home ($REAL_HOME)." >&2
    echo "This script must never touch the live profile." >&2
    exit 2
    ;;
esac

[ -x "$DSH_BIN" ] || { echo "FATAL: no dsh at $DSH_BIN" >&2; exit 2; }

BOOT_LOG="$VERIFY_HOME.boot.log"
COOKIE_JAR="$VERIFY_HOME.cookies"
HOST_PID=

cleanup() {
  if [ -n "$HOST_PID" ]; then
    kill "$HOST_PID" 2>/dev/null || true
    sleep 1
    kill -9 "$HOST_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

echo "== host loop: dsh $("$DSH_BIN" --version 2>/dev/null || echo '?')  home=$VERIFY_HOME  port=$PORT"

rm -rf "$VERIFY_HOME" "$BOOT_LOG" "$COOKIE_JAR"
export DSH_HOME="$VERIFY_HOME"

echo "-- 1/5 init the '$PROFILE' profile${TEMPLATE:+ from the '$TEMPLATE' template}"
if [ -n "$TEMPLATE" ]; then
  "$DSH_BIN" --profile "$PROFILE" --from-default-profile "$TEMPLATE" --dump-config >/dev/null 2>&1 || {
    echo "FATAL: could not create profile '$PROFILE' from template '$TEMPLATE'." >&2
    echo "       Shipped profiles are 'web' and 'desktop'; is '$TEMPLATE' one of them?" >&2
    exit 2
  }
else
  "$DSH_BIN" --profile "$PROFILE" --dump-config >/dev/null 2>&1 || {
    echo "FATAL: profile '$PROFILE' does not exist, and no TEMPLATE was given." >&2
    echo "       'web' and 'desktop' are shipped and need none; any other name must" >&2
    echo "       say what to clone:" >&2
    echo "         TEMPLATE=web PROFILE=$PROFILE sh scripts/verify-host.sh" >&2
    exit 2
  }
fi

echo "-- 2/5 install the plugin from this working tree"
"$DSH_BIN" plugin --profile "$PROFILE" add "file:$REPO_ROOT" >/dev/null 2>&1

echo "-- 3/5 boot"
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

# A dead bundle entry is reported on stderr but does NOT stop the host, so it has
# to be asserted explicitly: without this the loop would pass with the plugin
# inactive.
if grep -q "did not activate" "$BOOT_LOG"; then
  echo "FAIL: the host booted with an inactive entry:" >&2
  grep -A2 -B2 "did not activate" "$BOOT_LOG" >&2
  exit 1
fi

echo "-- 4/5 probe /health"
curl -sS -c "$COOKIE_JAR" -L -o /dev/null "http://127.0.0.1:$PORT/?token=$TOKEN"
curl -sS -b "$COOKIE_JAR" "http://127.0.0.1:$PORT/api/dsh-reclaim/health" -o "$VERIFY_HOME.health.json"

node -e '
  const fs = require("node:fs")
  const file = process.argv[1]
  let payload
  try {
    payload = JSON.parse(fs.readFileSync(file, "utf8"))
  } catch (cause) {
    console.error("FAIL: /health did not return JSON:", cause.message)
    process.exit(1)
  }
  const capabilities = payload.capabilities
  if (payload.ok !== true || !capabilities || capabilities.ok !== true) {
    console.error("FAIL: capabilities are not green:", JSON.stringify(capabilities))
    process.exit(1)
  }
  if (capabilities.missing.length !== 0) {
    console.error("FAIL: missing host capabilities:", capabilities.missing.join(", "))
    process.exit(1)
  }
  const images = (payload.families ?? []).find((family) => family.id === "request-images")
  console.log("   capabilities  : " + capabilities.checks.length + " present, 0 missing")
  console.log("   request-images: " + (images?.layout?.selected ?? "?") + " → " + (images?.path ?? "?"))
  // Printed precisely: `?? "?"` renders both `null` and a missing key as "?",
  // which reads like "unknown" on a line that is asserting they are known.
  console.log("   dshCachePath  : exported=" + String(images?.layout?.dshCachePathExported) +
              " anomaly=" + (images?.layout === undefined || !("anomaly" in images.layout)
                ? "(absent)"
                : JSON.stringify(images.layout.anomaly)))

  // The layout values above used to be printed and never checked, which made
  // this loop pass while showing a regressed value: `ok` and `capabilities` are
  // produced by the backend check, not by the path resolution, so a layout
  // regression could not turn either of them red. They are asserted here
  // because this is the ONLY place the real `@deepseek-ai/dsh-home-paths`
  // supplies them — the unit tests map that specifier to a double
  // (`test/hooks/peer-shim.mjs`), so nothing else can catch a divergence.
  if (images === undefined) {
    console.error("FAIL: /health reported no request-images family; families were:", JSON.stringify((payload.families ?? []).map((family) => family.id)))
    process.exit(1)
  }
  // A fresh home created by this script has no legacy leftovers, so the
  // authoritative location is the `cache` one and there is nothing to flag. Both
  // assertions are therefore exact rather than "non-null".
  if (images.layout?.selected !== "cache") {
    console.error("FAIL: request-images resolved to the", JSON.stringify(images.layout?.selected), "candidate, not `cache`; layout was", JSON.stringify(images.layout))
    process.exit(1)
  }
  if (images.layout?.dshCachePathExported !== true) {
    console.error("FAIL: dsh-home-paths no longer exports dshCachePath, so the plugin fell back to a guessed path; layout was", JSON.stringify(images.layout))
    process.exit(1)
  }
  if (images.layout?.anomaly !== null) {
    console.error("FAIL: request-images reported an anomaly in a freshly created home:", JSON.stringify(images.layout.anomaly))
    process.exit(1)
  }
' "$VERIFY_HOME.health.json"

echo "PASS: the plugin mounted on the real host and every capability it needs is present."

echo "-- 5/5 clear a rebuildable cache family and restore it"
node "$REPO_ROOT/scripts/verify-clear.mjs" --port "$PORT" --jar "$COOKIE_JAR"

cleanup
HOST_PID=

if [ "$KEEP_HOME" = "1" ]; then
  echo "kept: $VERIFY_HOME (reusable — point DSH_HOME at it for other plugins)"
else
  rm -rf "$VERIFY_HOME"
fi
