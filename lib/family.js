/**
 * dsh-reclaim — family grouping.
 *
 * A parent session and its (direct and indirect) children are graded as ONE
 * unit. The reason is the user's mental model, not tidiness: deleting a parent
 * while keeping a child leaves "an orphan whose parent is gone", which nobody
 * can reason about afterwards. So:
 *
 *   1. **A family's tier is the worst tier any member has.**
 *   2. **A family may be batch-cleared only when every member satisfies every
 *      safety condition on its own.**
 *
 * Rule 2 is the deliberate conservative half. Without it, an archived and
 * long-inactive parent with one never-archived child would become "safe" and
 * get swept up by a one-click clear — deleting a child the user never said
 * anything about. With it, that family lands in the confirm tier: the user may
 * still select it by hand, having seen it.
 *
 * Two relationship kinds are followed here, and both matter:
 *
 *   - **lineage** — `SessionHeader.parentSession`, indexed into child lists by
 *     the session table. A reference that points outside the listing is
 *     reported as unresolved rather than silently treated as a root: a wrong
 *     root would silently move a session into a different family.
 *   - **structured session references** — `@session` edges from the reference
 *     graph. A session some other session points at is "retained" by that
 *     other session, whatever the lineage says.
 *
 * Read-only: pure data in, pure data out.
 */

import { buildReferencingIndex } from './graph.js'

/** Helper: the parent id a record declares, or null. */
function parentOf(record) {
  const parent = record?.parentSession
  if (typeof parent === 'string' && parent.length > 0) return parent
  // The header field is an object in some host versions; accept both shapes
  // rather than silently losing the edge.
  if (parent !== null && typeof parent === 'object' && typeof parent.id === 'string') return parent.id
  return null
}

/** Helper: the child ids the session table indexed, or []. */
function childrenOf(record) {
  const children = record?.childSessions
  if (!Array.isArray(children)) return []
  return children.filter((id) => typeof id === 'string' && id.length > 0)
}

/**
 * Group session records into families.
 *
 * @param {readonly object[]} records - rows from the session table
 * @param {object} [options]
 * @param {readonly object[]} [options.sessionEdges] - `@session` edges from the
 *   reference graph (`{ fromSessionId, toSessionId }`)
 * @returns {{
 *   families: object[],
 *   bySessionId: Map<string, string>,
 *   roots: string[],
 *   notes: string[],
 *   unresolvedParents: object[],
 * }}
 */
