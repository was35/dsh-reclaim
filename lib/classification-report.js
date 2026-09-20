/**
 * dsh-reclaim — the classification report.
 *
 * This module is the single assembly point for the two-pass grading, shared by
 * the in-host route and the acceptance tool, so both always exercise the same
 * code path. It is deliberately NOT where facts are gathered: it receives a
 * `scan()` callback (the session table, the attachment enumeration, the cache
 * report, the reference graph) and a `probe(id)` callback (fresh liveness).
 *
 * Two separations exist for reasons that are visible in the acceptance runs:
 *
 *   - **facts are gathered once, graded many times.** Changing 7 → 30 days must
 *     re-grade facts already in memory, never re-read session logs (a full
 *     reference graph over the real tree costs ~1s and reads every byte of
 *     every log). That is why grading lives in `gradeAll(facts, …)` and fact
 *     gathering lives in the caller: the in-host route scans once per process
 *     and re-grades on every threshold change.
 *   - **probe(id) is called at the moment of decision, twice.** Once to grade,
 *     once in the second pass for every candidate. A probe backed by
 *     `lib/liveness.js` re-reads both services each call, so no liveness value
 *     in this report is a reused snapshot. Tests inject a probe whose answer
 *     changes between the two calls, which is exactly the cold → live step that
 *     was measured in the running host.
 *
 * Read-only. Nothing in this module writes, moves, or deletes anything.
 */

import { COVERAGE_KNOWN_LIMIT } from './coverage.js'
import { DEFAULT_THRESHOLD_DAYS, THRESHOLD_CHOICES, normalizeConfig } from './config.js'
import { MESSAGES, classifyAttachment, classifyCache, classifySession, classifyUnknownObject, gradeFamily, TIER_RANK, TIERS } from './classify.js'
import { groupFamilies } from './family.js'
import { readLivenessServices } from './liveness.js'
import { recomputeAfterRemoval } from './recompute.js'

/** Families that expose no cleanup entry of their own. */
const REPORT_ONLY_FAMILIES = Object.freeze(['file-objects', 'files'])

function emptyTierGroups() {
  return { danger: [], confirm: [], safe: [], unclassified: [], reportOnly: [] }
}

/**
 * Extract every stored object's on-disk presence from the attachment scan.
 *
 * The reference graph counts objects by content id; the attachment scan counts
 * files under `<home>/attachments/v1/objects/<aa>/<64-hex id>/<name>`. This is
 * the join between the two, and it is intentionally conservative: the id is
 * taken from the **directory** that holds the file, never guessed from the
 * file's own name, because a stored object's file name is not guaranteed to be
 * its hash. Anything that does not join is reported rather than assumed away.
 */
export function indexAttachmentsOnDisk(attachments) {
  const byId = new Map()
  const filesById = new Map()
  const families = Array.isArray(attachments?.families) ? attachments.families : []

  const walk = (path, bytes, familyId, explicitRelative) => {
    const normalized = String(explicitRelative ?? path).replace(/\\/g, '/')
    const segments = normalized.split('/')
    // `ab/<id>/<name>` — the id is the middle segment, and the shard must be
    // exactly two hex characters (that is the documented object layout).
    if (segments.length < 3) return
    const id = segments[segments.length - 2]
    const shard = segments[segments.length - 3]
    if (!/^[0-9a-f]{2}$/i.test(shard)) return
    if (!/^[0-9a-f]{64}$/i.test(id)) return
    if (!filesById.has(id)) filesById.set(id, [])
    filesById.get(id).push({ path, bytes, familyId, shard })
    if (!byId.has(id)) byId.set(id, { id, families: new Set(), bytes: 0, files: 0, samplePath: path })
    const entry = byId.get(id)
    entry.families.add(familyId)
    entry.bytes += typeof bytes === 'number' ? bytes : 0
    entry.files += 1
  }

  for (const family of families) {
    for (const file of family.fileList ?? []) {
      walk(file.path, file.bytes, family.id, file.relativePath)
    }
  }

  return { byId, filesById, available: families.length > 0 }
}

/**
 * Build the row set for every stored object under `request-images` / `tmp`.
 * Those two families are regenerable, so they are graded without consulting the
 * reference graph at all — but "not read" still must not become "safe".
 */
