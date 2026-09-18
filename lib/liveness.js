/**
 * dsh-reclaim — the ONE place that decides whether a session is alive.
 *
 * Every consumer (the session table, risk grading, and later the moment of
 * deletion) must call this module instead of assembling its own test. The
 * rules are not stylistic — they come from a live-session experiment that
 * measured the real lifecycle:
 *
 *   1. **Alive means `ctx.sessions.get(id) !== undefined`.** That is the only
 *      precise "is loaded in this process" test. It is not `SessionSummary.running`.
 *   2. **`running` means the Agent is mid-turn.** It is measured as
 *      `agents.get(id)?.status === 'running'`, and it is NOT a liveness test:
 *      a session that is loaded and waiting for input is indistinguishable from
 *      a cold session under `running` alone. It is the danger tier's UNION
 *      condition, not the liveness gate.
 *   3. **A missing service yields `unknown`, never "nothing is alive".**
 *      `ctx.get('sessions')` genuinely returns `undefined` while the host is
 *      being torn down. Defaulting that to the empty set would classify live
 *      sessions as deletable exactly at shutdown — the worst possible moment.
 *
 * Two further conservatisms, both from the same experiment:
 *
 *   - The `running` window can be as short as ~117ms, so any polled snapshot
 *     misses it. Liveness must be re-read at the moment of use; the caller's
 *     snapshot is display-only. This module is cheap and side-effect free so
 *     that re-reading is always the easy option.
 *   - If the two probes disagree (an Agent reports `running` for an id the
 *     session store does not know), that is not a state to guess about: it is
 *     reported as `unknown`.
 *
 * Read-only: two service lookups. Nothing is mutated.
 */

/**
 * Liveness states.
 *
 * - `running`    — loaded AND the Agent is mid-turn.
 * - `idle-live`  — loaded but not mid-turn (waiting for input, or between turns).
 * - `not-live`   — not loaded in this process.
 * - `unknown`    — could not be determined; must be treated as dangerous.
 */
export const LIVENESS_STATES = Object.freeze(['running', 'idle-live', 'not-live', 'unknown'])

/** States that must block destructive operations. */
export const DANGEROUS_LIVENESS_STATES = Object.freeze(['running', 'idle-live', 'unknown'])

function describeCause(cause) {
  if (cause === null || cause === undefined) return String(cause)
  const name = cause.name ?? 'Error'
  const message = cause.message ?? String(cause)
  const code = cause.code === undefined ? '' : ` (code ${String(cause.code)})`
  return `${name}: ${message}${code}`
}

/**
 * Read the two services once for a batch of ids.
 *
 * @param {object} ctx - the plugin context
 * @returns {{
 *   sessions: object | null,
 *   sessionsUnavailableReason: string | null,
 *   agents: object | null,
 *   agentsUnavailableReason: string | null,
 * }}
 */
export function readLivenessServices(ctx) {
  const result = {
    sessions: null,
    sessionsUnavailableReason: null,
    agents: null,
    agentsUnavailableReason: null,
  }

  try {
    const sessions = ctx.get('sessions')
    if (sessions === null || sessions === undefined) {
      result.sessionsUnavailableReason =
        'ctx.get("sessions") returned undefined (the service is not mounted, or the host is being torn down)'
    } else if (typeof sessions.get !== 'function') {
      result.sessionsUnavailableReason = 'the sessions service does not implement get()'
    } else {
      result.sessions = sessions
    }
  } catch (cause) {
    result.sessionsUnavailableReason = `ctx.get("sessions") threw ${describeCause(cause)}`
  }

  try {
    const agents = ctx.get('agents')
    if (agents === null || agents === undefined) {
      // Not fatal on its own: `running` becomes unknown, `live` is still exact.
      result.agentsUnavailableReason =
        'ctx.get("agents") returned undefined, so the mid-turn signal is unavailable'
    } else if (typeof agents.get !== 'function') {
      result.agentsUnavailableReason = 'the agents service does not implement get()'
    } else {
      result.agents = agents
    }
  } catch (cause) {
    result.agentsUnavailableReason = `ctx.get("agents") threw ${describeCause(cause)}`
  }

  return result
}

