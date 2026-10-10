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
import { deleteSession } from './delete-session.js'
import { AUTOMATIC_PURGE_IMPLEMENTED } from './trash.js'
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
 * compatibility-breaking changes. Its manifest fields (`engines.dsh`, `dsh.manifestVersion`) are
 * documented as **declarative only** — the installer and loader do not enforce them — so a mismatched
 * host will load this plugin happily and then fail in ways that look like plugin bugs: a blank
 * settings page, a 404 route, a silently missing service.
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
const factCache = { mode: null, facts: null, scanCount: 0, inFlight: null }

/** Gather every fact the grading needs, once. */
export async function scanFacts(ctx, options = {}) {
  const layout = resolveLayout()
  const backend = checkAttachmentBackend({ store: ctx.get('attachments'), layout })
  const sessions = await listSessions(ctx)
  const sessionIds = sessions.available === true
    ? sessionIdsFrom(sessions.sessions.map((row) => row.id))
    : sessionIdsUnavailable(sessions.reason ?? 'the session listing could not be read')

  const attachments = await scanAttachments(layout, { backend, collectFileList: true })
  const caches = buildCacheReport({ layout, attachments, sessionIds })
  const graph = await buildReferenceGraph(ctx, {
    verifyRead: options.verifyRead ?? 'empty-refs',
    sessionIds: sessions.available === true ? sessions.sessions.map((row) => row.id) : undefined,
  })

  return {
    ctx,
    layout,
    backend,
    startupBackendCheck: options.startupBackendCheck ?? null,
    sessions,
    sessionsServiceAvailable: readLivenessServices(ctx).sessions !== null,
    attachments,
    caches,
    graph,
    scannedAt: new Date().toISOString(),
  }
}

async function factsFor(ctx, mode, rescan, startupBackendCheck) {
  if (!rescan && factCache.mode === mode && factCache.facts !== null) return factCache
  if (factCache.inFlight !== null) return factCache.inFlight
  const run = (async () => {
    const facts = await scanFacts(ctx, { verifyRead: mode, startupBackendCheck })
    factCache.mode = mode
    factCache.facts = facts
    factCache.scanCount += 1
    return factCache
  })()
  factCache.inFlight = run
  try {
    return await run
  } finally {
    factCache.inFlight = null
  }
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
    const cache = await factsFor(ctx, mode, rescan, startupBackendCheck)
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
    const report = gradeAll(cache.facts, {
      probe,
      config: requested,
      scanCount: cache.scanCount,
      nowMs,
    })
    if (hooks.describe !== null) report.livenessTestHook = hooks.describe
    return jsonResponse(report)
  })

  route('/api/dsh-reclaim/trash', ['GET'], async () => {
    const layout = resolveLayout()
    const listed = listBatches(layout)
    const footprint = trashFootprint(layout)
    // The archive residue is a read-only observation and belongs next to the
    // quarantine view: a user looking at "what did I delete" is also the user who
    // needs to know that an archived id stays behind.
    const sessions = await listSessions(ctx).catch(() => null)
    const residue = await archivedResidue(
      ctx,
      (sessions?.sessions ?? []).map((row) => row.id),
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
    if (sessionId === null) {
      return jsonResponse({ ok: false, error: 'a delete requires {"sessionId": "..."}' }, 400)
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
    } catch {
      referenceGraph = null
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

  return ROUTES.map((entry) => entry.path)
}
