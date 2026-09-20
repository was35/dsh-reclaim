/**
 * dsh-reclaim — deleting one session, end to end.
 *
 * This module is the only place that decides *what* a session delete consists of;
 * `lib/trash.js` knows *how* to move one thing. Splitting it that way keeps the
 * dangerous part small enough to read in one sitting.
 *
 * ## The five places a session lives
 *
 * | # | Location | What happens |
 * |---|---|---|
 * | ① | `sessions/<workspace-slug>/session-<id>/` (or the bare `<id>` form) | moved into the batch |
 * | ② | `storages/session_projcache/sessions/<id>.json` | moved into the batch |
 * | ③ | the workspace's `sessionIds` | `detachSession()`, then read back |
 * | ④ | a persistent index | none exists on this host (measured), so it is reported as empty rather than assumed |
 * | ⑤ | background-job ownership | checked **before** anything moves; a session that still owns a job is not moved |
 *
 * ①② are moved before ③ on purpose. The workspace entity prunes, on every write,
 * any member whose session directory no longer resolves — so moving first means
 * the host is already correcting the accounting, and a move that fails leaves the
 * session fully intact and fully accounted for, which is the only state that is
 * safe to be interrupted in.
 *
 * ## Live sessions
 *
 * A session that is loaded in the process is never a candidate: liveness is
 * re-read here, at the moment of decision, not taken from the caller's snapshot.
 * A caller that passes a stale assessment cannot cause a delete with this
 * function, because the assessment is not an input — only the disagreement is
 * reported.
 *
 * Write scope: the quarantine, plus the one official `detachSession` call.
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { deleteSessionItems, directoryFileCount, directoryBytes, makeIsInsideTrash } from './trash.js'
import { PROJECTION_CACHE_SEGMENTS, normalizeSessionId } from './caches.js'
import { readLivenessServices, classifyLiveness } from './liveness.js'
import { describeJobOwnership, detachSessionAccounting } from './workspace-sync.js'

function describeCause(cause) {
  if (cause === null || cause === undefined) return String(cause)
  const name = cause?.name ?? 'Error'
  const message = cause?.message ?? String(cause)
  const code = cause?.code === undefined ? '' : ` (code ${String(cause.code)})`
  return `${name}: ${message}${code}`
}

/**
 * The directory name a workspace path is stored under.
 *
 * The session tree groups sessions by a slug of the workspace path, not by the
 * path itself: a workspace at `<drive>:\<segments>` is stored under a slug that
 * encodes the drive letter, the ASCII segments, and every non-ASCII character as
 * `~` plus four uppercase hex digits. Measured against the real tree:
 *
 *   - the slug is wrapped in `--`;
 *   - ASCII letters and digits are kept as-is, and so is `.` (measured:
 *     `.cc-switch` survives as `.cc-switch`, not `-cc-switch` — the host keeps a
 *     leading-dot directory name readable);
 *   - every OTHER non-alphanumeric ASCII character becomes `-` (so `:`, `\`,
 *     spaces and `_` all collapse into the same separator);
 *   - runs of `-` collapse to one;
 *   - every character outside printable ASCII becomes `~` plus four uppercase hex
 *     digits of its UTF-16 code unit.
 *
 * The reconstruction is checked against the real directory names rather than
 * assumed, because a wrong slug means "session directory not found" — which looks
 * exactly like a session whose files are missing, and would silently turn a delete
 * into a no-op. `findSessionDir` therefore scans the tree as a fallback: the slug
 * is a fast path, never the only path.
 */
export function workspaceSlug(workspacePath) {
  if (typeof workspacePath !== 'string' || workspacePath.length === 0) return null
  let out = ''
  for (const character of workspacePath) {
    const code = character.codePointAt(0)
    if (code > 0x7e || code < 0x20) {
      out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      continue
    }
    out += /[A-Za-z0-9.]/.test(character) ? character : '-'
  }
  const collapsed = out.replace(/-{2,}/g, '-').replace(/^-|-$/g, '')
  return `--${collapsed}--`
}

/**
 * Every directory name a session's own directory could use.
 *
 * Two shapes exist on this host — `session-<uuid>` and a bare `<uuid>` — and the
 * workspace slug is one more layer. The candidates are tried in order, and each
 * one is only accepted when it actually holds a session artifact, so a wrong
 * guess cannot authorise a move.
 */
export function sessionDirCandidates(sessionsRoot, workspacePath, sessionId) {
  const bare = normalizeSessionId(sessionId)
  const names = [...new Set([sessionId, bare, `session-${bare}`])].filter((name) => typeof name === 'string' && name.length > 0)
  const workspaces = [workspaceSlug(workspacePath)]
    .filter((name) => typeof name === 'string' && name.length > 0)

  const candidates = []
  for (const workspace of workspaces) {
    for (const name of names) candidates.push(join(sessionsRoot, workspace, name))
  }
  return candidates
}

