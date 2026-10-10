/**
 * dsh-reclaim — the panel's own copy, in two languages.
 *
 * ## Why this file exists separately from `lib/classify.js`'s `MESSAGES`
 *
 * They answer different questions and must be allowed to differ:
 *
 *   - **`MESSAGES` (host side)** is the *evidence* text: it explains why a row was
 *     graded the way it was, and it travels out through the API and the read-only model
 *     tool. It stays in Chinese; translating it would change what the model reports.
 *   - **this file (client side)** is the *interface* text: buttons, headings, labels,
 *     and a translation of each blocking-reason code for display. It follows the host's
 *     language setting.
 *
 * The two meet at the reason codes (`not-archived`, `too-recent`, …). The code is the
 * stable contract; the host sends its Chinese message alongside it, and the panel
 * prefers its own translation and falls back to the host's text when it has none — so a
 * new code can never render as nothing.
 *
 * ## Two languages, on purpose
 *
 * `zh` and `en` only. The user asked for exactly that and explicitly did not want a
 * third, so there is no locale list, no region variants, and no fallback chain to
 * maintain. `en` falls back to `zh` (the source of truth here), not the other way round.
 *
 * ## Shape
 *
 * Values are either a string or a function of a parameters object. Functions carry the
 * plural/word-order differences that a single template string cannot express:
 * "1 session" vs "3 sessions" needs code in English, and Chinese needs none of it.
 * Keeping them here means the panel renders `t('row.images', { count })` and never
 * builds a sentence itself.
 */

/** The locale ids this panel speaks. Mirrors the host's ids. */
export const PANEL_LOCALES = Object.freeze(['zh', 'en'])

/** The locale used when the host exposes no locale service at all. */
export const FALLBACK_LOCALE = 'zh'

