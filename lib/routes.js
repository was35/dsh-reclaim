/**
 * dsh-reclaim — the HTTP surface.
 *
 * Every route lives here so the whole attack surface of this plugin can be read
 * in one file. That matters more for this plugin than for most: it can move a
 * user's data into a quarantine, and the difference between "safe" and "a
 * malicious page deleted my sessions" is entirely in this file.
 *
 * ## The one rule that is not negotiable
 *
 * **Routes go through `ctx.connection.fetch.register` with an `/api/...` path.**
 * That prefix is what puts the host's Host/Origin fence and cookie authentication
 * in front of the handler. `ctx.webServer` routes carry no authentication, and a
 * plugin that can delete data behind an unauthenticated route can be triggered by
 * any page the user happens to visit. `assertApiPath` below is the enforcement:
 * the route table cannot be reached with a non-`/api/` path even by mistake.
 *
 * ## Reads and writes are separate routes, and only writes demand confirmation
 *
 *   - **GET** routes never change anything. They exist so the interface (and the
 *     acceptance tools) can see what the plugin would do.
 *   - **POST** routes change something, and each one requires `confirm: true` in
 *     the body. A missing field is answered with **400 plus the description of
 *     what would be destroyed**, because that response is exactly the text a
 *     confirmation dialog needs — the interface cannot show "permanently delete N
 *     items, X MB" unless the server produced the numbers first.
 *   - `POST /delete` additionally accepts `dryRun`, so asking "what would happen"
 *     is never the same request as "do it".
 *
 * ## Why the read-only classification route caches its facts
 *
 * Grading is arithmetic over facts that cost a full replay of every session log
 * to gather. The facts are cached **in memory only** (a persisted cache could go
 * stale and authorize a wrong deletion), keyed by the read-verification mode, and
 * every response reports which scan generation it came from. `?rescan=1` throws
 * the facts away — which acceptance tooling needs, because after a delete a plain
 * call would otherwise describe the world as it was before it.
 *
 * ## Read-only with respect to everything except the quarantine
 *
 * No route writes outside `<home>/.dsh-reclaim-trash/`. The plugin's only
 * mutating operation is moving data INTO the quarantine; nothing destroys data.
 */

import { isAbsolute, join, relative } from 'node:path'

import { resolveLayout } from './paths.js'
import { checkAttachmentBackend } from './backend-check.js'
import { scanAttachments } from './attachments.js'
import { buildCacheReport, sessionIdsFrom, sessionIdsUnavailable } from './caches.js'
import { listSessions } from './sessions.js'
import { buildReferenceGraph } from './graph.js'
import { gradeAll } from './classification-report.js'
import { livenessOf, readLivenessServices } from './liveness.js'
import { DEFAULT_THRESHOLD_DAYS } from './config.js'
import { listBatches, describePurge, purgeBatch, trashFootprint } from './purge.js'
import { describeRestoreResult, planRestore, restoreBatch, pruneEmptyDirs } from './restore.js'
import { deleteSession, isValidSessionId } from './delete-session.js'
import { planClearCandidates } from './clear-objects.js'
import { AUTOMATIC_PURGE_IMPLEMENTED, deleteSessionItems } from './trash.js'
import { archivedResidue } from './workspace-sync.js'

/**
 * The route table. `kind` documents the write boundary: `read` routes change
 * nothing, `write` routes require a confirmation field.
 */
export const ROUTES = Object.freeze([
  { path: '/api/dsh-reclaim/health', methods: ['GET'], kind: 'read', description: 'asset layout and home resolution' },
  { path: '/api/dsh-reclaim/sessions', methods: ['GET'], kind: 'read', description: 'session table with metadata and liveness' },
  { path: '/api/dsh-reclaim/attachments', methods: ['GET'], kind: 'read', description: 'attachment families and rebuildable caches' },
  { path: '/api/dsh-reclaim/refs', methods: ['GET'], kind: 'read', description: 'reference graph and coverage verdict' },
  { path: '/api/dsh-reclaim/classify', methods: ['GET'], kind: 'read', description: 'two-pass risk grading' },
  { path: '/api/dsh-reclaim/trash', methods: ['GET'], kind: 'read', description: 'quarantine contents and footprint' },
  { path: '/api/dsh-reclaim/trash/plan', methods: ['GET'], kind: 'read', description: 'what a restore or a purge would do' },
  { path: '/api/dsh-reclaim/restore', methods: ['POST'], kind: 'write', description: 'move items back out of the quarantine' },
  { path: '/api/dsh-reclaim/purge', methods: ['POST'], kind: 'write', description: 'permanently delete one batch' },
  { path: '/api/dsh-reclaim/delete', methods: ['POST'], kind: 'write', description: 'move a session into the quarantine' },
  { path: '/api/dsh-reclaim/clear', methods: ['POST'], kind: 'write', description: 'move named attachment and cache rows into the quarantine' },
])

