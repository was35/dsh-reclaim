/**
 * dsh-reclaim — reading a batch's record back off the batch itself.
 *
 * ## Why this module exists
 *
 * The manifest is the only place a batch records *where each item came from*. The
 * bytes survive without it, but nothing can put them back: a restore reads the
 * manifest and nothing else. A batch whose manifest was never written — or was
 * replaced by a second move that landed in the same one-second batch id — reports
 * `the batch has no manifest` with 0 restored, 0 blocked, 0 failed, and the user
 * is left with a quarantine they cannot empty back out.
 *
 * A batch, however, is a **mirror**, not a blob. An item moved into it lands at
 * `<batchDir>/<kind subdir>/<path relative to the volume root>` (see
 * `destinationFor` in `lib/trash.js`), so the original path is still written on
 * disk in the directory names. This module reads it back:
 *
 *   - `reconstructEntries()` rebuilds the entry list of a batch whose manifest is
 *     missing, so `planRestore` can offer it and a listing can count it;
 *   - `mergeIntoManifest()` writes a manifest as a **union** with what the
 *     directory already held, so a second move into the same batch adds entries
 *     instead of erasing the first move's record. The erasing half is the bug
 *     this pair exists for; the union half is the guard against repeating it.
 *
 * ## What reconstruction cannot know
 *
 * The mirror does not record where one item ends and the next begins. The rule
 * used here is structural: a directory that directly holds a non-directory entry
 * is an item, an empty directory is an item, and a directory that holds only
 * directories is a mirror parent, descended into. An item whose own top level
 * holds nothing but directories is therefore split at a deeper level; its pieces
 * restore into the (still absent) original directory, recreating the tree
 * piecewise rather than moving it in one step. Everything produced here carries
 * `inferred: true` and the manifest carries a note saying so — a reconstruction
 * never pretends to be the record the move wrote.
 *
 * ## Where the move's own record beats the guess
 *
 * A move *does* know the boundaries of the items it just moved: it writes one
 * entry per item, each one carrying `isDirectory`. So when a merge has to read
 * the layout back, those entries decide the overlapping ground, in both
 * directions. An inferred entry *below* a directory this move moved is dropped,
 * because a restore of the directory brings that entry back anyway, and keeping
 * both makes a whole batch report a conflict for bytes that never went missing
 * (issue #12: a cleared cache-family directory was also listed as each of its
 * subdirectories, so the parent was restored first and every child then found
 * its original path occupied). An inferred directory *above* the moved items is
 * dropped too — but only once every file below it is proven to belong to an item
 * this move moved, since otherwise that layout is those files' only record: the
 * directory is scaffolding the move created, not an item anything moved out of.
 * The layout stays in charge exactly where the move is silent: entries it does
 * not cover are still kept, so a batch holding items from an earlier
 * manifest-less move is still healed by the next one.
 */

import { readdirSync } from 'node:fs'
import { join } from 'node:path'

import { directoryBytes, directoryFileCount } from './measure.js'
import {
  DEFAULT_KIND_SUBDIRS,
  KIND_SUBDIR_BY_KIND,
  buildManifest,
  readManifest,
  relativePathInside,
  writeManifest,
} from './manifest.js'
import { isUnder } from './paths.js'

/** The kind whose subdirectory an item came from, inverted for the layout walk. */
const KIND_BY_SUBDIR = Object.freeze(
  Object.fromEntries(Object.entries(KIND_SUBDIR_BY_KIND).map(([kind, subdir]) => [subdir, kind])),
)

/** Stamped into a reconstructed manifest, so a reader can see what it is. */
export const RECONSTRUCTED_NOTE =
  'this manifest was reconstructed from the batch directory layout: the record written by the move that created ' +
  'this batch is missing or unreadable, so original paths were read back from the mirror layout and item boundaries ' +
  'were inferred (an item is a directory holding at least one file, or an empty directory)'

/**
 * The items directly inside one kind subdirectory.
 *
 * Returns segment lists below the subdirectory root — for
 * `<batchDir>/sessions/Users/me/.dsh/sessions/ws/id` the tail is
 * `['Users', 'me', '.dsh', 'sessions', 'ws', 'id']`.
 */