function cacheFamilyItems(attachments, caches) {
  const items = []
  const derived = caches?.derivedRequestImages
  if (derived !== undefined) {
    items.push({
      kind: 'derived-request-images',
      id: 'cache:request-images',
      bytes: derived.bytes ?? 0,
      available: derived.available === true,
      enumerated: derived.available === true,
      regenerable: true,
      path: derived.path ?? null,
      reason: derived.reason ?? null,
    })
  }
  const staging = caches?.stagingLeftovers
  if (staging !== undefined) {
    items.push({
      kind: 'staging-leftovers',
      id: 'cache:tmp',
      bytes: staging.bytes ?? 0,
      available: staging.available === true,
      enumerated: staging.available === true,
      regenerable: true,
      path: staging.path ?? null,
      reason: staging.reason ?? null,
    })
  }
  const orphans = caches?.orphanProjectionCaches
  if (orphans !== undefined && (orphans.orphans ?? []).length > 0) {
    for (const orphan of orphans.orphans) {
      items.push({
        kind: 'orphan-projection-cache',
        id: `cache:projcache:${orphan.id}`,
        bytes: orphan.bytes ?? 0,
        available: orphans.enabled === true,
        enumerated: orphans.enabled === true,
        regenerable: true,
        path: orphan.path,
        reason: orphans.enabled === true ? null : (orphans.reason ?? null),
      })
    }
  }
  const unreported = []
  if (caches !== undefined && orphans !== undefined && orphans.enabled !== true && (orphans.scannedFiles ?? 0) > 0) {
    unreported.push({
      kind: 'orphan-projection-cache',
      reason: orphans.reason ?? 'orphan detection is disabled',
      scannedFiles: orphans.scannedFiles,
    })
  }
  return { items, unreported, orphanProjectionReport: orphans ?? null }
}

/**
 * Grade one set of facts. Pure with respect to the world: the only side effect
 * is calling `probe`.
 *
 * @param {object} facts - output of the scan
 * @param {object} options
 * @param {(sessionId: string) => object} options.probe - fresh liveness read
 * @param {object} [options.config]
 * @param {number} [options.nowMs]
 * @returns {object}
 */
