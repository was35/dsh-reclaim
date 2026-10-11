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
 * Read-only: at most two read APIs per session, nothing written — and see
 * {@link crossCheckDecision} for the one case where the second read is proven
 * redundant before it is paid for.
 */

import { extractReferences, independentKeyLiteralScan } from './refs.js'
import { readServices, readViaPersistence, readViaQuery } from './observe.js'
import { COVERAGE_KNOWN_LIMIT, reconcile } from './coverage.js'

function describeCause(cause) {
  if (cause === null || cause === undefined) return String(cause)
  return `${cause?.name ?? 'Error'}: ${cause?.message ?? String(cause)}`
}

/**
 * Index the session→session edges by their target: "who references this session".
 *
 * The rule lives here, in one place, because two callers have to agree on it and
 * a disagreement is silent in the worst direction. `gradeAll` uses it to decide
 * whether a row is `danger` and therefore not offered for selection
 * (`lib/classification-report.js`); `planSessionDelete` uses the same index to
 * refuse the move (`lib/delete-session.js`). The second is the *enforcement* of
 * the first — if the two ever computed this differently, the checkbox the user
 * could not tick and the request the server refused would describe different sets
 * of sessions, and nothing would report the discrepancy.
 *
 * A self-edge is dropped, because "another session references this one" is what
 * the tier is about: a session referring to itself is not somebody else
 * depending on it.
 *
 * @param {object} graph - a `buildReferenceGraph` report
 * @returns {Map<string, Set<string>>} target session id → referencing session ids
 */
export function buildReferencingIndex(graph) {
  const index = new Map()
  for (const edge of graph?.sessionEdges ?? []) {
    const from = edge?.fromSessionId
    const to = edge?.toSessionId
    if (typeof from !== 'string' || typeof to !== 'string' || from === to) continue
    if (!index.has(to)) index.set(to, new Set())
    index.get(to).add(from)
  }
  return index
}

/**
 * The referencing session ids for one target, from an index built above.
 *
 * @param {Map<string, Set<string>>} index - from {@link buildReferencingIndex}
 * @param {string} sessionId - the target
 * @returns {string[]} the ids that reference it, unsorted
 */
export function referencingSessionIdsOf(index, sessionId) {
  return [...(index.get(sessionId) ?? [])]
}

/**
 * Whether a graph *proved* every session's relations — as opposed to merely
 * having been built.
 *
 * `ok: true` alone is not that. A scan over truncated session logs still returns
 * a report; it records the gap in `coverage.unknownSessions` and closes the
 * orphan gate (`orphanDetermination.allowed: false`) precisely so that nobody
 * rounds "could not read it" down to "there was nothing there". An edge
 * belonging to an unread session is *absent* from `sessionEdges`, which makes an
 * unproven graph indistinguishable from a clean one to a caller that checks only
 * `ok` — and the direction it fails in is the one that authorises a move.
 *
 * `orphanDetermination.allowed` is the one field that is correct in both failure
 * modes: `false` for a graph that could not be built at all (the `unavailable()`
 * path below) and `false` for one built without proving completeness, `true` only
 * for a fully proven scan. It is also the field `classification-report.js`
 * already gates the orphan tier on, so this predicate exists to keep the two
 * readers agreeing — not to add a second opinion.
 *
 * @param {object} graph - a `buildReferenceGraph` report, or anything shaped like one
 * @returns {boolean} true only when the relation is fully proven
 */
export function referencesProvenComplete(graph) {
  return graph?.ok === true && graph?.orphanDetermination?.allowed === true
}

