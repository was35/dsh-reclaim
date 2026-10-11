/**
 * What a panel open costs, measured end to end.
 *
 * WHY THIS EXISTS
 * The unit loop can prove that a repeated open does not re-read the store — it
 * counts calls against a test double. It cannot say what an open COSTS, because
 * the cost lives in the host's session services: walking the session tree,
 * folding titles out of compressed logs, and building a reference graph by
 * opening every log. Only a real host over a real store produces that number,
 * and the acceptance bar for the audit speed-up ("124 sessions, first open
 * under 2s") can only be answered here.
 *
 * WHAT IT MEASURES, AND WHY THESE REQUESTS
 * It issues the same requests the panel's own open does, in the same order, and
 * times each one:
 *
 *   1. `?preview=1` — the cheap half (listing, titles, badges, attachment and
 *      cache walk) that the panel paints first;
 *   2. `classify` + `trash`, concurrently — the full answer and the quarantine
 *      listing, exactly as the client fires them;
 *   3. the same two again — a second open, which is what tells "reused the facts
 *      it already had" apart from "re-read the store";
 *   4. an explicit `rescan=1` — the refresh button, which is allowed to be
 *      expensive because the person pressed it.
 *
 * Every request is timed on the wire, and each response is read for what it
 * claims about itself (`factsFromCache`, `scannedAt`, `scanCount`, the graph's
 * own read totals, how many sessions came back). A timing without the cache
 * state beside it is not evidence of anything.
 *
 * Output: ONE line of JSON on stdout, so two runs can be diffed. The narrative
 * goes to stderr.
 *
 * Usage: node scripts/bench-audit.mjs --port <n> --jar <cookie jar> [--label X] [--preview]
 */
import { readFileSync } from 'node:fs'

const args = new Map()
for (let i = 2; i < process.argv.length; i += 1) {
  if (process.argv[i].startsWith('--')) {
    const next = process.argv[i + 1]
    if (next === undefined || next.startsWith('--')) args.set(process.argv[i], true)
    else {
      args.set(process.argv[i], next)
      i += 1
    }
  }
}
const port = args.get('--port')
const jar = args.get('--jar')
const label = typeof args.get('--label') === 'string' ? args.get('--label') : 'unlabelled'
const wantsPreview = args.get('--preview') === true
if (typeof port !== 'string' || typeof jar !== 'string') {
  console.error('usage: node scripts/bench-audit.mjs --port <n> --jar <cookie jar> [--label X] [--preview]')
  process.exit(2)
}

/** The cookie header, read out of curl's Netscape-format jar. */
function cookieHeader(path) {
  const pairs = []
  for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
    const line = rawLine.startsWith('#HttpOnly_') ? rawLine.slice('#HttpOnly_'.length) : rawLine
    if (line.startsWith('#') || line.trim() === '') continue
    const fields = line.split('\t')
    if (fields.length >= 7) pairs.push(`${fields[5]}=${fields[6]}`)
  }
  if (pairs.length === 0) throw new Error(`no cookies found in ${path}`)
  return pairs.join('; ')
}

const cookie = cookieHeader(jar)

/** Milliseconds, rounded to one decimal — enough to compare, not enough to lie. */
const round = (ms) => Math.round(ms * 10) / 10

/**
 * One timed request. `at` is stamped BEFORE the request leaves, so the
 * timestamps say when the answer was asked for, not when it arrived.
 */
async function timed(path) {
  const at = new Date().toISOString()
  const start = performance.now()
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { cookie } })
  const body = await response.json()
  return { path, at, status: response.status, ms: round(performance.now() - start), body }
}

/** The claims a response makes about its own freshness, kept beside its timing. */
function describe(result) {
  const body = result.body ?? {}
  const graph = body.graph ?? null
  return {
    path: result.path,
    status: result.status,
    ms: result.ms,
    ok: body.ok === true,
    // `pending` is the preview's whole point: it is not a grade.
    pending: body.pending === true,
    factsFromCache: body.factsFromCache === true,
    scannedAt: typeof body.scannedAt === 'string' ? body.scannedAt : null,
    scanCount: typeof body.scanCount === 'number' ? body.scanCount : null,
    sessions: typeof body.totals?.sessionCount === 'number'
      ? body.totals.sessionCount
      : Array.isArray(body.sessions) ? body.sessions.length : null,
    // The report carries the graph's coverage verdict, not the graph itself.
    graphProven: body.gate?.coverage?.proven ?? graph?.coverage?.proven ?? null,
    graphUnknown: body.gate?.coverage?.unknown ?? graph?.coverage?.unknown ?? null,
    orphanDeterminationAllowed: body.gate?.orphanDeterminationAllowed ?? null,
    // The quarantine listing says how many archived sessions it could account
    // for, which is the number the panel shows beside the bin.
    archived: body.archived?.count ?? null,
    archivedKnown: typeof body.archived?.available === 'boolean' ? body.archived.available : null,
  }
}

/**
 * The store's own inventory, read once at the end through `/sessions`.
 *
 * This is not part of the panel's open — it is here so the numbers above can be
 * read beside what they were measured over (how many sessions, how many titles
 * came free from the host's projection cache, how many had to be folded out of
 * compressed logs, how many sizes are unknown). Run last, so it cannot warm
 * anything the timed requests would have paid for.
 */
