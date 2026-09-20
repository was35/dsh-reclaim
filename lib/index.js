/**
 * dsh-reclaim — host-side plugin entry.
 *
 * Exposes four read-only routes inside the running host: a health route that
 * reports what the asset-location layer resolved, a sessions route that reports
 * the session table, an attachments route that reports the attachment/cache
 * enumeration, and a refs route that reports the reference graph together with
 * its coverage verdict.
 *
 * Everything registered here is READ-ONLY except the quarantine routes, which
 * are the plugin's only mutating paths: a delete MOVES data into the plugin's own
 * quarantine under the user's DSH home, and nothing is ever destroyed by a delete.
 * Every one of those routes requires an explicit confirmation in the request body,
 * and none of them is reachable from the agent-tool surface.
 *
 * Loader row (published form, see cordis.patch.yml):
 *   - insert: [{ id: reclaim, name: dsh-reclaim }]
 *
 * `inject` lists exactly the services accessed via `ctx.<name>` property
 * access — omitting one makes that access throw
 * (`cannot get property "<name>" without inject`). Services fetched through
 * `ctx.get(name)` bypass inject and are therefore not listed. The attachment
 * backend is deliberately reached with `ctx.get('attachments')` and NOT
 * declared here: declaring it would make the plugin fail to load in a
 * deployment without that backend, which is the opposite of the required
 * behavior (disable enumeration and state the reason).
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
import { THRESHOLD_CHOICES, DEFAULT_THRESHOLD_DAYS } from './config.js'
import { listBatches, describePurge, purgeBatch, trashFootprint } from './purge.js'
import { describeRestoreResult, planRestore, restoreBatch, pruneEmptyDirs } from './restore.js'
import { deleteSession } from './delete-session.js'
import { AUTOMATIC_PURGE_IMPLEMENTED } from './trash.js'
import { archivedResidue } from './workspace-sync.js'

export const name = 'reclaim'
export const inject = ['connection']

/**
 * Why orphan projection-cache detection is off while no session list is
 * available. A projection cache may only be called an orphan when the list
 * that would have claimed it was actually obtained; an absent list must never
 * degrade into "no session claims this file, therefore it is an orphan".
 */
const SESSION_LIST_PENDING =
  'no session list is available yet, so no cache file is classified as an orphan; ' +
  'calling a file an orphan without the list that would have claimed it could authorize ' +
  'deleting a live session cache'

/**
 * Compose the read-only attachment/cache report.
 *
 * Shared by the in-host route and the acceptance CLI on purpose: the CLI
 * exists to verify the same code path without loading the plugin, so both
 * callers must go through this one function.
 *
 * @param {object} [options]
 * @param {object|undefined} [options.store] - `ctx.get('attachments')`
 * @param {object} [options.backend] - pre-computed backend verdict, used by
 *   callers that cannot probe (the acceptance CLI asserts locality explicitly
 *   via `assumeLocalBackend`); when absent the backend is probed
 * @param {object} [options.layout] - pre-resolved layout (defaults to the process layout)
 * @param {object} [options.sessionIds] - injected session-id source; defaults to "unavailable"
 * @param {string} [options.projectionCacheRoot] - test override for the cache root
 * @param {object|null} [options.startupBackendCheck] - apply-time probe, evidence only
 */
