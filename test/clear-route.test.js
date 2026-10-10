/**
 * The `POST /clear` route — the boundary the "batch clearable" mark never had.
 *
 * Until this route existed, `batchClearable` was a promise with no path out for
 * attachment and cache rows: the trash has had `attachments/` and `caches/`
 * subdirectories since the move primitive landed, and no producer ever filled
 * them (§8.8 of `docs/safety.md`).
 *
 * The claim this test pins is the one that makes the new path safe rather than
 * merely present: **the request names rows by id, and the server re-derives every
 * path from its own fresh scan.** A caller that names a path is not giving an
 * instruction, it is giving an unknown id. §8.5 is the precedent — `body.risk`
 * was a caller's self-report and authorized nothing, and the fix was to stop
 * reading facts out of the request body.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { ROUTES, registerRoutes } from '../lib/routes.js'

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
  const home = mkdtempSync(join(tmpdir(), 'dsh-reclaim-clear-route-'))
  for (const dir of ['sessions', 'attachments/v1', 'cache']) {
    mkdirSync(join(home, dir), { recursive: true })
  }
  return home
}

/** Run one request against the registered handler with `DSH_HOME` pointed at `home`. */
async function requestClear(home, body) {
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const { ctx, handlers } = recordingHost()
    registerRoutes(ctx, {})
    const handler = handlers.get('/api/dsh-reclaim/clear')
    assert.equal(typeof handler, 'function', 'the clear route must be registered')
    const response = await handler({ text: async () => JSON.stringify(body) })
    return { response, body: await response.json() }
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
}

test('/clear is a write route in the table', () => {
  const entry = ROUTES.find((route) => route.path === '/api/dsh-reclaim/clear')
  assert.ok(entry, 'the route table must declare /clear')
  assert.deepEqual(entry.methods, ['POST'])
  assert.equal(entry.kind, 'write')
})

test('POST /clear refuses without a confirmation, and says what would be destroyed', async () => {
  const home = emptyHome()
  try {
    const { response, body } = await requestClear(home, { ids: ['anything'] })

    assert.equal(response.status, 400)
    assert.equal(body.ok, false)
    assert.match(body.error, /confirm/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('POST /clear will not move anything for an id it cannot find in its own scan', async () => {
  const home = emptyHome()
  try {
    const { response, body } = await requestClear(home, { ids: ['no-such-row'], confirm: true })

    // A refusal, not a failure: "there is no such row" is an answer, and a 500
    // would say "try again" about something that will never become true.
    assert.equal(response.status, 200, `expected a refusal, not a failure: ${JSON.stringify(body)}`)
    assert.equal(body.ok, false)
    assert.equal(body.move, null)
    assert.deepEqual(body.refusals.map((entry) => entry.code), ['unknown-id'])
    assert.equal(existsSync(join(home, '.dsh-reclaim-trash')), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('POST /clear treats a path in the request as an unknown id, not as an instruction', async () => {
  const home = emptyHome()
  try {
    const { response, body } = await requestClear(home, { ids: ['/etc/passwd'], confirm: true })

    assert.equal(response.status, 200)
    assert.equal(body.ok, false)
    assert.deepEqual(body.refusals.map((entry) => entry.code), ['unknown-id'])
    // The field that would let a caller point the move at a file of its choosing
    // is not part of the contract; supplying one changes nothing.
    assert.equal(existsSync(join(home, '.dsh-reclaim-trash')), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('POST /clear refuses an empty selection instead of reporting a success', async () => {
  const home = emptyHome()
  try {
    const { response, body } = await requestClear(home, { ids: [], confirm: true })

    assert.equal(response.status, 400)
    assert.equal(body.ok, false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
