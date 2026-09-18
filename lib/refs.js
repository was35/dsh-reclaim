/**
 * dsh-reclaim — reference extraction.
 *
 * 🔴 This module exists because of one real near-miss. The design's early
 * version ENUMERATED the two paths it had observed for `attachmentId`. An
 * exhaustive audit of every event on the machine then measured:
 *
 *   total structured `attachmentId` occurrences : 18
 *   covered by those two enumerated paths       :  6
 *   MISSED                                     : 12
 *   images identified / actually present        :  3 / 13
 *   in-use images that would have been judged "zero-reference orphans" : 10
 *
 * and nothing would have reported an error. The missed majority lived in
 * `tool/result` events (an image handed back by a tool).
 *
 * The lesson is that completeness cannot come from "which nestings have I seen".
 * Sampling paths always misses some; a recursive walk is complete by structure.
 * So: **walk every value, never name a path.**
 *
 * Direction of error: if the walk mistakes some unrelated field for a reference,
 * the consequence is that we delete LESS (conservative). That is the safe
 * direction, which is why no allow-list is needed here.
 *
 * The literal-vs-structured distinction is equally load-bearing: this machine has
 * 118 events containing the literal string `session-reference` (tool output,
 * draft strings) while the number of STRUCTURED `source.kind === 'session-reference'`
 * edges is **zero**. A text search would invent 118 edges that do not exist; and
 * for attachments, text search would read a printed directory listing as a set of
 * live references. Nothing in this module reads text to decide a reference.
 *
 * Read-only and pure: no services, no I/O, no side effects.
 */

/** Content-addressed ids are `sha256:<hex>`; on disk the prefix is absent. */
const SHA256_PREFIX = /^sha256:/

/** Independently verifiable occurrence of a structured attachment reference. */
const KEY_LITERAL = /"attachmentId"\s*:\s*"sha256:([0-9a-f]{64})"/g

/** A bare 64-hex string appearing anywhere in a string value (never a reference). */
const LOOSE_HEX = /\b[0-9a-f]{64}\b/g

function describeCause(cause) {
  if (cause === null || cause === undefined) return String(cause)
  return `${cause?.name ?? 'Error'}: ${cause?.message ?? String(cause)}`
}

/**
 * Recursively collect every string `attachmentId` field, at ANY depth.
 *
 * `seen` guards against a cycle. Event payloads arrive from JSON, which cannot
 * produce one, but this walk is correctness-critical and a stack overflow in the
 * middle of a scan would be a far worse failure than one WeakSet. Note that a
 * guard is safe here precisely BECAUSE the input is JSON-derived: `JSON.parse`
 * never hands out the same object twice, so `seen` can only ever suppress a true
 * cycle, never a legitimate repeated occurrence.
 *
 * @param {unknown} node
 * @param {(id: string, node: object) => void} record - receives the normalized id
 *   (the `sha256:` prefix stripped) and the owning object
 * @param {WeakSet<object>} [seen]
 */
export function walkAttachmentRefs(node, record, seen = new WeakSet()) {
  if (node === null || typeof node !== 'object') return
  if (seen.has(node)) return
  seen.add(node)
  if (Array.isArray(node)) {
    for (const item of node) walkAttachmentRefs(item, record, seen)
    return
  }
  const candidate = node.attachmentId
  if (typeof candidate === 'string') {
    record(candidate.replace(SHA256_PREFIX, ''), node)
  }
  for (const value of Object.values(node)) walkAttachmentRefs(value, record, seen)
}

/**
 * Recursively collect STRUCTURED session-to-session edges.
 *
 * Two shipped forms carry the target, and BOTH must be read (found by building a
 * real case — the first implementation only knew the URI form and produced an
 * edge with a null target):
 *
 *   1. `source.kind === 'session-reference'` with `source.uri` — the canonical
 *      `dsh-session:<id>` mention encoding.
 *   2. `source.kind === 'session-reference'` with `source.references[]`, where each
 *      entry carries `sessionId` — the durable recall form the host actually
 *      writes (`SessionReferenceSource` in dsh-session-reference).
 *
 * Only the structured field counts; see the module header for why text is not
 * consulted.
 *
 * @param {unknown} node
 * @param {(edge: { uri: string | null, sessionId: string | null, sessionIds: string[], raw: object }) => void} record
 */
export function walkSessionRefs(node, record, seen = new WeakSet()) {
  if (node === null || typeof node !== 'object') return
  if (seen.has(node)) return
  seen.add(node)
  if (Array.isArray(node)) {
    for (const item of node) walkSessionRefs(item, record, seen)
    return
  }
  const source = node.source
  if (source !== null && typeof source === 'object' && source.kind === 'session-reference') {
    const uri = typeof source.uri === 'string' ? source.uri : null
    const sessionIds = []
    if (uri !== null && uri.startsWith('dsh-session:')) {
      sessionIds.push(uri.slice('dsh-session:'.length))
    }
    for (const reference of Array.isArray(source.references) ? source.references : []) {
      const target = reference?.sessionId
      if (typeof target === 'string' && !sessionIds.includes(target)) sessionIds.push(target)
    }
    record({ uri, sessionId: sessionIds[0] ?? null, sessionIds, raw: source })
  }
  for (const value of Object.values(node)) walkSessionRefs(value, record, seen)
}