function collectItemTails(root) {
  const found = []
  descend(root, [], found)
  return found
}

function descend(dir, tail, found) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    // A subdirectory that cannot be listed holds nothing we can name. The caller
    // reports the batch by what it could read, never as empty.
    return
  }
  const files = entries.filter((entry) => !entry.isDirectory())
  const dirs = entries.filter((entry) => entry.isDirectory())
  if (tail.length > 0) {
    if (files.length > 0 || dirs.length === 0) {
      // Holds something flat (or is empty): this is where an item starts, and
      // anything below it belongs to that item, so do not descend further.
      found.push({ tail, isDirectory: true })
      return
    }
    // Only directories at this level: a mirror parent, not an item.
  } else if (files.length > 0) {
    // A move always lands an item at least one segment below the kind
    // subdirectory, so files directly here cannot come from this plugin; if they
    // are present, each one is treated as its own item rather than ignored.
    for (const file of files) found.push({ tail: [file.name], isDirectory: false })
  }
  for (const sub of dirs) descend(join(dir, sub.name), [...tail, sub.name], found)
}

/**
 * The items a batch directory still holds, read back from its layout.
 *
 * @param {string} batchDir
 * @param {object} options
 * @param {string} options.volumeRoot - the root the batch's relative paths are
 *   anchored to. Without it original paths cannot be named, so the caller gets an
 *   explicit failure rather than a guess built on the current working directory.
 * @returns {{ok: boolean, entries: object[], subdirs: string[], issues: string[], reason: string|null}}
 */
export function reconstructEntries(batchDir, options = {}) {
  const volumeRoot = options.volumeRoot
  if (typeof volumeRoot !== 'string' || volumeRoot.length === 0) {
    return {
      ok: false,
      entries: [],
      subdirs: [],
      issues: [],
      reason: 'the volume root is required to read original paths back off the batch layout',
    }
  }
  const entries = []
  const issues = []
  const subdirs = []
  for (const subdir of DEFAULT_KIND_SUBDIRS) {
    const tails = collectItemTails(join(batchDir, subdir))
    if (tails.length === 0) continue
    subdirs.push(subdir)
    const kind = KIND_BY_SUBDIR[subdir] ?? 'other'
    for (const item of tails) {
      const relativePath = [subdir, ...item.tail].join('/')
      if (!relativePathInside(batchDir, relativePath).inside) {
        issues.push(`${relativePath} does not resolve inside the batch directory; it is left alone`)
        continue
      }
      const leaf = item.tail[item.tail.length - 1]
      const target = join(batchDir, ...relativePath.split('/'))
      entries.push({
        originalPath: join(volumeRoot, ...item.tail),
        relativePath,
        kind,
        // Only a session item's leaf names a session: a session lives at
        // `sessions/<workspace>/<session id>`, whereas a cache or attachment leaf
        // is a file name. Nothing is invented for the other kinds.
        sessionId: kind === 'session' ? leaf : null,
        bytes: directoryBytes(target),
        files: directoryFileCount(target),
        isDirectory: item.isDirectory,
        // The move time was recorded only in the manifest that is missing.
        removedAt: null,
        risk: null,
        inferred: true,
        note: 'reconstructed from the batch directory layout; the move that put this item here left no manifest entry',
      })
    }
  }
  return { ok: true, entries, subdirs, issues, reason: null }
}

/** One entry per relative path; a newer record for the same path wins. */
export function unionEntries(existing, incoming) {
  const byPath = new Map()
  for (const entry of existing ?? []) byPath.set(entry.relativePath, entry)
  for (const entry of incoming ?? []) byPath.set(entry.relativePath, entry)
  return [...byPath.values()]
}

