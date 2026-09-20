/**
 * dsh-reclaim — the three risk tiers.
 *
 * ## The question this module answers
 *
 * Not "is anything referencing this right now", but **"after this batch is
 * gone, does anything still need it?"** That is why grading happens twice:
 * `lib/recompute.js` takes the candidates this module produced, treats them as
 * already removed, and recomputes what that frees. The number on a row is the
 * result of the second pass, never of the first.
 *
 * ## The five-safety-condition rule for sessions
 *
 * A session may be batch-cleared only when ALL of these hold:
 *
 *   1. it is archived (an explicit "I do not need this" the user expressed)
 *   2. it is past the threshold
 *   3. nothing references it (`@session` edges from other sessions)
 *   4. it is not the parent of a session that is NOT in this batch
 *   5. all of its children are in this batch
 *
 * (4) and (5) are two edges of one idea — "cutting here leaves nobody stranded"
 * — and they are reported separately because the user-facing explanation
 * differs: (4) means "deleting it would make N children's lineage incomplete
 * but would not damage their content", (5) means "it has a child you have not
 * selected".
 *
 * Archiving alone is a signal, never an authorization. And the age of a
 * session whose age cannot be measured is **unknown**, which can never satisfy
 * "past the threshold": unknown is not zero, and it is not "ancient" either.
 *
 * ## Fail-closed rules that override everything above
 *
 *   - liveness is re-read at this moment, and anything that is not proven
 *     `not-live` blocks the safe tier (`unknown` included — a missing service
 *     must never read as "nothing is alive");
 *   - a session whose reference relations are not proven complete can never
 *     authorize an orphan attachment, and if ANY session is unproven the whole
 *     orphan class is paused for the scan, not just for that session;
 *   - a family is only batch-clearable when every member is safe on its own.
 *
 * ## Wording discipline (these strings reach the interface)
 *
 * Two phrases are used, and two are banned:
 *
 *   - USE **"删掉可释放"** (`freedByDeletingBytes`): attachments are deduplicated
 *     by content, so a shared image that two sessions reference frees nothing
 *     when one of them goes.
 *   - USE **"去重张数"** (`dedupCount`): a session may reference the same object
 *     several times (measured: 6 occurrences of 2 objects).
 *   - DO NOT write "占用 N MB" for a row — with sharing it is a false statement.
 *   - DO NOT report occurrence counts as if they were image counts.
 *
 * Read-only: pure functions over facts already gathered.
 */

import { DEFAULT_THRESHOLD_DAYS, MS_PER_DAY, ageInDays, cutoffMs } from './config.js'

/** Risk tiers, ordered worst first. */
export const TIERS = Object.freeze(['danger', 'confirm', 'safe', 'unclassified'])

/** Tier ordering used when a family takes its worst member's tier. */
export const TIER_RANK = Object.freeze({ danger: 3, confirm: 2, safe: 1, unclassified: 0 })

/** Liveness states that block every destructive operation. */
const DANGEROUS_LIVENESS = Object.freeze(['running', 'idle-live', 'unknown'])

/**
 * Message catalogue. Every user-visible string this module can emit is here,
 * so the wording rules can be asserted against one place instead of grepping
 * prose out of the grading logic.
 */
export const MESSAGES = Object.freeze({
  sessionLive: '正在使用中——内存里活着，删掉会让当前对话失去内容',
  sessionMidTurn: '正在使用中——Agent 正在跑一个回合',
  sessionLivenessUnknown: '活态无法判定（服务取不到或探针矛盾），保守起见一律不可清',
  sessionReferenced: '被另一个会话以 @会话引用 指向，删掉会破坏那条引用',
  sessionParentOfOutside: '是某个保留会话的父会话：删掉它会让 N 个子会话的谱系显示不完整，但不会损坏它们的内容',
  sessionChildNotInBatch: '有子会话不在本批删除范围内',
  sessionFamilyDirty: '家族里还有成员不满足安全档条件，整个家族因此不参与批量清',
  sessionNotArchived: '未归档——归档是你亲手表达的“我不需要它了”',
  sessionArchivedUnknown: '归档状态未知（归档集合读不到），不能当成“未归档”，也不能当成“已归档”',
  sessionTooRecent: '未超过阈值',
  sessionAgeUnknown: '最后活动时间读不到，年龄未知——未知既不满足“超过阈值”，也不等于很老',
  sessionSafe: '已归档、超过阈值、无入边、子会话都在本批内',
  attachmentReferencedByRetained: '仍被保留的会话引用，删掉会损坏那些会话',
  attachmentOrphanPaused: '有会话的引用关系无法证明完整，孤儿附件判定整体暂停——不把“没读到”当成“没人引用”',
  attachmentGraphUnavailable: '引用图整表读不到，无法证明任何附件零引用',
  attachmentUnknownObject: '不属于任何已定义族的对象，无法判断它是什么，因此不提供清理',
  attachmentSafeOrphan: '零引用孤儿：没有任何会话引用它',
  attachmentFamilyNoEntry: '这一族没有安全档条款（尚无真实样本可定规则），只报告、不提供清理',
  regenerableRequestImages: '派生请求图片：可以重新生成，清理不影响原图',
  regenerableStaging: '暂存残留：写入被中断留下的半成品',
  regenerableProjectionCache: '孤儿投影缓存：对应会话已不存在，宿主可以重建',
  entryNotEnumerated: '目录没能枚举（读不到或后端不可用），因此既不说它安全，也不说它有什么',
  secondPassFreed: '第二遍判定（把本批当成已经不在）之后才变为无人引用的对象',
  secondPassDropped: '第二遍重新读活态后不再满足安全档条件，已从本批剔除',
})