export function gradeAll(facts, options) {
  const probe = options.probe
  const nowMs = options.nowMs ?? Date.now()
  const { thresholdDays, requestedThresholdDays, thresholdNotes } = normalizeConfig(options.config)

  const sessions = facts.sessions?.sessions ?? []
  const graph = facts.graph ?? {}
  const gateAllowed = graph.orphanDetermination?.allowed === true
  const unknownSessions = graph.orphanDetermination?.unknownSessions ?? []
  const declaredCandidateIds = asStringArray(options.candidateSessionIds ?? [])
  const candidateSet = new Set(declaredCandidateIds.length > 0 ? declaredCandidateIds : sessions.map((row) => row.id))

  // --- families ------------------------------------------------------------
  const grouping = groupFamilies(sessions, { sessionEdges: graph.sessionEdges ?? [] })

  // --- references, indexed both ways --------------------------------------
  const referencingByTarget = new Map()
  for (const edge of graph.sessionEdges ?? []) {
    const from = edge?.fromSessionId
    const to = edge?.toSessionId
    if (typeof from !== 'string' || typeof to !== 'string' || from === to) continue
    if (!referencingByTarget.has(to)) referencingByTarget.set(to, new Set())
    referencingByTarget.get(to).add(from)
  }

  const attachmentIndex = Array.isArray(graph.attachments) ? graph.attachments : []
  const attachmentSessionIds = {}
  const bytesOf = {}
  for (const entry of attachmentIndex) {
    attachmentSessionIds[entry.id] = entry.sessionIds ?? []
    bytesOf[entry.id] = typeof entry.bytes === 'number' ? entry.bytes : 0
  }
  const onDisk = indexAttachmentsOnDisk(facts.attachments)
  for (const [id, entry] of onDisk.byId) {
    if (bytesOf[id] === undefined || bytesOf[id] === 0) bytesOf[id] = entry.bytes
  }

  // --- first pass ----------------------------------------------------------
  const scanCount = facts.scanCount ?? 1
  const firstPass = []
  const familyRowsById = new Map()
  // "Can this process prove a session is not alive?" is a different question
  // from "could the session listing be read". The session-table and attachment
  // seams can be readable while the in-memory store is missing or being torn
  // down, and it is the store that the liveness rule depends on.
  const services = readLivenessServices(facts.ctx ?? { get: () => undefined })
  const sessionsServiceAvailable = services.sessions !== null
  const sessionsServiceUnavailableReason = services.sessionsUnavailableReason

  for (const session of sessions) {
    const id = session?.id
    if (typeof id !== 'string') continue
    const liveness = probe(id)
    const children = Array.isArray(session.childSessions) ? session.childSessions : []
    const childrenOutsideBatch = children.filter((child) => !candidateSet.has(child))
    const childrenInBatch = children.filter((child) => candidateSet.has(child))
    const referencingSessionIds = [...(referencingByTarget.get(id) ?? [])]
    const row = classifySession(session, {
      liveness,
      thresholdDays,
      nowMs,
      sessionsServiceAvailable,
      referencingSessionIds,
      childrenOutsideBatch,
      childrenInBatch,
    })
    firstPass.push(row)
    familyRowsById.set(id, row)
  }

  // Family tiers, and the "all independently safe" rule applied to the rows
  // themselves so the recompute pass and the family view agree.
  const familyViews = []
  for (const family of grouping.families) {
    const memberRows = family.memberIds.map((id) => familyRowsById.get(id)).filter(Boolean)
    const view = gradeFamily(memberRows, family)
    familyViews.push(view)
    if (view.batchClearable !== true) {
      for (const row of memberRows) {
        if (row.tier === 'safe') {
          row.tier = 'confirm'
          row.tierReasons = [...new Set([...row.tierReasons, 'family-not-fully-safe'])]
          row.blockingChecks = [
            ...row.blockingChecks,
            { ok: false, code: 'family-not-fully-safe', message: MESSAGES.sessionFamilyDirty, detail: { familyId: family.id } },
          ]
        }
        row.batchClearable = false
      }
    }
    for (const row of memberRows) row.familyId = family.id
  }

  // --- attachments and caches ---------------------------------------------
  const attachmentRows = attachmentIndex.map((entry) =>
    classifyAttachment(
      { ...entry, bytes: bytesOf[entry.id] ?? null, onDisk: onDisk.byId.get(entry.id) ?? null },
      {
        orphanDeterminationAllowed: gateAllowed,
        orphanDeterminationReason: graph.orphanDetermination?.reason ?? null,
        // "The whole graph could not be built" is a different failure from
        // "some session's relations are unproven": the first means no attachment
        // can be judged at all, and it says so in its own words. The test is
        // `!== false` on purpose — a fact source that does not carry the flag is
        // not evidence that the graph is missing, and the unproven-session gate
        // (which is always populated) remains the conservative fallback.
        referenceGraphAvailable: graph.ok !== false,
        referenceGraphReason: graph.ok === false ? (graph.reason ?? 'the reference graph could not be built') : null,
        unknownSessions,
        enumerationEnabled: facts.attachments?.enumerationEnabled !== false,
        batchSessionIds: [...candidateSet],
      },
    ),
  )
  for (const row of attachmentRows) {
    row.bytes = bytesOf[row.id] ?? null
    row.dedupCount = (row.facts?.sessionIds ?? []).length
  }

  const unknownObjectRows = (facts.attachments?.unknown ?? []).map((entry) => {
    const row = classifyUnknownObject(entry)
    row.bytes = entry.bytes ?? null
    return row
  })

  const cacheFamilyIds = new Set(['request-images', 'tmp'])
  const cacheFamilyRows = []
  for (const family of facts.attachments?.families ?? []) {
    if (!cacheFamilyIds.has(family.id)) continue
    cacheFamilyRows.push({
      kind: 'cache-family',
      id: `cache-family:${family.id}`,
      cacheKind: family.id === 'request-images' ? 'derived-request-images' : 'staging-leftovers',
      tier: family.enumerated === true ? 'safe' : 'unclassified',
      tierReasons: family.enumerated === true ? [] : ['cache-family-not-enumerated'],
      blockingChecks: family.enumerated === true
        ? []
        : [{ ok: false, code: 'cache-family-not-enumerated', message: MESSAGES.entryNotEnumerated, detail: { reason: family.reason } }],
      checks: [
        {
          ok: true,
          code: family.id === 'request-images' ? 'regenerable-derived-images' : 'regenerable-staging',
          message: family.id === 'request-images' ? MESSAGES.regenerableRequestImages : MESSAGES.regenerableStaging,
          detail: null,
        },
      ],
      selectable: family.enumerated === true,
      batchClearable: family.enumerated === true,
      facts: {
        path: family.path,
        bytes: family.bytes ?? 0,
        files: family.files ?? 0,
        regenerable: true,
        enumerated: family.enumerated === true,
        reason: family.reason ?? null,
      },
      freedByDeletingBytes: family.enumerated === true ? (family.bytes ?? 0) : null,
      bytes: family.bytes ?? 0,
    })
  }

  const cacheReport = cacheFamilyItems(facts.attachments, facts.caches)
  const cacheRows = cacheReport.items
    .filter((item) => item.kind === 'orphan-projection-cache')
    .map((item) => ({ ...classifyCache(item), bytes: item.bytes }))

  // An unreadable session listing is not "no sessions": without the list that
  // would have claimed them, a session-owned object must not be called
  // reclaimable. Regenerable caches survive the failure — they are not owned by
  // any session — and the reason is stated rather than implied.
  const coreListingAvailable = facts.sessions?.available !== false
  const cacheGateBlocked = !coreListingAvailable
  if (cacheGateBlocked) {
    for (const row of cacheFamilyRows) {
      row.tier = 'unclassified'
      row.batchClearable = false
      row.selectable = false
      row.freedByDeletingBytes = null
      row.tierReasons = [...new Set([...(row.tierReasons ?? []), 'session-listing-unavailable'])]
      row.blockingChecks = [
        ...(row.blockingChecks ?? []),
        {
          ok: false,
          code: 'session-listing-unavailable',
          message:
            '核心会话清单读不到，无法确认这些可重建产物不被任何会话占用；' +
            '缺失的清单不等于空清单，因此本项不进安全档',
          detail: { reason: facts.sessions?.reason ?? null },
        },
      ]
    }
    for (const row of cacheRows) {
      row.tier = 'unclassified'
      row.batchClearable = false
      row.selectable = false
      row.freedByDeletingBytes = null
      row.tierReasons = [...new Set([...(row.tierReasons ?? []), 'session-listing-unavailable'])]
    }
  }

  // --- second pass ---------------------------------------------------------
  const attachmentIdsBySession = {}
  for (const [id, sessionIds] of Object.entries(attachmentSessionIds)) {
    for (const sessionId of sessionIds) {
      if (!attachmentIdsBySession[sessionId]) attachmentIdsBySession[sessionId] = []
      attachmentIdsBySession[sessionId].push(id)
    }
  }

  const secondPass = recomputeAfterRemoval({
    facts: {
      sessions,
      attachments: attachmentIndex.map((entry) => ({ id: entry.id, sessionIds: entry.sessionIds ?? [], occurrences: entry.occurrences ?? 0 })),
      bytesOf,
      attachmentIdsBySession,
      attachmentSessionIds,
    },
    classification: {
      sessions: firstPass,
      attachments: attachmentRows,
      caches: cacheFamilyRows,
      families: familyViews.map((view) => ({
        id: view.id,
        memberIds: view.memberIds,
        tier: view.tier,
        batchClearable: view.batchClearable,
      })),
      familyBySessionId: grouping.bySessionId,
    },
    context: { probe, thresholdDays, nowMs, orphanDeterminationAllowed: gateAllowed },
  })

  const mergedSessionRows = secondPass.allSessionRows
  const mergedAttachmentRows = secondPass.attachments

  // Objects that exist on disk but were never referenced: they are invisible to
  // the reference graph by definition, which is why they are reported rather
  // than silently graded.
  const unreferencedOnDisk = []
  for (const [id, entry] of onDisk.byId) {
    if (attachmentSessionIds[id] !== undefined) continue
    unreferencedOnDisk.push({ id, bytes: entry.bytes, files: entry.files, name: entry.name ?? null })
  }

  // --- grouping into tiers -------------------------------------------------
  const sessionTiers = emptyTierGroups()
  for (const row of mergedSessionRows) sessionTiers[row.tier].push(row)
  const attachmentTiers = emptyTierGroups()
  for (const row of mergedAttachmentRows) attachmentTiers[row.tier].push(row)
  for (const row of unknownObjectRows) attachmentTiers.danger.push(row)
  const cacheTiers = emptyTierGroups()
  for (const row of [...cacheFamilyRows, ...cacheRows]) {
    cacheTiers[row.tier].push(row)
  }
  // Families whose only cleanup entry does not exist are reported separately
  // instead of being graded: "behavior undefined" is a hole, "explicitly not
  // handled" is a decision.
  for (const family of facts.attachments?.families ?? []) {
    if (!REPORT_ONLY_FAMILIES.includes(family.id)) continue
    cacheTiers.reportOnly.push({
      kind: 'report-only-family',
      id: `report-only:${family.id}`,
      tier: 'reportOnly',
      reason: MESSAGES.attachmentFamilyNoEntry,
      selectable: false,
      batchClearable: false,
      facts: {
        path: family.path,
        bytes: family.bytes ?? 0,
        files: family.files ?? 0,
        enumerated: family.enumerated === true,
        reportOnly: family.reportOnly === true,
      },
      bytes: family.bytes ?? 0,
    })
  }

  // --- totals --------------------------------------------------------------
  const alreadyOrphanRows = mergedAttachmentRows.filter(
    (row) => (row.facts?.sessionIds ?? []).length === 0 && row.tier === 'safe',
  )
  const alreadyOrphanBytes = alreadyOrphanRows.reduce((sum, row) => sum + (row.bytes ?? 0), 0)
  const cascadeBytes = secondPass.freed.cascadeObjectBytes
  const cacheBytes = cacheTiers.safe.reduce((sum, row) => sum + (row.bytes ?? 0), 0)
  const safeSessionBytes = secondPass.freed.sessionLogBytes
  const totalReclaimable = safeSessionBytes + alreadyOrphanBytes + cascadeBytes + cacheBytes

  const notes = [
    ...(facts.sessions?.notes ?? []),
    ...grouping.notes,
    ...secondPass.notes,
    COVERAGE_KNOWN_LIMIT,
  ]
  if (!gateAllowed) {
    notes.push(
      `the orphan gate is CLOSED: ${unknownSessions.length} session(s) have unproven reference relations, so no ` +
        'attachment may be called a zero-reference orphan in this scan',
    )
  }
  if (unreferencedOnDisk.length > 0) {
    notes.push(
      `${unreferencedOnDisk.length} object(s) exist on disk but are referenced by no session at all; they are ` +
        'reported as evidence and are NOT graded, because the reference graph is built from logs and cannot ' +
        'explain a file nothing mentions',
    )
  }
  if (cacheReport.unreported.length > 0) {
    notes.push(
      `${cacheReport.unreported[0].scannedFiles} projection-cache file(s) were measured but not classified ` +
        `(${cacheReport.unreported[0].reason})`,
    )
  }

  const secondPassReasons = {}
  for (const row of mergedSessionRows) {
    for (const code of row.tierReasons ?? []) secondPassReasons[code] = (secondPassReasons[code] ?? 0) + 1
  }

  const report = {
    ok: true,
    generatedAt: new Date().toISOString(),
    nowMs,
    config: {
      thresholdDays,
      requestedThresholdDays,
      thresholdNotes,
      choices: THRESHOLD_CHOICES,
      defaults: { thresholdDays: DEFAULT_THRESHOLD_DAYS },
    },
    scanCount,
    tierReasonCounts: secondPassReasons,
    gate: {
      orphanDeterminationAllowed: gateAllowed,
      reason: graph.orphanDetermination?.reason ?? null,
      unknownSessions,
      coverage: graph.coverage ?? null,
      livenessServiceAvailable: sessionsServiceAvailable,
      livenessServiceUnavailableReason: sessionsServiceUnavailableReason,
    },
    secondPass: {
      candidateIds: secondPass.candidateIds,
      keptSessionIds: secondPass.keptSessionIds,
      droppedCandidates: secondPass.droppedCandidates,
      becomingOrphanObjectIds: secondPass.becomingOrphanObjectIds,
      notes: secondPass.notes,
    },
    tiers: {
      sessions: sessionTiers,
      attachments: attachmentTiers,
      caches: cacheTiers,
    },
    families: familyViews,
    sessions: mergedSessionRows,
    attachments: mergedAttachmentRows,
    unknownObjects: unknownObjectRows,
    unreferencedOnDisk,
    totals: {
      sessionCount: mergedSessionRows.length,
      familyCount: familyViews.length,
      attachmentCount: mergedAttachmentRows.length,
      dedupAttachmentCount: new Set(mergedAttachmentRows.map((row) => row.id)).size,
      tiers: {
        sessions: countTiers(mergedSessionRows),
        attachments: countTiers(mergedAttachmentRows),
        caches: countTiers([...cacheTiers.safe, ...cacheTiers.confirm, ...cacheTiers.danger, ...cacheTiers.unclassified]),
      },
      safeSessionLogBytes: safeSessionBytes,
      alreadyOrphanAttachmentBytes: alreadyOrphanBytes,
      cascadeObjectBytes: cascadeBytes,
      cacheBytes,
      // The headline is a sum of disjoint origin buckets. Summing per-row
      // attribution instead would count a shared object once per holder and
      // inflate the number, which is the one direction a "reclaimable" figure
      // must never lie in.
      totalReclaimableBytes: totalReclaimable,
      secondPassBatchFreedBytes: secondPass.freed.byBatchBytes,
    },
    messages: MESSAGES,
    limits: {
      coverage: COVERAGE_KNOWN_LIMIT,
      orphanDetermination:
        'orphan attachments may only be called orphans relative to the READABLE logs of this scan; a log ' +
        'truncated at a compression-frame boundary is indistinguishable from a genuinely short one on this host',
      thresholdSwitch: 'changing the threshold re-grades facts already in memory; it never re-reads session logs',
      // Two phrases are used and two are banned. The banned one is safe only
      // when it is SHARED, because a share means nothing is freed. Stating it
      // here makes the assertion exact: the phrase may appear in this
      // declaration, and nowhere else in the report.
      wordForSharedBytes: '删掉可释放',
      wordForImageCount: '去重张数',
      // Spelled as code points on purpose. The rule is "this phrase never
      // appears in the report", and writing it here would break that — so the
      // declaration is machine-checkable (codePointAt each entry) while the
      // serialized report stays free of it. A naive `report.includes(phrase)`
      // search over the whole payload is therefore a valid assertion.
      forbiddenWordingCodePoints: [[0x5360, 0x7528]],
      forbiddenWordingNote: 'the forbidden phrase is spelled as UTF-16 code points above',
      forbiddenWordingReason:
        'attachments are deduplicated by content, so a shared image frees nothing when one holder goes; ' +
        'an "occupies N MB" style figure would be a false statement on any row with a shared object',
      forbiddenWordingEmitted: [],
    },
    notes,
  }

  // The wording rule is stated as "this report never contains the phrase", so it
  // is verified by LOOKING, not by asserting an empty array: every string in the
  // serialized report is searched for the declared code points. A message added
  // later that uses the banned phrasing therefore shows up here instead of
  // shipping quietly.
  report.limits.forbiddenWordingEmitted = findForbiddenWording(report)
  return report
}

/** Search a JSON-serializable value for the declared forbidden phrasing. */
function findForbiddenWording(value) {
  const phrases = (value?.limits?.forbiddenWordingCodePoints ?? [])
    .filter((points) => Array.isArray(points) && points.length > 0)
    .map((points) => String.fromCodePoint(...points))
  const hits = []
  const seen = new WeakSet()
  const walk = (node, path) => {
    if (typeof node === 'string') {
      for (const phrase of phrases) {
        if (node.includes(phrase)) hits.push({ path, phrase })
      }
      return
    }
    if (node === null || typeof node !== 'object') return
    if (seen.has(node)) return
    seen.add(node)
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${index}]`))
      return
    }
    for (const [key, child] of Object.entries(node)) walk(child, path === '' ? key : `${path}.${key}`)
  }
  walk(value, '')
  return hits
}

function countTiers(rows) {
  const counts = {}
  for (const tier of TIERS) counts[tier] = 0
  for (const row of rows) if (counts[row.tier] !== undefined) counts[row.tier] += 1
  return counts
}

function asStringArray(value) {
  if (!Array.isArray(value)) return []
  return value.filter((entry) => typeof entry === 'string')
}

/** Tier ranking re-exported for tools that sort rows for display. */
export { TIER_RANK }
