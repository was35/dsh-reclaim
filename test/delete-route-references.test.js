/**
 * The `POST /delete` route — the boundary where §8.5 was actually reachable.
 *
 * `planSessionDelete` is the seam that decides, but the *bypass* was a hand-rolled
 * HTTP request: `route('/api/dsh-reclaim/delete', …)` asked for a `sessionId` and
 * a `confirm` and nothing else, so a caller who never rendered the interface
 * never met the tier rule that only existed in the interface. Pinning the planner
 * alone would leave that door open, so this test drives the registered handler.
 *
 * The claim under test is the one written into the route's comment: a reference
 * graph that cannot be read must produce a **refusal**, not a 500 and not a
 * silent allowance. A 500 says "try again"; this case has to say "do not".
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { buildManifest, writeManifest } from '../lib/manifest.js'
import { registerRoutes } from '../lib/routes.js'

const TARGET = '33333333-3333-4333-8333-333333333333'

/**
 * A context that records the routes it is given, so the handler can be called
 * directly. `sessions` holds nothing, which makes liveness `not-live` and leaves
 * the reference graph as the only thing that can refuse this delete.
 */
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

test('POST /delete refuses rather than 500s when the reference graph cannot be read', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-reclaim-delete-route-'))
  const dir = join(home, 'sessions', '--workspace--', `session-${TARGET}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.v1.jsonl'), '')

  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const { ctx, handlers } = recordingHost()
    registerRoutes(ctx, {})

    const handler = handlers.get('/api/dsh-reclaim/delete')
    assert.equal(typeof handler, 'function', 'the delete route must be registered')

    const response = await handler({
      text: async () => JSON.stringify({ sessionId: TARGET, confirm: true }),
    })
    const body = await response.json()

    assert.equal(response.status, 200, `expected a refusal, not a failure response: ${JSON.stringify(body)}`)
    assert.equal(body.ok, false)
    assert.equal(body.move, null)
    assert.ok(
      body.plan.blockers.some((entry) => entry.code === 'reference-graph-unavailable'),
      `expected the unreadable-graph refusal; blockers were ${JSON.stringify(body.plan.blockers.map((entry) => entry.code))}`,
    )
    // The refusal has to be real, not merely reported.
    assert.equal(existsSync(dir), true)
    assert.equal(existsSync(join(home, '.dsh-reclaim-trash')), false)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})

test('POST /delete refuses a traversal sessionId with 400 Bad Request', async () => {
  const { ctx, handlers } = recordingHost()
  registerRoutes(ctx, {})

  const handler = handlers.get('/api/dsh-reclaim/delete')
  const response = await handler({
    text: async () => JSON.stringify({ sessionId: '../traversal-id', confirm: true }),
  })
  const body = await response.json()

  assert.equal(response.status, 400)
  assert.equal(body.ok, false)
  assert.match(body.error, /path traversal/)
})

/**
 * Put one session into the quarantine, the way a real move would: a batch directory
 * with a manifest naming the session. Nothing else is needed — the question the route
 * asks is "does a batch claim this session", and the manifest is the only record.
 */
function quarantineSession(home, sessionId) {
  const batchId = '20260101T000000000-0001'
  const batchDir = join(home, '.dsh-reclaim-trash', batchId)
  const manifest = buildManifest({
    batchId,
    createdAt: '2026-01-01T00:00:00.000Z',
    volumeRoot: null,
    entries: [
      {
        kind: 'session',
        sessionId,
        originalPath: join(home, 'sessions', '--workspace--', `session-${sessionId}`),
        relativePath: `sessions/--workspace--/session-${sessionId}`,
        files: 1,
        bytes: 10,
      },
    ],
  })
  const written = writeManifest(batchDir, manifest)
  assert.equal(written.ok, true, `could not seed a quarantine batch: ${written.reason}`)
  return batchId
}

test('POST /delete says already quarantined when a batch holds the missing session', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-reclaim-delete-quarantine-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const batchId = quarantineSession(home, TARGET)
    const { ctx, handlers } = recordingHost()
    registerRoutes(ctx, {})

    const handler = handlers.get('/api/dsh-reclaim/delete')
    const response = await handler({
      text: async () => JSON.stringify({ sessionId: TARGET, confirm: true }),
    })
    const body = await response.json()

    assert.equal(response.status, 200, `expected an answer, not a failure response: ${JSON.stringify(body)}`)
    assert.equal(body.ok, false)
    assert.equal(body.sourceGone, true)
    assert.notEqual(body.alreadyInQuarantine, null, 'the quarantine batch holding this session was not reported')
    assert.equal(body.alreadyInQuarantine.batchId, batchId)
    assert.equal(body.alreadyInQuarantine.canRestore, true)
    assert.ok(
      body.plan.blockers.some((entry) => entry.code === 'session-dir-not-found'),
      'the answer should still explain what was refused',
    )
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})

test('POST /delete reports a vanished source, not a quarantine hit, when no batch holds it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-reclaim-delete-gone-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const { ctx, handlers } = recordingHost()
    registerRoutes(ctx, {})

    const handler = handlers.get('/api/dsh-reclaim/delete')
    const response = await handler({
      text: async () => JSON.stringify({ sessionId: TARGET, confirm: true }),
    })
    const body = await response.json()

    assert.equal(response.status, 200)
    assert.equal(body.ok, false)
    assert.equal(body.sourceGone, true)
    assert.equal(body.alreadyInQuarantine, null)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})
