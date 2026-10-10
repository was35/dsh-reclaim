/**
 * Which graded rows may actually be moved into the quarantine, and what that
 * means on disk.
 *
 * ## Why this module exists
 *
 * The grading has always marked some attachment and cache rows `batchClearable`,
 * but nothing could act on that mark: the trash has had `attachments/`,
 * `caches/` and `other/` subdirectories since the move primitive landed, and no
 * producer ever filled them (docs/safety.md §8.8). So "safe — batch clearable"
 * was, for those rows, a promise with no path out.
 *
 * ## The rule this module is built around
 *
 * **The caller names rows by id. It never names a path.** Paths are read off the
 * row the server just graded, in the same pass that decided the row was safe —
 * so "which files does clearing this mean" and "is clearing this allowed" are
 * answered by one scan, and a caller cannot point the move at a file of its
 * choosing. That is the §8.5 lesson applied before the fact: `body.risk` was a
 * caller's self-report and authorized nothing.
 *
 * ## What is deliberately *not* clearable here
 *
 * A session row is refused even when it is `batchClearable`, because moving a
 * session is only part of deleting one: the accounting steps (the workspace's
 * `sessionIds`, background-job ownership) live in `deleteSession`, and a bare
 * move would leave a session that is gone from disk but still accounted for.
 * That path is `POST /delete` and it stays the only one.
 */

import { resolve, sep } from 'node:path'

/**
 * Row kind → trash subdirectory kind. A row kind that is absent here cannot be
 * cleared by this module, and that is the point: the map is an allow-list, so a
 * new row kind is refused until someone decides where it goes.
 */
const TRASH_KIND_BY_ROW_KIND = Object.freeze({
  attachment: 'attachment',
  cache: 'cache',
  // Cache *families* (`request-images`, `tmp`) are rows of their own shape but
  // land in the same subdirectory as the single-file orphan caches.
  'cache-family': 'cache',
})

function refusal(id, code, message, detail = null) {
  return { id: typeof id === 'string' ? id : null, code, message, detail }
}

/** The paths a row says clearing it would move. Never taken from the caller. */
function pathsOf(row) {
  const paths = row?.facts?.paths
  if (Array.isArray(paths)) return paths.filter((path) => typeof path === 'string' && path.length > 0)
  const single = row?.facts?.path
  return typeof single === 'string' && single.length > 0 ? [single] : []
}

/** True when `inner` is `outer` itself or lives underneath it. */
function isInside(inner, outer) {
  if (inner === outer) return true
  return inner.startsWith(outer.endsWith(sep) ? outer : outer + sep)
}

/**
 * @param {readonly object[]} rows - every graded row from one scan
 * @param {readonly string[]} requestedIds - the rows the caller wants cleared
 * @returns {{ ok: boolean, items: object[], refusals: object[], reason: string|null }}
 *   `items` are `{ path, kind, reason }` candidates for the move primitive.
 *   `ok` is false when **any** id was refused — the whole request is refused
 *   rather than clearing the subset that happened to pass, because a partial
 *   clear of a selection the user made as one action is the kind of surprise
 *   this plugin exists to avoid.
 */
export function planClearCandidates(rows, requestedIds) {
  const byId = new Map()
  for (const row of rows ?? []) {
    if (typeof row?.id === 'string' && !byId.has(row.id)) byId.set(row.id, row)
  }

  const items = []
  const refusals = []
  const seen = new Set()

  for (const id of requestedIds ?? []) {
    if (typeof id !== 'string' || id.length === 0) {
      refusals.push(refusal(id, 'invalid-id', '每一项都要用一个非空字符串 id 来指名'))
      continue
    }
    if (seen.has(id)) continue
    seen.add(id)

    const row = byId.get(id)
    if (row === undefined) {
      refusals.push(refusal(id, 'unknown-id', '这一次扫描里没有这个 id，所以无法确认它现在是什么、能不能清'))
      continue
    }

    const kind = TRASH_KIND_BY_ROW_KIND[row.kind]
    if (kind === undefined) {
      if (row.kind === 'session') {
        refusals.push(
          refusal(
            id,
            'session-not-clearable-here',
            '会话不能走这条通路：搬走目录只是删除一个会话的一部分，工作区 sessionIds 与后台任务归属还要一并处理，' +
              '那条通路是 POST /delete，而且只有它',
          ),
        )
      } else {
        refusals.push(
          refusal(id, 'kind-not-clearable', `这个 id 指向的是 ${JSON.stringify(row.kind)} 行，本通路不清理这一类`),
        )
      }
      continue
    }

    if (row.batchClearable !== true) {
      refusals.push(
        refusal(id, 'row-not-clearable', '这一行当前不在可批量清理档，服务端不会因为被指名就照做', {
          tier: row.tier ?? null,
          tierReasons: row.tierReasons ?? [],
        }),
      )
      continue
    }

    const paths = pathsOf(row)
    if (paths.length === 0) {
      refusals.push(
        refusal(id, 'no-paths', '这一行没有给出任何磁盘路径，所以「清掉它」没有确定的含义', {
          cacheKind: row.cacheKind ?? null,
        }),
      )
      continue
    }

    for (const path of paths) {
      items.push({ path, kind, reason: `cleared by id ${id} (${row.kind})` })
    }
  }

  // Two ids can name the same file — the same cache reached through two rows, say.
  // That is one item named twice, not a nesting problem, and the move primitive
  // already dedupes by resolved path. Collapse them *before* the containment test
  // so a duplicate cannot be mistaken for a parent/child pair.
  const unique = new Map()
  for (const item of items) {
    const key = resolve(item.path)
    if (!unique.has(key)) unique.set(key, item)
  }
  const candidates = [...unique.values()]

  // Nesting: a directory and something inside it cannot both be moved. Whichever
  // went first would decide the outcome for the other, and the batch would then
  // hold a file whose parent directory is also in the batch — a restore would
  // put the directory back without it and report the file missing. Refusing is
  // cheap; explaining that later is not.
  outer: for (const inner of candidates) {
    for (const outer of candidates) {
      if (inner === outer) continue
      if (isInside(resolve(inner.path), resolve(outer.path))) {
        refusals.push(
          refusal(null, 'nested-selection', '所选内容里有一个路径套在另一个里面，一次搬运无法同时容纳两者', {
            inner: inner.path,
            outer: outer.path,
          }),
        )
        break outer
      }
    }
  }

  const ok = refusals.length === 0 && candidates.length > 0
  return {
    ok,
    items: ok ? candidates : [],
    refusals,
    reason: ok ? null : (refusals[0]?.message ?? '没有任何一项被选中'),
  }
}
