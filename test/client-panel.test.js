/**
 * The panel's interface rules, asserted without a browser.
 *
 * `lib/client.js` is a classic script, so it cannot be imported — it registers a factory on
 * `window.__ModuleLoader__` and, on the way out, hangs the render function on
 * `globalThis.__dshReclaimPanel` precisely so a test can evaluate it once and call
 * `renderPanel` directly. That seam existed but nothing used it; these tests are the first.
 *
 * WHAT IS BEING TESTED, AND WHY IT IS NOT COSMETIC
 * `renderPanel` is hook-free, so "is this control usable" is a property of the tree it
 * returns, not of a browser. That matters because the two halves of the plugin decide
 * selectability in different places: the server grades a row (`batchClearable`), and the
 * panel turns that grade into a checkbox. If the panel offered a checkbox the server would
 * refuse, the user would learn about it at the worst moment — after ticking it. So the rule
 * "a control is enabled only when the server said the row can actually be cleared" is an
 * acceptance criterion, and it is checked here for the rows phase two made clearable.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { translatePanel } from '../lib/messages.js'
import { loadPanel } from './hooks/panel-harness.mjs'

/**
 * The bundle, evaluated the way the page evaluates it.
 *
 * The evaluation itself lives in `test/hooks/panel-harness.mjs`, because a second caller needs
 * the same bundle: the host-level check in `scripts/verify-reentry.mjs` asks the real panel what
 * it would say about responses a real host produced. It is evaluated ONCE per process, because
 * evaluating it twice produces two plugin instances.
 */
const loaded = (() => {
  const { react, plugin, seam } = loadPanel()
  return {
    react,
    plugin,
    renderPanel: seam.renderPanel,
    classifyUrl: seam.classifyUrl,
    formatClock: seam.formatClock,
    shouldRescanAfter: seam.shouldRescanAfter,
    rememberReceipt: seam.rememberReceipt,
    summarizeReceipts: seam.summarizeReceipts,
    summarizeRun: seam.summarizeRun,
    unavailableFromRun: seam.unavailableFromRun,
    selectableSafeIds: seam.selectableSafeIds,
    selectableArtifactIds: seam.selectableArtifactIds,
    setupCompanionNotification: seam.setupCompanionNotification,
    showCompanionToast: seam.showCompanionToast,
  }
})()

/** The panel's own Chinese dictionary, so the assertions can read the strings a user reads. */
function translator() {
  return (key, params) => loaded.plugin.__messages.translatePanel('zh', key, params)
}

/** Every element in the tree, depth first. */
function walk(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  out.push(node)
  for (const child of node.children ?? []) walk(child, out)
  return out
}

/** The text content of an element, concatenated. */
function textOf(node) {
  if (typeof node === 'string') return node
  if (node === null || node === undefined || typeof node !== 'object') return ''
  return (node.children ?? []).map(textOf).join(' ')
}

const noop = () => {}

function render(report, overrides = {}, handlers = {}) {
  return loaded.renderPanel(
    loaded.react,
    {
      t: translator(),
      locale: 'zh',
      status: 'ready',
      error: null,
      report,
      trash: null,
      thresholdDays: 30,
      view: 'audit',
      selected: new Set(),
      busy: null,
      notice: null,
      reviewOpen: new Set(),
      collapsed: new Set(),
      ...overrides,
    },
    {
      toggle: noop,
      toggleReview: noop,
      toggleGroup: noop,
      toggleTier: noop,
      toggleArtifactFold: noop,
      selectSafe: noop,
      selectSafeArtifacts: noop,
      clearSelection: noop,
      setThresholdDays: noop,
      setView: noop,
      refresh: noop,
      cleanUp: noop,
      cleanFamily: noop,
      ...handlers,
    },
  )
}

/** One row as the panel rendered it: its selectability, its tier and the text beside it. */
function rowById(tree, id) {
  const element = walk(tree).find((node) => node.props?.['data-dshr-row'] === id)
  if (element === undefined) return null
  const control = walk(element).find((node) => node.type === 'input')
  return {
    selectable: control?.props?.['data-dshr-selectable'],
    disabled: control?.props?.disabled,
    tier: control?.props?.['data-dshr-tier'],
    text: textOf(element),
  }
}

/** A report carrying only what these tests are about. */
function reportWith({ caches = {}, attachments = {}, sessions = {} }) {
  return {
    ok: true,
    scanCount: 1,
    gate: {},
    families: [],
    totals: { totalReclaimableBytes: 0, sessionCount: 0, dedupAttachmentCount: 0 },
    tiers: {
      sessions: { safe: [], confirm: [], danger: [], unclassified: [], ...sessions },
      attachments: { safe: [], confirm: [], danger: [], unclassified: [], ...attachments },
      caches: { safe: [], confirm: [], danger: [], unclassified: [], reportOnly: [], ...caches },
    },
  }
}

/**
 * The folds that have to be open for one artifact row to be on screen.
 *
 * The clearables card folds by tier and then by kind, so a row is rendered only when both of
 * its folds are open. Tests that are about a row open the folds that lead to it; tests that
 * are about the folds leave them shut.
 */
function foldsOpen(tier, kind) {
  return new Set(['tier:' + tier, 'kind:' + tier + ':' + kind])
}

/**
 * A session row as the server grades it, carrying whatever archive state is under test.
 *
 * `archived` is passed through verbatim — including `null` and `undefined`, because the whole
 * point of the badge is that "we could not read the archive set" must not be rendered as the
 * absence that means "not archived".
 */
function sessionRow(archived) {
  return {
    kind: 'session',
    id: 's-archived-demo',
    tier: 'safe',
    tierReasons: [],
    blockingChecks: [],
    selectable: true,
    batchClearable: true,
    dedupCount: 0,
    freedByDeletingBytes: 4096,
    freedBreakdown: {},
    facts: {
      title: 'a session with a title',
      archived,
      sizeBytes: 4096,
      lastActivity: '2026-01-01T00:00:00.000Z',
      ageDays: 41,
      workspacePath: '/home/Projects/demo',
      sessionIds: [],
    },
  }
}

/** The archive badge inside one row, found by the data attribute the badge carries. */
function archivedBadgeOf(tree, id) {
  const row = walk(tree).find((node) => node.props?.['data-dshr-row'] === id)
  if (row === undefined) return null
  return walk(row).find((node) => node.props?.['data-dshr-archived'] !== undefined) ?? null
}

const SAFE_FAMILY = {
  kind: 'cache-family',
  id: 'cache-family:request-images',
  cacheKind: 'derived-request-images',
  tier: 'safe',
  tierReasons: [],
  blockingChecks: [],
  selectable: true,
  batchClearable: true,
  facts: { path: '/home/.dsh/cache/attachments/request-images', bytes: 2048, files: 4, regenerable: true, enumerated: true, reason: null },
  bytes: 2048,
}

const BLOCKED_FAMILY = {
  kind: 'cache-family',
  id: 'cache-family:tmp',
  cacheKind: 'staging-leftovers',
  tier: 'unclassified',
  tierReasons: ['cache-family-not-enumerated'],
  blockingChecks: [
    { ok: false, code: 'cache-family-not-enumerated', message: 'the family could not be enumerated', detail: { reason: 'EACCES' } },
  ],
  selectable: false,
  batchClearable: false,
  facts: { path: '/home/.dsh/cache/attachments/tmp', bytes: 0, files: 0, regenerable: true, enumerated: false, reason: 'EACCES' },
  bytes: 0,
}

