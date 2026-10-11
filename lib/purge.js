/**
 * dsh-reclaim — permanently deleting a batch from the quarantine.
 *
 * This is the only operation in the entire plugin that destroys user data, and
 * everything about its shape follows from that:
 *
 *   - **It is never automatic.** There is no timer, no schedule and no "clean up
 *     old batches" path anywhere in this plugin. A purge happens because a person
 *     asked for it, naming a batch.
 *   - **The confirmation is not this module's job.** The interface asks
 *     ("permanently delete N items, X MB") and passes `confirmed: true`; this
 *     module deliberately has no opinion about how that question is asked: a
 *     function that purges when called cannot be tricked into being a function
 *     that purges on its own.
 *   - **It reports bytes before it deletes them.** A permanent delete the user
 *     cannot size up first is a permanent delete they cannot consent to.
 *   - **It refuses to interpret.** A batch directory that holds things but no
 *     manifest is reported as incomplete and NOT purged by name; only an explicit
 *     "purge this directory" request touches it, and that request lists what it
 *     is about to destroy.
 *
 * Removal itself uses verified per-entry primitives: measured in this workspace,
 * `rmSync(recursive)` returns normally and deletes nothing, so a purge built on
 * it would report success while leaving everything in place — the mirror image of
 * the failure mode this module exists to avoid.
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { removeTreeVerified, directoryBytes, directoryFileCount, listDir, resolveVolumeRoot, volumeRootFor } from './trash.js'
import { readManifest } from './manifest.js'
import { reconstructEntries } from './recover.js'
import { resolveLayout } from './paths.js'
import { pruneEmptyDirs } from './restore.js'

/** The volume a batch's relative paths are anchored to, from the live layout. */
function volumeRootForLayout(layout) {
  return resolveVolumeRoot(volumeRootFor((layout ?? resolveLayout()).home))
}

/** The session ids a reconstructed item list names, deduplicated. */
function sessionIdsOf(entries) {
  return [...new Set(entries.map((entry) => entry.sessionId).filter((id) => typeof id === 'string'))].sort()
}

function describeCause(cause) {
  if (cause === null || cause === undefined) return String(cause)
  const name = cause?.name ?? 'Error'
  const message = cause?.message ?? String(cause)
  const code = cause?.code === undefined ? '' : ` (code ${String(cause.code)})`
  return `${name}: ${message}${code}`
}

/**
 * Size up a batch before deleting it: what it holds and how much it would free.
 *
 * The numbers come from the manifest when it is readable, and from a real walk
 * when it is not — an incomplete batch still has to be measurable, because
 * "permanently delete this unknown-size thing" is not a question worth asking.
 */
export function describePurge(batchDir, options = {}) {
  if (!existsSync(batchDir)) {
    return { ok: false, batchDir, reason: 'the batch directory does not exist', entries: null, files: null, bytes: null, incomplete: false }
  }
  const read = readManifest(batchDir)
  const files = directoryFileCount(batchDir)
  const bytes = directoryBytes(batchDir)
  if (!read.ok) {
    // A batch with no manifest still knows what it holds: the batch is a mirror of
    // the items' original paths, so the count can be read back off the layout.
    // Reporting "unknown" would hide that the batch is recoverable; reporting a
    // number without saying where it came from would overstate what is known, so
    // the result carries `reconstructed` and the reason names the walk.
    const guess =
      read.incomplete === true
        ? reconstructEntries(batchDir, { volumeRoot: volumeRootForLayout(options.layout) })
        : null
    const inferred = guess !== null && guess.entries.length > 0
    return {
      ok: true,
      batchDir,
      reason: inferred
        ? `${read.reason}; ${guess.entries.length} item(s) were read back from the batch layout and can be restored`
        : read.reason,
      manifestReadable: false,
      incomplete: read.incomplete,
      reconstructed: inferred,
      recoverable: inferred,
      issues: read.issues,
      entries: inferred ? guess.entries.length : null,
      files,
      bytes,
      sessionIds: inferred ? sessionIdsOf(guess.entries) : [],
      wouldDestroy: inferred
        ? `${guess.entries.length} reconstructed item(s), ${files} file(s), ${bytes} B`
        : `${files} file(s), ${bytes} B`,
    }
  }
  return {
    ok: true,
    batchDir,
    reason: null,
    manifestReadable: true,
    incomplete: false,
    issues: [],
    entries: read.manifest.entries.length,
    files: read.manifest.totals?.files ?? files,
    bytes: read.manifest.totals?.bytes ?? bytes,
    sessionIds: read.manifest.sessionIds ?? [],
    createdAt: read.manifest.createdAt ?? null,
    wouldDestroy: `${read.manifest.entries.length} item(s), ${read.manifest.totals?.files ?? files} file(s), ${read.manifest.totals?.bytes ?? bytes} B`,
  }
}