const zh = {
  // --- top bar ------------------------------------------------------------
  'app.section': '空间回收',
  'top.reclaimable': '删掉可释放',
  'top.quarantine': '隔离区占用（仍在磁盘上）',
  'top.netRelease': '净释放 = 可释放 − 隔离区',
  'top.source': ({ sessions, attachments, families, scan }) =>
    `数据来源：${sessions} 个会话 · ${attachments} 张去重附件 · ${families} 个家族 · 扫描代数 ${scan}`,
  'top.pending': ({ count }) => `${count} 项待确认（引用关系未证明完整，孤儿附件判定已暂停）`,
  'threshold.group': '阈值',
  'threshold.days': ({ days }) => `${days} 天`,
  'threshold.note': '改阈值只重新分档，不重扫',

  // --- views and actions ---------------------------------------------------
  'view.audit': '审计',
  'view.bin': '隔离区',
  'view.binWithCount': ({ batches, size }) => `隔离区（${batches} 批 / ${size}）`,
  'action.rescan': '重新扫描',
  'action.rescanning': '重新读取中…',
  'action.cleanSelected': ({ count }) => `清理所选 ${count} 项（进隔离区，可恢复）`,
  'action.cleaning': '搬运中…',
  'action.cleanNote': '只会搬进插件自带的隔离区，不会销毁任何东西',

  // --- states --------------------------------------------------------------
  'state.loading': '正在读取审计结果…',
  'state.loadFailed': ({ error }) => `审计结果读不到：${error}`,
  'state.retry': '重试',
  'state.binUnreadable': ({ reason }) => `隔离区读不到：${reason}`,
  'state.binEmpty': '隔离区是空的。清理过的会话会出现在这里，可以恢复。',

  // --- tiers ---------------------------------------------------------------
  'tier.safe': '安全',
  'tier.confirm': '需确认',
  'tier.danger': '危险',
  'tier.count': ({ count }) => `${count} 项`,
  'tier.safeEmpty': '没有可批量清理的项：可能是会话都还很新，或归档得不够久',
  'tier.confirmEmpty': '没有需要逐个确认的项',
  'tier.dangerEmpty': '没有不可清理的项',

  // --- a row ---------------------------------------------------------------
  'row.images': ({ count }) => `${count} 张图片`,
  'row.size': ({ size }) => `会话 ${size}`,
  'row.freed': ({ size }) => `删掉可释放 ${size}`,
  'row.age': ({ days }) => `${days} 天未活动`,
  'row.ageUnknown': '未活动时间未知',
  'row.archived': '已归档',
  'row.notArchived': '未归档',
  'row.archiveUnknown': '归档状态未知',
  'row.shared': ({ count }) => `共享未释放 ${count} 张`,
  'row.untitled': '（无标题）',

  // --- the "still clean it up" entry (confirm tier) ------------------------
  'review.action': '仍要清理…',
  'review.actionClose': '收起',
  'review.explains': ({ count, familyCount }) =>
    `这一族共 ${familyCount} 个会话，会整族一起搬进隔离区（本次选中 ${count} 项）。`,
  'review.blockedBy': '被这些条件挡住：',
  'review.whyFamily': '家族要么整族一起动，要么都不动——只删其中一部分会让留下来的会话内容不完整。',
  'review.members': ({ count }) => `同族成员 ${count} 个：`,
  'review.confirm': '确认清理这一族',
  'review.cancel': '取消',

  // --- the quarantine -----------------------------------------------------
  'bin.items': ({ count, size }) => `${count} 项 · ${size}`,
  'bin.restore': '恢复',
  'bin.restoring': '恢复中…',
  'bin.destroyTitle': '彻底清空（不可恢复）',
  'bin.destroyBody': ({ count, size }) => `将永久删除 ${count} 项、${size}。这不进回收站，无法撤销。`,
  'bin.destroy': '彻底清空这一批',
  'bin.destroying': '清空中…',

  // --- notices ------------------------------------------------------------
  'notice.moved': ({ count }) => `已把 ${count} 个会话搬进隔离区，可从"隔离区"视图恢复。`,
  'notice.moveFailed': ({ moved, total, failures }) => `搬走 ${moved}/${total}；${failures} 项失败并留在原位：`,
  'notice.noReason': '未给出原因',
  'notice.restored': ({ count }) => `已恢复 ${count} 项。`,
  'notice.restoreIncomplete': ({ restored, blocked, failed, reason }) =>
    `恢复未完成：成功 ${restored}、受阻 ${blocked}、失败 ${failed}。${reason}`,
  'notice.destroyed': ({ files, size }) => `已永久删除 ${files} 个文件、${size}。`,
  'notice.destroyFailed': ({ reason }) => `清空失败：${reason}`,
  'notice.reviewFamilyOnly': ({ familyCount }) =>
    `这个入口按家族处理：本族 ${familyCount} 个会话会一起搬进隔离区。`,

  // --- blocking reasons, by code ------------------------------------------
  // The panel shows these in the user's language; the host's own Chinese message is
  // the fallback when a code is unknown here (see the module comment).
  'reason.not-archived': '未归档——归档是你亲手表达的"我不需要它了"',
  'reason.too-recent': '未超过阈值',
  'reason.liveness-idle-live': '正在使用中——内存里活着，删掉会让当前对话失去内容',
  'reason.liveness-running': '正在使用中——Agent 正在跑一个回合',
  'reason.liveness-unknown': '活态无法判定，保守起见一律不可清',
  'reason.sessions-service-unavailable': '读不到活态服务，无法证明它不在用',
  'reason.archived-unknown': '归档状态未知，不能当成"未归档"，也不能当成"已归档"',
  'reason.age-unknown': '最后活动时间读不到，年龄未知——未知既不满足"超过阈值"，也不等于很老',
  'reason.referenced-by-retained': '被另一个会话以 @会话引用 指向，删掉会破坏那条引用',
  'reason.parent-of-outside': '是某个保留会话的父会话：删掉它会让子会话的谱系显示不完整',
  'reason.child-not-in-batch': '有子会话不在本批删除范围内',
  'reason.family-dirty': '家族里还有成员不满足安全档条件，整个家族因此不参与批量清',
  'reason.referenced': '仍被保留的会话引用，删掉会损坏那些会话',
  'reason.referenced-by-session': '仍被会话引用：删掉它会让那些会话失去内容',
  'reason.reference-graph-unavailable': '引用图整表读不到，无法证明这个对象零引用',
  'reason.orphan-determination-paused': '有会话的引用关系无法证明完整，孤儿判定整体暂停',
  'reason.graph-unavailable': '引用图整表读不到，无法证明任何附件零引用',
  'reason.unknown-object': '不属于任何已定义族的对象，无法判断它是什么',
  'reason.family-no-entry': '这一族没有安全档条款，只报告、不提供清理',
  'reason.not-enumerated': '目录没能枚举，因此既不说它安全，也不说它有什么',
  'reason.cache-not-enumerated': '这一项没能枚举，因此既不说它安全，也不说它有什么',
  'reason.cache-family-not-enumerated': '这一族没能枚举：没读到内容不等于内容是空的，所以不进安全档',
  'reason.session-listing-unavailable': '核心会话清单读不到，无法确认它不被任何会话占用；缺失的清单不等于空清单',
  'reason.invalid-session-id': '会话 ID 格式无效或包含路径穿越字符，服务端拒绝处理',
}

