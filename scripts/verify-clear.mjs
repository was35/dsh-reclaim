/**
 * The clear-and-restore half of the host loop.
 *
 * WHY THIS IS NOT A UNIT TEST
 * `planClearCandidates` is unit-tested against synthetic rows, but the rows
 * themselves cannot be faked into existence: a cache family is only graded
 * `safe` when the attachment backend probe confirms the mounted store is
 * host-file-backed and rooted in the tree this plugin scans
 * (`lib/backend-check.js`). The unit loop maps `@deepseek-ai/dsh-home-paths` to a
 * double, so nothing enumerates there and every cache row comes back
 * `unclassified`. Only the real host can produce a clearable row, so only the
 * real host can prove that clearing one works — and, more importantly, that it
 * is reversible.
 *
 * WHAT IT PROVES, IN ORDER
 *   1. a planted rebuildable cache family is graded safe and batch-clearable;
 *   2. `POST /clear` moves it into the quarantine and the bytes leave the tree;
 *   3. the batch's manifest records it under the `caches/` subdirectory, so
 *      restoring it later does not have to guess where it came from;
 *   4. `POST /restore` puts it back, byte for byte.
 *
 * Step 4 is the one that matters. The whole promise of this plugin is that
 * cleanup is a move and not a delete, and a promise about restoring is only
 * worth anything if something actually restores.
 *
 * Usage: node scripts/verify-clear.mjs --port <n> --jar <cookie jar>
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const args = new Map()
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1])
const port = args.get('--port')
const jar = args.get('--jar')
if (port === undefined || jar === undefined) {
  console.error('usage: node scripts/verify-clear.mjs --port <n> --jar <cookie jar>')
  process.exit(2)
}

/** The cookie header, read out of curl's Netscape-format jar. */
function cookieHeader(path) {
  const pairs = []
  for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
    // curl marks HttpOnly cookies with a `#HttpOnly_` prefix, which is still a
    // cookie line; every other `#` line is a real comment.
    const line = rawLine.startsWith('#HttpOnly_') ? rawLine.slice('#HttpOnly_'.length) : rawLine
    if (line.startsWith('#') || line.trim() === '') continue
    const fields = line.split('\t')
    if (fields.length >= 7) pairs.push(`${fields[5]}=${fields[6]}`)
  }
  if (pairs.length === 0) throw new Error(`no cookies found in ${path}`)
  return pairs.join('; ')
}

const cookie = cookieHeader(jar)

async function api(path, init = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: { cookie, ...(init.body === undefined ? {} : { 'content-type': 'application/json' }), ...(init.headers ?? {}) },
  })
  const body = await response.json()
  return { status: response.status, body }
}

function fail(message) {
  console.error(`FAIL: ${message}`)
  process.exit(1)
}

/** Every file under `dir`, as `relative path → contents`. */
function snapshot(dir) {
  const out = new Map()
  const walk = (current, prefix) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      const key = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) walk(full, key)
      else out.set(key, readFileSync(full, 'utf8'))
    }
  }
  if (existsSync(dir)) walk(dir, '')
  return out
}

// --- 1. where the host actually keeps the rebuildable image cache ----------
const health = await api('/api/dsh-reclaim/health')
if (health.status !== 200 || health.body.ok !== true) fail(`/health was not green: ${JSON.stringify(health.body)}`)
const family = (health.body.families ?? []).find((entry) => entry.id === 'request-images')
if (family === undefined) fail('/health reported no request-images family')
const familyPath = family.path
if (typeof familyPath !== 'string' || !familyPath.includes('cache')) {
  fail(`request-images resolved to ${JSON.stringify(familyPath)}, which is not the cache location`)
}
console.log(`   family path   : ${familyPath}`)

// --- 2. plant something real to clear -------------------------------------
const planted = {
  'ab/one.bin': 'dsh-reclaim host loop fixture one\n',
  'cd/two.bin': 'dsh-reclaim host loop fixture two\n',
}
for (const [relativePath, contents] of Object.entries(planted)) {
  const full = join(familyPath, relativePath)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, contents)
}
const before = snapshot(familyPath)
if (before.size !== 2) fail(`the fixture did not land: ${JSON.stringify([...before.keys()])}`)
const plantedBytes = [...before.values()].reduce((total, contents) => total + Buffer.byteLength(contents), 0)
console.log(`   planted       : ${before.size} file(s), ${plantedBytes} B under ${familyPath}`)

