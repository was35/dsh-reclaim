/**
 * dsh-reclaim — measuring a directory without following symbolic links.
 *
 * Extracted from `lib/trash.js` for one reason: the recovery module
 * (`lib/recover.js`) has to measure an item it reconstructed from a batch
 * directory, and `lib/recover.js` is imported *by* `lib/trash.js`. Importing the
 * two measuring functions back from `lib/trash.js` would close that cycle, and
 * writing them a second time inside `lib/recover.js` would leave two answers to
 * "how big is this item" that could drift apart — which is exactly the kind of
 * duplicate judgement `docs/safety.md` refuses elsewhere.
 *
 * So the implementation lives here, `lib/trash.js` re-exports both names for
 * every existing caller (`lib/delete-session.js`, `lib/purge.js`,
 * `lib/restore.js`), and there is still only one of each.
 *
 * Both walks are best effort by design: a directory that cannot be listed counts
 * as empty, an entry whose size cannot be read counts as 0, and **a symbolic link
 * is never followed** — a link inside the quarantine must not make the plugin
 * count data that lives outside it.
 */

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Total bytes under a directory (best effort; unknown sizes count as 0). */
export function directoryBytes(root) {
  let bytes = 0
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        stack.push(full)
        continue
      }
      try {
        bytes += statSync(full).size
      } catch {
        /* unknown size */
      }
    }
  }
  return bytes
}

/** Total files under a directory (best effort). */
export function directoryFileCount(root) {
  let files = 0
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) stack.push(full)
      else files += 1
    }
  }
  return files
}
