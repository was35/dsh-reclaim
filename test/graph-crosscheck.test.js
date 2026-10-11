/**
 * The reference graph's second read — paid for only where it can still say
 * something.
 *
 * `lib/graph.js` cross-reads a session through the raw persistence handle when
 * the query read yielded no references, because "nothing here" is the conclusion
 * that authorizes deletion. That cross-read is a whole-log read, and on a real
 * store it is the largest remaining cost of an audit.
 *
 * The host measurement behind this file: for a COLD session
 * `sessionQuery.observeSession` serves the log through `readColdSessionLog`
 * (`dsh-session-query/lib/index.js:34-56`) — `sessionPersistence.open(id, 'read')`
 * + `handle.read()` — which is the very call `readViaPersistence` makes, plus
 * synthetic `interruptedTurnClosers` appended after the stored events. So a
 * second read of an unchanged file cannot find a reference the first read missed,
 * and the only thing it can detect is that the file CHANGED — which the
 * stat-derived revision (`dev:ino:size:mtimeNs:ctimeNs`, compared before and
 * after the query read) already answers.
 *
 * These tests pin both halves: the skip happens exactly when that evidence holds,
 * and every case where the second read is still a different source keeps it.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildReferenceGraph } from '../lib/graph.js'

const SESSION = '11111111-1111-4111-8111-111111111111'
const IMAGE = `sha256:${'a'.repeat(64)}`

/** Two contiguous events that reference nothing at all. */
function plainEvents() {
  return [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 't1' } },
    { type: 'turn/end', seq: 1, time: 2, data: { turn: 't1' } },
  ]
}

/** One event that carries a structured attachment reference. */
function eventsWithAttachment() {
  return [{ type: 'tool/result', seq: 0, time: 1, data: { attachmentId: IMAGE } }]
}

/**
 * A `ctx` with the two read seams and a call counter on each.
 *
 * @param {object} [options]
 * @param {readonly object[]} [options.events] - the events BOTH readers return
 * @param {boolean} [options.live] - serve the query read from the registry, as the host does
 * @param {string[]} [options.revisions] - successive `stat()` revisions (default: stable)
 * @param {boolean} [options.statUnavailable] - make `stat()` answer `undefined`
 */
function hostFor({ events = plainEvents(), live = false, revisions = null, statUnavailable = false } = {}) {
  const calls = { observe: 0, stat: 0, open: 0, read: 0 }
  const sequence = revisions ?? ['rev-1', 'rev-1']
  let statIndex = 0

  const ctx = {
    get(name) {
      if (name === 'sessionQuery') {
        return {
          observeSession: async (sessionId) => {
            calls.observe += 1
            return {
              source: live ? 'live' : 'prepared',
              header: { id: sessionId },
              inheritedEventCount: 0,
              events,
              cursor: events.length === 0 ? -1 : events[events.length - 1].seq,
              ...(live ? {} : { revision: sequence[0] }),
              [Symbol.dispose]() {},
            }
          },
        }
      }
      if (name === 'sessionPersistence') {
        return {
          stat: async (sessionId) => {
            calls.stat += 1
            if (statUnavailable) return undefined
            const revision = sequence[Math.min(statIndex, sequence.length - 1)]
            statIndex += 1
            return { header: { id: sessionId }, revision, sizeBytes: 64 }
          },
          open: async (sessionId) => {
            calls.open += 1
            return {
              header: { id: sessionId },
              inheritedEventCount: 0,
              read: async () => {
                calls.read += 1
                return { events, eventState: 'ok' }
              },
              close: async () => {},
            }
          },
        }
      }
      if (name === 'sessions') return { get: () => undefined }
      return undefined
    },
  }

  return { ctx, calls }
}

function readPathsCheck(graph) {
  return graph.sessions[0].checks.find((entry) => entry.id === 'read-paths')
}

