/**
 * dsh-reclaim — restoring from the quarantine.
 *
 * A restore is the mirror image of a move, with one extra rule that the move does
 * not need:
 *
 *   **A restore never overwrites.** At the moment of a move, the destination is
 *   inside the plugin's own batch and a collision means "this batch already has
 *   that item". At the moment of a restore, the destination is the user's live
 *   tree — and by then the user may have created a new session with the same id,
 *   put a file back by hand, or restored a different batch over the same path.
 *   Overwriting there destroys something the user currently has, so the correct
 *   behaviour is to stop and say so.
 *
 * Per-item outcomes are all-or-nothing at the item level and *nothing* is
 * half-done: an item is either back at its original path (verified), or still in
 * the batch with the entry left in the manifest. A partially restored item would
 * be the one state where the user cannot tell where their data is.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, statSync, unlinkSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { copyTreeVerified, directoryBytes, directoryFileCount, removeTreeVerified, resolveVolumeRoot, volumeRootFor } from './trash.js'
import { MANIFEST_NAME, buildManifest, readManifest, writeManifest } from './manifest.js'
import { RECONSTRUCTED_NOTE, reconstructEntries } from './recover.js'
import { makeIsInsideTrash, resolveLayout } from './paths.js'

function describeCause(cause) {
  if (cause === null || cause === undefined) return String(cause)
  const name = cause?.name ?? 'Error'
  const message = cause?.message ?? String(cause)
  const code = cause?.code === undefined ? '' : ` (code ${String(cause.code)})`
  return `${name}: ${message}${code}`
}

function exists(path) {
  try {
    return existsSync(path)
  } catch {
    return false
  }
}

function statOrNull(path) {
  try {
    return statSync(path)
  } catch (cause) {
    return { error: describeCause(cause), code: cause?.code ?? null }
  }
}

/**
 * Work out what a restore of one batch would do, without doing it.
 *
 * Async because `options.isInsideTrash` is contractually async: the predicate
 * this module is handed is `makeIsInsideTrash`'s, documented as
 * `(candidatePath) => Promise<boolean>` (`lib/paths.js:329`). Comparing that
 * promise with `=== true` is always false, which is exactly how this guard
 * stayed dead (`docs/safety.md` §8.6). The plan itself stays pure — nothing is
 * touched, so a dry run remains honest.
 *
 * @param {string} batchDir
 * @param {object} [options]
 * @param {readonly string[]} [options.only] - restore only these original paths
 * @param {(path: string) => Promise<boolean>|boolean} [options.isInsideTrash]
 *   - the quarantine test; defaults to one bound to `options.layout`
 * @param {object} [options.layout] - from `resolveLayout()`; used only to bind
 *   the default `isInsideTrash`
 * @returns {Promise<{ ok: boolean, reason: string|null, items: object[], counts: object }>}
 */
