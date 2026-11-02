/**
 * The panel's dictionaries, held to the vocabulary issue #23 settled.
 *
 * WHY THIS FILE EXISTS
 * The panel says dangerous things. "Isolate N items" and "empty this batch" are one click apart
 * and only one of them can be undone, so the words are not decoration: they are how the user
 * knows which of the two they are about to do. #21 fixed the words in a prototype, #23 carried
 * them into the product, and this file is what keeps them from drifting back — a single
 * "清理" in the destroy button turns a permanent delete into a tidy-up.
 *
 * Two properties are asserted, and they are different in kind:
 *   1. STRUCTURE — the zh and en dictionaries define exactly the same keys, and every key
 *      resolves to real text in both. `PANEL_KEY_PARITY` has existed since the dictionaries
 *      were split; nothing asserted it until now, so a key added to one side only would have
 *      shipped as a bare key on screen.
 *   2. VOCABULARY — the renamed actions are pinned verbatim, and the retired words are banned
 *      outright. Pinning catches a silent reword; banning catches a new string (or a reworded
 *      neighbour) reintroducing "清空"/"搬运中" next to the button that cannot be undone.
 *
 * WHAT IS NOT ASSERTED HERE
 * `lib/client.js` ships a hand-written copy of these strings (`INLINE_MESSAGES`), because the
 * host's locale service may answer with the key itself. That copy is checked in
 * `test/client-panel.test.js`, where the bundle is already loaded; the cross-check that the two
 * copies agree on the renamed keys lives there too.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { PANEL_KEY_PARITY, PANEL_MESSAGES, translatePanel } from '../lib/messages.js'

/** Every parameter any entry in either dictionary interpolates. */
const SAMPLE_PARAMS = {
  sessions: 12,
  attachments: 34,
  families: 5,
  scan: 3,
  count: 3,
  time: '12:00',
  days: 30,
  batches: 2,
  size: '1.0 MB',
  error: 'boom',
  reason: 'boom',
  familyCount: 4,
  moved: 1,
  failed: 0,
  already: 1,
  total: 2,
  failures: 1,
  files: 7,
  restored: 2,
  blocked: 0,
}

const LOCALES = ['zh', 'en']

/** Render every entry of one locale once, as a user would see it. */
function rendered(locale) {
  const dict = PANEL_MESSAGES[locale]
  return Object.keys(dict).map((key) => ({ key, text: translatePanel(locale, key, SAMPLE_PARAMS) }))
}

test('both dictionaries define exactly the same keys', () => {
  assert.equal(PANEL_KEY_PARITY.ok, true, `dictionary keys drifted: ${JSON.stringify(PANEL_KEY_PARITY)}`)
  assert.deepEqual(PANEL_KEY_PARITY.missingInEn, [])
  assert.deepEqual(PANEL_KEY_PARITY.missingInZh, [])
  assert.deepEqual(Object.keys(PANEL_MESSAGES.zh).sort(), Object.keys(PANEL_MESSAGES.en).sort())
  assert.ok(PANEL_KEY_PARITY.count > 0)
})

test('every key renders real text in both locales', () => {
  for (const locale of LOCALES) {
    for (const { key, text } of rendered(locale)) {
      assert.equal(typeof text, 'string', `${locale}:${key} did not render a string`)
      assert.notEqual(text, key, `${locale}:${key} resolved to the key itself`)
      assert.ok(text.trim().length > 0, `${locale}:${key} rendered as blank`)
      assert.ok(!text.includes('undefined'), `${locale}:${key} interpolated an undefined parameter: ${text}`)
    }
  }
})

test('the renamed actions read the same in the source dictionary', () => {
  const zh = (key, params) => translatePanel('zh', key, params)
  const en = (key, params) => translatePanel('en', key, params)

  // The restorable move: the button says what it does and that it can be undone.
  assert.equal(zh('action.cleanSelected', { count: 3 }), '隔离所选 3 项（可恢复）')
  assert.equal(en('action.cleanSelected', { count: 3 }), 'Quarantine 3 items (restorable)')
  assert.equal(zh('action.cleaning'), '正在隔离…')
  assert.equal(en('action.cleaning'), 'Quarantining…')
  assert.equal(zh('action.pendingNote'), '参考图读完前不提供任何隔离操作')

  // The irreversible one: no "tidy up" language anywhere near it.
  assert.equal(zh('bin.destroyTitle'), '彻底删除（不可恢复）')
  assert.equal(en('bin.destroyTitle'), 'Delete permanently (cannot be undone)')
  assert.equal(zh('bin.destroy'), '彻底删除这一批')
  assert.equal(en('bin.destroy'), 'Delete this batch permanently')
  assert.equal(zh('bin.destroying'), '正在彻底删除…')
  assert.equal(en('bin.destroying'), 'Deleting permanently…')

  // Progress and results use the same verb as the button that started them.
  assert.equal(zh('run.moved', { count: 2 }), '已隔离 2 项')
  assert.equal(en('run.moved', { count: 2 }), 'Quarantined 2')
  assert.equal(zh('run.announce', { moved: 1, failed: 0, already: 1 }), '已隔离 1 项，失败 0 项，已在隔离区 1 项。')
  assert.equal(en('run.announce', { moved: 1, failed: 0, already: 1 }), 'Quarantined 1, failed 0, already quarantined 1.')
  assert.equal(zh('notice.destroyFailed', { reason: 'disk' }), '彻底删除失败：disk')
})

test('the retired words are gone from the Chinese dictionary', () => {
  // Words that made a restorable move read like a deletion, or named the wrong action.
  const retired = ['彻底清空', '清空这一批', '正在清空', '清理所选', '搬运中', '已搬走', '仍要清理', '确认清理这一族', '不提供任何清理']
  for (const { key, text } of rendered('zh')) {
    for (const word of retired) {
      assert.ok(!text.includes(word), `zh:${key} still says "${word}": ${text}`)
    }
  }
})

test('the retired words are gone from the English dictionary', () => {
  const retired = ['Empty permanently', 'Empty this batch', 'Emptying', 'Clean up', 'Moving…', 'Still clean up', 'Nothing can be cleaned up']
  for (const { key, text } of rendered('en')) {
    for (const word of retired) {
      assert.ok(!text.includes(word), `en:${key} still says "${word}": ${text}`)
    }
  }
})

test('"清理" survives only as a collective term, never as a click', () => {
  // The rename is not a ban on the word: `清理` still describes the capability as a whole
  // (README's promise, docs/safety.md's passages, the `clearable` identifiers). What must not
  // survive is `清理` naming an action the user takes on the quarantine: that action is
  // 隔离 (restorable) or 彻底删除 (not).
  const actionKeys = ['action.cleanSelected', 'action.cleaning', 'bin.destroyTitle', 'bin.destroy', 'bin.destroying', 'run.moved', 'notice.moved']
  for (const key of actionKeys) {
    const text = translatePanel('zh', key, SAMPLE_PARAMS)
    assert.ok(!text.includes('清理'), `zh:${key} names an action "清理": ${text}`)
  }
})
