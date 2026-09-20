/**
 * dsh-reclaim — reference graph assembly.
 *
 * Turns the per-session reads into the two graphs everything downstream needs:
 *
 *   attachment ← session   (which sessions reference which stored objects)
 *   session  ←→ session    (structured `@session` edges)
 *
 * and, just as importantly, carries the coverage verdict into a single gate:
 *
 *   **if ANY session's relations could not be proven complete, the orphan
 *   determination is paused for the whole scan.** Not "paused for that session" —
 *   that session's attachments might be referenced only from the unreadable part,
 *   and the design's rule is that the orphan class as a whole stops.
 *
 * Counting discipline: a session may reference the same object repeatedly
 * (measured: 6 occurrences of 2 unique ids in one session), so every displayed
 * number is a **deduplicated count of objects**, with occurrences reported
 * separately as evidence. Dedup is by content id, which is also what makes
 * cross-session sharing visible.
 *
 * Read-only: two read APIs per session, nothing written.
 */

import { extractReferences, independentKeyLiteralScan } from './refs.js'
import { readServices, readViaPersistence, readViaQuery } from './observe.js'
import { COVERAGE_KNOWN_LIMIT, reconcile } from './coverage.js'

function describeCause(cause) {
  if (cause === null || cause === undefined) return String(cause)
  return `${cause?.name ?? 'Error'}: ${cause?.message ?? String(cause)}`
}

/**
 * Decide whether to run the raw cross-check for one session.
 *
 * The cross-check doubles the read cost, so the default is deliberately narrow:
 * it runs where a mistake would be dangerous. A session that yielded **no
 * references** is exactly that case — "nothing here" is the conclusion that
 * authorizes deletion. `'all'` exists for acceptance runs.
 */
function shouldCrossCheck(mode, queryRead, extraction) {
  if (mode === 'none') return false
  if (mode === 'all') return true
  if (queryRead.ok !== true) return true
  if (extraction.eventCount === 0) return true
  return extraction.attachments.size === 0
}

/**
 * Build the graph.
 *
 * @param {object} ctx
 * @param {object} [options]
 * @param {readonly string[]} [options.sessionIds] - defaults to the seam listing
 * @param {'all'|'empty-refs'|'none'} [options.verifyRead='empty-refs']
 * @returns {Promise<object>} JSON-serializable report
 */