const REPORT_ONLY_FAMILY = {
  kind: 'report-only-family',
  id: 'report-only:files',
  tier: 'reportOnly',
  reason: 'this family has no cleanup entry',
  selectable: false,
  batchClearable: false,
  facts: { path: '/home/.dsh/attachments/v1/files', bytes: 512, files: 2, enumerated: true, reportOnly: true },
  bytes: 512,
}

const DANGER_ATTACHMENT = {
  kind: 'attachment',
  id: 'sha256-aaaa',
  tier: 'danger',
  tierReasons: ['referenced-by-session'],
  blockingChecks: [
    { ok: false, code: 'referenced-by-session', message: 'still referenced by a session', detail: { sessionIds: ['s-1'] } },
  ],
  selectable: false,
  batchClearable: false,
  facts: { paths: ['/home/.dsh/attachments/v1/objects/aa/bb'], bytes: 4096, sessionIds: ['s-1'] },
  bytes: 4096,
}

test('a cache row the server graded clearable gets a usable checkbox', () => {
  const tree = render(reportWith({ caches: { safe: [SAFE_FAMILY] } }), {
    openArtifacts: foldsOpen('safe', 'cache-family'),
  })
  const row = rowById(tree, 'cache-family:request-images')
  assert.notEqual(row, null, 'the clearable cache family was not rendered at all')
  assert.equal(row.selectable, 'true')
  assert.equal(row.disabled, false)
  assert.equal(row.tier, 'safe')
  assert.match(row.text, /可重建缓存族/)
  assert.match(row.text, /2\.0 KB/)
})

test('a cache row that could not be enumerated is listed, refused, and says why', () => {
  const tree = render(reportWith({ caches: { unclassified: [BLOCKED_FAMILY] } }), {
    openArtifacts: foldsOpen('unclassified', 'cache-family'),
  })
  const row = rowById(tree, 'cache-family:tmp')
  assert.notEqual(row, null, 'the blocked cache family was hidden instead of explained')
  assert.equal(row.selectable, 'false')
  assert.equal(row.disabled, true)
  assert.match(row.text, /这一族没能枚举/)
})

test('a report-only family is shown as reported, never as clearable', () => {
  const tree = render(reportWith({ caches: { reportOnly: [REPORT_ONLY_FAMILY] } }), {
    openArtifacts: foldsOpen('reportOnly', 'report-only-family'),
  })
  const row = rowById(tree, 'report-only:files')
  assert.notEqual(row, null)
  assert.equal(row.selectable, 'false')
  assert.match(row.text, /只报告/)
})

test('an attachment still referenced by a session is never offered for clearing', () => {
  const tree = render(reportWith({ attachments: { danger: [DANGER_ATTACHMENT] } }), {
    openArtifacts: foldsOpen('danger', 'attachment'),
  })
  const row = rowById(tree, 'sha256-aaaa')
  assert.notEqual(row, null, 'the attachment was not rendered')
  assert.equal(row.selectable, 'false')
  assert.equal(row.disabled, true)
  assert.match(row.text, /仍被会话引用/)
})

test('with nothing to show the clearables card is absent, not empty', () => {
  const tree = render(reportWith({}))
  assert.equal(walk(tree).some((node) => node.props?.['data-dshr-clearables'] === 'true'), false)
})

test('companion mode banner is rendered at the top of the panel', () => {
  const tree = render(reportWith({}))
  const companionNode = walk(tree).find((node) => node.props?.['data-dshr-companion'] === 'true')
  assert.notEqual(companionNode, null, 'companion card must be rendered')
  const text = textOf(companionNode)
  assert.match(text, /伴生协同/)
  assert.match(text, /@michengai\/dsh-archive-manager/)
})

test('an archived session wears a badge beside its title, not a word among the metrics', () => {
  const tree = render(reportWith({ sessions: { safe: [sessionRow(true)] } }))
  const badge = archivedBadgeOf(tree, 's-archived-demo')
  assert.notEqual(badge, null, 'the archived session rendered no archive badge at all')
  assert.match(String(badge.props.className), /dshr-badge-archived(\s|$)/)
  assert.equal(textOf(badge), '已归档')

  // Beside the title, not behind the time: the badge is a sibling of the title span and
  // comes before the right-aligned clock.
  const row = walk(tree).find((node) => node.props?.['data-dshr-row'] === 's-archived-demo')
  const head = walk(row).find((node) => node.props?.className === 'dshr-row-head')
  const order = (head?.children ?? []).map((child) => child?.props?.className ?? null)
  assert.ok(
    order.indexOf('dshr-row-title') < order.findIndex((name) => typeof name === 'string' && name.includes('dshr-badge-archived')),
    `the archive badge is not beside the title: ${JSON.stringify(order)}`,
  )
})

test('an unarchived session shows no archive badge, and does not claim one either way', () => {
  const tree = render(reportWith({ sessions: { safe: [sessionRow(false)] } }))
  assert.equal(archivedBadgeOf(tree, 's-archived-demo'), null, 'an unarchived session wore an archive badge')
  const row = rowById(tree, 's-archived-demo')
  assert.doesNotMatch(row.text, /已归档/)
  assert.doesNotMatch(row.text, /归档状态未知/)
})

test('an archive state that could not be read says unknown, never "not archived"', () => {
  for (const unreadable of [null, undefined]) {
    const tree = render(reportWith({ sessions: { safe: [sessionRow(unreadable)] } }))
    const badge = archivedBadgeOf(tree, 's-archived-demo')
    assert.notEqual(badge, null, `archived=${String(unreadable)} rendered no badge, which reads as "not archived"`)
    assert.match(String(badge.props.className), /dshr-badge-archived-unknown/)
    assert.equal(textOf(badge), '归档状态未知')
    assert.doesNotMatch(rowById(tree, 's-archived-demo').text, /已归档/)
  }
})

test('the clearables card and the session tiers are separate surfaces', () => {
  const tree = render(reportWith({ caches: { safe: [SAFE_FAMILY] } }))
  const cards = walk(tree).filter((node) => node.props?.['data-dshr-clearables'] === 'true')
  assert.equal(cards.length, 1)
  // The session tiers are their own card: a cache row must not be able to arrive inside one.
  const tierElements = walk(tree).filter((node) => node.props?.['data-dshr-tier'] === 'safe')
  for (const tier of tierElements) {
    assert.equal(walk(tier).some((node) => node.props?.['data-dshr-row'] === 'cache-family:request-images'), false)
  }
})

test('the panel dates the facts it shows, and dates them with the scan that read them', () => {
  const scannedAt = '2026-01-02T03:04:05.000Z'
  const tree = render({ ...reportWith({}), scannedAt, generatedAt: '2026-01-02T09:00:00.000Z' })
  const stamp = walk(tree).find((node) => node.props?.['data-dshr-as-of'] !== undefined)
  assert.notEqual(stamp, undefined, 'a dated report rendered no as-of line')
  // The scan instant, not the grading instant: `generatedAt` is always "now", so rendering it
  // here would tell the user the facts are fresher than they are.
  assert.equal(stamp.props['data-dshr-as-of'], scannedAt)
  const clock = loaded.formatClock(scannedAt)
  assert.match(clock, /^\d{2}:\d{2}:\d{2}$/)
  assert.equal(textOf(stamp), `数据截至 ${clock}`)
})

