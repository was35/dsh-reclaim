/**
 * `GET /classify?preview=1` — the cheap half of a scan, and what it may not claim.
 *
 * A cold open has to read the reference graph, and that read is the expensive one (it opens
 * session logs). The preview exists so the panel can paint the rows — titles, sizes, ages and
 * the archive badge, which is what the user came for — while the graph is still being read.
 *
 * The whole point of a preview is that it is NOT a grade, so these tests pin the two
 * properties that make it safe to show:
 *
 *   1. it does not read the reference graph (the cost it exists to avoid), and
 *   2. it claims no verdict that would come from the graph: every row is `pending`, nothing
 *      is selectable, and the graph-derived numbers are null rather than a zero that reads
 *      as "none".
 *
 * Plus the saving that pays for the split: the full grade that follows a preview reuses the
 * listing the preview already read, so the two answers cost one listing between them.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { registerRoutes } from '../lib/routes.js'

const SESSION = '22222222-2222-4222-8222-222222222222'

/** A synthetic DSH home with the three trees the scan reads, all empty. */
function emptyHome() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-reclaim-classify-preview-'))
  for (const dir of ['sessions', 'attachments/v1', 'cache']) {
    mkdirSync(join(home, dir), { recursive: true })
  }
  return home
}

/**
 * A host with one stored session, and a counter on each read that costs something.
 *
 * The two observables are the point of the file: `listings` is the session store being
 * walked, `observes` is a session log being opened (which is what building the reference
 * graph does per session). Neither is inferred from the response — both are counted.
 */
function countingHost() {
  const handlers = new Map()
  let listings = 0
  let observes = 0
  const ctx = {
    effect: (fn) => fn(),
    connection: { fetch: { register: (entry) => handlers.set(entry.path, entry.fetch) } },
    get(name) {
      if (name === 'sessions') return { get: () => undefined }
      if (name === 'sessionQuery') {
        return {
          listSessions: async () => {
            listings += 1
            return [
              {
                header: { id: SESSION, cwd: '/home/Projects/demo', createdAt: 1735689600000 },
                live: false,
                persisted: true,
              },
            ]
          },
          observeSession: async (sessionId) => {
            observes += 1
            return {
              source: 'prepared',
              header: { id: sessionId },
              inheritedEventCount: 0,
              events: [{ type: 'turn/start', seq: 0, time: 1, data: {} }],
              cursor: 0,
              revision: 'rev-1',
              [Symbol.dispose]() {},
            }
          },
        }
      }
      return undefined
    },
  }
  return { ctx, handlers, listings: () => listings, observes: () => observes }
}

/**
 * A route table with no scan generation behind it.
 *
 * The fact caches are module-wide, so a test that needs a COLD cache has to take its own copy
 * of the module — an ESM query string is a new module instance. Without this, the generation
 * left by the test above is (correctly) reused, and "did this read the store?" would answer
 * itself.
 */
async function coldRoutes(tag) {
  const isolated = await import(`../lib/routes.js?isolated=${tag}`)
  return isolated.registerRoutes
}

/** Call the classify route on a freshly registered table, with `DSH_HOME` pointed at `home`. */
async function classify(home, host, query, register = registerRoutes) {
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    register(host.ctx, {})
    const handler = host.handlers.get('/api/dsh-reclaim/classify')
    assert.equal(typeof handler, 'function', 'the classify route must be registered')
    const response = await handler({ url: `http://127.0.0.1/api/dsh-reclaim/classify${query}` })
    return { response, body: await response.json() }
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
}

const home = emptyHome()

test('a preview reads the listing and never the reference graph', async () => {
  const host = countingHost()
  const { response, body } = await classify(home, host, '?thresholdDays=30&preview=1')

  assert.equal(response.status, 200)
  assert.equal(body.ok, true, `the preview failed: ${JSON.stringify(body).slice(0, 400)}`)
  assert.equal(host.listings(), 1, 'the preview did not list the session store')
  assert.equal(host.observes(), 0, 'the preview opened a session log — the cost it exists to avoid')
  assert.equal(body.pending, true)
  assert.equal(body.factsFromCache, false)
  assert.equal(typeof body.scannedAt, 'string', 'a preview must date the listing it read')
})

test('a preview withdraws every verdict the graph would have supported', async () => {
  const host = countingHost()
  const { body } = await classify(home, host, '?thresholdDays=30&preview=1', await coldRoutes('verdicts'))

  assert.equal(body.sessions.length, 1, 'the preview painted no rows')
  for (const row of body.sessions) {
    assert.equal(row.pending, true)
    assert.equal(row.tier, 'pending')
    assert.equal(row.selectable, false, 'a pending row was offered for deletion')
    assert.equal(row.batchClearable, false)
    // Null, not zero: a zero here is a claim ("nothing is freed", "no images"), and the read
    // that could support it has not happened.
    assert.equal(row.freedByDeletingBytes, null)
    assert.equal(row.dedupCount, null)
    assert.deepEqual(row.freedBreakdown, {})
    assert.deepEqual(row.tierReasons, [])
    assert.deepEqual(row.blockingChecks, [])
  }
  assert.deepEqual(Object.keys(body.tiers.sessions), ['pending'], 'a preview put a row in a real tier')
  assert.deepEqual(body.families, [], 'a preview claimed cache families, which come from the graph')
  // The row still carries what the paint is FOR. (The size is null here only because this
  // host has no persistence service — a missing number stays unknown, which is the rule the
  // pending paint is built on.)
  assert.ok('sizeBytes' in body.sessions[0].facts)
  assert.ok('archived' in body.sessions[0].facts)
})

test('the grade after a preview reuses its listing, and does read the graph', async () => {
  const host = countingHost()
  const register = await coldRoutes('grade-after-preview')

  const preview = await classify(home, host, '?thresholdDays=30&preview=1', register)
  assert.equal(preview.body.pending, true)
  assert.equal(host.listings(), 1)

  // The full answer is a second question, but not a second read of the same bytes: the cheap
  // facts the preview produced are handed to the graph scan.
  const full = await classify(home, host, '?thresholdDays=30', register)
  assert.equal(full.body.ok, true, `the full grade failed: ${JSON.stringify(full.body).slice(0, 400)}`)
  assert.equal(host.listings(), 1, 'the grade after a preview listed the session store again')
  assert.ok(host.observes() > 0, 'the full grade never read the reference graph')
  assert.equal(full.body.pending, undefined, 'the full grade is still marked pending')
  assert.equal(full.body.factsFromCache, false, 'the full facts came from a cache that was empty')
})

test('a preview is reusable, and an explicit rescan is never served from it', async () => {
  const host = countingHost()
  const register = await coldRoutes('preview-reuse')

  const first = await classify(home, host, '?thresholdDays=30&preview=1', register)
  const second = await classify(home, host, '?thresholdDays=30&preview=1', register)
  assert.equal(second.body.factsFromCache, true, 'a second preview re-read the listing')
  assert.equal(second.body.scannedAt, first.body.scannedAt, 'reuse re-dated the listing to the moment of the reply')
  assert.equal(host.listings(), 1)

  const rescanned = await classify(home, host, '?thresholdDays=30&preview=1&rescan=1', register)
  assert.equal(rescanned.body.factsFromCache, false, 'rescan=1 was served from the cheap cache')
  assert.equal(host.listings(), 2, 'rescan=1 did not re-read the listing')
})