export async function buildAttachmentsReport(options = {}) {
  const layout = options.layout ?? resolveLayout()
  const backend = options.backend ?? checkAttachmentBackend({ store: options.store, layout })
  const attachments = await scanAttachments(layout, { backend })
  const caches = buildCacheReport({
    layout,
    attachments,
    sessionIds: options.sessionIds ?? sessionIdsUnavailable(SESSION_LIST_PENDING),
    projectionCacheRoot: options.projectionCacheRoot,
  })

  return {
    ok: true,
    plugin: 'dsh-reclaim',
    name,
    scannedAt: new Date().toISOString(),
    layout: {
      home: layout.home,
      homeDisplay: layout.homeDisplay,
      homeSource: layout.homeSource,
      attachmentsRoot: layout.attachmentsRoot,
      trashRoot: layout.trash.root,
    },
    // The apply-time probe is evidence for "when did the backend appear",
    // never the verdict: it is not memoized and the scan re-probes.
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
 * Gather every fact the grading needs, once.
 *
 * This is the expensive step: the reference graph replays whole session logs
 * (`observeSession` per session) and the attachment scan walks the storage
 * tree. Grading itself is arithmetic over this result, so a threshold change
 * must never come back here.
 *
 * @param {object} ctx
 * @param {object} options
 * @param {'all'|'empty-refs'|'none'} [options.verifyRead]
 * @param {object} [options.startupBackendCheck]
 */
async function scanFacts(ctx, options = {}) {
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

/**
 * The classification route's fact cache — memory only.
 *
 * The design forbids a persisted cache here on purpose: the whole point of this
 * plugin is to judge correctly, and a disk layer that can go stale is exactly
 * how a wrong judgment reaches a delete. Reusing facts inside one process is
 * different: grading is pure arithmetic, so re-grading costs nothing and the
 * expensive reads happen once per fact generation.
 */
const factCache = { mode: null, facts: null, scanCount: 0, inFlight: null }

/**
 * @param {object} ctx
 * @param {'all'|'empty-refs'|'none'} mode
 * @param {boolean} rescan
 * @param {object|null} startupBackendCheck
 */
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

/** Format the layout that the health route reports. */
function healthPayload() {
  const layout = resolveLayout()
  return {
    ok: true,
    plugin: 'dsh-reclaim',
    name,
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
 * Best-effort logging through the host logger service. Property access on
 * `ctx` is gated by `inject`, and a missing logger must never break `apply`,
 * so this goes through `ctx.get` inside a guard.
 */
function safeLog(ctx, level, message) {
  try {
    ctx.get('logger')?.[level]?.(message)
  } catch {
    /* logging is never allowed to affect plugin behavior */
  }
}

/**
 * Acceptance hooks for liveness, off unless explicitly requested.
 *
 * Two properties the classifier must be able to demonstrate — "a loaded-but-idle
 * session is still dangerous" and "liveness is re-read before a candidate leaves
 * the batch" — cannot be observed by waiting: the measured `running` window is
 * ~117ms, and a
 * freshly created session is idle-live for only as long as it takes to type the
 * next check. Faking the probe makes both properties testable in one request.
 *
 * The hooks can only ever make the verdict MORE cautious for the states they
 * name (`?testLiveness=idle-live` reports a session as in use), and the report
 * records their presence so no evidence produced with them can be mistaken for
 * an unmodified run. They are not a user-facing feature, and nothing here
 * writes anything.
 *
 * @param {URLSearchParams} params
 * @returns {{ wrap: (probe: Function) => Function, describe: object|null }}
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

export function apply(ctx, rawConfig) {
  // The threshold is the plugin's only user-facing setting; the shape (and its
  // normalization) lives in lib/config.js so the grading code and the host's
  // validation agree by construction.
  const config = {
    thresholdDays: rawConfig?.thresholdDays ?? DEFAULT_THRESHOLD_DAYS,
  }
  // Early warning only: the attachment backend may legitimately not be mounted
  // yet, so this result is recorded as evidence and never reused as a verdict.
  let startupBackendCheck = null
  try {
    startupBackendCheck = checkAttachmentBackend({
      store: ctx.get('attachments'),
      layout: resolveLayout(),
    })
    safeLog(
      ctx,
      'info',
      `dsh-reclaim: startup attachment-backend probe: local=${startupBackendCheck.local} (evidence only)`,
    )
  } catch (cause) {
    startupBackendCheck = {
      local: null,
      reason: `the startup probe itself failed: ${cause?.name ?? 'Error'}: ${cause?.message ?? String(cause)}`,
    }
    safeLog(ctx, 'warn', `dsh-reclaim: startup attachment-backend probe failed: ${startupBackendCheck.reason}`)
  }

  // Everything the plugin registers goes through ctx.effect() so the host can
  // unwind it on unload (the register call returns its own disposer).
  //
  // Routes MUST live under /api/ — that prefix is what puts the host's
  // Host/Origin fence and cookie auth in front of the handler.

  // --- route registration area: additional /api/dsh-reclaim/* routes go here ---
  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        path: '/api/dsh-reclaim/health',
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: async () => {
          try {
            return jsonResponse(healthPayload())
          } catch (cause) {
            return failureResponse(cause)
          }
        },
      }),
    'dsh-reclaim: health route',
  )

  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        path: '/api/dsh-reclaim/attachments',
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: async () => {
          try {
            return jsonResponse(
              await buildAttachmentsReport({
                store: ctx.get('attachments'),
                startupBackendCheck,
              }),
            )
          } catch (cause) {
            return failureResponse(cause)
          }
        },
      }),
    'dsh-reclaim: attachments route',
  )

  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        path: '/api/dsh-reclaim/sessions',
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: async () => {
          try {
            return jsonResponse(await listSessions(ctx))
          } catch (cause) {
            return failureResponse(cause)
          }
        },
      }),
    'dsh-reclaim: sessions route',
  )

  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        path: '/api/dsh-reclaim/refs',
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: async (request) => {
          try {
            // The raw-read cross-check doubles the read cost, so it defaults to
            // running where a mistake would be dangerous (sessions that yielded no
            // references). `?verifyRead=all` exists for acceptance runs.
            let requested = null
            try {
              requested = new URL(request.url).searchParams.get('verifyRead')
            } catch {
              requested = null
            }
            const verifyRead = requested === 'all' || requested === 'none' ? requested : 'empty-refs'
            return jsonResponse(await buildReferenceGraph(ctx, { verifyRead }))
          } catch (cause) {
            return failureResponse(cause)
          }
        },
      }),
    'dsh-reclaim: refs route',
  )
  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        path: '/api/dsh-reclaim/classify',
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: async (request) => {
          try {
            const params = new URL(request.url).searchParams
            // The URL threshold wins over the configured one so a threshold
            // sweep can be exercised against one scan. It is still validated in
            // lib/config.js: an unusable value falls back to the default AND
            // says so, rather than being read as a number the user did not mean.
            const requestedThreshold = params.get('thresholdDays')
            const requestedVerify = params.get('verifyRead')
            const mode = requestedVerify === 'all' || requestedVerify === 'none' ? requestedVerify : 'empty-refs'
            const rescan = params.get('rescan') === '1'
            const cache = await factsFor(ctx, mode, rescan, startupBackendCheck)
            const requested = requestedThreshold === null
              ? { thresholdDays: config.thresholdDays }
              : { thresholdDays: requestedThreshold }
            // `before=<ISO>` moves the grading clock only. Every measurement —
            // last activity, sizes, the reference graph — comes from the scan;
            // reading the same facts as of an earlier instant is the only way to
            // exercise a 7/14/30/90-day decision on a tree whose sessions are all
            // a few days old, and it is arithmetic, so it cannot rescan.
            let nowMs
            const before = params.get('before')
            if (before !== null) {
              const parsed = Date.parse(before)
              if (!Number.isFinite(parsed)) {
                return jsonResponse({ ok: false, error: `before=${before} is not a parseable instant` }, 400)
              }
              nowMs = parsed
            }
            // Liveness is read HERE, at the moment of decision: this closure
            // calls lib/liveness.js afresh on every invocation, and the second
            // pass invokes it again for every candidate.
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
          } catch (cause) {
            return failureResponse(cause)
          }
        },
      }),
    'dsh-reclaim: classification route',
  )

  // --- quarantine routes ---------------------------------------------------
  //
  // Two read-only routes and two mutating ones, and the mutating pair is
  // deliberately narrow:
  //
  //   - every route that changes anything requires a `confirm` body field, so no
  //     request can destroy or move data through a default argument;
  //   - `POST /delete` accepts `dryRun` and is the ONLY way a delete can start,
  //     which keeps the "the model can query, never delete" rule enforceable at
  //     one place: `inject` still does not expose these to any tool;
  //   - the automatic purge is deliberately absent, and that absence is reported
  //     by the status route rather than left to be inferred from a missing route.
  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        path: '/api/dsh-reclaim/trash',
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: async () => {
          try {
            const layout = resolveLayout()
            const listed = listBatches(layout)
            const footprint = trashFootprint(layout)
            // The archive residue is a read-only observation, and it belongs next
            // to the quarantine view: a user looking at "what did I delete" is
            // also the user who needs to know that an archived id stays behind.
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
          } catch (cause) {
            return failureResponse(cause)
          }
        },
      }),
    'dsh-reclaim: trash route',
  )

  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        path: '/api/dsh-reclaim/trash/plan',
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: async (request) => {
          try {
            const params = new URL(request.url).searchParams
            const batch = params.get('batch')
            if (batch === null || batch.length === 0) {
              return jsonResponse({ ok: false, error: 'pass ?batch=<batch directory name or absolute path>' }, 400)
            }
            const layout = resolveLayout()
            const batchDir = resolveBatchDir(layout, batch)
            const restore = planRestore(batchDir)
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
          } catch (cause) {
            return failureResponse(cause)
          }
        },
      }),
    'dsh-reclaim: trash plan route',
  )

  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        path: '/api/dsh-reclaim/restore',
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          try {
            const body = await readJsonBody(request)
            if (body.confirm !== true) {
              return jsonResponse(
                { ok: false, error: 'a restore requires {"confirm": true} in the request body' },
                400,
              )
            }
            const layout = resolveLayout()
            const batchDir = resolveBatchDir(layout, body.batch)
            const result = restoreBatch(batchDir, { only: Array.isArray(body.only) ? body.only : undefined })
            const pruned = result.restored.length > 0 ? pruneEmptyDirs(batchDir) : null
            return jsonResponse({ ...describeRestoreResult(result), raw: result, pruned })
          } catch (cause) {
            return failureResponse(cause)
          }
        },
      }),
    'dsh-reclaim: restore route',
  )

  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        path: '/api/dsh-reclaim/purge',
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          try {
            const body = await readJsonBody(request)
            const layout = resolveLayout()
            const batchDir = resolveBatchDir(layout, body.batch)
            const before = describePurge(batchDir)
            if (body.confirm !== true) {
              // The interface is responsible for showing "permanently delete N
              // items, X MB" first; this response is what it shows.
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
          } catch (cause) {
            return failureResponse(cause)
          }
        },
      }),
    'dsh-reclaim: purge route',
  )

  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        path: '/api/dsh-reclaim/delete',
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          try {
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
                  error:
                    'a delete requires {"confirm": true}; use {"dryRun": true} to ask what would happen first',
                },
                400,
              )
            }
            // The workspace path is needed to locate the session directory. It is
            // taken from the accounting when the caller does not supply it, so a
            // caller cannot point the delete at an arbitrary directory.
            const workspacePath = typeof body.workspacePath === 'string'
              ? body.workspacePath
              : await workspacePathFor(ctx, sessionId)
            const result = await deleteSession(ctx, {
              layout,
              sessionId,
              workspacePath,
              dryRun,
              risk: body.risk ?? null,
            })
            return jsonResponse(result)
          } catch (cause) {
            return failureResponse(cause)
          }
        },
      }),
    'dsh-reclaim: delete route',
  )
  // --- end route registration area ---
}

/** Resolve a batch name or path against the trash root, refusing anything else. */
function resolveBatchDir(layout, batch) {
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
