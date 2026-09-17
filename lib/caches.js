/**
 * dsh-reclaim — rebuildable caches.
 *
 * Three kinds, all of them safe to clear in principle because the host can
 * rebuild them, and none of them dependent on the reference graph:
 *
 *   1. derived request images (`request-images` family)
 *   2. orphaned session projection caches
 *      (`<home>/storages/session_projcache/sessions/<id>.json`)
 *   3. staging leftovers (`tmp` family)
 *
 * Two rules this module exists to enforce:
 *
 * **Never re-derive the request-image path.** It is consumed from the
 * asset-location layer (`layout.families[request-images].path`, decided by
 * that layer's contract gate). Deriving it a second time here would
 * reintroduce the silent path switch that gate exists to prevent.
 *
 * **Never guess a session list.** Orphan detection takes an explicit,
 * injected session-id source. When the source is unavailable, orphan detection
 * is DISABLED with a reason: a cache file must never be called an orphan
 * because we could not obtain the list that would have claimed it.
 *
 * Read-only: everything here measures and compares. Nothing is deleted.
 */

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Default `storage-json` layout of the session projection cache. */
export const PROJECTION_CACHE_SEGMENTS = Object.freeze(['storages', 'session_projcache', 'sessions'])

/**
 * Visible statement of the one assumption behind projection-cache orphans.
 * `ctx.storage` exposes a backend registry and data forms but no root path
 * (`dsh-storage/lib/types/index.d.ts`), so the location can only come from the
 * documented default layout.
 */
export const PROJECTION_CACHE_LAYOUT_CAVEAT =
  'orphaned projection caches are determined from the default storage-json layout ' +
  '(<home>/storages/session_projcache/sessions). A host that relocated storage-json.root is ' +
  'not covered by this check, because the storage service exposes no root path.'

/**
 * Session ids are compared with the `session-` prefix removed on BOTH sides.
 *
 * Measured on this machine: `storages/session_projcache/sessions/` holds both
 * `<uuid>.json` and `session-<uuid>.json`, while session directories are always
 * `session-<uuid>` (measured on a real installation). Normalization can only ever claim MORE cache
 * files as live, i.e. produce FEWER orphans — the safe direction for a check
 * whose mistakes would authorize deletion.
 */
export function normalizeSessionId(id) {
  return String(id).replace(/^session-/, '')
}

/** Build the available/unavailable shape orphan detection consumes. */
export function sessionIdsFrom(ids) {
  const list = ids instanceof Set ? [...ids] : [...(ids ?? [])]
  return { available: true, ids: list, reason: null }
}

/** Explicit "we could not obtain the list" — never silently the same as empty. */
export function sessionIdsUnavailable(reason) {
  return { available: false, ids: [], reason }
}

function describeCause(cause) {
  if (cause === null || cause === undefined) return String(cause)
  const name = cause.name ?? 'Error'
  const message = cause.message ?? String(cause)
  const code = cause.code === undefined ? '' : ` (code ${String(cause.code)})`
  return `${name}: ${message}${code}`
}

function statOrNull(path) {
  try {
    return statSync(path)
  } catch (cause) {
    return { error: describeCause(cause), code: cause?.code ?? null }
  }
}

/**
 * Segment 1 — derived request images.
 *
 * Measurement is CONSUMED from the attachment scan, never recomputed here, so
 * the two views of the same directory can never disagree.
 *
 * @param {object} attachments - result of `scanAttachments()`
 */
export function describeDerivedRequestImages(attachments) {
  const family = (attachments?.families ?? []).find((entry) => entry.id === 'request-images')
  if (family === undefined) {
    return {
      kind: 'derived-request-images',
      available: false,
      reason: 'the attachment scan did not report a request-images family',
      regenerable: true,
    }
  }
  return {
    kind: 'derived-request-images',
    available: family.enumerated,
    reason: family.reason,
    regenerable: true,
    path: family.path,
    layout: attachments.requestImagesLayout,
    files: family.files,
    bytes: family.bytes,
  }
}

/**
 * Segment 3 — staging leftovers in `tmp/`.
 *
 * The host stages writes there and publishes with an atomic hard link, so a
 * file left behind means an interrupted write. Reported with names and sizes;
 * acting on them is out of scope for this module.
 *
 * @param {object} attachments - result of `scanAttachments()`
 * @param {object} [options]
 * @param {number} [options.maxEntries=50] - cap on listed names (counts are exact)
 */
export function describeStagingLeftovers(attachments, options = {}) {
  const maxEntries = options.maxEntries ?? 50
  const family = (attachments?.families ?? []).find((entry) => entry.id === 'tmp')
  if (family === undefined) {
    return {
      kind: 'staging-leftovers',
      available: false,
      reason: 'the attachment scan did not report a tmp family',
      regenerable: true,
      path: null,
      files: 0,
      bytes: 0,
      nonFileEntries: 0,
      listedEntries: 0,
      truncated: false,
      entries: [],
    }
  }

  const entries = []
  let otherEntries = 0
  if (family.enumerated && family.exists) {
    try {
      for (const entry of readdirSync(family.path, { withFileTypes: true })) {
        if (!entry.isFile()) {
          otherEntries += 1
          continue
        }
        const full = join(family.path, entry.name)
        const info = statOrNull(full)
        if (info.error !== undefined) continue
        entries.push({ name: entry.name, path: full, bytes: info.size })
      }
    } catch (cause) {
      return {
        kind: 'staging-leftovers',
        available: false,
        reason: `could not list the staging directory: ${describeCause(cause)}`,
        regenerable: true,
        path: family.path,
        files: family.files,
        bytes: family.bytes,
        nonFileEntries: otherEntries,
        listedEntries: 0,
        truncated: false,
        entries: [],
      }
    }
  }

  entries.sort((left, right) => right.bytes - left.bytes)
  return {
    kind: 'staging-leftovers',
    available: family.enumerated,
    reason: family.reason,
    regenerable: true,
    path: family.path,
    files: family.files,
    bytes: family.bytes,
    nonFileEntries: otherEntries,
    listedEntries: entries.length,
    truncated: entries.length > maxEntries,
    entries: entries.slice(0, maxEntries),
  }
}

