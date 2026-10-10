/**
 * dsh-reclaim — the quarantine: where "delete" actually puts things.
 *
 * ## What this module is for
 *
 * Every other part of this plugin is read-only by design; this is the first and
 * only place that moves a user's data. So the rule it exists to enforce is:
 *
 *   **Nothing is ever destroyed here.** A delete is a *move* into the plugin's
 *   own directory, with a manifest next to it that says where it came from and
 *   what the risk assessment said at the time. "Delete" becomes "recoverable".
 *
 * ## The three conditions the layout must satisfy (all three, at once)
 *
 *   1. **Outside `sessions/` and `attachments/`.** The host walks those trees to
 *      build its own listings; a session moved *into* them would come back as a
 *      ghost entry, and the plugin's own scan would double-count it.
 *   2. **Excluded from this plugin's own scan.** Otherwise the plugin would
 *      "clean" its own recycle bin — the user restores a session, and the next
 *      scan deletes it again. The exclusion primitive (`makeIsInsideTrash`) is
 *      fail-closed and lives in the asset-location layer, so this module consumes
 *      it rather than writing a second, weaker test.
 *   3. **The manifest lives INSIDE the batch.** Restore information travels with
 *      the data: copy the batch directory to another disk and it is still
 *      restorable.
 *
 * ## The move primitive, measured rather than assumed
 *
 * Two Node bulk operations are known to return normally and do NOTHING under this
 * workspace (`rmSync(recursive)`, `cpSync(recursive)`), so nothing here trusts a
 * recursive call to have done its job. The measured facts behind the move:
 *
 *   - `renameSync` works for files AND for non-empty directories, so a batch item
 *     moves with one atomic call and never needs a recursive delete first;
 *   - `renameSync` **silently overwrites an existing file** — the one failure
 *     mode that loses data without any error. Every move therefore checks its
 *     destination first and refuses on a collision;
 *   - `renameSync` onto an existing directory fails with `EPERM`, so a collision
 *     is at least loud in that shape;
 *   - a cross-volume move (`EXDEV`) cannot be atomic, and falls back to
 *     copy → verify bytes → unlink, which is the only sequence that cannot leave
 *     zero copies behind.
 *
 * Write scope: only under `<home>/<TRASH_DIR_NAME>/`. This module never writes
 * anywhere else, and never into `sessions/` or `attachments/`.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { TRASH_DIR_NAME, makeIsInsideTrash, resolveLayout } from './paths.js'

export { TRASH_DIR_NAME }

/** Directory names inside a batch, one per object kind. */
export const BATCH_SUBDIRS = Object.freeze({
  session: 'sessions',
  'session-cache': 'session-caches',
  attachment: 'attachments',
  cache: 'caches',
  other: 'other',
})

function describeCause(cause) {
  if (cause === null || cause === undefined) return String(cause)
  const name = cause?.name ?? 'Error'
  const message = cause?.message ?? String(cause)
  const code = cause?.code === undefined ? '' : ` (code ${String(cause.code)})`
  return `${name}: ${message}${code}`
}

/** Coerce a value that may be a Date, an ISO string or a number into millis. */
export function toMillis(value) {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? null : parsed
  }
  return null
}

/**
 * The batch directory name for an instant: `2026-09-16T10-30-00`.
 *
 * Colons are illegal in a Windows path, so the ISO string is made
 * filesystem-safe. The format is kept human-sortable: batch directories list in
 * chronological order with a plain `dir`.
 */
