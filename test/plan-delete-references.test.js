/**
 * The `planSessionDelete` seam — the reference relationship, re-read at the
 * moment of decision.
 *
 * `classifySession` grades a session `danger` when another session references it
 * (`lib/classify.js:212-214`), and `selectable` is false for `danger`
 * (`lib/classify.js:250-253`), so the interface disables the checkbox
 * (`lib/client.js:674-690`). But `POST /delete` never re-derived that verdict:
 * `planSessionDelete`'s only blockers were liveness and "no session directory"
 * (`lib/delete-session.js:230-243`), and the reference relationship was not among
 * them. A hand-rolled request carrying a `sessionId` the interface refuses to
 * offer therefore moved a referenced session into the quarantine anyway.
 * Recorded as §8.5 of `docs/safety.md`.
 *
 * The module's own doc states the discipline this test pins: "liveness is
 * re-read here, at the moment of decision, not taken from the caller's snapshot"
 * (`lib/delete-session.js:26-30`). References are the same kind of fact — a
 * relationship to *other* sessions that a caller's snapshot can be stale about —
 * so they are re-read here too, and a graph that cannot be read is refused rather
 * than read as "nobody references it".
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { deleteSession, planSessionDelete } from '../lib/delete-session.js'

const TARGET = '11111111-1111-4111-8111-111111111111'
const REFERRER = '22222222-2222-4222-8222-222222222222'

/** A synthetic DSH home holding one session directory with a real artifact. */
function homeWithSession(sessionId = TARGET) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-reclaim-plan-delete-'))
  const dir = join(home, 'sessions', '--workspace--', `session-${sessionId}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.v1.jsonl'), '')
  const layout = { home, trash: { root: join(home, '.dsh-reclaim-trash') } }
  return { home, dir, layout }
}

/**
 * A `ctx` whose session store holds nothing, so liveness is `not-live` and this
 * one blocker is measured in isolation. No `sessionQuery` and no `jobs`: the
 * reference graph is therefore unreadable, which is exactly the fail-closed case.
 */
function ctxWithoutLiveSessions() {
  return {
    get(name) {
      if (name === 'sessions') return { get: () => undefined }
      return undefined
    },
  }
}

/** A reference graph carrying exactly the given session→session edges. */
function graphWithEdges(edges) {
  return {
    ok: true,
    generatedAt: '2026-01-01T00:00:00.000Z',
    verifyRead: 'empty-refs',
    coverage: { proven: 2, unknown: 0, total: 2, unknownSessions: [], provenRatio: 1 },
    orphanDetermination: { allowed: true, reason: null, unknownSessions: [] },
    sessions: [],
    attachments: [],
    sessionEdges: edges.map(([fromSessionId, toSessionId], index) => ({
      fromSessionId,
      fromSeq: index,
      toSessionId,
      uri: `dsh-session://${toSessionId}`,
    })),
  }
}

/**
 * A graph that *built* (`ok: true`) but could not prove every session's
 * references were read.
 *
 * This is the shape `buildReferenceGraph` returns when a session's log is
 * truncated or its reader throws: the scan does not fail, it reports the gap in
 * `coverage.unknownSessions` and pauses orphan detection
 * (`orphanDetermination.allowed: false`). An edge belonging to an unread session
 * is simply absent from `sessionEdges`, so a caller that only looks at `ok` reads
 * that absence as "nobody references it".
 */
function graphWithUnprovenSessions(unknownSessions, edges = []) {
  const graph = graphWithEdges(edges)
  const total = unknownSessions.length + 1
  graph.coverage = {
    proven: 1,
    unknown: unknownSessions.length,
    total,
    unknownSessions,
    provenRatio: 1 / total,
  }
  graph.orphanDetermination = {
    allowed: false,
    reason: `attachment relations could not be proven complete for ${unknownSessions.length} of ${total} session(s); orphan detection is PAUSED for the whole scan rather than silently under-counting`,
    unknownSessions,
  }
  return graph
}

test('planSessionDelete refuses a session that another session references', async () => {
  const { dir, layout } = homeWithSession()
  try {
    const plan = await planSessionDelete(ctxWithoutLiveSessions(), {
      layout,
      sessionId: TARGET,
      referenceGraph: graphWithEdges([[REFERRER, TARGET]]),
    })

    const blocker = plan.blockers.find((entry) => entry.code === 'referenced-by-other-session')
    assert.ok(
      blocker !== undefined,
      `a session another session references must not be planned for a move; blockers were ${JSON.stringify(plan.blockers.map((entry) => entry.code))}`,
    )
    assert.deepEqual(blocker.detail.referencingSessionIds, [REFERRER])
    assert.equal(plan.ok, false)

    // The directory is still where it was: planning alone must not move anything.
    assert.equal(existsSync(dir), true)
  } finally {
    rmSync(layout.home, { recursive: true, force: true })
  }
})