/** Throws unless a route path is under `/api/`. The unauthenticated-route guard. */
export function assertApiPath(path) {
  if (typeof path !== 'string' || !path.startsWith('/api/')) {
    throw new Error(
      `refusing to register ${JSON.stringify(path)}: every route must live under /api/ so the host's ` +
        'Host/Origin fence and cookie authentication sit in front of it. A bare route on the web server ' +
        'carries no authentication, and this plugin can move user data',
    )
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function failureResponse(cause) {
  return jsonResponse(
    {
      ok: false,
      error: `${cause?.name ?? 'Error'}: ${cause?.message ?? String(cause)}`,
      stack: typeof cause?.stack === 'string' ? cause.stack.split('\n').slice(0, 8) : [],
    },
    500,
  )
}

/**
 * Why orphan projection-cache detection is off while no session list is
 * available. A projection cache may only be called an orphan when the list that
 * would have claimed it was actually obtained; an absent list must never degrade
 * into "no session claims this file, therefore it is an orphan".
 */
const SESSION_LIST_PENDING =
  'no session list is available yet, so no cache file is classified as an orphan; ' +
  'calling a file an orphan without the list that would have claimed it could authorize ' +
  'deleting a live session cache'

/** Compose the read-only attachment/cache report (shared with the acceptance CLI). */
export async function buildAttachmentsReport(options = {}) {
  const layout = options.layout ?? resolveLayout()
  const backend = options.backend ?? checkAttachmentBackend({ store: options.store, layout })
  // `collectFileList` is opt-in per call: the grading stage joins content ids to
  // files, and this route does not need the listing.
  const attachments = await scanAttachments(layout, { backend, collectFileList: options.collectFileList === true })
  const caches = buildCacheReport({
    layout,
    attachments,
    sessionIds: options.sessionIds ?? sessionIdsUnavailable(SESSION_LIST_PENDING),
    projectionCacheRoot: options.projectionCacheRoot,
  })

  return {
    ok: true,
    plugin: 'dsh-reclaim',
    name: 'reclaim',
    scannedAt: new Date().toISOString(),
    layout: {
      home: layout.home,
      homeDisplay: layout.homeDisplay,
      homeSource: layout.homeSource,
      attachmentsRoot: layout.attachmentsRoot,
      trashRoot: layout.trash.root,
    },
    startupBackendCheck: options.startupBackendCheck ?? null,
    backend,
    attachments,
    caches,
    summary: {
      enumerationEnabled: attachments.enumerationEnabled,
      families: attachments.families.length,
      familyFiles: attachments.totals.familyFiles,
      familyBytes: attachments.totals.familyBytes,
      unknownObjects: attachments.unknown.length,
      unknownFiles: attachments.totals.unknownFiles,
      unknownBytes: attachments.totals.unknownBytes,
      uncertainEntries: attachments.uncertain.length,
      nonRegularEntries: attachments.nonRegular.length,
      excludedAsTrashEntries: attachments.excludedAsTrash.length,
      regenerableBytes: caches.regenerableBytes,
      orphanProjectionCacheDetection: caches.orphanProjectionCaches.enabled,
    },
  }
}

/**
 * Which host capabilities this plugin actually stands on.
 *
 * ## Why this exists
 *
 * DSH ships as a developer preview and states in its own README that there WILL be
 * compatibility-breaking changes. Its two manifest fields are **not equally enforced**: `engines.dsh`
 * IS checked at install time (an incompatible range is rejected outright; the only escape hatch is a
 * per-version `dsh plugin allow-version` exemption), while `dsh.manifestVersion` is declarative only.
 * Neither check says anything about the API shapes *inside* the declared range, so a host that
 * satisfies it can still fail in ways that look like plugin bugs: a blank settings page, a 404 route,
 * a silently missing service.
 *
 * Measured history in this very project: `ctx.require` does not exist (only `ctx.get`), and `inject`
 * gates property access so an undeclared service throws `cannot get property "<name>" without inject`.
 * Both were discovered by crashing, not by declaration.
 *
 * So the plugin checks its own ground and reports it. Each entry names the capability, whether it is
 * present, and — when it is missing — what that breaks. The shape is deliberately the same for every
 * entry so a reader can diff two hosts by eye.
 *
 * @param {object} ctx - the plugin context handed to `apply`.
 * @returns {{ok: boolean, missing: string[], checks: object[]}}
 */
export function probeHostCapabilities(ctx) {
  const has = (value) => typeof value === 'function'
  const at = (path) => {
    let node = ctx
    for (const key of path.split('.')) {
      if (node === undefined || node === null) return undefined
      node = node[key]
    }
    return node
  }

  /**
   * Read a service WITHOUT touching `ctx.<name>`.
   *
   * `inject` gates property access: this plugin injects only `connection`, so `ctx.sessions` throws
   * `cannot get property "sessions" without inject`. Measured — the first version of this probe did
   * exactly that and turned `/health` into a 500, which is a nice demonstration of why the probe is
   * worth having and also why it must stay inside `ctx.get`.
   */
  const service = (name) => {
    const get = at('get')
    if (typeof get !== 'function') return undefined
    try {
      return get.call(ctx, name)
    } catch (cause) {
      return undefined
    }
  }

  const checks = [
    {
      capability: 'ctx.effect',
      present: has(at('effect')),
      neededFor: 'everything: every registration is wrapped in ctx.effect so the host can unwind it',
    },
    {
      capability: 'ctx.connection.fetch.register',
      present: has(at('connection.fetch.register')),
      neededFor: 'all HTTP routes (/api/dsh-reclaim/*) — without it the panel has nothing to read',
    },
    {
      capability: 'ctx.get',
      present: has(at('get')),
      neededFor: 'every optional service below; without it the plugin can only report, not read',
    },
    {
      capability: 'service "sessions"',
      present: service('sessions') !== undefined,
      neededFor: 'the session listing and liveness (falls back to "unknown", never to "empty")',
    },
    {
      capability: 'service "attachments"',
      present: service('attachments') !== undefined,
      neededFor: 'the attachment scan; absent means the report says so instead of claiming zero',
    },
    {
      capability: 'service "sessionQuery"',
      present: service('sessionQuery') !== undefined,
      neededFor: 'reading session logs to build the reference graph',
    },
    {
      capability: 'service "tools"',
      present: service('tools') !== undefined,
      neededFor: 'the read-only reclaim_audit tool; absent means the model simply cannot ask',
    },
  ]

  const missing = checks.filter((check) => check.present !== true).map((check) => check.capability)
  return { ok: missing.length === 0, missing, checks }
}

/**
 * The layout the health route reports, plus the host-capability probe.
 *
 * The probe is included here on purpose: `/health` is the one request a user or maintainer can make
 * without knowing anything about the plugin, so it is the right place for "does this host look like
 * the one this plugin was built against?".
 */
export function healthPayload(ctx) {
  const layout = resolveLayout()
  return {
    ok: true,
    plugin: 'dsh-reclaim',
    name: 'reclaim',
    capabilities: probeHostCapabilities(ctx),
    home: {
      path: layout.home,
      display: layout.homeDisplay,
      source: layout.homeSource,
    },
    attachmentsRoot: layout.attachmentsRoot,
    families: layout.families,
    trash: { root: layout.trash.root },
  }
}

/**
 * The classification route's fact cache — memory only.
 *
 * The design forbids a persisted cache here on purpose: the whole point of this
 * plugin is to judge correctly, and a disk layer that can go stale is exactly how
 * a wrong judgment reaches a delete. Reusing facts inside one process is
 * different: grading is pure arithmetic, so re-grading costs nothing and the
 * expensive reads happen once per fact generation.
 */
const factCache = { mode: null, facts: null, scanCount: 0, inFlight: null, atMs: 0 }

/**
 * How long a fact generation may be reused without re-reading the disk.
 *
 * The panel bounds this much more tightly than the number alone suggests: a first paint
 * that came out of the cache is followed by exactly one background rescan, so in practice
 * these facts live only as long as one panel open. This bound covers the case where that
 * rescan never lands — the host is busy, the request is dropped — and it is what keeps the
 * timestamp the panel shows from ever being older than a minute. Past it, the facts are
 * re-read rather than presented as the world.
 *
 * A number, not a "forever": the reason this cache is allowed to exist at all is that
 * `lib/routes.js` refuses to persist one, and an unbounded in-memory cache would be the
 * same mistake with a shorter lifetime.
 */
const FACT_CACHE_TTL_MS = 60 * 1000

/**
 * The cheap half's own generation, cached under the same rules as the facts above.
 *
 * It exists for one flow: the panel asks for a preview (rows and archive badges, graded
 * "pending") and then for the full grade, and both need the same listing, the same attachment
 * walk and the same cache report. Without this the second request would read all of it again —
 * the very duplication #6 removed from `/trash`. The graph is NOT here: it is cached per
 * `verifyRead` mode in `factCache`, because how much was cross-read is part of what it means.
 */
const cheapCache = { facts: null, scanCount: 0, inFlight: null, atMs: 0, scannedAt: null }

/**
 * The cheap facts, reusing the in-process generation while it is fresh.
 *
 * Returns `scannedAt` — the moment the disk was actually read — and `reused`, for the same
 * reason `factsFor` does: a preview that came out of the cache is dated with the read it came
 * from, never with the moment it was served.
 */
async function cheapFactsFor(ctx, rescan, startupBackendCheck) {
  const reusable =
    !rescan && cheapCache.facts !== null && Date.now() - cheapCache.atMs <= FACT_CACHE_TTL_MS
  if (reusable) {
    return { facts: cheapCache.facts, scanCount: cheapCache.scanCount, scannedAt: cheapCache.scannedAt, reused: true }
  }
  if (cheapCache.inFlight !== null) return cheapCache.inFlight
  const run = (async () => {
    const facts = await scanCheapFacts(ctx, { startupBackendCheck })
    cheapCache.facts = facts
    cheapCache.scanCount += 1
    cheapCache.atMs = Date.now()
    cheapCache.scannedAt = new Date().toISOString()
    return { facts, scanCount: cheapCache.scanCount, scannedAt: cheapCache.scannedAt, reused: false }
  })()
  cheapCache.inFlight = run
  try {
    return await run
  } finally {
    if (cheapCache.inFlight === run) cheapCache.inFlight = null
  }
}

/**
 * The facts for this grade, reusing the in-process generation when it is still fresh.
 *
 * Returns the whole generation plus two things the caller must not invent: `scannedAt`,
 * the moment the disk was actually read, and `reused`, whether this answer came out of the
 * cache. The panel shows the first and acts on the second (a reused first paint is what
 * earns a background rescan); neither is derivable from the graded report, which is
 * arithmetic and carries no idea of when its inputs were read.
 */
async function factsFor(ctx, mode, rescan, startupBackendCheck, cheapFacts = null) {
  const reusable =
    !rescan &&
    factCache.facts !== null &&
    factCache.mode === mode &&
    Date.now() - factCache.atMs <= FACT_CACHE_TTL_MS
  if (reusable) {
    return {
      facts: factCache.facts,
      scanCount: factCache.scanCount,
      scannedAt: typeof factCache.facts.scannedAt === 'string' ? factCache.facts.scannedAt : null,
      reused: true,
    }
  }
  // The single flight is keyed by mode: `verifyRead` decides how much of the reference
  // graph was cross-read, so handing an `all` caller the facts of an `empty-refs` scan
  // would answer a question nobody asked. Two different modes scanning at once is rare and
  // merely costs one extra read.
  if (factCache.inFlight !== null && factCache.inFlight.mode === mode) return factCache.inFlight.promise
  const run = (async () => {
    const facts = await scanFacts(ctx, { verifyRead: mode, startupBackendCheck, cheapFacts })
    factCache.mode = mode
    factCache.facts = facts
    factCache.scanCount += 1
    factCache.atMs = Date.now()
    // The generation is a property of the facts, not of the call: `gradeAll` reads it from
    // the facts (`lib/classification-report.js:189` `facts.scanCount ?? 1`), so a generation
    // that lived only on the cache would show every report as generation 1. Stamp it here,
    // where the generation is minted, so a reused answer reports the scan it came from.
    facts.scanCount = factCache.scanCount
    return {
      facts,
      scanCount: factCache.scanCount,
      scannedAt: typeof facts.scannedAt === 'string' ? facts.scannedAt : null,
      reused: false,
    }
  })()
  factCache.inFlight = { mode, promise: run }
  try {
    return await run
  } finally {
    // Only the flight that is still current may be cleared: a later one must not be
    // cancelled by an earlier caller's exit.
    if (factCache.inFlight !== null && factCache.inFlight.promise === run) factCache.inFlight = null
  }
}

/**
 * The session listing the audit view would use, without paying for a second one.
 *
 * `/trash` needs one thing from the session store — the ids behind the archive residue — and
 * the panel asks for it in the same breath as the audit (`Promise.all([classify, trash])`).
 * So this joins the scan the audit already started, or reuses the generation it left behind
 * while that generation is still fresh — the full one if the grade has run, the cheap one if
 * only the preview has — and lists the store itself only when there is nothing to join. A
 * listing of its own is not wrong, it is simply the second read of the same bytes.
 */
async function auditSessions(ctx) {
  const flight = factCache.inFlight
  if (flight !== null) {
    try {
      const settled = await flight.promise
      if (settled !== null && settled.facts !== null && settled.facts.sessions !== undefined) {
        return settled.facts.sessions
      }
    } catch {
      // The scan failed. This caller still deserves an answer, and listing the store is the
      // honest one: falling through here is not a fallback to emptiness.
    }
  }
  const cached = factCache.facts
  if (
    cached !== null &&
    cached.sessions !== undefined &&
    Date.now() - factCache.atMs <= FACT_CACHE_TTL_MS
  ) {
    return cached.sessions
  }
  // The cheap half of a scan lists the store too, and the panel reads it first (the preview
  // paint), so a `/trash` that arrives before the full grade finds its listing here rather
  // than reading the same bytes again.
  const cheap = cheapCache.facts
  if (
    cheap !== null &&
    cheap.sessions !== undefined &&
    Date.now() - cheapCache.atMs <= FACT_CACHE_TTL_MS
  ) {
    return cheap.sessions
  }
  return await listSessions(ctx)
}

/**
 * The cheap half of a scan: every fact the grading needs EXCEPT the reference graph.
 *
 * The graph is the expensive read — it opens session logs — while the listing, the attachment
 * walk and the cache report are not. Splitting the scan here is what lets the panel paint its
 * rows (titles, archive badges, sizes, ages) while the graph is still being read, without ever
 * showing a verdict that was graded without it.
 */
export async function scanCheapFacts(ctx, options = {}) {
  const layout = resolveLayout()
  const backend = checkAttachmentBackend({ store: ctx.get('attachments'), layout })
  const sessions = await listSessions(ctx)
  const sessionIds = sessions.available === true
    ? sessionIdsFrom(sessions.sessions.map((row) => row.id))
    : sessionIdsUnavailable(sessions.reason ?? 'the session listing could not be read')

  const attachments = await scanAttachments(layout, { backend, collectFileList: true })
  const caches = buildCacheReport({ layout, attachments, sessionIds })

  return {
    ctx,
    layout,
    backend,
    startupBackendCheck: options.startupBackendCheck ?? null,
    sessions,
    sessionsServiceAvailable: readLivenessServices(ctx).sessions !== null,
    attachments,
    caches,
  }
}

/**
 * Gather every fact the grading needs, once.
 *
 * `options.cheapFacts` lets a caller hand in the cheap half it already read (the classify route
 * does, so that a preview and the full grade that follows it do not list the store twice).
 * Without it this reads both halves itself, which is what the startup grade and `/refs` want.
 */
export async function scanFacts(ctx, options = {}) {
  const cheap = options.cheapFacts ?? (await scanCheapFacts(ctx, options))
  const graph = await buildReferenceGraph(ctx, {
    verifyRead: options.verifyRead ?? 'empty-refs',
    sessionIds: cheap.sessions.available === true ? cheap.sessions.sessions.map((row) => row.id) : undefined,
  })

  return { ...cheap, graph, scannedAt: new Date().toISOString() }
}

/** Resolve a batch name or path against the trash root, refusing anything else. */
export function resolveBatchDir(layout, batch) {
  const root = layout?.trash?.root
  if (typeof root !== 'string' || root.length === 0) {
    throw new Error('the layout does not expose a trash root')
  }
  if (typeof batch !== 'string' || batch.length === 0) {
    throw new Error('no batch was named')
  }
  const candidate = isAbsolute(batch) ? batch : join(root, batch)
  const rel = relative(root, candidate)
  if (rel.startsWith('..') || isAbsolute(rel) || rel === '') {
    // A batch path outside the quarantine is refused here rather than later: this
    // is the boundary that keeps a request from naming `sessions/` as its target.
    throw new Error(`refusing to operate on ${candidate}: it is not inside the quarantine`)
  }
  return candidate
}

/** The workspace a session's directory lives under, from the accounting. */
async function workspacePathFor(ctx, sessionId) {
  try {
    const registry = ctx.get('workspaceRegistry')
    const workspaces = (await registry?.list?.()) ?? []
    for (const workspace of workspaces) {
      if ((workspace.sessionIds ?? []).includes(sessionId)) return workspace.path
    }
  } catch {
    /* reported by the delete plan as a missing workspace path */
  }
  return null
}

/** Read a JSON request body, tolerating an absent one. */
async function readJsonBody(request) {
  try {
    const text = await request.text()
    if (text === undefined || text === null || text.trim() === '') return {}
    return JSON.parse(text)
  } catch (cause) {
    throw new Error(`the request body is not valid JSON: ${cause?.message ?? String(cause)}`)
  }
}

/**
 * Acceptance hooks for liveness, off unless explicitly requested.
 *
 * Two properties the classifier must be able to demonstrate — "a loaded-but-idle
 * session is still dangerous" and "liveness is re-read before a candidate leaves
 * the batch" — cannot be observed by waiting: the measured `running` window is
 * ~117ms, and a freshly created session is idle-live for only as long as it takes
 * to type the next check. Faking the probe makes both testable in one request.
 *
 * The hooks can only ever make the verdict MORE cautious for the states they name
 * (`?testLiveness=idle-live` reports a session as in use), and the report records
 * their presence, so no evidence produced with them can be mistaken for an
 * unmodified run.
 */
function livenessTestHooks(params) {
  const forced = params.get('testLiveness')
  const forcedState = forced === 'idle-live' || forced === 'running' ? forced : null
  const flipOn = params.get('testLivenessCall')
  const flipSession = params.get('testLivenessSession')
  const flipTo = params.get('testLivenessTo')
  const flipState = flipTo === 'idle-live' || flipTo === 'running' ? flipTo : 'idle-live'
  const flipCall = flipOn === null ? null : Number.parseInt(flipOn, 10)

  if (forcedState === null && !Number.isFinite(flipCall)) {
    return { wrap: (probe) => probe, describe: null }
  }

  const seen = new Map()
  const wrap = (probe) => (sessionId) => {
    const count = (seen.get(sessionId) ?? 0) + 1
    seen.set(sessionId, count)
    if (forcedState !== null && (flipSession === null || flipSession === sessionId)) {
      return {
        sessionId,
        state: forcedState,
        live: true,
        running: forcedState === 'running',
        reason: 'test-hook-forced-liveness',
        message: `the acceptance hook forced the liveness state to ${forcedState}`,
        evidence: { testHook: true },
      }
    }
    if (Number.isFinite(flipCall) && count >= flipCall && (flipSession === null || flipSession === sessionId)) {
      return {
        sessionId,
        state: flipState,
        live: true,
        running: flipState === 'running',
        reason: 'test-hook-liveness-flip',
        message: `the acceptance hook flipped liveness to ${flipState} from read ${flipCall} onward`,
        evidence: { testHook: true },
      }
    }
    return probe(sessionId)
  }

  return {
    wrap,
    describe: {
      forcedState,
      flipAtCall: Number.isFinite(flipCall) ? flipCall : null,
      flipSessionId: flipSession,
      flipState: Number.isFinite(flipCall) ? flipState : null,
      note: 'an acceptance hook modified the liveness probe for this response; treat the liveness fields as injected',
    },
  }
}

/**
 * Register every route on a plugin context.
 *
 * @param {object} ctx
 * @param {object} options
 * @param {object} [options.startupBackendCheck] - apply-time probe, evidence only
 */
export function registerRoutes(ctx, options = {}) {
  const startupBackendCheck = options.startupBackendCheck ?? null

  const route = (path, methods, handler) => {
    assertApiPath(path)
    ctx.effect(
      () =>
        ctx.connection.fetch.register({
          path,
          methods,
          requestBody: 'buffered',
          fetch: async (request) => {
            try {
              return await handler(request)
            } catch (cause) {
              return failureResponse(cause)
            }
          },
        }),
      `dsh-reclaim: ${path}`,
    )
  }

  // --- reads ---------------------------------------------------------------

  route('/api/dsh-reclaim/health', ['GET'], async () => jsonResponse(healthPayload(ctx)))

  route('/api/dsh-reclaim/attachments', ['GET'], async () =>
    jsonResponse(
      await buildAttachmentsReport({
        store: ctx.get('attachments'),
        startupBackendCheck,
      }),
    ))

  route('/api/dsh-reclaim/sessions', ['GET'], async () => jsonResponse(await listSessions(ctx)))

  route('/api/dsh-reclaim/refs', ['GET'], async (request) => {
    // The raw-read cross-check doubles the read cost, so it defaults to running
    // where a mistake would be dangerous (sessions that yielded no references).
    let requested = null
    try {
      requested = new URL(request.url).searchParams.get('verifyRead')
    } catch {
      requested = null
    }
    const verifyRead = requested === 'all' || requested === 'none' ? requested : 'empty-refs'
    return jsonResponse(await buildReferenceGraph(ctx, { verifyRead }))
  })

  route('/api/dsh-reclaim/classify', ['GET'], async (request) => {
    const params = new URL(request.url).searchParams
    const requestedThreshold = params.get('thresholdDays')
    const requestedVerify = params.get('verifyRead')
    const mode = requestedVerify === 'all' || requestedVerify === 'none' ? requestedVerify : 'empty-refs'
    const rescan = params.get('rescan') === '1'
    // `preview=1` answers with the cheap half only: rows, titles, archive badges, sizes and
    // ages, every row graded "pending". The reference graph is not read, so no tier is claimed
    // — the panel paints these rows while the graph is still being read and replaces them with
    // the real grade when it lands. Nothing here is actionable: a pending row is never
    // selectable, so the gap between the two answers cannot be used to delete anything.
    const preview = params.get('preview') === '1'
    const requested = requestedThreshold === null
      ? { thresholdDays: options.thresholdDays ?? DEFAULT_THRESHOLD_DAYS }
      : { thresholdDays: requestedThreshold }
    // `before=<ISO>` moves the grading clock only. Every measurement — last
    // activity, sizes, the reference graph — comes from the scan; reading the
    // same facts as of an earlier instant is the only way to exercise a
    // 7/14/30/90-day decision on a tree whose sessions are all a few days old,
    // and it is arithmetic, so it cannot rescan.
    let nowMs
    const before = params.get('before')
    if (before !== null) {
      const parsed = Date.parse(before)
      if (!Number.isFinite(parsed)) {
        return jsonResponse({ ok: false, error: `before=${before} is not a parseable instant` }, 400)
      }
      nowMs = parsed
    }
    // Liveness is read HERE, at the moment of decision: this closure calls
    // lib/liveness.js afresh on every invocation, and the second pass invokes it
    // again for every candidate.
    const hooks = livenessTestHooks(params)
    const probe = hooks.wrap((sessionId) => livenessOf(ctx, sessionId))
    // The cheap half is read (or reused) once here and handed to the full scan below, so a
    // preview immediately followed by the real grade does not list the store twice.
    const cheap = await cheapFactsFor(ctx, rescan, startupBackendCheck)
    if (preview) {
      const pending = gradeAll(cheap.facts, {
        probe,
        config: requested,
        scanCount: cheap.scanCount,
        nowMs,
      })
      if (hooks.describe !== null) pending.livenessTestHook = hooks.describe
      pending.pending = true
      pending.scannedAt = cheap.scannedAt
      pending.factsFromCache = cheap.reused === true
      // The grade above ran without the reference graph, so its tiers are not an answer. Every
      // row is relabelled: the tier says "pending" rather than a verdict, nothing is
      // selectable, and the fields that would state a number derived from the graph (how many
      // images, what deleting frees, how much is shared) are nulled rather than left holding a
      // zero that reads as "none".
      for (const row of pending.sessions) {
        row.pending = true
        row.tier = 'pending'
        row.selectable = false
        row.batchClearable = false
        row.dedupCount = null
        row.freedByDeletingBytes = null
        row.freedBreakdown = {}
        row.tierReasons = []
        row.blockingChecks = []
      }
      pending.tiers.sessions = { pending: pending.sessions }
      pending.families = []
      return jsonResponse(pending)
    }
    const cache = await factsFor(ctx, mode, rescan, startupBackendCheck, cheap.facts)
    const report = gradeAll(cache.facts, {
      probe,
      config: requested,
      scanCount: cache.scanCount,
      nowMs,
    })
    if (hooks.describe !== null) report.livenessTestHook = hooks.describe
    // `generatedAt` is the moment of GRADING, which is arithmetic and always now. The two
    // facts below are the ones the panel needs to be honest about what it is showing: when
    // the disk was actually read, and whether this answer came out of the process cache.
    // A missing instant stays null — never filled with "now", which would claim a freshness
    // the scan never had.
    report.scannedAt = cache.scannedAt
    report.factsFromCache = cache.reused === true
    return jsonResponse(report)
  })

  route('/api/dsh-reclaim/trash', ['GET'], async () => {
    const layout = resolveLayout()
    const listed = listBatches(layout)
    const footprint = trashFootprint(layout)
    // The archive residue is a read-only observation and belongs next to the
    // quarantine view: a user looking at "what did I delete" is also the user who
    // needs to know that an archived id stays behind.
    //
    // The listing comes from the audit's own read rather than a second one (see
    // `auditSessions`). That matters for honesty, not only for speed: the residue is a
    // claim about which archived ids are dangling, and classifying them against an empty
    // "live" set — which is what an unreadable listing looks like — would report every
    // archived session as dangling. So an unreadable listing is reported as an unreadable
    // residue, never laundered into a confident one.
    const listing = await auditSessions(ctx).catch(() => null)
    const residue =
      listing === null || listing.available !== true
        ? {
            ok: false,
            reason:
              listing === null
                ? 'the session listing could not be read, so the archive residue cannot be classified'
                : `the session listing is unavailable (${listing.reason ?? 'no reason given'}), so the archive residue cannot be classified`,
            archived: null,
            live: null,
            accountedElsewhere: null,
            dangling: null,
          }
        : await archivedResidue(
            ctx,
            (listing.sessions ?? []).map((row) => row.id),
          )
    return jsonResponse({
      ok: listed.ok,
      generatedAt: new Date().toISOString(),
      root: listed.root,
      exists: listed.exists === true,
      batches: listed.batches,
      strayFiles: listed.strayFiles,
      footprint,
      automaticPurge: {
        implemented: AUTOMATIC_PURGE_IMPLEMENTED,
        note:
          'no scheduled purge exists anywhere in this plugin: a permanent delete happens only because a ' +
          'person asked for one, naming a batch',
      },
      archivedResidue: residue,
      reason: listed.reason,
    })
  })

  route('/api/dsh-reclaim/trash/plan', ['GET'], async (request) => {
    const params = new URL(request.url).searchParams
    const batch = params.get('batch')
    if (batch === null || batch.length === 0) {
      return jsonResponse({ ok: false, error: 'pass ?batch=<batch directory name or absolute path>' }, 400)
    }
    const layout = resolveLayout()
    const batchDir = resolveBatchDir(layout, batch)
    const restore = await planRestore(batchDir)
    return jsonResponse({
      ok: restore.ok,
      batchDir,
      wouldRestore: restore.counts?.pending ?? null,
      blocked: (restore.items ?? []).filter((item) => item.status !== 'pending').map((item) => ({
        originalPath: item.originalPath,
        status: item.status,
        reason: item.reason,
      })),
      purge: describePurge(batchDir),
      reason: restore.reason,
    })
  })

  // --- writes --------------------------------------------------------------

  route('/api/dsh-reclaim/restore', ['POST'], async (request) => {
    const body = await readJsonBody(request)
    if (body.confirm !== true) {
      return jsonResponse({ ok: false, error: 'a restore requires {"confirm": true} in the request body' }, 400)
    }
    const layout = resolveLayout()
    const batchDir = resolveBatchDir(layout, body.batch)
    const result = await restoreBatch(batchDir, { only: Array.isArray(body.only) ? body.only : undefined })
    const pruned = result.restored.length > 0 ? pruneEmptyDirs(batchDir) : null
    return jsonResponse({ ...describeRestoreResult(result), raw: result, pruned })
  })

  route('/api/dsh-reclaim/purge', ['POST'], async (request) => {
    const body = await readJsonBody(request)
    const layout = resolveLayout()
    const batchDir = resolveBatchDir(layout, body.batch)
    const before = describePurge(batchDir)
    if (body.confirm !== true) {
      // The interface is responsible for showing "permanently delete N items,
      // X MB" first; this response is what it shows.
      return jsonResponse(
        {
          ok: false,
          error: 'a permanent delete requires {"confirm": true} in the request body',
          wouldDestroy: before,
        },
        400,
      )
    }
    return jsonResponse(purgeBatch(batchDir, { confirmed: true }))
  })

  route('/api/dsh-reclaim/delete', ['POST'], async (request) => {
    const body = await readJsonBody(request)
    const layout = resolveLayout()
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : null
    if (sessionId === null || !isValidSessionId(sessionId)) {
      return jsonResponse({ ok: false, error: 'a delete requires a valid non-empty {"sessionId": "..."} without path traversal' }, 400)
    }
    const dryRun = body.dryRun === true
    if (!dryRun && body.confirm !== true) {
      return jsonResponse(
        {
          ok: false,
          error: 'a delete requires {"confirm": true}; use {"dryRun": true} to ask what would happen first',
        },
        400,
      )
    }
    // The workspace path is needed to locate the session directory. It is taken
    // from the accounting when the caller does not supply it, so a caller cannot
    // point the delete at an arbitrary directory.
    const workspacePath = typeof body.workspacePath === 'string'
      ? body.workspacePath
      : await workspacePathFor(ctx, sessionId)

    // The tier this session was *shown* with is not taken from the caller: the
    // reference graph is supplied from the same cached scan the interface graded
    // with, so the request is refused by exactly the rule that disabled the
    // checkbox — and a batch of deletes pays for one scan, not one per session.
    // `body.risk` below is the caller's own claim and authorizes nothing; it is
    // recorded as evidence.
    //
    // When the scan cannot be run, nothing is passed and `planSessionDelete`
    // builds the graph itself; if that fails too the delete is refused as
    // unprovable rather than allowed. A failed scan must not become a 500 here,
    // because a 500 says "try again" and this says "do not".
    let referenceGraph = null
    let referenceScanCount = null
    try {
      // A warm cache is used as-is, whatever mode filled it: the point is to
      // judge by the generation the interface graded with, and grading again at a
      // different read-verification depth would both throw that away and evict
      // the cache the interface is still using.
      const cache = factCache.facts === null
        ? await factsFor(ctx, 'empty-refs', false, startupBackendCheck)
        : factCache
      referenceGraph = cache.facts?.graph ?? null
      referenceScanCount = cache.scanCount ?? null
    } catch (cause) {
      // Not swallowed, and not retried either. Falling back to `null` would make
      // `planSessionDelete` build the graph itself and fail closed — correct, but
      // the refusal reason would then describe that second failure instead of
      // this one, which is the fault that actually happened. A graph-shaped
      // "not ok" carries this cause through the contract that already exists
      // (`referenceGraphFailure` reads `graph.reason`) and spends no second scan.
      const detail = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)
      referenceGraph = { ok: false, reason: `the reference graph could not be built while grading: ${detail}` }
      referenceScanCount = null
    }

    const result = await deleteSession(ctx, {
      layout,
      sessionId,
      workspacePath,
      dryRun,
      risk: body.risk ?? null,
      referenceGraph,
      referenceScanCount,
    })
    return jsonResponse(result)
  })

  route('/api/dsh-reclaim/clear', ['POST'], async (request) => {
    const body = await readJsonBody(request)
    const layout = resolveLayout()
    const ids = Array.isArray(body.ids) ? body.ids : null
    if (ids === null || ids.length === 0) {
      return jsonResponse(
        { ok: false, error: 'a clear requires {"ids": ["<row id>", ...]} naming at least one row' },
        400,
      )
    }
    const dryRun = body.dryRun === true
    if (!dryRun && body.confirm !== true) {
      return jsonResponse(
        {
          ok: false,
          error: 'a clear requires {"confirm": true}; use {"dryRun": true} to ask what would happen first',
        },
        400,
      )
    }

    // Graded fresh, and deliberately not from the cache the interface rendered
    // from. `/delete` honours the generation the user was shown, because a
    // session's identity does not depend on the scan. Here it does: a row
    // supplies BOTH the verdict ("this object has no references") and the paths
    // that verdict is about, and a session written since the page was rendered
    // can turn an orphan into a referenced object. Re-deriving both from one
    // instant costs one scan per clear, and it removes the only way this route
    // could move something the user still needs.
    const cache = await factsFor(ctx, 'empty-refs', true, startupBackendCheck)
    const report = gradeAll(cache.facts, {
      probe: (sessionId) => livenessOf(ctx, sessionId),
      config: { thresholdDays: options.thresholdDays ?? DEFAULT_THRESHOLD_DAYS },
      scanCount: cache.scanCount,
    })
    // Every row kind that can carry a `batchClearable` verdict. Sessions are in
    // the report too and are deliberately absent here: `planClearCandidates`
    // refuses them by name, because moving a session is only part of deleting one.
    const rows = [
      ...(report.attachments ?? []),
      ...Object.values(report.tiers?.caches ?? {}).flat(),
    ]
    const plan = planClearCandidates(rows, ids)
    if (!plan.ok) {
      // A refusal, not a 500: "this row is not clearable any more" is an answer
      // about the world, and a 500 would say "try again" about a verdict that
      // will not change on retry.
      return jsonResponse(
        { ok: false, error: plan.reason, refusals: plan.refusals, move: null, scanCount: cache.scanCount },
        200,
      )
    }

    // No `detach`: that accounting step exists for sessions, and session rows
    // never reach this call. `risk` is not taken from the caller either — the
    // verdict that authorized this move is the one graded above, and it is
    // archived from there rather than from the request body (§8.5).
    const move = await deleteSessionItems({ layout, items: plan.items, dryRun })
    return jsonResponse({ ok: move.ok, refusals: [], move, scanCount: cache.scanCount })
  })

  return ROUTES.map((entry) => entry.path)
}