const en = {
  'app.section': 'Space reclaim',
  'top.reclaimable': 'Reclaimable',
  'top.quarantine': 'In quarantine (still on disk)',
  'top.netRelease': 'Net release = reclaimable − quarantine',
  'top.source': ({ sessions, attachments, families, scan }) =>
    `Source: ${sessions} session${sessions === 1 ? '' : 's'} · ${attachments} deduplicated attachment${attachments === 1 ? '' : 's'} · ${families} famil${families === 1 ? 'y' : 'ies'} · scan generation ${scan}`,
  'top.pending': ({ count }) =>
    `${count} item${count === 1 ? '' : 's'} awaiting confirmation (reference completeness is unproven, so orphan detection is paused)`,
  'threshold.group': 'Inactivity window',
  'threshold.days': ({ days }) => `${days} days`,
  'threshold.note': 'Changing it re-grades only; it does not rescan',
  'view.audit': 'Audit',
  'view.bin': 'Quarantine',
  'view.binWithCount': ({ batches, size }) => `Quarantine (${batches} batch${batches === 1 ? '' : 'es'} / ${size})`,
  'action.rescan': 'Rescan',
  'action.rescanning': 'Rereading…',
  'action.cleanSelected': ({ count }) =>
    `Clean up ${count} item${count === 1 ? '' : 's'} (moves to quarantine, restorable)`,
  'action.cleaning': 'Moving…',
  'action.cleanNote': 'It only moves data into the plugin\'s own quarantine; nothing is destroyed',
  'state.loading': 'Reading the audit…',
  'state.loadFailed': ({ error }) => `The audit could not be read: ${error}`,
  'state.retry': 'Try again',
  'state.binUnreadable': ({ reason }) => `The quarantine could not be read: ${reason}`,
  'state.binEmpty': 'The quarantine is empty. Sessions you clean up appear here, and can be restored.',
  'tier.safe': 'Safe',
  'tier.confirm': 'Needs review',
  'tier.danger': 'Dangerous',
  'tier.count': ({ count }) => `${count}`,
  'tier.safeEmpty': 'Nothing can be batch-cleared: the sessions are probably still recent, or not archived long enough',
  'tier.confirmEmpty': 'Nothing needs reviewing one by one',
  'tier.dangerEmpty': 'Nothing is un-clearable',
  'row.images': ({ count }) => `${count} image${count === 1 ? '' : 's'}`,
  'row.size': ({ size }) => `session ${size}`,
  'row.freed': ({ size }) => `frees ${size}`,
  'row.age': ({ days }) => `${days} days idle`,
  'row.ageUnknown': 'idle time unknown',
  'row.archived': 'archived',
  'row.notArchived': 'not archived',
  'row.archiveUnknown': 'archive state unknown',
  'row.shared': ({ count }) => `${count} still shared`,
  'row.untitled': '(untitled)',
  'review.action': 'Still clean up…',
  'review.actionClose': 'Hide',
  'review.explains': ({ count, familyCount }) =>
    `This family has ${familyCount} session${familyCount === 1 ? '' : 's'}, and moves as a whole (${count} selected here).`,
  'review.blockedBy': 'Blocked by:',
  'review.whyFamily':
    'A family moves together or not at all — deleting only part of it would leave the remaining sessions incomplete.',
  'review.members': ({ count }) => `${count} member${count === 1 ? '' : 's'} in this family:`,
  'review.confirm': 'Clean up this family',
  'review.cancel': 'Cancel',
  'bin.items': ({ count, size }) => `${count} item${count === 1 ? '' : 's'} · ${size}`,
  'bin.restore': 'Restore',
  'bin.restoring': 'Restoring…',
  'bin.destroyTitle': 'Empty permanently (cannot be undone)',
  'bin.destroyBody': ({ count, size }) =>
    `This permanently deletes ${count} item${count === 1 ? '' : 's'}, ${size}. It does not go to a recycle bin and cannot be undone.`,
  'bin.destroy': 'Empty this batch',
  'bin.destroying': 'Emptying…',
  'notice.moved': ({ count }) => `Moved ${count} session${count === 1 ? '' : 's'} into the quarantine; restore them from the Quarantine view.`,
  'notice.moveFailed': ({ moved, total, failures }) =>
    `Moved ${moved}/${total}; ${failures} failed and stayed in place: `,
  'notice.noReason': 'no reason reported',
  'notice.restored': ({ count }) => `Restored ${count} item${count === 1 ? '' : 's'}.`,
  'notice.restoreIncomplete': ({ restored, blocked, failed, reason }) =>
    `Restore incomplete: restored ${restored}, blocked ${blocked}, failed ${failed}. ${reason}`,
  'notice.destroyed': ({ files, size }) => `Permanently removed ${files} file${files === 1 ? '' : 's'}, ${size}.`,
  'notice.destroyFailed': ({ reason }) => `Could not empty the batch: ${reason}`,
  'notice.reviewFamilyOnly': ({ familyCount }) =>
    `This entry point works per family: all ${familyCount} session${familyCount === 1 ? '' : 's'} in it move together.`,
  'reason.not-archived': 'Not archived — archiving is how you say "I do not need this any more"',
  'reason.too-recent': 'Within the inactivity window',
  'reason.liveness-idle-live': 'In use — loaded in memory; deleting it would empty the conversation you are in',
  'reason.liveness-running': 'In use — the agent is mid-turn',
  'reason.liveness-unknown': 'Liveness could not be determined, so it is treated as unsafe',
  'reason.sessions-service-unavailable': 'The live-session store is unreadable, so "not in use" cannot be proven',
  'reason.archived-unknown': 'Archive state unknown — it is neither "not archived" nor "archived"',
  'reason.age-unknown': 'Last activity is unreadable, so the age is unknown — unknown is not "old"',
  'reason.referenced-by-retained': 'Another session references it with @session; deleting it would break that reference',
  'reason.parent-of-outside': 'It is the parent of a session being kept: deleting it would leave that session\'s lineage incomplete',
  'reason.child-not-in-batch': 'It has child sessions outside this batch',
  'reason.family-dirty': 'Another member of its family is not safe, so the family does not take part in batch cleanup',
  'reason.referenced': 'Still referenced by a session that is being kept; deleting it would damage that session',
  'reason.referenced-by-session': 'Still referenced by a session; deleting it would empty that session\'s content',
  'reason.reference-graph-unavailable': 'The reference graph is unreadable, so "unreferenced" cannot be proven',
  'reason.orphan-determination-paused': 'Reference completeness is unproven for some session, so orphan detection is paused',
  'reason.graph-unavailable': 'The reference graph is unreadable, so no attachment can be proven unreferenced',
  'reason.unknown-object': 'It belongs to no defined family, so what it is cannot be established',
  'reason.family-no-entry': 'This family has no safe-tier rule; it is reported but not offered for cleanup',
  'reason.not-enumerated': 'The directory could not be enumerated, so it is neither called safe nor described',
  'reason.cache-not-enumerated': 'This item could not be enumerated, so it is neither called safe nor described',
  'reason.cache-family-not-enumerated': 'This family could not be enumerated: unread does not mean empty, so it does not enter the safe tier',
  'reason.session-listing-unavailable': 'Core session listing cannot be read to prove it is unclaimed; missing list is not an empty list',
  'reason.invalid-session-id': 'The session ID is invalid or contains path-traversal characters and was refused',
}