/**
 * Find a session directory by scanning the session tree for a directory whose
 * name matches the id, without relying on the slug rule alone.
 */
export function scanForSessionDir(sessionsRoot, sessionId) {
  const bare = normalizeSessionId(sessionId)
  const wanted = new Set([sessionId, bare, `session-${bare}`])
  const checked = []
  let workspaces
  try {
    workspaces = readdirSync(sessionsRoot, { withFileTypes: true })
  } catch (cause) {
    return { ok: false, path: null, artifacts: [], checked, reason: `could not list the session tree: ${describeCause(cause)}` }
  }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue
    for (const name of wanted) {
      const candidate = join(sessionsRoot, workspace.name, name)
      if (!existsSync(candidate)) continue
      let produced = []
      try {
        produced = readdirSync(candidate).filter((entry) => /^session\.v\d+\.jsonl(\.zstd)?$/.test(entry))
      } catch (cause) {
        checked.push({ path: candidate, status: `unreadable (${describeCause(cause)})` })
        continue
      }
      if (produced.length === 0) {
        checked.push({ path: candidate, status: 'no-session-artifact' })
        continue
      }
      return { ok: true, path: candidate, artifacts: produced, checked, reason: null, foundBy: 'scan' }
    }
  }
  return {
    ok: false,
    path: null,
    artifacts: [],
    checked,
    reason: `no directory under ${sessionsRoot} holds a session artifact for ${sessionId}`,
  }
}

/** Locate a session's own directory by looking for the artifacts it must hold. */
export function findSessionDir(sessionsRoot, workspacePath, sessionId) {
  const checked = []
  for (const candidate of sessionDirCandidates(sessionsRoot, workspacePath, sessionId)) {
    let info
    try {
      info = statSync(candidate)
    } catch (cause) {
      checked.push({ path: candidate, status: cause?.code === 'ENOENT' ? 'missing' : `unreadable (${cause?.code ?? describeCause(cause)})` })
      continue
    }
    if (!info.isDirectory()) {
      checked.push({ path: candidate, status: 'not-a-directory' })
      continue
    }
    let produced = []
    try {
      produced = readdirSync(candidate).filter((name) => /^session\.v\d+\.jsonl(\.zstd)?$/.test(name))
    } catch (cause) {
      checked.push({ path: candidate, status: `unreadable (${describeCause(cause)})` })
      continue
    }
    if (produced.length === 0) {
      checked.push({ path: candidate, status: 'no-session-artifact' })
      continue
    }
    return { ok: true, path: candidate, artifacts: produced, checked, reason: null, foundBy: 'slug' }
  }
  // The slug rule is a measurement, not a contract: if it does not match this
  // build's naming, fall back to scanning the tree rather than declaring the
  // session's files missing. A false "not found" would turn a delete into a
  // silent no-op.
  const scanned = scanForSessionDir(sessionsRoot, sessionId)
  if (scanned.ok) return { ...scanned, checked: [...checked, ...scanned.checked] }
  return {
    ok: false,
    path: null,
    artifacts: [],
    checked: [...checked, ...scanned.checked],
    reason:
      'no directory holding a session artifact was found at the expected locations, and a scan of the session ' +
      'tree found none either; the session may have been stored elsewhere, so nothing is moved and the checked ' +
      'paths are listed',
  }
}

/** The projection cache file for a session id, if it exists. */
export function findProjectionCache(layout, sessionId) {
  const root = join(layout.home, ...PROJECTION_CACHE_SEGMENTS)
  const names = new Set([`${sessionId}.json`, `${normalizeSessionId(sessionId)}.json`])
  const checked = []
  for (const name of names) {
    const path = join(root, name)
    if (existsSync(path)) return { ok: true, path, checked, reason: null }
    checked.push(path)
  }
  return { ok: false, path: null, checked, reason: 'no projection cache file was found for this session id' }
}

/**
 * Gather what a delete would touch, without touching it.
 *
 * @returns {Promise<object>} the plan, including anything that blocks the delete
 */
