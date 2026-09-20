/**
 * dsh-reclaim — the read-only audit tool for the model.
 *
 * ## Why this file is deliberately small
 *
 * The project's delivery decision is that **the model can query, never delete**.
 * The interface is where destruction happens, because a person is there to weigh
 * the evidence. A tool that could move a session into the quarantine would put a
 * destructive action one hallucination away, so this tool has:
 *
 *   - **no destructive capability**, and
 *   - **no parameter that could acquire one**. The parameters are a threshold, a
 *     result limit and a filter. There is no path, no session id, no direction
 *     ("delete"/"restore"/"purge"), no `dryRun`, and no way to smuggle one in.
 *
 * That second half is the part that is easy to get wrong: a tool with a
 * `sessionId` parameter is one line of implementation away from being a delete
 * tool. So the parameters are asserted in the unit tests as a closed set, and the
 * description tells the model plainly that it cannot delete and must not claim
 * otherwise.
 *
 * ## Unknown must survive the trip
 *
 * The tool's output carries the same honesty the interface needs: which sessions'
 * reference relations could not be proven complete, whether orphan detection is
 * paused because of them, and which numbers are unknown rather than zero. A model
 * that reports "0 reclaimable" when the truth is "we could not tell" is the same
 * failure as an interface that does it — and harder to notice.
 *
 * ## Registration is optional, and its absence is reported
 *
 * The tool registers only if the deployment actually exposes a tools service.
 * `tools` is therefore read with `ctx.get`, never declared in `inject`: declaring
 * it would stop this plugin from loading at all in a deployment without tools,
 * which is the opposite of what is wanted. When the service is missing, the audit
 * data is still served over the read-only routes, and `describeToolRegistration`
 * says exactly why no tool exists.
 */

/** The tool's name as the model sees it. */
export const TOOL_NAME = 'reclaim_audit'

/**
 * The full parameter surface, exported so it can be asserted as a closed set.
 *
 * Deliberately flat JSON Schema, no `oneOf`, no free-form object: a structured
 * parameter is a place a destructive capability could hide.
 */
export const TOOL_PARAMETERS = Object.freeze({
  thresholdDays: {
    type: 'integer',
    description:
      'Inactivity window in days used to grade sessions. One of 7, 14, 30 or 90. Defaults to the ' +
      'configured value (30). Changing it only re-grades facts already in memory; it does not rescan.',
  },
  limit: {
    type: 'integer',
    description: 'Maximum rows per tier in the response. Defaults to 20, capped at 200.',
  },
  tier: {
    type: 'string',
    enum: ['safe', 'confirm', 'danger', 'all'],
    description: 'Which tier to detail. Defaults to "all" (counts plus the safe and confirm rows).',
  },
})

/** One line describing what the tool does not do, for the description. */
const NO_DELETE_NOTICE =
  'This tool is READ-ONLY and cannot delete, move or restore anything: it has no parameter for it. ' +
  'Destruction happens only in the settings interface, where a person confirms it.'

function describeCause(cause) {
  if (cause === null || cause === undefined) return String(cause)
  const name = cause?.name ?? 'Error'
  const message = cause?.message ?? String(cause)
  return `${name}: ${message}`
}

/** The nearest offered threshold, or the configured one. */
export function normalizeThresholdDays(requested, configured = 30) {
  const choices = [7, 14, 30, 90]
  if (requested === undefined || requested === null) return { thresholdDays: configured, note: null }
  if (choices.includes(requested)) return { thresholdDays: requested, note: null }
  const positive = typeof requested === 'number' && Number.isFinite(requested) && requested > 0
  if (positive) {
    return {
      thresholdDays: requested,
      note: `thresholdDays=${requested} is not one of the offered choices (${choices.join(' / ')}); used as given`,
    }
  }
  return {
    thresholdDays: configured,
    note: `thresholdDays=${JSON.stringify(requested)} is not a positive number, so the configured ${configured} days is used`,
  }
}

/**
 * Build the tool definition.
 *
 * @param {object} deps
 * @param {(ctx: object, options: object) => Promise<object>} deps.grade
 *   - a function that produces the classification report; injected so this module
 *     stays free of the fact-gathering details (and testable with a fake)
 * @param {() => object} deps.describeLayout - evidence about which home was used
 * @param {(error: unknown) => void} [deps.log]
 */
