/**
 * dsh-reclaim — asset-location layer.
 *
 * Single place that knows WHERE everything lives:
 *   - the DSH home root (always through the official helpers, never hardcoded)
 *   - the attachment family directories under `<home>/attachments/v1/`
 *   - the request-image cache, whose location DRIFTED between host versions
 *     (dual layout + feature detection, never hardcoded to one of them)
 *   - the plugin's own recoverable trash directory
 *   - the "is this path inside the trash" test used to keep the plugin from
 *     ever scanning (and later: re-trashing) its own quarantine
 *
 * Layout facts come from the official `@deepseek-ai/dsh-attachment-local`
 * package documentation:
 *   - `objects/`      content-addressed originals, never auto-deleted
 *   - `file-objects/` canonical bytes of generic files
 *   - `files/`        read-only hardlink references into `file-objects/`
 *   - `request-images/` derived (regenerable) request-sized variants —
 *       `< 0.1.5`: `<home>/attachments/v1/request-images/`
 *       newer:     `<home>/cache/attachments/request-images/`, resolved by
 *                  a `dshCachePath` helper that older `dsh-home-paths`
 *                  releases do not export (feature-detected below)
 *   - `tmp/`          staging area for atomic writes
 *
 * This layer is pure path math + read-only existence probes. It writes nothing
 * and interprets nothing: it resolves where assets live, and never enumerates
 * their contents.
 */

import { existsSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import * as officialHomePaths from '@deepseek-ai/dsh-home-paths'

const { canonicalizeWatchPath, dshHomeDisplay, resolveDshHome } = officialHomePaths

/** Directory name of the plugin's quarantine inside the DSH home. */
export const TRASH_DIR_NAME = '.dsh-reclaim-trash'

/**
 * The attachment family directories, in the order they are reported.
 *
 * `request-images` has no fixed segments — its location is decided by
 * {@link detectRequestImagesLayout} because it moved between host versions.
 * `file-objects` and `files` are one logical family (generic file storage)
 * split into two directories by the official backend; both are report-only:
 * they are measured, and no cleanup is offered for them.
 */
const FAMILY_DEFS = [
  {
    id: 'objects',
    segments: ['attachments', 'v1', 'objects'],
    nature: 'originals, content-addressed, never auto-deleted by the host',
  },
  {
    id: 'file-objects',
    segments: ['attachments', 'v1', 'file-objects'],
    nature: 'canonical bytes of generic files (report-only: no cleanup is offered)',
  },
  {
    id: 'files',
    segments: ['attachments', 'v1', 'files'],
    nature: 'read-only hardlink references into file-objects (report-only: no cleanup is offered)',
  },
  {
    id: 'request-images',
    segments: null,
    nature: 'derived request-image cache, regenerable by the host',
  },
  {
    id: 'tmp',
    segments: ['attachments', 'v1', 'tmp'],
    nature: 'staging area for atomic writes',
  },
]

/**
 * Detect which request-image layout the RUNNING host maintains.
 *
 * Selection follows the running host's writer, not mere directory existence:
 * a host old enough to lack `dshCachePath` cannot be the one writing a
 * `cache/` tree, so a stale `cache/` directory from another version must not
 * win. Existence of BOTH candidates is always reported as evidence either
 * way, so a drift anomaly is visible instead of silent.
 *
 * A `dshCachePath` export is trusted only when its resolved value stays
 * under `<home>/cache` — the documented contract of the newer layout. Any
 * other value is REFUSED (otherwise the plugin would silently follow the
 * request-image cache to an unexpected location the day the host upgrades)
 * and the detection degrades to the legacy layout with an anomaly on record.
 * A contract-valid value is adopted AS the cache location — the host's
 * resolver is authoritative about its own layout — and when it differs from
 * the documented `cache/attachments/request-images` candidate, that drift is
 * surfaced as an anomaly instead of being silently swallowed.
 *
 * @param {string} home - resolved DSH home
 * @param {object} [homePathsNs] - the `@deepseek-ai/dsh-home-paths` namespace;
 *   injectable so tests can pin the feature detection
 * @returns {{
 *   selected: 'legacy' | 'cache',
 *   selectedPath: string,
 *   reason: string,
 *   dshCachePathExported: boolean,
 *   dshCachePathResolved: string | null,
 *   dshCachePathError: string | null,
 *   candidates: Array<{ id: string, path: string, exists: boolean }>,
 *   anomaly: string | null,
 * }}
 */
export function detectRequestImagesLayout(home, homePathsNs) {
  const namespace = homePathsNs ?? officialHomePaths
  const legacyPath = join(home, 'attachments', 'v1', 'request-images')
  const cachePath = join(home, 'cache', 'attachments', 'request-images')
  const cacheRoot = join(home, 'cache')
  const candidates = [
    { id: 'cache', path: cachePath, exists: existsSync(cachePath) },
    { id: 'legacy', path: legacyPath, exists: existsSync(legacyPath) },
  ]
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]))

  const hasDshCachePath = typeof namespace.dshCachePath === 'function'
  let dshCachePathResolved = null
  let dshCachePathError = null

  if (hasDshCachePath) {
    // The exact signature of dshCachePath is not observable on hosts that
    // ship it (this machine's build predates the export), so try the two
    // plausible call shapes defensively and accept only an absolute path.
    const attemptErrors = []
    for (const attempt of [
      () => namespace.dshCachePath(join('attachments', 'request-images')),
      () => namespace.dshCachePath(),
    ]) {
      try {
        const value = attempt()
        if (typeof value === 'string' && value !== '' && isAbsolute(value)) {
          dshCachePathResolved = value
          // A later successful attempt must clear the earlier failure: a stale
          // error string left on a SUCCESSFUL resolution reads as if the host
          // were broken (found in review, 2026-09-17).
          dshCachePathError = null
          break
        }
        attemptErrors.push(`dshCachePath() returned a non-absolute value: ${typeof value}`)
      } catch (cause) {
        attemptErrors.push(`${cause?.name ?? 'Error'}: ${cause?.message ?? String(cause)}`)
      }
    }
    if (dshCachePathResolved === null && attemptErrors.length > 0) {
      dshCachePathError = attemptErrors.join(' | ')
    }
    // Layout-contract check: the newer layout lives under <home>/cache. A
    // value anywhere else is refused rather than followed.
    if (dshCachePathResolved !== null && !isUnder(cacheRoot, dshCachePathResolved)) {
      dshCachePathError =
        `dshCachePath() resolved ${dshCachePathResolved}, which is not under ` +
        `${cacheRoot} — refusing to follow it (layout contract violation)`
      dshCachePathResolved = null
    }
  }

  const cacheUnusable = hasDshCachePath && dshCachePathResolved === null
  let selected
  let reason
  if (hasDshCachePath && !cacheUnusable) {
    selected = 'cache'
    reason =
      'dshCachePath is exported by the running dsh-home-paths and resolved ' +
      'under <home>/cache, so its value is the authoritative request-image ' +
      'cache location and is adopted as-is'
  } else {
    selected = 'legacy'
    reason = cacheUnusable
      ? 'dshCachePath is exported but its resolved value violated the ' +
        '<home>/cache contract, so the plugin refuses it and falls back to ' +
        'attachments/v1/request-images until the host behavior is re-verified'
      : 'dshCachePath is NOT exported by the running dsh-home-paths (pre-cache ' +
        'host build), so the host writes attachments/v1/request-images'
  }

  // The gate verifies the resolved value's HOME (under <home>/cache); once it
  // passes, the VALUE itself is kept — the host's resolver is authoritative
  // about its own layout, and discarding it here would silently scan the
  // documented path while the host moved on (the exact drift this layer must
  // not commit).
  const selectedPath = selected === 'cache'
    ? dshCachePathResolved
    : byId.get('legacy').path

  // Drift anomalies: anything that "works" but does not match expectations
  // must be surfaced, never silently swallowed.
  let anomaly = null
  const otherCandidate = byId.get(selected === 'cache' ? 'legacy' : 'cache')
  if (cacheUnusable) {
    anomaly = dshCachePathError
  } else if (selected === 'cache' && dshCachePathResolved !== byId.get('cache').path) {
    anomaly =
      `dshCachePath resolved ${dshCachePathResolved}, which differs from the ` +
      `documented cache layout (${byId.get('cache').path}) — following the ` +
      'host resolver; refresh the documented candidate when convenient'
  }
  if (anomaly === null) {
    const selectedExists = existsSync(selectedPath)
    if (!selectedExists && otherCandidate.exists) {
      anomaly =
        `the selected layout directory (${selectedPath}) does not exist ` +
        `while the other candidate (${otherCandidate.path}) does — the stale one ` +
        'likely comes from a different host version; investigate before clearing'
    }
  }

  return {
    selected,
    selectedPath,
    reason,
    dshCachePathExported: hasDshCachePath,
    dshCachePathResolved,
    dshCachePathError,
    candidates,
    anomaly,
  }
}

/**
 * True when `candidate` is strictly INSIDE `root` (the root itself does not
 * count). Lexical, NOT realpath-grade: this gate compares two paths the host's
 * own resolver produced (a home-derived root and a `dshCachePath` value), so
 * on-disk identity is irrelevant and touching the filesystem here would buy
 * nothing. It uses `path.relative` with a proper parent-traversal check, which
 * is what stops sibling names sharing a prefix (`<root>-evil`) and drive
 * changes from fooling it. The realpath-grade comparison lives in
 * {@link makeIsInsideTrash}, where identities do matter.
 */
function isUnder(root, candidate) {
  const rel = relative(root, candidate)
  if (rel === '' || isAbsolute(rel)) return false
  return rel !== '..' && !rel.startsWith(`..${sep}`)
}

