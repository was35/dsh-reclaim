/**
 * dsh-reclaim — session reading.
 *
 * A reference graph is only as good as the read behind it, and the read is where
 * this project's riskiest failure lives: "the read succeeded and parsed nothing".
 * So this module reads each session through **two independent implementations**
 * and hands both to the coverage checks:
 *
 *   path A — `sessionQuery.observeSession(id)` → `lease.events`   (query layer)
 *   path B — `sessionPersistence.open(id, 'read')` → `handle.read()` (raw layer)
 *
 * They are different code paths, so their agreement means something; a
 * reader-side truncation (the design's "only the first frame" failure) makes them
 * disagree. On this machine the persistence snapshot carries NO `eventCount`
 * (measured: absent on both `list()` and `stat()` for all 24 sessions), so this
 * cross-check is what stands in for a stored event count, which this host does not expose.
 *
 * Both leases are released on EVERY path, including throws — the query layer
 * returns a disposable lease and the persistence layer a closeable handle, and a
 * leaked one would pin memory or ownership for the life of the host.
 *
 * Read-only: two read APIs, nothing written.
 */

function describeCause(cause) {
  if (cause === null || cause === undefined) return String(cause)
  const name = cause?.name ?? 'Error'
  const message = cause?.message ?? String(cause)
  const code = cause?.code === undefined ? '' : ` (code ${String(cause.code)})`
  return `${name}: ${message}${code}`
}

function summarizeCursor(cursor) {
  if (typeof cursor === 'number') return cursor
  // `SessionSeqCursor` is a branded number in practice; be tolerant and honest.
  if (cursor === null || cursor === undefined) return null
  const numeric = Number(cursor)
  return Number.isNaN(numeric) ? null : numeric
}

/**
 * Read one session through the query layer.
 *
 * @param {object} ctx
 * @param {string} sessionId
 * @returns {Promise<{
 *   path: 'query', ok: boolean, id: string,
 *   events: readonly object[], eventCount: number | null,
 *   cursor: number | null, inheritedEventCount: number | null,
 *   source: string | null, hasRevision: boolean,
 *   leaseReleased: boolean, error: string | null,
 *   statBefore: object | null, statAfter: object | null,
 *   revisionStable: boolean | null, ms: number,
 * }>}
 */
export async function readViaQuery(ctx, sessionId) {
  const started = Date.now()
  const result = {
    path: 'query',
    ok: false,
    id: sessionId,
    events: [],
    eventCount: null,
    cursor: null,
    inheritedEventCount: null,
    source: null,
    hasRevision: false,
    leaseReleased: false,
    error: null,
    statBefore: null,
    statAfter: null,
    revisionStable: null,
    ms: 0,
  }

  let query
  try {
    query = ctx.get('sessionQuery')
  } catch (cause) {
    result.error = `ctx.get("sessionQuery") threw ${describeCause(cause)}`
    result.ms = Date.now() - started
    return result
  }
  if (query === null || query === undefined || typeof query.observeSession !== 'function') {
    result.error = 'sessionQuery.observeSession is unavailable'
    result.ms = Date.now() - started
    return result
  }

  // Atomicity evidence: the stored revision must not move while we read. A change
  // means a writer interleaved, so this read is not one coherent cut.
  const persistence = safeGet(ctx, 'sessionPersistence')
  result.statBefore = await safeStat(persistence, sessionId)

  let lease = null
  try {
    lease = await query.observeSession(sessionId)
    result.source = typeof lease.source === 'string' ? lease.source : null
    result.hasRevision = lease.revision !== undefined
    result.events = Array.isArray(lease.events) ? lease.events : []
    result.eventCount = result.events.length
    result.cursor = summarizeCursor(lease.cursor)
    result.inheritedEventCount = summarizeCursor(lease.inheritedEventCount)
    result.ok = true
  } catch (cause) {
    result.error = describeCause(cause)
  } finally {
    try {
      if (lease !== null && typeof lease[Symbol.dispose] === 'function') {
        lease[Symbol.dispose]()
        result.leaseReleased = true
      } else if (lease !== null && typeof lease[Symbol.asyncDispose] === 'function') {
        await lease[Symbol.asyncDispose]()
        result.leaseReleased = true
      } else if (lease === null) {
        // Nothing was acquired; record it so the aggregate counter stays exact.
        result.leaseReleased = true
      }
    } catch (cause) {
      result.leaseReleased = false
      result.error = result.error ?? `releasing the observation lease threw ${describeCause(cause)}`
    }
  }

  result.statAfter = await safeStat(persistence, sessionId)
  if (result.statBefore !== null && result.statAfter !== null) {
    const before = result.statBefore.revision
    const after = result.statAfter.revision
    result.revisionStable = before === undefined || after === undefined ? null : String(before) === String(after)
  }

  result.ms = Date.now() - started
  return result
}

