/**
 * 124 sessions — the scale the audit was reported slow at.
 *
 * The other test files work at the scale of two or three sessions, which is
 * enough to prove a rule but not enough to prove a COST. This one builds the
 * store the complaint was about (124 sessions, a few of them at the edges the
 * honesty rules are about) and asserts two different things:
 *
 *   1. what the open reads. Not "how fast" — a unit test cannot time a host —
 *      but HOW MANY TIMES: how many store listings, how many session logs
 *      opened, how many titles folded out of those logs. Those counts are what
 *      the speed-up actually changed, and they are what would silently regress.
 *   2. that the edge rows are still honest at that scale: a session whose title
 *      is unknown stays unknown, a session whose size was never reported stays
 *      null rather than 0, and the archive flag keeps its three states.
 *
 * The timing half of this ticket is `scripts/bench-audit.sh`, which measures a
 * real host over a real store. This file is the regression fence around it.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { registerRoutes } from '../lib/routes.js'

/** The scale the report was about. */
const SESSIONS = 124
const IDS = Array.from({ length: SESSIONS }, (_, index) => `s-${String(index).padStart(3, '0')}`)
// The four rows that must not be smoothed over. Each one is a state the panel
// has a distinct way of saying, and at scale it would be easy to lose one.
const KNOWN_NO_TITLE = 's-000' // the host knows there is no title yet
const TITLE_UNKNOWN = 's-001' // the host does not know — the fold has to answer
const SIZE_UNKNOWN = 's-002' // no sizeBytes was ever reported
const ARCHIVED = 's-003'
const NOT_ARCHIVED = 's-004'

const BASE_MS = 1735689600000

/** An empty DSH home: the routes resolve a layout before they scan anything. */
function emptyHome() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-reclaim-scale-'))
  for (const dir of ['sessions', 'attachments/v1', 'cache']) mkdirSync(join(home, dir), { recursive: true })
  return home
}

/**
 * A host holding 124 stored sessions, counting every read that costs something.
 *
 * `listings` is the store walked; `observes` is a session log opened through the
 * query seam (which is what the reference graph pays for); `folds` is a batch of
 * titles read out of compressed logs; `rawOpens` is the cross-check's second
 * read of a log, which must not happen when one reader and one revision prove
 * it redundant.
 */
function scaleHost() {
  const handlers = new Map()
  const counts = { listings: 0, observes: 0, folds: 0, rawOpens: 0, activityReads: 0 }

  const recordFor = (id) => ({ header: { id, cwd: '/home/Projects/demo', createdAt: BASE_MS }, live: false, persisted: true })
  const sizeOf = (id) => (id === SIZE_UNKNOWN ? null : 1024 + IDS.indexOf(id))
  const projectionsFor = (id) => {
    if (id === KNOWN_NO_TITLE) return { kind: 'cached', asOfSeq: 5, values: { title: null } }
    if (id === TITLE_UNKNOWN) return { kind: 'cached', asOfSeq: 5, values: {} }
    return { kind: 'cached', asOfSeq: 5, values: { title: `projection title of ${id}` } }
  }

  const ctx = {
    effect: (fn) => fn(),
    connection: { fetch: { register: (entry) => handlers.set(entry.path, entry.fetch) } },
    get(name) {
      if (name === 'sessions') return { get: () => undefined }
      if (name === 'sessionQuery') {
        return {
          listSessions: async () => {
            counts.listings += 1
            return IDS.map(recordFor)
          },
          observeSession: async (id) => {
            counts.observes += 1
            return {
              source: 'prepared',
              header: { id },
              inheritedEventCount: 0,
              events: [{ type: 'turn/start', seq: 0, time: 1, data: {} }],
              cursor: 0,
              revision: 'rev-1',
              [Symbol.dispose]() {},
            }
          },
          readTitleSnapshots: async (requested) => {
            counts.folds += 1
            return requested.map((id) => ({
              sessionId: id,
              status: 'fulfilled',
              value: { title: { title: `folded title of ${id}`, updatedAt: BASE_MS, source: { kind: 'user' } } },
            }))
          },
        }
      }
      if (name === 'sessionPersistence') {
        return {
          list: async () =>
            IDS.filter((id) => id !== SIZE_UNKNOWN).map((id) => ({
              header: { id },
              sizeBytes: sizeOf(id),
              eventCount: 1,
            })),
          stat: async (id) => ({ header: { id }, revision: 'rev-1', sizeBytes: sizeOf(id) ?? undefined }),
          open: async () => {
            counts.rawOpens += 1
            return { header: { id: 'raw' }, read: async () => ({ events: [] }), close: async () => {} }
          },
        }
      }
      if (name === 'sessionController') {
        return {
          list: async () => {
            counts.activityReads += 1
            return {
              items: IDS.map((id) => ({
                sessionId: id,
                updatedAt: BASE_MS,
                running: false,
                blank: false,
                projections: projectionsFor(id),
              })),
            }
          },
        }
      }
      if (name === 'workspaceRegistry') {
        return { list: () => [], archivedSessionIds: [ARCHIVED] }
      }
      return undefined
    },
  }
  return { ctx, handlers, counts }
}

/** A route table with no scan generation behind it (the caches are module-wide). */
async function coldRoutes(tag) {
  const isolated = await import(`../lib/routes.js?isolated=${tag}`)
  return isolated.registerRoutes
}

async function call(home, host, path, register) {
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    register(host.ctx, {})
    const handler = host.handlers.get(path.split('?')[0])
    assert.equal(typeof handler, 'function', `${path} must be registered`)
    const response = await handler({ url: `http://127.0.0.1${path}` })
    return await response.json()
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
}

