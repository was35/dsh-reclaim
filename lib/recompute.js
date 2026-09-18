/**
 * dsh-reclaim — the second grading pass.
 *
 * The design's core sentence is:
 *
 *   **"Grading does not ask whether anything references it now; it asks whether,
 *   after this batch is gone, anything still needs it."**
 *
 * The first pass selects candidates. This pass treats those candidates as
 * already removed and recomputes:
 *
 *   - which attachments no longer have any session referencing them (they
 *     become orphans, and only now is their byte count honest);
 *   - which attachment objects are shared between a candidate and a session
 *     staying behind (deleting the candidate frees NOTHING for those — which is
 *     exactly why rows report "freed when deleted" rather than "occupies");
 *   - how many bytes the batch actually frees.
 *
 * Two rules are enforced here rather than trusted to the caller:
 *
 *   1. **Liveness is re-read through the probe at this moment.** The measured
 *      cold → live transition is a single step that can happen at any second,
 *      so a candidate whose liveness changed is dropped from the batch and the
 *      drop is reported. Reusing the first pass's snapshot would let "the user
 *      opened the session while looking at the panel" turn into a deletion.
 *   2. **A family is all-or-nothing for batch clearing.** Every member has to
 *      be independently safe; a shared attachment does not rescue a member and
 *      a safe member does not carry an unsafe sibling into the batch.
 *
 * Read-only: arithmetic over facts. Nothing is deleted, and nothing here is
 * allowed to decide on its own to touch the filesystem.
 */

import { TIER_RANK } from './classify.js'

function asSet(iterable) {
  return new Set(iterable ?? [])
}

/**
 * Run the second pass.
 *
 * @param {object} input
 * @param {{ sessions: object[], attachments: object[] }} input.facts
 * @param {object} input.classification - output of the first pass
 * @param {object} input.context - `{ probe, thresholdDays, nowMs, orphanDeterminationAllowed }`
 * @returns {object} JSON-serializable second-pass result
 */
