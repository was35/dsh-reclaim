/**
 * The session table's titles: the host's projection cache first, the log fold only for what
 * it cannot answer.
 *
 * The fold is the expensive read here — it materializes the complete event array of every
 * session log to find the last `session/title` event — so this file guards two things at once:
 * that a title the cache can answer costs no log read, and that every case the cache CANNOT
 * answer still ends up in the fold rather than being quietly reported as "no title".
 *
 * The distinctions under test come from the host's own schema (`titleViewSchema =
 * z.string().min(1).nullable()`), and they are not cosmetic:
 *   - a string  → the title;
 *   - `null`    → the cache answered: this session has produced no title yet (a known fact);
 *   - `undefined` / no projections at all → UNKNOWN, which must go to the log, never read as
 *     "this session has no title".
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { listSessions } from '../lib/sessions.js'

function record(id) {
  return { header: { id, cwd: `/tmp/${id}`, createdAt: 1_700_000_000_000 } }
}

/**
 * Build a context from the three seams, counting how many ids each fold request asked about.
 *
 * `fold` is the whole point of the counter: `readTitleSnapshots` reading every log is what the
 * change removes, so "which ids were sent to the fold" is the observable behaviour.
 */
function contextWith({ ids, items, foldedTitles = {}, foldFails = false }) {
  const foldRequests = []
  const ctx = {
    get(name) {
      if (name === 'sessionQuery') {
        return {
          listSessions: async () => ids.map(record),
          readTitleSnapshots: async (requested) => {
            foldRequests.push([...requested])
            if (foldFails) throw new Error('log store is gone')
            return requested.map((sessionId) => ({
              sessionId,
              status: 'fulfilled',
              value: {
                title:
                  foldedTitles[sessionId] === undefined
                    ? null
                    : { title: foldedTitles[sessionId], updatedAt: 42, source: { kind: 'user' } },
              },
            }))
          },
        }
      }
      if (name === 'sessionController') {
        if (items === undefined) return undefined
        return { list: async () => ({ items }) }
      }
      return undefined
    },
  }
  return { ctx, foldRequests }
}

function item(sessionId, projections) {
  const entry = { sessionId, updatedAt: 5, running: false, blank: false }
  if (projections !== null) entry.projections = projections
  return entry
}

function projection(title, kind = 'cached', asOfSeq = 12) {
  return { kind, asOfSeq, values: title === 'absent' ? {} : { title } }
}

function rowOf(report, id) {
  const row = report.sessions.find((session) => session.id === id)
  assert.ok(row, `no row for ${id}`)
  return row
}

test('a projected title is used as-is and costs no log read', async () => {
  const { ctx, foldRequests } = contextWith({
    ids: ['a', 'b', 'c'],
    items: [
      item('a', projection('Alpha')),
      item('b', projection('Beta', 'sequenced')),
      item('c', null),
    ],
    foldedTitles: { c: 'Gamma' },
  })

  const report = await listSessions(ctx)
  const a = rowOf(report, 'a')

  assert.equal(a.title, 'Alpha')
  assert.equal(a.titleFrom, 'projection-cache')
  // The cache carries the text and nothing else: provenance and time are unknown, and a null
  // here is the honest answer rather than a copied value from somewhere else.
  assert.equal(a.titleSource, null)
  assert.equal(a.titleUpdatedAt, null)
  // A log position, carried as such. It is not a timestamp and must never be rendered as one.
  assert.equal(a.titleAsOfSeq, 12)

  const b = rowOf(report, 'b')
  assert.equal(b.title, 'Beta')
  assert.equal(b.titleFrom, 'live-projection', 'a live projection is named differently from a cached one')

  // Only the row with no projection at all was folded, and it was folded exactly once.
  assert.deepEqual(foldRequests, [['c']], 'the fold was asked about ids the cache had already answered')
  const c = rowOf(report, 'c')
  assert.equal(c.title, 'Gamma')
  assert.equal(c.titleFrom, 'log-fold')
  assert.equal(c.titleSource, 'user')
  assert.equal(c.titleUpdatedAt, 42)
  assert.equal(c.titleAsOfSeq, null)

  assert.equal(report.titles.projection.served, 2)
  assert.equal(report.titles.folded.requested, 1)
  assert.equal(report.titles.available, true)
})

test('a projection row with no title unit is unknown, and unknown goes to the log', async () => {
  // `values.title === undefined`: the row exists and other units have values, but this one
  // does not. The host's schema discards an empty title exactly this way, so this is the
  // shape of "we do not know" — and it must not become "this session has no title".
  const { ctx, foldRequests } = contextWith({
    ids: ['only'],
    items: [item('only', projection('absent'))],
    foldedTitles: { only: 'From the log' },
  })

  const report = await listSessions(ctx)
  const row = rowOf(report, 'only')

  assert.deepEqual(foldRequests, [['only']], 'an undefined title unit was treated as an answer')
  assert.equal(row.title, 'From the log')
  assert.equal(row.titleFrom, 'log-fold')
})

test('a `null` projected title is a known "no title yet", not an unknown', async () => {
  const { ctx, foldRequests } = contextWith({
    ids: ['empty'],
    items: [item('empty', projection(null))],
    foldedTitles: { empty: 'should not be read' },
  })

  const report = await listSessions(ctx)
  const row = rowOf(report, 'empty')

  assert.equal(foldRequests.length, 0, 'a known "no title yet" was re-read from the log')
  assert.equal(row.title, null)
  assert.equal(row.titleFrom, 'projection-cache')
  assert.equal(report.titles.projection.served, 1)
  assert.equal(report.titles.folded.requested, 0)
  // Nothing needed folding, so the titles are complete — that is an answer, not a gap.
  assert.equal(report.titles.available, true)
})

test('without the host list every title is folded, exactly as before', async () => {
  const { ctx, foldRequests } = contextWith({
    ids: ['a', 'b'],
    items: undefined,
    foldedTitles: { a: 'A', b: 'B' },
  })

  const report = await listSessions(ctx)

  assert.deepEqual(foldRequests, [['a', 'b']])
  assert.equal(rowOf(report, 'a').titleFrom, 'log-fold')
  assert.equal(report.titles.projection.served, 0)
  assert.equal(report.titles.folded.requested, 2)
  assert.equal(report.titles.available, true)
})

test('a fold that fails reports titles as unavailable rather than as absent', async () => {
  const { ctx } = contextWith({ ids: ['a'], items: [item('a', null)], foldFails: true })

  const report = await listSessions(ctx)

  assert.equal(report.titles.available, false)
  assert.match(String(report.titles.reason), /log store is gone/)
  // The row still exists; its title is unknown, which is what a null title means when
  // `titles.available` is false — never "this session has no title".
  assert.equal(rowOf(report, 'a').title, null)
  assert.equal(report.summary.withoutTitle, 1)
})