export function groupFamilies(records, options = {}) {
  const sessionEdges = options.sessionEdges ?? []
  const notes = []

  const byId = new Map()
  for (const record of records) {
    const id = record?.id
    if (typeof id === 'string' && id.length > 0 && !byId.has(id)) byId.set(id, record)
  }

  // Children come from the session table's own index. Lineage edges are only
  // trusted when BOTH ends are in the listing; an edge to an unlisted parent
  // is reported, never guessed at.
  const childrenByParent = new Map()
  const unresolvedParents = []
  for (const record of byId.values()) {
    const parent = parentOf(record)
    if (parent === null) continue
    if (parent === record.id) {
      unresolvedParents.push({
        sessionId: record.id,
        parentSession: parent,
        reason: 'the session declares itself as its own parent; the edge is ignored',
      })
      continue
    }
    if (!byId.has(parent)) {
      unresolvedParents.push({
        sessionId: record.id,
        parentSession: parent,
        reason:
          'the declared parent is not in the session listing, so its family root cannot be ' +
          'determined; the session is reported as its own root rather than attached to a guessed root',
      })
      continue
    }
    if (!childrenByParent.has(parent)) childrenByParent.set(parent, new Set())
    childrenByParent.get(parent).add(record.id)
  }

  // The session table may index children the header no longer names (or vice
  // versa). Union both indexes so a child edge present in either place still
  // binds the family — a missed lineage edge would shrink a family, and a
  // smaller family is a *less* conservative answer.
  for (const record of byId.values()) {
    for (const child of childrenOf(record)) {
      if (child === record.id || !byId.has(child)) continue
      if (!childrenByParent.has(record.id)) childrenByParent.set(record.id, new Set())
      childrenByParent.get(record.id).add(child)
    }
  }

  // Structural cycles are not expected (a session cannot be its own ancestor),
  // but this walk is a correctness-critical traversal and a cycle would hang it
  // forever, so each walk carries its own visited set.
  const rootOf = new Map()
  let cycleCount = 0
  for (const id of byId.keys()) {
    if (rootOf.has(id)) continue
    const path = []
    const onPath = new Set()
    let current = id
    let root = null
    for (;;) {
      if (rootOf.has(current)) {
        root = rootOf.get(current)
        break
      }
      if (onPath.has(current)) {
        // A cycle: cut it by making the current node the root, and say so.
        cycleCount += 1
        root = current
        break
      }
      onPath.add(current)
      path.push(current)
      const parent = parentOf(byId.get(current))
      const usable = parent !== null && parent !== current && byId.has(parent)
      if (!usable) {
        root = current
        break
      }
      current = parent
    }
    for (const node of path) rootOf.set(node, root)
  }

  const membersByRoot = new Map()
  for (const id of byId.keys()) {
    const root = rootOf.get(id) ?? id
    if (!membersByRoot.has(root)) membersByRoot.set(root, [])
    membersByRoot.get(root).push(id)
  }

  // Structured references: who points at whom, and which targets are retained
  // by a source. The index itself is built by `graph.js` rather than here,
  // because `gradeAll` and `planSessionDelete` decide on the very same relation
  // and a second copy of the rule is a second chance for them to disagree.
  const referencedBy = buildReferencingIndex({ sessionEdges })

  const families = []
  const bySessionId = new Map()
  for (const [root, members] of membersByRoot) {
    members.sort()
    const id = `family:${root}`
    for (const member of members) bySessionId.set(member, id)

    const childCount = members.reduce(
      (sum, member) => sum + (childrenByParent.get(member)?.size ?? 0),
      0,
    )
    const parentOutside = members.filter((member) => {
      const parent = parentOf(byId.get(member))
      return parent !== null && parent !== member && !byId.has(parent)
    })

    families.push({
      id,
      root,
      memberIds: members,
      size: members.length,
      // A member whose declared parent is outside the listing: the family is
      // still graded as a unit, but "is this the whole family?" cannot be
      // proven, and the report says so.
      incomplete: parentOutside.length > 0,
      incompleteReason: parentOutside.length > 0
        ? `${parentOutside.length} member(s) declare a parent that is not in the session listing, so the ` +
          'family boundary cannot be proven complete'
        : null,
      childEdgeCount: childCount,
      lineages: members
        .map((member) => ({ sessionId: member, parentSession: parentOf(byId.get(member)), children: [...(childrenByParent.get(member) ?? [])].sort() }))
        .filter((entry) => entry.parentSession !== null || entry.children.length > 0),
    })
  }

  families.sort((left, right) => right.size - left.size || (left.root < right.root ? -1 : 1))

  if (unresolvedParents.length > 0) {
    notes.push(
      `${unresolvedParents.length} session(s) declare a parent that is not in the listing; each is treated as ` +
        'its own family root, and the situation is reported rather than attached to a guessed root',
    )
  }
  if (cycleCount > 0) {
    notes.push(`${cycleCount} lineage cycle(s) were found and cut at the repeat; a family walk must never hang`)
  }

  const referencedTargets = [...referencedBy.keys()].filter((id) => byId.has(id))
  if (referencedTargets.length > 0) {
    notes.push(
      `${referencedTargets.length} session(s) are the target of a structured @session reference; such a session ` +
        'is retained by the referencing session and cannot be graded safe',
    )
  }

  return { families, bySessionId, roots: families.map((family) => family.root), notes, unresolvedParents, referencedBy }
}
