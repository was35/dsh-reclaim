/**
 * dsh-reclaim — attachment enumeration.
 *
 * The official `AttachmentStore` exposes read-by-reference, write, and
 * host-path derivation, but **no list / iterate / enumerate method**
 * (`dsh-attachment/lib/types/index.d.ts`, full method set checked), so a
 * complete inventory can only come from walking the disk. This module does
 * exactly that and nothing more: it lists names and measures sizes. It never
 * reads an object's bytes, never interprets content, and never writes.
 *
 * What it produces:
 *   - file count + byte total per family directory (to be cross-checked
 *     against `dir /s /a-d` on the same root)
 *   - shape anomalies INSIDE a family (files that the documented layout would
 *     not place there) — reported, and still counted in the family total so
 *     the arithmetic against `dir` stays exact
 *   - non-regular entries (junctions/symlinks are never followed: following
 *     them would leave the scanned tree and could double-count)
 *   - unknown objects: entries under the attachment storage root that belong
 *     to no defined family — these go straight to the danger tier, because
 *     undefined behavior is a hole and "explicitly not handled" is a decision
 *   - uncertain entries, from BOTH failure sources: `isInsideTrash`
 *     canonicalization failure (fail-closed) and `readdir`/`stat` failure
 *     during the walk. Uncertain entries are counted and reported, never
 *     swallowed, and are excluded from every family total.
 *
 * Path knowledge comes from the asset-location layer only. In particular the
 * request-image family path is CONSUMED from `layout.families`, never
 * re-derived here: the layout layer's contract gate already decided it, and
 * deriving it a second time would reintroduce exactly the silent path switch
 * that gate exists to prevent.
 */

import { readdirSync, statSync } from 'node:fs'
import { basename, dirname, join, relative, sep } from 'node:path'
import { makeIsInsideTrash } from './paths.js'

/**
 * Families whose bytes are reported but which expose NO cleanup: there are no
 * real-world samples to define rules against, and guessing would be worse than
 * waiting.
 */
export const REPORT_ONLY_FAMILIES = Object.freeze(['file-objects', 'files'])

/** Maximum directory depth walked inside one family (pathology guard). */
const MAX_DEPTH = 12

/**
 * Documented object shapes, as POSIX-style relative paths from the family
 * root. Only the families whose layout the official package documents
 * precisely are checked. `request-images` is deliberately absent: its key is a
 * request-variant identity (attachment id + transform version + budgets +
 * encoder settings, README "request versions"), not a content digest, so
 * shape-checking it would invent a constraint the host never promised.
 */
const FAMILY_SHAPES = Object.freeze({
  objects: /^[0-9a-f]{2}\/[0-9a-f]{64}$/,
  'file-objects': /^[0-9a-f]{2}\/[0-9a-f]{64}$/,
  files: /^[0-9a-f]{2}\/[0-9a-f]{64}\/[^/]+$/,
})

function describeCause(cause) {
  if (cause === null || cause === undefined) return String(cause)
  const name = cause.name ?? 'Error'
  const message = cause.message ?? String(cause)
  const code = cause.code === undefined ? '' : ` (code ${String(cause.code)})`
  return `${name}: ${message}${code}`
}

function toPosix(root, fullPath) {
  return relative(root, fullPath).split(sep).join('/')
}

/** `statSync` that reports failure instead of throwing. */
function statOrNull(path) {
  try {
    return statSync(path)
  } catch (cause) {
    return { error: describeCause(cause) }
  }
}

/**
 * Recursively measure a tree, excluding anything inside the plugin trash.
 *
 * @param {string} root
 * @param {object} walker - shared bookkeeping (see {@link scanAttachments})
 * @param {{ shapeRoot: string, shape: RegExp, anomalies: object[] } | null}
 *   [shapeContext] - when given, every counted file is additionally checked
 *   against the documented layout. The check is informational only: anomalous
 *   files stay in the totals so the `dir` cross-check remains exact.
 */
async function measureTree(root, walker, shapeContext = null) {
  const stats = { files: 0, bytes: 0, dirs: 0 }
  const stack = [{ path: root, depth: 0 }]

  while (stack.length > 0) {
    const current = stack.pop()
    if (current.depth > MAX_DEPTH) {
      walker.noteUncertain(current.path, 'directory', `depth limit ${MAX_DEPTH} reached; subtree not walked`)
      continue
    }

    let entries
    try {
      entries = readdirSync(current.path, { withFileTypes: true })
    } catch (cause) {
      walker.noteUncertain(current.path, 'directory', `readdir failed: ${describeCause(cause)}`)
      continue
    }

    for (const entry of entries) {
      const full = join(current.path, entry.name)
      const kind = entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'non-regular'
      if (await walker.excludeIfTrash(full, kind)) continue

      if (entry.isDirectory()) {
        stats.dirs += 1
        stack.push({ path: full, depth: current.depth + 1 })
        continue
      }
      if (entry.isFile()) {
        const info = statOrNull(full)
        if (info.error !== undefined) {
          walker.noteUncertain(full, 'file', `stat failed: ${info.error}`)
          continue
        }
        stats.files += 1
        stats.bytes += info.size
        if (shapeContext !== null) {
          const rel = toPosix(shapeContext.shapeRoot, full)
          if (!shapeContext.shape.test(rel)) {
            shapeContext.anomalies.push({
              path: full,
              relativePath: rel,
              expectedShape: String(shapeContext.shape),
              note:
                'counted in the family total (so the `dir` cross-check stays exact) but the ' +
                'documented layout would not place it here',
            })
          }
        }
        continue
      }
      // Junctions, symlinks, and anything else that is not a plain file or
      // directory. Never followed: classification follows the data's physical
      // location, and following a link here could walk out of
      // the tree or count one object twice.
      walker.noteNonRegular(full, entry.isSymbolicLink() ? 'symlink' : 'other')
    }
  }

  return stats
}