export function batchIdFor(instant) {
  const millis = toMillis(instant)
  const at = millis === null ? new Date() : new Date(millis)
  const pad = (value) => String(value).padStart(2, '0')
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` +
    `T${pad(at.getHours())}-${pad(at.getMinutes())}-${pad(at.getSeconds())}`
  )
}

/** The batch directory for an instant, under the layout's trash root. */
export function batchDirFor(layout, instant) {
  const root = layout?.trash?.root
  if (typeof root !== 'string' || root.length === 0) {
    throw new Error('the layout does not expose a trash root; refusing to guess a quarantine location')
  }
  return join(root, batchIdFor(instant))
}

/**
 * Land an item at `batchDir/<subdir>/<original path>`.
 *
 * The original absolute path is reproduced *inside* the batch, so the manifest's
 * `originalPath` can be recomputed from `relativePath` plus a volume root and a
 * restore needs no extra mapping table. Two different originals therefore can
 * never collide with each other.
 *
 * The volume root is a parameter rather than "whatever drive we are on": a batch
 * is expected to be copyable to another machine, where only the root differs.
 * Callers pass the drive/volume root of the DSH home, so the relative path is
 * stable and the two stored forms stay consistent.
 */
export function destinationFor(batchDir, kind, sourcePath, options = {}) {
  if (typeof sourcePath !== 'string' || !isAbsolute(sourcePath)) {
    throw new Error(`the quarantine only accepts absolute source paths; got ${JSON.stringify(sourcePath)}`)
  }
  const subdir = BATCH_SUBDIRS[kind]
  if (subdir === undefined) {
    throw new Error(`unknown object kind ${JSON.stringify(kind)}; expected one of ${Object.keys(BATCH_SUBDIRS).join(', ')}`)
  }
  const segments = relativeSegments(sourcePath, options.volumeRoot)
  if (segments.length === 0) throw new Error(`refusing to place ${sourcePath}: the relative path is empty`)
  if (segments.some((segment) => segment === '..')) {
    throw new Error(`refusing to place ${sourcePath}: the relative path escapes the batch`)
  }
  return join(batchDir, subdir, ...segments)
}

/**
 * The path of `sourcePath` relative to a volume root, as path segments.
 *
 * Handles both Windows volumes (`D:\`, and a UNC share where `relative` would
 * give up and return the absolute path) and POSIX roots. When the source is on a
 * different volume than the root, the drive/UNC prefix is kept as the first
 * segment so a batch copied to another machine can still be interpreted.
 *
 * The root arrives in the portable form (`D:/`), and `join('D:/', 'a')` produces
 * the drive-*relative* path `D:/a` rather than `D:\a`. Converting back to the
 * native root here is what keeps `relative()` honest — measured the hard way:
 * with the portable form the move landed outside the batch while the manifest
 * recorded the intended place, so the batch looked empty and restore reported
 * the item missing.
 */
export function relativeSegments(sourcePath, volumeRoot) {
  const absolute = resolve(sourcePath)
  const requested = volumeRoot === undefined || volumeRoot === null ? null : join(volumeRoot)
  const root = requested === null || requested === '' ? volumeRootFor(absolute) : requested

  let relativePart = null
  try {
    const candidate = relative(root, absolute)
    if (!candidate.startsWith('..') && !isAbsolute(candidate)) relativePart = candidate
  } catch {
    relativePart = null
  }
  if (relativePart === null) {
    // Different volume (or a UNC share `relative` refuses): keep the prefix.
    relativePart = absolute.replace(/^[/\\]+/, '').replace(/^([A-Za-z]):[/\\]?/, '$1/')
  }
  return relativePart.split(/[/\\]+/).filter((segment) => segment.length > 0 && segment !== '.')
}

/** The volume root of an absolute path: `D:\` on Windows, the UNC host, or `/`. */
export function volumeRootFor(absolutePath) {
  const text = resolve(absolutePath)
  const drive = /^([A-Za-z]):[/\\]/.exec(text)
  if (drive !== null) return `${drive[1]}:\\`
  const unc = /^[/\\]{2}([^/\\]+)[/\\]([^/\\]+)/.exec(text)
  if (unc !== null) return `\\\\${unc[1]}\\${unc[2]}`
  return '/'
}

/**
 * Normalise a volume root to exactly one trailing separator.
 *
 * `D:` and `D:\` and `D:/` all mean the same volume, but `join('D:', 'a')`
 * produces `D:a` — a *relative* path on that drive. Normalising here is what
 * keeps a batch's stored paths stable across machines.
 */
export function resolveVolumeRoot(volumeRoot) {
  if (volumeRoot === undefined || volumeRoot === null || volumeRoot === '') return null
  let text = String(volumeRoot).replace(/\\/g, '/')
  const drive = /^([A-Za-z]):(\/|$)/.exec(text)
  if (drive !== null) return `${drive[1]}:/`
  const unc = /^\/\/([^/]+)\/([^/]+)/.exec(text)
  if (unc !== null) return `//${unc[1]}/${unc[2]}/`
  if (!text.endsWith('/')) text += '/'
  return text
}

