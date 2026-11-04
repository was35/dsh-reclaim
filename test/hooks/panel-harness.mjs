/**
 * The panel bundle, evaluated the way the page evaluates it.
 *
 * WHY THIS LIVES HERE
 * `lib/client.js` is a classic script: it cannot be imported, it registers a factory on
 * `window.__ModuleLoader__` and hangs its render function on `globalThis.__dshReclaimPanel`
 * so a test can evaluate it once and call it directly. Two callers need that bundle —
 * the unit test that asserts the panel's rules, and `scripts/verify-reentry.mjs`, which asks
 * the REAL panel what it would say about responses a real host produced. A second copy of
 * this harness would be a second copy of the truth about how the panel behaves, so there is
 * one, and both callers use it.
 *
 * WHY IT IS EVALUATED ONCE
 * Evaluating the file twice produces two plugin instances, and the second one then throws
 * `Cannot read properties of undefined (reading 'Component')` depending on call order. The
 * result is cached at module scope for that reason, not for speed.
 */
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'

const SOURCE = readFileSync(new URL('../../lib/client.js', import.meta.url), 'utf8')

/** The smallest React this panel uses: `createElement`, and nothing else. */
export function fakeReact() {
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

let cached = null

/**
 * Evaluate the bundle once and hand back the panel, its factory and the test seam.
 *
 * @returns {{react: object, plugin: object, seam: object}}
 */
export function loadPanel() {
  if (cached !== null) return cached
  const react = fakeReact()
  let registration = null
  const sandbox = { console, window: { __ModuleLoader__: { load: (spec) => { registration = spec } } } }
  runInContext(SOURCE, createContext(sandbox))
  if (registration === null) throw new Error('the panel never registered a factory')
  const plugin = registration.factory((name) => {
    if (name === 'react') return react
    throw new Error(`unexpected require(${name})`)
  })
  const seam = sandbox.__dshReclaimPanel
  if (seam === undefined) throw new Error('the panel exposed no test seam')
  cached = { react, plugin, seam }
  return cached
}