async function inventory() {
  const result = await timed('/api/dsh-reclaim/sessions')
  const body = result.body ?? {}
  return {
    status: result.status,
    ms: result.ms,
    sessions: body.summary?.total ?? (Array.isArray(body.sessions) ? body.sessions.length : null),
    archived: body.archived?.count ?? null,
    withTitle: body.summary?.withTitle ?? null,
    withoutTitle: body.summary?.withoutTitle ?? null,
    bytesUnknown: body.summary?.bytesUnknownCount ?? null,
    titlesFromProjectionCache: body.titles?.projection?.served ?? null,
    titlesFoldedFromLogs: body.titles?.folded?.requested ?? null,
    titlesFoldFailed: body.titles?.available === false,
    livenessCounts: body.liveness?.counts ?? null,
  }
}

const narrative = (row) => {
  const bits = [
    `${row.ms.toFixed(1).padStart(8)} ms`,
    row.path,
    `status=${row.status}`,
    row.pending ? 'pending' : null,
    row.factsFromCache ? 'from-cache' : 'fresh-read',
    row.sessions === null ? null : `${row.sessions} session(s)`,
    row.graphReadMs === null ? null : `graph-read ${row.graphReadMs} ms`,
  ]
  return bits.filter((bit) => bit !== null).join('  ')
}

async function request(path) {
  const result = await timed(path)
  const row = describe(result)
  console.error(`   ${narrative(row)}`)
  return { result, row }
}

// --- the open, cold -------------------------------------------------------
// No `rescan` anywhere in this block: the point is what an open costs when the
// process has nothing, which is the number the person experiences on a fresh
// host. An explicit rescan is measured separately, at the bottom.
console.error(`bench: ${label} (port ${port}${wantsPreview ? ', with preview' : ''})`)
console.error('-- cold open')
const coldPreview = wantsPreview ? await request('/api/dsh-reclaim/classify?preview=1') : null
const [coldFull, coldTrash] = await Promise.all([
  request('/api/dsh-reclaim/classify'),
  request('/api/dsh-reclaim/trash'),
])

// --- the open, warm -------------------------------------------------------
// Same requests again. If the plugin reused what it had, the timings collapse
// and `factsFromCache` says so; if it re-read the store, they do not.
console.error('-- second open')
const warmPreview = wantsPreview ? await request('/api/dsh-reclaim/classify?preview=1') : null
const [warmFull, warmTrash] = await Promise.all([
  request('/api/dsh-reclaim/classify'),
  request('/api/dsh-reclaim/trash'),
])

// --- the refresh button ---------------------------------------------------
console.error('-- explicit rescan')
const rescanned = await request('/api/dsh-reclaim/classify?rescan=1')

// --- the store's inventory, last so it warms nothing ----------------------
console.error('-- inventory')
const store = await inventory()
console.error(`   ${store.sessions} session(s), ${store.archived} archived, ` +
  `${store.titlesFromProjectionCache} title(s) from the projection cache, ` +
  `${store.titlesFoldedFromLogs} folded from logs`)

// --- what the panel actually experiences ----------------------------------
// The panel's open is not one request. It paints when the first answer lands,
// and it is "done" when the last of the concurrent pair does. Both numbers are
// reported because the acceptance bar is about the first one.
const firstPaintMs = coldPreview === null ? coldFull.row.ms : coldPreview.row.ms
const coldPairMs = Math.max(coldFull.row.ms, coldTrash.row.ms)
const warmPairMs = Math.max(warmFull.row.ms, warmTrash.row.ms)

const output = {
  label,
  preview: wantsPreview,
  panel: {
    // When the rows are on screen (title + size + age + archive badge).
    firstPaintMs,
    // When the open has finished: the pair the client fires concurrently.
    coldCompleteMs: round(coldPairMs + (coldPreview === null ? 0 : coldPreview.row.ms)),
    warmFirstPaintMs: warmPreview === null ? warmFull.row.ms : warmPreview.row.ms,
    warmCompleteMs: round(warmPairMs + (warmPreview === null ? 0 : warmPreview.row.ms)),
    // The same request the old client sent on EVERY open.
    refreshMs: rescanned.row.ms,
    sessions: coldFull.row.sessions,
    // What the reference graph added on top of the cheap half. Only meaningful
    // when the full answer reused the preview's facts, which is the case the
    // panel actually walks: preview, then classify without rescan.
    graphMs: coldPreview === null || coldFull.row.factsFromCache !== false
      ? null
      : round(coldFull.row.ms - coldPreview.row.ms),
  },
  cold: {
    preview: coldPreview === null ? null : coldPreview.row,
    full: coldFull.row,
    trash: coldTrash.row,
  },
  warm: {
    preview: warmPreview === null ? null : warmPreview.row,
    full: warmFull.row,
    trash: warmTrash.row,
  },
  rescan: rescanned.row,
  store,
  notes: [
    'firstPaintMs is when the rows could be on screen; coldCompleteMs is when the open finished.',
    'the cold block sends no rescan=1: that is what a fresh process costs.',
    'factsFromCache/fresh-read is each response describing its own freshness.',
    'graphMs is the full answer minus the preview, i.e. what the reference graph cost.',
    'store is read last through /sessions: it describes what was measured, and warms nothing.',
  ],
}

console.log(JSON.stringify(output))