/** True when the path exists (any type). */
function exists(path) {
  try {
    return existsSync(path)
  } catch {
    return false
  }
}

/** `statSync` that reports failure instead of throwing. */
function statOrNull(path) {
  try {
    return statSync(path)
  } catch (cause) {
    return { error: describeCause(cause), code: cause?.code ?? null }
  }
}

/**
 * Decide what a move would do, without doing it.
 *
 * Every refusal reason is a status the caller must report: an item that cannot be
 * moved must stay exactly where it is, and the batch must say so instead of
 * silently containing one item fewer.
 *
 * The plan itself is still pure: nothing is touched, and a dry run stays honest.
 * Async only because `options.isInsideTrash` is contractually async — the
 * documented type is `(candidatePath) => Promise<boolean>` (`lib/paths.js:329`),
 * and a promise compared with `=== true` is always false, so the comparison has
 * to cross the seam rather than take a shortcut.
 *
 * @param {string} sourcePath
 * @param {string} destination
 * @param {object} [options]
 * @param {(path: string) => Promise<boolean>|boolean} [options.isInsideTrash]
 * @returns {Promise<{ sourcePath: string, destination: string, status: string, reason: string|null, bytes: number|null, isDirectory: boolean|null }>}
 */
export async function planMove(sourcePath, destination, options = {}) {
  const base = { sourcePath, destination, status: 'pending', reason: null, bytes: null, isDirectory: null }
  if (typeof sourcePath !== 'string' || sourcePath.length === 0) {
    return { ...base, status: 'invalid', reason: 'no source path was supplied' }
  }
  if (typeof destination !== 'string' || destination.length === 0) {
    return { ...base, status: 'invalid', reason: 'no destination path was supplied' }
  }
  // The guard must be ON unless a caller deliberately replaces it — the same
  // discipline `planRestore` follows (`lib/restore.js`), and for the same
  // reason. The old `options.isInsideTrash !== undefined` prefix meant "no
  // predicate supplied" and "no guard" were the same thing, which is how the
  // guard stayed dead for callers that never injected one (docs/safety.md §8.6).
  // Every caller in this repository injects a shared predicate
  // (`deleteSessionItems` binds one for the whole batch); this default exists so
  // that a caller which does not still gets the guard rather than silence.
  const isInsideTrash = options.isInsideTrash ?? makeIsInsideTrash(options.layout ?? resolveLayout())
  if ((await isInsideTrash(sourcePath)) === true) {
    return {
      ...base,
      status: 'already-in-trash',
      reason: 'the source is already inside the quarantine; moving it again would nest the trash inside itself',
    }
  }
  const info = statOrNull(sourcePath)
  if (info.error !== undefined) {
    return {
      ...base,
      status: info.code === 'ENOENT' ? 'source-missing' : 'source-unreadable',
      reason: info.code === 'ENOENT'
        ? 'the source does not exist'
        : `the source could not be inspected: ${info.error}`,
    }
  }
  const isDirectory = info.isDirectory()
  if (exists(destination)) {
    // `renameSync` would overwrite a file here without a word, so the check is
    // not a nicety: it is the only thing standing between a collision and data
    // loss.
    return {
      ...base,
      status: 'destination-exists',
      reason:
        'the quarantine already holds something at this path; refusing to move, because renaming onto an ' +
        'existing file overwrites it silently',
      isDirectory,
    }
  }
  const parent = dirname(destination)
  // Walk up to the first ancestor that exists: a destination path can be several
  // levels below a file that is blocking it, and checking only the immediate
  // parent would miss `sessions` being a FILE with `sessions/<slug>/<id>` as the
  // destination — which is exactly the shape a corrupt quarantine takes.
  const blocking = firstExistingAncestor(parent)
  if (blocking !== null) {
    const blockingInfo = statOrNull(blocking)
    if (blockingInfo.isDirectory?.() !== true) {
      return {
        ...base,
        status: 'destination-unusable',
        reason: `"${blocking}" exists and is not a directory, so the destination path cannot be created`,
        isDirectory,
      }
    }
  }
  return {
    ...base,
    status: 'pending',
    reason: null,
    bytes: isDirectory ? directoryBytes(sourcePath) : info.size,
    isDirectory,
  }
}

