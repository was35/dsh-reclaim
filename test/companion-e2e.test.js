import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply, getCompanionState } from '../lib/index.js'
import { registerRoutes } from '../lib/routes.js'

function setupTestEnvironment() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-reclaim-e2e-'))
  const sessionsDir = join(home, 'sessions', '--workspace--')
  const attachmentsDir = join(home, 'attachments', 'v1', 'files')
  const fileObjectsDir = join(home, 'attachments', 'v1', 'file-objects')
  const objectsDir = join(home, 'attachments', 'v1', 'objects')
  const cacheDir = join(home, 'cache', 'attachments', 'request-images')
  mkdirSync(sessionsDir, { recursive: true })
  mkdirSync(attachmentsDir, { recursive: true })
  mkdirSync(fileObjectsDir, { recursive: true })
  mkdirSync(objectsDir, { recursive: true })
  mkdirSync(cacheDir, { recursive: true })

  const handlers = new Map()
  const listeners = new Map()
  let activeSessions = []

  const sessionQuery = {
    listSessions: async () => activeSessions,
    observeSession: async (sessionId) => {
      const match = activeSessions.find((s) => s.header?.id === sessionId)
      if (!match) return null
      return {
        source: 'prepared',
        header: { id: sessionId },
        inheritedEventCount: 0,
        events: [
          {
            type: 'turn/start',
            seq: 0,
            time: 1,
            data: { attachmentId: match.attachmentSha },
          },
        ],
        cursor: 0,
        revision: 'rev-1',
        [Symbol.dispose]() {},
      }
    },
  }

  const attachmentsStore = {
    imageHostPath: (ref) => {
      const id = String(ref?.attachmentId ?? '').replace('sha256:', '')
      return join(home, 'attachments', 'v1', 'objects', id.slice(0, 2), id)
    },
    fileHostPath: (ref) => {
      const id = String(ref?.attachmentId ?? '').replace('sha256:', '')
      return join(home, 'attachments', 'v1', 'files', id.slice(0, 2), id, ref.name)
    },
  }

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
      if (name === 'sessionQuery') return sessionQuery
      if (name === 'attachments') return attachmentsStore
      return undefined
    },
  }

  return {
    home,
    sessionsDir,
    attachmentsDir,
    fileObjectsDir,
    objectsDir,
    handlers,
    listeners,
    ctx,
    setActiveSessions: (sessions) => {
      activeSessions = sessions
    },
  }
}

test('companion E2E: session deletion by upstream unblocks orphan attachment for quarantine and restore', async () => {
  const env = setupTestEnvironment()
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = env.home

  try {
    apply(env.ctx, { thresholdDays: 30 })

    const sessionId = '11111111-1111-4111-8111-111111111111'
    const sessionDir = join(env.sessionsDir, `session-${sessionId}`)
    mkdirSync(sessionDir, { recursive: true })

    // Create an attachment object on disk
    const attachmentContent = 'Hello DSH companion test attachment'
    const attachmentSha = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    const objectPath = join(env.objectsDir, attachmentSha.slice(0, 2), attachmentSha)
    mkdirSync(join(env.objectsDir, attachmentSha.slice(0, 2)), { recursive: true })
    writeFileSync(objectPath, attachmentContent)

    // Initially, upstream session exists and references this attachment
    env.setActiveSessions([
      {
        header: { id: sessionId, cwd: '/tmp', createdAt: 1735689600000 },
        live: false,
        persisted: true,
        attachmentSha,
      },
    ])

    // 1. Initial audit before session deletion: attachment is referenced, so in danger tier
    const classifyHandler = env.handlers.get('/api/dsh-reclaim/classify')
    assert.equal(typeof classifyHandler, 'function')

    const firstRes = await classifyHandler({ url: 'http://127.0.0.1/api/dsh-reclaim/classify?rescan=1' })
    const firstData = await firstRes.json()
    assert.equal(firstData.ok, true)

    // Verify attachment is present and NOT safe (referenced by active session)
    const dangerAttachments = firstData.tiers?.attachments?.danger ?? []
    const safeAttachmentsBefore = firstData.tiers?.attachments?.safe ?? []
    assert.equal(safeAttachmentsBefore.length, 0, 'attachment must not be safe while session exists')
    assert.ok(
      dangerAttachments.some((item) => item.id.includes(attachmentSha)),
      'attachment must be graded danger while referenced by session',
    )

    // 2. Upstream (@michengai/dsh-archive-manager) deletes the session
    // Upstream removes the session directory and drops it from its registry
    rmSync(sessionDir, { recursive: true, force: true })
    assert.equal(existsSync(sessionDir), false, 'upstream has removed session transcript')
    env.setActiveSessions([])

    // Upstream broadcasts Cordis api-session/removed event
    env.ctx.emit('api-session/removed', sessionId)

    // Verify companion status updated
    const companionStatus = getCompanionState()
    assert.equal(companionStatus.lastRemovedSessionId, sessionId)

    // 3. Re-classify after session deletion: attachment is now an unreferenced orphan!
    const secondRes = await classifyHandler({ url: 'http://127.0.0.1/api/dsh-reclaim/classify' })
    const secondData = await secondRes.json()
    assert.equal(secondData.ok, true)

    const safeAttachmentsAfter = secondData.tiers?.attachments?.safe ?? []
    const orphanItem = safeAttachmentsAfter.find((item) => item.id.includes(attachmentSha))
    assert.notEqual(orphanItem, undefined, 'orphan attachment must now be graded safe for quarantine')
    assert.equal(orphanItem.batchClearable, true)

    // 4. Clear the orphan attachment into quarantine
    const clearHandler = env.handlers.get('/api/dsh-reclaim/clear')
    assert.equal(typeof clearHandler, 'function')

    const clearRes = await clearHandler({
      method: 'POST',
      text: async () => JSON.stringify({ ids: [orphanItem.id], confirm: true }),
    })
    const clearData = await clearRes.json()
    assert.equal(clearData.ok, true, `clear must succeed: ${JSON.stringify(clearData)}`)
    assert.equal(clearData.move.moved.length, 1)

    // Verify file is gone from active attachments and moved to trash
    assert.equal(existsSync(objectPath), false, 'orphan attachment must be moved out of live attachments')
    const batchId = clearData.move.batchId
    assert.ok(typeof batchId === 'string' && batchId.length > 0)

    // 5. Restore the quarantined batch
    const restoreHandler = env.handlers.get('/api/dsh-reclaim/restore')
    assert.equal(typeof restoreHandler, 'function')

    const restoreRes = await restoreHandler({
      method: 'POST',
      text: async () => JSON.stringify({ batch: batchId, confirm: true }),
    })
    const restoreData = await restoreRes.json()
    assert.equal(restoreData.ok, true, `restore must succeed: ${JSON.stringify(restoreData)}`)

    // Verify file is restored byte-for-byte to its original location
    assert.equal(existsSync(objectPath), true, 'restored file must be back at original path')
    assert.equal(readFileSync(objectPath, 'utf8'), attachmentContent, 'restored content must match exactly')
  } finally {
    process.env.DSH_HOME = previousHome
    rmSync(env.home, { recursive: true, force: true })
  }
})
