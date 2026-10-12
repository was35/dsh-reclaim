/**
 * One move writes one entry per item: a directory is not also its own children.
 *
 * The reported defect (issue #12): clearing a rebuildable cache *family*
 * directory (`cache-family:request-images`) wrote a manifest that listed the
 * family **and** each subdirectory the batch mirrored beneath it. `POST /restore`
 * then reported `ok: false` for a batch whose bytes were all still there —
 * the family was renamed back first, and every child then found its original
 * path occupied by the parent that had just been restored
 * (`lib/restore.js:219`, "the original path appeared while restoring").
 *
 * `deleteSessionItems` builds the manifest from what it actually moved — one
 * entry, the family directory. But it hands that record to `mergeIntoManifest`
 * (`lib/trash.js:965` → `lib/recover.js`), and the batch holds no manifest
 * yet, so the merge takes its "no record ⇒ read the layout back" branch.
 * Layout reading cannot know where one item ends and the next begins: a
 * directory whose top level holds only directories is split at a deeper level
 * (`lib/recover.js:93`, `descend`), and the union kept both records.
 *
 * The property pinned here — when the move's own record already covers an
 * inferred entry, the inferred entry is not written, because a restore of the
 * covering *directory* brings that entry back anyway. Inferred entries the move
 * says nothing about are still kept: the mirror stays in charge exactly where
 * the move is silent.
 *
 * The same rule runs the other way round, and the file-level clear is where it
 * shows: moving one file out of a directory leaves that directory behind, so
 * reconstruction lists the directory as well — a phantom item, until the user
 * removes the emptied directory before restoring, and then the phantom restores
 * first and its own child fails with the very same message. An inferred
 * directory *above* the moved items is dropped only once every file below it is
 * proven to belong to an entry this move wrote; otherwise that layout is those
 * files' only record and the entry is kept.
 *
 * The malformed manifests already on disk are not rewritten by this change;
 * they are read back as they always were.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { test } from 'node:test'

import { planClearCandidates } from '../lib/clear-objects.js'
import { buildManifest, readManifest, writeManifest } from '../lib/manifest.js'
import { resolveLayout } from '../lib/paths.js'
import { RECONSTRUCTED_NOTE, mergeIntoManifest, reconstructEntries } from '../lib/recover.js'
import { restoreBatch } from '../lib/restore.js'
import { batchIdFor, deleteSessionItems, destinationFor, volumeRootFor } from '../lib/trash.js'

const INSTANT = new Date(2026, 0, 1, 0, 0, 0)
const STAMP = batchIdFor(INSTANT)

function syntheticHome() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-reclaim-entry-boundary-'))
  const layout = resolveLayout({ configuredHome: home })
  return { home, layout, trashRoot: layout.trash.root }
}

function mirrorPath(batchDir, kind, originalPath, home) {
  return destinationFor(batchDir, kind, originalPath, { volumeRoot: volumeRootFor(home) })
}

function mirrorRelative(batchDir, mirror) {
  return relative(batchDir, mirror).split(sep).join('/')
}

function sortedOriginalPaths(manifest) {
  return manifest.entries.map((entry) => entry.originalPath).sort()
}

test('clearing a cache family writes one entry and restores byte for byte', async () => {
  const { home, layout } = syntheticHome()
  try {
    const family = join(home, 'cache', 'attachments', 'request-images')
    const planted = { 'ab/one.bin': 'one\n', 'cd/two.bin': 'two\n' }
    for (const [name, contents] of Object.entries(planted)) {
      mkdirSync(dirname(join(family, name)), { recursive: true })
      writeFileSync(join(family, name), contents)
    }
    const row = {
      id: 'cache-family:request-images',
      kind: 'cache-family',
      batchClearable: true,
      facts: { paths: [family] },
    }
    const plan = planClearCandidates([row], [row.id])
    assert.equal(plan.ok, true, plan.reason ?? '')

    const move = await deleteSessionItems({ layout, items: plan.items })
    assert.equal(move.ok, true, move.reason ?? '')
    assert.equal(move.moved.length, 1)

    const read = readManifest(move.batchDir)
    assert.equal(read.ok, true, read.reason)
    assert.equal(read.incomplete, false, 'the batch is not the manifest-less kind')
    assert.deepEqual(
      sortedOriginalPaths(read.manifest),
      [family],
      'a moved directory is one entry, not also the subdirectories the batch mirrors beneath it',
    )
    assert.equal(read.manifest.entries[0].isDirectory, true)
    assert.equal(read.manifest.reconstructed, undefined)

    const result = await restoreBatch(move.batchDir, { layout })
    assert.equal(result.ok, true, `${result.reason ?? ''} (${result.failed.map((item) => item.originalPath).join(', ')})`)
    assert.equal(result.restored.length, 1)
    assert.equal(result.failed.length, 0)
    for (const [name, contents] of Object.entries(planted)) {
      assert.equal(readFileSync(join(family, name), 'utf8'), contents, `${name} came back byte for byte`)
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('an inferred entry under a directory this move made is not written twice', () => {
  const { home, layout } = syntheticHome()
  try {
    const batchDir = join(layout.trash.root, STAMP)
    const family = join(home, 'cache', 'attachments', 'request-images')
    // The batch already holds the mirrored subtree, with no manifest to explain it.
    const mirror = mirrorPath(batchDir, 'cache', family, home)
    mkdirSync(join(mirror, 'ab'), { recursive: true })
    writeFileSync(join(mirror, 'ab', 'one.bin'), 'one\n')
    assert.deepEqual(
      reconstructEntries(batchDir, { volumeRoot: volumeRootFor(home) }).entries.map((entry) => entry.originalPath),
      [join(family, 'ab')],
      'reading the layout back can only find the deepest directory, never the boundary',
    )

    const written = mergeIntoManifest(
      batchDir,
      buildManifest({
        batchId: STAMP,
        entries: [
          {
            originalPath: family,
            relativePath: mirrorRelative(batchDir, mirror),
            kind: 'cache',
            sessionId: null,
            bytes: 4,
            files: 1,
            isDirectory: true,
            removedAt: INSTANT.toISOString(),
            risk: null,
            note: 'cleared by id cache-family:request-images (cache-family)',
          },
        ],
        volumeRoot: volumeRootFor(home),
      }),
      { volumeRoot: volumeRootFor(home) },
    )
    assert.equal(written.ok, true, written.reason ?? '')

    const read = readManifest(batchDir)
    assert.deepEqual(sortedOriginalPaths(read.manifest), [family])
    assert.equal(written.reconstructed, false, 'the manifest is the move record alone, not a guess')
    assert.equal(read.manifest.reconstructed, undefined, 'no reconstruction note when nothing inferred was kept')
    assert.ok(
      !(read.manifest.notes ?? []).includes(RECONSTRUCTED_NOTE),
      'the layout is not credited for a manifest it did not contribute to',
    )
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('an inferred sibling that only shares a name prefix survives the coverage test', () => {
  const { home, layout } = syntheticHome()
  try {
    const batchDir = join(layout.trash.root, STAMP)
    const family = join(home, 'cache', 'attachments', 'request-images')
    const sibling = join(home, 'cache', 'attachments', 'request-images-old')
    const familyMirror = mirrorPath(batchDir, 'cache', family, home)
    const siblingMirror = mirrorPath(batchDir, 'cache', sibling, home)
    for (const mirror of [familyMirror, siblingMirror]) {
      mkdirSync(join(mirror, 'ab'), { recursive: true })
      writeFileSync(join(mirror, 'ab', 'one.bin'), 'one\n')
    }

    const written = mergeIntoManifest(
      batchDir,
      buildManifest({
        batchId: STAMP,
        entries: [
          {
            originalPath: family,
            relativePath: mirrorRelative(batchDir, familyMirror),
            kind: 'cache',
            sessionId: null,
            bytes: 4,
            files: 1,
            isDirectory: true,
            removedAt: INSTANT.toISOString(),
            risk: null,
            note: 'cleared by id cache-family:request-images (cache-family)',
          },
        ],
        volumeRoot: volumeRootFor(home),
      }),
      { volumeRoot: volumeRootFor(home) },
    )
    assert.equal(written.ok, true, written.reason ?? '')

    const read = readManifest(batchDir)
    assert.deepEqual(
      sortedOriginalPaths(read.manifest),
      [family, join(sibling, 'ab')].sort(),
      'a path that merely starts with the same characters is a different item, not one inside it',
    )
    assert.equal(written.coveredEntries, 1, 'only the guess inside the moved family was covered')
    assert.equal(written.reconstructed, true, 'the sibling is the layout\'s contribution')
    assert.ok((read.manifest.notes ?? []).includes(RECONSTRUCTED_NOTE))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('inferred entries the move says nothing about are all kept', () => {
  const { home, layout } = syntheticHome()
  try {
    const batchDir = join(layout.trash.root, STAMP)
    const family = join(home, 'cache', 'attachments', 'request-images')
    const other = join(home, 'cache', 'attachments', 'pending-images')
    for (const [target, name] of [
      [family, 'one.bin'],
      [other, 'two.bin'],
    ]) {
      const mirror = join(mirrorPath(batchDir, 'cache', target, home), 'ab')
      mkdirSync(mirror, { recursive: true })
      writeFileSync(join(mirror, name), name)
    }

    const written = mergeIntoManifest(
      batchDir,
      buildManifest({
        batchId: STAMP,
        entries: [
          {
            originalPath: family,
            relativePath: mirrorRelative(batchDir, mirrorPath(batchDir, 'cache', family, home)),
            kind: 'cache',
            sessionId: null,
            bytes: 6,
            files: 1,
            isDirectory: true,
            removedAt: INSTANT.toISOString(),
            risk: null,
            note: 'cleared by id cache-family:request-images (cache-family)',
          },
        ],
        volumeRoot: volumeRootFor(home),
      }),
      { volumeRoot: volumeRootFor(home) },
    )
    assert.equal(written.ok, true, written.reason ?? '')

    const read = readManifest(batchDir)
    assert.deepEqual(sortedOriginalPaths(read.manifest), [join(other, 'ab'), family].sort())
    assert.equal(written.coveredEntries, 1)
    assert.equal(written.reconstructed, true)
    assert.ok(existsSync(join(batchDir, mirrorRelative(batchDir, mirrorPath(batchDir, 'cache', other, home)), 'ab', 'two.bin')))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('clearing one file does not also record the directory it was moved out of', async () => {
  const { home, layout } = syntheticHome()
  try {
    const dir = join(home, 'cache', 'attachments', 'request-images')
    const file = join(dir, 'note.bin')
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, 'note\n')
    const row = {
      id: 'cache:note.bin',
      kind: 'cache',
      batchClearable: true,
      facts: { paths: [file] },
    }
    const plan = planClearCandidates([row], [row.id])
    assert.equal(plan.ok, true, plan.reason ?? '')

    const move = await deleteSessionItems({ layout, items: plan.items })
    assert.equal(move.ok, true, move.reason ?? '')
    assert.equal(move.moved.length, 1)

    const read = readManifest(move.batchDir)
    assert.equal(read.ok, true, read.reason)
    assert.deepEqual(
      sortedOriginalPaths(read.manifest),
      [file],
      'the directory around the file was never moved, so it is not an item of this batch',
    )
    assert.equal(read.manifest.entries[0].isDirectory, false)
    assert.equal(read.manifest.reconstructed, undefined)

    // The user tidies up the directory the clear emptied before restoring.
    rmSync(dir, { recursive: true, force: true })
    const result = await restoreBatch(move.batchDir, { layout })
    assert.equal(result.ok, true, `${result.reason ?? ''} (${result.failed.map((item) => item.originalPath).join(', ')})`)
    assert.equal(result.restored.length, 1)
    assert.equal(result.failed.length, 0)
    assert.equal(readFileSync(file, 'utf8'), 'note\n', 'the file came back byte for byte, parent directory and all')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('an inferred directory is kept when it holds files this move did not move', () => {
  const { home, layout } = syntheticHome()
  try {
    const batchDir = join(layout.trash.root, STAMP)
    const dir = join(home, 'cache', 'attachments', 'request-images')
    const file = join(dir, 'note.bin')
    // A stranded item from an earlier manifest-less move, and this move's file.
    const mirror = mirrorPath(batchDir, 'cache', dir, home)
    mkdirSync(join(mirror, 'ab'), { recursive: true })
    writeFileSync(join(mirror, 'ab', 'one.bin'), 'one\n')
    writeFileSync(join(mirror, 'note.bin'), 'note\n')

    const written = mergeIntoManifest(
      batchDir,
      buildManifest({
        batchId: STAMP,
        entries: [
          {
            originalPath: file,
            relativePath: mirrorRelative(batchDir, join(mirror, 'note.bin')),
            kind: 'cache',
            sessionId: null,
            bytes: 5,
            files: 1,
            isDirectory: false,
            removedAt: INSTANT.toISOString(),
            risk: null,
            note: 'cleared by id cache:note.bin (cache)',
          },
        ],
        volumeRoot: volumeRootFor(home),
      }),
      { volumeRoot: volumeRootFor(home) },
    )
    assert.equal(written.ok, true, written.reason ?? '')

    const read = readManifest(batchDir)
    assert.deepEqual(
      sortedOriginalPaths(read.manifest),
      [dir, file].sort(),
      'the directory is the only record of ab/one.bin, so it stays',
    )
    assert.equal(written.coveredEntries, 0, 'nothing was dropped on a guess')
    assert.equal(written.reconstructed, true)
    assert.ok((read.manifest.notes ?? []).includes(RECONSTRUCTED_NOTE))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a manifest already on disk is never rewritten by the coverage rule', () => {
  const { home, layout } = syntheticHome()
  try {
    const batchDir = join(layout.trash.root, STAMP)
    const family = join(home, 'cache', 'attachments', 'request-images')
    const child = join(family, 'ab')
    const later = join(home, 'cache', 'attachments', 'pending-images')
    // An old, readable manifest of exactly the shape issue #12 produced — one
    // entry for the directory and one for its child. Both paths are real records
    // of items that were moved; dropping either is not this fix's business.
    const familyMirror = mirrorPath(batchDir, 'cache', family, home)
    mkdirSync(join(familyMirror, 'ab'), { recursive: true })
    writeFileSync(join(familyMirror, 'ab', 'one.bin'), 'one\n')
    const laterMirror = mirrorPath(batchDir, 'cache', later, home)
    mkdirSync(laterMirror, { recursive: true })
    writeFileSync(join(laterMirror, 'two.bin'), 'two\n')
    const entry = (originalPath, relativePath, isDirectory) => ({
      originalPath,
      relativePath,
      kind: 'cache',
      sessionId: null,
      bytes: 4,
      files: 1,
      isDirectory,
      removedAt: INSTANT.toISOString(),
      risk: null,
      note: 'cleared by id cache-family:request-images (cache-family)',
    })
    assert.equal(
      writeManifest(
        batchDir,
        buildManifest({
          batchId: STAMP,
          entries: [
            entry(family, mirrorRelative(batchDir, familyMirror), true),
            entry(child, mirrorRelative(batchDir, join(familyMirror, 'ab')), true),
          ],
          volumeRoot: volumeRootFor(home),
        }),
      ).ok,
      true,
    )

    const written = mergeIntoManifest(
      batchDir,
      buildManifest({
        batchId: STAMP,
        entries: [entry(later, mirrorRelative(batchDir, laterMirror), true)],
        volumeRoot: volumeRootFor(home),
      }),
      { volumeRoot: volumeRootFor(home) },
    )
    assert.equal(written.ok, true, written.reason ?? '')

    const read = readManifest(batchDir)
    assert.deepEqual(
      sortedOriginalPaths(read.manifest),
      [child, family, later].sort(),
      'the union keeps every record it can read, doubled or not',
    )
    assert.equal(written.reconstructed, false, 'a readable manifest is not second-guessed')
    assert.equal(written.coveredEntries, 0)
    assert.ok(!(read.manifest.notes ?? []).includes(RECONSTRUCTED_NOTE))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