/**
 * Read the same session through the raw persistence handle.
 *
 * @param {object} ctx
 * @param {string} sessionId
 * @returns {Promise<{
 *   path: 'persistence', ok: boolean, id: string,
 *   events: readonly object[], eventCount: number | null,
 *   inheritedEventCount: number | null, eventState: string | null,
 *   handleClosed: boolean, error: string | null, ms: number,
 * }>}
 */
export async function readViaPersistence(ctx, sessionId) {
  const started = Date.now()
  const result = {
    path: 'persistence',
    ok: false,
    id: sessionId,
    events: [],
    eventCount: null,
    inheritedEventCount: null,
    eventState: null,
    handleAcquired: false,
    handleClosed: false,
    error: null,
    ms: 0,
  }

  const persistence = safeGet(ctx, 'sessionPersistence')
  if (persistence === null || persistence === undefined || typeof persistence.open !== 'function') {
    result.error = 'sessionPersistence.open is unavailable'
    result.ms = Date.now() - started
    return result
  }

  let handle = null
  try {
    handle = await persistence.open(sessionId, 'read')
    result.handleAcquired = true
    result.inheritedEventCount = summarizeCursor(handle.inheritedEventCount)
    const read = await handle.read()
    result.events = Array.isArray(read?.events) ? read.events : []
    result.eventCount = result.events.length
    result.eventState = read?.eventState === undefined ? null : String(read.eventState)
    result.ok = true
  } catch (cause) {
    result.error = describeCause(cause)
  } finally {
    try {
      if (handle !== null && typeof handle.close === 'function') {
        await handle.close()
        result.handleClosed = true
      } else if (handle === null) {
        result.handleClosed = true
      }
    } catch (cause) {
      result.handleClosed = false
      result.error = result.error ?? `closing the read handle threw ${describeCause(cause)}`
    }
  }

  result.ms = Date.now() - started
  return result
}

function safeGet(ctx, key) {
  try {
    return ctx.get(key)
  } catch {
    return null
  }
}

async function safeStat(persistence, sessionId) {
  if (persistence === null || persistence === undefined || typeof persistence.stat !== 'function') return null
  try {
    const snapshot = await persistence.stat(sessionId)
    if (snapshot === undefined || snapshot === null) return null
    return {
      hasEventCount: typeof snapshot.eventCount === 'number',
      hasSizeBytes: typeof snapshot.sizeBytes === 'number',
      sizeBytes: typeof snapshot.sizeBytes === 'number' ? snapshot.sizeBytes : null,
      revision: snapshot.revision,
    }
  } catch {
    return null
  }
}

/** Availability of everything a proven read needs. */
export function readServices(ctx) {
  const query = safeGet(ctx, 'sessionQuery')
  const persistence = safeGet(ctx, 'sessionPersistence')
  const sessions = safeGet(ctx, 'sessions')
  return {
    sessionQuery: query !== null && query !== undefined,
    observeSession: typeof query?.observeSession === 'function',
    sessionPersistence: persistence !== null && persistence !== undefined,
    open: typeof persistence?.open === 'function',
    stat: typeof persistence?.stat === 'function',
    sessions: sessions !== null && sessions !== undefined,
  }
}

export { summarizeCursor }