test('planSessionDelete still plans a session that nobody references', async () => {
  const { dir, layout } = homeWithSession()
  try {
    const plan = await planSessionDelete(ctxWithoutLiveSessions(), {
      layout,
      sessionId: TARGET,
      referenceGraph: graphWithEdges([]),
    })

    assert.deepEqual(plan.blockers, [])
    assert.equal(plan.ok, true)
    assert.deepEqual(plan.items.map((item) => item.path), [dir])
  } finally {
    rmSync(layout.home, { recursive: true, force: true })
  }
})

test('a session referencing itself is not another session referencing it', async () => {
  const { layout } = homeWithSession()
  try {
    const plan = await planSessionDelete(ctxWithoutLiveSessions(), {
      layout,
      sessionId: TARGET,
      referenceGraph: graphWithEdges([[TARGET, TARGET]]),
    })

    assert.deepEqual(plan.blockers, [])
  } finally {
    rmSync(layout.home, { recursive: true, force: true })
  }
})

test('an unreadable reference graph refuses the delete instead of reading as "no references"', async () => {
  const { layout } = homeWithSession()
  try {
    // No `referenceGraph` is injected, and this `ctx` exposes no `sessionQuery`,
    // so the graph cannot be built at all. "Could not read it" must never be
    // rounded down to "nobody references it".
    const plan = await planSessionDelete(ctxWithoutLiveSessions(), { layout, sessionId: TARGET })

    assert.equal(plan.ok, false)
    assert.ok(
      plan.blockers.some((entry) => entry.code === 'reference-graph-unavailable'),
      `expected a reference-graph-unavailable blocker; blockers were ${JSON.stringify(plan.blockers.map((entry) => entry.code))}`,
    )
  } finally {
    rmSync(layout.home, { recursive: true, force: true })
  }
})

test('deleteSession refuses a referenced session and moves nothing', async () => {
  const { dir, layout } = homeWithSession()
  try {
    const result = await deleteSession(ctxWithoutLiveSessions(), {
      layout,
      sessionId: TARGET,
      dryRun: false,
      referenceGraph: graphWithEdges([[REFERRER, TARGET]]),
    })

    assert.equal(result.ok, false)
    assert.equal(result.move, null)
    assert.match(result.reason, /referenced-by-other-session/)
    assert.equal(existsSync(dir), true)
    assert.equal(readdirSync(dir).includes('session.v1.jsonl'), true)
    // Nothing was carried into the quarantine either.
    assert.equal(existsSync(join(layout.trash.root)), false)
  } finally {
    rmSync(layout.home, { recursive: true, force: true })
  }
})

test('a graph that could not be proven complete refuses the delete', async () => {
  const { dir, layout } = homeWithSession()
  try {
    // `ok` is true — the scan ran and returned a report. But REFERRER's log could
    // not be read, so its edge to TARGET is missing from `sessionEdges`. The
    // graph already knows it could not prove completeness and says so in
    // `coverage.unknownSessions`; a caller that reads only `ok` turns that gap
    // into "nobody references TARGET" and authorises the move.
    const plan = await planSessionDelete(ctxWithoutLiveSessions(), {
      layout,
      sessionId: TARGET,
      referenceGraph: graphWithUnprovenSessions([REFERRER]),
    })

    assert.equal(plan.ok, false)
    assert.ok(
      plan.blockers.some((entry) => entry.code === 'reference-graph-incomplete'),
      `expected a reference-graph-incomplete blocker; blockers were ${JSON.stringify(plan.blockers.map((entry) => entry.code))}`,
    )
    assert.equal(existsSync(dir), true)
  } finally {
    rmSync(layout.home, { recursive: true, force: true })
  }
})

test('deleteSession refuses a partially readable graph and moves nothing', async () => {
  const { dir, layout } = homeWithSession()
  try {
    const result = await deleteSession(ctxWithoutLiveSessions(), {
      layout,
      sessionId: TARGET,
      dryRun: false,
      referenceGraph: graphWithUnprovenSessions([REFERRER]),
    })

    assert.equal(result.ok, false)
    assert.equal(result.move, null)
    assert.match(result.reason, /reference-graph-incomplete/)
    assert.equal(existsSync(dir), true)
    assert.equal(existsSync(join(layout.trash.root)), false)
  } finally {
    rmSync(layout.home, { recursive: true, force: true })
  }
})
