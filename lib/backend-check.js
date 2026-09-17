/**
 * dsh-reclaim — attachment-backend locality check.
 *
 * This plugin enumerates attachments by scanning `<DSH_HOME>/attachments/v1`.
 * That is only sound when the mounted attachment backend is **host-file-backed
 * and rooted in exactly that tree**. A remote or shared backend would make the
 * disk scan describe storage the host does not actually use, so the scan must
 * be switched off with a stated reason rather than silently performed.
 *
 * Probe: call the official `AttachmentStore.imageHostPath(ref)` with a
 * shape-valid synthetic reference and compare the returned absolute path with
 * the object path this plugin would scan. The official local backend derives
 * that path purely from the reference digest and its configured root
 * (`dsh-attachment-local/lib/index.js:267,288-291,986`), so an exact match
 * proves both "host-file-backed" and "the same tree we intend to scan".
 *
 * Read-only: the probe calls a path-derivation method. Nothing is read,
 * written, created, or deleted, and the synthetic digest (`sha256:000…0`) is
 * not a valid attachment id that any real object could collide with.
 *
 * The check is deliberately NOT memoized: `ctx.get(...)` can
 * legitimately return `undefined` before the backend is mounted, so caching an
 * apply-time verdict would turn a startup-ordering artifact into a permanent
 * false negative. Callers run it fresh at scan time; an apply-time call is an
 * early warning only.
 *
 * `inject` is intentionally NOT extended with `attachments`:
 * declaring it would make the whole plugin wait for — and fail without — that
 * service, which is the opposite of "disable enumeration and explain why".
 */

import { isAbsolute, join, relative } from 'node:path'

/**
 * Digest used by the synthetic probe reference: 64 zeros, formatted as the
 * official content-addressed id (`sha256:<hex>`, see
 * `dsh-attachment-local/lib/index.js:267,610`) so a real backend accepts it
 * and derives a path from it instead of rejecting the reference shape.
 */
const PROBE_DIGEST = '0'.repeat(64)

/** Display name carried by the synthetic file-reference probe. */
export const PROBE_FILE_NAME = 'dsh-reclaim-locality-probe'

/**
 * Human-readable rendering of a caught value, including a stable `code` when
 * the backend supplies one (`AttachmentError` carries one).
 */
function describeCause(cause) {
  if (cause === null || cause === undefined) return String(cause)
  const name = cause.name ?? 'Error'
  const message = cause.message ?? String(cause)
  const code = cause.code === undefined ? '' : ` (code ${String(cause.code)})`
  return `${name}: ${message}${code}`
}

/**
 * Platform-faithful path identity: `path.relative` is case-insensitive on
 * win32 and case-sensitive elsewhere, which is this platform's own rule.
 */
function samePath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  if (left === '' || right === '') return false
  return relative(left, right) === ''
}

/**
 * Call one `AttachmentStore` host-path method and classify what came back.
 *
 * @param {object|undefined} store - the `ctx.attachments` service, if mounted
 * @param {'imageHostPath'|'fileHostPath'} method
 * @param {object} ref - shape-valid synthetic reference
 * @returns {{
 *   method: string,
 *   called: boolean,
 *   hostFileBacked: boolean | null,
 *   returnedPath: string | null,
 *   error: string | null,
 * }}
 */
function probeHostFilePath(store, method, ref) {
  const result = {
    method,
    called: false,
    hostFileBacked: null,
    returnedPath: null,
    error: null,
  }

  if (store === null || store === undefined) {
    result.error = 'the attachments service is not mounted, so locality cannot be probed'
    return result
  }
  if (typeof store[method] !== 'function') {
    result.error = `the mounted AttachmentStore does not implement ${method}()`
    return result
  }

  result.called = true
  try {
    const value = store[method](ref)
    if (value === undefined || value === null || value === '') {
      result.hostFileBacked = false
      result.error = `${method}() returned ${String(value)}: this backend is not host-file-backed`
      return result
    }
    if (typeof value !== 'string' || !isAbsolute(value)) {
      result.hostFileBacked = false
      result.error = `${method}() returned a non-absolute value of type ${typeof value}`
      return result
    }
    result.hostFileBacked = true
    result.returnedPath = value
    return result
  } catch (cause) {
    // An invalid reference is rejected, and a backend that cannot resolve host
    // paths rejects as well — both mean "do not scan the local tree".
    result.hostFileBacked = false
    result.error = `${method}() threw ${describeCause(cause)}`
    return result
  }
}

/**
 * Decide whether attachment enumeration and orphan detection may run.
 *
 * @param {object} options
 * @param {object|undefined} options.store - `ctx.get('attachments')`
 * @param {object} options.layout - from `resolveLayout()`
 * @returns {{
 *   service: { available: boolean, source: string },
 *   local: boolean,
 *   reason: string,
 *   images: object,
 *   files: object,
 *   enumeration: { enabled: boolean, disabledReason: string | null },
 *   orphanDetection: { enabled: boolean, disabledReason: string | null },
 *   reportOnlyFamilies: string[],
 *   notes: string[],
 * }}
 */