/**
 * The path itself, or one below it.
 *
 * Containment is the same lexical gate the rest of the plugin uses
 * ({@link isUnder} in `lib/paths.js`): both sides are paths one move produced,
 * so nothing needs reconciling on disk, and the parent-traversal check keeps a
 * sibling that merely shares a prefix (`request-images-old` next to
 * `request-images`) from being swept in. Case is deliberately not folded: both
 * sides are built from the one source string the move was given (the mirror's
 * directory names are that path's segments), so a case difference means two
 * genuinely different items — and dropping a record for a different item is the
 * one outcome this must never produce.
 */
function isAtOrInside(root, candidate) {
  return root === candidate || isUnder(root, candidate)
}

/**
 * Every file below `dir`, named relative to the batch root; `null` when
 * unreadable. Note the contract difference from `descend()` above: that walk
 * *lists* a layout and may skip a directory it cannot read (recording the fact
 * in `issues`), whereas this one *licenses dropping a record*, so "I could not
 * read it" and "there is nothing in it" must not collapse into the same answer
 * — an unreadable directory returns `null` and the caller keeps the entry.
 */
function listFilesUnder(dir, prefix, out) {
  let children
  try {
    children = readdirSync(dir, { withFileTypes: true })
  } catch {
    // Nothing can be proven about what is down there, so nothing may be dropped
    // on its account.
    return null
  }
  for (const child of children) {
    const childPath = `${prefix}/${child.name}`
    if (child.isDirectory()) {
      if (listFilesUnder(join(dir, child.name), childPath, out) === null) return null
    } else {
      out.push(childPath)
    }
  }
  return out
}

/**
 * The inferred entry is one the move's own record already accounts for, in
 * either direction of nesting:
 *
 *   - **below** a directory this move moved: a restore of that directory brings
 *     everything the inferred entry describes back with it;
 *   - **above** the items this move moved, as the scaffolding the move created
 *     to hold them: the move's own entries rebuild that tree (a restore creates
 *     the parent directories it needs), so keeping the inferred record would only
 *     add a phantom item for a directory that was never moved out. A single-file
 *     clear shows this directly: the file is moved, the directory around it is
 *     left in place, and reconstruction lists the directory too — until the
 *     emptied directory is removed, and then that phantom item restores first and
 *     makes its own child fail with "the original path appeared while restoring".
 *
 * The upward direction is proven, never assumed: every file below the inferred
 * directory must belong to an entry this move wrote. If even one does not, the
 * layout is that file's only record and the entry stays.
 */
function coveredByMove(entry, movedEntries, batchDir) {
  if (typeof entry?.originalPath !== 'string') return false
  const moved = movedEntries ?? []
  const below = moved.some(
    (item) =>
      item?.isDirectory === true &&
      typeof item.originalPath === 'string' &&
      isUnder(item.originalPath, entry.originalPath),
  )
  if (below) return true

  if (entry.isDirectory !== true || typeof entry.relativePath !== 'string') return false
  const inside = moved.filter(
    (item) => typeof item?.relativePath === 'string' && isUnder(entry.relativePath, item.relativePath),
  )
  if (inside.length === 0) return false
  const files = listFilesUnder(join(batchDir, ...entry.relativePath.split('/')), entry.relativePath, [])
  if (files === null || files.length === 0) return false
  return files.every((file) => inside.some((item) => isAtOrInside(item.relativePath, file)))
}

/**
 * Write `candidate` as a union with whatever the batch directory already holds.
 *
 * This is the only write path a move uses, and it is deliberately not
 * "writeManifest(candidate)": a manifest describes the whole batch, so replacing
 * it with a manifest that lists only the newest call's items throws away every
 * path recorded before it — silently, and with the bytes still on disk. Merging
 * makes that impossible; when the existing manifest is missing or unreadable the
 * union is taken from the directory layout instead, which is also how a stranded
 * batch is healed by the next move into it.
 *
 * The layout half of that union is a guess, so the move's own entries win where
 * the two overlap: an inferred entry the move's entries already account for is
 * not written (see {@link coveredByMove}). The manifest then says exactly what
 * the move did, plus what the layout had to offer that the move did not touch.
 *
 * @param {string} batchDir
 * @param {object} candidate - a manifest from `buildManifest`, listing this
 *   call's move only
 * @param {object} [options]
 * @param {string} [options.volumeRoot]
 * @returns {{ok: boolean, path: string|null, reason: string|null, merged: boolean,
 *   reconstructed: boolean, coveredEntries: number, entriesBefore: number,
 *   entriesAfter: number, missing: string[]}}
 */