const rowOf = (body, id) => {
  const row = (body.sessions ?? []).find((candidate) => candidate.id === id)
  assert.ok(row !== undefined, `no row for ${id}`)
  return row
}

const home = emptyHome()

test('124 sessions: the preview paints every row without opening a single log', async () => {
  const host = scaleHost()
  const body = await call(home, host, '/api/dsh-reclaim/classify?preview=1', await coldRoutes('scale-preview'))

  assert.equal(body.ok, true)
  assert.equal(body.pending, true)
  assert.equal(body.sessions.length, SESSIONS)
  assert.equal(body.tiers.sessions.pending.length, SESSIONS)
  for (const row of body.sessions) {
    assert.equal(row.tier, 'pending')
    assert.equal(row.selectable, false)
    assert.equal(row.freedByDeletingBytes, null)
  }
  assert.equal(host.counts.listings, 1, 'the preview listed the store more than once')
  assert.equal(host.counts.observes, 0, 'the preview opened a session log — the cost it exists to avoid')
  assert.equal(host.counts.rawOpens, 0)
  // The cheap half still folds the titles the host could not answer for. That is
  // the honest cost of a preview, and it is one batch, not one read per session.
  assert.equal(host.counts.folds, 1, 'the preview folded titles more than once')
})

test('124 sessions: the full grade reads each log once, and cross-checks none', async () => {
  const host = scaleHost()
  const register = await coldRoutes('scale-full')
  await call(home, host, '/api/dsh-reclaim/classify?preview=1', register)
  const body = await call(home, host, '/api/dsh-reclaim/classify', register)

  assert.equal(body.pending, undefined, 'the full grade is still marked pending')
  assert.equal(body.sessions.length, SESSIONS)
  assert.equal(host.counts.listings, 1, 'the grade after a preview listed the store again')
  assert.equal(host.counts.observes, SESSIONS, 'the graph did not read each session exactly once')
  assert.equal(host.counts.rawOpens, 0, 'a cross-check re-read a log that one reader and one revision already proved')
  assert.equal(body.gate.coverage.proven, SESSIONS)
  assert.equal(body.gate.coverage.unknown, 0)
  assert.equal(body.gate.orphanDeterminationAllowed, true)
})

test('124 sessions: the edge rows keep their three states', async () => {
  const host = scaleHost()
  const body = await call(home, host, '/api/dsh-reclaim/classify', await coldRoutes('scale-edges'))

  // Known-no-title and unknown-title are different answers, and neither is "". The grade
  // report carries the text plus the fold's provenance, which a cache-served row cannot
  // supply — so `titleSource: null` is how the report says "we were not told where this
  // came from", never "the user named it".
  assert.equal(rowOf(body, KNOWN_NO_TITLE).facts.title, null)
  assert.equal(rowOf(body, KNOWN_NO_TITLE).facts.titleSource, null)
  assert.equal(rowOf(body, TITLE_UNKNOWN).facts.title, `folded title of ${TITLE_UNKNOWN}`)
  assert.equal(rowOf(body, TITLE_UNKNOWN).facts.titleSource, 'user')
  // A size nobody reported stays null; 0 would read as "this session is empty".
  assert.equal(rowOf(body, SIZE_UNKNOWN).facts.sizeBytes, null)
  // ...and the row beside it does have a number, so "unknown" is a state, not a blanket.
  assert.equal(typeof rowOf(body, ARCHIVED).facts.sizeBytes, 'number')
  // The archive flag keeps all three states, at scale.
  assert.equal(rowOf(body, ARCHIVED).facts.archived, true)
  assert.equal(rowOf(body, NOT_ARCHIVED).facts.archived, false)
  assert.equal(body.totals.sessionCount, SESSIONS)
})

test('124 sessions: a second open reads nothing, and an explicit rescan reads it all', async () => {
  const host = scaleHost()
  const register = await coldRoutes('scale-reopen')

  await call(home, host, '/api/dsh-reclaim/classify?preview=1', register)
  await call(home, host, '/api/dsh-reclaim/classify', register)
  const listingsAfterOpen = host.counts.listings
  const observesAfterOpen = host.counts.observes
  const foldsAfterOpen = host.counts.folds

  // Opening the panel again is the case the complaint was about: the old client
  // asked for a rescan on every mount.
  const again = await call(home, host, '/api/dsh-reclaim/classify', register)
  assert.equal(again.factsFromCache, true, 'a second open did not reuse the facts it already had')
  assert.equal(again.sessions.length, SESSIONS)
  assert.equal(host.counts.listings, listingsAfterOpen, 'a second open listed the store again')
  assert.equal(host.counts.observes, observesAfterOpen, 'a second open read session logs again')
  assert.equal(host.counts.folds, foldsAfterOpen, 'a second open folded titles again')

  // The quarantine view is not a second listing either.
  await call(home, host, '/api/dsh-reclaim/trash', register)
  assert.equal(host.counts.listings, listingsAfterOpen, 'the quarantine listed the store again')

  // Pressing refresh is allowed to cost: it must re-read, or the panel would be
  // describing a world it never looked at.
  const rescanned = await call(home, host, '/api/dsh-reclaim/classify?rescan=1', register)
  assert.equal(rescanned.factsFromCache, false)
  assert.equal(host.counts.listings, listingsAfterOpen + 1, 'rescan=1 did not re-list the store')
  assert.equal(host.counts.observes, observesAfterOpen + SESSIONS, 'rescan=1 did not re-read the logs')
})
