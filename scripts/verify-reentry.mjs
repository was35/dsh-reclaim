/**
 * The #18 field report, replayed against the real host.
 *
 * WHY THIS IS NOT A UNIT TEST
 * #18 was reported from a real panel: nine sessions were submitted for quarantine, eight had
 * already been moved by an earlier click, and the ninth had been deleted outright when the
 * quarantine was emptied. The panel answered "0 of 9, 9 failed" - a report that reads like a
 * catastrophe when nothing was lost. #22 changed the counting, the wording and the guard; what
 * is left to prove is that the changed code says the right thing *against a real host*: real
 * quarantine batches, real manifests, real refusals, and the real panel reading them.
 *
 * WHAT IT PROVES, IN ORDER
 *   1. nine session directories are planted under the host's own session tree, and the ninth is
 *      removed outright - the state #18 described;
 *   2. the first submission moves eight of them into the quarantine and refuses the ninth with
 *      session-dir-not-found;
 *   3. the second submission - the repeat click - is refused for all nine, and eight of those
 *      refusals carry the quarantine batch that holds them: "already in the quarantine", not
 *      "failed";
 *   4. the real panel, asked about those nine real responses, reads them as 0 moved / 1 failed /
 *      8 already quarantined, says so in the live region, and takes all nine rows out of the
 *      selectable set.
 *
 * Step 3 is the one #22 was opened for. A refusal that cannot say *which* refusal it is forces
 * the panel to count a session that is safe and recoverable as a failure, and that is how nine
 * rows became nine failures in the first place.
 *
 * Usage: node scripts/verify-reentry.mjs --port <n> --jar <cookie jar>
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { loadPanel } from '../test/hooks/panel-harness.mjs'

const args = new Map()
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1])
const port = args.get('--port')
const jar = args.get('--jar')
if (port === undefined || jar === undefined) {
  console.error('usage: node scripts/verify-reentry.mjs --port <n> --jar <cookie jar>')
  process.exit(2)
}

/** The cookie header, read out of curl's Netscape-format jar. */
function cookieHeader(path) {
  const pairs = []
  for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
    // curl marks HttpOnly cookies with a #HttpOnly_ prefix, which is still a cookie line;
    // every other # line is a real comment.
    const line = rawLine.startsWith('#HttpOnly_') ? rawLine.slice('#HttpOnly_'.length) : rawLine
    if (line.startsWith('#') || line.trim() === '') continue
    const fields = line.split('\t')
    if (fields.length >= 7) pairs.push(fields[5] + '=' + fields[6])
  }
  if (pairs.length === 0) throw new Error('no cookies found in ' + path)
  return pairs.join('; ')
}

const cookie = cookieHeader(jar)

async function api(path, init = {}) {
  const headers = { cookie }
  if (init.body !== undefined) headers['content-type'] = 'application/json'
  const response = await fetch('http://127.0.0.1:' + port + path, { ...init, headers })
  return { status: response.status, body: await response.json() }
}

function fail(message) {
  console.error('FAIL: ' + message)
  process.exit(1)
}

/**
 * A valid, empty zstd frame.
 *
 * The host's session artifact is a zstd-compressed JSONL log. A file that cannot be decoded
 * would be a *broken* session rather than an empty one, and this host may read the tree back at
 * any moment - so the fixture is a frame that decodes to nothing, not random bytes.
 */
const EMPTY_ZSTD = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x20, 0x00, 0x01, 0x00, 0x00])

// --- the nine sessions of #18 -------------------------------------------------
// The ids carry a per-run stamp so a second run against a kept home starts from a clean
// slate: an id that is already in a quarantine batch would make the *first* submission
// answer "already quarantined", and the assertion it breaks would be about the run, not
// about the repeat.
const stamp = Date.now().toString(16).slice(-8)
const MOVED = Array.from({ length: 8 }, (_, index) => 'e2e2' + stamp + '-0000-4000-8000-00000000000' + (index + 1))
const GONE = 'e2e2' + stamp + '-0000-4000-8000-000000000099'
const IDS = [...MOVED, GONE]

/** The blocker codes of a refused delete, for a message that has to be readable. */
function blockerCodes(entry) {
  return (entry?.body?.plan?.blockers ?? []).map((blocker) => blocker.code)
}

/** One submission, in the panel's own shape: one request per session, in order. */
async function submitAll(ids) {
  const results = []
  for (const id of ids) {
    const response = await api('/api/dsh-reclaim/delete', {
      method: 'POST',
      body: JSON.stringify({ sessionId: id, confirm: true }),
    })
    results.push({ id, ok: response.body?.ok === true, body: response.body })
  }
  return results
}

// --- 1. where the host keeps its sessions, and what it says about them --------
const health = await api('/api/dsh-reclaim/health')
if (health.status !== 200 || health.body?.ok !== true) {
  fail('/health was not green: ' + JSON.stringify(health.body))
}
const home = health.body.home?.path
if (typeof home !== 'string' || home.length === 0) {
  fail('the host did not say where its home is: ' + JSON.stringify(health.body.home))
}
const sessionsRoot = join(home, 'sessions')
const workspaceDir = join(sessionsRoot, 'verify-reentry')
console.log('   home          : ' + home)
console.log('   session tree  : ' + workspaceDir)

