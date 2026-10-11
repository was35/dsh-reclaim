/**
 * The batch directory is one operation's record, and the record keeps up.
 *
 * The reported defect (issue #1): a batch directory is named from `batchIdFor`
 * (`lib/trash.js:99`, second resolution) and the UI moves one object per
 * `POST /delete` call, so several moves in the same second shared one directory
 * — and each move wrote its manifest from scratch over the previous one
 * (`lib/trash.js` wrote `writeManifest(batchDir, manifest)` unconditionally).
 * The items moved first lost their only record of where they came from, the
 * batch became "a directory holding data with no manifest", and the UI's restore
 * button answered `the batch has no manifest` (0 restored / 0 blocked / 0
 * failed) for items that were sitting right there.
 *
 * These tests pin the three properties that together make that impossible:
 *
 *   1. a directory is claimed per operation — a second operation in the same
 *      second gets its own name (`<stamp>-2`), and never inherits a batch that
 *      belongs to another session or that it cannot describe;
 *   2. the manifest is a UNION of what the directory holds, never a replacement;
 *   3. a batch that has no manifest anyway is read back off its own layout, so
 *      it can be restored instead of being reported as unrestorable.
 *
 * The invariant asserted throughout: everything standing in the batch directory
 * is named in the manifest (`entries ⊆ manifest`), which is exactly what the
 * lost record violated.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { MANIFEST_NAME, readManifest } from '../lib/manifest.js'
import { resolveLayout } from '../lib/paths.js'
import { listBatches } from '../lib/purge.js'
import { planRestore, restoreBatch } from '../lib/restore.js'
import { deleteSessionItems, batchIdFor, destinationFor, volumeRootFor } from '../lib/trash.js'

/** A fixed instant: the collision only happens when the second is shared. */
const INSTANT = new Date(2026, 0, 1, 0, 0, 0)
/** Batch ids are LOCAL time (`lib/trash.js:105`), so derive rather than spell it. */
const STAMP = batchIdFor(INSTANT)

/** A disposable DSH home plus the layout the plugin would derive from it. */
function syntheticHome() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-reclaim-batch-record-'))
  const layout = resolveLayout({ configuredHome: home })
  return { home, layout, trashRoot: layout.trash.root }
}

/** Create a directory at `path` holding one file, and return the path. */
function objectAt(path, name = 'state.json') {
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, name), JSON.stringify({ path }))
  return path
}

/** Where production would have mirrored `originalPath` inside `batchDir`. */
function mirrorPath(batchDir, kind, originalPath, home) {
  return destinationFor(batchDir, kind, originalPath, { volumeRoot: volumeRootFor(home) })
}

/** Every relative path the manifest names; the batch's own inventory of itself. */
function listedRelativePaths(batchDir) {
  const read = readManifest(batchDir)
  assert.equal(read.ok, true, `expected a readable manifest in ${batchDir}: ${read.reason}`)
  return read.manifest.entries.map((entry) => entry.relativePath)
}

/** The invariant: every listed item really is inside the batch directory. */
function assertManifestDescribesTheDirectory(batchDir) {
  for (const relativePath of listedRelativePaths(batchDir)) {
    assert.equal(existsSync(join(batchDir, relativePath)), true, `${relativePath} is listed but not in the batch`)
  }
}