export async function planRestore(batchDir, options = {}) {
  // The guard must be ON unless a caller deliberately replaces it. Both real
  // HTTP callers inject nothing, and the old
  // `options.isInsideTrash !== undefined` prefix therefore kept it dead even
  // once the comparison was fixed. Defaulting it here rather than in each caller
  // also keeps the preview (`/trash/plan`) and the executor (`/restore`)
  // agreeing: a preview that disagrees with the restore it previews is worse
  // than no preview. `DELETE` already binds the same default
  // (`lib/trash.js:687`).
  const isInsideTrash = options.isInsideTrash ?? makeIsInsideTrash(options.layout ?? resolveLayout())
  const read = readManifest(batchDir)
  let manifest = read.ok ? read.manifest : null
  let reconstruction = null
  // Whether THIS plan had to read the record back off the layout — which is not
  // the same as the batch's manifest saying it was reconstructed once: a record
  // written back by an earlier restore is a real record from here on.
  let reconstructedNow = false
  if (manifest === null && read.incomplete === true) {
    // A batch with no manifest is not an empty batch. Its items are still there,
    // mirrored under the batch directory, and every original path is written in
    // the directory names — so the record can be read back off the layout instead
    // of telling the user about a batch they can see but never restore.
    //
    // Deliberately only for a *missing* manifest: a manifest that is present and
    // fails validation is a different problem (the record disagrees with the
    // batch, which is a bug to report), and quietly replacing it would hide it.
    const layout = options.layout ?? resolveLayout()
    reconstruction = reconstructEntries(batchDir, { volumeRoot: resolveVolumeRoot(volumeRootFor(layout.home)) })
    if (reconstruction.entries.length > 0) {
      manifest = buildManifest({
        batchId: basename(batchDir),
        entries: reconstruction.entries,
        volumeRoot: resolveVolumeRoot(volumeRootFor(layout.home)),
        notes: [RECONSTRUCTED_NOTE],
      })
      manifest.reconstructed = true
      reconstructedNow = true
    }
  }
  if (manifest === null) {
    return {
      ok: false,
      reason:
        reconstruction === null || reconstruction.reason === null
          ? `${read.reason}, and nothing in the batch directory could be read back as an item`
          : `${read.reason}, and the batch directory could not be read back either (${reconstruction.reason})`,
      items: [],
      counts: { pending: 0, blocked: 0, total: 0 },
      reconstructed: false,
    }
  }
  const only = options.only === undefined ? null : new Set(options.only)
  const items = []
  for (const entry of manifest.entries) {
    if (only !== null && !only.has(entry.originalPath)) continue
    const source = join(batchDir, entry.relativePath)
    const target = entry.originalPath
    const base = {
      originalPath: target,
      batchPath: source,
      relativePath: entry.relativePath,
      kind: entry.kind,
      sessionId: entry.sessionId ?? null,
      bytes: entry.bytes ?? null,
      isDirectory: entry.isDirectory === true,
      status: 'pending',
      reason: null,
    }
    if (!exists(source)) {
      // The batch says it holds this item and it is not there: that is a fact
      // about the batch, not a reason to invent a file.
      items.push({ ...base, status: 'batch-item-missing', reason: 'the batch does not hold this item any more' })
      continue
    }
    if ((await isInsideTrash(target)) === true) {
      items.push({
        ...base,
        status: 'target-inside-trash',
        reason: 'the recorded original path is inside the quarantine; refusing to restore into it',
      })
      continue
    }
    if (exists(target)) {
      items.push({
        ...base,
        status: 'target-occupied',
        reason: 'something already exists at the original path; a restore never overwrites it',
      })
      continue
    }
    const parent = dirname(target)
    if (exists(parent) && statOrNull(parent).isDirectory?.() !== true) {
      items.push({
        ...base,
        status: 'target-unusable',
        reason: 'a parent of the original path exists and is not a directory',
      })
      continue
    }
    items.push(base)
  }
  const counts = {
    total: items.length,
    pending: items.filter((item) => item.status === 'pending').length,
    blocked: items.filter((item) => item.status !== 'pending').length,
  }
  return {
    ok: true,
    reason: null,
    items,
    counts,
    manifest,
    reconstructed: reconstructedNow,
    reconstruction: reconstruction === null ? null : { subdirs: reconstruction.subdirs, issues: reconstruction.issues },
  }
}

/**
 * Restore one batch (or the subset named by `only`).
 *
 * @param {string} batchDir
 * @param {object} [options]
 * @returns {Promise<{ ok: boolean, restored: object[], blocked: object[], failed: object[], reason: string|null, manifestRewrite: object|null }>}
 */
export async function restoreBatch(batchDir, options = {}) {
  const plan = await planRestore(batchDir, options)
  if (!plan.ok) {
    return { ok: false, restored: [], blocked: [], failed: [], reason: plan.reason, manifestRewrite: null }
  }

  const restored = []
  const failed = []
  const blocked = plan.items.filter((item) => item.status !== 'pending')

  for (const item of plan.items) {
    if (item.status !== 'pending') continue
    try {
      mkdirSync(dirname(item.originalPath), { recursive: true })
    } catch (cause) {
      failed.push({ ...item, status: 'failed', reason: `could not create the original path: ${describeCause(cause)}` })
      continue
    }
    if (exists(item.originalPath)) {
      // Between planning and restoring, the target appeared. Same rule: stop.
      failed.push({
        ...item,
        status: 'failed',
        reason: 'the original path appeared while restoring; refusing to overwrite it',
      })
      continue
    }
    const outcome = moveBack(item)
    if (outcome.ok) restored.push({ ...item, method: outcome.method, status: 'restored' })
    else failed.push({ ...item, status: 'failed', reason: outcome.reason })
  }

  // Rewrite the manifest so it describes what the batch still holds. Entries that
  // could not be restored stay listed — the batch must never claim to hold
  // something it does not, nor stop claiming something it does.
  const remaining = plan.manifest.entries.filter(
    (entry) => !restored.some((item) => item.relativePath === entry.relativePath),
  )
  let manifestRewrite = null
  // A batch whose record was reconstructed has no manifest on disk at all. Writing
  // it out is how that batch stops being one that a listing cannot describe — and
  // it is worth doing even when every restore was blocked, because the record is
  // then true of what is left rather than absent.
  const persistReconstruction = plan.reconstructed === true && remaining.length > 0
  if (restored.length > 0 || persistReconstruction) {
    if (remaining.length === 0) {
      manifestRewrite = { ok: true, deleted: true, reason: null }
      try {
        unlinkSync(join(batchDir, MANIFEST_NAME))
      } catch (cause) {
        if (cause?.code === 'ENOENT') {
          // Nothing on disk to remove: the batch's manifest was missing already
          // (a reconstruction), and the restore itself succeeded.
          manifestRewrite = { ok: true, deleted: true, alreadyAbsent: true, reason: null }
        } else {
          manifestRewrite = { ok: false, deleted: false, reason: `could not remove the emptied manifest: ${describeCause(cause)}` }
        }
      }
    } else {
      const next = {
        ...plan.manifest,
        entries: remaining,
        totals: {
          entries: remaining.length,
          files: remaining.reduce((sum, entry) => sum + (typeof entry.files === 'number' ? entry.files : 0), 0),
          bytes: remaining.reduce((sum, entry) => sum + (typeof entry.bytes === 'number' ? entry.bytes : 0), 0),
        },
        notes: [
          ...(plan.manifest.notes ?? []),
          `restored ${restored.length} item(s) at ${new Date().toISOString()}; ${remaining.length} remain in this batch`,
        ],
      }
      manifestRewrite = writeManifest(batchDir, next)
    }
  }

  const ok = failed.length === 0
  return {
    ok,
    restored,
    blocked,
    failed,
    reconstructed: plan.reconstructed === true,
    reason: ok
      ? null
      : `${failed.length} item(s) could not be restored and remain in the batch; each failure is listed with its reason`,
    manifestRewrite,
  }
}