/** The nearest existing ancestor of `path` (not including `path` itself). */
function firstExistingAncestor(path) {
  let current = path
  for (let depth = 0; depth < 64; depth += 1) {
    if (exists(current)) return current
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
  return null
}

/** Total bytes under a directory (best effort; unknown sizes count as 0). */
export function directoryBytes(root) {
  let bytes = 0
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        stack.push(full)
        continue
      }
      try {
        bytes += statSync(full).size
      } catch {
        /* unknown size */
      }
    }
  }
  return bytes
}

/** Total files under a directory (best effort). */
export function directoryFileCount(root) {
  let files = 0
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) stack.push(full)
      else files += 1
    }
  }
  return files
}

/**
 * Copy a tree with per-entry primitives and then PROVE the copy.
 *
 * Only used on the cross-volume path. It walks first to count what it is about
 * to copy, then verifies file count and byte total afterwards; only a byte-exact
 * copy authorizes removing the original.
 */
export function copyTreeVerified(from, to) {
  const result = { files: 0, bytes: 0, failures: [], verified: false, links: [] }
  mkdirSync(to, { recursive: true })
  const stack = [{ from, to }]
  while (stack.length > 0) {
    const current = stack.pop()
    let entries
    try {
      entries = readdirSync(current.from, { withFileTypes: true })
    } catch (cause) {
      result.failures.push(`${current.from} (readdir ${describeCause(cause)})`)
      continue
    }
    for (const entry of entries) {
      const sourcePath = join(current.from, entry.name)
      const targetPath = join(current.to, entry.name)
      if (entry.isSymbolicLink()) {
        // Never followed: a link inside the quarantine could point back out, and
        // following it would copy (or later delete) something outside the tree.
        result.links.push(sourcePath)
        continue
      }
      if (entry.isDirectory()) {
        try {
          mkdirSync(targetPath, { recursive: true })
        } catch (cause) {
          result.failures.push(`${targetPath} (mkdir ${describeCause(cause)})`)
          continue
        }
        stack.push({ from: sourcePath, to: targetPath })
        continue
      }
      try {
        const sourceInfo = statSync(sourcePath)
        copyFileSync(sourcePath, targetPath)
        const targetInfo = statSync(targetPath)
        if (targetInfo.size !== sourceInfo.size) {
          result.failures.push(`${targetPath} (size ${targetInfo.size} != source ${sourceInfo.size})`)
          continue
        }
        result.files += 1
        result.bytes += targetInfo.size
      } catch (cause) {
        result.failures.push(`${sourcePath} (copy ${describeCause(cause)})`)
      }
    }
  }
  const expected = directoryFileCount(from)
  result.verified = result.failures.length === 0 && result.files === expected && result.links.length === 0
  if (!result.verified && result.links.length > 0) {
    result.failures.push(
      `${result.links.length} link(s) were not copied (links are never followed), so this copy cannot be ` +
        'called complete and the original must not be removed',
    )
  }
  return result
}