/** The dictionaries, by locale id. */
export const PANEL_MESSAGES = Object.freeze({ zh: Object.freeze(zh), en: Object.freeze(en) })

/**
 * Look up one key.
 *
 * Resolution order is deliberate: the requested locale, then the fallback locale
 * (`zh`, which is this file's source of truth), then the key itself. Returning the key
 * rather than an empty string means a typo is visible in the interface instead of
 * silently rendering a blank.
 *
 * @param {string} locale - `zh` or `en` (anything else falls back)
 * @param {string} key
 * @param {object} [params]
 * @returns {string}
 */
export function translatePanel(locale, key, params) {
  const dict = PANEL_MESSAGES[locale] ?? PANEL_MESSAGES[FALLBACK_LOCALE]
  const entry = dict[key] ?? PANEL_MESSAGES[FALLBACK_LOCALE][key]
  if (entry === undefined) return key
  if (typeof entry === 'function') return String(entry(params ?? {}))
  if (params === undefined) return entry
  // A plain string entry with parameters: substitute `{name}` tokens, which is the same
  // syntax the host's own locale service understands (its `translate` uses `\{(\w+)\}`).
  return entry.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
}

/** Non-fatal self-check: both dictionaries must define exactly the same keys. */
export const PANEL_KEY_PARITY = (() => {
  const zhKeys = Object.keys(zh).sort()
  const enKeys = Object.keys(en).sort()
  const missingInEn = zhKeys.filter((key) => !(key in en))
  const missingInZh = enKeys.filter((key) => !(key in zh))
  return { ok: missingInEn.length === 0 && missingInZh.length === 0, missingInEn, missingInZh, count: zhKeys.length }
})()
