import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { indexAttachmentsOnDisk, gradeAll } from '../lib/classification-report.js'
import { planClearCandidates } from '../lib/clear-objects.js'
import { deleteSessionItems } from '../lib/trash.js'
import { restoreBatch } from '../lib/restore.js'
import { resolveLayout } from '../lib/paths.js'

test('indexAttachmentsOnDisk handles 2-segment (file-objects/objects) and 3-segment (files) shapes', () => {
  const hash = '60750f23b957e41e77de87b102367d94067181a1cfb1f5fb51ec4a70f7ef9b9c'
  const shard = '60'
  const fileObjPath = `/home/.dsh/attachments/v1/file-objects/${shard}/${hash}`
  const filesPath = `/home/.dsh/attachments/v1/files/${shard}/${hash}/contract.docx`
  const objectPath = `/home/.dsh/attachments/v1/objects/aa/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`

  const attachments = {
    families: [
      {
        id: 'file-objects',
        fileList: [{ path: fileObjPath, bytes: 34800, relativePath: `${shard}/${hash}` }],
      },
      {
        id: 'files',
        fileList: [{ path: filesPath, bytes: 34800, relativePath: `${shard}/${hash}/contract.docx` }],
      },
      {
        id: 'objects',
        fileList: [
          {
            path: objectPath,
            bytes: 5000,
            relativePath: 'aa/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          },
        ],
      },
    ],
  }

  const indexed = indexAttachmentsOnDisk(attachments)
  assert.equal(indexed.available, true)
  assert.equal(indexed.byId.has(hash), true)
  assert.equal(indexed.byId.has('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), true)

  const entry = indexed.byId.get(hash)
  assert.equal(entry.id, hash)
  assert.equal(entry.bytes, 34800) // byte count is not doubled
  assert.equal(entry.files, 2)
  assert.equal(entry.name, 'contract.docx')

  const files = indexed.filesById.get(hash)
  assert.equal(files.length, 2)
  assert.deepEqual(
    files.map((f) => f.path).sort(),
    [fileObjPath, filesPath].sort(),
  )
})

test('an unreferenced file attachment on disk is graded safe and batchClearable', () => {
  const hash = '60750f23b957e41e77de87b102367d94067181a1cfb1f5fb51ec4a70f7ef9b9c'
  const shard = '60'
  const fileObjPath = `/home/.dsh/attachments/v1/file-objects/${shard}/${hash}`
  const filesPath = `/home/.dsh/attachments/v1/files/${shard}/${hash}/contract.docx`

  const report = gradeAll(
    {
      sessions: { sessions: [{ id: 'session-1', live: false, createdAt: Date.now() - 1000 }] },
      graph: {
        ok: true,
        attachments: [], // No session references this attachment
        sessionEdges: [],
        orphanDetermination: { allowed: true, unknownSessions: [] },
      },
      attachments: {
        families: [
          {
            id: 'file-objects',
            fileList: [{ path: fileObjPath, bytes: 34800, relativePath: `${shard}/${hash}` }],
          },
          {
            id: 'files',
            fileList: [{ path: filesPath, bytes: 34800, relativePath: `${shard}/${hash}/contract.docx` }],
          },
        ],
      },
    },
    {
      probe: () => ({ live: false, source: 'test' }),
      config: { thresholdDays: 7 },
      nowMs: Date.now(),
    },
  )

  const row = report.attachments.find((r) => r.id === hash)
  assert.notEqual(row, undefined, 'unreferenced attachment must be graded as a row')
  assert.equal(row.tier, 'safe')
  assert.equal(row.selectable, true)
  assert.equal(row.batchClearable, true)
  assert.equal(row.facts.name, 'contract.docx')
  assert.deepEqual(row.facts.paths.sort(), [fileObjPath, filesPath].sort())
  // The families travel with the row as an array, not as the internal Set (a Set serialises
  // to `{}` on the wire): the panel needs them to tell an upload from an image.
  assert.deepEqual(row.facts.families.sort(), ['file-objects', 'files'])
  assert.equal(row.freedByDeletingBytes, 34800)
})

test('clearing an attachment moves both files/ and file-objects/ paths to trash, and restore restores both', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-reclaim-attachment-clear-'))
  const layout = resolveLayout({ configuredHome: home })
  const hash = '60750f23b957e41e77de87b102367d94067181a1cfb1f5fb51ec4a70f7ef9b9c'
  const shard = '60'

  const fileObjDir = join(home, 'attachments/v1/file-objects', shard)
  const filesDir = join(home, 'attachments/v1/files', shard, hash)
  mkdirSync(fileObjDir, { recursive: true })
  mkdirSync(filesDir, { recursive: true })

  const fileObjPath = join(fileObjDir, hash)
  const filesPath = join(filesDir, 'contract.docx')
  writeFileSync(fileObjPath, 'original file content\n')
  writeFileSync(filesPath, 'original file content\n')

  try {
    const row = {
      id: hash,
      kind: 'attachment',
      batchClearable: true,
      facts: { paths: [fileObjPath, filesPath], bytes: 22 },
    }
    const plan = planClearCandidates([row], [hash])
    assert.equal(plan.ok, true, plan.reason ?? '')
    assert.equal(plan.items.length, 2)

    const move = await deleteSessionItems({ layout, items: plan.items })
    assert.equal(move.ok, true, move.reason ?? '')
    assert.equal(move.moved.length, 2)

    // Original files are moved into quarantine
    assert.equal(existsSync(fileObjPath), false)
    assert.equal(existsSync(filesPath), false)

    // Restore batch restores both
    const restored = await restoreBatch(move.batchDir, { layout })
    assert.equal(restored.ok, true, restored.reason ?? '')
    assert.equal(existsSync(fileObjPath), true)
    assert.equal(existsSync(filesPath), true)
    assert.equal(readFileSync(fileObjPath, 'utf8'), 'original file content\n')
    assert.equal(readFileSync(filesPath, 'utf8'), 'original file content\n')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
