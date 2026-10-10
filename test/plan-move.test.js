/**
 * The `planMove` seam — the "already inside the quarantine" refusal.
 *
 * `makeIsInsideTrash` is documented to return `(candidatePath) => Promise<boolean>`
 * (`lib/paths.js:329`, `lib/paths.js:346`), but `planMove` compares its result
 * with a SYNCHRONOUS `=== true` (`lib/trash.js:244`). A Promise is never
 * `=== true`, so the guard never fires and a move whose source already sits
 * inside the quarantine is planned as a normal move — which would nest the
 * trash inside itself. Recorded as §8.6 of `docs/safety.md`.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { makeIsInsideTrash } from '../lib/paths.js'
import { planMove } from '../lib/trash.js'

/** A synthetic DSH home holding one real object already inside the quarantine. */
function quarantineWithOneItem() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-reclaim-plan-move-'))
  const trashRoot = join(home, '.dsh-reclaim-trash')
  const insidePath = join(trashRoot, '2026-01-01T00-00-00', 'sessions', 'item')
  mkdirSync(insidePath, { recursive: true })
  writeFileSync(join(insidePath, 'manifest.json'), '{}')
  return { home, trashRoot, insidePath }
}

test('planMove refuses a source that is already inside the quarantine', async () => {
  const { home, trashRoot, insidePath } = quarantineWithOneItem()
  try {
    const isInsideTrash = makeIsInsideTrash({ trash: { root: trashRoot } })

    // The predicate itself is correct — this is the control that isolates the
    // bug to `planMove`'s comparison rather than to `makeIsInsideTrash`.
    assert.equal(await isInsideTrash(insidePath), true)

    const plan = await planMove(insidePath, join(home, 'elsewhere', 'item'), { isInsideTrash })

    assert.equal(plan.status, 'already-in-trash')
    assert.equal(plan.sourcePath, insidePath)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
