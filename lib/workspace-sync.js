/**
 * dsh-reclaim — keeping the host's accounting honest after a session is moved.
 *
 * Moving a session's files into the quarantine leaves two pieces of bookkeeping
 * pointing at something that is no longer there:
 *
 *   1. **The workspace's `sessionIds`.** Removed with the official
 *      `Workspace.detachSession(id)`. `workspaceRegistry.delete(id)` is NOT used
 *      and must never be: that one deletes the whole *workspace* and keeps every
 *      session log, which is the opposite of what a user asked for.
 *   2. **`archivedSessionIds`.** This one CANNOT be fixed. The official API has no
 *      unarchive operation, so an id deleted while archived stays in the archive
 *      set forever. That is a known residue with a known cost (~44 bytes per id),
 *      and this module's job is to **report** it, not to hand-edit another
 *      component's storage to make a number look tidy.
 *
 * ## Why the order is "move first, then detach"
 *
 * The workspace entity prunes, on every write, any member whose `sessionPath(id)`
 * no longer equals the record's path. So after the files have moved, a
 * `detachSession` call is belt-and-braces: it removes the id explicitly, and if
 * it were to fail the next write would prune it anyway. Doing it the other way
 * round (detach, then move) would leave accounting that claims nothing is there
 * while the files still are — and if the move then failed, the session would be
 * live but unaccounted, which is worse than either end state.
 *
 * Read/write scope: this module writes nothing itself. It calls one official
 * method and reads the result back.
 */

import { readLivenessServices } from './liveness.js'

function describeCause(cause) {
  if (cause === null || cause === undefined) return String(cause)
  const name = cause?.name ?? 'Error'
  const message = cause?.message ?? String(cause)
  const code = cause?.code === undefined ? '' : ` (code ${String(cause.code)})`
  return `${name}: ${message}${code}`
}

/** The registry seam, or a reason it is not usable. */
function readRegistry(ctx) {
  let registry
  try {
    registry = ctx?.get?.('workspaceRegistry')
  } catch (cause) {
    return { registry: null, reason: `ctx.get("workspaceRegistry") threw ${describeCause(cause)}` }
  }
  if (registry === null || registry === undefined) {
    return {
      registry: null,
      reason:
        'ctx.get("workspaceRegistry") returned undefined; the accounting cannot be read, which is UNKNOWN, ' +
        'not "no workspace accounts for this session"',
    }
  }
  if (typeof registry.list !== 'function') {
    return { registry: null, reason: 'the workspace registry does not implement list()' }
  }
  return { registry, reason: null }
}

/**
 * Find the workspaces that currently account for a session id.
 *
 * @returns {{ ok: boolean, reason: string|null, holders: object[] }}
 */
export async function findHolders(ctx, sessionId) {
  const { registry, reason } = readRegistry(ctx)
  if (registry === null) return { ok: false, reason, holders: [] }
  let workspaces
  try {
    workspaces = await registry.list()
  } catch (cause) {
    return { ok: false, reason: `workspaceRegistry.list() threw ${describeCause(cause)}`, holders: [] }
  }
  const holders = []
  for (const workspace of workspaces) {
    let ids
    try {
      ids = [...(workspace.sessionIds ?? [])]
    } catch (cause) {
      return { ok: false, reason: `reading workspace.sessionIds threw ${describeCause(cause)}`, holders: [] }
    }
    if (ids.includes(sessionId)) holders.push({ id: workspace.id, path: workspace.path, workspace })
  }
  return { ok: true, reason: null, holders }
}

/**
 * Detach a moved session from every workspace that accounts for it.
 *
 * @param {object} ctx
 * @param {string} sessionId
 * @returns {Promise<object>} a JSON-serializable accounting report
 */
export async function detachSessionAccounting(ctx, sessionId) {
  const found = await findHolders(ctx, sessionId)
  if (!found.ok) {
    return {
      ok: false,
      sessionId,
      action: 'not-attempted',
      reason: found.reason,
      before: null,
      after: null,
      holders: null,
      note:
        'the accounting could not be read, so nothing was detached. This is reported as unknown: a session ' +
        'whose accounting cannot be checked must not be described as "no longer accounted for"',
    }
  }
  const before = found.holders.map((holder) => holder.id)
  if (found.holders.length === 0) {
    return {
      ok: true,
      sessionId,
      action: 'not-needed',
      reason: null,
      before: [],
      after: [],
      holders: [],
      note: 'no workspace accounts for this session, so there was nothing to detach',
    }
  }

  const attempted = []
  for (const holder of found.holders) {
    if (typeof holder.workspace.detachSession !== 'function') {
      attempted.push({ workspaceId: holder.id, ok: false, reason: 'the workspace entity does not implement detachSession()' })
      continue
    }
    try {
      await holder.workspace.detachSession(sessionId)
      attempted.push({ workspaceId: holder.id, ok: true, reason: null })
    } catch (cause) {
      attempted.push({ workspaceId: holder.id, ok: false, reason: `detachSession() threw ${describeCause(cause)}` })
    }
  }

  // Read back rather than trusting the call's success: the point of this step is
  // the accounting's state, not our invocation of a method.
  const verified = await findHolders(ctx, sessionId)
  const after = verified.ok ? verified.holders.map((holder) => holder.id) : null
  const stillAccounted = after === null ? null : after.length > 0

  const failures = attempted.filter((entry) => entry.ok !== true)
  return {
    ok: failures.length === 0 && stillAccounted === false,
    sessionId,
    action: 'detached',
    reason: failures.length > 0
      ? `${failures.length} detach call(s) failed; the accounting after the attempt is reported below`
      : stillAccounted === true
        ? 'the session is still accounted for after detachSession(); the accounting was NOT changed'
        : null,
    before,
    after,
    stillAccounted,
    attempts: attempted,
    note:
      stillAccounted === true
        ? 'detachSession() reported no error but the id is still there; reporting the discrepancy instead of ' +
          'retrying with a different method'
        : 'the id no longer appears in any workspace',
  }
}

