/**
 * The `restoreBatch` seam — the guard must be on by default.
 *
 * Fixing the async/sync comparison is only half of §8.6: the guard also reads
 * `options.isInsideTrash !== undefined && …`, so it stays dead whenever the
 * caller injects nothing — and BOTH real callers inject nothing
 * (`lib/routes.js:590` for the plan, `lib/routes.js:614` for the restore).
 * `POST /restore` therefore plans a normal restore for an entry whose recorded
 * original path is inside the quarantine, and performs it.
 *
 * The executor is the right place to bind the default: it is the thing that
 * touches the filesystem. `DELETE`'s path already does exactly this
 * (`lib/trash.js:687` — `options.isInsideTrash ?? makeIsInsideTrash(layout)`),
 * so this pins the same discipline on the restore side rather than inventing a
 * new one.
 *
 * This test deliberately injects NOTHING but `$DSH_HOME`: it exercises the
 * production default, not an injected double.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { MANIFEST_NAME } from '../lib/manifest.js'
import { restoreBatch } from '../lib/restore.js'

test('restoreBatch refuses to restore into the quarantine when the caller injects no predicate', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-reclaim-restore-batch-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const trashRoot = join(home, '.dsh-reclaim-trash')
    const batchDir = join(trashRoot, '2026-01-01T00-00-00')

    const relativePath = 'sessions/item/manifest.json'
    mkdirSync(join(batchDir, 'sessions', 'item'), { recursive: true })
    writeFileSync(join(batchDir, relativePath), '{}')

    const originalPath = join(trashRoot, 'somewhere', 'item', 'manifest.json')
    writeFileSync(
      join(batchDir, MANIFEST_NAME),
      JSON.stringify({
        schemaVersion: 1,
        batchId: '2026-01-01T00-00-00',
        volumeRoot: null,
        entries: [{ originalPath, relativePath, kind: 'session' }],
      }),
    )

    // No `isInsideTrash` — this is the shape the HTTP route uses.
    const result = await restoreBatch(batchDir)

    assert.equal(result.restored.length, 0, 'nothing may be restored into the quarantine')
    assert.equal(result.blocked.length, 1)
    assert.equal(result.blocked[0].status, 'target-inside-trash')
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})