/** Probe states used to explain why a liveness-dependent decision was made. */
const DANGER_LIVENESS_REASON = Object.freeze({
  'running': 'liveness-running',
  'idle-live': 'liveness-idle-live',
  'unknown': 'liveness-unknown',
})

function failing(condition, code, message, detail) {
  return { code, message, ok: false, detail: detail ?? null }
}

/** Unix ms for a timestamp that may be an ISO string, or null. */
function toMillis(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? null : parsed
  }
  return null
}

/**
 * Grade one session.
 *
 * @param {object} session - a row from the session table
 * @param {object} context
 * @param {{ state: string, reason: string|null, message: string|null }} context.liveness
 *   - freshly probed, never a snapshot from an earlier scan
 * @param {number} context.thresholdDays
 * @param {number} context.nowMs
 * @param {boolean} context.sessionsServiceAvailable
 * @param {readonly string[]} context.referencingSessionIds - outside this batch
 * @param {readonly string[]} context.childrenOutsideBatch
 * @param {readonly string[]} context.childrenInBatch
 * @returns {object}
 */
export function classifySession(session, context) {
  const id = session?.id ?? null
  const checks = []
  const tierReasons = []

  // --- liveness: the gate that is re-read now, never remembered ------------
  const liveness = context.liveness ?? { state: 'unknown', reason: 'liveness-not-probed', message: null }
  const livenessBlocks = !context.sessionsServiceAvailable || DANGEROUS_LIVENESS.includes(liveness.state)
  if (livenessBlocks) {
    const code = context.sessionsServiceAvailable
      ? `liveness-${liveness.state}`
      : 'sessions-service-unavailable'
    checks.push(
      failing(
        true,
        code,
        liveness.state === 'running'
          ? MESSAGES.sessionMidTurn
          : liveness.state === 'idle-live'
            ? MESSAGES.sessionLive
            : MESSAGES.sessionLivenessUnknown,
        { livenessState: liveness.state, livenessReason: liveness.reason, message: liveness.message },
      ),
    )
    tierReasons.push(code)
  }

  // --- referenced by someone else -----------------------------------------
  const referencing = (context.referencingSessionIds ?? []).filter((other) => other !== id)
  if (referencing.length > 0) {
    checks.push(
      failing(true, 'referenced-by-other-session', MESSAGES.sessionReferenced, { referencingSessionIds: referencing }),
    )
    tierReasons.push('referenced-by-other-session')
  }

  const childrenOutside = context.childrenOutsideBatch ?? []
  const childrenInside = context.childrenInBatch ?? []
  if (childrenOutside.length > 0) {
    checks.push(
      failing(true, 'parent-of-outside-session', MESSAGES.sessionParentOfOutside.replace('N', String(childrenOutside.length)), {
        childSessionIds: childrenOutside,
      }),
    )
    tierReasons.push('parent-of-outside-session')
  }

  // --- the five safety conditions -----------------------------------------
  // Condition 5 is "every child is inside this batch". It is reported even when
  // condition 4 already fired, because the two say different things to the
  // user: 4 means "a session staying behind needs this one" (a lineage notice),
  // 5 means "you have not selected one of its children" (an incomplete batch).
  const childrenInBatchCondition = childrenOutside.length === 0
    ? { ok: true, code: 'children-all-in-batch', message: null, detail: { childSessionIds: childrenInside } }
    : failing(true, 'child-not-in-batch', MESSAGES.sessionChildNotInBatch, { childSessionIds: childrenOutside })
  checks.push(childrenInBatchCondition)

  const archivedCondition = session?.archived === true
    ? { ok: true, code: 'archived', message: null, detail: null }
    : session?.archived === null || session?.archived === undefined
      ? failing(true, 'archived-unknown', MESSAGES.sessionArchivedUnknown)
      : failing(true, 'not-archived', MESSAGES.sessionNotArchived)
  checks.push(archivedCondition)

  const activityMs = toMillis(session?.lastActivity) ?? toMillis(session?.createdAt)
  const activitySource = toMillis(session?.lastActivity) !== null ? 'last-activity' : (toMillis(session?.createdAt) !== null ? 'createdAt' : null)
  const ageDays = ageInDays(activityMs, context.nowMs)
  const cutoff = cutoffMs(context.nowMs, context.thresholdDays)
  const ageCondition = ageDays === null
    ? failing(true, 'age-unknown', MESSAGES.sessionAgeUnknown)
    : activityMs <= cutoff
      ? { ok: true, code: 'older-than-threshold', message: null, detail: null }
      : failing(true, 'too-recent', MESSAGES.sessionTooRecent, { ageDays, thresholdDays: context.thresholdDays })
  checks.push(ageCondition)

  const failed = checks.filter((check) => check.ok === false)

  let tier = 'safe'
  if (livenessBlocks || referencing.length > 0) tier = 'danger'
  else if (childrenOutside.length > 0) tier = 'confirm'
  else if (failed.length > 0) tier = 'confirm'

  if (tier === 'safe') {
    checks.push({ ok: true, code: 'all-safety-conditions', message: MESSAGES.sessionSafe, detail: null })
  }

  // The two conditions that are about the session's own state (as opposed to a
  // relationship with another session). They are reported separately because a
  // family downgrade must name them: "you satisfy everything about yourself, but
  // the family is not clean" is a different statement from "this condition
  // failed".
  const safeConditions = [archivedCondition, ageCondition]

  return {
    kind: 'session',
    id,
    tier,
    tierReasons: [...new Set(tierReasons)],
    blockingChecks: failed,
    checks,
    safeConditions,
    // A dangerous row is not offered for selection at all: the interface
    // disables the checkbox and explains why, instead of letting the user tick
    // it and then refusing.
    selectable: tier === 'confirm' || tier === 'safe',
    batchClearable: tier === 'safe',
    facts: {
      archived: session?.archived ?? null,
      ageDays,
      activitySource,
      thresholdDays: context.thresholdDays,
      sizeBytes: typeof session?.sizeBytes === 'number' ? session.sizeBytes : null,
      livenessState: liveness.state,
      referencingSessionIds: referencing,
      childrenOutsideBatch: childrenOutside,
      childrenInBatch: childrenInside,
    },
    // Per-session line counts only; the cross-session numbers are filled in by
    // the recompute pass.
    dedupCount: null,
    freedByDeletingBytes: null,
  }
}

