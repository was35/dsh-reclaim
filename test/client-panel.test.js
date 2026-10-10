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
  return { react, plugin, renderPanel: panel.renderPanel }
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
function reportWith({ caches = {}, attachments = {} }) {
  return {
    ok: true,
    scanCount: 1,
    gate: {},
    families: [],
    totals: { totalReclaimableBytes: 0, sessionCount: 0, dedupAttachmentCount: 0 },
    tiers: {
      sessions: { safe: [], confirm: [], danger: [], unclassified: [] },
      attachments: { safe: [], confirm: [], danger: [], unclassified: [], ...attachments },
      caches: { safe: [], confirm: [], danger: [], unclassified: [], reportOnly: [], ...caches },
    },
  }
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