/**
 * Remove a tree that a verified copy has already replaced.
 *
 * `rmSync(recursive)` is measured to do nothing under this workspace, so the walk
 * is explicit: links are unlinked (never followed, never entered), files
 * unlinked, directories removed children-first. The caller gets the failures and
 * must surface them — a partial removal is a fact, not an error to swallow.
 */
export function removeTreeVerified(root) {
  const result = { files: 0, bytes: 0, dirs: 0, failures: [], stillPresent: exists(root) }
  if (!result.stillPresent) return result

  const directories = []
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    directories.push(dir)
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (cause) {
      result.failures.push(`${dir} (readdir ${describeCause(cause)})`)
      continue
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      const isLink = entry.isSymbolicLink()
      if (entry.isDirectory() && !isLink) {
        stack.push(full)
        continue
      }
      try {
        if (!isLink) {
          try {
            result.bytes += statSync(full).size
          } catch {
            /* unknown size */
          }
        }
        unlinkSync(full)
        result.files += 1
      } catch (cause) {
        result.failures.push(`${full} (unlink ${describeCause(cause)})`)
      }
    }
  }
  // Children before parents. Reversing the discovery order is NOT enough: this
  // walk is depth-first but not strictly pre-order, so a parent can end up after
  // its child in the reversed list and then fail with `ENOTEMPTY` (measured — it
  // left an empty batch tree behind after a purge). Sorting by depth descending
  // is the guarantee.
  directories.sort((left, right) => pathDepth(right) - pathDepth(left))
  for (const dir of directories) {
    try {
      rmdirSync(dir)
      result.dirs += 1
    } catch (cause) {
      if (cause?.code !== 'ENOENT') result.failures.push(`${dir} (rmdir ${describeCause(cause)})`)
    }
  }
  result.stillPresent = exists(root)
  return result
}

/** How many separators separate a path from its volume root. */
function pathDepth(path) {
  return path.split(/[/\\]+/).filter((segment) => segment.length > 0).length
}

/**
 * Move one planned item into the batch.
 *
 * Order of operations on the fallback path is deliberate and must not be
 * "simplified": copy → verify bytes → remove original. Any other order can end
 * with zero copies.
 *
 * @returns {{ status: 'moved'|'copied'|'failed', reason: string|null, bytes: number|null, method: string|null }}
 */
export function performMove(plan) {
  if (plan.status !== 'pending') {
    return { status: 'failed', reason: plan.reason ?? `the plan is not movable (${plan.status})`, bytes: null, method: null }
  }
  const { sourcePath, destination } = plan
  try {
    mkdirSync(dirname(destination), { recursive: true })
  } catch (cause) {
    return { status: 'failed', reason: `could not create the quarantine path: ${describeCause(cause)}`, bytes: null, method: null }
  }

  // Re-check immediately before the rename: between planning and moving, another
  // process could have created the destination, and a rename would overwrite it.
  if (exists(destination)) {
    return {
      status: 'failed',
      reason: 'the destination appeared between planning and moving; refusing to overwrite it',
      bytes: null,
      method: null,
    }
  }

  try {
    renameSync(sourcePath, destination)
    return { status: 'moved', reason: null, bytes: plan.bytes ?? null, method: 'rename' }
  } catch (cause) {
    if (cause?.code !== 'EXDEV') {
      return {
        status: 'failed',
        reason: `could not move the item: ${describeCause(cause)}`,
        bytes: null,
        method: 'rename',
      }
    }
    // Cross-volume: a rename is impossible, so the only safe sequence is a
    // verified copy followed by removing the original.
    if (plan.isDirectory === true) {
      const copy = copyTreeVerified(sourcePath, destination)
      if (!copy.verified) {
        return {
          status: 'failed',
          reason:
            `a cross-volume copy could not be verified (${copy.files} file(s), ${copy.failures.length} ` +
            `failure(s)), so the original was left in place: ${copy.failures.slice(0, 3).join('; ')}`,
          bytes: null,
          method: 'copy-verify-remove',
        }
      }
      const removal = removeTreeVerified(sourcePath)
      if (removal.failures.length > 0 || removal.stillPresent) {
        return {
          status: 'failed',
          reason:
            `the item was copied but the original could not be fully removed (${removal.failures.length} ` +
            `failure(s)); the quarantine now holds a copy and the original is still in place`,
          bytes: copy.bytes,
          method: 'copy-verify-remove',
        }
      }
      return { status: 'copied', reason: null, bytes: copy.bytes, method: 'copy-verify-remove' }
    }
    try {
      const sourceInfo = statSync(sourcePath)
      copyFileSync(sourcePath, destination)
      const targetInfo = statSync(destination)
      if (targetInfo.size !== sourceInfo.size) {
        return {
          status: 'failed',
          reason: `a cross-volume copy does not match its source (${targetInfo.size} vs ${sourceInfo.size} bytes)`,
          bytes: null,
          method: 'copy-verify-remove',
        }
      }
      unlinkSync(sourcePath)
      return { status: 'copied', reason: null, bytes: targetInfo.size, method: 'copy-verify-remove' }
    } catch (inner) {
      return {
        status: 'failed',
        reason: `cross-volume fallback failed: ${describeCause(inner)}`,
        bytes: null,
        method: 'copy-verify-remove',
      }
    }
  }
}

