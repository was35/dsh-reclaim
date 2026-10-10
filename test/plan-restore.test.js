/**
 * The `planRestore` seam — the "target is inside the quarantine" refusal.
 *
 * Same defect as `planMove` (`test/plan-move.test.js`), one module over:
 * `makeIsInsideTrash` is documented to return
 * `(candidatePath) => Promise<boolean>` (`lib/paths.js:329`, `lib/paths.js:346`),
 * but `planRestore` compares its result with a SYNCHRONOUS `=== true`
 * (`lib/restore.js:89`), so a restore whose recorded original path sits inside
 * the quarantine is planned as a normal restore. `lib/restore.js:57` even
 * declares the parameter as `(path: string) => boolean` — the type that made the
 * mistake look correct. Recorded as §8.6 of `docs/safety.md`.
 *
 * The manifest is hand-written rather than produced by a move, so the test pins
 * exactly the branch under test. `volumeRoot: null` is deliberate: the manifest
 * validator skips its two-path-forms agreement check when no volume root is
 * recorded (`lib/manifest.js:121-123`), which keeps this fixture about the
 * restore guard and nothing else.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { MANIFEST_NAME } from '../lib/manifest.js'
import { makeIsInsideTrash } from '../lib/paths.js'
import { planRestore } from '../lib/restore.js'

/** A quarantine batch holding one item whose recorded original path is in the trash. */
function batchWhoseTargetLivesInTheQuarantine() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-reclaim-plan-restore-'))
  const trashRoot = join(home, '.dsh-reclaim-trash')
  const batchDir = join(trashRoot, '2026-01-01T00-00-00')

  // The batch really does hold the item — otherwise the plan would stop at
  // `batch-item-missing` and never reach the guard under test.
  const relativePath = 'sessions/item/manifest.json'
  mkdirSync(join(batchDir, 'sessions', 'item'), { recursive: true })
  writeFileSync(join(batchDir, relativePath), '{}')

  // The recorded original path is INSIDE the quarantine: restoring there would
  // write the trash into itself.
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

  return { home, trashRoot, batchDir, originalPath }
}

test('planRestore refuses a batch item whose original path is inside the quarantine', async () => {
  const { home, trashRoot, batchDir, originalPath } = batchWhoseTargetLivesInTheQuarantine()
  try {
    const isInsideTrash = makeIsInsideTrash({ trash: { root: trashRoot } })

    // The control that isolates the bug to `planRestore`'s comparison.
    assert.equal(await isInsideTrash(originalPath), true)

    const plan = await planRestore(batchDir, { isInsideTrash })

    assert.equal(plan.ok, true)
    assert.equal(plan.items.length, 1)
    assert.equal(plan.items[0].status, 'target-inside-trash')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
