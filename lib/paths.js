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
 * This layer is pure path math plus read-only existence probes: it writes
 * nothing and interprets nothing.
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
 * there are no real-world samples to define cleanup rules against.
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
    nature: 'canonical bytes of generic files (report-only)',
  },
  {
    id: 'files',
    segments: ['attachments', 'v1', 'files'],
    nature: 'read-only hardlink references into file-objects (report-only)',
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
    for (const attempt of [
      () => namespace.dshCachePath(join('attachments', 'request-images')),
      () => namespace.dshCachePath(),
    ]) {
      try {
        const value = attempt()
        if (typeof value === 'string' && value !== '' && isAbsolute(value)) {
          dshCachePathResolved = value
          break
        }
        dshCachePathError = `dshCachePath() returned a non-absolute value: ${typeof value}`
      } catch (cause) {
        dshCachePathError = `${cause?.name ?? 'Error'}: ${cause?.message ?? String(cause)}`
      }
    }
  }

  let selected
  let reason
  if (hasDshCachePath) {
    selected = 'cache'
    reason =
      'dshCachePath is exported by the running dsh-home-paths, so the host ' +
      'maintains the cache/attachments/request-images layout'
  } else {
    selected = 'legacy'
    reason =
      'dshCachePath is NOT exported by the running dsh-home-paths (pre-cache ' +
      'host build), so the host writes attachments/v1/request-images'
  }

  const selectedPath = selected === 'cache'
    ? (dshCachePathResolved ?? byId.get('cache').path)
    : byId.get('legacy').path

  // Drift anomaly: the selected layout's directory is missing while the other
  // one exists. Harmless for path resolution, but it must be surfaced.
  let anomaly = null
  const selectedCandidate = byId.get(selected)
  const otherCandidate = byId.get(selected === 'cache' ? 'legacy' : 'cache')
  if (!selectedCandidate.exists && otherCandidate.exists) {
    anomaly =
      `the selected layout directory (${selectedCandidate.path}) does not exist ` +
      `while the other candidate (${otherCandidate.path}) does — the stale one ` +
      'likely comes from a different host version; investigate before clearing'
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
 * @param {{ trash: { root: string } }} layout - from {@link resolveLayout}
 * @returns {(candidatePath: string) => Promise<boolean>}
 */
export function makeIsInsideTrash(layout) {
  const trashRoot = layout.trash.root
  return async function isInsideTrash(candidatePath) {
    const [canonicalTarget, canonicalRoot] = await Promise.all([
      canonicalizeWatchPath(candidatePath),
      canonicalizeWatchPath(trashRoot),
    ])
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