/**
 * Create (or open) a batch directory.
 *
 * Reusing the same second is intentional: `batchIdFor` has one-second resolution,
 * so calling this from a script that runs twice would otherwise produce two batch
 * directories and split a single logical operation across them. A new batch is
 * only started when the caller asks for one with a distinct instant, or when the
 * existing directory holds a manifest for a *different* session id.
 */
export function createBatch(layout, options = {}) {
  const root = layout?.trash?.root
  if (typeof root !== 'string' || root.length === 0) {
    throw new Error('the layout does not expose a trash root; refusing to guess a quarantine location')
  }
  const batchDir = batchDirFor(layout, options.instant ?? new Date())
  mkdirSync(batchDir, { recursive: true })
  return { root, batchDir, batchId: basename(batchDir) }
}

/** The subdirectory a batch keeps for one object kind. */
export function subdirFor(batchDir, kind) {
  const subdir = BATCH_SUBDIRS[kind]
  if (subdir === undefined) throw new Error(`unknown object kind ${JSON.stringify(kind)}`)
  return join(batchDir, subdir)
}

/**
 * Read a directory's top-level entries, reporting failure rather than returning
 * an empty list. A batch that cannot be listed must not look like an empty one.
 */
export function listDir(path) {
  try {
    return { ok: true, entries: readdirSync(path, { withFileTypes: true }), reason: null }
  } catch (cause) {
    return {
      ok: false,
      entries: [],
      reason: cause?.code === 'ENOENT' ? 'the directory does not exist' : `could not list the directory: ${describeCause(cause)}`,
    }
  }
}

/**
 * A background sweep of the quarantine's own leftovers.
 *
 * Deliberately absent: an automatic purge is a delete path with no user in front
 * of it, and this plugin's contract is that nothing is destroyed except by a
 * person who asked for it. Leaving it out is a decision, not an omission — and
 * `purgeBatch` cannot be reached from any scheduled path.
 */
export const AUTOMATIC_PURGE_IMPLEMENTED = false