/**
 * Permanently remove one batch directory.
 *
 * @param {string} batchDir
 * @param {object} [options]
 * @param {boolean} [options.confirmed] - must be `true`; a purge without an
 *   explicit confirmation is refused, so no caller can reach destruction by
 *   accident or by a default argument.
 * @param {boolean} [options.pruneEmptyParents] - remove the batch's emptied
 *   parent directories (the trash root included when it is empty), so a purge
 *   does not leave a 0-byte batch behind.
 * @returns {{ ok: boolean, removed: object|null, failures: string[], reason: string|null, pruned: object|null }}
 */
export function purgeBatch(batchDir, options = {}) {
  if (options.confirmed !== true) {
    return {
      ok: false,
      removed: null,
      failures: [],
      reason:
        'a permanent delete requires an explicit confirmation; this call did not carry one, so nothing was ' +
        'touched (the interface is responsible for asking the user first)',
      pruned: null,
    }
  }
  if (!existsSync(batchDir)) {
    return { ok: false, removed: null, failures: [], reason: 'the batch directory does not exist', pruned: null }
  }

  const before = describePurge(batchDir)
  const removal = removeTreeVerified(batchDir)
  // The emptied parents must be pruned from the TRASH ROOT, not from the batch
  // directory: the batch directory has just been removed, so walking it removes
  // nothing and leaves `<home>/.dsh-reclaim-trash/` behind as an empty shell.
  // Measured — the first version did exactly that and the root survived every
  // purge, so a user who cleared everything still saw a quarantine directory.
  const pruneFrom = parentOf(batchDir)
  const pruned = options.pruneEmptyParents === false
    ? null
    : pruneEmptyDirs(pruneFrom, { keepRoot: false })

  const ok = !removal.stillPresent && removal.failures.length === 0
  return {
    ok,
    removed: {
      batchDir,
      files: removal.files,
      bytes: removal.bytes,
      dirs: removal.dirs,
      entriesBefore: before.entries,
      sessionIds: before.sessionIds ?? [],
    },
    failures: removal.failures,
    reason: ok
      ? null
      : `the batch could not be fully removed (${removal.failures.length} failure(s), stillPresent=${removal.stillPresent}); ` +
        'nothing is hidden: the remaining paths are listed',
    pruned,
  }
}

/**
 * List every batch under the quarantine root.
 *
 * Three kinds of entry exist and all three are reported, because the difference
 * between them is what tells a user where their data is:
 *
 *   - **`ok`** — a batch with a readable, self-consistent manifest;
 *   - **`incomplete`** — a directory with contents and no manifest: an
 *     interrupted move. Reported, never auto-cleaned;
 *   - **`unreadable`** — a manifest that exists but does not describe its batch
 *     (schema drift, or a hand edit). Also reported rather than repaired.
 *
 * A stray *file* directly under the root is reported too: it is not a batch
 * directory, and silently ignoring it would hide the one artifact a bug would
 * most likely leave behind.
 */
