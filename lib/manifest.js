/**
 * dsh-reclaim — the batch manifest.
 *
 * The manifest is the reason a quarantine can be trusted instead of feared. It
 * lives INSIDE the batch directory, so the restore information travels with the
 * data: copy a batch to another disk and it is still restorable, with no side
 * table to lose.
 *
 * ## What it records, and why each field earns its place
 *
 *   - **`originalPath`** (absolute) and **`relativePath`** — the first is what a
 *     restore needs; the second is what a reviewer needs to see that the batch
 *     mirrors the original tree. They are checked against each other on read: a
 *     manifest whose relative path does not reproduce its absolute path is
 *     corrupt, and a corrupt manifest must not silently guide a restore.
 *   - **`risk`** — the tier and the reference evidence computed *before* the
 *     move. This is deliberate: the plugin's whole promise is "you were shown
 *     the evidence before anything happened", so the evidence is archived with
 *     the data rather than recomputed (recomputing it later would describe a
 *     state that no longer exists).
 *   - **`removedAt`**, `bytes`, `files`, `isDirectory` — the accounting a purge
 *     and a restore both need, measured at move time.
 *   - **no `status` for items that were never moved**: the manifest lists only
 *     what is actually in the batch. Items that could not be moved stay in place
 *     and are reported in the operation result, so the batch never implies it
 *     holds something it does not.
 *
 * ## The crash rule
 *
 * **The manifest is not written before the move.** A batch directory with
 * contents but no manifest therefore means exactly one thing: an operation was
 * interrupted. That is reported as an incomplete batch and listed for the user,
 * never auto-cleaned — auto-cleaning it would be the plugin deleting data on its
 * own.
 *
 * Read/write scope: one JSON file inside the batch directory.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

/** Filename inside the batch directory. */
export const MANIFEST_NAME = 'manifest.json'

/** Schema version; a manifest from another version is refused, not guessed at. */
export const MANIFEST_VERSION = 1

function describeCause(cause) {
  if (cause === null || cause === undefined) return String(cause)
  const name = cause?.name ?? 'Error'
  const message = cause?.message ?? String(cause)
  const code = cause?.code === undefined ? '' : ` (code ${String(cause.code)})`
  return `${name}: ${message}${code}`
}

/** The manifest path of a batch directory. */
export function manifestPath(batchDir) {
  return join(batchDir, MANIFEST_NAME)
}

/**
 * Build the manifest object for a batch.
 *
 * @param {object} options
 * @param {string} options.batchId
 * @param {string} [options.createdAt]
 * @param {readonly object[]} options.entries - already-moved items, with their
 *   measured size and the risk evidence captured before the move
 * @param {object} [options.sessionAccounting] - `{ detach: object|null }`, the
 *   workspace-sync result, so the record of what was touched is complete
 */
export function buildManifest(options) {
  const entries = (options.entries ?? []).slice().sort((left, right) =>
    String(left.relativePath).localeCompare(String(right.relativePath)))
  return {
    schemaVersion: MANIFEST_VERSION,
    plugin: 'dsh-reclaim',
    batchId: options.batchId,
    createdAt: options.createdAt ?? new Date().toISOString(),
    // The volume the relative paths are anchored to. Recorded so a batch can be
    // interpreted on a machine whose root differs, and so a reader can check that
    // each entry's two path forms agree.
    volumeRoot: options.volumeRoot ?? null,
    // A single batch holds one logical operation; the session ids it touched are
    // listed so a later reader can tell "this batch deleted session X".
    sessionIds: [...new Set((options.entries ?? []).map((entry) => entry.sessionId).filter((id) => typeof id === 'string'))].sort(),
    entries,
    totals: {
      entries: entries.length,
      files: entries.reduce((sum, entry) => sum + (typeof entry.files === 'number' ? entry.files : 0), 0),
      bytes: entries.reduce((sum, entry) => sum + (typeof entry.bytes === 'number' ? entry.bytes : 0), 0),
    },
    sessionAccounting: options.sessionAccounting ?? null,
    notes: options.notes ?? [],
  }
}