/**
 * Segment 2 — orphaned session projection caches.
 *
 * @param {object} layout - from `resolveLayout()`
 * @param {{ available: boolean, ids: string[], reason: string|null }} sessionIds
 *   - from {@link sessionIdsFrom} / {@link sessionIdsUnavailable}. When
 *   `available` is false the check is DISABLED and the reason is reported; no
 *   file is classified.
 * @param {object} [options]
 * @param {string} [options.root] - explicit override for tests
 * @param {number} [options.maxEntries=50]
 */
export function findOrphanProjectionCaches(layout, sessionIds, options = {}) {
  const root = options.root ?? join(layout.home, ...PROJECTION_CACHE_SEGMENTS)
  const maxEntries = options.maxEntries ?? 50
  const report = {
    kind: 'orphan-projection-cache',
    regenerable: true,
    root,
    caveat: PROJECTION_CACHE_LAYOUT_CAVEAT,
    enabled: sessionIds?.available === true,
    reason: sessionIds?.available === true ? null : (sessionIds?.reason ?? 'no session-id source was supplied'),
    sessionIdCount: sessionIds?.available === true ? sessionIds.ids.length : null,
    scannedFiles: 0,
    scannedBytes: 0,
    orphans: [],
    orphanBytes: 0,
    orphansTruncated: false,
    unexpectedEntries: [],
    uncertain: [],
  }

  const rootInfo = statOrNull(root)
  if (rootInfo.error !== undefined) {
    report.enabled = false
    report.reason = rootInfo.code === 'ENOENT'
      ? 'the projection-cache directory does not exist on this host, so there is nothing to classify'
      : `the projection-cache directory could not be inspected: ${rootInfo.error}`
    return report
  }
  if (!rootInfo.isDirectory()) {
    report.enabled = false
    report.reason = 'the projection-cache directory does not exist on this host'
    return report
  }

  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch (cause) {
    report.enabled = false
    report.reason = `could not list the projection-cache directory: ${describeCause(cause)}`
    return report
  }

  const live = report.enabled
    ? new Set((sessionIds.ids ?? []).map((id) => normalizeSessionId(id)))
    : null

  for (const entry of entries) {
    const full = join(root, entry.name)
    const info = statOrNull(full)
    if (info.error !== undefined) {
      report.uncertain.push({ path: full, reason: `stat failed: ${info.error}` })
      continue
    }
    if (!info.isFile()) {
      report.unexpectedEntries.push({
        path: full,
        kind: 'non-file',
        reason: 'the projection cache stores one <session-id>.json file per session; this entry is not a regular file',
      })
      continue
    }
    report.scannedFiles += 1
    report.scannedBytes += info.size

    if (!entry.name.endsWith('.json')) {
      report.unexpectedEntries.push({
        path: full,
        kind: 'unexpected-name',
        bytes: info.size,
        reason: 'the projection cache stores <session-id>.json; this file has another extension and is not classified',
      })
      continue
    }
    if (live === null) continue

    const id = entry.name.slice(0, -'.json'.length)
    if (!live.has(normalizeSessionId(id))) {
      report.orphans.push({
        path: full,
        id,
        normalizedId: normalizeSessionId(id),
        bytes: info.size,
        regenerable: true,
        note: 'no live session claims this projection cache under the normalized session-id comparison',
      })
    }
  }

  report.orphans.sort((left, right) => right.bytes - left.bytes)
  report.orphanBytes = report.orphans.reduce((sum, orphan) => sum + orphan.bytes, 0)
  report.orphansTruncated = report.orphans.length > maxEntries
  report.orphans = report.orphans.slice(0, maxEntries)
  return report
}

/**
 * Assemble the cache section of the attachment report.
 *
 * @param {object} options
 * @param {object} options.layout
 * @param {object} options.attachments - result of `scanAttachments()`
 * @param {object} options.sessionIds - see {@link findOrphanProjectionCaches}
 * @param {object} [options.projectionCacheRoot] - test override
 */
export function buildCacheReport({ layout, attachments, sessionIds, projectionCacheRoot }) {
  const derivedRequestImages = describeDerivedRequestImages(attachments)
  const orphanProjectionCaches = findOrphanProjectionCaches(layout, sessionIds, {
    root: projectionCacheRoot,
  })
  const stagingLeftovers = describeStagingLeftovers(attachments)

  return {
    derivedRequestImages,
    orphanProjectionCaches,
    stagingLeftovers,
    regenerableBytes:
      (derivedRequestImages.bytes ?? 0) +
      (orphanProjectionCaches.orphanBytes ?? 0) +
      (stagingLeftovers.bytes ?? 0),
    notes: [
      'request-image bytes are CONSUMED from the attachment scan (single measurement, no second derivation)',
      'file-objects / files expose no cleanup entry, so they are absent from this section by design',
    ],
  }
}