export function buildAuditTool(deps) {
  const { grade, describeLayout, log } = deps

  return {
    name: TOOL_NAME,
    description:
      'Audit how much disk space DeepSeek Harness occupies (sessions, attachments, rebuildable caches) and ' +
      'which of it could be reclaimed, with the evidence behind each verdict. Use it when the user asks what ' +
      'is taking up space, what can be cleaned up, or why something is or is not considered safe to remove. ' +
      NO_DELETE_NOTICE,
    parameters: TOOL_PARAMETERS,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          thresholdDays: { type: 'integer', required: true },
          scannedAt: { type: 'string', required: true },
          scanGeneration: { type: 'integer' },
          home: { type: 'string' },
          counts: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              sessions: { type: 'integer', required: true },
              families: { type: 'integer', required: true },
              attachments: { type: 'integer', required: true },
            },
          },
          reclaimableBytes: { type: 'integer', required: true },
          quarantineBytes: { type: 'integer', required: true },
          byTier: { type: 'object', required: true },
          safeSessions: { type: 'array', required: true },
          confirmSessions: { type: 'array', required: true },
          dangerSessions: { type: 'array', required: true },
          warnings: { type: 'array', required: true },
          cannotDelete: { type: 'string', required: true },
        },
      },
      render: (_args, value) => {
        const lines = []
        lines.push(
          `Reclaimable: ${value.reclaimableBytes} B (quarantine currently holds ${value.quarantineBytes} B).`,
        )
        lines.push(
          `Sessions: ${value.counts.sessions} (safe ${value.byTier.sessions?.safe ?? 0}, ` +
            `confirm ${value.byTier.sessions?.confirm ?? 0}, danger ${value.byTier.sessions?.danger ?? 0}).`,
        )
        if (value.warnings.length > 0) {
          lines.push('Warnings:')
          for (const warning of value.warnings) lines.push(`  - ${warning}`)
        }
        lines.push(value.cannotDelete)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },

    async execute(args = {}, exec) {
      const limit = Math.min(Math.max(Number.isSafeInteger(args.limit) && args.limit > 0 ? args.limit : 20, 1), 200)
      const tier = typeof args.tier === 'string' && ['safe', 'confirm', 'danger', 'all'].includes(args.tier)
        ? args.tier
        : 'all'
      const requested = Number.isSafeInteger(args.thresholdDays) ? args.thresholdDays : undefined
      const normalized = normalizeThresholdDays(requested, deps.configuredThresholdDays ?? 30)

      let report
      try {
        report = await grade(exec?.ctx ?? deps.ctx, { thresholdDays: normalized.thresholdDays })
      } catch (cause) {
        // A failed audit is reported as a failure, never as "nothing to clean".
        throw new Error(`the audit could not be produced: ${describeCause(cause)}`)
      }

      const warnings = []
      if (normalized.note !== null) warnings.push(normalized.note)
      if (report.gate?.orphanDeterminationAllowed === false) {
        warnings.push(
          `orphan attachment detection is PAUSED for this scan: relations could not be proven complete for ` +
            `${report.gate.unknownSessions?.length ?? '?'} session(s). Attachment figures are therefore ` +
            'incomplete, not zero.',
        )
      }
      if (report.gate?.livenessServiceAvailable === false) {
        warnings.push(
          'the live-session store could not be read, so no session can be proven safe to remove in this scan ' +
            '(unknown is not the same as "nothing is running").',
        )
      }
      if (report.totals?.sessionCount === 0 && report.totals?.attachmentCount === 0) {
        warnings.push(
          'no sessions and no attachments were found. That is reported as a measurement, but if the host ' +
            'normally has sessions it means the listing could not be read rather than that the disk is empty.',
        )
      }
      warnings.push(...(report.limits?.coverage !== undefined ? [report.limits.coverage] : []))
      warnings.push(...(report.notes ?? []).slice(0, 6))

      const rows = (tierRows) => tierRows.slice(0, limit).map((row) => ({
        id: row.id,
        tier: row.tier,
        archived: row.facts?.archived ?? null,
        ageDays: typeof row.facts?.ageDays === 'number' ? Math.round(row.facts.ageDays * 10) / 10 : null,
        sizeBytes: row.facts?.sizeBytes ?? null,
        dedupImageCount: row.dedupCount ?? null,
        freedBytes: row.freedByDeletingBytes ?? null,
        reasons: (row.blockingChecks ?? []).filter((check) => check.ok === false).map((check) => check.code),
      }))

      const safe = rows(report.tiers?.sessions?.safe ?? [])
      const confirm = rows(report.tiers?.sessions?.confirm ?? [])
      const danger = rows(report.tiers?.sessions?.danger ?? [])

      return {
        thresholdDays: normalized.thresholdDays,
        scannedAt: report.generatedAt ?? new Date().toISOString(),
        scanGeneration: report.scanCount ?? null,
        home: describeLayout?.()?.homeDisplay ?? null,
        counts: {
          sessions: report.totals?.sessionCount ?? 0,
          families: report.totals?.familyCount ?? 0,
          attachments: report.totals?.dedupAttachmentCount ?? 0,
        },
        reclaimableBytes: report.totals?.totalReclaimableBytes ?? 0,
        quarantineBytes: report.quarantineBytes ?? 0,
        byTier: {
          sessions: report.totals?.tiers?.sessions ?? {},
          attachments: report.totals?.tiers?.attachments ?? {},
          caches: report.totals?.tiers?.caches ?? {},
        },
        safeSessions: tier === 'all' || tier === 'safe' ? safe : [],
        confirmSessions: tier === 'all' || tier === 'confirm' ? confirm : [],
        dangerSessions: tier === 'danger' ? danger : [],
        warnings,
        cannotDelete:
          'READ-ONLY: nothing was changed and nothing can be removed through this tool. If the user wants ' +
          'something deleted, tell them to do it in the settings interface, where the evidence is shown and ' +
          'the deletion goes to a recoverable quarantine.',
      }
    },
  }
}

/**
 * Register the tool on a context, if the deployment has a tools service.
 *
 * @returns {{ registered: boolean, reason: string|null, name: string }}
 */
export function registerAuditTool(ctx, tool) {
  let tools
  try {
    tools = ctx?.get?.('tools')
  } catch (cause) {
    return { registered: false, reason: `ctx.get("tools") threw ${describeCause(cause)}`, name: TOOL_NAME }
  }
  if (tools === null || tools === undefined) {
    return {
      registered: false,
      reason:
        'this deployment exposes no tools service, so the read-only audit tool is not registered; the audit ' +
        'data remains available over the /api/dsh-reclaim/* routes',
      name: TOOL_NAME,
    }
  }
  if (typeof tools.register !== 'function') {
    return { registered: false, reason: 'the tools service does not implement register()', name: TOOL_NAME }
  }
  try {
    tools.register(tool)
    return { registered: true, reason: null, name: TOOL_NAME }
  } catch (cause) {
    return { registered: false, reason: `tools.register() threw ${describeCause(cause)}`, name: TOOL_NAME }
  }
}
