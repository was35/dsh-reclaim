/**
 * dsh-reclaim — the session table.
 *
 * One row per logical session answering: who is it, how big, when was it
 * touched, is it alive, is it archived, who is its parent / children, and which
 * workspaces claim it.
 *
 * Sources, all seams (no disk decoding, no log parsing in this module):
 *
 *   | what                        | from                                        |
 *   |-----------------------------|---------------------------------------------|
 *   | id / createdAt / cwd /      | `sessionQuery.listSessions()` → SessionRecord |
 *   | parent / origin / isSeeded  |                                             |
 *   | bytes / event count         | `sessionPersistence.list()`                 |
 *   | title                       | `sessionQuery.readTitleSnapshots(ids)`       |
 *   | archive set / workspaces    | `workspaceRegistry.list()`                  |
 *   | liveness                    | `lib/liveness.js` (the single entry point)   |
 *   | last activity (optional)    | `sessionController.list()`                   |
 *
 * Three honesty rules this module enforces:
 *
 *   1. **A missing service is reported as unavailable, never as empty.** If the
 *      core listing seam cannot be read, the report says so and carries no rows
 *      — it does not claim "zero sessions".
 *   2. **A missing number stays unknown.** `sizeBytes` / `eventCount` are
 *      optional on the persistence snapshot; absent means `null` plus a count in
 *      the summary. They are never filled with `0`, which would read as "empty"
 *      and understate what a deletion frees.
 *   3. **The live bit is not cached into a decision.** `SessionRecord.live` and
 *      the liveness probe are two reads at two moments, so they may legitimately
 *      differ; a difference is recorded as drift, and the liveness probe is the
 *      one that matters at the moment of use.
 *
 * Read-only: service calls only.
 */

import { livenessFor } from './liveness.js'

function describeCause(cause) {
  if (cause === null || cause === undefined) return String(cause)
  const name = cause.name ?? 'Error'
  const message = cause.message ?? String(cause)
  const code = cause.code === undefined ? '' : ` (code ${String(cause.code)})`
  return `${name}: ${message}${code}`
}

/**
 * Look up one optional service by name. `ctx.get` is used on purpose instead of
 * `inject`: declaring these services would stop the whole plugin from loading in
 * a deployment that omits one, when the correct behavior is to degrade and say
 * why.
 */
function probeService(ctx, key, methods) {
  const result = { key, service: null, available: false, reason: null }
  try {
    const service = ctx.get(key)
    if (service === null || service === undefined) {
      result.reason = `ctx.get("${key}") returned undefined (service not mounted)`
      return result
    }
    for (const method of methods) {
      if (typeof service[method] !== 'function') {
        result.reason = `the ${key} service does not implement ${method}()`
        return result
      }
    }
    result.service = service
    result.available = true
    return result
  } catch (cause) {
    result.reason = `ctx.get("${key}") threw ${describeCause(cause)}`
    return result
  }
}

/** Step 1 — the core listing seam. Without it there is no table at all. */
async function readCoreRecords(ctx) {
  const probe = probeService(ctx, 'sessionQuery', ['listSessions'])
  if (!probe.available) return { available: false, records: [], reason: probe.reason }

  try {
    const records = await probe.service.listSessions()
    if (!Array.isArray(records)) {
      return { available: false, records: [], reason: 'listSessions() did not return an array' }
    }
    return { available: true, records, reason: null }
  } catch (cause) {
    return { available: false, records: [], reason: `listSessions() threw ${describeCause(cause)}` }
  }
}

/** Step 2 — bytes and event counts, keyed by session id. */
async function readPersistence(ctx) {
  const result = {
    available: false,
    reason: null,
    byId: new Map(),
    listedIds: [],
    withoutSize: [],
    withoutEventCount: [],
  }
  const probe = probeService(ctx, 'sessionPersistence', ['list'])
  if (!probe.available) {
    result.reason = probe.reason
    return result
  }

  try {
    const snapshots = await probe.service.list()
    if (!Array.isArray(snapshots)) {
      result.reason = 'sessionPersistence.list() did not return an array'
      return result
    }
    for (const snapshot of snapshots) {
      const id = snapshot?.header?.id
      if (typeof id !== 'string') continue
      result.listedIds.push(id)
      result.byId.set(id, snapshot)
      if (typeof snapshot.sizeBytes !== 'number') result.withoutSize.push(id)
      if (typeof snapshot.eventCount !== 'number') result.withoutEventCount.push(id)
    }
    result.available = true
    return result
  } catch (cause) {
    result.reason = `sessionPersistence.list() threw ${describeCause(cause)}`
    return result
  }
}