/**
 * Validate a parsed manifest against the batch directory it came from.
 *
 * Returns `{ ok, manifest, issues }`. Issues are never "repaired": a manifest
 * that does not describe its own batch directory cannot be trusted to guide a
 * restore, and guessing would risk restoring a file over a live one.
 */
export function validateManifest(parsed, batchDir) {
  const issues = []
  if (parsed === null || typeof parsed !== 'object') {
    return { ok: false, manifest: null, issues: ['the manifest is not an object'] }
  }
  if (parsed.schemaVersion !== MANIFEST_VERSION) {
    issues.push(`unsupported manifest schemaVersion ${JSON.stringify(parsed.schemaVersion)} (expected ${MANIFEST_VERSION})`)
  }
  if (typeof parsed.batchId !== 'string' || parsed.batchId.length === 0) issues.push('batchId is missing')
  if (!Array.isArray(parsed.entries)) {
    issues.push('entries is not an array')
    return { ok: false, manifest: null, issues }
  }
  // The two stored path forms must agree. The check runs only when the batch
  // records a volume root: without one there is nothing to compare against, and
  // saying "consistent" would be a claim this function cannot support.
  const agreement = parsed.volumeRoot === null || parsed.volumeRoot === undefined
    ? { checked: false, reason: 'the batch records no volume root, so the two path forms cannot be compared' }
    : { checked: true, reason: null }
  const seen = new Set()
  for (const [index, entry] of parsed.entries.entries()) {
    const at = `entries[${index}]`
    if (entry === null || typeof entry !== 'object') {
      issues.push(`${at} is not an object`)
      continue
    }
    if (typeof entry.originalPath !== 'string' || !isAbsolute(entry.originalPath)) {
      issues.push(`${at}.originalPath is not an absolute path`)
    }
    if (typeof entry.relativePath !== 'string' || entry.relativePath.length === 0) {
      issues.push(`${at}.relativePath is missing`)
    } else if (seen.has(entry.relativePath)) {
      issues.push(`${at}.relativePath ${entry.relativePath} appears twice`)
    } else {
      seen.add(entry.relativePath)
    }
    if (typeof entry.kind !== 'string' || entry.kind.length === 0) issues.push(`${at}.kind is missing`)
    // relativePath must land inside this batch directory: a manifest that points
    // outside it would let a restore read an arbitrary path.
    if (typeof entry.relativePath === 'string' && entry.relativePath.length > 0) {
      const target = resolve(batchDir, entry.relativePath)
      const rel = relative(resolve(batchDir), target)
      if (rel.startsWith('..') || isAbsolute(rel)) {
        issues.push(`${at}.relativePath escapes the batch directory`)
      }
    }
    if (agreement.checked && typeof entry.relativePath === 'string' && typeof entry.originalPath === 'string') {
      const paths = entryPathsAgree(entry, parsed.volumeRoot)
      if (paths.agree === false) issues.push(`${at}: ${paths.reason}`)
    }
    if (entry.risk !== undefined && entry.risk !== null && !isPlainObject(entry.risk)) {
      issues.push(`${at}.risk is present but is not an object`)
    }
  }
  return { ok: issues.length === 0, manifest: issues.length === 0 ? parsed : null, issues, agreement }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Write a manifest.
 *
 * Returns `{ ok }` rather than throwing, because the caller has already moved the
 * data: a manifest that cannot be written must be surfaced as loudly as possible
 * but must not be reported as "nothing happened".
 *
 * The write is a temp-file-plus-rename inside the batch, so a crash mid-write
 * cannot leave a half-written manifest that parses as a valid one.
 */
export function writeManifest(batchDir, manifest) {
  const path = manifestPath(batchDir)
  const temp = `${path}.partial`
  try {
    mkdirSync(batchDir, { recursive: true })
    writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    // `renameSync` onto an existing file overwrites silently — which is exactly
    // what is wanted here, and is why this is the one place a rename is allowed
    // to have a live destination.
    renameSync(temp, path)
    return { ok: true, path, reason: null, bytes: statSync(path).size }
  } catch (cause) {
    try {
      if (existsSync(temp)) unlinkSync(temp)
    } catch {
      /* the partial file is reported by its absence from the result */
    }
    return { ok: false, path, reason: `could not write the manifest: ${describeCause(cause)}`, bytes: null }
  }
}

/**
 * Read a batch manifest.
 *
 * @returns {{ ok: boolean, manifest: object|null, issues: string[], reason: string|null, incomplete: boolean }}
 *   `incomplete: true` means the batch directory has contents but no manifest —
 *   the signature of an interrupted operation, which must be shown to the user
 *   rather than cleaned up.
 */
export function readManifest(batchDir) {
  const path = manifestPath(batchDir)
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (cause) {
    const missing = cause?.code === 'ENOENT'
    return {
      ok: false,
      manifest: null,
      issues: [],
      reason: missing ? 'the batch has no manifest' : `could not read the manifest: ${describeCause(cause)}`,
      incomplete: missing,
    }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (cause) {
    return {
      ok: false,
      manifest: null,
      issues: [],
      reason: `the manifest is not valid JSON: ${describeCause(cause)}`,
      incomplete: false,
    }
  }
  const validation = validateManifest(parsed, batchDir)
  return {
    ok: validation.ok,
    manifest: validation.manifest,
    issues: validation.issues,
    reason: validation.ok ? null : `the manifest does not describe this batch: ${validation.issues.join('; ')}`,
    incomplete: false,
  }
}

/**
 * Check that an entry's two path forms describe the same original file.
 *
 * The batch mirrors the original tree *inside a kind subdirectory*
 * (`sessions/<path from the volume root>`), so an entry's `relativePath` is not
 * simply the original path minus the volume root — it carries the subdirectory
 * first. A naive `join(volumeRoot, relativePath)` therefore produces a wrong path
 * (it repeats the kind subdirectory under the volume root), and it would have been
 * a false alarm on every healthy batch.
 *
 * The check that is actually meaningful is on the tail: once the leading kind
 * subdirectory is stripped, the remaining segments must equal the original
 * path's segments after the volume root. That is what makes the two stored forms
 * mutually checkable.
 */
export function entryPathsAgree(entry, volumeRoot, kindSubdirs = DEFAULT_KIND_SUBDIRS) {
  if (volumeRoot === undefined || volumeRoot === null) {
    return { checked: false, agree: null, reason: 'the batch records no volume root, so the two path forms cannot be compared' }
  }
  const relocation = relocationSegments(entry, volumeRoot, kindSubdirs)
  return relocation
}

/** The segments an entry's relative path must have on top of the original path. */
function relocationSegments(entry, volumeRoot, kindSubdirs) {
  const relativeSegments = String(entry.relativePath ?? '').split(/[/\\]+/).filter(Boolean)
  const originalSegments = String(entry.originalPath ?? '').split(/[/\\]+/).filter(Boolean)
  const rootSegments = String(volumeRoot).split(/[/\\]+/).filter(Boolean)

  const originalTail = originalSegments.slice(rootSegments.length)
  if (originalTail.length === 0) {
    return { checked: false, agree: null, reason: 'the original path is shorter than the volume root' }
  }
  const matchesTail = relativeSegments.length === originalTail.length + 1
    && relativeSegments.slice(1).join('/') === originalTail.join('/')
  if (!matchesTail) {
    return {
      checked: true,
      agree: false,
      reason:
        `the relative path does not mirror the original path under ${volumeRoot}: expected ` +
        `<kind>/<${originalTail.length} segment(s)> but found ${relativeSegments.length} segment(s)`,
    }
  }
  if (!kindSubdirs.includes(relativeSegments[0])) {
    return {
      checked: true,
      agree: false,
      reason: `the relative path starts with ${JSON.stringify(relativeSegments[0])}, which is not a known kind subdirectory`,
    }
  }
  if (entry.kind !== undefined && KIND_SUBDIR_BY_KIND[entry.kind] !== relativeSegments[0]) {
    return {
      checked: true,
      agree: false,
      reason:
        `the entry says kind ${JSON.stringify(entry.kind)} but its relative path is under ` +
        `${JSON.stringify(relativeSegments[0])}; the two do not describe the same item`,
    }
  }
  return { checked: true, agree: true, mirror: relativeSegments[0], reason: null }
}

/** Which subdirectory each kind belongs in, so `kind` and the path can be cross-checked. */
export const KIND_SUBDIR_BY_KIND = Object.freeze({
  session: 'sessions',
  'session-cache': 'session-caches',
  attachment: 'attachments',
  cache: 'caches',
  other: 'other',
})

/** The kind subdirectories a batch may use. */
export const DEFAULT_KIND_SUBDIRS = Object.freeze(['sessions', 'session-caches', 'attachments', 'caches', 'other'])

/** Check that an entry's relative path stays inside its batch directory. */
export function relativePathInside(batchDir, relativePath) {
  const target = resolve(batchDir, relativePath)
  const rel = relative(resolve(batchDir), target)
  return { inside: !(rel.startsWith('..') || isAbsolute(rel)), target }
}

/**
 * The original path as it would read on a machine whose volume root differs.
 *
 * A restore uses the recorded absolute path, so this exists for a caller that
 * explicitly wants to relocate a batch (moving it to another drive), NOT as the
 * primary restore mechanism.
 */
export function relocateOriginalPath(entry, fromVolumeRoot, toVolumeRoot) {
  const relativeSegments = String(entry.relativePath ?? '').split(/[/\\]+/).filter(Boolean)
  // Drop the kind subdirectory: what remains is the path under the volume root.
  const kindSubdir = relativeSegments[0]
  const expectedSubdir = entry.kind === undefined ? null : KIND_SUBDIR_BY_KIND[entry.kind]
  if (expectedSubdir !== null && kindSubdir !== expectedSubdir) {
    return {
      ok: false,
      path: null,
      reason:
        `the entry says kind ${JSON.stringify(entry.kind)} but its relative path is under ` +
        `${JSON.stringify(kindSubdir)}; relocating it would place the item in the wrong batch subdirectory`,
    }
  }
  const tail = relativeSegments.slice(1)
  const originalSegments = String(entry.originalPath ?? '').split(/[/\\]+/).filter(Boolean)
  const fromRootSegments = String(fromVolumeRoot ?? '').split(/[/\\]+/).filter(Boolean)
  const expectedTail = originalSegments.slice(fromRootSegments.length)
  if (tail.join('/') !== expectedTail.join('/')) {
    return {
      ok: false,
      path: null,
      reason:
        'the entry does not mirror its original path, so relocating it would guess at the destination; the ' +
        'manifest is reported as inconsistent instead',
    }
  }
  return { ok: true, path: join(String(toVolumeRoot ?? '/'), ...expectedTail), reason: null }
}

/** A compact description of a batch for listings and for the interface. */
export function describeBatch(batchDir) {
  const read = readManifest(batchDir)
  if (!read.ok) {
    return {
      batchDir,
      batchId: dirname(batchDir) === batchDir ? batchDir : batchDir.split(/[/\\]/).pop(),
      ok: false,
      reason: read.reason,
      issues: read.issues,
      incomplete: read.incomplete,
      entries: 0,
      bytes: null,
      sessionIds: [],
      createdAt: null,
    }
  }
  const manifest = read.manifest
  return {
    batchDir,
    batchId: manifest.batchId,
    ok: true,
    reason: null,
    issues: [],
    incomplete: false,
    entries: manifest.totals?.entries ?? manifest.entries.length,
    bytes: manifest.totals?.bytes ?? null,
    sessionIds: manifest.sessionIds ?? [],
    createdAt: manifest.createdAt ?? null,
    notes: manifest.notes ?? [],
  }
}