/**
 * Probe one id against already-read services. Prefer {@link livenessFor} for
 * batches; this exists for the "re-read at the moment of use" call site.
 *
 * @param {ReturnType<typeof readLivenessServices>} services
 * @param {string} sessionId
 * @returns {{
 *   sessionId: string,
 *   state: string,
 *   live: boolean | null,
 *   running: boolean | null,
 *   reason: string | null,
 *   message: string | null,
 *   evidence: object,
 * }}
 */
export function classifyLiveness(services, sessionId) {
  const evidence = {
    sessionsService: services.sessions === null ? 'unavailable' : 'available',
    agentsService: services.agents === null ? 'unavailable' : 'available',
    sessionsUnavailableReason: services.sessionsUnavailableReason,
    agentsUnavailableReason: services.agentsUnavailableReason,
  }

  if (services.sessions === null) {
    return {
      sessionId,
      state: 'unknown',
      live: null,
      running: null,
      reason: 'sessions-service-unavailable',
      message: services.sessionsUnavailableReason,
      evidence,
    }
  }

  let live
  try {
    live = services.sessions.get(sessionId) !== undefined
  } catch (cause) {
    return {
      sessionId,
      state: 'unknown',
      live: null,
      running: null,
      reason: 'sessions-get-threw',
      message: `${describeCause(cause)}`,
      evidence,
    }
  }

  let running = null
  let midTurnMessage = null
  if (services.agents !== null) {
    try {
      const agent = services.agents.get(sessionId)
      const status = agent?.status
      running = status === 'running'
      if (status !== undefined && status !== 'running' && status !== 'idle') {
        running = null
        midTurnMessage = `the agent reports an unrecognized status ${JSON.stringify(status)}`
      }
    } catch (cause) {
      running = null
      midTurnMessage = `agents.get() threw ${describeCause(cause)}`
    }
  } else {
    midTurnMessage = services.agentsUnavailableReason
  }

  // Two probes disagreeing is not a state to guess about.
  if (!live && running === true) {
    return {
      sessionId,
      state: 'unknown',
      live,
      running,
      reason: 'probes-disagree',
      message:
        'the agent reports mid-turn while the session store does not know this id; ' +
        'refusing to pick one probe as the truth',
      evidence,
    }
  }

  if (!live) {
    // A cold session has no agent, so `running` is false by construction. If
    // the mid-turn probe was unavailable, say so rather than implying proof.
    return {
      sessionId,
      state: 'not-live',
      live,
      running: running === null ? false : running,
      reason: null,
      message: null,
      evidence,
    }
  }

  if (running === true) {
    return { sessionId, state: 'running', live, running, reason: null, message: null, evidence }
  }

  // Loaded and not mid-turn. When the mid-turn probe was unavailable the state
  // is still idle-live (the session is loaded either way, which is what blocks
  // deletion), but the uncertainty is carried in `message`.
  return {
    sessionId,
    state: 'idle-live',
    live,
    running: false,
    reason: running === null ? 'mid-turn-signal-unavailable' : null,
    message: running === null ? midTurnMessage : null,
    evidence,
  }
}

/**
 * The batch entry point: read the services once, classify every id.
 *
 * @param {object} ctx
 * @param {readonly string[]} sessionIds
 * @returns {Map<string, object>}
 */
export function livenessFor(ctx, sessionIds) {
  const services = readLivenessServices(ctx)
  const byId = new Map()
  for (const sessionId of sessionIds) {
    byId.set(sessionId, classifyLiveness(services, sessionId))
  }
  return byId
}

/**
 * Liveness for a single id, reading the services now. This is the call every
 * mutating path must use at the moment of use, never a value cached earlier.
 *
 * @param {object} ctx
 * @param {string} sessionId
 * @returns {object}
 */
export function livenessOf(ctx, sessionId) {
  return classifyLiveness(readLivenessServices(ctx), sessionId)
}

/** True when a state must block a destructive operation. */
export function isDangerousLiveness(state) {
  return DANGEROUS_LIVENESS_STATES.includes(state)
}
