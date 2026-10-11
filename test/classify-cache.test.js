/**
 * The classify route's in-process fact cache — reuse, and the two things it must never do.
 *
 * The cache exists because the panel opens on the same facts twice in a row: once for the
 * first paint and once when the user asks for a re-read. What it may NOT do is blur the two,
 * so this test pins four properties that together keep the reuse honest:
 *
 *   1. a plain GET reuses the facts it already has, and says so (`factsFromCache`),
 *   2. a `rescan=1` GET never reuses, and bumps the scan generation,
 *   3. a reused answer carries the ORIGINAL scan instant, not the moment it was answered —
 *      otherwise the "data as of HH:MM:SS" line would creep forward while the disk stood still,
 *   4. facts read in one `verifyRead` mode are never served to another, because the mode
 *      changes what was read (the cross-check) and therefore what the answer can claim.
 *
 * The mechanism is the same recording host the other route tests use: register the routes,
 * take the handler, call it. A scan over an empty DSH home is cheap and touches no real tree.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { registerRoutes } from '../lib/routes.js'

/** A context that records the routes it is given, so the handler can be called. */
function recordingHost() {
  const handlers = new Map()
  const ctx = {
    effect: (fn) => fn(),
    connection: { fetch: { register: (entry) => handlers.set(entry.path, entry.fetch) } },
    get(name) {
      if (name === 'sessions') return { get: () => undefined }
      return undefined
    },
  }
  return { ctx, handlers }
}

/** A synthetic DSH home with the three trees the scan reads, all empty. */
function emptyHome() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-reclaim-classify-cache-'))
  for (const dir of ['sessions', 'attachments/v1', 'cache']) {
    mkdirSync(join(home, dir), { recursive: true })
  }
  return home
}

/** One GET /classify against a freshly registered route table. */
async function classify(home, query = '') {
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const { ctx, handlers } = recordingHost()
    registerRoutes(ctx, {})
    const handler = handlers.get('/api/dsh-reclaim/classify')
    assert.equal(typeof handler, 'function', 'the classify route must be registered')
    const response = await handler({ url: `http://127.0.0.1/api/dsh-reclaim/classify${query}` })
    return { response, body: await response.json() }
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
}

const home = emptyHome()

test('opening the panel twice reuses one scan, and says which answer was reused', async () => {
  const first = await classify(home, '?thresholdDays=30')
  assert.equal(first.response.status, 200)
  assert.equal(first.body.ok, true, `the first classify failed: ${JSON.stringify(first.body).slice(0, 400)}`)
  assert.equal(first.body.factsFromCache, false, 'the first answer claimed to come from a cache that was empty')
  assert.equal(typeof first.body.scannedAt, 'string', 'a fresh scan must date itself')

  const second = await classify(home, '?thresholdDays=30')
  assert.equal(second.body.factsFromCache, true, 'the second answer re-read the disk instead of reusing facts')
  assert.equal(second.body.scanCount, first.body.scanCount, 'reuse must not advance the scan generation')
  // The honesty rule: a reused answer is dated with the scan, not with the reply. If this
  // ever drifts forward, the panel starts claiming a freshness the disk never had.
  assert.equal(second.body.scannedAt, first.body.scannedAt, 'reuse re-dated the facts to the moment of the answer')
})

test('an explicit rescan always re-reads, and advances the generation', async () => {
  const before = await classify(home, '?thresholdDays=30')
  const rescanned = await classify(home, '?thresholdDays=30&rescan=1')
  assert.equal(rescanned.body.factsFromCache, false, 'rescan=1 was served from the cache')
  assert.equal(
    rescanned.body.scanCount,
    before.body.scanCount + 1,
    'rescan=1 must produce a new fact generation',
  )
})

test('changing the risk dial re-grades the facts it has instead of re-reading the disk', async () => {
  const thirty = await classify(home, '?thresholdDays=30')
  const seven = await classify(home, '?thresholdDays=7')
  assert.equal(seven.body.factsFromCache, true, 'changing the threshold re-read the session logs')
  assert.equal(seven.body.scannedAt, thirty.body.scannedAt)
  assert.equal(seven.body.scanCount, thirty.body.scanCount)
})

test('facts read under one verifyRead mode are never served to another', async () => {
  // `verifyRead` changes WHAT was read (the raw-read cross-check), so the two modes are not
  // interchangeable facts. The cache is keyed by mode for exactly this reason.
  const emptyRefs = await classify(home, '?verifyRead=empty-refs&rescan=1')
  assert.equal(emptyRefs.body.factsFromCache, false)

  // The same mode, asked again, is the same question — so it is reused.
  const againEmptyRefs = await classify(home, '?verifyRead=empty-refs')
  assert.equal(againEmptyRefs.body.factsFromCache, true, 'the mode that was just read was not reused')
  assert.equal(againEmptyRefs.body.scannedAt, emptyRefs.body.scannedAt)
  assert.equal(againEmptyRefs.body.scanCount, emptyRefs.body.scanCount)

  // A different mode is a different question, at a different read depth. Handing it the
  // other mode's facts would answer something nobody asked.
  const all = await classify(home, '?verifyRead=all')
  assert.equal(all.body.factsFromCache, false, "a different verifyRead mode was served another mode's facts")
  assert.notEqual(all.body.scanCount, emptyRefs.body.scanCount, 'the mismatched mode did not actually re-read')
})
