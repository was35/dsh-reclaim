/**
 * dsh-reclaim — host-side plugin entry.
 *
 * Exposes two read-only routes inside the running host: a health route that
 * reports what the asset-location layer resolved, and an attachments route
 * that reports the attachment/cache enumeration.
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
import { buildCacheReport, sessionIdsUnavailable } from './caches.js'

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

export function apply(ctx, config) {
  // No user-facing configuration is defined yet; the value is accepted and
  // intentionally unused.
  void config

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
  // --- end route registration area ---
}