export function listBatches(layout) {
  const root = layout?.trash?.root
  if (typeof root !== 'string' || root.length === 0) {
    return { ok: false, root: null, batches: [], strayFiles: [], reason: 'the layout does not expose a trash root' }
  }
  if (!existsSync(root)) {
    return { ok: true, root, batches: [], strayFiles: [], reason: null, exists: false }
  }
  const listed = listDir(root)
  if (!listed.ok) {
    // A root that cannot be listed must not look like an empty quarantine.
    return { ok: false, root, batches: [], strayFiles: [], reason: listed.reason, exists: true }
  }

  const batches = []
  const strayFiles = []
  for (const entry of listed.entries) {
    const full = join(root, entry.name)
    if (!entry.isDirectory()) {
      strayFiles.push({ path: full, kind: entry.isSymbolicLink() ? 'link' : 'file' })
      continue
    }
    const read = readManifest(full)
    if (read.ok) {
      const manifest = read.manifest
      batches.push({
        kind: 'ok',
        batchDir: full,
        batchId: manifest.batchId,
        createdAt: manifest.createdAt ?? null,
        entries: manifest.entries.length,
        sessionIds: manifest.sessionIds ?? [],
        files: manifest.totals?.files ?? null,
        bytes: manifest.totals?.bytes ?? null,
        reason: null,
      })
      continue
    }
    const files = directoryFileCount(full)
    const bytes = directoryBytes(full)
    const guess =
      read.incomplete === true ? reconstructEntries(full, { volumeRoot: volumeRootForLayout(layout) }) : null
    const inferred = guess !== null && guess.entries.length > 0
    batches.push({
      kind: read.incomplete ? 'incomplete' : 'unreadable',
      batchDir: full,
      batchId: entry.name,
      createdAt: null,
      entries: inferred ? guess.entries.length : null,
      reconstructed: inferred,
      recoverable: inferred,
      sessionIds: inferred ? sessionIdsOf(guess.entries) : [],
      files,
      bytes,
      reason: inferred
        ? `${read.reason}; ${guess.entries.length} item(s) were read back from the batch layout and can be restored`
        : read.reason,
      issues: read.issues,
    })
  }

  // Newest first: a batch listing exists to answer "what did I just delete".
  batches.sort((left, right) => String(right.batchId).localeCompare(String(left.batchId)))
  return { ok: true, root, exists: true, batches, strayFiles, reason: null }
}

/**
 * The quarantine's own footprint, as the interface must show it.
 *
 * Two numbers, not one: the design requires "original data / quarantine" to be
 * reported separately and the net release to be derived, because otherwise a user
 * who clears 50 MB sees total usage go UP by 50 MB and concludes the plugin lied.
 */
export function trashFootprint(layout) {
  const listed = listBatches(layout)
  if (!listed.ok) {
    return {
      ok: false,
      reason: listed.reason,
      root: listed.root,
      batches: null,
      files: null,
      bytes: null,
      incompleteBatches: null,
    }
  }
  const bytes = listed.batches.reduce((sum, batch) => sum + (typeof batch.bytes === 'number' ? batch.bytes : 0), 0)
  const files = listed.batches.reduce((sum, batch) => sum + (typeof batch.files === 'number' ? batch.files : 0), 0)
  return {
    ok: true,
    reason: null,
    root: listed.root,
    exists: listed.exists === true,
    batches: listed.batches.length,
    completeBatches: listed.batches.filter((batch) => batch.kind === 'ok').length,
    incompleteBatches: listed.batches.filter((batch) => batch.kind === 'incomplete').length,
    unreadableBatches: listed.batches.filter((batch) => batch.kind === 'unreadable').length,
    strayFiles: listed.strayFiles.length,
    files,
    bytes,
    sessionIds: [...new Set(listed.batches.flatMap((batch) => batch.sessionIds))].sort(),
    note:
      'these bytes are still on disk: a quarantine is not a delete. The interface must show this separately ' +
      'from the live tree and derive the net release from both.',
  }
}

/** Every batch directory name under the root, for a caller that wants paths only. */
export function batchDirs(layout) {
  const listed = listBatches(layout)
  return listed.batches.map((batch) => batch.batchDir)
}

/** The directory that contains a batch directory. */
function parentOf(path) {
  return dirname(path)
}