// --- 2. plant the nine, and remove the ninth --------------------------------
for (const id of IDS) {
  const dir = join(workspaceDir, 'session-' + id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), EMPTY_ZSTD)
}
// The ninth session is not "moved" by the plugin at all: it was deleted outright when the
// quarantine was emptied. There is nothing left of it but its id.
rmSync(join(workspaceDir, 'session-' + GONE), { recursive: true, force: true })
console.log('   planted       : ' + MOVED.length + ' session(s); the ninth (' + GONE + ') was removed outright')

// --- 3. the first submission: eight move, one is refused ----------------------
const first = await submitAll(IDS)
const movedFirst = first.filter((entry) => entry.ok)
if (movedFirst.length !== MOVED.length) {
  fail(
    'the first submission moved ' + movedFirst.length + ' of ' + MOVED.length + ', not ' + MOVED.length + ': ' +
      JSON.stringify(
        first.map((entry) => ({ id: entry.id, ok: entry.ok, blockers: blockerCodes(entry), reason: entry.body?.reason ?? null })),
        null,
        2,
      ),
  )
}
for (const id of MOVED) {
  if (existsSync(join(workspaceDir, 'session-' + id))) {
    fail(id + ' is still in the session tree after the first submission')
  }
}
const goneFirst = first.find((entry) => entry.id === GONE)
if (goneFirst.body?.sourceGone !== true) {
  fail('the ninth session was not reported as source-gone: ' + JSON.stringify(goneFirst.body))
}
if (goneFirst.body?.alreadyInQuarantine !== null) {
  fail('the ninth session claimed a quarantine batch: ' + JSON.stringify(goneFirst.body?.alreadyInQuarantine))
}
console.log('   first click   : ' + movedFirst.length + ' moved into the quarantine, 1 refused (session-dir-not-found)')

// --- 4. the repeat click: the same nine again --------------------------------
const second = await submitAll(IDS)
for (const entry of second) {
  if (entry.ok !== false) fail('the repeat submission moved ' + entry.id + ' a second time')
  if (entry.body?.sourceGone !== true) {
    fail('the repeat submission did not report ' + entry.id + ' as source-gone: ' + JSON.stringify(entry.body))
  }
}
for (const id of MOVED) {
  const entry = second.find((candidate) => candidate.id === id)
  const held = entry.body?.alreadyInQuarantine
  if (held === null || held === undefined || typeof held.batchId !== 'string') {
    fail('the repeat submission did not say which batch holds ' + id + ': ' + JSON.stringify(entry.body?.alreadyInQuarantine))
  }
}
const goneSecond = second.find((entry) => entry.id === GONE)
if (goneSecond.body?.alreadyInQuarantine !== null) {
  fail('the ninth session claimed a quarantine batch: ' + JSON.stringify(goneSecond.body?.alreadyInQuarantine))
}
console.log('   repeat click  : 9 refused; 8 name the batch that holds them, 1 names none')

// --- 5. what the real panel makes of those nine real answers ----------------
const { react, plugin, seam } = loadPanel()
const summary = seam.summarizeRun(second)
if (summary.total !== 9) fail('the run counted ' + summary.total + ' item(s), not 9')
if (summary.moved !== 0) fail('the run moved ' + summary.moved + ' item(s), not 0')
if (summary.already !== 8) fail('the run read ' + summary.already + ' item(s) as already quarantined, not 8')
if (summary.failed !== 1) fail('the run read ' + summary.failed + ' item(s) as failed, not 1')
const failures = Array.from(summary.failures)
if (failures.length !== 1 || failures[0].id !== GONE) {
  fail('the run blamed the wrong item(s): ' + JSON.stringify(failures.map((failure) => failure.id)))
}
if (!Array.from(failures[0].codes).includes('session-dir-not-found')) {
  fail('the failure carries the wrong code: ' + JSON.stringify(Array.from(failures[0].codes)))
}
console.log('   the panel says: moved 0, already quarantined 8, failed 1 (' + GONE + ')')

const unavailable = seam.unavailableFromRun(summary)
for (const id of MOVED) {
  if (unavailable.get(id) !== 'row.inQuarantine') {
    fail(id + ' is not marked as already quarantined: ' + JSON.stringify(unavailable.get(id)))
  }
}
if (unavailable.get(GONE) !== 'row.sourceGone') {
  fail('the ninth session is not marked as source-gone: ' + JSON.stringify(unavailable.get(GONE)))
}

