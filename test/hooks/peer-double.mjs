/**
 * Test double for `@deepseek-ai/dsh-home-paths`.
 *
 * Implements only the three exports `lib/paths.js` actually consumes
 * (`lib/paths.js:34`), with the semantics the plugin's own docs assert:
 *
 *   - `resolveDshHome(configuredHome, env)` — an explicitly configured home wins,
 *     then `$DSH_HOME`, then `~/.dsh` (`lib/paths.js:261`)
 *   - `dshHomeDisplay(home)` — render `$DSH_HOME` when the home came from it
 *     (`lib/paths.js:287`)
 *   - `canonicalizeWatchPath(target)` — async realpath that tolerates a
 *     not-yet-existing tail, which is what `makeIsInsideTrash` relies on
 *     (`lib/paths.js:337`, `lib/paths.js:351`; documented at `lib/paths.js:298-302`)
 *
 * `dshCachePath` is deliberately NOT exported. The plugin feature-detects it
 * (`lib/paths.js:120`), and leaving it unexported pins the pre-cache layout
 * deterministically rather than making the default depend on whatever the test
 * double happens to define. Tests that exercise the newer layout pass their own
 * namespace to `detectRequestImagesLayout(home, homePathsNs)` — the injection
 * point that already exists for exactly this reason (`lib/paths.js:109`).
 */
import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

const HOME_ENV = 'DSH_HOME'

export function resolveDshHome(configuredHome, env = process.env) {
  const fromArgument = typeof configuredHome === 'string' ? configuredHome : ''
  if (fromArgument !== '') return resolve(fromArgument)
  const fromEnv = typeof env?.[HOME_ENV] === 'string' ? env[HOME_ENV] : ''
  if (fromEnv !== '') return resolve(fromEnv)
  return join(homedir(), '.dsh')
}

export function dshHomeDisplay(home) {
  const fromEnv = process.env[HOME_ENV]
  if (typeof fromEnv === 'string' && fromEnv !== '' && resolve(fromEnv) === resolve(home)) {
    return `$${HOME_ENV}`
  }
  return home
}

export async function canonicalizeWatchPath(target) {
  let current = resolve(target)
  const missing = []
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      const real = await realpath(current)
      return missing.length === 0 ? real : join(real, ...missing.reverse())
    } catch (cause) {
      // Only a missing segment is tolerated. Everything else (a permission
      // error, a file-shaped ancestor) propagates, which is what makes
      // `makeIsInsideTrash`'s fail-closed branch observable.
      if (cause?.code !== 'ENOENT') throw cause
      const parent = dirname(current)
      if (parent === current) throw cause
      missing.push(basename(current))
      current = parent
    }
  }
  throw new Error(`canonicalizeWatchPath: more than 64 missing segments in ${target}`)
}