test('two sessions moved in the same second claim two batch directories', async () => {
  const { home, layout, trashRoot } = syntheticHome()
  try {
    const sessionA = objectAt(join(home, 'sessions', 'proj', 'sess-a'))
    const sessionB = objectAt(join(home, 'sessions', 'proj', 'sess-b'))

    const first = await deleteSessionItems({
      layout,
      instant: INSTANT,
      sessionId: 'a',
      items: [{ path: sessionA, kind: 'session' }],
    })
    const second = await deleteSessionItems({
      layout,
      instant: INSTANT,
      sessionId: 'b',
      items: [{ path: sessionB, kind: 'session' }],
    })

    assert.equal(first.ok, true, first.reason ?? '')
    assert.equal(second.ok, true, second.reason ?? '')
    assert.equal(first.batchId, STAMP)
    assert.equal(second.batchId, `${STAMP}-2`, 'the second move must not inherit the first move\'s batch')
    assert.notEqual(first.batchDir, second.batchDir)

    // Each record names its own item and nothing else — neither was overwritten.
    assert.deepEqual(listedRelativePaths(first.batchDir), [first.moved[0].relativePath])
    assert.deepEqual(listedRelativePaths(second.batchDir), [second.moved[0].relativePath])
    assertManifestDescribesTheDirectory(first.batchDir)
    assertManifestDescribesTheDirectory(second.batchDir)

    assert.equal(existsSync(sessionA), false)
    assert.equal(existsSync(sessionB), false)
    assert.equal(existsSync(join(trashRoot, `${STAMP}-2`)), true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a later move of the same session joins its batch and the manifest keeps both items', async () => {
  const { home, layout } = syntheticHome()
  try {
    const session = objectAt(join(home, 'sessions', 'proj', 'sess-a'))
    const attachment = objectAt(join(home, 'attachments', 'att-1'))

    const first = await deleteSessionItems({
      layout,
      instant: INSTANT,
      sessionId: 'a',
      items: [{ path: session, kind: 'session' }],
    })
    const second = await deleteSessionItems({
      layout,
      instant: INSTANT,
      sessionId: 'a',
      items: [{ path: attachment, kind: 'attachment' }],
    })

    assert.equal(first.ok, true, first.reason ?? '')
    assert.equal(second.ok, true, second.reason ?? '')
    assert.equal(second.batchDir, first.batchDir, 'the same session should keep one batch')
    assert.equal(second.manifestEntries, 2, 'the second item must be added, not replace the first')
    assert.deepEqual(listedRelativePaths(first.batchDir).sort(), [first.moved[0].relativePath, second.moved[0].relativePath].sort())
    assertManifestDescribesTheDirectory(first.batchDir)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('session-less moves in the same second accumulate instead of overwriting one another', async () => {
  const { home, layout } = syntheticHome()
  try {
    // The `/clear` shape: one POST per object, no session id to tell them apart.
    const one = objectAt(join(home, 'session-caches', 'cache-1'))
    const two = objectAt(join(home, 'caches', 'cache-2'))

    const first = await deleteSessionItems({ layout, instant: INSTANT, items: [{ path: one, kind: 'session-cache' }] })
    const second = await deleteSessionItems({ layout, instant: INSTANT, items: [{ path: two, kind: 'cache' }] })

    assert.equal(first.ok, true, first.reason ?? '')
    assert.equal(second.ok, true, second.reason ?? '')
    assert.equal(second.batchDir, first.batchDir)
    assert.equal(second.manifestEntries, 2)

    // The regression itself: both originals are still recoverable, in order.
    const read = readManifest(first.batchDir)
    assert.equal(read.ok, true)
    assert.deepEqual(
      read.manifest.entries.map((entry) => entry.originalPath).sort(),
      [one, two].sort(),
    )
    assertManifestDescribesTheDirectory(first.batchDir)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a batch that cannot be described is left alone rather than written into', async () => {
  const { home, layout, trashRoot } = syntheticHome()
  try {
    // An old batch whose manifest never survived: the items are inside, and only
    // the layout says so. Adding to it would bury them under a record that does
    // not mention them.
    const abandoned = join(trashRoot, STAMP)
    const buried = join(abandoned, 'sessions', 'junk')
    mkdirSync(buried, { recursive: true })
    writeFileSync(join(buried, 'payload.bin'), 'still here')

    const session = objectAt(join(home, 'sessions', 'proj', 'sess-a'))
    const result = await deleteSessionItems({
      layout,
      instant: INSTANT,
      sessionId: 'a',
      items: [{ path: session, kind: 'session' }],
    })

    assert.equal(result.ok, true, result.reason ?? '')
    assert.equal(result.batchId, `${STAMP}-2`, 'the undescribable batch must not be reused')
    assert.equal(existsSync(join(abandoned, MANIFEST_NAME)), false, 'the abandoned batch stays as it was')
    assert.equal(readFileSync(join(buried, 'payload.bin'), 'utf8'), 'still here')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a batch with no manifest is planned from its layout, restored, and recorded on the way out', async () => {
  const { home, layout, trashRoot } = syntheticHome()
  try {
    const batchDir = join(trashRoot, STAMP)
    const restorableOriginal = join(home, 'sessions', 'proj', 'sess-a')
    const blockedOriginal = join(home, 'sessions', 'proj', 'sess-b')
    mkdirSync(join(home, 'sessions', 'proj'), { recursive: true })
    writeFileSync(blockedOriginal, 'occupying the target')

    const restorableMirror = mirrorPath(batchDir, 'session', restorableOriginal, home)
    const blockedMirror = mirrorPath(batchDir, 'session', blockedOriginal, home)
    mkdirSync(restorableMirror, { recursive: true })
    writeFileSync(join(restorableMirror, 'state.json'), '{"session":"a"}')
    mkdirSync(blockedMirror, { recursive: true })
    writeFileSync(join(blockedMirror, 'state.json'), '{"session":"b"}')

    const plan = await planRestore(batchDir, { layout })
    assert.equal(plan.ok, true, plan.reason ?? '')
    assert.equal(plan.reconstructed, true)
    assert.deepEqual(plan.counts, { pending: 1, blocked: 1, total: 2 })
    assert.deepEqual(
      plan.items.map((item) => [item.originalPath, item.status]).sort(),
      [
        [blockedOriginal, 'target-occupied'],
        [restorableOriginal, 'pending'],
      ].sort(),
    )

    const result = await restoreBatch(batchDir, { layout })
    assert.equal(result.reconstructed, true)
    assert.equal(result.restored.length, 1)
    assert.equal(result.blocked.length, 1)
    assert.equal(readFileSync(join(restorableOriginal, 'state.json'), 'utf8'), '{"session":"a"}')

    // The blocked item means the batch survives — and it now carries a record, so
    // it is no longer a batch that a listing can only shrug at.
    assert.equal(existsSync(join(batchDir, MANIFEST_NAME)), true, 'the reconstructed record must be written back')
    const read = readManifest(batchDir)
    assert.equal(read.ok, true, read.reason)
    assert.deepEqual(
      read.manifest.entries.map((entry) => entry.originalPath),
      [blockedOriginal],
    )
    assertManifestDescribesTheDirectory(batchDir)

    const again = await planRestore(batchDir, { layout })
    assert.equal(again.ok, true, again.reason ?? '')
    assert.equal(again.reconstructed, false, 'a batch with a record is not reconstructed')
    assert.deepEqual(again.counts, { pending: 0, blocked: 1, total: 1 })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a listing counts the items of a manifest-less batch instead of reporting unknown', async () => {
  const { home, layout, trashRoot } = syntheticHome()
  try {
    const batchDir = join(trashRoot, STAMP)
    const sessionOriginal = join(home, 'sessions', 'proj', 'sess-a')
    const cacheOriginal = join(home, 'session-caches', 'cache-1')
    for (const [kind, original] of [
      ['session', sessionOriginal],
      ['session-cache', cacheOriginal],
    ]) {
      const mirror = mirrorPath(batchDir, kind, original, home)
      mkdirSync(mirror, { recursive: true })
      writeFileSync(join(mirror, 'state.json'), '{}')
    }

    const row = listBatches(layout).batches.find((batch) => batch.batchId === STAMP)
    assert.ok(row, 'the batch must be listed')
    assert.equal(row.kind, 'incomplete')
    assert.equal(row.entries, 2, 'the count comes from the layout, not from "unknown"')
    assert.equal(row.reconstructed, true)
    assert.equal(row.recoverable, true)
    assert.deepEqual(row.sessionIds, ['sess-a'], 'only the sessions kind names a session')
    assert.match(row.reason, /read back from the batch layout and can be restored/)
    assert.equal(typeof row.files, 'number')
    assert.equal(typeof row.bytes, 'number')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
