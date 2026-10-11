/**
 * `GET /trash` — the archive residue, and the listing it must not pay for twice.
 *
 * The panel opens the audit and the quarantine in the same breath
 * (`Promise.all([classify, trash])`), and both need the session listing: the audit to grade
 * rows, the quarantine to say which archived ids are still live, still held by a workspace,
 * or now dangling. A second full listing of the session store answers a question the first
 * read already answered, so the route joins the audit's read instead.
 *
 * The assertion that matters here is not the saving but the honesty rule it must not break:
 * an unreadable listing makes every archived id look dangling, and "everything is dangling"
 * is a confident wrong answer. So the unavailable case is reported as unavailable.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { registerRoutes } from '../lib/routes.js'

/** A synthetic DSH home with the three trees the scan reads, all empty. */
function emptyHome() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-reclaim-trash-route-'))
  for (const dir of ['sessions', 'attachments/v1', 'cache']) {
    mkdirSync(join(home, dir), { recursive: true })
  }
  return home
}

/**
 * A host whose session listing is countable.
 *
 * `listSessions` is the seam that costs the real read, so counting its calls is how "did this
 * route read the store again?" becomes an observable fact rather than a claim in a comment.
 */
function countingHost({ archived = [] } = {}) {
  const handlers = new Map()
  let listings = 0
  const ctx = {
    effect: (fn) => fn(),
    connection: { fetch: { register: (entry) => handlers.set(entry.path, entry.fetch) } },
    get(name) {
      if (name === 'sessions') return { get: () => undefined }
      if (name === 'sessionQuery') {
        return {
          listSessions: async () => {
            listings += 1
            return []
          },
        }
      }
      if (name === 'workspaceRegistry') return { archivedSessionIds: archived, list: () => [] }
      return undefined
    },
  }
  return { ctx, handlers, listings: () => listings }
}

/** Call one route on a freshly registered table, with `DSH_HOME` pointed at `home`. */
async function call(home, host, path, url, register = registerRoutes) {
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    register(host.ctx, {})
    const handler = host.handlers.get(path)
    assert.equal(typeof handler, 'function', `${path} must be registered`)
    const response = await handler({ url: `http://127.0.0.1${url}` })
    return { response, body: await response.json() }
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
}

const home = emptyHome()

test('the quarantine reuses the audit\'s listing instead of reading the store again', async () => {
  const host = countingHost({ archived: [] })

  // A cold quarantine view still needs a listing of its own: nothing has been read yet.
  const cold = await call(home, host, '/api/dsh-reclaim/trash', '/api/dsh-reclaim/trash')
  assert.equal(cold.body.ok, true, `the trash route failed: ${JSON.stringify(cold.body).slice(0, 300)}`)
  assert.equal(host.listings(), 1, 'a cold quarantine view did not read the session store')
  assert.equal(cold.body.archivedResidue.ok, true)

  // The audit reads it once, for itself.
  await call(home, host, '/api/dsh-reclaim/classify', '/api/dsh-reclaim/classify?thresholdDays=30')
  assert.equal(host.listings(), 2, 'the audit did not read the session store')

  // ...and the quarantine, asked again, joins the generation the audit left behind.
  const warm = await call(home, host, '/api/dsh-reclaim/trash', '/api/dsh-reclaim/trash')
  assert.equal(warm.body.ok, true)
  assert.equal(warm.body.archivedResidue.ok, true)
  assert.equal(host.listings(), 2, 'the quarantine read the session store a second time for the same answer')
})

test('an unreadable listing is an unreadable residue, never a confident "everything dangles"', async () => {
  // Its own copy of the module, so this test observes the route with no scan generation
  // behind it: the fact cache is process-wide, and a generation left by the test above would
  // (correctly) be reused here, which would hide the case under test.
  const isolated = await import('../lib/routes.js?isolated=residue')

  // No sessionQuery at all: the listing seam is missing, which is exactly the case where a
  // `?? []` would silently classify every archived id as no-longer-live.
  const host = countingHost({ archived: ['ghost-1'] })
  host.ctx.get = (name) => {
    if (name === 'sessions') return { get: () => undefined }
    if (name === 'workspaceRegistry') return { archivedSessionIds: ['ghost-1'], list: () => [] }
    return undefined
  }

  const { body } = await call(
    home,
    host,
    '/api/dsh-reclaim/trash',
    '/api/dsh-reclaim/trash',
    isolated.registerRoutes,
  )
  assert.equal(body.ok, true, 'the quarantine view itself must still render')
  assert.equal(body.archivedResidue.ok, false, 'a missing listing was reported as a classified residue')
  assert.equal(body.archivedResidue.dangling, null, 'a missing listing produced dangling ids out of nothing')
  assert.equal(body.archivedResidue.live, null)
  assert.equal(body.archivedResidue.archived, null)
  assert.match(String(body.archivedResidue.reason), /unavailable|could not be read/)
})