/**
 * The archive residue: ids the registry still holds in `archivedSessionIds`.
 *
 * Three categories, and only the third is an actual residue:
 *   - **live** — the id is still in the session listing (nothing to do);
 *   - **accounted-elsewhere** — the listing does not have it, but a workspace
 *     still names it: report, because the user is looking at a half state;
 *   - **dangling** — nothing has it any more. This is what a delete of an
 *     archived session leaves behind, and it cannot be removed through the
 *     official API. Reported, never repaired.
 *
 * @param {object} ctx
 * @param {readonly string[]} listedSessionIds
 */
export async function archivedResidue(ctx, listedSessionIds) {
  const { registry, reason } = readRegistry(ctx)
  if (registry === null) {
    return { ok: false, reason, archived: null, live: null, accountedElsewhere: null, dangling: null }
  }
  let archived
  try {
    archived = [...(registry.archivedSessionIds ?? [])]
  } catch (cause) {
    // This getter is registry-global, and reading it from an entity yields
    // `undefined` — a mistake that once produced a confident "0 archived
    // sessions" in this project. It is therefore reported as unknown, never as 0.
    return {
      ok: false,
      reason: `reading the registry-level archivedSessionIds threw ${describeCause(cause)}`,
      archived: null,
      live: null,
      accountedElsewhere: null,
      dangling: null,
    }
  }
  const listed = new Set(listedSessionIds ?? [])
  const live = archived.filter((id) => listed.has(id))
  const maybeAccounted = archived.filter((id) => !listed.has(id))
  const accounted = []
  for (const id of maybeAccounted) {
    const holders = await findHolders(ctx, id)
    if (!holders.ok) {
      return {
        ok: false,
        reason: `could not determine whether archived id ${id} is accounted for: ${holders.reason}`,
        archived: archived.length,
        live: null,
        accountedElsewhere: null,
        dangling: null,
      }
    }
    if (holders.holders.length > 0) accounted.push({ id, workspaceIds: holders.holders.map((holder) => holder.id) })
  }
  const accountedIds = new Set(accounted.map((entry) => entry.id))
  const dangling = maybeAccounted.filter((id) => !accountedIds.has(id))
  return {
    ok: true,
    reason: null,
    archived: archived.length,
    live,
    accountedElsewhere: accounted,
    dangling,
    note:
      dangling.length === 0
        ? 'no dangling archived id'
        : `${dangling.length} archived session id(s) no longer exist anywhere. The official API has no unarchive ` +
          'operation, so they cannot be removed; they are reported rather than edited out of another ' +
          "component's storage",
  }
}

/**
 * Whether a session still owns background jobs.
 *
 * `JobSnapshot.ownerSession` is a confirmed field. A session that still owns a job
 * must not be moved out from under it, so this is checked before a delete rather
 * than discovered afterwards.
 */
export function describeJobOwnership(ctx, sessionId) {
  let jobs
  try {
    jobs = ctx?.get?.('jobs')
  } catch (cause) {
    return { checked: false, reason: `ctx.get("jobs") threw ${describeCause(cause)}`, owned: null }
  }
  if (jobs === null || jobs === undefined) {
    return {
      checked: false,
      reason:
        'the jobs service is not mounted, so job ownership could not be checked. Reported as UNKNOWN: an ' +
        'unchecked ownership is not the same as "owns nothing"',
      owned: null,
    }
  }
  if (typeof jobs.list !== 'function') {
    return { checked: false, reason: 'the jobs service does not implement list()', owned: null }
  }
  try {
    const snapshots = jobs.list()
    const owned = (snapshots ?? []).filter((snapshot) => snapshot?.ownerSession === sessionId)
    return {
      checked: true,
      reason: null,
      owned: owned.length,
      jobs: owned.map((snapshot) => ({ id: snapshot.id ?? null, status: snapshot.status ?? null })),
    }
  } catch (cause) {
    return { checked: false, reason: `jobs.list() threw ${describeCause(cause)}`, owned: null }
  }
}

/** Liveness of the session store, re-exported so a delete can state what it read. */
export function accountingAvailability(ctx) {
  const services = readLivenessServices(ctx ?? { get: () => undefined })
  return {
    sessionsService: services.sessions !== null,
    sessionsServiceReason: services.sessionsUnavailableReason,
    agentsService: services.agents !== null,
    agentsServiceReason: services.agentsUnavailableReason,
  }
}