/** Move one item back to its original path, verifying whatever it does. */
function moveBack(item) {
  if (!exists(item.batchPath)) {
    return { ok: false, reason: 'the batch item disappeared before it could be moved back' }
  }
  try {
    renameSync(item.batchPath, item.originalPath)
    return { ok: true, method: 'rename' }
  } catch (cause) {
    if (cause?.code !== 'EXDEV') {
      return { ok: false, reason: `could not move the item back: ${describeCause(cause)}` }
    }
    // Cross-volume (a batch copied to another disk): copy → verify → remove the
    // copy, in that order, so the item can never exist zero times.
    if (item.isDirectory) {
      const copy = copyTreeVerified(item.batchPath, item.originalPath)
      if (!copy.verified) {
        return {
          ok: false,
          reason:
            `a cross-volume restore could not be verified (${copy.files} file(s), ${copy.failures.length} ` +
            `failure(s)); the batch still holds the item`,
        }
      }
      const removal = removeTreeVerified(item.batchPath)
      if (removal.failures.length > 0 || removal.stillPresent) {
        return {
          ok: false,
          reason:
            `the item was restored by copy but the batch copy could not be removed (${removal.failures.length} ` +
            'failure(s)); both copies exist and the batch still lists it',
        }
      }
      return { ok: true, method: 'copy-verify-remove' }
    }
    try {
      const sourceInfo = statSync(item.batchPath)
      copyFileSync(item.batchPath, item.originalPath)
      const targetInfo = statSync(item.originalPath)
      if (targetInfo.size !== sourceInfo.size) {
        return { ok: false, reason: `a cross-volume restore does not match the batch copy (${targetInfo.size} vs ${sourceInfo.size} bytes)` }
      }
      unlinkSync(item.batchPath)
      return { ok: true, method: 'copy-verify-remove' }
    } catch (inner) {
      return { ok: false, reason: `cross-volume restore failed: ${describeCause(inner)}` }
    }
  }
}

/**
 * Report what a batch still holds, including the empty directories a completed
 * restore leaves behind.
 */
export function describeRestoreResult(result) {
  return {
    ok: result.ok,
    restored: result.restored.length,
    blocked: result.blocked.length,
    failed: result.failed.length,
    reconstructed: result.reconstructed === true,
    reason: result.reason,
    restoredPaths: result.restored.map((item) => item.originalPath),
    blockedPaths: result.blocked.map((item) => ({ path: item.originalPath, reason: item.reason })),
    failedPaths: result.failed.map((item) => ({ path: item.originalPath, reason: item.reason })),
  }
}

/**
 * Remove the directories a restore emptied, children-first.
 *
 * A batch that has been fully restored should not leave an empty directory tree
 * behind: an empty batch looks like a batch with nothing in it, and the interface
 * would offer to "restore" nothing forever.
 */
export function pruneEmptyDirs(batchDir, options = {}) {
  const removed = []
  const failures = []
  const root = options.keepRoot === true ? batchDir : null
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (cause) {
      failures.push(`${dir} (readdir ${describeCause(cause)})`)
      return
    }
    for (const entry of entries) {
      if (entry.isDirectory()) walk(join(dir, entry.name))
    }
    if (root !== null && dir === root) return
    try {
      rmdirSync(dir)
      removed.push(dir)
    } catch (cause) {
      if (cause?.code !== 'ENOENT' && cause?.code !== 'ENOTEMPTY') {
        failures.push(`${dir} (rmdir ${describeCause(cause)})`)
      }
    }
  }
  if (!exists(batchDir)) return { removed, failures, stillPresent: false }
  walk(batchDir)
  return { removed, failures, stillPresent: exists(batchDir) }
}

export { directoryBytes, directoryFileCount }
