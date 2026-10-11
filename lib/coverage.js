/**
 * dsh-reclaim — coverage reconciliation.
 *
 * The hard rule from the design: **"read it but parsed nothing" must never be
 * treated as "it references nothing".** A session whose reference relations cannot
 * be shown complete is `unknown`, and while any session is unknown the orphan
 * determination is paused entirely.
 *
 * Four checks are needed. Measurement changed one of them, so this module
 * implements the INTENT with the signals that actually exist on this host — see
 * the measurements taken before the rules were fixed:
 *
 *   1. SERVICES      — the query + persistence read APIs are mounted. A missing
 *                      service is unknown, never "no references".
 *   2. READ PATHS    — the obvious rule is "parsed event count == the stored eventCount".
 *                      This host has **no stored eventCount**: measured absent on
 *                      both `sessionPersistence.list()` and `stat(id)` for 24/24
 *                      sessions. The substitute is a cross-check of two independent
 *                      readers (`observeSession` vs `open('read')`), which is also
 *                      the design's own §11 "read-path equivalence" test, and which
 *                      DOES catch a reader-side truncation — the design's failure
 *                      mode 3.
 *                      The rule is **direction-aware**: the raw reader must never
 *                      report MORE events than the query view. Equality is NOT
 *                      required, because the query layer balances an interrupted
 *                      turn while the raw layer does not — measured: one session
 *                      read 2651 vs 2648 with identical reference sets. Requiring
 *                      equality would flag every torn/live session as unknown.
 *                      One shortcut is allowed, and only with evidence: when the
 *                      query layer served a COLD session through the same reader
 *                      the cross-check uses and the stat-derived revision held
 *                      still across that read, the second read is skipped as
 *                      redundant (`rawReadSkipped`), and this check then rests on
 *                      the revision instead of on a comparison — and says so in
 *                      its detail rather than claiming two readers agreed.
 *   3. EXTRACTION    — the recursive walk must agree with an independent
 *                      key-literal scan of the same events. This is the regression
 *                      for the 6/18 near-miss: a path-enumerating extractor agrees
 *                      with nothing.
 *   4. ATOMICITY     — the read did not throw, the seqs are contiguous from 0 to
 *                      the cursor, `inheritedEventCount <= eventCount`, and the
 *                      persistence revision did not move under the read.
 *
 * **Known limit, stated rather than hidden**: with no stored event count, a log
 * truncated at a zstd frame boundary is NOT detectable. Both readers read the same
 * damaged bytes and both legitimately report a shorter (or empty) log — measured:
 * a 193-byte remnant of a 1.9 MB log read as "0 events, contiguous, no error". The
 * host's own contract treats a torn physical tail as normal, so a shorter tail is
 * an indistinguishable state. Completeness here is therefore proven *relative to
 * the readable log*, and that is the honest bound.
 *
 * Read-only and pure: it receives already-read results and returns a verdict.
 */

import { extractReferences, independentKeyLiteralScan } from './refs.js'

/** Check ids, in reporting order. */
export const COVERAGE_CHECK_IDS = Object.freeze(['services', 'read-paths', 'extraction', 'atomicity'])

const FAILURE_MODES = Object.freeze({
  service: '2 (read succeeded but nothing parsed) — a missing service cannot prove anything',
  readPaths: '3 (log truncated / only the first frame decoded)',
  extraction: '2 (read succeeded but nothing parsed) — the S1 shape',
  atomicity: '3 (log truncated) or an interrupted read',
})

function check(id, passed, detail, evidence) {
  return { id, passed, detail, evidence: evidence ?? null, failureMode: FAILURE_MODES[id === 'read-paths' ? 'readPaths' : id] ?? null }
}

/**
 * Reconcile one session's read and extraction into `proven` or `unknown`.
 *
 * @param {object} input
 * @param {object} input.services - from `readServices()`
 * @param {object} input.queryRead - from `readViaQuery()`
 * @param {object|null} input.rawRead - from `readViaPersistence()`, or null when skipped
 * @param {object} input.extraction - from `extractReferences(queryRead.events)`
 * @param {object} input.independent - from `independentKeyLiteralScan(queryRead.events)`
 * @param {boolean} input.rawReadRequired - whether the caller asked for the cross-check
 * @param {string|null} [input.rawReadSkipped] - the evidence that made the cross-check
 *   redundant (`'same-reader-same-revision'`), or null when it was requested or irrelevant
 * @returns {{ status: 'proven'|'unknown', checks: object[], reasons: string[], readPath: object }}
 */