/**
 * Grade one attachment object.
 *
 * @param {object} entry - the reference-graph view of one stored object
 * @param {object} context
 * @param {boolean} context.orphanDeterminationAllowed
 * @param {string|null} context.orphanDeterminationReason
 * @param {readonly string[]} context.unknownSessions
 * @param {boolean} context.enumerationEnabled
 * @param {readonly string[]} context.batchSessionIds - the batch under consideration
 * @returns {object}
 */
export function classifyAttachment(entry, context) {
  const id = entry?.id ?? null
  const blocks = []
  const referencing = entry?.sessionIds ?? []

  if (referencing.length > 0) {
    blocks.push(
      failing(true, 'referenced-by-session', MESSAGES.attachmentReferencedByRetained, { sessionIds: referencing }),
    )
  } else if (context.referenceGraphAvailable === false) {
    blocks.push(
      failing(true, 'reference-graph-unavailable', MESSAGES.attachmentGraphUnavailable, {
        reason: context.referenceGraphReason ?? null,
      }),
    )
  } else if (!context.orphanDeterminationAllowed) {
    blocks.push(
      failing(
        true,
        'orphan-determination-paused',
        MESSAGES.attachmentOrphanPaused,
        { unknownSessions: context.unknownSessions ?? [], reason: context.orphanDeterminationReason ?? null },
      ),
    )
  }

  const tier = blocks.length === 0 ? 'safe' : 'danger'
  if (tier === 'safe') {
    blocks.push({ ok: true, code: 'zero-references-proven', message: MESSAGES.attachmentSafeOrphan, detail: null })
  }

  return {
    kind: 'attachment',
    id,
    tier,
    tierReasons: blocks.filter((block) => block.ok === false).map((block) => block.code),
    blockingChecks: blocks.filter((block) => block.ok === false),
    checks: blocks,
    selectable: tier === 'safe',
    batchClearable: tier === 'safe',
    facts: {
      sessionIds: referencing,
      occurrences: entry?.occurrences ?? null,
      dedupCount: entry?.sessionIds?.length ?? null,
      inBatchSessionIds: referencing.filter((sessionId) => (context.batchSessionIds ?? []).includes(sessionId)),
      orphanDeterminationAllowed: context.orphanDeterminationAllowed,
    },
    freedByDeletingBytes: null,
  }
}