/**
 * Enumerate every attachment family plus the unknown objects around them.
 *
 * @param {object} layout - from `resolveLayout()`
 * @param {object} [options]
 * @param {object} [options.backend] - result of `checkAttachmentBackend()`;
 *   when it says the backend is not local, families are reported but NOT
 *   enumerated, with the reason attached
 * @param {(candidatePath: string) => Promise<boolean>} [options.isInsideTrash]
 *   - override, mainly for tests; defaults to the fail-closed trash test bound to
 *   this layout
 * @param {boolean} [options.includeUnknown=true]
 * @returns {Promise<object>} a JSON-serializable report
 */
export async function scanAttachments(layout, options = {}) {
  const backend = options.backend ?? null
  const enumerationEnabled = backend === null ? true : backend.enumeration.enabled !== false

  const uncertain = []
  const uncertainPaths = new Set()
  const nonRegular = []
  const excludedAsTrash = []

  const walker = {
    noteUncertain(path, kind, reason) {
      if (uncertainPaths.has(path)) return
      uncertainPaths.add(path)
      uncertain.push({ path, kind, reason })
    },
    noteNonRegular(path, kind) {
      nonRegular.push({ path, kind, reason: `${kind} entries are never followed` })
    },
    async excludeIfTrash(candidatePath, kind) {
      const inside = await isInsideTrash(candidatePath)
      if (!inside) return false
      // `onUncertain` fires synchronously right before the fail-closed verdict,
      // so membership in `uncertainPaths` distinguishes "genuinely inside the
      // trash" from "could not be canonicalized, excluded out of caution".
      if (uncertainPaths.has(candidatePath)) {
        // The callback only knows the path; this call site knows the kind, so
        // upgrade the record instead of leaving it as "unknown".
        const record = uncertain.find((entry) => entry.path === candidatePath)
        if (record !== undefined && record.kind === 'unknown') record.kind = kind
      } else {
        excludedAsTrash.push({ path: candidatePath, kind })
      }
      return true
    },
  }

  const isInsideTrash = options.isInsideTrash ?? makeIsInsideTrash(layout, {
    onUncertain: (cause, candidatePath) => {
      walker.noteUncertain(
        candidatePath,
        'unknown',
        `isInsideTrash could not canonicalize the path (fail-closed: treated as trash and excluded): ${describeCause(cause)}`,
      )
    },
  })

  const families = []
  for (const family of layout.families) {
    const record = {
      id: family.id,
      path: family.path,
      exists: family.exists,
      nature: family.nature,
      reportOnly: REPORT_ONLY_FAMILIES.includes(family.id),
      enumerated: false,
      files: 0,
      bytes: 0,
      dirs: 0,
      shapeAnomalies: [],
      reason: null,
    }

    if (!enumerationEnabled) {
      record.reason = backend.enumeration.disabledReason
      families.push(record)
      continue
    }
    if (!family.exists) {
      record.reason = 'the family directory does not exist on this host'
      families.push(record)
      continue
    }
    if (await walker.excludeIfTrash(family.path, 'directory')) {
      record.reason = 'the family directory is inside the plugin trash and is excluded from scanning'
      families.push(record)
      continue
    }

    const shape = FAMILY_SHAPES[family.id] ?? null
    const stats = await measureTree(family.path, walker, shape === null ? null : {
      shapeRoot: family.path,
      shape,
      anomalies: record.shapeAnomalies,
    })
    // The walk reports a root it could not read (ENOTDIR, EACCES, …) as an
    // uncertain entry. Claiming `enumerated: true` in that case would be a lie:
    // the family was NOT enumerated, and anything downstream must see that.
    const rootUnreadable = uncertainPaths.has(family.path)
    record.enumerated = !rootUnreadable
    record.reason = rootUnreadable
      ? 'the family root could not be read; see the uncertain entry for this path'
      : 'enumerated'
    record.files = stats.files
    record.bytes = stats.bytes
    record.dirs = stats.dirs
    families.push(record)
  }

  const unknowns = options.includeUnknown === false
    ? []
    : await collectUnknownObjects(layout, walker)

  const totals = {
    familyFiles: families.reduce((sum, family) => sum + family.files, 0),
    familyBytes: families.reduce((sum, family) => sum + family.bytes, 0),
    unknownFiles: unknowns.reduce((sum, entry) => sum + entry.files, 0),
    unknownBytes: unknowns.reduce((sum, entry) => sum + entry.bytes, 0),
  }

  return {
    home: layout.home,
    homeDisplay: layout.homeDisplay,
    attachmentsStorageRoot: storageRootOf(layout),
    requestImagesLayout: requestImagesLayoutOf(layout),
    enumerationEnabled,
    enumerationDisabledReason: enumerationEnabled ? null : backend.enumeration.disabledReason,
    families,
    unknown: unknowns,
    uncertain,
    nonRegular,
    excludedAsTrash,
    totals,
    accounting: {
      familyFiles: totals.familyFiles,
      familyBytes: totals.familyBytes,
      unknownFiles: totals.unknownFiles,
      unknownBytes: totals.unknownBytes,
      uncertainEntries: uncertain.length,
      nonRegularEntries: nonRegular.length,
      excludedAsTrashEntries: excludedAsTrash.length,
      rule:
        'each family file/byte total must equal `dir /s /a-d <family>` on the same root. When ' +
        'the file counts agree the byte totals must agree too. A shortfall is acceptable only ' +
        'when it is covered by refused-to-count entries inside that family (uncertain entries: ' +
        'an unreadable subtree, whose byte size is therefore unknown; non-regular entries: ' +
        'junctions/symlinks, which `dir` reports as directories). A surplus is never ' +
        'acceptable. Unknown objects live OUTSIDE the family directories, so they never change ' +
        'a family total — they are accounted separately.',
    },
  }
}