export function reconcile({
  services,
  queryRead,
  rawRead,
  extraction,
  independent,
  rawReadRequired,
  rawReadSkipped = null,
}) {
  const checks = []

  // 1) services ------------------------------------------------------------
  const servicesOk = services.observeSession === true
    && services.sessionPersistence === true
    && services.open === true
  checks.push(check(
    'services',
    servicesOk,
    servicesOk
      ? 'sessionQuery.observeSession and sessionPersistence.open are both available'
      : `a read service is missing: ${JSON.stringify(services)}`,
    services,
  ))

  // 2) two read paths ------------------------------------------------------
  const rawOk = rawRead !== null && rawRead.ok === true
  const rawEventCount = rawRead?.eventCount ?? null
  const queryEventCount = queryRead?.eventCount ?? null
  const rawExceedsQuery = rawEventCount !== null && queryEventCount !== null && rawEventCount > queryEventCount
  const inheritedMatches = rawRead === null
    ? null
    : rawRead.inheritedEventCount === queryRead.inheritedEventCount

  // Reference sets, computed on BOTH readers' events. If the readers disagree
  // about what the session contains, we cannot claim to know its references.
  let rawExtraction = null
  let refsMatch = null
  let rawOnlyRefs = []
  let queryOnlyRefs = []
  if (rawRead !== null && rawRead.ok === true) {
    rawExtraction = extractReferences(rawRead.events)
    const rawIds = new Set(rawExtraction.attachments.keys())
    const queryIds = new Set(extraction.attachments.keys())
    rawOnlyRefs = [...rawIds].filter((id) => !queryIds.has(id))
    queryOnlyRefs = [...queryIds].filter((id) => !rawIds.has(id))
    refsMatch = rawOnlyRefs.length === 0 && queryOnlyRefs.length === 0
  }

  const readReasons = []
  if (queryRead.ok !== true) readReasons.push(`query read failed: ${queryRead.error ?? 'unknown error'}`)
  if (rawReadRequired && !rawOk) readReasons.push(`raw read failed: ${rawRead?.error ?? 'not attempted'}`)
  if (rawExceedsQuery) {
    readReasons.push(
      `the raw reader saw MORE events than the query view (${rawEventCount} > ${queryEventCount}) — ` +
        'the query read lost events',
    )
  }
  if (inheritedMatches === false) {
    readReasons.push(
      `the two readers disagree about inheritedEventCount (${String(rawRead?.inheritedEventCount)} vs ` +
        `${String(queryRead?.inheritedEventCount)})`,
    )
  }
  if (refsMatch === false) {
    readReasons.push(
      `the two readers disagree about the reference set (raw-only ${rawOnlyRefs.length}, ` +
        `query-only ${queryOnlyRefs.length})`,
    )
  }

  const readPassed = queryRead.ok === true
    && (!rawReadRequired || rawOk)
    && !rawExceedsQuery
    && inheritedMatches !== false
    && refsMatch !== false

  checks.push(check(
    'read-paths',
    readPassed,
    readPassed
      ? rawReadRequired
        ? `both readers agree: query ${queryEventCount} events, raw ${rawEventCount} events, ` +
          'identical reference sets, identical inheritedEventCount'
        : rawReadSkipped === null
          ? `query-only read of ${queryEventCount} events (the cross-check was not requested for this session)`
          : `query-only read of ${queryEventCount} events; the cross-check was skipped as redundant ` +
            `(${rawReadSkipped}) — the query layer read this stored session through the same cold-log reader the ` +
            'cross-check would use, and the persistence revision (dev:ino:size:mtimeNs:ctimeNs) was unchanged ' +
            'across that read, so the evidence here is the revision, not a comparison of two readers'
      : readReasons.join('; '),
    {
      queryEvents: queryEventCount,
      rawEvents: rawEventCount,
      inheritedMatches,
      refsMatch,
      rawOnlyRefs,
      queryOnlyRefs,
      rawReadRequired,
      rawReadSkipped,
      // The measured reason equality is NOT the rule: the query layer balances an
      // interrupted turn, so a raw read may legitimately be slightly shorter.
      countsEqual: rawEventCount === null ? null : rawEventCount === queryEventCount,
    },
  ))

  // 3) extraction completeness --------------------------------------------
  const walkIds = new Set(extraction.attachments.keys())
  const literalIds = independent.ids
  const onlyInWalk = [...walkIds].filter((id) => !literalIds.has(id))
  const onlyInLiteral = [...literalIds].filter((id) => !walkIds.has(id))
  const extractionPassed = onlyInWalk.length === 0
    && onlyInLiteral.length === 0
    && extraction.parseErrors.length === 0

  const extractionReasons = []
  if (onlyInWalk.length > 0) {
    extractionReasons.push(`${onlyInWalk.length} id(s) came from the recursive walk but not from the independent scan`)
  }
  if (onlyInLiteral.length > 0) {
    extractionReasons.push(
      `${onlyInLiteral.length} id(s) appear as a structured key literal but the recursive walk missed them — ` +
        'this is the S1 shape (path enumeration)',
    )
  }
  if (extraction.parseErrors.length > 0) {
    extractionReasons.push(`${extraction.parseErrors.length} event(s) could not be traversed: ${extraction.parseErrors.slice(0, 3).join(' | ')}`)
  }

  checks.push(check(
    'extraction',
    extractionPassed,
    extractionPassed
      ? `recursive walk and the independent key-literal scan agree on ${walkIds.size} unique id(s) ` +
        `(${independent.occurrences} occurrence(s))`
      : extractionReasons.join('; '),
    {
      walkUnique: walkIds.size,
      literalUnique: literalIds.size,
      literalOccurrences: independent.occurrences,
      textOnlyHex: extraction.textOnlyHex,
      onlyInWalk,
      onlyInLiteral,
    },
  ))

  // 4) atomicity -----------------------------------------------------------
  const seqs = extraction.seqs
  const cursor = queryRead.cursor
  const contiguityHolds = extraction.eventCount === 0
    ? cursor === null || cursor === -1
    : seqs.length > 0 && seqs[0] === 0 && extraction.gaps.length === 0 && cursor !== null && cursor === seqs[seqs.length - 1]
  const inheritedSane = queryRead.inheritedEventCount === null
    || queryRead.eventCount === null
    || queryRead.inheritedEventCount <= queryRead.eventCount
  const revisionStable = queryRead.revisionStable !== false

  const atomicityReasons = []
  if (!contiguityHolds) {
    atomicityReasons.push(
      `events are not a contiguous run from seq 0 to the cursor (events ${extraction.eventCount}, ` +
        `cursor ${String(cursor)}, gaps ${extraction.gaps.length})`,
    )
  }
  if (!inheritedSane) {
    atomicityReasons.push(
      `inheritedEventCount ${String(queryRead.inheritedEventCount)} exceeds the ${String(queryRead.eventCount)} events read`,
    )
  }
  if (!revisionStable) atomicityReasons.push('the persistence revision changed while the session was being read')
  if (queryRead.leaseReleased !== true) atomicityReasons.push('the observation lease was not released')

  const atomicityPassed = contiguityHolds && inheritedSane && revisionStable && queryRead.leaseReleased === true
  checks.push(check(
    'atomicity',
    atomicityPassed,
    atomicityPassed
      ? `contiguous 0..${String(cursor)} with no gaps; revision ${queryRead.revisionStable === null ? 'not comparable' : 'stable'}; lease released`
      : atomicityReasons.join('; '),
    {
      eventCount: extraction.eventCount,
      cursor,
      gaps: extraction.gaps.length,
      inheritedEventCount: queryRead.inheritedEventCount,
      revisionStable: queryRead.revisionStable,
      leaseReleased: queryRead.leaseReleased,
    },
  ))

  const reasons = checks.filter((entry) => !entry.passed).map((entry) => `${entry.id}: ${entry.detail}`)
  return {
    status: reasons.length === 0 ? 'proven' : 'unknown',
    checks,
    reasons,
    readPath: {
      queryEvents: queryEventCount,
      rawEvents: rawEventCount,
      rawChecked: rawRead !== null && rawRead.ok === true,
      rawReadSkipped,
      rawExtractionUnique: rawExtraction === null ? null : rawExtraction.attachments.size,
    },
    knownLimit: FAILURE_MODES.readPaths === undefined ? null : null,
  }
}

/**
 * The statement this project must never overclaim. Kept next to the checks so it
 * travels with them.
 */
export const COVERAGE_KNOWN_LIMIT =
  'Completeness is proven relative to the READABLE log. This host exposes no stored ' +
  'event count (absent on both sessionPersistence.list() and stat()), and a log truncated ' +
  'at a zstd frame boundary reads as a legitimately shorter or empty log — measured: a ' +
  '193-byte remnant of a 1.9 MB log read as "0 events, contiguous, no error". No signal ' +
  'available here distinguishes that from a genuinely short session.'

export { FAILURE_MODES }
