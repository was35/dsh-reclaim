/**
 * The `planClearCandidates` seam — which graded rows may actually be moved, and
 * what "clear this row" means on disk.
 *
 * The grading has always marked some attachment and cache rows `batchClearable`
 * (`lib/classify.js:296`, `lib/classify.js:360`), but no producer ever filled the
 * trash's `attachments/` and `caches/` subdirectories, so that mark was a promise
 * with no path out — §8.8 of `docs/safety.md`.
 *
 * What these tests pin is the rule that makes the new path safe rather than
 * merely present: **the caller names rows by id and never names a path.** The
 * paths come off the row the server just graded, in the same pass that decided
 * the row was safe. §8.5 is the precedent — `body.risk` was a caller's
 * self-report and authorized nothing.
 */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'

import { planClearCandidates } from '../lib/clear-objects.js'

const HOME = '/tmp/dsh-reclaim-clear-objects'

/** A safe, batch-clearable attachment row carrying two files on disk. */
function attachmentRow(id, paths, overrides = {}) {
  return {
    kind: 'attachment',
    id,
    tier: 'safe',
    tierReasons: [],
    selectable: true,
    batchClearable: true,
    facts: { sessionIds: [], paths },
    ...overrides,
  }
}

/** A safe cache-family row — a whole directory, e.g. `request-images`. */
function cacheFamilyRow(familyId, path, overrides = {}) {
  return {
    kind: 'cache-family',
    id: `cache-family:${familyId}`,
    cacheKind: 'derived-request-images',
    tier: 'safe',
    tierReasons: [],
    selectable: true,
    batchClearable: true,
    facts: { path, bytes: 1024, files: 3, regenerable: true, enumerated: true },
    ...overrides,
  }
}

test('a clearable attachment row yields every one of its files', () => {
  const a = join(HOME, 'attachments/v1/objects/aa/aaa')
  const b = join(HOME, 'attachments/v1/objects/bb/bbb')
  const plan = planClearCandidates([attachmentRow('aaa', [a, b])], ['aaa'])

  assert.equal(plan.ok, true)
  assert.equal(plan.refusals.length, 0)
  assert.deepEqual(
    plan.items.map((item) => [item.path, item.kind]),
    [
      [a, 'attachment'],
      [b, 'attachment'],
    ],
  )
})

test('a cache family row lands in the cache subdirectory, not the attachment one', () => {
  const dir = join(HOME, 'cache/attachments/request-images')
  const plan = planClearCandidates([cacheFamilyRow('request-images', dir)], ['cache-family:request-images'])

  assert.equal(plan.ok, true)
  assert.deepEqual(
    plan.items.map((item) => [item.path, item.kind]),
    [[dir, 'cache']],
  )
})

test('a session row is refused even when it is batch clearable', () => {
  const row = {
    kind: 'session',
    id: '11111111-1111-4111-8111-111111111111',
    tier: 'safe',
    batchClearable: true,
    facts: { path: join(HOME, 'sessions/--w--/session-1111') },
  }
  const plan = planClearCandidates([row], [row.id])

  assert.equal(plan.ok, false)
  assert.deepEqual(plan.items, [])
  assert.equal(plan.refusals.length, 1)
  assert.equal(plan.refusals[0].code, 'session-not-clearable-here')
  // The refusal has to point at the path that *does* handle sessions, or the
  // caller is left knowing only that this one is closed.
  assert.match(plan.refusals[0].message, /POST \/delete/)
})

test('a row outside the clearable tier is refused and says which tier it is in', () => {
  const row = attachmentRow('aaa', [join(HOME, 'objects/aa/aaa')], {
    tier: 'danger',
    tierReasons: ['referenced-by-session'],
    selectable: false,
    batchClearable: false,
  })
  const plan = planClearCandidates([row], ['aaa'])

  assert.equal(plan.ok, false)
  assert.equal(plan.refusals[0].code, 'row-not-clearable')
  assert.equal(plan.refusals[0].detail.tier, 'danger')
  assert.deepEqual(plan.refusals[0].detail.tierReasons, ['referenced-by-session'])
})

test('a caller cannot turn a path into an instruction', () => {
  // A request that names a file directly is not a request about a row. It must
  // read as an unknown id — never as a path to move.
  const plan = planClearCandidates([attachmentRow('aaa', [join(HOME, 'objects/aa/aaa')])], ['/etc/passwd'])

  assert.equal(plan.ok, false)
  assert.deepEqual(plan.items, [])
  assert.equal(plan.refusals[0].code, 'unknown-id')
})

test('nothing moves when any one of the ids is refused', () => {
  const good = attachmentRow('aaa', [join(HOME, 'objects/aa/aaa')])
  const plan = planClearCandidates([good], ['aaa', 'not-a-row'])

  assert.equal(plan.ok, false)
  // All or nothing: a selection the user made as one action must not be half
  // carried out, because the half that moved is the half they cannot see.
  assert.deepEqual(plan.items, [])
  assert.equal(plan.refusals.length, 1)
  assert.equal(plan.refusals[0].code, 'unknown-id')
})

test('the same file named twice is one item, not a nesting problem', () => {
  const path = join(HOME, 'objects/aa/aaa')
  const plan = planClearCandidates(
    [attachmentRow('aaa', [path]), cacheFamilyRow('shared', path, { id: 'cache-family:shared' })],
    ['aaa', 'cache-family:shared'],
  )

  assert.equal(plan.ok, true)
  assert.equal(plan.items.length, 1)
  assert.equal(plan.items[0].path, path)
})

test('a directory and a file inside it cannot both be selected', () => {
  const dir = join(HOME, 'cache/attachments/request-images')
  const inside = join(dir, 'aa/aaa')
  const plan = planClearCandidates(
    [cacheFamilyRow('request-images', dir), attachmentRow('aaa', [inside])],
    ['cache-family:request-images', 'aaa'],
  )

  assert.equal(plan.ok, false)
  assert.deepEqual(plan.items, [])
  assert.equal(plan.refusals[0].code, 'nested-selection')
  assert.equal(plan.refusals[0].detail.outer, dir)
  assert.equal(plan.refusals[0].detail.inner, inside)
})

test('a clearable row that names no path is refused rather than silently skipped', () => {
  const plan = planClearCandidates([attachmentRow('aaa', [])], ['aaa'])

  assert.equal(plan.ok, false)
  assert.equal(plan.refusals[0].code, 'no-paths')
})

test('an empty request clears nothing and is not reported as a success', () => {
  const plan = planClearCandidates([attachmentRow('aaa', [join(HOME, 'objects/aa/aaa')])], [])

  assert.equal(plan.ok, false)
  assert.deepEqual(plan.items, [])
})
