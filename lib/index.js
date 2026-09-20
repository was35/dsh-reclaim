/**
 * dsh-reclaim — host-side plugin entry.
 *
 * This file is now only the plugin's *identity* and its wiring:
 *
 *   - `name` / `inject` (the published contract),
 *   - the apply-time backend probe (evidence, never a cached verdict),
 *   - handing the HTTP surface to `lib/routes.js`, where the whole attack surface
 *     can be read in one file,
 *   - registering the read-only audit tool when the deployment has a tools
 *     service — and reporting it honestly when it does not.
 *
 * `inject` lists exactly the services this file accesses through `ctx.<name>`
 * property access. It deliberately contains only `connection`:
 *
 *   - the attachment backend is reached with `ctx.get('attachments')`, because
 *     declaring it would stop the plugin from loading at all in a deployment
 *     without that backend — which is the opposite of the required behavior
 *     (disable enumeration and state the reason);
 *   - `tools` is reached with `ctx.get('tools')` for the same reason: a
 *     headless deployment without tools should still serve the audit routes.
 */

import { resolveLayout } from './paths.js'
import { checkAttachmentBackend } from './backend-check.js'
import { registerRoutes, scanFacts } from './routes.js'
import { gradeAll } from './classification-report.js'
import { livenessOf } from './liveness.js'
import { buildAuditTool, registerAuditTool } from './tool.js'
import { trashFootprint } from './purge.js'
import { DEFAULT_THRESHOLD_DAYS } from './config.js'

export const name = 'reclaim'
export const inject = ['connection']

/**
 * Best-effort logging through the host logger service. Property access on `ctx`
 * is gated by `inject`, and a missing logger must never break `apply`, so this
 * goes through `ctx.get` inside a guard.
 */
function safeLog(ctx, level, message) {
  try {
    ctx.get('logger')?.[level]?.(message)
  } catch {
    /* logging is never allowed to affect plugin behavior */
  }
}

/** The last tool-registration outcome, reported by the health route. */
let toolRegistration = null

export function apply(ctx, rawConfig) {
  const thresholdDays = rawConfig?.thresholdDays ?? DEFAULT_THRESHOLD_DAYS

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

  const registeredRoutes = registerRoutes(ctx, { startupBackendCheck, thresholdDays })

  // --- the read-only audit tool -------------------------------------------
  //
  // Registered only if this deployment has a tools service, and the outcome is
  // remembered so the health route can say "no tool, and here is why" instead of
  // leaving a model to wonder whether audit data exists at all.
  const tool = buildAuditTool({
    ctx,
    configuredThresholdDays: thresholdDays,
    describeLayout: () => {
      const layout = resolveLayout()
      return { home: layout.home, homeDisplay: layout.homeDisplay, homeSource: layout.homeSource }
    },
    log: (error) => safeLog(ctx, 'warn', `dsh-reclaim: ${error}`),
    grade: async (gradeCtx, options) => {
      // The tool grades through the same path the interface uses, with facts
      // gathered fresh: a tool answer built from a cache that outlived the
      // interface's last cleanup would describe a tree that no longer exists.
      const facts = await scanFacts(gradeCtx ?? ctx, { verifyRead: 'empty-refs' })
      const report = gradeAll(facts, {
        probe: (sessionId) => livenessOf(gradeCtx ?? ctx, sessionId),
        config: { thresholdDays: options?.thresholdDays ?? thresholdDays },
        scanCount: 1,
      })
      const footprint = trashFootprint(facts.layout)
      return { ...report, quarantineBytes: footprint.bytes ?? 0 }
    },
  })
  toolRegistration = registerAuditTool(ctx, tool)
  safeLog(
    ctx,
    toolRegistration.registered ? 'info' : 'warn',
    `dsh-reclaim: audit tool ${toolRegistration.registered ? 'registered as ' + toolRegistration.name : 'not registered: ' + toolRegistration.reason}`,
  )

  safeLog(
    ctx,
    'info',
    `dsh-reclaim: ready (${thresholdDays}-day threshold, ${registeredRoutes.length} route(s), ` +
      `audit tool ${toolRegistration.registered ? 'registered' : 'absent'})`,
  )
}

/** Evidence about the tool registration, for the health route. */
export function describeTool() {
  return toolRegistration
}
