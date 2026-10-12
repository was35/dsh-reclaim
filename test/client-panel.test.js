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
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { createContext, runInContext } from 'node:vm'

const SOURCE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

/** The smallest React this panel uses: `createElement`, and nothing else. */
function fakeReact() {
  function flatten(value, out) {
    if (value === null || value === undefined || typeof value === 'boolean') return out
    if (Array.isArray(value)) {
      for (const item of value) flatten(item, out)
      return out
    }
    out.push(value)
    return out
  }
  return {
    createElement(type, props) {
      const children = []
      for (let index = 2; index < arguments.length; index += 1) flatten(arguments[index], children)
      return { type, props: props ?? {}, children }
    },
  }
}

/**
 * Evaluate the bundle the way the page does, and hand back the test seam.
 *
 * Evaluated ONCE at module scope: the file registers its factory on load, and evaluating it
 * twice produces two plugin instances, which is exactly the failure the seam's own comment
 * warns about.
 */
const loaded = (() => {
  const react = fakeReact()
  let registration = null
  const sandbox = { console, window: { __ModuleLoader__: { load: (spec) => { registration = spec } } } }
  runInContext(SOURCE, createContext(sandbox))
  assert.notEqual(registration, null, 'the panel never registered a factory')
  const plugin = registration.factory((name) => {
    if (name === 'react') return react
    throw new Error(`unexpected require(${name})`)
  })
  const panel = sandbox.__dshReclaimPanel
  assert.notEqual(panel, undefined, 'the panel exposed no test seam')
  return {
    react,
    plugin,
    renderPanel: panel.renderPanel,
    classifyUrl: panel.classifyUrl,
    formatClock: panel.formatClock,
    shouldRescanAfter: panel.shouldRescanAfter,
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

function render(report, overrides = {}) {
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
      setThresholdDays: noop,
      setView: noop,
      refresh: noop,
      cleanUp: noop,
      cleanFamily: noop,
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
  const tree = render(reportWith({ caches: { safe: [SAFE_FAMILY] } }))
  const row = rowById(tree, 'cache-family:request-images')
  assert.notEqual(row, null, 'the clearable cache family was not rendered at all')
  assert.equal(row.selectable, 'true')
  assert.equal(row.disabled, false)
  assert.equal(row.tier, 'safe')
  assert.match(row.text, /可重建缓存族/)
  assert.match(row.text, /2\.0 KB/)
})

test('a cache row that could not be enumerated is listed, refused, and says why', () => {
  const tree = render(reportWith({ caches: { unclassified: [BLOCKED_FAMILY] } }))
  const row = rowById(tree, 'cache-family:tmp')
  assert.notEqual(row, null, 'the blocked cache family was hidden instead of explained')
  assert.equal(row.selectable, 'false')
  assert.equal(row.disabled, true)
  assert.match(row.text, /这一族没能枚举/)
})

test('a report-only family is shown as reported, never as clearable', () => {
  const tree = render(reportWith({ caches: { reportOnly: [REPORT_ONLY_FAMILY] } }))
  const row = rowById(tree, 'report-only:files')
  assert.notEqual(row, null)
  assert.equal(row.selectable, 'false')
  assert.match(row.text, /只报告/)
})

test('an attachment still referenced by a session is never offered for clearing', () => {
  const tree = render(reportWith({ attachments: { danger: [DANGER_ATTACHMENT] } }))
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
  assert.match(textOf(tree), /参考图读完前不提供任何清理操作/)

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