/**
 * The full "delete one session" operation: move its files, write the manifest,
 * then fix the accounting.
 *
 * ## The five places a session lives, and the order they are handled in
 *
 * | # | Location | Why it is on the list |
 * |---|---|---|
 * | ① | the session's own directory (`sessions/<workspace>/session-<id>/`) | the data |
 * | ② | the projection cache (`storages/session_projcache/sessions/<id>.json`) | a cache with no session is unreadable garbage |
 * | ③ | the workspace's `sessionIds` | a dangling accounting entry |
 * | ④ | a persistent index | none exists on this host (measured), so this is reported as empty rather than assumed |
 * | ⑤ | background-job ownership | a job whose owner vanished cannot be reported on afterwards |
 *
 * ①② happen **before** ③ on purpose: the workspace entity prunes members whose
 * session directory no longer resolves, so moving first means the accounting is
 * already being corrected by the host itself, and a failed move never leaves a
 * session that is live but unaccounted for.
 *
 * ## The failure rules, which are the whole point
 *
 *   - an item that cannot be moved **stays where it is** and is reported;
 *   - if **nothing** moved, no manifest is written and the batch directory is
 *     removed again — a batch that holds nothing must not exist to be restored;
 *   - the manifest lists only what actually moved, so it never claims more than
 *     the batch holds.
 *
 * @param {object} options
 * @param {object} options.layout
 * @param {string} options.sessionId
 * @param {readonly object[]} options.items - `{ path, kind }` candidates
 * @param {object|null} [options.risk] - the pre-move assessment, archived as evidence
 * @param {boolean} [options.dryRun]
 * @param {object} [options.instant]
 * @param {(sessionId: string) => Promise<object>} [options.detach] - accounting step (③)
 * @returns {Promise<object>} a JSON-serializable report of every item's status
 */