export function mergeIntoManifest(batchDir, candidate, options = {}) {
  const volumeRoot =
    typeof options.volumeRoot === 'string' && options.volumeRoot.length > 0
      ? options.volumeRoot
      : candidate?.volumeRoot
  const read = readManifest(batchDir)
  const issues = []
  let existing = read.ok ? read.manifest : null
  let reconstructed = false
  let coveredEntries = 0

  if (existing === null) {
    const guess = reconstructEntries(batchDir, { volumeRoot })
    issues.push(...guess.issues)
    // The move's own entries decide the boundaries on the ground they cover; the
    // rest of the layout is still read back, because a batch this move did not
    // describe in full is exactly the case reconstruction exists for.
    const moved = candidate?.entries ?? []
    const kept = guess.entries.filter((entry) => !coveredByMove(entry, moved, batchDir))
    coveredEntries = guess.entries.length - kept.length
    if (kept.length > 0) {
      // The directory holds items this move does not account for and there is no
      // readable record of them. Build the base from those, then union the move.
      reconstructed = true
      existing = buildManifest({
        batchId: candidate?.batchId ?? null,
        entries: kept,
        volumeRoot,
        notes: [],
      })
    }
  }

  if (
    existing !== null &&
    typeof existing.volumeRoot === 'string' &&
    typeof volumeRoot === 'string' &&
    existing.volumeRoot !== volumeRoot
  ) {
    // Two volume roots in one batch would give entries whose recorded paths
    // cannot both be right. Refuse loudly; the caller has already moved the
    // items, and a later reconstruction can still read them off the layout.
    return {
      ok: false,
      path: null,
      reason:
        `the batch already describes items under volume root ${existing.volumeRoot}, but this move is under ` +
        `${volumeRoot}; the two cannot share one manifest`,
      merged: false,
      reconstructed,
      coveredEntries,
      entriesBefore: existing.entries.length,
      entriesAfter: 0,
      missing: [],
    }
  }

  const baseEntries = existing?.entries ?? []
  const merged = unionEntries(baseEntries, candidate?.entries ?? [])
  const manifest = buildManifest({
    batchId: candidate?.batchId ?? existing?.batchId ?? null,
    createdAt: existing?.createdAt ?? candidate?.createdAt,
    entries: merged,
    volumeRoot,
    sessionAccounting: existing?.sessionAccounting ?? candidate?.sessionAccounting ?? null,
    notes: [
      ...(reconstructed ? [RECONSTRUCTED_NOTE] : []),
      ...(existing?.notes ?? []),
      ...(candidate?.notes ?? []),
    ],
  })
  if (reconstructed) {
    manifest.reconstructed = true
    manifest.reconstructionIssues = issues
  }

  const written = writeManifest(batchDir, manifest)
  if (!written.ok) {
    return {
      ok: false,
      path: written.path,
      reason: written.reason,
      merged: false,
      reconstructed,
      coveredEntries,
      entriesBefore: baseEntries.length,
      entriesAfter: merged.length,
      missing: [],
    }
  }

  // Verify rather than assume: re-read what was written and require every entry
  // this call moved into the batch to be present in it.
  const verified = readManifest(batchDir)
  const missing = (candidate?.entries ?? [])
    .filter((entry) => !verified.ok || !verified.manifest.entries.some((held) => held.relativePath === entry.relativePath))
    .map((entry) => entry.relativePath)
  return {
    ok: verified.ok && missing.length === 0,
    path: written.path,
    reason: !verified.ok
      ? `the manifest was written but could not be read back: ${verified.reason}`
      : missing.length > 0
        ? `the manifest was written but does not record ${missing.length} item(s) that were moved`
        : null,
    merged: true,
    reconstructed,
    coveredEntries,
    entriesBefore: baseEntries.length,
    entriesAfter: merged.length,
    missing,
  }
}