// A report carrying the nine sessions as the server grades them: safe and batch-clearable,
// which is exactly what they were when they were submitted the first time.
const report = {
  ok: true,
  scanCount: 1,
  gate: {},
  families: [],
  totals: { totalReclaimableBytes: 0, sessionCount: 9, dedupAttachmentCount: 0 },
  tiers: {
    sessions: {
      safe: IDS.map((id) => ({
        kind: 'session',
        id,
        tier: 'safe',
        tierReasons: [],
        blockingChecks: [],
        selectable: true,
        batchClearable: true,
        dedupCount: 0,
        freedByDeletingBytes: 4096,
        freedBreakdown: {},
        facts: {
          title: 'a session from the #18 report',
          archived: false,
          sizeBytes: 4096,
          lastActivity: '2026-01-01T00:00:00.000Z',
          ageDays: 41,
          workspacePath: '/home/Projects/demo',
          sessionIds: [],
        },
      })),
      confirm: [],
      danger: [],
      unclassified: [],
    },
    attachments: { safe: [], confirm: [], danger: [], unclassified: [] },
    caches: { safe: [], confirm: [], danger: [], unclassified: [], reportOnly: [] },
  },
}

const selectable = Array.from(seam.selectableSafeIds(report, unavailable))
if (selectable.length !== 0) {
  fail('the panel would still offer these rows for a bulk action: ' + JSON.stringify(selectable))
}

// --- 6. and what it says, in the words a user reads ------------------------
const noop = () => {}
const tree = seam.renderPanel(
  react,
  {
    t: (key, params) => plugin.__messages.translatePanel('zh', key, params),
    locale: 'zh',
    status: 'ready',
    error: null,
    report,
    trash: null,
    thresholdDays: 30,
    view: 'audit',
    selected: new Set(),
    busy: null,
    notice: null,
    run: summary,
    receipts: [],
    unavailable,
    reviewOpen: new Set(),
    collapsed: new Set(),
    openTiers: new Set(['safe']),
    openArtifacts: new Set(),
    uploadOpen: new Set(),
    uploadAll: new Set(),
  },
  {
    toggle: noop,
    toggleReview: noop,
    toggleGroup: noop,
    toggleTier: noop,
    toggleArtifactFold: noop,
    selectSafe: noop,
    selectSafeArtifacts: noop,
    clearSelection: noop,
    setThresholdDays: noop,
    setView: noop,
    refresh: noop,
    cleanUp: noop,
    cleanFamily: noop,
  },
)

/** Every element in the tree, depth first. */
function walk(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  out.push(node)
  for (const child of node.children ?? []) walk(child, out)
  return out
}

/** The text content of an element, concatenated. */
function textOf(node) {
  if (typeof node === 'string') return node
  if (node === null || node === undefined || typeof node !== 'object') return ''
  return (node.children ?? []).map(textOf).join(' ')
}

const nodes = walk(tree)
const runBar = nodes.find((node) => node.props?.['data-dshr-run'] !== undefined)
if (runBar?.props?.['data-dshr-run'] !== '0:1:8') {
  fail('the result bar reads ' + JSON.stringify(runBar?.props?.['data-dshr-run']) + ', not "0:1:8"')
}
const announcer = nodes.find((node) => node.props?.['data-dshr-announcer'] !== undefined)
const announced = textOf(announcer)
if (announced !== '已隔离 0 项，失败 1 项，已在隔离区 8 项。') {
  fail('the live region says "' + announced + '"')
}
const blamed = nodes.filter((node) => node.props?.['data-dshr-run-failure'] !== undefined)
if (blamed.length !== 1 || blamed[0].props['data-dshr-run-failure'] !== GONE) {
  fail('the result bar blames ' + JSON.stringify(blamed.map((node) => node.props['data-dshr-run-failure'])) + ', not the ninth')
}
for (const id of MOVED) {
  const badge = nodes.find((node) => node.props?.['data-dshr-unavailable-badge'] === id)
  if (badge === undefined || textOf(badge) !== '已在隔离区') {
    fail(id + ' is not badged as already quarantined: ' + JSON.stringify(textOf(badge)))
  }
}
const goneBadge = nodes.find((node) => node.props?.['data-dshr-unavailable-badge'] === GONE)
if (goneBadge === undefined || textOf(goneBadge) !== '源目录不存在') {
  fail('the ninth session is not badged as source-gone: ' + JSON.stringify(textOf(goneBadge)))
}
for (const id of IDS) {
  const row = nodes.find((node) => node.props?.['data-dshr-row'] === id)
  if (row === undefined) fail(id + ' is not on screen')
  const control = walk(row).find((node) => node.type === 'input')
  if (control?.props?.disabled !== true) {
    fail(id + ' still offers a usable checkbox')
  }
}
console.log('   live region   : ' + announced)
console.log('   result bar    : ' + runBar.props['data-dshr-run'] + ' (moved:failed:already), one failure listed')

// --- 7. and the quarantine itself agrees ------------------------------------
const trash = await api('/api/dsh-reclaim/trash')
const held = (trash.body?.batches ?? []).flatMap((batch) => batch.sessionIds ?? [])
for (const id of MOVED) {
  if (!held.includes(id)) {
    fail('the quarantine listing does not mention ' + id + ': ' + JSON.stringify(held))
  }
}
if (held.includes(GONE)) {
  fail('the quarantine listing claims to hold the ninth session, which was deleted: ' + JSON.stringify(held))
}
console.log('   quarantine    : ' + held.length + ' session id(s) recorded across ' + trash.body.batches.length + ' batch(es)')

console.log('PASS: a repeated quarantine of nine sessions reads as 8 already quarantined and 1 gone - not 9 failures.')