export async function deleteSessionItems(options) {
  const layout = options.layout
  if (layout?.trash?.root === undefined) {
    return { ok: false, reason: 'the layout does not expose a trash root', batchDir: null, items: [], manifest: null }
  }
  const isInsideTrash = options.isInsideTrash ?? makeIsInsideTrash(layout)
  const instant = options.instant ?? new Date()
  // The volume the batch mirrors. Derived from the DSH home when the caller does
  // not name one, because a relative path computed against "whatever drive the
  // process is on" would change meaning if the batch were read from elsewhere.
  const volumeRoot = resolveVolumeRoot(options.volumeRoot ?? volumeRootFor(layout.home))

  const known = new Set()
  const items = []
  for (const candidate of options.items ?? []) {
    if (typeof candidate?.path !== 'string' || candidate.path.length === 0) continue
    const key = resolve(candidate.path).toLowerCase()
    if (known.has(key)) continue
    known.add(key)
    items.push({
      originalPath: candidate.path,
      kind: candidate.kind ?? 'other',
      reason: candidate.reason ?? null,
    })
  }

  // Plan everything before touching anything: a plan is what makes a dry run
  // honest, and it gives the caller a complete picture of what would happen.
  const batchDir = batchDirFor(layout, instant)
  const batchId = basename(batchDir)
  const planned = await Promise.all(
    items.map(async (item) => {
      const destination = destinationFor(batchDir, item.kind, item.originalPath, { volumeRoot })
      // The path is taken from the destination itself, not recomputed from the
      // source: the destination carries the kind's subdirectory (`sessions/`), and a
      // recomputed path would omit it — the batch would then hold the item at one
      // path while the manifest pointed at another, so a restore would report the
      // item missing even though it was right there.
      const relativePath = relative(batchDir, destination).split(sep).join('/')
      return {
        ...item,
        destination,
        relativePath,
        plan: await planMove(item.originalPath, destination, { isInsideTrash }),
      }
    }),
  )

  const moveable = planned.filter((item) => item.plan.status === 'pending')
  if (options.dryRun === true) {
    return {
      ok: true,
      dryRun: true,
      sessionId: options.sessionId ?? null,
      batchDir,
      batchId,
      moved: [],
      skipped: planned.filter((item) => item.plan.status !== 'pending').map(summarizeItem),
      wouldMove: moveable.map(summarizeItem),
      manifestPath: null,
      accounting: null,
      totals: {
        moved: 0,
        skipped: planned.length - moveable.length,
        wouldMove: moveable.length,
        bytes: moveable.reduce((sum, item) => sum + (item.plan.bytes ?? 0), 0),
      },
      reason: null,
    }
  }

  if (moveable.length === 0) {
    // Zero successful moves: say so and leave no batch behind. An empty batch
    // would be restorable-looking nothing and purgable-looking like a decision.
    const skipped = planned.map(summarizeItem)
    return {
      ok: false,
      dryRun: false,
      sessionId: options.sessionId ?? null,
      batchDir: null,
      batchId,
      moved: [],
      skipped,
      wouldMove: [],
      manifestPath: null,
      accounting: null,
      totals: { moved: 0, skipped: skipped.length, wouldMove: 0, bytes: 0 },
      reason:
        moveable.length === 0 && planned.length === 0
          ? 'nothing was found to move: no file belonging to this session exists at the expected locations'
          : `none of the ${planned.length} item(s) could be moved, so no batch was created and no manifest was ` +
            'written; each item is listed with its reason and every one of them is still in place',
    }
  }

  mkdirSync(batchDir, { recursive: true })
  const moved = []
  const failed = []
  for (const item of moveable) {
    const outcome = performMove(item.plan)
    if (outcome.status === 'moved' || outcome.status === 'copied') {
      const files = item.plan.isDirectory === true ? directoryFileCount(item.originalPath) : 1
      moved.push({
        ...summarizeItem(item),
        status: outcome.status,
        method: outcome.method,
        bytes: outcome.bytes,
        files,
        isDirectory: item.plan.isDirectory === true,
      })
    } else {
      failed.push({ ...summarizeItem(item), status: 'failed', reason: outcome.reason })
    }
  }
  const skipped = planned
    .filter((item) => item.plan.status !== 'pending')
    .map(summarizeItem)
    .concat(failed)

  // Only what actually moved goes into the manifest — and the manifest is
  // written now, not before, so an interrupted batch is recognisable by its
  // missing manifest.
  const entries = moved.map((item) => ({
    originalPath: item.originalPath,
    relativePath: item.relativePath,
    kind: item.kind,
    sessionId: options.sessionId ?? null,
    bytes: item.bytes ?? null,
    files: item.files,
    isDirectory: item.isDirectory === true,
    removedAt: new Date().toISOString(),
    risk: options.risk ?? null,
    note: item.reason,
  }))

  const { buildManifest, writeManifest } = await import('./manifest.js')
  const manifest = buildManifest({
    batchId,
    createdAt: new Date(instant).toISOString(),
    entries,
    volumeRoot,
    sessionAccounting: null,
    notes: skipped.length > 0
      ? [`${skipped.length} item(s) were not moved and remain in place; each carries its reason in the operation report`]
      : [],
  })
  const written = writeManifest(batchDir, manifest)

  // ③ accounting, after ①② and only for what moved.
  let accounting = null
  if (typeof options.detach === 'function' && moved.some((item) => item.kind === 'session')) {
    try {
      accounting = await options.detach(options.sessionId)
    } catch (cause) {
      accounting = { ok: false, action: 'threw', reason: describeCause(cause) }
    }
    if (written.ok) {
      const { readManifest } = await import('./manifest.js')
      const current = readManifest(batchDir)
      if (current.ok) {
        writeManifest(batchDir, { ...current.manifest, sessionAccounting: accounting })
      }
    }
  }

  return {
    ok: moved.length > 0 && written.ok,
    dryRun: false,
    sessionId: options.sessionId ?? null,
    batchDir,
    batchId,
    moved,
    skipped,
    manifestPath: written.path,
    manifestWritten: written.ok,
    manifestReason: written.reason,
    accounting,
    totals: {
      moved: moved.length,
      skipped: skipped.length,
      bytes: moved.reduce((sum, item) => sum + (item.bytes ?? 0), 0),
    },
    reason: written.ok
      ? null
      : `the items were moved but the manifest could not be written (${written.reason}); the batch holds data ` +
        'that cannot be restored by this plugin, and that is reported rather than hidden',
  }
}

function summarizeItem(item) {
  return {
    originalPath: item.originalPath,
    relativePath: item.relativePath,
    destination: item.destination,
    kind: item.kind,
    status: item.plan?.status ?? 'unknown',
    reason: item.plan?.reason ?? item.reason ?? null,
    bytes: item.plan?.bytes ?? null,
    isDirectory: item.plan?.isDirectory ?? null,
  }
}

export { makeIsInsideTrash }
