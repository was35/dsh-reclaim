/**
 * Redirects the single host-provided specifier to the test double.
 *
 * Only `resolve` is hooked, deliberately: the shim changes WHICH url a
 * specifier maps to, never how a module is evaluated. Kept synchronous so the
 * same module works under both `module.registerHooks()` and the older,
 * promise-based `module.register()`.
 */
const PEER = '@deepseek-ai/dsh-home-paths'
const DOUBLE_URL = new URL('./peer-double.mjs', import.meta.url).href

export function resolve(specifier, context, nextResolve) {
  if (specifier === PEER) return { url: DOUBLE_URL, shortCircuit: true }
  return nextResolve(specifier, context)
}