/**
 * Entries under the attachment storage root (plus the cache-layout attachment
 * namespace, when the running host uses it) that belong to no defined family.
 *
 * "Belongs to a family" is derived, not hardcoded: a directory child is known
 * when it is the parent of a family path the layout layer resolved. That keeps
 * the drift case honest — when the host moves `request-images` to the cache
 * layout, a leftover `attachments/v1/request-images` is reported as unknown
 * *with that explanation*, instead of being silently attributed or silently
 * ignored.
 */
async function collectUnknownObjects(layout, walker) {
  const named = new Map() // storage root -> Set of known child directory names
  for (const family of layout.families) {
    const parent = dirname(family.path)
    if (!named.has(parent)) named.set(parent, new Set())
    named.get(parent).add(basename(family.path))
  }

  const requestImages = requestImagesLayoutOf(layout)
  const driftNote = requestImages === null
    ? null
    : `this host serves the request-images family from ${requestImages.selectedPath} ` +
      `(layout: ${requestImages.selected})`

  const unknowns = []
  for (const [root, knownNames] of named) {
    const rootInfo = statOrNull(root)
    if (rootInfo.error !== undefined || !rootInfo.isDirectory()) continue
    if (await walker.excludeIfTrash(root, 'directory')) continue

    let entries
    try {
      entries = readdirSync(root, { withFileTypes: true })
    } catch (cause) {
      walker.noteUncertain(root, 'directory', `readdir failed while looking for unknown objects: ${describeCause(cause)}`)
      continue
    }

    for (const entry of entries) {
      if (knownNames.has(entry.name)) continue
      const full = join(root, entry.name)
      const kind = entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'non-regular'
      if (await walker.excludeIfTrash(full, kind)) continue

      const isDirectory = entry.isDirectory()
      let files = 0
      let bytes = 0
      if (isDirectory) {
        const stats = await measureTree(full, walker)
        files = stats.files
        bytes = stats.bytes
      } else if (entry.isFile()) {
        const info = statOrNull(full)
        if (info.error !== undefined) {
          walker.noteUncertain(full, 'file', `stat failed: ${info.error}`)
          continue
        }
        files = 1
        bytes = info.size
      } else {
        walker.noteNonRegular(full, entry.isSymbolicLink() ? 'symlink' : 'other')
        continue
      }

      const isDriftedRequestImages = entry.name === 'request-images' && driftNote !== null
      unknowns.push({
        path: full,
        kind: isDirectory ? 'directory' : 'file',
        files,
        bytes,
        tier: 'danger',
        reason: isDriftedRequestImages
          ? `not the active request-images family location: ${driftNote}; this directory is left over from a different host build and its contents are not attributable`
          : 'belongs to no defined attachment family (objects / file-objects / files / request-images / tmp)',
      })
    }
  }
  return unknowns
}

/** The attachment storage root that holds the fixed families (`.../attachments/v1`). */
function storageRootOf(layout) {
  const objects = layout.families.find((family) => family.id === 'objects')
  return objects === undefined ? join(layout.home, 'attachments', 'v1') : dirname(objects.path)
}

/** Echo of the request-image layout decision, or `null` if absent. */
function requestImagesLayoutOf(layout) {
  const family = layout.families.find((entry) => entry.id === 'request-images')
  return family?.layout ?? null
}

export { MAX_DEPTH, FAMILY_SHAPES, storageRootOf }