/**
 * Step 3 — workspaces and the archive set.
 *
 * The archive set is **registry-global**: it is a getter on the registry
 * (`ctx.workspaceRegistry.archivedSessionIds`, "sessions hidden from every
 * grouping surface"), NOT a property of a workspace entity. Reading it off each
 * entity yields `undefined`, and treating that as `[]` would report "nothing is
 * archived" — a wrong answer in the dangerous direction. So the archive set has
 * its own availability: unreadable means unknown, per session.
 *
 * The set is read-only on this seam: the official package exposes no unarchive
 * operation, so an id can stay in it after its session is gone. That dangling-id
 * case is reported, not fixed.
 */
function readWorkspaces(ctx) {
  const result = {
    available: false,
    reason: null,
    workspaces: [],
    bySessionId: new Map(),
    archivedIds: [],
    archiveAvailable: false,
    archiveReason: null,
    danglingArchivedIds: [],
  }
  const probe = probeService(ctx, 'workspaceRegistry', ['list'])
  if (!probe.available) {
    result.reason = probe.reason
    result.archiveReason = probe.reason
    return result
  }

  // The registry-global archive set.
  try {
    const archived = probe.service.archivedSessionIds
    if (Array.isArray(archived)) {
      result.archivedIds = [...archived]
      result.archiveAvailable = true
    } else {
      result.archiveReason =
        'workspaceRegistry.archivedSessionIds is not an array — note the archive set lives on the ' +
        'REGISTRY, not on a workspace entity; archive state stays unknown'
    }
  } catch (cause) {
    result.archiveReason = `reading workspaceRegistry.archivedSessionIds threw ${describeCause(cause)}`
  }

  let workspaces
  try {
    workspaces = probe.service.list()
  } catch (cause) {
    result.reason = `workspaceRegistry.list() threw ${describeCause(cause)}`
    return result
  }
  if (!Array.isArray(workspaces)) {
    result.reason = 'workspaceRegistry.list() did not return an array'
    return result
  }

  for (const workspace of workspaces) {
    const id = workspace?.id ?? null
    let sessionIds = []
    try {
      sessionIds = [...(workspace.sessionIds ?? [])]
    } catch (cause) {
      result.reason = result.reason ?? `reading Workspace.sessionIds threw ${describeCause(cause)}`
    }

    result.workspaces.push({ id, sessionCount: sessionIds.length })
    for (const sessionId of sessionIds) {
      if (!result.bySessionId.has(sessionId)) result.bySessionId.set(sessionId, [])
      result.bySessionId.get(sessionId).push(id)
    }
  }

  result.available = true
  return result
}

/**
 * What the host's projection cache holds for one row, if it holds anything.
 *
 * Three states, and the difference between them is the entire reason this function exists:
 *
 *   - `null` — no usable projection. Either the row carried none at all (no cache row, the
 *     cache refused to answer, the id was not in the host's list), or it carried one whose
 *     `title` unit is missing/undefined. Both mean UNKNOWN, and the caller must fall back to
 *     reading the log. Undefined is not "no title": a row exists but this unit has no value.
 *   - `{ title: null, ... }` — the cache answered, and this session has produced no title yet.
 *     That is a known fact, distinct from unknown, and it needs no log read.
 *   - `{ title: '…', ... }` — a title. The host guarantees this is never empty and never
 *     wrong, only possibly stale ("as stale as the last durable checkpoint": the write path
 *     is a throttled write-behind and the log is flushed before the row is written, so the
 *     cache can lag but never lead).
 *
 * No timestamp is carried across on purpose. The only version field a projection row has is
 * `asOfSeq` — the lowest session-log sequence number among the rows it was served from — and
 * it is a position in a log, not a clock. Rendering it as a time, or filling in "now", would
 * be a confident answer about something nobody measured.
 */
function readProjection(projections) {
  if (projections === null || typeof projections !== 'object') return null
  const values = projections.values
  if (values === null || typeof values !== 'object') return null
  const title = values.title
  if (title !== null && (typeof title !== 'string' || title.length === 0)) return null
  return {
    title,
    kind: typeof projections.kind === 'string' ? projections.kind : null,
    asOfSeq: typeof projections.asOfSeq === 'number' ? projections.asOfSeq : null,
  }
}