test('a report that carries no scan instant is left undated rather than dated now', () => {
  for (const missing of [undefined, null]) {
    const tree = render({ ...reportWith({}), scannedAt: missing })
    const stamp = walk(tree).find((node) => node.props?.['data-dshr-as-of'] !== undefined)
    assert.equal(stamp, undefined, `scannedAt=${String(missing)} was rendered as a date the report does not have`)
    assert.doesNotMatch(textOf(tree), /数据截至/)
  }
})

test('a clock is only rendered for an instant that can actually be parsed', () => {
  assert.equal(loaded.formatClock('not a date'), null)
  assert.equal(loaded.formatClock(undefined), null)
  assert.equal(loaded.formatClock(null), null)
  assert.equal(loaded.formatClock(''), null)
})

/**
 * A pending report, as the route answers a `preview=1` request.
 *
 * The rows are real rows — title, size, age, archive badge — but every verdict that depends
 * on the reference graph has been withdrawn by the server: the tier is `pending`, the row is
 * not selectable, and the graph-derived numbers are null rather than zero.
 */
function pendingReport() {
  const row = sessionRow(true)
  row.pending = true
  row.tier = 'pending'
  row.selectable = false
  row.batchClearable = false
  row.dedupCount = null
  row.freedByDeletingBytes = null
  row.freedBreakdown = {}
  const report = reportWith({})
  report.pending = true
  report.sessions = [row]
  report.tiers.sessions = { pending: [row] }
  return report
}

test('a pending paint shows the rows and their archive badges, and claims no tier', () => {
  const tree = render(pendingReport())

  const card = walk(tree).find((node) => node.props?.['data-dshr-pending'] === 'true')
  assert.notEqual(card, undefined, 'a pending report rendered no pending surface')

  // The row is there, with the two things the paint exists to show: the title and the badge.
  const row = rowById(tree, 's-archived-demo')
  assert.notEqual(row, null, 'a pending paint dropped its rows')
  assert.equal(row.tier, 'pending')
  assert.equal(row.selectable, 'false')
  assert.equal(row.disabled, true)
  assert.match(row.text, /a session with a title/)
  assert.equal(textOf(archivedBadgeOf(tree, 's-archived-demo')), '已归档')

  // No verdict may be drawn: safe/confirm/danger are answers, and the graph has not been read.
  const headings = walk(tree)
    .filter((node) => node.type === 'h4')
    .map((node) => textOf(node))
  assert.equal(headings.some((text) => /安全|需确认|危险/.test(text)), false, `a pending paint drew a verdict: ${JSON.stringify(headings)}`)
  assert.ok(headings.some((text) => /判定中/.test(text)), 'the pending surface is not labelled as pending')
})

test('a pending paint offers nothing to clean up, and no numbers it has not read', () => {
  const tree = render(pendingReport())

  assert.equal(
    walk(tree).some((node) => node.props?.['data-dshr-clean-selected'] === 'true'),
    false,
    'a pending paint offered the cleanup button, so the gap before the grade is actionable',
  )
  // The clearable-artifact card is graded from the graph too, so it is absent rather than empty.
  assert.equal(walk(tree).some((node) => node.props?.['data-dshr-clearables'] === 'true'), false)
  assert.match(textOf(tree), /参考图读完前不提供任何隔离操作/)

  // Zero would read as "nothing is reclaimable"; unknown is the only honest value here.
  const net = walk(tree).find((node) => node.props?.['data-dshr-net'] !== undefined)
  assert.equal(net.props['data-dshr-net'], 'pending')
  assert.equal(textOf(net), '—')
  assert.match(textOf(tree), /参考图读取中/)
})

test('a pending row states the size and age it does know, and marks the rest pending', () => {
  const row = rowById(render(pendingReport()), 's-archived-demo')
  assert.match(row.text, /4\.0 KB|4 KB|4096/)
  assert.match(row.text, /判定中/)
  // The graph-derived metrics are gone rather than zeroed.
  assert.doesNotMatch(row.text, /张图片/)
  assert.doesNotMatch(row.text, /删掉可释放/)
  assert.doesNotMatch(row.text, /共享未释放/)
})

test('only an explicit rescan asks the route to re-read the disk', () => {
  const cached = loaded.classifyUrl(30, false)
  assert.match(cached, /thresholdDays=30/)
  assert.doesNotMatch(cached, /rescan=1/, 'opening the panel would rebuild the world it already has')

  const rescanned = loaded.classifyUrl(7, true)
  assert.match(rescanned, /thresholdDays=7/)
  assert.match(rescanned, /rescan=1/)

  // Changing the risk dial re-grades facts already in memory; it never re-reads session logs.
  assert.doesNotMatch(loaded.classifyUrl(90), /rescan=1/)
})

test('a cached open is followed by a real read, and a cached dial change is not', () => {
  const cached = { factsFromCache: true }
  const fresh = { factsFromCache: false }

  assert.equal(loaded.shouldRescanAfter(cached, 'open'), true, 'the open must not rest on a cached picture')
  assert.equal(loaded.shouldRescanAfter(fresh, 'open'), false, 'a paint that was already a fresh read would scan twice')
  // The rule `lib/config.js` records: "changing 30 → 7 is a re-grade of facts already in
  // memory, never a rescan". Freshness cannot decide this — what asked for the answer does.
  assert.equal(loaded.shouldRescanAfter(cached, 'threshold'), false, 'the risk dial re-read the disk')
  assert.equal(loaded.shouldRescanAfter(fresh, 'threshold'), false)
  // A failed request rendered nothing, so there is no picture to replace.
  assert.equal(loaded.shouldRescanAfter(null, 'open'), false)
  assert.equal(loaded.shouldRescanAfter(undefined, 'open'), false)
})

/**
 * An uploaded file as the server grades it.
 *
 * Only `files`/`file-objects` rows are uploads; `objects` rows are images and are excluded
 * from the preview (the row's own image count already covers them). `sessionIds` is the
 * reference list the grader produced — a length above one means shared.
 */
function uploadRow({
  id = 'f'.repeat(64),
  name = 'contract.docx',
  bytes = 1024,
  families = ['files', 'file-objects'],
  sessionIds = ['s-archived-demo'],
  tier = 'safe',
} = {}) {
  return {
    kind: 'attachment',
    id,
    tier,
    tierReasons: [],
    blockingChecks: [],
    selectable: true,
    batchClearable: true,
    dedupCount: sessionIds.length,
    freedByDeletingBytes: bytes,
    freedBreakdown: {},
    bytes,
    facts: {
      paths: [
        `/home/.dsh/attachments/v1/files/60/${id}/${name}`,
        `/home/.dsh/attachments/v1/file-objects/60/${id}`,
      ],
      families,
      name,
      sessionIds,
    },
  }
}

function uploadsToggleOf(tree, id) {
  return walk(tree).find((node) => node.props?.['data-dshr-uploads-toggle'] === id) ?? null
}

function uploadsListOf(tree, id) {
  return walk(tree).find((node) => node.props?.['data-dshr-uploads'] === id) ?? null
}

test('a session row carries a disclosure that counts its exclusive upload files', () => {
  const row = sessionRow(false)
  const tree = render(reportWith({ sessions: { safe: [row] }, attachments: { safe: [uploadRow()] } }))
  const toggle = uploadsToggleOf(tree, 's-archived-demo')
  assert.notEqual(toggle, null, 'the session row offered no way to preview its uploads')
  assert.equal(toggle.props['aria-expanded'], false)
  assert.match(textOf(toggle), /上传文件 1/)
  // Collapsed by default: the preview must not push the tier apart before it is asked for.
  assert.equal(uploadsListOf(tree, 's-archived-demo'), null)
})

