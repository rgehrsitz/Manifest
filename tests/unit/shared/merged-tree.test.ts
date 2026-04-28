import { describe, expect, it } from 'vitest'
import { buildMergedTree, computeSubtreeSummaries } from '../../../src/shared/merged-tree'
import { diffProjects } from '../../../src/shared/diff-engine'
import type { Project, ManifestNode } from '../../../src/shared/types'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeProject(nodes: ManifestNode[]): Project {
  return {
    version: 2,
    id: 'project-id',
    name: 'Test Project',
    created: '2026-01-01T00:00:00.000Z',
    modified: '2026-01-01T00:00:00.000Z',
    nodes,
  }
}

function n(
  id: string,
  parentId: string | null,
  order: number,
  name = id,
  properties: ManifestNode['properties'] = {}
): ManifestNode {
  return {
    id,
    parentId,
    name,
    order,
    properties,
    created: '2026-01-01T00:00:00.000Z',
    modified: '2026-01-02T00:00:00.000Z',
  }
}

/** Build a merged tree from two flat node lists — diffs derived automatically. */
function merge(fromNodes: ManifestNode[], toNodes: ManifestNode[]) {
  const from = makeProject(fromNodes)
  const to = makeProject(toNodes)
  const diffs = diffProjects(from, to)
  return buildMergedTree(from, to, diffs, 'snap-a', 'snap-b')
}

/** Find a node in the merged output by real (non-ghost) id. */
function findNode(merged: ReturnType<typeof merge>, id: string) {
  return merged.nodes.find(nd => nd.id === id)
}