test('a stored session with no references is not read twice when the revision held still', async () => {
  const { ctx, calls } = hostFor()
  const graph = await buildReferenceGraph(ctx, { sessionIds: [SESSION], verifyRead: 'empty-refs' })

  assert.equal(calls.open, 0, 'the raw cross-read must not happen')
  assert.equal(graph.readTotals.rawChecks, 0)
  assert.equal(graph.readTotals.handlesAcquired, 0)
  assert.equal(graph.readTotals.crossChecksSkipped, 1)
  assert.equal(graph.sessions[0].read.crossCheckSkipped, 'same-reader-same-revision')
  assert.equal(graph.sessions[0].read.source, 'prepared')

  // The verdict still holds, and it still allows the orphan determination — but
  // it says what it stands on rather than claiming two readers agreed.
  assert.equal(graph.coverage.proven, 1)
  assert.equal(graph.coverage.unknown, 0)
  assert.equal(graph.orphanDetermination.allowed, true)
  const check = readPathsCheck(graph)
  assert.equal(check.passed, true)
  assert.match(check.detail, /skipped as redundant \(same-reader-same-revision\)/)
  assert.match(check.detail, /the evidence here is the revision, not a comparison of two readers/)
  assert.equal(check.evidence.rawReadRequired, false)
  assert.equal(check.evidence.rawReadSkipped, 'same-reader-same-revision')
  assert.equal(check.evidence.rawEvents, null)

  assert.ok(
    graph.notes.some((note) => note.includes('were NOT read a second time')),
    'the report must state the skip where a reader will see it',
  )
})

test('a live session keeps its cross-read, because the two reads are different sources', async () => {
  const { ctx, calls } = hostFor({ live: true })
  const graph = await buildReferenceGraph(ctx, { sessionIds: [SESSION], verifyRead: 'empty-refs' })

  assert.equal(calls.open, 1, 'an in-memory query read is not the durable log')
  assert.equal(graph.readTotals.rawChecks, 1)
  assert.equal(graph.readTotals.crossChecksSkipped, 0)
  assert.equal(graph.sessions[0].read.crossCheckSkipped, null)
  assert.match(readPathsCheck(graph).detail, /both readers agree/)
})

test('a revision that moved is cross-read rather than trusted', async () => {
  const { ctx, calls } = hostFor({ revisions: ['rev-1', 'rev-2'] })
  const graph = await buildReferenceGraph(ctx, { sessionIds: [SESSION], verifyRead: 'empty-refs' })

  assert.equal(calls.open, 1)
  assert.equal(graph.sessions[0].read.revisionStable, false)
  assert.equal(graph.sessions[0].read.crossCheckSkipped, null)
  // The moved revision is already a failure of atomicity, so the session is
  // unknown and orphan detection pauses — the skip is never what hides it.
  assert.equal(graph.coverage.unknown, 1)
  assert.equal(graph.orphanDetermination.allowed, false)
})

test('an unprovable revision (no stat) is cross-read rather than trusted', async () => {
  const { ctx, calls } = hostFor({ statUnavailable: true })
  const graph = await buildReferenceGraph(ctx, { sessionIds: [SESSION], verifyRead: 'empty-refs' })

  assert.equal(calls.open, 1)
  assert.equal(graph.sessions[0].read.revisionStable, null)
  assert.equal(graph.sessions[0].read.crossCheckSkipped, null)
})

test('verifyRead=all always reads twice, so the readers stay comparable', async () => {
  const { ctx, calls } = hostFor()
  const graph = await buildReferenceGraph(ctx, { sessionIds: [SESSION], verifyRead: 'all' })

  assert.equal(calls.open, 1)
  assert.equal(graph.readTotals.rawChecks, 1)
  assert.equal(graph.readTotals.crossChecksSkipped, 0)
  assert.match(readPathsCheck(graph).detail, /both readers agree/)
})

test('a session that DID yield a reference is not cross-read, and not called skipped', async () => {
  const { ctx, calls } = hostFor({ events: eventsWithAttachment() })
  const graph = await buildReferenceGraph(ctx, { sessionIds: [SESSION], verifyRead: 'empty-refs' })

  assert.equal(calls.open, 0)
  assert.equal(graph.readTotals.crossChecksSkipped, 0)
  assert.equal(graph.sessions[0].read.crossCheckSkipped, null)
  assert.equal(graph.sessions[0].referenceCount, 1)
  assert.match(readPathsCheck(graph).detail, /the cross-check was not requested for this session/)
})

test('an empty log is still cross-read: "parsed nothing" is the failure being checked', async () => {
  const { ctx, calls } = hostFor({ events: [] })
  const graph = await buildReferenceGraph(ctx, { sessionIds: [SESSION], verifyRead: 'empty-refs' })

  assert.equal(calls.open, 1)
  assert.equal(graph.readTotals.rawChecks, 1)
  assert.equal(graph.readTotals.crossChecksSkipped, 0)
})