/**
 * Step 4 — titles: the host's projection cache first, the log fold only for what it cannot answer.
 *
 * The log fold is honest but it is the expensive read in this table: it materializes the
 * complete event array of every session log (to find the last `session/title` event), so it
 * costs one full read of every byte on disk. The host already maintains the same titles in
 * its projection cache and already puts them on the list this plugin calls for last-activity,
 * so for any session that cache can answer we take its answer and read nothing.
 *
 * What cannot be answered that way is folded exactly as before: a session whose projection is
 * absent or whose title unit has no value, and — whether or not that is a problem today — a
 * cold session the host's list omits outright (it skips headers with no `cwd`). Neither case
 * is allowed to become "no title": it stays unknown until a log says otherwise.
 *
 * `titleSource` is the log fold's provenance (`user` / `provider` / `fallback`) and the cache
 * cannot supply it, so a cache-served row reports `titleSource: null` — unknown, truthfully.
 * `titleFrom` is the new field that says which of the two seams actually answered, so a reader
 * can tell "this title is as fresh as the last checkpoint" from "this title was read from the
 * log just now" without guessing from a null.
 */
async function readTitles(ctx, ids, activity) {
  const result = {
    available: false,
    reason: null,
    byId: new Map(),
    failures: [],
    requested: ids.length,
    returned: 0,
    projection: { available: false, served: 0 },
    folded: { available: false, requested: 0, returned: 0, reason: null },
  }

  const unresolved = []
  for (const id of ids) {
    const projection = activity.byId.get(id)?.projection ?? null
    if (projection === null) {
      unresolved.push(id)
      continue
    }
    result.byId.set(id, {
      title: projection.title,
      updatedAt: null,
      source: null,
      from: projection.kind === 'sequenced' ? 'live-projection' : 'projection-cache',
      asOfSeq: projection.asOfSeq,
    })
    result.projection.served += 1
  }
  result.projection.available = result.projection.served > 0

  const folded = await foldTitles(ctx, unresolved)
  result.folded = {
    available: folded.available,
    requested: unresolved.length,
    returned: folded.returned,
    reason: folded.reason,
  }
  for (const [id, value] of folded.byId) result.byId.set(id, value)
  result.failures = folded.failures
  result.returned = result.byId.size
  // `available` answers one question — does this table know the title of everything it asked
  // about? — and it stays true when nothing needed folding at all.
  result.available = folded.available
  result.reason = folded.available ? null : folded.reason
  return result
}

/**
 * The log fold: one batch call to `sessionQuery.readTitleSnapshots`, tolerant per id.
 *
 * The seam documents "one fulfilled or rejected result per unique requested id"; that per-id
 * isolation is preserved here rather than rethrown, because a single unreadable log must not
 * blank out the whole table. A batch-level failure is also caught: the table keeps its ids and
 * sizes and simply reports titles as unavailable.
 */
async function foldTitles(ctx, ids) {
  const result = { available: false, reason: null, byId: new Map(), failures: [], returned: 0 }
  if (ids.length === 0) {
    // Nothing needed the fold. That is a complete answer, not a missing one.
    result.available = true
    return result
  }
  const probe = probeService(ctx, 'sessionQuery', ['readTitleSnapshots'])
  if (!probe.available) {
    result.reason = probe.reason
    return result
  }

  let observations
  try {
    observations = await probe.service.readTitleSnapshots([...ids])
  } catch (cause) {
    result.reason = `readTitleSnapshots() threw for the whole batch ${describeCause(cause)}`
    return result
  }
  if (!Array.isArray(observations)) {
    result.reason = 'readTitleSnapshots() did not return an array'
    return result
  }

  result.available = true
  result.returned = observations.length
  for (const observation of observations) {
    if (observation?.status === 'fulfilled') {
      const snapshot = observation.value?.title
      result.byId.set(observation.sessionId, {
        title: typeof snapshot?.title === 'string' ? snapshot.title : null,
        updatedAt: typeof snapshot?.updatedAt === 'number' ? snapshot.updatedAt : null,
        source: snapshot?.source?.kind ?? null,
        from: 'log-fold',
        asOfSeq: null,
      })
    } else {
      result.failures.push({
        sessionId: observation?.sessionId ?? null,
        reason: describeCause(observation?.reason),
      })
    }
  }
  return result
}