/**
 * Grade one regenerable cache item.
 *
 * Regenerable caches do NOT depend on the reference graph at all: a derived
 * request image can be produced again from the original, a staging leftover is
 * half of an interrupted write, and an orphaned projection cache belongs to a
 * session that no longer exists. They are therefore unaffected by the orphan
 * pause — but they DO depend on having actually been enumerated: "not read" is
 * not "safe to clear".
 *
 * @param {object} item - `{ kind, id, bytes, available, regenerable, reason, path }`
 * @returns {object}
 */
export function classifyCache(item) {
  const available = item?.available === true
  const enumerable = available && item?.enumerated !== false
  const blocks = []
  if (!enumerable) {
    blocks.push(
      failing(true, 'cache-not-enumerated', MESSAGES.entryNotEnumerated, { reason: item?.reason ?? null }),
    )
  }
  const tier = blocks.length === 0 ? 'safe' : 'unclassified'
  const message = item?.kind === 'derived-request-images'
    ? MESSAGES.regenerableRequestImages
    : item?.kind === 'staging-leftovers'
      ? MESSAGES.regenerableStaging
      : MESSAGES.regenerableProjectionCache
  if (tier === 'safe') blocks.push({ ok: true, code: 'regenerable', message, detail: null })

  return {
    kind: 'cache',
    id: item?.id ?? null,
    cacheKind: item?.kind ?? null,
    tier,
    tierReasons: blocks.filter((block) => block.ok === false).map((block) => block.code),
    blockingChecks: blocks.filter((block) => block.ok === false),
    checks: blocks,
    selectable: tier === 'safe',
    batchClearable: tier === 'safe',
    facts: {
      path: item?.path ?? null,
      bytes: typeof item?.bytes === 'number' ? item.bytes : null,
      regenerable: item?.regenerable === true,
      available,
      reason: item?.reason ?? null,
    },
    freedByDeletingBytes: typeof item?.bytes === 'number' ? item.bytes : null,
  }
}

/**
 * Objects that belong to no defined family. They cannot be graded at all —
 * nobody knows what they are — so they are reported as dangerous and given no
 * cleanup entry.
 */
export function classifyUnknownObject(entry) {
  return {
    kind: 'unknown-object',
    id: entry?.path ?? null,
    tier: 'danger',
    tierReasons: ['not-in-any-defined-family'],
    blockingChecks: [failing(true, 'not-in-any-defined-family', MESSAGES.attachmentUnknownObject, null)],
    checks: [{ ok: true, code: 'reported-only', message: MESSAGES.attachmentUnknownObject, detail: null }],
    selectable: false,
    batchClearable: false,
    facts: {
      path: entry?.path ?? null,
      files: entry?.files ?? null,
      bytes: entry?.bytes ?? null,
      reason: entry?.reason ?? null,
    },
    freedByDeletingBytes: null,
  }
}

/**
 * A family whose members are not all independently safe can never be
 * batch-cleared, whatever the individual tiers were.
 *
 * @param {object[]} memberRows
 * @param {object} family
 * @returns {object}
 */
export function gradeFamily(memberRows, family) {
  const worst = memberRows.reduce(
    (current, row) => (TIER_RANK[row.tier] > TIER_RANK[current] ? row.tier : current),
    'unclassified',
  )
  const allIndependentlySafe = memberRows.every((row) => row.batchClearable === true)
  const blockedBy = memberRows
    .filter((row) => row.batchClearable !== true)
    .map((row) => ({ sessionId: row.id, tier: row.tier, reasons: row.tierReasons }))

  const effectiveTier = allIndependentlySafe
    ? worst
    : worst === 'danger' || worst === 'unclassified'
      ? worst
      : 'confirm'

  return {
    kind: 'family',
    id: family.id,
    root: family.root,
    tier: effectiveTier,
    worstMemberTier: worst,
    allMembersIndependentlySafe: allIndependentlySafe,
    // The rule that is easy to miss: "worst tier wins" is not enough, the
    // family ALSO has to be entirely safe on its own to be swept by a batch.
    batchClearable: allIndependentlySafe && worst === 'safe',
    selectable: effectiveTier === 'confirm' || effectiveTier === 'safe',
    memberIds: family.memberIds,
    blockedBy,
    incomplete: family.incomplete === true,
    incompleteReason: family.incompleteReason ?? null,
    lineageReason: blockedBy.some((entry) => entry.reasons.includes('parent-of-outside-session'))
      ? MESSAGES.sessionParentOfOutside.replace('N', String(blockedBy.length))
      : null,
  }
}
