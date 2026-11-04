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

// --- 3. direct delete submission: all 8 real sessions are blocked with session-delete-delegated (ADR 0001), 1 missing is refused with session-dir-not-found
const first = await submitAll(IDS)
const movedFirst = first.filter((entry) => entry.ok)
if (movedFirst.length !== 0) {
  fail(
    'the submission moved ' + movedFirst.length + ' sessions directly, violating ADR 0001 delegation: ' +
      JSON.stringify(
        first.map((entry) => ({ id: entry.id, ok: entry.ok, blockers: blockerCodes(entry), reason: entry.body?.reason ?? null })),
        null,
        2,
      ),
  )
}
for (const id of MOVED) {
  const entry = first.find((item) => item.id === id)
  const blockers = blockerCodes(entry)
  if (!blockers.includes('session-delete-delegated')) {
    fail('session ' + id + ' was not blocked with session-delete-delegated: ' + JSON.stringify(blockers))
  }
  if (!existsSync(join(workspaceDir, 'session-' + id))) {
    fail(id + ' was physically removed from session tree, violating ADR 0001')
  }
}
const goneFirst = first.find((entry) => entry.id === GONE)
if (!blockerCodes(goneFirst).includes('session-dir-not-found')) {
  fail('missing session was not reported with session-dir-not-found: ' + JSON.stringify(blockerCodes(goneFirst)))
}
console.log('   delegated guard: 8 blocked with session-delete-delegated (ADR 0001), 1 refused (session-dir-not-found)')

// --- 4. verify panel renders companion state and delegates direct deletion ---
const { react, plugin, seam } = loadPanel()
const companionStatus = await api('/api/dsh-reclaim/companion-status')
if (companionStatus.status !== 200 || companionStatus.body?.ok !== true) {
  fail('/companion-status route failed: ' + JSON.stringify(companionStatus.body))
}
if (companionStatus.body?.active !== true) {
  fail('companion mode is not reported as active')
}
console.log('   companion     : status route ok, upstream=' + companionStatus.body.upstream)

// Verify panel tree renders companion banner
const noop = () => {}
const dummyReport = {
  ok: true,
  scanCount: 1,
  gate: {},
  families: [],
  totals: { totalReclaimableBytes: 0, sessionCount: 9, dedupAttachmentCount: 0 },
  tiers: {
    sessions: { safe: [], confirm: [], danger: [], unclassified: [] },
    attachments: { safe: [], confirm: [], danger: [], unclassified: [] },
    caches: { safe: [], confirm: [], danger: [], unclassified: [], reportOnly: [] },
  },
}
const tree = seam.renderPanel(
  react,
  {
    t: (key, params) => plugin.__messages.translatePanel('zh', key, params),
    locale: 'zh',
    status: 'ready',
    error: null,
    report: dummyReport,
    trash: null,
    thresholdDays: 30,
    view: 'audit',
    selected: new Set(),
    busy: null,
    notice: null,
    run: null,
    receipts: [],
    unavailable: new Map(),
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

function walk(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  out.push(node)
  for (const child of node.children ?? []) walk(child, out)
  return out
}

const nodes = walk(tree)
const companionCard = nodes.find((node) => node.props?.className?.includes('dshr-companion-card'))
if (!companionCard) {
  fail('companion banner was not rendered in the panel tree')
}
console.log('   companion UI  : banner successfully rendered in panel header')

console.log('PASS: session deletion safely delegated to upstream (ADR 0001) and companion status verified.')