/**
 * Step 5 — the host's activity summary, and with it the projection cache.
 *
 * The session header carries `createdAt` only; "when was it last touched" is not
 * on any cheap core seam. The host's session controller exposes an
 * activity-ordered summary list, which is exactly the right fact — but it is a
 * UI-layer service that a headless deployment may not mount, so it is strictly
 * optional: absent or failing yields `null` with the reason, never a guess and
 * never an expensive log read (that belongs to a later stage).
 *
 * The same list carries each row's projection values, including the title, and that is why
 * this runs BEFORE the title step: the titles step prefers those over re-reading every log.
 * It does not make this seam load-bearing — when it is missing, every title is simply folded
 * from the log, exactly as it was before.
 */
async function readActivity(ctx) {
  const result = { available: false, reason: null, source: 'sessionController.list', byId: new Map() }
  const probe = probeService(ctx, 'sessionController', ['list'])
  if (!probe.available) {
    result.reason = `${probe.reason}; last-activity is reported as unknown rather than read from the logs`
    return result
  }

  try {
    const value = await probe.service.list({}, new AbortController().signal)
    const items = value?.items
    if (!Array.isArray(items)) {
      result.reason = 'sessionController.list() did not return an items array'
      return result
    }
    for (const item of items) {
      if (typeof item?.sessionId !== 'string') continue
      result.byId.set(item.sessionId, {
        updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : null,
        running: typeof item.running === 'boolean' ? item.running : null,
        blank: typeof item.blank === 'boolean' ? item.blank : null,
        projection: readProjection(item.projections),
      })
    }
    result.available = true
    return result
  } catch (cause) {
    result.reason = `sessionController.list() threw ${describeCause(cause)}`
    return result
  }
}

function indexChildren(records) {
  const childrenOf = new Map()
  for (const record of records) {
    const parent = record?.header?.parentSession
    if (typeof parent !== 'string') continue
    if (!childrenOf.has(parent)) childrenOf.set(parent, [])
    childrenOf.get(parent).push(record.header.id)
  }
  for (const list of childrenOf.values()) list.sort()
  return childrenOf
}

/**
 * Build the session table.
 *
 * @param {object} ctx
 * @param {object} [options]
 * @param {number} [options.maxActivityEntries] - unused today; reserved so the
 *   report shape does not change when the activity list grows bounds
 * @returns {Promise<object>} JSON-serializable report
 */