export function recomputeAfterRemoval(input) {
  const { facts, classification, context } = input
  const probe = context.probe
  const thresholdDays = context.thresholdDays

  const sessionRows = new Map()
  for (const row of classification.sessions ?? []) sessionRows.set(row.id, row)
  const attachmentRows = new Map()
  for (const row of classification.attachments ?? []) attachmentRows.set(row.id, row)

  // --- step 1: the first-pass candidates, taken from the rows themselves so
  // the batch can never drift from what was displayed.
  const firstPass = [...sessionRows.values()].filter((row) => row.batchClearable === true)
  const candidateIds = firstPass.map((row) => row.id).sort()

  // --- step 2: re-read liveness for every candidate, now.
  const kept = []
  const dropped = []
  for (const id of candidateIds) {
    const row = sessionRows.get(id)
    const fresh = probe(id)
    const stillSafe = fresh?.state === 'not-live'
    if (stillSafe) {
      kept.push(id)
      if (row !== undefined) row.livenessAtSecondPass = fresh?.state ?? 'unknown'
    } else {
      dropped.push({
        sessionId: id,
        livenessState: fresh?.state ?? 'unknown',
        reasonCode: 'liveness-changed-before-decision',
        reason:
          `the session was not live during the scan but reports ${fresh?.state ?? 'unknown'} at the moment of ` +
          'decision; it is removed from the batch, because the batch must never be built from a stale liveness read',
      })
    }
  }

  // --- step 3: a family is only swept when EVERY member is in the kept batch.
  //
  // The caller already refuses to mark a member of a partly-unsafe family as
  // batch-clearable, so reaching this branch means something moved between the
  // two reads: a member that was safe during grading is not in the kept batch
  // now. Re-checking it here means the all-or-nothing rule holds no matter
  // which side of the call the family rule was applied on.
  const keptSet = asSet(kept)
  const familyOf = classification.familyBySessionId ?? new Map()
  for (const family of classification.families ?? []) {
    const missing = family.memberIds.filter((id) => !keptSet.has(id))
    if (missing.length === 0) continue
    for (const id of [...keptSet]) {
      if (familyOf.get(id) !== family.id) continue
      keptSet.delete(id)
      const index = kept.indexOf(id)
      if (index >= 0) kept.splice(index, 1)
      dropped.push({
        sessionId: id,
        livenessState: sessionRows.get(id)?.facts?.livenessState ?? 'unknown',
        reasonCode: 'family-not-fully-in-batch',
        reason:
          `family ${family.id} has ${missing.length} member(s) outside the batch ` +
          `(${missing.join(', ')}), so no member of it is batch-cleared`,
      })
    }
  }

  // --- step 4: which attachments lose their last reference.
  const references = new Map()
  for (const entry of facts.attachments ?? []) {
    references.set(entry.id, new Set(entry.sessionIds ?? []))
  }

  const becomingOrphanIds = []
  for (const [id, referencing] of references) {
    if (referencing.size === 0) continue
    let remaining = 0
    for (const sessionId of referencing) if (!keptSet.has(sessionId)) remaining += 1
    if (remaining === 0) becomingOrphanIds.push(id)
  }
  becomingOrphanIds.sort()
  const becomingOrphanSet = asSet(becomingOrphanIds)

  // Attribute each newly freed object to the candidate that held its last
  // reference. Attribution is per object, so a shared object contributes its
  // bytes exactly once to the batch total: double-counting is the one way a
  // "freed" number can lie upwards.
  const bytesByOwner = new Map()
  const ownerByObject = new Map()
  for (const id of becomingOrphanIds) {
    const holders = [...(references.get(id) ?? [])].filter((sessionId) => keptSet.has(sessionId)).sort()
    const owner = holders[holders.length - 1] ?? null
    ownerByObject.set(id, owner)
    if (owner !== null) bytesByOwner.set(owner, (bytesByOwner.get(owner) ?? 0) + (facts.bytesOf?.[id] ?? 0))
  }

  // --- step 5: per-row numbers.
  let freedByCandidates = 0
  const keptRows = []
  for (const id of kept) {
    const row = sessionRows.get(id)
    if (row === undefined) continue
    const own = typeof row.facts.sizeBytes === 'number' ? row.facts.sizeBytes : 0
    const released = bytesByOwner.get(id) ?? 0
    row.dedupCount = (facts.attachmentIdsBySession?.[id] ?? []).length
    row.freedByDeletingBytes = own + released
    row.freedBreakdown = {
      sessionLogBytes: typeof row.facts.sizeBytes === 'number' ? row.facts.sizeBytes : null,
      orphanedObjectBytes: released,
      sharedWithRetainedSessionCount: countShared(facts, id, keptSet),
    }
    freedByCandidates += own + released
    keptRows.push(row)
  }

  const updatedAttachments = []
  for (const row of attachmentRows.values()) {
    const referenced = references.get(row.id) ?? new Set()
    if (referenced.size === 0) {
      row.freedByDeletingBytes = row.tier === 'safe' ? (facts.bytesOf?.[row.id] ?? null) : null
      updatedAttachments.push(row)
      continue
    }
    if (becomingOrphanSet.has(row.id)) {
      // The object is only free once the batch is gone. It is NOT promoted into
      // an already-safe row: it becomes a cascade item, shown to the user
      // rather than swept silently.
      row.tier = 'confirm'
      row.tierReasons = [...new Set([...(row.tierReasons ?? []), 'becomes-orphan-after-batch'])]
      row.checks = [
        ...(row.checks ?? []),
        { ok: true, code: 'becomes-orphan-after-batch', message: '删掉本批之后才变为无人引用', detail: { ownerSessionId: ownerByObject.get(row.id) ?? null } },
      ]
      row.batchClearable = false
      row.selectable = true
      row.cascade = true
      row.freedByDeletingBytes = facts.bytesOf?.[row.id] ?? null
      row.facts = { ...(row.facts ?? {}), remainingSessionsAfterBatch: [] }
    } else {
      row.freedByDeletingBytes = 0
      row.facts = {
        ...(row.facts ?? {}),
        remainingSessionsAfterBatch: [...referenced].filter((sessionId) => !keptSet.has(sessionId)).sort(),
      }
    }
    updatedAttachments.push(row)
  }

  const freedByCascadeObjects = becomingOrphanIds.reduce((sum, id) => sum + (facts.bytesOf?.[id] ?? 0), 0)
  const freedByCaches = (classification.caches ?? [])
    .filter((row) => row.batchClearable === true)
    .reduce((sum, row) => sum + (typeof row.freedByDeletingBytes === 'number' ? row.freedByDeletingBytes : 0), 0)

  // The batch total is computed from the OBJECTS, never from summing the
  // per-row attribution: a shared object counted once per holder would inflate
  // the headline number.
  const freedByBatch =
    kept.reduce((sum, id) => sum + (typeof sessionRows.get(id)?.facts.sizeBytes === 'number' ? sessionRows.get(id).facts.sizeBytes : 0), 0) +
    freedByCascadeObjects

  const notes = []
  if (dropped.length > 0) {
    notes.push(
      `${dropped.length} candidate(s) were removed from the batch during the second pass: ` +
        'liveness is re-read at the moment of decision, and a session that came alive is never deleted',
    )
  }
  if (becomingOrphanIds.length > 0) {
    notes.push(
      `${becomingOrphanIds.length} stored object(s) become unreferenced only after this batch is gone; their bytes ` +
        'are already part of the batch total and they are reported as cascade items, not promoted to already-safe rows',
    )
  }
  const sharedCount = (facts.attachments ?? []).filter((entry) => (entry.sessionIds ?? []).length > 1).length
  if (sharedCount > 0) {
    notes.push(
      `${sharedCount} stored object(s) are referenced by more than one session; deleting one holder frees nothing ` +
        'for those, which is why rows report "freed when deleted" rather than an occupancy figure',
    )
  }

  return {
    thresholdDays,
    candidateIds,
    keptSessionIds: [...kept],
    droppedCandidates: dropped,
    becomingOrphanObjectIds: becomingOrphanIds,
    ownerByObject: Object.fromEntries(ownerByObject),
    freed: {
      byBatchBytes: freedByBatch,
      sessionLogBytes: kept.reduce(
        (sum, id) => sum + (typeof sessionRows.get(id)?.facts.sizeBytes === 'number' ? sessionRows.get(id).facts.sizeBytes : 0),
        0,
      ),
      cascadeObjectBytes: freedByCascadeObjects,
      cacheBytes: freedByCaches,
      totalBytes: freedByBatch + freedByCaches,
      candidatesOnlyConsistent: freedByCandidates === freedByBatch,
    },
    sessions: keptRows,
    allSessionRows: [...sessionRows.values()],
    attachments: updatedAttachments,
    notes,
  }
}

function countShared(facts, sessionId, keptSet) {
  const ids = facts.attachmentIdsBySession?.[sessionId] ?? []
  let shared = 0
  for (const id of ids) {
    const referencing = facts.attachmentSessionIds?.[id] ?? []
    if (referencing.some((other) => !keptSet.has(other))) shared += 1
  }
  return shared
}

/**
 * Rank helper kept here so callers comparing a family's tier to its members'
 * use one implementation.
 */
export function worstTier(tiers) {
  return tiers.reduce((current, tier) => (TIER_RANK[tier] > TIER_RANK[current] ? tier : current), 'unclassified')
}