export async function buildReferenceGraph(ctx, options = {}) {
  const generatedAt = new Date().toISOString()
  const verifyRead = options.verifyRead ?? 'empty-refs'
  const notes = []
  const services = readServices(ctx)

  let sessionIds = options.sessionIds ?? null
  if (sessionIds === null) {
    const query = (() => {
      try {
        return ctx.get('sessionQuery')
      } catch {
        return null
      }
    })()
    if (query === null || query === undefined || typeof query.listSessions !== 'function') {
      return unavailable(generatedAt, services, 'sessionQuery.listSessions is unavailable')
    }
    try {
      const records = await query.listSessions()
      sessionIds = records.map((record) => record?.header?.id).filter((id) => typeof id === 'string')
    } catch (cause) {
      return unavailable(generatedAt, services, `listSessions threw ${describeCause(cause)}`)
    }
  }

  const sessions = []
  const attachmentIndex = new Map()
  const sessionEdges = []
  const literalTotals = {
    sessionReferenceEvents: 0,
    sessionReferenceOccurrences: 0,
    literalWithoutStructuredEdge: 0,
    literalWithStructuredEdge: 0,
    structuredEdges: 0,
    textOnlyHex: 0,
  }
  const readTotals = { leasesAcquired: 0, leasesReleased: 0, handlesAcquired: 0, handlesClosed: 0, rawChecks: 0, ms: 0 }
  let proven = 0
  let unknown = 0

  for (const id of sessionIds) {
    const queryRead = await readViaQuery(ctx, id)
    if (queryRead.ok) readTotals.leasesAcquired += 1
    if (queryRead.leaseReleased) readTotals.leasesReleased += 1
    readTotals.ms += queryRead.ms

    const extraction = extractReferences(queryRead.events)
    const independent = independentKeyLiteralScan(queryRead.events)

    let rawRead = null
    if (shouldCrossCheck(verifyRead, queryRead, extraction)) {
      rawRead = await readViaPersistence(ctx, id)
      if (rawRead.handleAcquired) readTotals.handlesAcquired += 1
      if (rawRead.handleClosed) readTotals.handlesClosed += 1
      readTotals.rawChecks += 1
      readTotals.ms += rawRead.ms
    }

    const coverage = reconcile({
      services,
      queryRead,
      rawRead,
      extraction,
      independent,
      rawReadRequired: rawRead !== null,
    })
    if (coverage.status === 'proven') proven += 1
    else unknown += 1

    literalTotals.sessionReferenceEvents += extraction.literalSessionReference.events
    literalTotals.sessionReferenceOccurrences += extraction.literalSessionReference.occurrences
    literalTotals.literalWithStructuredEdge += extraction.literalSessionReference.withStructuredEdge
    literalTotals.literalWithoutStructuredEdge += extraction.literalSessionReference.withoutStructuredEdge
    literalTotals.structuredEdges += extraction.sessionRefs.length
    literalTotals.textOnlyHex += extraction.textOnlyHex.count

    for (const [attachmentId, entry] of extraction.attachments) {
      if (!attachmentIndex.has(attachmentId)) {
        attachmentIndex.set(attachmentId, { id: attachmentId, sessionIds: [], occurrences: 0 })
      }
      const indexed = attachmentIndex.get(attachmentId)
      indexed.sessionIds.push(id)
      indexed.occurrences += entry.occurrences
    }
    for (const edge of extraction.sessionRefs) {
      sessionEdges.push({ fromSessionId: id, fromSeq: edge.fromSeq, toSessionId: edge.sessionId, uri: edge.uri })
    }

    sessions.push({
      id,
      coverage: coverage.status,
      coverageReasons: coverage.reasons,
      checks: coverage.checks,
      read: {
        source: queryRead.source,
        events: queryRead.eventCount,
        cursor: queryRead.cursor,
        inheritedEventCount: queryRead.inheritedEventCount,
        revisionStable: queryRead.revisionStable,
        ms: queryRead.ms,
        error: queryRead.error,
      },
      rawRead: rawRead === null ? null : {
        events: rawRead.eventCount,
        inheritedEventCount: rawRead.inheritedEventCount,
        eventState: rawRead.eventState,
        ms: rawRead.ms,
        error: rawRead.error,
      },
      referenceCount: extraction.attachments.size,
      referenceOccurrences: [...extraction.attachments.values()].reduce((sum, entry) => sum + entry.occurrences, 0),
      attachmentIds: [...extraction.attachments.keys()],
      sessionReferenceCount: extraction.sessionRefs.length,
      literal: {
        sessionReferenceEvents: extraction.literalSessionReference.events,
        sessionReferenceOccurrences: extraction.literalSessionReference.occurrences,
        textOnlyHex: extraction.textOnlyHex,
      },
    })
  }

  const unknownSessions = sessions.filter((session) => session.coverage === 'unknown').map((session) => session.id)
  const attachments = [...attachmentIndex.values()]
    .map((entry) => ({ ...entry, sessionIds: [...new Set(entry.sessionIds)].sort() }))
    .sort((left, right) => right.sessionIds.length - left.sessionIds.length)

  const shared = attachments.filter((entry) => entry.sessionIds.length > 1)
  if (shared.length > 0) {
    notes.push(
      `${shared.length} object(s) are referenced by MORE than one session — a deletion frees nothing for those, ` +
        'which is why rows report "frees" rather than "occupies"',
    )
  }
  if (literalTotals.textOnlyHex > 0) {
    notes.push(
      `${literalTotals.textOnlyHex} bare 64-hex string(s) appear in text but are NOT references; they are counted ` +
        'as evidence that text is never consulted (a printed directory listing must not become a live reference)',
    )
  }
  if (literalTotals.literalWithoutStructuredEdge > 0 && literalTotals.structuredEdges === 0) {
    notes.push(
      `${literalTotals.literalWithoutStructuredEdge} event(s) contain the literal "session-reference" with NO ` +
        'structured source, while the number of STRUCTURED edges is 0 — a text search would invent edges that ' +
        'do not exist',
    )
  } else if (literalTotals.literalWithoutStructuredEdge > 0) {
    notes.push(
      `${literalTotals.literalWithoutStructuredEdge} event(s) contain the literal "session-reference" with no ` +
        `structured source (compared with ${literalTotals.structuredEdges} real structured edge(s)); the literal ` +
        'is never consulted',
    )
  }
  notes.push(COVERAGE_KNOWN_LIMIT)

  return {
    ok: true,
    generatedAt,
    verifyRead,
    services,
    coverage: {
      proven,
      unknown,
      total: sessions.length,
      unknownSessions,
      provenRatio: sessions.length === 0 ? null : proven / sessions.length,
    },
    orphanDetermination: unknownSessions.length === 0
      ? { allowed: true, reason: null, unknownSessions: [] }
      : {
          allowed: false,
          reason:
            `attachment relations could not be proven complete for ${unknownSessions.length} of ` +
            `${sessions.length} session(s); orphan detection is PAUSED for the whole scan rather than ` +
            'silently under-counting',
          unknownSessions,
        },
    sessions,
    attachments,
    sessionEdges,
    literals: literalTotals,
    readTotals,
    notes,
  }
}

function unavailable(generatedAt, services, reason) {
  return {
    ok: false,
    generatedAt,
    available: false,
    reason,
    services,
    coverage: { proven: null, unknown: null, total: null, unknownSessions: [], provenRatio: null },
    orphanDetermination: { allowed: false, reason, unknownSessions: [] },
    sessions: [],
    attachments: [],
    sessionEdges: [],
    literals: null,
    readTotals: null,
    notes: ['the session listing could not be read, so no graph is reported; this is "unknown", not "no references"'],
  }
}