export function checkAttachmentBackend({ store, layout }) {
  const families = new Map((layout?.families ?? []).map((family) => [family.id, family]))
  const objectsFamily = families.get('objects')
  const filesFamily = families.get('files')

  const imageRef = {
    attachmentId: `sha256:${PROBE_DIGEST}`,
    mediaType: 'image/png',
    bytes: 0,
    width: 1,
    height: 1,
  }
  const fileRef = {
    attachmentId: `sha256:${PROBE_DIGEST}`,
    name: PROBE_FILE_NAME,
    bytes: 0,
  }

  const images = probeHostFilePath(store, 'imageHostPath', imageRef)
  const files = probeHostFilePath(store, 'fileHostPath', fileRef)

  const expectedImagePath = objectsFamily === undefined
    ? null
    : join(objectsFamily.path, PROBE_DIGEST.slice(0, 2), PROBE_DIGEST)
  const expectedFilePath = filesFamily === undefined
    ? null
    : join(filesFamily.path, PROBE_DIGEST.slice(0, 2), PROBE_DIGEST, fileRef.name)

  images.expectedPath = expectedImagePath
  images.matchesScannedTree = samePath(images.returnedPath, expectedImagePath)
  files.expectedPath = expectedFilePath
  files.matchesScannedTree = samePath(files.returnedPath, expectedFilePath)

  const notes = []
  let local
  let reason

  if (store === null || store === undefined) {
    local = false
    reason =
      'ctx.get("attachments") returned undefined, so the mounted backend could not be ' +
      'probed; attachment enumeration and orphan detection stay OFF rather than assume ' +
      'the scanned tree is the one the host writes'
  } else if (images.hostFileBacked !== true) {
    local = false
    reason =
      `imageHostPath() did not yield a host file path (${images.error ?? 'no value'}), ` +
      'so this deployment does not use host-file-backed image attachments under DSH_HOME; ' +
      'attachment enumeration and orphan detection stay OFF'
  } else if (!images.matchesScannedTree) {
    local = false
    reason =
      `imageHostPath() resolved ${images.returnedPath}, which is NOT the object path this ` +
      `plugin scans (${expectedImagePath}); the backend is host-file-backed but rooted ` +
      'elsewhere, so scanning the local tree would describe storage the host does not use — ' +
      'attachment enumeration and orphan detection stay OFF'
  } else {
    local = true
    reason =
      `imageHostPath() resolved the content-addressed object inside the scanned tree ` +
      `(${images.returnedPath}), so the mounted backend is host-file-backed and rooted ` +
      'where this plugin scans'
  }

  // Supplementary evidence only: the generic-file families are report-only,
  // so a file-path mismatch cannot enable or disable anything on
  // its own — but it must be visible when it disagrees with the image probe.
  if (local && files.matchesScannedTree !== true) {
    notes.push(
      `fileHostPath() did not confirm the generic-file tree (${files.error ?? `resolved ${String(files.returnedPath)}`}); ` +
        'the file-objects/files families remain report-only and their attribution is unverified',
    )
  }
  if (files.returnedPath !== null && files.matchesScannedTree !== true) {
    notes.push(
      `fileHostPath() resolved ${files.returnedPath} instead of the expected ${String(expectedFilePath)}`,
    )
  }

  return {
    service: { available: store !== null && store !== undefined, source: 'ctx.get("attachments")' },
    local,
    reason,
    images,
    files,
    enumeration: { enabled: local, disabledReason: local ? null : reason },
    orphanDetection: { enabled: local, disabledReason: local ? null : reason },
    reportOnlyFamilies: ['file-objects', 'files'],
    notes,
  }
}

export { PROBE_DIGEST }

/**
 * A backend verdict that **asserts** host-file-backed locality instead of
 * probing it.
 *
 * The probe needs the in-process `AttachmentStore`, so callers without a
 * `ctx` — the acceptance CLI, unit tests — cannot perform it. Pretending they
 * had would be a lie, so the assertion is explicit and stays visible in the
 * report (`assumed: true`, `notes`). The in-host route always probes; only it
 * can produce the authoritative verdict.
 *
 * @param {string} reason - who asserted locality and why
 */
export function assumeLocalBackend(reason) {
  const empty = (method) => ({
    method,
    called: false,
    hostFileBacked: null,
    returnedPath: null,
    error: null,
    expectedPath: null,
    matchesScannedTree: null,
  })
  return {
    service: { available: null, source: 'asserted by the caller, not probed' },
    local: true,
    assumed: true,
    reason,
    images: empty('imageHostPath'),
    files: empty('fileHostPath'),
    enumeration: { enabled: true, disabledReason: null },
    orphanDetection: { enabled: true, disabledReason: null },
    reportOnlyFamilies: ['file-objects', 'files'],
    notes: [
      'locality was ASSERTED rather than probed: only the in-host route can call the real ' +
        'AttachmentStore.imageHostPath()',
    ],
  }
}