// --- 3. it must be graded clearable, or nothing below means anything ------
const classify = await api('/api/dsh-reclaim/classify?rescan=1')
if (classify.status !== 200) fail(`/classify returned ${classify.status}`)
const row = (classify.body.tiers?.caches?.safe ?? []).find(
  (entry) => entry.id === 'cache-family:request-images' && entry.batchClearable === true,
)
if (row === undefined) {
  const all = Object.entries(classify.body.tiers?.caches ?? {}).flatMap(([bucket, rows]) =>
    rows.map((entry) => `${bucket}:${entry.id}${entry.facts?.reason === undefined ? '' : ` (${entry.facts.reason})`}`),
  )
  fail(`no safe, batch-clearable request-images row; cache rows were ${JSON.stringify(all)}`)
}
console.log(`   graded        : ${row.id} tier=${row.tier} batchClearable=${row.batchClearable} bytes=${row.bytes}`)

// --- 4. clear it ----------------------------------------------------------
const cleared = await api('/api/dsh-reclaim/clear', {
  method: 'POST',
  body: JSON.stringify({ ids: [row.id], confirm: true }),
})
if (cleared.status !== 200 || cleared.body.ok !== true) {
  fail(`/clear refused: ${JSON.stringify(cleared.body)}`)
}
const move = cleared.body.move
if (move.moved.length !== 1) fail(`expected one moved item, got ${JSON.stringify(move.moved)}`)
if (existsSync(familyPath)) fail(`${familyPath} still exists after the clear`)
console.log(`   cleared       : ${move.totals.moved} item(s), ${move.totals.bytes} B → ${move.batchDir}`)

// --- 5. the batch must record enough to put it back -----------------------
// The quarantine mirrors each item's path *relative to the volume root*, not
// its path relative to whatever directory the row happened to name, so the
// prefix cannot be guessed from the row alone. Read it out of the manifest
// instead: if the manifest did not carry this mapping, restore would have to
// reconstruct it, and a restore that guesses is not a restore.
const manifestPath = join(move.batchDir, 'manifest.json')
if (!existsSync(manifestPath)) fail(`the batch has no manifest.json: ${JSON.stringify(readdirSync(move.batchDir))}`)
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const entry = (manifest.entries ?? []).find((candidate) => candidate.originalPath === familyPath)
if (entry === undefined) {
  fail(`the manifest does not record ${familyPath}: ${JSON.stringify((manifest.entries ?? []).map((e) => e.originalPath))}`)
}
if (entry.kind !== 'cache') fail(`the manifest recorded kind=${JSON.stringify(entry.kind)}, expected "cache"`)
if (typeof entry.note !== 'string' || !entry.note.includes(row.id)) {
  fail(`the manifest does not say which row caused the move: ${JSON.stringify(entry.note)}`)
}
const quarantined = snapshot(join(move.batchDir, entry.relativePath))
if (quarantined.size !== before.size) fail(`the quarantine holds ${quarantined.size} file(s), expected ${before.size}`)
for (const [key, contents] of before) {
  if (quarantined.get(key) !== contents) fail(`${key} did not survive the move intact`)
}
console.log(`   quarantined   : ${entry.relativePath} holds ${quarantined.size} file(s), contents intact`)
console.log(`   recorded      : kind=${entry.kind} bytes=${entry.bytes} note=${JSON.stringify(entry.note)}`)

// --- 6. and it must come back ---------------------------------------------
const restored = await api('/api/dsh-reclaim/restore', {
  method: 'POST',
  body: JSON.stringify({ batch: move.batchDir, confirm: true }),
})
if (restored.status !== 200 || restored.body.ok !== true) fail(`/restore refused: ${JSON.stringify(restored.body)}`)
const after = snapshot(familyPath)
if (after.size !== before.size) fail(`after restoring, the family holds ${after.size} file(s), expected ${before.size}`)
for (const [key, contents] of before) {
  if (after.get(key) !== contents) fail(`${key} came back changed`)
}
console.log(`   restored      : ${after.size} file(s) back at ${familyPath}, byte for byte`)

console.log('PASS: a rebuildable cache family was cleared into the quarantine and restored byte for byte.')