export async function planSessionDelete(ctx, options) {
  const layout = options.layout
  const sessionId = options.sessionId
  const sessionsRoot = join(layout.home, 'sessions')
  const blockers = []
  const items = []

  // --- ⑤ job ownership: checked first, because it can veto the whole operation.
  const jobs = describeJobOwnership(ctx, sessionId)

  // --- liveness, read NOW. A caller's snapshot is display-only.
  const services = readLivenessServices(ctx ?? { get: () => undefined })
  const liveness = classifyLiveness(services, sessionId)
  if (liveness.state !== 'not-live') {
    blockers.push({
      code: `liveness-${liveness.state}`,
      message:
        liveness.state === 'unknown'
          ? 'the liveness of this session could not be determined, so it must not be moved'
          : 'the session is loaded in this process; moving its files would pull them out from under a live conversation',
      detail: { livenessState: liveness.state, reason: liveness.reason, message: liveness.message },
    })
  }

  // --- ① the session directory.
  //
  // A missing workspace path is NOT a reason to refuse: the session tree is
  // grouped by a slug of the workspace path, and the listing's `cwd` is not always
  // the same string the host used when it created the directory (measured: a host
  // whose own working directory is the repository records that path for a session
  // whose directory sits under a different slug). So when the caller cannot name the
  // workspace, the tree is scanned for a directory that actually holds this
  // session's artifact — a slow path that is still certain, because the artifact
  // is what identifies the session, not the directory name.
  const workspacePath = options.workspacePath ?? null
  const dir = workspacePath === null
    ? scanForSessionDir(sessionsRoot, sessionId)
    : findSessionDir(sessionsRoot, workspacePath, sessionId)
  if (dir.ok) {
    items.push({
      path: dir.path,
      kind: 'session',
      reason: `holds ${dir.artifacts.join(', ')}`,
      artifacts: dir.artifacts,
      isDirectory: true,
      files: directoryFileCount(dir.path),
      bytes: directoryBytes(dir.path),
    })
  } else {
    blockers.push({ code: 'session-dir-not-found', message: dir.reason, detail: { checked: dir.checked } })
  }

  // --- ② the projection cache.
  const cache = findProjectionCache(layout, sessionId)
  if (cache.ok) {
    items.push({ path: cache.path, kind: 'session-cache', reason: 'the session projection cache', isDirectory: false })
  }

  // --- ④ persistent index: measured to be absent on this host. Reported as a
  // checked-and-empty item rather than silently dropped.
  const indexCheck = {
    checked: true,
    found: [],
    reason: 'this host keeps no persistent session index (measured: no database file under the DSH home)',
  }

  return {
    ok: blockers.length === 0 && items.length > 0,
    sessionId,
    sessionDir: dir.ok ? dir.path : null,
    sessionDirSearch: dir.checked,
    projectionCache: cache.ok ? cache.path : null,
    projectionCacheSearch: cache.checked,
    index: indexCheck,
    jobs,
    liveness,
    items,
    blockers,
    notes: [
      'the accounted session id is read from the seam listing; the directory name is only used to find the files',
      'a delete re-reads liveness here, at the moment of decision, rather than trusting the caller\'s scan',
    ],
  }
}

/**
 * Delete one session: plan, then move what the plan allows.
 *
 * @param {object} ctx
 * @param {object} options
 * @param {object} options.layout
 * @param {string} options.sessionId
 * @param {string} [options.workspacePath]
 * @param {boolean} [options.dryRun]
 * @param {boolean} [options.skipJobCheck] - for a controlled test of the block path
 * @returns {Promise<object>}
 */
export async function deleteSession(ctx, options) {
  const plan = await planSessionDelete(ctx, options)
  const blockedByJob = plan.jobs.checked === true && (plan.jobs.owned ?? 0) > 0 && options.skipJobCheck !== true

  const result = {
    ok: false,
    sessionId: options.sessionId,
    plan: {
      items: plan.items,
      blockers: plan.blockers,
      jobs: plan.jobs,
      liveness: plan.liveness,
      index: plan.index,
    },
    move: null,
    accounting: null,
    reason: null,
    archivedResidueNote:
      'deleting an archived session leaves its id in the registry-global archive set; the official API has no ' +
      'unarchive operation, so this is reported and never repaired',
  }

  if (plan.blockers.length > 0) {
    result.reason = `the delete was refused before anything moved: ${plan.blockers.map((blocker) => blocker.code).join(', ')}`
    return result
  }
  if (blockedByJob) {
    result.reason =
      `the session still owns ${plan.jobs.owned} background job(s); they are listed rather than silently abandoned`
    result.plan.blockers = [
      ...result.plan.blockers,
      { code: 'owns-jobs', message: result.reason, detail: { jobs: plan.jobs.jobs } },
    ]
    return result
  }

  const move = await deleteSessionItems({
    layout: options.layout,
    sessionId: options.sessionId,
    items: plan.items,
    risk: options.risk ?? null,
    dryRun: options.dryRun === true,
    instant: options.instant,
    isInsideTrash: options.isInsideTrash ?? makeIsInsideTrash(options.layout),
    detach: (sessionId) => detachSessionAccounting(ctx, sessionId),
    volumeRoot: options.volumeRoot,
  })
  result.move = move
  result.ok = move.ok === true
  result.accounting = move.accounting ?? null
  result.reason = move.reason
  return result
}

export { makeIsInsideTrash }
