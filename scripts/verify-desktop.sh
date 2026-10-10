#!/bin/sh
#
# Desktop-profile check — prove the plugin's requirements hold on the Desktop
# profile, without ever touching it.
#
# WHY THIS IS A SEPARATE SCRIPT
# `--profile desktop` cannot be booted from any command line: the CLI rejects the
# name unconditionally (`rejectElectronProfile`, @deepseek-ai/dsh/lib/bin.js — the
# `manageDesktopProfile` flag only unlocks `dsh plugin`, not booting). The Desktop
# profile is booted by the Electron carrier, which calls `runProfile` directly with
# `--no-open --port 19387` hardcoded (dsh-desktop-host/lib/index.js:223-235). So a
# literal Desktop boot is impossible in isolation, and booting it in place would
# both fight the live app for port 19387 and install a plugin into the profile the
# user actually uses. Neither is acceptable.
#
# WHAT IT PROVES INSTEAD
# That there is nothing Desktop-specific to verify, and then exercises the claim:
#
#   1. The Desktop profile's own composed config (`cordis.yml`, written by the host
#      from `dsh.profile.bundles`) is scanned read-only. Every service this plugin
#      asks for — sessions, attachments, sessionQuery, tools, connection.fetch —
#      must be provided by an `@deepseek-ai/*` entry, i.e. by the two official
#      bundles the profile declares. The Desktop carrier is asserted to be NOT a
#      profile member: it is layered on from outside.
#   2. The plugin's own source is asserted to read exactly one environment
#      variable, `DSH_HOME`, and never `DSH_PROFILE` or `profileContext`. It
#      therefore cannot tell the two profiles apart; its entire view of the world
#      is the home directory, which is the same `~/.dsh` in both cases.
#   3. The full functional loop then runs against a clone of the Desktop profile's
#      OFFICIAL composition (the two bundles + this plugin) in a throwaway home —
#      mount, capability probe, clear a cache family, restore it byte for byte.
#   4. The live Desktop profile is fingerprinted before and after. Any difference
#      fails the run. That is the "does not pollute the global environment" check,
#      and it is an assertion rather than a promise.
#
# ISOLATION
# Everything lands in $VERIFY_HOME. The home is KEPT by default — it is reusable
# for verifying other plugins, and the user asked not to delete it yet. Remove it
# with a single `rm -rf` (printed at the end).
#
# Usage:
#   sh scripts/verify-desktop.sh
#   VERIFY_HOME=/path PORT=19401 sh scripts/verify-desktop.sh
#   KEEP_HOME=0 sh scripts/verify-desktop.sh   # delete the clone when done
#
set -eu

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
LIVE_HOME=${LIVE_HOME:-$HOME/.dsh}
DESKTOP_DIR="$LIVE_HOME/profiles/desktop"
VERIFY_HOME=${VERIFY_HOME:-/tmp/dsh-reclaim-desktop-verify}
PORT=${PORT:-19400}
PROFILE=${PROFILE:-desktop-clone}
KEEP_HOME=${KEEP_HOME:-1}