export async function listSessions(ctx, options = {}) {
  void options
  const generatedAt = new Date().toISOString()
  const notes = []

  const core = await readCoreRecords(ctx)
  const sources = {
    sessionQuery: core.available ? 'available' : `unavailable: ${core.reason}`,
  }

  if (!core.available) {
    notes.push(
      'the core session listing seam could not be read, so NO rows are reported; this is ' +
        '"unknown", not "there are no sessions"',
    )
    return {
      ok: false,
      generatedAt,
      available: false,
      reason: core.reason,
      sources,
      sessions: [],
      titles: {
        available: false,
        requested: 0,
        returned: 0,
        failures: [],
        reason: core.reason,
        projection: { available: false, served: 0 },
        folded: { available: false, requested: 0, returned: 0, reason: core.reason },
      },
      archived: { available: false, ids: [], danglingIds: [], reason: core.reason },
      workspaces: { available: false, count: 0, list: [], reason: core.reason },
      bytes: { available: false, total: null, knownCount: 0, unknownCount: 0, unknownIds: [], reason: core.reason },
      liveness: { available: false, counts: {}, unknownReason: core.reason },
      activity: { available: false, source: 'sessionController.list', reason: core.reason },
      summary: { total: null, live: null, running: null, archived: null },
      notes,
    }
  }

  const records = core.records
  const ids = records.map((record) => record.header.id)
  const idSet = new Set(ids)

  const persistence = await readPersistence(ctx)
  sources.sessionPersistence = persistence.available ? 'available' : `unavailable: ${persistence.reason}`
  const workspaces = readWorkspaces(ctx)
  sources.workspaceRegistry = workspaces.available ? 'available' : `unavailable: ${workspaces.reason}`
  // Activity before titles: the host's list is the cheap read (projections live in memory),
  // and the title step uses it to avoid the expensive one — a full read of every session log.
  const activity = await readActivity(ctx)
  sources.sessionController = activity.available ? 'available' : `unavailable: ${activity.reason}`
  const titles = await readTitles(ctx, ids, activity)
  sources.sessionQueryTitles = titles.available ? 'available' : `unavailable: ${titles.reason}`
  sources.sessionTitles = titles.projection.served > 0
    ? `projection cache: ${titles.projection.served} served, ${titles.folded.requested} folded from the logs`
    : `log fold: ${titles.folded.requested} requested`
  const liveness = livenessFor(ctx, ids)
  sources.liveness = 'available'

  const childrenOf = indexChildren(records)

  const sessions = []
  const livenessCounts = {}
  let totalBytes = 0
  let bytesKnown = 0
  const bytesUnknownIds = []
  let archivedCount = 0
  let liveCount = 0
  let runningCount = 0
  let titleCount = 0
  let driftCount = 0
  let persistedCount = 0

  for (const record of records) {
    const header = record.header
    const id = header.id
    const snapshot = persistence.byId.get(id)
    const sizeBytes = typeof snapshot?.sizeBytes === 'number' ? snapshot.sizeBytes : null
    const eventCount = typeof snapshot?.eventCount === 'number' ? snapshot.eventCount : null
    if (sizeBytes === null) {
      bytesUnknownIds.push(id)
    } else {
      totalBytes += sizeBytes
      bytesKnown += 1
    }

    const title = titles.byId.get(id) ?? null
    if (title?.title != null) titleCount += 1

    // Unknown must never look like "no". With the workspace seam unreadable we
    // do not know whether this session is archived or in a workspace, so both
    // fields are null rather than a confident false / empty list. The archive
    // set has its own availability: it is a registry-global getter that can be
    // missing even while `list()` works.
    const workspaceIds = workspaces.available ? (workspaces.bySessionId.get(id) ?? []) : null
    const archived = workspaces.archiveAvailable ? workspaces.archivedIds.includes(id) : null
    if (archived === true) archivedCount += 1

    const recordLive = typeof record.live === 'boolean' ? record.live : null
    const recordPersisted = typeof record.persisted === 'boolean' ? record.persisted : null
    if (recordLive === true) liveCount += 1
    if (recordPersisted === true) persistedCount += 1

    const live = liveness.get(id)
    const state = live?.state ?? 'unknown'
    livenessCounts[state] = (livenessCounts[state] ?? 0) + 1
    if (state === 'running') runningCount += 1

    // Two reads at two moments: a difference is drift, not a contradiction.
    const liveSignalDrift = recordLive !== null && live?.live !== null && recordLive !== live?.live
    if (liveSignalDrift) driftCount += 1

    const activityEntry = activity.byId.get(id) ?? null

    sessions.push({
      id,
      title: title?.title ?? null,
      titleSource: title?.source ?? null,
      // Which seam answered this title: the host's projection cache (as fresh as the last
      // durable checkpoint, no timestamp) or a log fold read just now. `titleSource` cannot
      // say — the cache does not carry provenance — so a null alone would be ambiguous.
      titleFrom: title?.from ?? null,
      // A log sequence number, NOT a time. Never render it as one.
      titleAsOfSeq: title?.asOfSeq ?? null,
      titleUpdatedAt: title?.updatedAt ?? null,
      cwd: header.cwd ?? null,
      createdAt: typeof header.createdAt === 'number' ? header.createdAt : null,
      // `createdAt` is authoritative; last activity is a separate, optional fact.
      lastActivity: activityEntry?.updatedAt ?? null,
      lastActivitySource: activityEntry?.updatedAt != null ? activity.source : null,
      sizeBytes,
      eventCount,
      sizeSource: sizeBytes === null ? null : 'sessionPersistence.list().sizeBytes',
      persisted: recordPersisted,
      live: recordLive,
      running: live?.running ?? null,
      runningSource: activityEntry?.running != null ? 'sessionController.list().running' : null,
      liveness: { state, reason: live?.reason ?? null, message: live?.message ?? null },
      liveSignalDrift,
      archived,
      workspaceIds,
      parentSession: header.parentSession ?? null,
      origin: header.origin ?? null,
      delegationDepth: typeof header.delegationDepth === 'number' ? header.delegationDepth : header.delegationDepth ?? null,
      isSeeded: header.isSeeded === true,
      childSessions: childrenOf.get(id) ?? [],
    })
  }

  sessions.sort((left, right) => (right.lastActivity ?? right.createdAt ?? 0) - (left.lastActivity ?? left.createdAt ?? 0))

  const persistedNotListed = persistence.available
    ? persistence.listedIds.filter((id) => !idSet.has(id))
    : []
  if (persistedNotListed.length > 0) {
    notes.push(
      `${persistedNotListed.length} persisted session id(s) are listed by sessionPersistence but not by ` +
        'sessionQuery.listSessions(); they are reported here as evidence and get no row',
    )
  }

  const storedArchived = workspaces.archivedIds
  const danglingArchivedIds = workspaces.archiveAvailable
    ? storedArchived.filter((id) => !idSet.has(id))
    : []
  if (!workspaces.archiveAvailable) {
    notes.push(
      `the registry-global archive set could not be read (${workspaces.archiveReason}), so archive state is ` +
        'unknown for every session; it is NOT reported as "not archived"',
    )
  } else if (danglingArchivedIds.length > 0) {
    notes.push(
      `${danglingArchivedIds.length} archived session id(s) are not in the current listing. The official API ` +
        'has no unarchive operation, so these ids stay in archivedSessionIds; reported, never repaired',
    )
  }
  const sessionsInNoWorkspace = workspaces.available
    ? sessions.filter((row) => row.workspaceIds !== null && row.workspaceIds.length === 0).map((row) => row.id)
    : []
  if (sessionsInNoWorkspace.length > 0) {
    notes.push(
      `${sessionsInNoWorkspace.length} session(s) belong to no registered workspace; grouping surfaces may still ` +
        'show them, so this is reported rather than treated as an error',
    )
  }
  if (!persistence.available) {
    notes.push('byte sizes are unavailable for every session (no sessionPersistence listing)')
  } else if (bytesUnknownIds.length > 0) {
    notes.push(
      `${bytesUnknownIds.length} session(s) have no sizeBytes from the persistence snapshot; they are reported ` +
        'as unknown, NOT as 0',
    )
  }
  if (titles.failures.length > 0) {
    notes.push(`${titles.failures.length} title read(s) failed and are isolated per session; those titles are unknown`)
  }
  if (titles.projection.served > 0) {
    notes.push(
      `${titles.projection.served} title(s) come from the host's projection cache rather than from the logs: they ` +
        'are as fresh as the last durable checkpoint (the cache is written behind the log, so it can lag but not ' +
        'lead) and carry no timestamp, so those rows report titleUpdatedAt null and titleSource null',
    )
  }
  if (driftCount > 0) {
    notes.push(
      `${driftCount} session(s) show liveSignalDrift: the listing's live bit and the liveness probe disagreed. ` +
        'They are two reads at two moments, so this is expected drift — the liveness probe is the one that matters ' +
        'at the moment of use',
    )
  }
  if (!workspaces.available) {
    notes.push('the workspace/archive seam is unavailable, so archive state is unknown for every session')
  }

  return {
    ok: true,
    generatedAt,
    available: true,
    sources,
    sessions,
    titles: {
      available: titles.available,
      requested: titles.requested,
      returned: titles.returned,
      failures: titles.failures,
      reason: titles.reason,
      // The split is reported because "titles are available" no longer implies "every log
      // was read": a cache-served row has no `titleUpdatedAt` and no `titleSource`, and that
      // has to be visible somewhere other than in a null on a row.
      projection: { available: titles.projection.available, served: titles.projection.served },
      folded: {
        available: titles.folded.available,
        requested: titles.folded.requested,
        returned: titles.folded.returned,
        reason: titles.folded.reason,
      },
    },
    archived: {
      available: workspaces.archiveAvailable,
      ids: storedArchived,
      count: workspaces.archiveAvailable ? storedArchived.length : null,
      danglingIds: danglingArchivedIds,
      reason: workspaces.archiveReason,
    },
    workspaces: {
      available: workspaces.available,
      count: workspaces.workspaces.length,
      list: workspaces.workspaces,
      sessionsInNoWorkspace,
      reason: workspaces.reason,
    },
    bytes: {
      available: persistence.available,
      total: persistence.available ? totalBytes : null,
      knownCount: bytesKnown,
      unknownCount: bytesUnknownIds.length,
      unknownIds: bytesUnknownIds,
      withoutEventCount: persistence.withoutEventCount,
      persistedNotListed,
      reason: persistence.reason,
    },
    liveness: {
      available: true,
      counts: livenessCounts,
      dangerousStates: ['running', 'idle-live', 'unknown'],
    },
    activity: {
      available: activity.available,
      source: activity.source,
      reason: activity.reason,
      count: activity.byId.size,
    },
    summary: {
      total: sessions.length,
      live: liveCount,
      running: runningCount,
      persisted: persistedCount,
      archived: workspaces.archiveAvailable ? archivedCount : null,
      withTitle: titleCount,
      withoutTitle: sessions.length - titleCount,
      liveSignalDrift: driftCount,
      totalBytes: persistence.available ? totalBytes : null,
      bytesUnknownCount: bytesUnknownIds.length,
    },
    notes,
  }
}
