import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { scanAttachments } from '../lib/attachments.js'
import { resolveLayout } from '../lib/paths.js'

test('macOS .DS_Store is not reported as an unknown object', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-reclaim-dsstore-'))
  const layout = resolveLayout({ configuredHome: home })
  const root = join(home, 'attachments', 'v1')
  mkdirSync(join(root, 'objects'), { recursive: true })

  const metadata = '.DS_Store'
  const leftover = 'leftover.bin'
  writeFileSync(join(root, metadata), 'finder metadata')
  writeFileSync(join(root, leftover), 'real unknown')

  try {
    const report = await scanAttachments(layout)
    const paths = report.unknown.map((entry) => entry.path)

    // The Finder file is filtered at enumeration time, so it is absent from the
    // list, the count and the byte total alike — the three cannot drift apart.
    assert.equal(paths.includes(join(root, metadata)), false)
    assert.equal(paths.includes(join(root, leftover)), true)
    assert.equal(report.totals.unknownFiles, 1)
    assert.equal(report.totals.unknownBytes, Buffer.byteLength('real unknown'))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