test('expanding a row itemises name, size and the path under the attachments root', () => {
  const row = sessionRow(false)
  const attachment = uploadRow({ name: '季度报告.docx', bytes: 34800 })
  const tree = render(
    reportWith({ sessions: { safe: [row] }, attachments: { safe: [attachment] } }),
    { uploadOpen: new Set(['s-archived-demo']) },
  )
  const toggle = uploadsToggleOf(tree, 's-archived-demo')
  assert.equal(toggle.props['aria-expanded'], true)
  const list = uploadsListOf(tree, 's-archived-demo')
  assert.notEqual(list, null, 'expanding the toggle rendered no list')
  const text = textOf(list)
  assert.match(text, /季度报告\.docx/)
  assert.match(text, /34\.0 KB/)
  assert.match(text, /files\/60\//, 'the path shown is not the one under attachments/v1')
  assert.doesNotMatch(text, /\/home\//, 'the absolute path (and the home directory) leaked into the list')
  // The absolute path survives as the tooltip, which is what Finder and copy-paste need.
  const item = walk(list).find((node) => node.props?.['data-dshr-upload'] === attachment.id)
  assert.match(item.props.title, /^\/home\/\.dsh\/attachments\/v1\/files\//)
})

test('the preview shows the five largest first, then folds the rest with a count', () => {
  const row = sessionRow(false)
  const attachments = []
  for (let index = 1; index <= 7; index += 1) {
    attachments.push(uploadRow({ id: String(index).padStart(64, '0'), name: `f${index}.bin`, bytes: index * 100 }))
  }
  const report = reportWith({ sessions: { safe: [row] }, attachments: { safe: attachments } })
  const folded = textOf(uploadsListOf(render(report, { uploadOpen: new Set(['s-archived-demo']) }), 's-archived-demo'))
  assert.match(folded, /共 2\.7 KB/)
  assert.match(folded, /还有 2 个/)
  // Largest first: f7…f3 are on screen, f2 and f1 are folded away.
  for (const name of ['f7.bin', 'f6.bin', 'f5.bin', 'f4.bin', 'f3.bin']) assert.match(folded, new RegExp(name.replace('.', '\\.')))
  assert.doesNotMatch(folded, /f2\.bin/)
  assert.doesNotMatch(folded, /f1\.bin/)

  const expanded = textOf(
    uploadsListOf(render(report, { uploadOpen: new Set(['s-archived-demo']), uploadAll: new Set(['s-archived-demo']) }), 's-archived-demo'),
  )
  assert.doesNotMatch(expanded, /还有/)
  assert.match(expanded, /f1\.bin/)
  assert.match(expanded, /收起/)
})

test('a session with no exclusive uploads says so instead of showing zero silently', () => {
  const row = sessionRow(false)
  const tree = render(reportWith({ sessions: { safe: [row] } }), { uploadOpen: new Set(['s-archived-demo']) })
  assert.match(textOf(uploadsListOf(tree, 's-archived-demo')), /本会话没有独占的上传文件/)
  assert.match(textOf(uploadsToggleOf(tree, 's-archived-demo')), /上传文件 0/)
})

test('a shared upload is counted but not listed, because deleting either session frees none of it', () => {
  const row = sessionRow(false)
  const tree = render(
    reportWith({ sessions: { safe: [row] }, attachments: { safe: [uploadRow({ name: 'shared.pdf', sessionIds: ['s-archived-demo', 's-other'] })] } }),
    { uploadOpen: new Set(['s-archived-demo']) },
  )
  const text = textOf(uploadsListOf(tree, 's-archived-demo'))
  assert.match(text, /本会话没有独占的上传文件/)
  assert.match(text, /共享未释放 1 张/)
  assert.doesNotMatch(text, /shared\.pdf/)
})

test('images are not uploads: an objects row never enters the list', () => {
  const row = sessionRow(false)
  const image = uploadRow({ name: 'shot.png', families: ['objects'] })
  const tree = render(reportWith({ sessions: { safe: [row] }, attachments: { safe: [image] } }))
  assert.match(textOf(uploadsToggleOf(tree, 's-archived-demo')), /上传文件 0/)
})

test('a live session still previews, and says the files cannot be deleted yet', () => {
  const row = sessionRow(false)
  row.facts.livenessState = 'running'
  const tree = render(
    reportWith({ sessions: { danger: [row] }, attachments: { danger: [uploadRow({ tier: 'danger' })] } }),
    // The danger tier starts folded; this test is about the row behind the fold, so it opens it.
    { uploadOpen: new Set(['s-archived-demo']), openTiers: new Set(['safe', 'danger']) },
  )
  assert.notEqual(uploadsToggleOf(tree, 's-archived-demo'), null, 'a live session row lost its preview')
  assert.match(textOf(uploadsListOf(tree, 's-archived-demo')), /正在使用，不可删/)
})

test('a pending row offers no preview: its attachments have not been graded at all', () => {
  const tree = render(pendingReport())
  assert.equal(uploadsToggleOf(tree, 's-archived-demo'), null)
})

test('a finished run reports its three counts where the click happened', () => {
  const run = {
    total: 3,
    moved: 1,
    failed: 1,
    already: 1,
    failures: [{ id: 'deadbeefdeadbeef', codes: ['permission-denied'], reason: 'permission denied by the filesystem' }],
    quarantined: [{ id: 'q', batchId: 'b', createdAt: null }],
  }
  const tree = render(reportWith({ sessions: { safe: [sessionRow(false)] } }), { run })
  const card = walk(tree).find((node) => node.props?.['data-dshr-run'] !== undefined)
  assert.notEqual(card, undefined, 'a finished run rendered no result card')
  assert.equal(card.props['data-dshr-run'], '1:1:1')
  assert.equal(card.props.role, undefined, 'the card is not itself the live region')

  // The announcement comes from a region that was already in the tree, not from a node
  // inserted with its text — the latter is commonly not announced at all.
  const announcer = walk(tree).find((node) => node.props?.['data-dshr-announcer'] !== undefined)
  assert.notEqual(announcer, undefined)
  assert.equal(announcer.props.role, 'status')
  assert.equal(announcer.props['aria-live'], 'polite')
  assert.match(textOf(announcer), /已隔离 1 项，失败 1 项，已在隔离区 1 项/)

  const idle = walk(render(reportWith({ sessions: { safe: [sessionRow(false)] } }))).find(
    (node) => node.props?.['data-dshr-announcer'] !== undefined,
  )
  assert.notEqual(idle, undefined, 'the live region must exist before the first run')
  assert.equal(textOf(idle), '')

  const text = textOf(card)
  assert.match(text, /已隔离 1 项/)
  assert.match(text, /失败 1 项/)
  assert.match(text, /已在隔离区 1 项/)

  const details = walk(card).find((node) => node.type === 'details')
  assert.notEqual(details, undefined, 'the failure reason had no expander')
  assert.match(textOf(details.children[0]), /失败原因 \(1\)/)
  assert.match(text, /deadbeef/)
  assert.match(text, /permission denied by the filesystem/)
})

test('the result card offers the quarantine view instead of navigating there', () => {
  const views = []
  const run = { total: 1, moved: 1, failed: 0, already: 0, failures: [], quarantined: [{ id: 'q', batchId: 'b', createdAt: null }] }
  const tree = render(
    reportWith({ sessions: { safe: [sessionRow(false)] } }),
    { run },
    { setView: (view) => views.push(view) },
  )

  const card = walk(tree).find((node) => node.props?.['data-dshr-run'] !== undefined)
  assert.equal(card.props['data-dshr-run'], '1:0:0')
  const button = walk(card).find((node) => node.props?.['data-dshr-run-bin'] !== undefined)
  assert.notEqual(button, undefined, 'no way to open the quarantine from the result card')
  assert.match(textOf(button), /查看隔离区/)
  assert.deepEqual(views, [], 'rendering the card must not navigate by itself')
  button.props.onClick()
  assert.deepEqual(views, ['bin'])
})

test('a row a run proved unactionable is shown disabled with its reason', () => {
  const tree = render(reportWith({ sessions: { safe: [sessionRow(false)] } }), {
    unavailable: new Map([['s-archived-demo', 'row.inQuarantine']]),
  })
  const row = rowById(tree, 's-archived-demo')
  assert.equal(row.selectable, 'false')
  assert.equal(row.disabled, true)
  assert.match(row.text, /已在隔离区/)
  assert.notEqual(walk(tree).find((node) => node.props?.['data-dshr-unavailable-badge'] !== undefined), undefined)
})


test('the same batch submitted twice reads as "already in the quarantine", not as nine failures', () => {
  // The field report behind #22: nine sessions were submitted, eight had already been moved
  // and the ninth had been deleted outright. Submitting them again must not read as
  // "0 of 9, 9 failed" — eight are recoverable in the quarantine, one is simply gone.
  const moved = 'aaaaaaaa-0000-0000-0000-000000000000'
  const gone = 'bbbbbbbb-0000-0000-0000-000000000000'
  const results = [
    ...Array.from({ length: 8 }, () => ({
      id: moved,
      ok: false,
      body: {
        ok: false,
        sourceGone: true,
        alreadyInQuarantine: { batchId: '2026-11-04T11-19-58', createdAt: '2026-11-04T11:19:58.000Z' },
        plan: { blockers: [{ code: 'session-dir-not-found' }] },
      },
    })),
    {
      id: gone,
      ok: false,
      body: {
        ok: false,
        sourceGone: true,
        alreadyInQuarantine: null,
        plan: { blockers: [{ code: 'session-dir-not-found' }] },
      },
    },
  ]

  const summary = loaded.summarizeRun(results)
  assert.equal(summary.total, 9)
  assert.equal(summary.moved, 0, 'nothing moved on the second submission')
  assert.equal(summary.already, 8, 'eight were already in the quarantine')
  assert.equal(summary.failed, 1, 'only the deleted one failed')
  assert.equal(summary.quarantined.length, 8)
  // The panel's arrays come from the bundle's own realm, so they are copied out before they
  // are compared: an array built inside the vm is not the same kind of array as one built here.
  assert.deepEqual(Array.from(summary.failures, (failure) => failure.id), [gone])
  assert.deepEqual(Array.from(summary.failures[0].codes), ['session-dir-not-found'])

  // The rows that run proved unactionable leave the selectable set, so the panel cannot offer
  // the very click that just failed.
  const unavailable = loaded.unavailableFromRun(summary)
  assert.equal(unavailable.get(moved), 'row.inQuarantine')
  assert.equal(unavailable.get(gone), 'row.sourceGone')

  const report = reportWith({ sessions: { safe: [tierRow(moved, 'safe'), tierRow(gone, 'safe')] } })
  assert.deepEqual(Array.from(loaded.selectableSafeIds(report, unavailable)), [])
})


test('the copy in this bundle and the shared dictionary agree on the renamed actions', () => {
  // `lib/client.js` carries a hand-written copy of the copy (`INLINE_MESSAGES`), because the
  // host's locale service may answer with the key itself and `t()` then falls back to it. Two
  // copies that must agree is a bug factory: #23 renamed the same 38 entries in both, and this
  // is the assertion that notices when only one of them is edited next time.
  const inline = loaded.plugin.__messages.PANEL_MESSAGES
  const params = { count: 3, moved: 1, failed: 0, already: 1, size: '1.0 MB', reason: 'boom' }

  assert.deepEqual(
    Object.keys(inline.zh).sort(),
    Object.keys(inline.en).sort(),
    'the inline dictionaries disagree with each other',
  )

  const renamed = [
    'action.cleanSelected',
    'action.cleaning',
    'action.pendingNote',
    'bin.destroyTitle',
    'bin.destroy',
    'bin.destroying',
    'run.moved',
    'run.failed',
    'run.already',
    'run.announce',
  ]
  for (const key of renamed) {
    for (const locale of ['zh', 'en']) {
      const fromBundle = loaded.plugin.__messages.translatePanel(locale, key, params)
      const fromShared = translatePanel(locale, key, params)
      assert.notEqual(fromShared, key, `${locale}:${key} is missing from lib/messages.js`)
      assert.equal(fromBundle, fromShared, `${locale}:${key} drifted between lib/client.js and lib/messages.js`)
    }
  }

  // The whole `clear.*` family belongs to the clearables card, and it is long enough that a
  // partial check would let half of it drift between the two copies.
  const clearKeys = Object.keys(inline.zh).filter((key) => key.startsWith('clear.'))
  assert.ok(clearKeys.length > 0, 'the inline dictionary has no clear.* keys to compare')
  for (const key of clearKeys) {
    for (const locale of ['zh', 'en']) {
      const fromBundle = loaded.plugin.__messages.translatePanel(locale, key, params)
      const fromShared = translatePanel(locale, key, params)
      assert.notEqual(fromShared, key, `${locale}:${key} is missing from lib/messages.js`)
      assert.equal(fromBundle, fromShared, `${locale}:${key} drifted between lib/client.js and lib/messages.js`)
    }
  }


  // The same goes for the `reason.*` family. The result bar explains a refusal by its code,
  // so a code only one copy can translate is a refusal the user reads as an English sentence
  // in a Chinese panel - which is what happened to `session-dir-not-found` in #18.
  const reasonKeys = Object.keys(inline.zh).filter((key) => key.startsWith('reason.'))
  assert.ok(reasonKeys.length > 0, 'the inline dictionary has no reason.* keys to compare')
  for (const key of reasonKeys) {
    for (const locale of ['zh', 'en']) {
      const fromBundle = loaded.plugin.__messages.translatePanel(locale, key, params)
      const fromShared = translatePanel(locale, key, params)
      assert.notEqual(fromShared, key, `${locale}:${key} is missing from lib/messages.js`)
      assert.equal(fromBundle, fromShared, `${locale}:${key} drifted between lib/client.js and lib/messages.js`)
    }
  }
  // And the retired words are not hiding in this copy either.
  const retired = ['彻底清空', '清理所选', '搬运中', '已搬走', '仍要清理']
  for (const key of Object.keys(inline.zh)) {
    const text = loaded.plugin.__messages.translatePanel('zh', key, params)
    for (const word of retired) {
      assert.ok(!text.includes(word), `zh:${key} still says "${word}": ${text}`)
    }
  }
})

/** One batch exactly as `listBatches` describes it to the panel. */
function binBatch(overrides = {}) {
  return {
    kind: 'ok',
    batchId: 'b1',
    batchDir: '/home/.dsh-reclaim-trash/b1',
    createdAt: '2026-02-01T00:00:00.000Z',
    entries: 7,
    sessionIds: ['s-1'],
    files: 30,
    bytes: 1048576,
    reason: null,
    ...overrides,
  }
}

/** One batch's permanent-delete outcome, as the panel keeps it after the click. */
function receipt(overrides = {}) {
  return {
    batchId: 'b1',
    ok: true,
    entries: 7,
    files: 30,
    bytes: 1048576,
    failures: [],
    reason: null,
    at: '2026-02-01T00:00:01.000Z',
    ...overrides,
  }
}

test('a batch being permanently deleted says what it is deleting and that it cannot be stopped', () => {
  // The server deletes a batch in one verified tree walk, so there is no per-item progress to
  // paint and no way to cancel it. What the row can honestly say is the size it is working on
  // and the fact that the click already committed it.
  const tree = render(reportWith({}), { view: 'bin', trash: { ok: true, batches: [binBatch()] }, busy: 'purge:b1' })
  const row = walk(tree).find((node) => node.props?.['data-dshr-batch'] === 'b1')
  assert.notEqual(row, undefined, 'the batch being purged vanished from the list')
  assert.equal(row.props['aria-busy'], 'true')
  assert.match(textOf(row), /正在彻底删除… 共 7 项 · 1\.0 MB；开始后无法取消。/)
  assert.notEqual(
    walk(row).find((node) => String(node.props?.className ?? '').includes('dshr-spinner')),
    undefined,
    'a running purge showed no activity indicator',
  )
  const destroy = walk(row).find((node) => node.props?.['data-dshr-destructive'] !== undefined)
  assert.equal(destroy.props.disabled, true, 'a second click could start a second purge')
  assert.match(textOf(destroy), /正在彻底删除…/)

  const announcer = walk(tree).find((node) => node.props?.['data-dshr-announcer'] !== undefined)
  assert.match(textOf(announcer), /正在彻底删除 7 项（1\.0 MB）…/)
})

test('a finished purge leaves its numbers behind after the batch itself is gone', () => {
  // The reload a purge triggers replaces the batch list, and a successful purge removes the
  // batch it describes. Keeping the outcome in that list would erase it at the moment it
  // becomes true; the record is separate state for this reason.
  const tree = render(reportWith({}), { view: 'bin', trash: { ok: true, batches: [] }, receipts: [receipt()] })
  const card = walk(tree).find((node) => node.props?.['data-dshr-purge-result'] === 'b1:ok')
  assert.notEqual(card, undefined, 'the outcome of a purge disappeared when its batch did')
  assert.match(textOf(card), /已删除 7 项 · 1\.0 MB（30 个文件）/)

  const summary = walk(tree).find((node) => node.props?.['data-dshr-purge-summary'] !== undefined)
  assert.equal(summary.props['data-dshr-purge-summary'], '1:7:1048576')
  assert.match(textOf(summary), /本次已彻底删除 1 批 · 7 项 · 1\.0 MB/)

  const announcer = walk(tree).find((node) => node.props?.['data-dshr-announcer'] !== undefined)
  assert.match(textOf(announcer), /本批已彻底删除 7 项（1\.0 MB）。/)
})

test('a batch that failed to clear keeps its reasons and is not counted as deleted', () => {
  const failed = receipt({
    batchId: 'b2',
    ok: false,
    entries: 0,
    files: 3,
    bytes: 0,
    failures: ['/p/a (unlink EACCES)', '/p/b (rmdir EBUSY)'],
    reason: 'leftovers',
  })
  const tree = render(reportWith({}), {
    view: 'bin',
    trash: { ok: true, batches: [binBatch({ batchId: 'b2', kind: 'incomplete', reason: 'manifest says incomplete', entries: 5 })] },
    receipts: [failed],
  })

  const card = walk(tree).find((node) => node.props?.['data-dshr-purge-result'] === 'b2:fail')
  assert.notEqual(card, undefined)
  assert.match(textOf(card), /未完全删除/)
  const details = walk(card).find((node) => node.type === 'details')
  assert.notEqual(details, undefined, 'the failure had no expander')
  assert.match(textOf(details.children[0]), /失败位置 \(2\)/)
  assert.match(textOf(details), /unlink EACCES/)

  const summary = walk(tree).find((node) => node.props?.['data-dshr-purge-summary'] !== undefined)
  assert.equal(summary.props['data-dshr-purge-summary'], '0:0:0', 'a failed batch was counted as deleted space')
  assert.match(textOf(summary), /本次已彻底删除 0 批 · 0 项/)
  assert.match(textOf(summary), /另有 1 批未完全删除/)

  // The batch is still listed (nothing was deleted), so its row keeps the destructive action.
  const row = walk(tree).find((node) => node.props?.['data-dshr-batch'] === 'b2')
  assert.notEqual(row, undefined)
  assert.equal(walk(row).find((node) => node.props?.['data-dshr-destructive'] !== undefined).props.disabled, false)
})

test('the session-wide tally can be cleared without touching the quarantine', () => {
  let cleared = 0
  const tree = render(
    reportWith({}),
    { view: 'bin', trash: { ok: true, batches: [binBatch()] }, receipts: [receipt()] },
    {
      clearReceipts: () => {
        cleared += 1
      },
    },
  )
  const button = walk(tree).find((node) => node.props?.['data-dshr-purge-clear'] !== undefined)
  assert.notEqual(button, undefined)
  assert.match(textOf(button), /清除本次记录/)
  button.props.onClick()
  assert.equal(cleared, 1)
})

test('a retried batch replaces its earlier outcome instead of counting it twice', () => {
  const once = loaded.rememberReceipt([], receipt())
  const twice = loaded.rememberReceipt(once, receipt({ ok: false, at: '2026-02-01T00:00:02.000Z' }))
  assert.equal(twice.length, 1, 'the same batch was recorded twice')
  assert.equal(twice[0].ok, false, 'the newer outcome did not replace the older one')

  const other = loaded.rememberReceipt(twice, receipt({ batchId: 'b9' }))
  assert.equal(other.length, 2)
  const totals = loaded.summarizeReceipts(other)
  // Field by field: the tally is built inside the panel's realm, so its prototype is not this
  // realm's Object.prototype and a strict deep comparison would fail on that alone.
  assert.equal(totals.batches, 1)
  assert.equal(totals.entries, 7)
  assert.equal(totals.bytes, 1048576)
  assert.equal(totals.files, 30)
  assert.equal(totals.failedBatches, 1)
})

test('the permanent-delete record belongs to the quarantine view, not the audit page', () => {
  const tree = render(reportWith({}), { view: 'audit', receipts: [receipt()] })
  assert.equal(walk(tree).find((node) => node.props?.['data-dshr-purge-result'] !== undefined), undefined)
  const announcer = walk(tree).find((node) => node.props?.['data-dshr-announcer'] !== undefined)
  assert.equal(textOf(announcer), '', 'an audit view announced a purge that is not on screen')
})

// --- #25: the selection helpers, and the tiers that start folded ---------------

/** A session row with a distinct id and tier, built from the same fixture the other tests use. */
function tierRow(id, tier, overrides = {}) {
  return { ...sessionRow(false), id, tier, ...overrides }
}

/** The fold control of one session tier, found by the attribute it carries. */
function tierToggle(tree, tier) {
  return walk(tree).find((node) => node.props?.['data-dshr-tier-toggle'] === tier) ?? null
}

/** The two selection helpers in the action bar, found by their attributes. */
function buttonBy(tree, attribute) {
  return walk(tree).find((node) => node.type === 'button' && node.props?.[attribute] !== undefined) ?? null
}

test('the safe tier starts open; confirm and danger start folded with their count still visible', () => {
  const tree = render(
    reportWith({
      sessions: {
        safe: [tierRow('s-safe', 'safe')],
        confirm: [tierRow('s-confirm', 'confirm')],
        danger: [tierRow('s-danger', 'danger')],
      },
    }),
  )

  assert.notEqual(rowById(tree, 's-safe'), null, 'the safe tier did not start open')
  assert.equal(rowById(tree, 's-confirm'), null, 'the confirm tier started open')
  assert.equal(rowById(tree, 's-danger'), null, 'the danger tier started open')

  for (const tier of ['safe', 'confirm', 'danger']) {
    const toggle = tierToggle(tree, tier)
    assert.notEqual(toggle, null, `the ${tier} tier lost its fold control`)
    assert.equal(toggle.type, 'button', `the ${tier} fold control is not a button`)
    assert.equal(toggle.props['aria-expanded'], tier === 'safe', `the ${tier} tier claims the wrong open state`)
    assert.match(textOf(toggle), /1 项/, `the folded ${tier} tier hid how many rows it holds`)
  }

  // A folded tier still says why it is folded: the header carries the short reason, so a
  // person does not have to unfold the rows to find out what they are.
  assert.match(textOf(tierToggle(tree, 'confirm')), /需逐项确认/)
  assert.match(textOf(tierToggle(tree, 'danger')), /界面不提供隔离入口/)
  assert.match(textOf(tierToggle(tree, 'safe')), /可批量隔离/)
})

test('opening a folded tier renders its rows; folding is an input, not something derived from the rows', () => {
  const report = reportWith({ sessions: { confirm: [tierRow('s-confirm', 'confirm')] } })

  const open = render(report, { openTiers: new Set(['safe', 'confirm']) })
  assert.notEqual(rowById(open, 's-confirm'), null, 'an opened tier rendered no rows')
  assert.equal(tierToggle(open, 'confirm').props['aria-expanded'], true)

  // The same report with the fold shut again: the fold state is the input's, so a reload that
  // brings back the same rows must not silently reopen a tier the user closed.
  const shut = render(report, { openTiers: new Set(['safe']) })
  assert.equal(rowById(shut, 's-confirm'), null)
  assert.equal(tierToggle(shut, 'confirm').props['aria-expanded'], false)
})

test('clicking a tier header asks the panel to toggle exactly that tier', () => {
  const seen = []
  const tree = render(reportWith({ sessions: { confirm: [tierRow('s-confirm', 'confirm')] } }), {}, {
    toggleTier: (tier) => seen.push(tier),
  })
  tierToggle(tree, 'confirm').props.onClick()
  assert.deepEqual(seen, ['confirm'])
})

test('an empty tier keeps its explanation and offers nothing to fold', () => {
  const tree = render(reportWith({}))
  assert.equal(tierToggle(tree, 'confirm'), null, 'an empty tier offered a fold control')
  assert.match(textOf(tree), /没有需要逐个确认的项/)
})

test('select-all takes exactly the safe sessions that can still be moved, and never another tier', () => {
  const report = reportWith({
    sessions: {
      safe: [
        tierRow('s-a', 'safe'),
        tierRow('s-b', 'safe'),
        // The server graded this one safe but not batch-clearable: a checkbox it refuses.
        tierRow('s-blocked', 'safe', { batchClearable: false }),
      ],
      confirm: [tierRow('s-confirm', 'confirm')],
    },
  })

  assert.deepEqual(Array.from(loaded.selectableSafeIds(report, new Map())), ['s-a', 's-b'])

  // A row the last run proved unactionable (already in the quarantine, or its directory is
  // gone) is not offered again by a button that would only fail on it.
  const unavailable = new Map([['s-a', 'row.inQuarantine']])
  assert.deepEqual(Array.from(loaded.selectableSafeIds(report, unavailable)), ['s-b'])

  // Clearable cache families and attachments are a different surface with a different route
  // (POST /clear, not POST /delete); "all safe" here means the session tiers only.
  const clearablesOnly = reportWith({ caches: { safe: [SAFE_FAMILY] }, attachments: { safe: [] } })
  assert.deepEqual(Array.from(loaded.selectableSafeIds(clearablesOnly, new Map())), [])
})

test('the bar offers select-all with its scope in the label, and disables it when nothing is left to add', () => {
  const report = reportWith({ sessions: { safe: [tierRow('s-a', 'safe'), tierRow('s-b', 'safe')] } })
  let pressed = 0
  const tree = render(report, {}, { selectSafe: () => { pressed += 1 } })
  const button = buttonBy(tree, 'data-dshr-select-safe')
  assert.notEqual(button, null, 'the select-all control is missing from the action bar')
  assert.equal(button.props.disabled, false)
  assert.equal(textOf(button), '全选安全项（2）')
  button.props.onClick()
  assert.equal(pressed, 1)

  // Everything safe already ticked: pressing again could only be a no-op, so it is not offered.
  const all = render(report, { selected: new Set(['s-a', 's-b']) }, {})
  assert.equal(buttonBy(all, 'data-dshr-select-safe').props.disabled, true)

  // No safe rows at all: the button says so instead of inviting a click that does nothing.
  const none = render(reportWith({}), {}, {})
  const empty = buttonBy(none, 'data-dshr-select-safe')
  assert.equal(empty.props.disabled, true)
  assert.equal(textOf(empty), '全选安全项（0）')
})

test('select-all and clear-selection are both off the table while a run is in flight', () => {
  const report = reportWith({ sessions: { safe: [tierRow('s-a', 'safe')] } })
  const tree = render(report, { selected: new Set(['s-a']), busy: 'clean' })
  assert.equal(buttonBy(tree, 'data-dshr-select-safe').props.disabled, true, 'select-all stayed live during a run')
  assert.equal(buttonBy(tree, 'data-dshr-clear-selection').props.disabled, true, 'clear-selection stayed live during a run')
})

test('clear-selection is offered only while something is selected, and drops the selection in one step', () => {
  const report = reportWith({ sessions: { safe: [tierRow('s-a', 'safe'), tierRow('s-b', 'safe')] } })

  const idle = buttonBy(render(report, {}, {}), 'data-dshr-clear-selection')
  assert.notEqual(idle, null, 'the clear-selection control is missing from the action bar')
  assert.equal(idle.props.disabled, true, 'clear-selection was offered with nothing selected')
  assert.equal(textOf(idle), '清除选择')

  let cleared = 0
  const some = render(report, { selected: new Set(['s-a']) }, { clearSelection: () => { cleared += 1 } })
  const button = buttonBy(some, 'data-dshr-clear-selection')
  assert.equal(button.props.disabled, false)
  button.props.onClick()
  assert.equal(cleared, 1)
  // Clearing the selection does not touch the folds or the disclosures: those are about
  // reading the list, not about what the next action would move.
  assert.equal(buttonBy(some, 'data-dshr-select-safe').props.disabled, false)
})

// --- #28: the clearables card folds by tier and by kind ------------------------

/** The fold control of one artifact tier, found by the attribute it carries. */
function artifactTierToggle(tree, tier) {
  return walk(tree).find((node) => node.props?.['data-dshr-artifact-tier-toggle'] === 'tier:' + tier) ?? null
}

/** The fold control of one artifact kind inside one tier. */
function artifactKindToggle(tree, tier, kind) {
  return walk(tree).find((node) => node.props?.['data-dshr-artifact-kind-toggle'] === 'kind:' + tier + ':' + kind) ?? null
}

test('the clearables card folds by tier and then by kind, and starts with only the safe tier open', () => {
  const tree = render(reportWith({ caches: { safe: [SAFE_FAMILY], unclassified: [BLOCKED_FAMILY] } }))

  // The safe tier opens because it is the tier the card can act on; the kind inside it starts
  // folded, so the reader sees the inventory before the rows.
  assert.equal(artifactTierToggle(tree, 'safe').props['aria-expanded'], true)
  assert.equal(artifactKindToggle(tree, 'safe', 'cache-family').props['aria-expanded'], false)
  assert.equal(rowById(tree, 'cache-family:request-images'), null, 'the kind fold did not hold its rows back')

  // A tier the card cannot act on stays shut, and its header says why it is there at all.
  assert.equal(artifactTierToggle(tree, 'unclassified').props['aria-expanded'], false)
  assert.match(textOf(artifactTierToggle(tree, 'unclassified')), /读不到或说不清的都在这里/)
})

test('a folded artifact group still says how many rows and how many bytes it holds', () => {
  const tree = render(reportWith({ caches: { safe: [SAFE_FAMILY] } }))
  const tier = artifactTierToggle(tree, 'safe')
  assert.match(textOf(tier), /1 项/)
  assert.match(textOf(tier), /2\.0 KB/)
  const kind = artifactKindToggle(tree, 'safe', 'cache-family')
  assert.match(textOf(kind), /1 项/)
  assert.match(textOf(kind), /可重建缓存族/)
})

test('a row whose size is unknown is counted as unknown, not as zero bytes', () => {
  const unknown = { ...SAFE_FAMILY, id: 'cache-family:unknown', bytes: undefined }
  const tree = render(reportWith({ caches: { safe: [SAFE_FAMILY, unknown] } }))
  assert.match(textOf(artifactKindToggle(tree, 'safe', 'cache-family')), /另有 1 项大小未知/)
})

test('a row the card cannot act on is behind a fold too, and refuses exactly what it refused before', () => {
  const tree = render(reportWith({ attachments: { danger: [DANGER_ATTACHMENT] } }), {
    openArtifacts: foldsOpen('danger', 'attachment'),
  })
  const row = rowById(tree, 'sha256-aaaa')
  assert.notEqual(row, null, 'the attachment was not rendered')
  assert.equal(row.selectable, 'false')
  assert.equal(row.disabled, true)
  assert.match(row.text, /仍被会话引用/)
})

test('the fold state is the input\'s, so a reload cannot silently reopen what the reader shut', () => {
  const report = reportWith({ caches: { safe: [SAFE_FAMILY] } })
  const open = render(report, { openArtifacts: foldsOpen('safe', 'cache-family') })
  assert.notEqual(rowById(open, 'cache-family:request-images'), null, 'an opened fold rendered no rows')

  const shut = render(report, { openArtifacts: new Set(['tier:safe']) })
  assert.equal(rowById(shut, 'cache-family:request-images'), null)
  assert.equal(artifactKindToggle(shut, 'safe', 'cache-family').props['aria-expanded'], false)
})

test('clicking an artifact fold asks the panel to toggle exactly that fold', () => {
  const seen = []
  const tree = render(reportWith({ caches: { safe: [SAFE_FAMILY] } }), {}, {
    toggleArtifactFold: (key) => seen.push(key),
  })
  artifactTierToggle(tree, 'safe').props.onClick()
  artifactKindToggle(tree, 'safe', 'cache-family').props.onClick()
  assert.deepEqual(seen, ['tier:safe', 'kind:safe:cache-family'])
})

test('the card offers select-all for the artifacts a single click could take, and only those', () => {
  const report = reportWith({
    caches: { safe: [SAFE_FAMILY], unclassified: [BLOCKED_FAMILY] },
    attachments: { danger: [DANGER_ATTACHMENT] },
  })
  // The grey rows are not offered: the bulk control and the row's own checkbox read the same
  // predicate, so a bulk tick can never select a row a single click would refuse.
  assert.deepEqual(Array.from(loaded.selectableArtifactIds(report)), ['cache-family:request-images'])

  let pressed = 0
  const tree = render(report, {}, { selectSafeArtifacts: () => { pressed += 1 } })
  const button = buttonBy(tree, 'data-dshr-select-safe-artifacts')
  assert.notEqual(button, null, 'the artifact select-all control is missing from the card')
  assert.equal(button.props.disabled, false)
  assert.equal(textOf(button), '全选安全产物（1）')
  button.props.onClick()
  assert.equal(pressed, 1)

  // Nothing safe to add: the control says so instead of inviting a click that does nothing.
  const none = render(reportWith({ caches: { unclassified: [BLOCKED_FAMILY] } }), {}, {})
  const empty = buttonBy(none, 'data-dshr-select-safe-artifacts')
  assert.equal(empty.props.disabled, true)
  assert.equal(textOf(empty), '全选安全产物（0）')

  // A run in flight: the control is off the table.
  const busy = render(report, { busy: 'clean' }, {})
  assert.equal(buttonBy(busy, 'data-dshr-select-safe-artifacts').props.disabled, true)
})

test('the artifact select-all and the session select-all are two controls, not one', () => {
  const report = reportWith({ sessions: { safe: [tierRow('s-a', 'safe')] }, caches: { safe: [SAFE_FAMILY] } })
  const tree = render(report, {}, {})
  assert.notEqual(buttonBy(tree, 'data-dshr-select-safe'), null)
  assert.notEqual(buttonBy(tree, 'data-dshr-select-safe-artifacts'), null)
  // They act on different rows and leave their receipts in different places, so their labels
  // say which is which.
  assert.equal(textOf(buttonBy(tree, 'data-dshr-select-safe')), '全选安全项（1）')
  assert.equal(textOf(buttonBy(tree, 'data-dshr-select-safe-artifacts')), '全选安全产物（1）')
})

test('showCompanionToast mounts alert toast to document body on session removal signal', () => {
  // Simulate DOM document
  const createdElements = []
  const mockBody = {
    appendChild: (el) => {
      mockBody.children.push(el)
      el.parentNode = mockBody
      return el
    },
    removeChild: (el) => {
      const idx = mockBody.children.indexOf(el)
      if (idx !== -1) mockBody.children.splice(idx, 1)
      el.parentNode = null
      return el
    },
    children: [],
  }
  const mockDoc = {
    body: mockBody,
    getElementById: (id) => mockBody.children.find((c) => c.id === id) || null,
    createElement: (tag) => {
      const el = {
        tag,
        id: '',
        className: '',
        attrs: {},
        style: {},
        textContent: '',
        children: [],
        parentNode: null,
        setAttribute: (k, v) => { el.attrs[k] = v },
        appendChild: (child) => {
          el.children.push(child)
          child.parentNode = el
          return child
        },
      }
      createdElements.push(el)
      return el
    },
  }

  const mockWindow = {
    addEventListener: () => {},
    removeEventListener: () => {},
  }

  const helper = loaded.setupCompanionNotification(
    { locale: { get: () => 'zh' } },
    undefined,
    mockDoc,
    mockWindow,
  )

  assert.ok(mockWindow.__DSH_RECLAIM_COMPANION__, 'must expose companion helper on window')
  mockWindow.__DSH_RECLAIM_COMPANION__.notifySessionRemoved('test-session-123')

  const toast = mockDoc.getElementById('dshr-companion-toast')
  assert.notEqual(toast, null, 'toast element must be appended to body')
  assert.equal(toast.attrs['data-dshr-toast'], 'session-removed')
  assert.ok(toast.children.some((c) => c.textContent && c.textContent.includes('会话已删除')))
})