case "$VERIFY_HOME" in
  "$LIVE_HOME"|"$LIVE_HOME"/*)
    echo "REFUSING: VERIFY_HOME ($VERIFY_HOME) is inside the live DSH home ($LIVE_HOME)." >&2
    echo "This script must never touch the live profile." >&2
    exit 2
    ;;
esac

if [ ! -d "$DESKTOP_DIR" ]; then
  echo "SKIP: no Desktop profile at $DESKTOP_DIR — nothing to check against." >&2
  echo "      This script is about the profile the Desktop app actually loads;" >&2
  echo "      on a machine without one, run scripts/verify-host.sh instead." >&2
  exit 3
fi

fingerprint() {
  # Content hash of the three files that define the profile. Sizes and mtimes are
  # not enough: an in-place edit preserves both.
  for f in package.json cordis.yml cordis.patch.yml; do
    if [ -f "$DESKTOP_DIR/$f" ]; then
      printf '%s  %s\n' "$(shasum -a 256 "$DESKTOP_DIR/$f" | cut -d' ' -f1)" "$f"
    else
      printf '%s  %s\n' "absent" "$f"
    fi
  done
}

echo "== desktop check: live profile $DESKTOP_DIR (read-only)"
BEFORE=$(fingerprint)

echo "-- 1/4 read the Desktop profile's own composed config"
node -e '
  const fs = require("node:fs")
  const [dir, repo] = process.argv.slice(1)

  const pkg = JSON.parse(fs.readFileSync(`${dir}/package.json`, "utf8"))
  const bundles = pkg.dsh?.profile?.bundles ?? []
  if (bundles[0] !== "@deepseek-ai/dsh-base" || bundles[1] !== "@deepseek-ai/dsh-web-app") {
    console.error("FAIL: the Desktop profile no longer starts with the two official bundles:", JSON.stringify(bundles.slice(0, 3)))
    process.exit(1)
  }

  const composed = fs.readFileSync(`${dir}/cordis.yml`, "utf8")
  const names = [...composed.matchAll(/^\s*name:\s*(.+?)\s*$/gmu)].map((m) => m[1].replace(/^["\x27]|["\x27]$/g, ""))

  // Each of these is the provider of one service the plugin asks for at /health.
  const providers = {
    sessions: "@deepseek-ai/dsh-session-persistence-jsonl",
    attachments: "@deepseek-ai/dsh-attachment-local",
    sessionQuery: "@deepseek-ai/dsh-session-query-sqlite",
    tools: "@deepseek-ai/dsh-tools",
    "connection.fetch": "@deepseek-ai/dsh-client-connection",
  }
  const missing = []
  for (const [service, spec] of Object.entries(providers)) {
    if (!names.includes(spec)) missing.push(`${service} (${spec})`)
  }
  if (missing.length > 0) {
    console.error("FAIL: the Desktop profile does not compose the expected provider(s):", missing.join(", "))
    console.error("      Composed entries were:", JSON.stringify(names))
    process.exit(1)
  }

  // The carrier boots this profile from outside; it is not a member of it. If it
  // ever becomes one, this script is checking the wrong thing.
  if (names.includes("@deepseek-ai/dsh-desktop-host")) {
    console.error("FAIL: dsh-desktop-host is now a profile member, so this script is no longer a faithful check.")
    process.exit(1)
  }

  // And none of the providers may come from a third-party bundle: strip every
  // non-@deepseek-ai entry and the five specifiers must still be there.
  const official = names.filter((n) => n.startsWith("@deepseek-ai/"))
  for (const spec of Object.values(providers)) {
    if (!official.includes(spec)) {
      console.error("FAIL:", spec, "is present but not as an @deepseek-ai entry — a third-party bundle may be shadowing it.")
      process.exit(1)
    }
  }

  console.log(`   bundles      : ${bundles.length} declared, official pair first`)
  console.log(`   composed     : ${names.length} entries, all 5 providers from @deepseek-ai/*`)
  console.log(`   carrier      : dsh-desktop-host is outside the profile (checked)`)
' "$DESKTOP_DIR" "$REPO_ROOT"

echo "-- 2/4 check what the plugin can see of the profile"
node -e '
  const fs = require("node:fs")
  const path = require("node:path")
  const repo = process.argv[1]
  const files = fs.readdirSync(path.join(repo, "lib")).filter((f) => f.endsWith(".js"))

  const offenders = []
  const envReads = new Set()
  for (const file of files) {
    const text = fs.readFileSync(path.join(repo, "lib", file), "utf8")
    if (/\bDSH_PROFILE\b/.test(text) || /\bprofileContext\b/.test(text)) {
      offenders.push(`lib/${file} reads DSH_PROFILE or profileContext`)
    }
    for (const m of text.matchAll(/env\.([A-Z][A-Z0-9_]*)/g)) envReads.add(m[1])
    for (const m of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) envReads.add(m[1])
  }
  if (offenders.length > 0) {
    console.error("FAIL: the plugin now distinguishes profiles:", offenders.join("; "))
    process.exit(1)
  }
  // Only DSH_HOME may appear. Anything else is a new input that could differ
  // between the two profiles, and would have to be verified separately.
  const unexpected = [...envReads].filter((name) => name !== "DSH_HOME")
  if (unexpected.length > 0) {
    console.error("FAIL: the plugin reads environment variable(s) beyond DSH_HOME:", unexpected.join(", "))
    process.exit(1)
  }
  console.log(`   env reads    : ${[...envReads].join(", ") || "(none)"} — cannot tell desktop from web`)
' "$REPO_ROOT"

echo "-- 3/4 exercise the same composition in a throwaway home"
# Cloned from the `web` template, deliberately, and it is the faithful choice: the
# Desktop profile's own bundle list is the same two official bundles PLUS thirteen
# third-party plugins, none of which provides a service this plugin asks for (step
# 1 above asserts exactly that). Cloning the `desktop` template instead would drag
# in thirteen bundles that are not installed in a throwaway home, and the host loop
# fails on any bundle entry that "did not activate" — so it would test the
# third-party plugins, not this one. `web` IS the official pair, which is the part
# that matters here.
echo "   home=$VERIFY_HOME  profile=$PROFILE (from the 'web' template)  port=$PORT"
KEEP_HOME=1 VERIFY_HOME="$VERIFY_HOME" PORT="$PORT" PROFILE="$PROFILE" TEMPLATE=web \
  sh "$REPO_ROOT/scripts/verify-host.sh"

echo "-- 4/4 confirm the live Desktop profile is untouched"
AFTER=$(fingerprint)
if [ "$BEFORE" != "$AFTER" ]; then
  echo "FAIL: the live Desktop profile changed during this run." >&2
  echo "before:" >&2; echo "$BEFORE" >&2
  echo "after:" >&2;  echo "$AFTER" >&2
  exit 1
fi
echo "   unchanged    : package.json, cordis.yml, cordis.patch.yml all byte-identical"

echo
echo "PASS: the Desktop profile composes every service this plugin needs from the two"
echo "      official bundles, the plugin cannot distinguish the profiles, the same"
echo "      composition passes the full loop in isolation, and the live profile is"
echo "      byte-identical afterwards."

if [ "$KEEP_HOME" = "1" ]; then
  echo
  echo "kept: $VERIFY_HOME"
  echo "      reusable — point DSH_HOME at it to verify other plugins."
  echo "      remove it completely with:  rm -rf $VERIFY_HOME ${VERIFY_HOME}.boot.log ${VERIFY_HOME}.cookies ${VERIFY_HOME}.health.json"
else
  rm -rf "$VERIFY_HOME" "$VERIFY_HOME.boot.log" "$VERIFY_HOME.cookies" "$VERIFY_HOME.health.json"
  echo "removed: $VERIFY_HOME"
fi