/** Find a ghost node by original id. */
function findGhost(merged: ReturnType<typeof merge>, originalId: string) {
  return merged.nodes.find(nd => nd.id === `ghost:${originalId}`)
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('buildMergedTree', () => {
  // ── Identity ────────────────────────────────────────────────────────────────

  it('identity: unchanged snapshot produces all-unchanged nodes, no ghosts', () => {
    const nodes = [n('root', null, 0), n('child', 'root', 0)]
    const result = merge(nodes, nodes)

    expect(result.nodes).toHaveLength(2)
    for (const nd of result.nodes) {
      expect(nd.status).toBe('unchanged')
      expect(nd.id).not.toMatch(/^ghost:/)
    }
  })

  it('identity: summary counts are all zero', () => {
    const nodes = [n('root', null, 0)]
    const { summary } = merge(nodes, nodes)
    expect(summary.added).toBe(0)
    expect(summary.removed).toBe(0)
    expect(summary.moved).toBe(0)
    expect(summary.renamed).toBe(0)
    expect(summary.propertyChanged).toBe(0)
    expect(summary.orderChanged).toBe(0)
  })

  it('stores fromSnapshot and toSnapshot names', () => {
    const nodes = [n('root', null, 0)]
    const from = makeProject(nodes)
    const to = makeProject(nodes)
    const result = buildMergedTree(from, to, [], 'v1', 'v2')
    expect(result.fromSnapshot).toBe('v1')
    expect(result.toSnapshot).toBe('v2')
  })

  // ── Pure add ────────────────────────────────────────────────────────────────

  it('pure add: new node has status added', () => {
    const fromNodes = [n('root', null, 0)]
    const toNodes = [n('root', null, 0), n('new', 'root', 0)]
    const result = merge(fromNodes, toNodes)

    const added = findNode(result, 'new')
    expect(added).toBeDefined()
    expect(added!.status).toBe('added')
    expect(added!.diffs).toHaveLength(1)
    expect(added!.diffs[0].changeType).toBe('added')
  })

  it('pure add: summary.added increments', () => {
    const fromNodes = [n('root', null, 0)]
    const toNodes = [n('root', null, 0), n('a', 'root', 0), n('b', 'root', 1)]
    const { summary } = merge(fromNodes, toNodes)
    expect(summary.added).toBe(2)
  })

  it('pure add: no ghost emitted for added node', () => {
    const fromNodes = [n('root', null, 0)]
    const toNodes = [n('root', null, 0), n('new', 'root', 0)]
    const result = merge(fromNodes, toNodes)
    expect(findGhost(result, 'new')).toBeUndefined()
  })

  // ── Pure remove ─────────────────────────────────────────────────────────────

  it('pure remove: missing node emits a ghost with status removed', () => {
    const fromNodes = [n('root', null, 0), n('gone', 'root', 0)]
    const toNodes = [n('root', null, 0)]
    const result = merge(fromNodes, toNodes)

    const ghost = findGhost(result, 'gone')
    expect(ghost).toBeDefined()
    expect(ghost!.status).toBe('removed')
    expect(ghost!.id).toBe('ghost:gone')
  })

  it('pure remove: ghost carries the removed nodes name', () => {
    const fromNodes = [n('root', null, 0), n('gone', 'root', 0, 'Goodbye Node')]
    const toNodes = [n('root', null, 0)]
    const result = merge(fromNodes, toNodes)
    expect(findGhost(result, 'gone')!.name).toBe('Goodbye Node')
  })

  it('pure remove: summary.removed increments', () => {
    const fromNodes = [n('root', null, 0), n('a', 'root', 0), n('b', 'root', 1)]
    const toNodes = [n('root', null, 0)]
    const { summary } = merge(fromNodes, toNodes)
    expect(summary.removed).toBe(2)
  })

  // ── Pure rename ─────────────────────────────────────────────────────────────

  it('pure rename: live node has status renamed', () => {
    const fromNodes = [n('root', null, 0), n('rack', 'root', 0, 'Rack A')]
    const toNodes = [n('root', null, 0), n('rack', 'root', 0, 'Rack B')]
    const result = merge(fromNodes, toNodes)

    const renamed = findNode(result, 'rack')
    expect(renamed!.status).toBe('renamed')
    expect(renamed!.name).toBe('Rack B')
    expect(renamed!.previous?.name).toBe('Rack A')
  })

  it('pure rename: no ghost emitted', () => {
    const fromNodes = [n('root', null, 0), n('rack', 'root', 0, 'Rack A')]
    const toNodes = [n('root', null, 0), n('rack', 'root', 0, 'Rack B')]
    const result = merge(fromNodes, toNodes)
    expect(findGhost(result, 'rack')).toBeUndefined()
  })

  it('pure rename: summary.renamed increments', () => {
    const fromNodes = [n('root', null, 0), n('rack', 'root', 0, 'Rack A')]
    const toNodes = [n('root', null, 0), n('rack', 'root', 0, 'Rack B')]
    const { summary } = merge(fromNodes, toNodes)
    expect(summary.renamed).toBe(1)
  })

  // ── Pure move ───────────────────────────────────────────────────────────────

  it('pure move: live node has status moved, ghost emitted at origin', () => {
    const fromNodes = [
      n('root', null, 0),
      n('zone-a', 'root', 0),
      n('zone-b', 'root', 1),
      n('rack', 'zone-a', 0),
    ]
    const toNodes = [
      n('root', null, 0),
      n('zone-a', 'root', 0),
      n('zone-b', 'root', 1),
      n('rack', 'zone-b', 0),   // moved to zone-b
    ]
    const result = merge(fromNodes, toNodes)

    const live = findNode(result, 'rack')
    expect(live!.status).toBe('moved')
    expect(live!.parentId).toBe('zone-b')
    expect(live!.previous?.parentId).toBe('zone-a')

    const ghost = findGhost(result, 'rack')
    expect(ghost).toBeDefined()
    expect(ghost!.status).toBe('moved-from')
    expect(ghost!.id).toBe('ghost:rack')
  })

  it('pure move: ghost parentId points to the original parent (still live)', () => {
    const fromNodes = [
      n('root', null, 0),
      n('p1', 'root', 0),
      n('p2', 'root', 1),
      n('child', 'p1', 0),
    ]
    const toNodes = [
      n('root', null, 0),
      n('p1', 'root', 0),
      n('p2', 'root', 1),
      n('child', 'p2', 0),
    ]
    const result = merge(fromNodes, toNodes)
    // Ghost should sit under p1 (the original parent, which still lives in B)
    const ghost = findGhost(result, 'child')
    expect(ghost!.parentId).toBe('p1')
  })

  it('pure move: summary.moved increments', () => {
    const fromNodes = [
      n('root', null, 0),
      n('p1', 'root', 0),
      n('p2', 'root', 1),
      n('child', 'p1', 0),
    ]
    const toNodes = [
      n('root', null, 0),
      n('p1', 'root', 0),
      n('p2', 'root', 1),
      n('child', 'p2', 0),
    ]
    const { summary } = merge(fromNodes, toNodes)
    expect(summary.moved).toBe(1)
  })

  // ── Property changed ─────────────────────────────────────────────────────────

  it('property-changed: live node has status property-changed', () => {
    const fromNodes = [n('root', null, 0), n('rack', 'root', 0, 'Rack', { serial: 'A-1' })]
    const toNodes  = [n('root', null, 0), n('rack', 'root', 0, 'Rack', { serial: 'A-2' })]
    const result = merge(fromNodes, toNodes)

    const changed = findNode(result, 'rack')
    expect(changed!.status).toBe('property-changed')
    expect(changed!.properties.serial).toBe('A-2')
    expect(changed!.previous?.properties?.serial).toBe('A-1')
  })

  it('property-changed: summary.propertyChanged increments', () => {
    const fromNodes = [n('root', null, 0), n('rack', 'root', 0, 'Rack', { serial: 'A-1' })]
    const toNodes  = [n('root', null, 0), n('rack', 'root', 0, 'Rack', { serial: 'A-2' })]
    const { summary } = merge(fromNodes, toNodes)
    expect(summary.propertyChanged).toBe(1)
  })

  // ── Mixed status ─────────────────────────────────────────────────────────────

  it('rename + property change → mixed status', () => {
    const fromNodes = [n('root', null, 0), n('rack', 'root', 0, 'Rack A', { serial: 'A-1' })]
    const toNodes  = [n('root', null, 0), n('rack', 'root', 0, 'Rack B', { serial: 'A-2' })]
    const result = merge(fromNodes, toNodes)

    const nd = findNode(result, 'rack')
    expect(nd!.status).toBe('mixed')
  })

  it('move + rename → mixed status', () => {
    const fromNodes = [
      n('root', null, 0),
      n('p1', 'root', 0),
      n('p2', 'root', 1),
      n('child', 'p1', 0, 'Child A'),
    ]
    const toNodes = [
      n('root', null, 0),
      n('p1', 'root', 0),
      n('p2', 'root', 1),
      n('child', 'p2', 0, 'Child B'),
    ]
    const result = merge(fromNodes, toNodes)
    expect(findNode(result, 'child')!.status).toBe('mixed')
  })

  // ── Ghost parent resolution ──────────────────────────────────────────────────

  it('removed parent with removed child: child ghost points to parent ghost', () => {
    const fromNodes = [
      n('root', null, 0),
      n('parent', 'root', 0),
      n('child', 'parent', 0),
    ]
    const toNodes = [n('root', null, 0)]  // both parent and child removed
    const result = merge(fromNodes, toNodes)

    const childGhost = findGhost(result, 'child')
    const parentGhost = findGhost(result, 'parent')
    expect(childGhost).toBeDefined()
    expect(parentGhost).toBeDefined()
    // child ghost should point to parent ghost, not original parent id
    expect(childGhost!.parentId).toBe(`ghost:parent`)
    expect(parentGhost!.parentId).toBe('root')  // root still lives in B
  })

  it('root-level ghost has null parentId', () => {
    const fromNodes = [
      n('root', null, 0),
      n('sib', null, 1),
    ]
    const toNodes = [n('root', null, 0)]
    const result = merge(fromNodes, toNodes)

    const ghost = findGhost(result, 'sib')
    expect(ghost!.parentId).toBeNull()
  })

  // ── Added parent with children ───────────────────────────────────────────────

  it('added parent with children: parent added, children also added', () => {
    const fromNodes = [n('root', null, 0)]
    const toNodes = [
      n('root', null, 0),
      n('parent', 'root', 0),
      n('child', 'parent', 0),
    ]
    const result = merge(fromNodes, toNodes)

    expect(findNode(result, 'parent')!.status).toBe('added')
    expect(findNode(result, 'child')!.status).toBe('added')
  })

  // ── Summary counts ───────────────────────────────────────────────────────────

  it('summary counts match actual changes', () => {
    const fromNodes = [
      n('root', null, 0),
      n('keep', 'root', 0),
      n('rename-me', 'root', 1, 'Old Name'),
      n('move-me', 'root', 2),
      n('p1', 'root', 3),
      n('remove-me', 'root', 4),
    ]
    const toNodes = [
      n('root', null, 0),
      n('keep', 'root', 0),
      n('rename-me', 'root', 1, 'New Name'),   // renamed
      n('p1', 'root', 2),
      n('move-me', 'p1', 0),                    // moved under p1
      n('new-node', 'root', 3),                 // added
      // remove-me gone
    ]
    const { summary } = merge(fromNodes, toNodes)
    expect(summary.added).toBe(1)
    expect(summary.removed).toBe(1)
    expect(summary.renamed).toBe(1)
    expect(summary.moved).toBe(1)
  })

  // ── Diffs embedded per-node ───────────────────────────────────────────────────

  it('unchanged nodes have empty diffs array', () => {
    const nodes = [n('root', null, 0), n('a', 'root', 0)]
    const result = merge(nodes, nodes)
    for (const nd of result.nodes) {
      expect(nd.diffs).toEqual([])
    }
  })

  it('changed node embeds all its diffs, not just one', () => {
    // rename + property change → two diff entries on the same node → 'mixed'
    const fromNodes = [n('root', null, 0), n('rack', 'root', 0, 'Old', { v: 1 })]
    const toNodes  = [n('root', null, 0), n('rack', 'root', 0, 'New', { v: 2 })]
    const result = merge(fromNodes, toNodes)

    const rack = findNode(result, 'rack')
    expect(rack!.diffs.length).toBeGreaterThanOrEqual(2)
  })

  // ── Ghost diffs ───────────────────────────────────────────────────────────────

  it('removed ghosts embed their removal diff', () => {
    const fromNodes = [n('root', null, 0), n('gone', 'root', 0)]
    const toNodes = [n('root', null, 0)]
    const result = merge(fromNodes, toNodes)

    const ghost = findGhost(result, 'gone')
    expect(ghost!.diffs).toHaveLength(1)
    expect(ghost!.diffs[0].changeType).toBe('removed')
  })

  it('moved-from ghosts still have empty diffs array', () => {
    const fromNodes = [
      n('root', null, 0),
      n('p1', 'root', 0),
      n('p2', 'root', 1),
      n('child', 'p1', 0),
    ]
    const toNodes = [
      n('root', null, 0),
      n('p1', 'root', 0),
      n('p2', 'root', 1),
      n('child', 'p2', 0),
    ]
    const result = merge(fromNodes, toNodes)

    const ghost = findGhost(result, 'child')
    expect(ghost!.diffs).toEqual([])
  })

  // ── No duplicate nodes ────────────────────────────────────────────────────────

  it('no duplicate ids in output', () => {
    const fromNodes = [
      n('root', null, 0),
      n('p1', 'root', 0),
      n('child', 'p1', 0),
    ]
    const toNodes = [
      n('root', null, 0),
      n('p1', 'root', 0),
      n('child', 'root', 0),  // child moved to root level
    ]
    const result = merge(fromNodes, toNodes)
    const ids = result.nodes.map(nd => nd.id)
    const uniqueIds = new Set(ids)
    expect(ids).toHaveLength(uniqueIds.size)
  })

  it('total node count = |B| + ghosts', () => {
    const fromNodes = [
      n('root', null, 0),
      n('a', 'root', 0),
      n('b', 'root', 1),  // will be removed
    ]
    const toNodes = [
      n('root', null, 0),
      n('a', 'root', 0),
      n('c', 'root', 1),  // newly added
    ]
    const result = merge(fromNodes, toNodes)
    // B has 3 nodes (root, a, c); 1 ghost for b → total 4
    expect(result.nodes).toHaveLength(4)
  })
})

// ─── computeSubtreeSummaries ─────────────────────────────────────────────────

describe('computeSubtreeSummaries', () => {
  it('all-zeros for an unchanged tree', () => {
    const nodes = [n('root', null, 0), n('child', 'root', 0)]
    const summaries = computeSubtreeSummaries(merge(nodes, nodes))

    expect(summaries.get('root')).toEqual({
      added: 0, removed: 0, renamed: 0, moved: 0, propertyChanged: 0, orderChanged: 0,
    })
    expect(summaries.get('child')).toEqual({
      added: 0, removed: 0, renamed: 0, moved: 0, propertyChanged: 0, orderChanged: 0,
    })
  })

  it("descendant counts roll up into ancestor's subtree summary", () => {
    const fromNodes = [
      n('root', null, 0),
      n('a', 'root', 0),
      n('b', 'root', 1),
      n('a-child', 'a', 0, 'a-child', { color: 'red' }),
    ]
    const toNodes = [
      n('root', null, 0),
      n('a', 'root', 0),
      n('b', 'root', 1, 'b-renamed'),                              // renamed
      n('a-child', 'a', 0, 'a-child', { color: 'blue' }),          // property-changed
    ]
    const summaries = computeSubtreeSummaries(merge(fromNodes, toNodes))

    // root's subtree summary contains all changes anywhere below it.
    expect(summaries.get('root')).toMatchObject({
      renamed: 1,
      propertyChanged: 1,
    })
    // 'a' contains only the property change on its child.
    expect(summaries.get('a')).toMatchObject({
      renamed: 0,
      propertyChanged: 1,
    })
    // 'b' was renamed; itself contributes 1, no descendants.
    expect(summaries.get('b')).toMatchObject({
      renamed: 1,
      propertyChanged: 0,
    })
    // Leaf with the change carries it.
    expect(summaries.get('a-child')).toMatchObject({
      propertyChanged: 1,
    })
  })

  it('counts a removed node via its ghost', () => {
    const fromNodes = [n('root', null, 0), n('gone', 'root', 0)]
    const toNodes   = [n('root', null, 0)]
    const summaries = computeSubtreeSummaries(merge(fromNodes, toNodes))

    // The ghost gets keyed by `ghost:gone` and carries the removal.
    expect(summaries.get('ghost:gone')).toMatchObject({ removed: 1 })
    // Root's subtree includes the removed ghost.
    expect(summaries.get('root')).toMatchObject({ removed: 1 })
  })

  it('summary for an isolated leaf with no diffs is all zeros, present in the map', () => {
    const nodes = [n('root', null, 0), n('leaf', 'root', 0)]
    const summaries = computeSubtreeSummaries(merge(nodes, nodes))

    expect(summaries.has('leaf')).toBe(true)
    expect(summaries.get('leaf')).toEqual({
      added: 0, removed: 0, renamed: 0, moved: 0, propertyChanged: 0, orderChanged: 0,
    })
  })

  it('different change types accumulate independently', () => {
    const fromNodes = [
      n('root', null, 0),
      n('a', 'root', 0, 'a', { color: 'red' }),
      n('b', 'root', 1),
      n('c', 'root', 2),  // will be removed
    ]
    const toNodes = [
      n('root', null, 0),
      n('a', 'root', 0, 'a', { color: 'blue' }),    // property-changed
      n('b', 'root', 1, 'b-new'),                    // renamed
      n('d', 'root', 2),                              // newly added
    ]
    const summaries = computeSubtreeSummaries(merge(fromNodes, toNodes))

    const rootSummary = summaries.get('root')!
    expect(rootSummary.propertyChanged).toBe(1)
    expect(rootSummary.renamed).toBe(1)
    expect(rootSummary.added).toBe(1)
    expect(rootSummary.removed).toBe(1)
  })
})
