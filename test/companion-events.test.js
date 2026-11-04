import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply, getCompanionState, invalidateFactCache } from '../lib/index.js'
import { registerRoutes } from '../lib/routes.js'

function createMockHost() {
  const handlers = new Map()
  const listeners = new Map()
  const ctx = {
    effect: (fn) => fn(),
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(handler)
    },
    emit(event, ...args) {
      const list = listeners.get(event) ?? []
      for (const fn of list) fn(...args)
    },
    connection: {
      fetch: {
        register: (entry) => handlers.set(entry.path, entry.fetch),
      },
    },
    get(name) {
      if (name === 'sessions') return { get: () => undefined }
      return undefined
    },
  }
  return { ctx, handlers, listeners }
}

function emptyHome() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-reclaim-companion-'))
  for (const dir of ['sessions', 'attachments/v1', 'cache']) {
    mkdirSync(join(home, dir), { recursive: true })
  }
  return home
}

test('companion listener registers on api-session/removed and invalidates fact cache', async () => {
  const home = emptyHome()
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home

  try {
    const { ctx, handlers, listeners } = createMockHost()
    apply(ctx, { thresholdDays: 30 })

    assert.ok(listeners.has('api-session/removed'), 'should register api-session/removed listener')

    // Initial classify request to populate factCache
    const classifyHandler = handlers.get('/api/dsh-reclaim/classify')
    const firstRes = await classifyHandler({ url: 'http://127.0.0.1/api/dsh-reclaim/classify' })
    const firstBody = await firstRes.json()
    assert.equal(firstBody.factsFromCache, false, 'first classify must read fresh facts')

    // Second classify request without rescan should reuse cache
    const secondRes = await classifyHandler({ url: 'http://127.0.0.1/api/dsh-reclaim/classify' })
    const secondBody = await secondRes.json()
    assert.equal(secondBody.factsFromCache, true, 'second classify must reuse cached facts')

    // Simulate upstream session removal from @michengai/dsh-archive-manager
    const testSessionId = '00000000-0000-0000-0000-000000000042'
    ctx.emit('api-session/removed', testSessionId)

    // Verify companion status updated
    const companionStatus = getCompanionState()
    assert.equal(companionStatus.lastRemovedSessionId, testSessionId)
    assert.ok(companionStatus.eventCount >= 1)
    assert.ok(typeof companionStatus.lastRemovedAt === 'string')

    // Route /api/dsh-reclaim/companion-status returns this state
    const companionHandler = handlers.get('/api/dsh-reclaim/companion-status')
    assert.equal(typeof companionHandler, 'function')
    const statusRes = await companionHandler({ url: 'http://127.0.0.1/api/dsh-reclaim/companion-status' })
    const statusBody = await statusRes.json()
    assert.equal(statusBody.ok, true)
    assert.equal(statusBody.lastRemovedSessionId, testSessionId)

    // Third classify request must NOT reuse cache, must read fresh facts
    const thirdRes = await classifyHandler({ url: 'http://127.0.0.1/api/dsh-reclaim/classify' })
    const thirdBody = await thirdRes.json()
    assert.equal(thirdBody.factsFromCache, false, 'classify after event must read fresh facts')
  } finally {
    process.env.DSH_HOME = previousHome
  }
})