/**
 * Extract everything one session's events contain.
 *
 * @param {readonly object[]} events - `SessionEvent[]` (payload lives in `data`)
 * @returns {{
 *   attachments: Map<string, { id: string, occurrences: number, seqs: number[], types: Record<string, number> }>,
 *   sessionRefs: Array<{ fromSeq: number, uri: string | null, sessionId: string | null }>,
 *   literalSessionReference: { events: number, occurrences: number },
 *   textOnlyHex: { count: number, sample: string[] },
 *   eventCount: number,
 *   seqs: number[],
 *   gaps: Array<{ at: number, from: number, to: number }>,
 *   parseErrors: string[],
 * }}
 */
export function extractReferences(events) {
  const attachments = new Map()
  const sessionRefs = []
  // The literal counter counts events whose serialized data contains the string
  // `session-reference`. Note that a GENUINE structured edge also contains that
  // string (its own `kind` value), so the raw count alone cannot express the
  // false-positive rate — hence the split below. The number that matters for
  // "a text search would invent edges" is `withoutStructuredEdge`.
  const literalSessionReference = { events: 0, occurrences: 0, withStructuredEdge: 0, withoutStructuredEdge: 0 }
  const textOnlyHex = new Set()
  const parseErrors = []
  const seqs = []
  const gaps = []

  const list = Array.isArray(events) ? events : []

  for (const event of list) {
    const seq = typeof event?.seq === 'number' ? event.seq : null
    if (seq !== null) {
      if (seqs.length > 0 && seq !== seqs[seqs.length - 1] + 1) {
        gaps.push({ at: seqs.length, from: seqs[seqs.length - 1], to: seq })
      }
      seqs.push(seq)
    }

    // ⚠️ the payload field is `data`, not `payload`
    const data = event?.data
    const edgesBefore = sessionRefs.length
    try {
      walkAttachmentRefs(data, (id, node) => {
        const existing = attachments.get(id)
        if (existing === undefined) {
          attachments.set(id, {
            id,
            occurrences: 1,
            seqs: seq === null ? [] : [seq],
            types: event?.type === undefined ? {} : { [String(event.type)]: 1 },
          })
          return
        }
        existing.occurrences += 1
        if (seq !== null) existing.seqs.push(seq)
        if (event?.type !== undefined) {
          const key = String(event.type)
          existing.types[key] = (existing.types[key] ?? 0) + 1
        }
        void node
      })
      walkSessionRefs(data, (edge) => {
        for (const target of edge.sessionIds.length > 0 ? edge.sessionIds : [null]) {
          sessionRefs.push({ fromSeq: seq, uri: edge.uri, sessionId: target })
        }
      })
    } catch (cause) {
      parseErrors.push(`seq ${String(seq)}: ${describeCause(cause)}`)
    }

    // Evidence only — these counts never feed the reference set. They are what
    // makes "we do not read text" checkable rather than merely claimed.
    let serialized = null
    try {
      serialized = JSON.stringify(data ?? null)
    } catch (cause) {
      parseErrors.push(`seq ${String(seq)} serialize: ${describeCause(cause)}`)
    }
    if (serialized !== null) {
      const literalHits = serialized.match(/session-reference/g)
      if (literalHits !== null) {
        literalSessionReference.events += 1
        literalSessionReference.occurrences += literalHits.length
        if (sessionRefs.length > edgesBefore) literalSessionReference.withStructuredEdge += 1
        else literalSessionReference.withoutStructuredEdge += 1
      }
      const structuredIds = new Set()
      walkAttachmentRefs(data, (id) => structuredIds.add(id))
      for (const match of serialized.match(LOOSE_HEX) ?? []) {
        if (!structuredIds.has(match)) textOnlyHex.add(match)
      }
    }
  }

  return {
    attachments,
    sessionRefs,
    literalSessionReference,
    textOnlyHex: { count: textOnlyHex.size, sample: [...textOnlyHex].slice(0, 5) },
    eventCount: list.length,
    seqs,
    gaps,
    parseErrors,
  }
}

/**
 * The INDEPENDENT second opinion on the same events: scan the serialized form for
 * the structured key literal. It walks no structure at all, so a recursive-walk
 * bug cannot hide from it — that is the whole point (this is the regression for
 * the 6/18 near-miss, and the graph's extraction-completeness reconciliation).
 *
 * It is deliberately not used to DECIDE references (a tool output that echoes an
 * event would match). It is used to compare against the walk: the sets must be
 * equal. It may only ever agree or expose a bug in the walk.
 *
 * @param {readonly object[]} events
 * @returns {{ ids: Set<string>, occurrences: number, unparsable: number }}
 */
export function independentKeyLiteralScan(events) {
  const ids = new Set()
  let occurrences = 0
  let unparsable = 0
  for (const event of Array.isArray(events) ? events : []) {
    let serialized
    try {
      serialized = JSON.stringify(event?.data ?? null)
    } catch {
      unparsable += 1
      continue
    }
    if (serialized === null) continue
    for (const match of serialized.matchAll(KEY_LITERAL)) {
      ids.add(match[1])
      occurrences += 1
    }
  }
  return { ids, occurrences, unparsable }
}

export { KEY_LITERAL, LOOSE_HEX }