/**
 * Whether the cross-check would read the same bytes through the same reader —
 * in which case it cannot disagree about this session's references.
 *
 * For a **cold** session on this host it would. `sessionQuery.observeSession`
 * serves a stored session through `readColdSessionLog`, i.e.
 * `sessionPersistence.open(id, 'read')` + `handle.read()` — the very call
 * `readViaPersistence` makes — and its only addition is
 * `interruptedTurnClosers`, which appends synthetic step/turn endings *after*
 * the stored events. So the query view's reference set is a superset of the raw
 * read's, and the direction this check exists to catch (the raw reader seeing
 * MORE than the query view) cannot arise from a second read of an unchanged
 * file. What is left for the second read to detect is that the file CHANGED
 * between the two reads, which the stat-derived revision — `dev:ino:size:
 * mtimeNs:ctimeNs`, compared before and after the query read — already answers:
 * an append moves both size and mtime.
 *
 * Two cases are deliberately NOT covered, because there the second read is a
 * genuinely different source and stays:
 *   - a **live** session, whose query read is served from the registry's
 *     in-memory events instead of the durable log;
 *   - any read whose revision could not be established or did not hold still.
 */
function sameReaderProof(queryRead) {
  return queryRead.source === 'prepared'
    && queryRead.hasRevision === true
    && queryRead.revisionStable === true
}

/**
 * Decide whether to run the raw cross-check for one session.
 *
 * The cross-check doubles the read cost, so the default is deliberately narrow:
 * it runs where a mistake would be dangerous. A session that yielded **no
 * references** is exactly that case — "nothing here" is the conclusion that
 * authorizes deletion. `'all'` exists for acceptance runs, and it always reads
 * twice so the two readers can still be compared directly.
 *
 * @returns {{ run: boolean, skipped: string|null }} `skipped` names the evidence
 *   that made the second read redundant, so the coverage verdict can say what
 *   it actually stands on instead of claiming a comparison that never happened.
 */
function crossCheckDecision(mode, queryRead, extraction) {
  if (mode === 'none') return { run: false, skipped: null }
  if (mode === 'all') return { run: true, skipped: null }
  if (queryRead.ok !== true) return { run: true, skipped: null }
  if (extraction.eventCount === 0) return { run: true, skipped: null }
  if (extraction.attachments.size > 0) return { run: false, skipped: null }
  if (sameReaderProof(queryRead)) return { run: false, skipped: 'same-reader-same-revision' }
  return { run: true, skipped: null }
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
  const readTotals = {
    leasesAcquired: 0,
    leasesReleased: 0,
    handlesAcquired: 0,
    handlesClosed: 0,
    rawChecks: 0,
    crossChecksSkipped: 0,
    ms: 0,
  }
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
    const crossCheck = crossCheckDecision(verifyRead, queryRead, extraction)
    if (crossCheck.run) {
      rawRead = await readViaPersistence(ctx, id)
      if (rawRead.handleAcquired) readTotals.handlesAcquired += 1
      if (rawRead.handleClosed) readTotals.handlesClosed += 1
      readTotals.rawChecks += 1
      readTotals.ms += rawRead.ms
    } else if (crossCheck.skipped !== null) {
      readTotals.crossChecksSkipped += 1
    }

    const coverage = reconcile({
      services,
      queryRead,
      rawRead,
      extraction,
      independent,
      rawReadRequired: rawRead !== null,
      rawReadSkipped: crossCheck.skipped,
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
        crossCheckSkipped: crossCheck.skipped,
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

  if (readTotals.crossChecksSkipped > 0) {
    notes.push(
      `${readTotals.crossChecksSkipped} session(s) that yielded no references were NOT read a second time: their ` +
        'query read came through the same cold-log reader the cross-check uses (sessionPersistence.open(id, "read") ' +
        '+ handle.read()), and the persistence revision (dev:ino:size:mtimeNs:ctimeNs) was unchanged across that ' +
        'read, so a second read of the same file can only return the same events plus the query layer\'s synthetic ' +
        'turn closers. Live sessions, reads whose revision could not be shown to hold still, and every read under ' +
        'verifyRead=all are still cross-read — and the deletion paths re-read before they move anything.',
    )
  }

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