/**
 * Resolve every location this plugin reasons about.
 *
 * @param {object} [options]
 * @param {string} [options.configuredHome] - explicit home override; mirrors
 *   the highest-precedence argument of the official `resolveDshHome()`
 * @param {Record<string, string | undefined>} [options.env] - environment
 *   mapping used for `$DSH_HOME`; defaults to `process.env`
 * @param {object} [options.homePaths] - namespace override for the
 *   `dshCachePath` feature detection; defaults to the real import
 * @returns {{
 *   home: string,
 *   homeDisplay: string,
 *   homeSource: 'configured-override' | 'env:DSH_HOME' | 'default:~/.dsh',
 *   attachmentsRoot: string,
 *   families: Array<{ id: string, path: string, exists: boolean, nature: string,
 *     layout?: object }>,
 *   trash: { root: string },
 * }}
 */
export function resolveLayout(options = {}) {
  const env = options.env ?? process.env
  const home = resolveDshHome(options.configuredHome, env)
  const envValue = env.DSH_HOME
  const homeSource = options.configuredHome !== undefined
    ? 'configured-override'
    : (typeof envValue === 'string' && envValue.trim() !== ''
        ? 'env:DSH_HOME'
        : 'default:~/.dsh')

  const requestImages = detectRequestImagesLayout(home, options.homePaths)

  const families = FAMILY_DEFS.map((def) => {
    const path = def.segments === null
      ? requestImages.selectedPath
      : join(home, ...def.segments)
    const family = {
      id: def.id,
      path,
      exists: existsSync(path),
      nature: def.nature,
    }
    if (def.id === 'request-images') family.layout = requestImages
    return family
  })

  return {
    home,
    homeDisplay: dshHomeDisplay(home),
    homeSource,
    attachmentsRoot: join(home, 'attachments'),
    families,
    trash: { root: join(home, TRASH_DIR_NAME) },
  }
}

/**
 * Build an `isInsideTrash` bound to a specific layout.
 *
 * The comparison canonicalizes BOTH sides through `realpath` (via the
 * official `canonicalizeWatchPath`, which also tolerates not-yet-existing
 * tail segments) and then compares with `path.relative`. A lexical string
 * prefix would be fooled by sibling directories sharing a name prefix and by
 * symlinks pointing elsewhere; the realpath form is not.
 *
 * The trash root itself counts as inside (it must be excluded from scans as
 * a whole). Paths on another drive are outside by construction.
 *
 * **Classification follows the physical location of the data, not the path
 * used to reach it.** A junction inside the trash pointing elsewhere
 * resolves to its real (outside) target and is therefore NOT inside; a
 * junction anywhere else pointing into the trash resolves to its real
 * (inside) target and IS inside. Both expectations are pinned by tests.
 *
 * **Error policy is fail-closed.** If `canonicalizeWatchPath` throws (a
 * non-ENOENT condition — permission, a file-shaped ancestor, …), the path is
 * treated as INSIDE the trash, i.e. excluded from scanning. For a scanner
 * this is the safe direction: an unreadable path is never mistaken for live
 * data, at the cost of possibly under-reporting it. The uncertainty is not
 * swallowed silently — pass `onUncertain` to observe it.
 *
 * The trash root's canonical form is resolved once, lazily, on the first
 * call (callers run this check per scan entry, and the
 * root never moves under a running host). A failed resolution is not
 * cached — the next call retries.
 *
 * @param {{ trash: { root: string } }} layout - from {@link resolveLayout}
 * @param {object} [options]
 * @param {(cause: unknown, candidatePath: string) => void} [options.onUncertain]
 *   - called when canonicalization fails and the fail-closed verdict is used
 * @returns {(candidatePath: string) => Promise<boolean>}
 */
export function makeIsInsideTrash(layout, options = {}) {
  const trashRoot = layout.trash.root
  const onUncertain = options.onUncertain
  let canonicalRootPromise = null

  const getCanonicalRoot = () => {
    canonicalRootPromise ??= canonicalizeWatchPath(trashRoot).catch((cause) => {
      // Do not cache failures: a transient error must not poison every
      // later verdict.
      canonicalRootPromise = null
      throw cause
    })
    return canonicalRootPromise
  }

  return async function isInsideTrash(candidatePath) {
    let canonicalTarget
    let canonicalRoot
    try {
      ;[canonicalTarget, canonicalRoot] = await Promise.all([
        canonicalizeWatchPath(candidatePath),
        getCanonicalRoot(),
      ])
    } catch (cause) {
      try {
        onUncertain?.(cause, candidatePath)
      } catch {
        /* a faulty observer must not change the verdict */
      }
      return true
    }
    const rel = relative(canonicalRoot, canonicalTarget)
    if (rel === '') return true
    if (isAbsolute(rel)) return false
    return rel !== '..' && !rel.startsWith(`..${sep}`)
  }
}

let defaultIsInsideTrash = null

/**
 * Default-bound trash test using the process-wide layout. The layout is
 * resolved once per process — `$DSH_HOME` does not change under a running
 * host, and re-probing on every call would buy nothing. Tests that need a
 * synthetic home use {@link makeIsInsideTrash} instead.
 *
 * @param {string} candidatePath
 * @returns {Promise<boolean>}
 */
export async function isInsideTrash(candidatePath) {
  defaultIsInsideTrash ??= makeIsInsideTrash(resolveLayout())
  return defaultIsInsideTrash(candidatePath)
}
