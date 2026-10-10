/**
 * Registers the test-only module-resolution hook, before any test module loads.
 *
 * WHY THIS EXISTS
 * `lib/paths.js:32` imports the host-provided optional peer
 * `@deepseek-ai/dsh-home-paths` at MODULE scope. Outside a running DSH host
 * that specifier is unresolvable, so no module in `lib/` can be imported in a
 * plain Node process — `lib/trash.js` and `lib/restore.js` fail too, because
 * they import `./paths.js`. Measured:
 *
 *   node --input-type=module -e "import('./lib/paths.js')"
 *   → ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-home-paths'
 *
 * The hook maps that one specifier (the only bare specifier in `lib/`) to a
 * test double, so the modules under test can be loaded at all. It changes
 * nothing outside the test process.
 *
 * Because a double is a double, it does NOT stand in for the real host: the
 * genuine package is covered by `npm run test:host`, which boots a real DSH
 * host and lets the host's own ESM hooks supply it.
 */
import { register, registerHooks } from 'node:module'

import { resolve as resolvePeer } from './peer-shim.mjs'

// `module.register` (async hooks) is deprecated in favour of the synchronous
// `module.registerHooks`. Prefer the latter, but keep the former for the
// declared `engines.node` floor of >=20.0.0, where `registerHooks` is absent.
if (typeof registerHooks === 'function') {
  registerHooks({ resolve: resolvePeer })
} else {
  register('./peer-shim.mjs', import.meta.url)
}
