/**
 * dsh-reclaim — host-side plugin entry.
 *
 * Exposes four read-only routes inside the running host: a health route that
 * reports what the asset-location layer resolved, a sessions route that reports
 * the session table, an attachments route that reports the attachment/cache
 * enumeration, and a refs route that reports the reference graph together with
 * its coverage verdict.
 *
 * Everything registered here is READ-ONLY: no code path in this plugin
 * creates, moves, or deletes anything under the user's DSH home. The
 * quarantine and the mutating operations do not exist yet.
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

import { resolveLayout } from './paths.js'
import { checkAttachmentBackend } from './backend-check.js'
import { scanAttachments } from './attachments.js'
import { buildCacheReport, sessionIdsFrom, sessionIdsUnavailable } from './caches.js'
import { listSessions } from './sessions.js'
import { buildReferenceGraph } from './graph.js'
import { gradeAll } from './classification-report.js'
import { livenessOf, readLivenessServices } from './liveness.js'
import { THRESHOLD_CHOICES, DEFAULT_THRESHOLD_DAYS } from './config.js'

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
 * The two properties this switch exists to make provable — "a loaded-but-idle
 * session is still dangerous" and "liveness is re-read before a candidate leaves
 * the batch" —
 * cannot be observed by waiting: the measured `running` window is ~117ms, and a
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
  // --- end route registration area ---
}
