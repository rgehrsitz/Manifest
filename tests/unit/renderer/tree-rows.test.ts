import { describe, expect, it } from 'vitest'
import { flattenTree } from '../../../src/renderer/src/lib/tree-rows'
import { buildTree } from '../../../src/renderer/src/lib/tree'
import type { ManifestNode } from '../../../src/shared/types'
import type { MergedTreeNode } from '../../../src/shared/merged-tree'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function node(
  id: string,
  parentId: string | null,
  order: number,
  name = id
): ManifestNode {
  return {
    id,
    parentId,
    name,
    order,
    properties: {},
    created: '2026-01-01T00:00:00.000Z',
    modified: '2026-01-01T00:00:00.000Z',
  }
}

function makeTree(nodes: ManifestNode[]) {
  const tree = buildTree(nodes)
  if (!tree) throw new Error('buildTree returned null for non-empty input')
  return tree
}

// ─── flattenTree — normal mode ────────────────────────────────────────────────

describe('flattenTree (normal mode)', () => {
  it('returns empty array for empty tree', () => {
    const nodes = [node('root', null, 0)]
    const tree = makeTree(nodes)
    const rows = flattenTree(tree, new Set(['root']))
    expect(rows).toHaveLength(1)
    expect(rows[0].kind).toBe('normal')
    expect(rows[0].id).toBe('root')
  })

  it('returns only root when collapsed', () => {
    const nodes = [
      node('root', null, 0),
      node('child-a', 'root', 0),
      node('child-b', 'root', 1),
    ]
    const tree = makeTree(nodes)
    // root not in expandedIds → children hidden
    const rows = flattenTree(tree, new Set())
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe('root')
    expect(rows[0].hasChildren).toBe(true)
    expect(rows[0].expanded).toBe(false)
  })

  it('returns root + children when root is expanded', () => {
    const nodes = [
      node('root', null, 0),
      node('child-a', 'root', 0),
      node('child-b', 'root', 1),
    ]
    const tree = makeTree(nodes)
    const rows = flattenTree(tree, new Set(['root']))
    expect(rows).toHaveLength(3)
    expect(rows[0].id).toBe('root')
    expect(rows[1].id).toBe('child-a')
    expect(rows[2].id).toBe('child-b')
  })

  it('respects depth — children have depth 1, grandchildren depth 2', () => {
    const nodes = [
      node('root', null, 0),
      node('child', 'root', 0),
      node('grandchild', 'child', 0),
    ]
    const tree = makeTree(nodes)
    const rows = flattenTree(tree, new Set(['root', 'child']))
    expect(rows[0].depth).toBe(0)
    expect(rows[1].depth).toBe(1)
    expect(rows[2].depth).toBe(2)
  })

  it('skips collapsed subtrees — grandchildren hidden when parent collapsed', () => {
    const nodes = [
      node('root', null, 0),
      node('child', 'root', 0),
      node('grandchild', 'child', 0),
    ]
    const tree = makeTree(nodes)
    // root expanded, child collapsed
    const rows = flattenTree(tree, new Set(['root']))
    expect(rows).toHaveLength(2)
    expect(rows[1].id).toBe('child')
    expect(rows[1].expanded).toBe(false)
  })

  it('respects sibling order from the order field', () => {
    const nodes = [
      node('root', null, 0),
      node('c', 'root', 2, 'C'),
      node('a', 'root', 0, 'A'),
      node('b', 'root', 1, 'B'),
    ]
    const tree = makeTree(nodes)
    const rows = flattenTree(tree, new Set(['root']))
    expect(rows.map(r => r.id)).toEqual(['root', 'a', 'b', 'c'])
  })

  it('sets isFirst and isLast correctly for siblings', () => {
    const nodes = [
      node('root', null, 0),
      node('a', 'root', 0),
      node('b', 'root', 1),
      node('c', 'root', 2),
    ]
    const tree = makeTree(nodes)
    const rows = flattenTree(tree, new Set(['root']))
    expect(rows[1].id).toBe('a')
    expect(rows[1].kind === 'normal' && rows[1].isFirst).toBe(true)
    expect(rows[1].kind === 'normal' && rows[1].isLast).toBe(false)
    expect(rows[2].kind === 'normal' && rows[2].isFirst).toBe(false)
    expect(rows[2].kind === 'normal' && rows[2].isLast).toBe(false)
    expect(rows[3].kind === 'normal' && rows[3].isFirst).toBe(false)
    expect(rows[3].kind === 'normal' && rows[3].isLast).toBe(true)
  })

  it('root is always isFirst and isLast (single root)', () => {
    const nodes = [node('root', null, 0)]
    const tree = makeTree(nodes)
    const rows = flattenTree(tree, new Set(['root']))
    expect(rows[0].kind === 'normal' && rows[0].isFirst).toBe(true)
    expect(rows[0].kind === 'normal' && rows[0].isLast).toBe(true)
  })

  it('single child is both isFirst and isLast', () => {
    const nodes = [
      node('root', null, 0),
      node('only', 'root', 0),
    ]
    const tree = makeTree(nodes)
    const rows = flattenTree(tree, new Set(['root']))
    expect(rows[1].kind === 'normal' && rows[1].isFirst).toBe(true)
    expect(rows[1].kind === 'normal' && rows[1].isLast).toBe(true)
  })

  it('deep tree — only the expanded spine is visible', () => {
    // 5-level chain: root → l1 → l2 → l3 → leaf
    const nodes = [
      node('root', null, 0),
      node('l1', 'root', 0),
      node('l2', 'l1', 0),
      node('l3', 'l2', 0),
      node('leaf', 'l3', 0),
    ]
    const tree = makeTree(nodes)
    // Only root and l1 expanded
    const rows = flattenTree(tree, new Set(['root', 'l1']))
    expect(rows.map(r => r.id)).toEqual(['root', 'l1', 'l2'])
    expect(rows[2].hasChildren).toBe(true)
    expect(rows[2].expanded).toBe(false)
  })

  it('is stable — same input produces same id sequence', () => {
    const nodes = [
      node('root', null, 0),
      node('a', 'root', 0),
      node('b', 'root', 1),
    ]
    const tree = makeTree(nodes)
    const expandedIds = new Set(['root'])
    const rows1 = flattenTree(tree, expandedIds)
    const rows2 = flattenTree(tree, expandedIds)
    expect(rows1.map(r => r.id)).toEqual(rows2.map(r => r.id))
  })

  it('all rows have kind: normal in normal mode', () => {
    const nodes = [
      node('root', null, 0),
      node('a', 'root', 0),
      node('b', 'root', 1),
    ]
    const tree = makeTree(nodes)
    const rows = flattenTree(tree, new Set(['root']))
    for (const row of rows) {
      expect(row.kind).toBe('normal')
    }
  })

  it('hasChildren reflects actual child existence', () => {
    const nodes = [
      node('root', null, 0),
      node('parent', 'root', 0),
      node('child', 'parent', 0),
      node('leaf', 'root', 1),
    ]
    const tree = makeTree(nodes)
    const rows = flattenTree(tree, new Set(['root', 'parent']))
    const rowById = Object.fromEntries(rows.map(r => [r.id, r]))
    expect(rowById['root'].hasChildren).toBe(true)
    expect(rowById['parent'].hasChildren).toBe(true)
    expect(rowById['child'].hasChildren).toBe(false)
    expect(rowById['leaf'].hasChildren).toBe(false)
  })
})

// ─── flattenTree — compare mode ───────────────────────────────────────────────

/** Build a MergedTreeNode for use in compare-mode tests. */
function mergedNode(
  id: string,
  parentId: string | null,
  order: number,
  status: MergedTreeNode['status'] = 'unchanged',
  name = id
): MergedTreeNode {
  return {
    id,
    parentId,
    name,
    order,
    properties: {},
    created: '2026-01-01T00:00:00.000Z',
    modified: '2026-01-02T00:00:00.000Z',
    status,
    diffs: [],
  }
}

function makeCompareTree(nodes: MergedTreeNode[]) {
  // buildTree accepts any N extends ManifestNode — MergedTreeNode qualifies.
  const tree = buildTree(nodes as unknown as ManifestNode[])
  if (!tree) throw new Error('buildTree returned null')
  return tree
}

describe('flattenTree (compare mode)', () => {
  it('unchanged node emits kind: normal', () => {
    const nodes = [mergedNode('root', null, 0, 'unchanged')]
    const tree = makeCompareTree(nodes)
    const rows = flattenTree(tree, new Set(['root']), { compareMode: true })
    expect(rows[0].kind).toBe('normal')
  })

  it('added node emits kind: decorated with status added', () => {
    const nodes = [
      mergedNode('root', null, 0, 'unchanged'),
      mergedNode('new', 'root', 0, 'added'),
    ]
    const tree = makeCompareTree(nodes)
    const rows = flattenTree(tree, new Set(['root']), { compareMode: true })
    const decorated = rows.find(r => r.id === 'new')
    expect(decorated!.kind).toBe('decorated')
    if (decorated!.kind === 'decorated') {
      expect(decorated!.status).toBe('added')
      expect(decorated!.badges).toHaveLength(1)
      expect(decorated!.badges[0].label).toBe('Added')
      expect(decorated!.badges[0].severity).toBe('High')
    }
  })

  it('renamed node emits kind: decorated with status renamed', () => {
    const nodes = [
      mergedNode('root', null, 0, 'unchanged'),
      mergedNode('rack', 'root', 0, 'renamed'),
    ]
    const tree = makeCompareTree(nodes)
    const rows = flattenTree(tree, new Set(['root']), { compareMode: true })
    const r = rows.find(r => r.id === 'rack')!
    expect(r.kind).toBe('decorated')
    if (r.kind === 'decorated') expect(r.status).toBe('renamed')
  })

  it('removed node emits kind: ghost with status removed', () => {
    const nodes = [
      mergedNode('root', null, 0, 'unchanged'),
      mergedNode('ghost:gone', 'root', 0, 'removed', 'Gone Node'),
    ]
    const tree = makeCompareTree(nodes)
    const rows = flattenTree(tree, new Set(['root']), { compareMode: true })
    const ghost = rows.find(r => r.id === 'ghost:gone')
    expect(ghost!.kind).toBe('ghost')
    if (ghost!.kind === 'ghost') {
      expect(ghost!.status).toBe('removed')
      expect(ghost!.node.name).toBe('Gone Node')
    }
  })

  it('moved node emits live decorated row AND moved-from ghost row', () => {
    const nodes = [
      mergedNode('root', null, 0, 'unchanged'),
      mergedNode('p1', 'root', 0, 'unchanged'),
      mergedNode('p2', 'root', 1, 'unchanged'),
      mergedNode('rack', 'p2', 0, 'moved'),        // live at new location
      mergedNode('ghost:rack', 'p1', 1, 'moved-from', 'Rack'), // ghost at origin
    ]
    const tree = makeCompareTree(nodes)
    const rows = flattenTree(tree, new Set(['root', 'p1', 'p2']), { compareMode: true })

    const live = rows.find(r => r.id === 'rack')
    const ghost = rows.find(r => r.id === 'ghost:rack')

    expect(live!.kind).toBe('decorated')
    if (live!.kind === 'decorated') expect(live!.status).toBe('moved-to')

    expect(ghost!.kind).toBe('ghost')
    if (ghost!.kind === 'ghost') expect(ghost!.status).toBe('moved-from')
  })

  it('ghost rows are never expanded even if in expandedIds', () => {
    const nodes = [
      mergedNode('root', null, 0, 'unchanged'),
      mergedNode('ghost:gone', 'root', 0, 'removed', 'Gone'),
    ]
    const tree = makeCompareTree(nodes)
    // Include ghost id in expandedIds — should have no effect.
    const rows = flattenTree(tree, new Set(['root', 'ghost:gone']), { compareMode: true })
    const ghost = rows.find(r => r.id === 'ghost:gone')!
    expect(ghost.kind).toBe('ghost')
    if (ghost.kind === 'ghost') {
      expect(ghost.expanded).toBe(false)
      expect(ghost.hasChildren).toBe(false)
    }
  })

  it('ghost ids use ghost: prefix — no collision with live rows', () => {
    // Both live 'rack' and ghost 'ghost:rack' can coexist in the same output.
    const nodes = [
      mergedNode('root', null, 0, 'unchanged'),
      mergedNode('p1', 'root', 0, 'unchanged'),
      mergedNode('p2', 'root', 1, 'unchanged'),
      mergedNode('rack', 'p2', 0, 'moved'),
      mergedNode('ghost:rack', 'p1', 1, 'moved-from', 'Rack'),
    ]
    const tree = makeCompareTree(nodes)
    const rows = flattenTree(tree, new Set(['root', 'p1', 'p2']), { compareMode: true })
    const ids = rows.map(r => r.id)
    expect(ids).toContain('rack')
    expect(ids).toContain('ghost:rack')
    // No duplicates.
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('mixed-status node emits decorated with status mixed', () => {
    const nodes = [
      mergedNode('root', null, 0, 'unchanged'),
      mergedNode('rack', 'root', 0, 'mixed'),
    ]
    const tree = makeCompareTree(nodes)
    const rows = flattenTree(tree, new Set(['root']), { compareMode: true })
    const r = rows.find(r => r.id === 'rack')!
    expect(r.kind).toBe('decorated')
    if (r.kind === 'decorated') {
      expect(r.status).toBe('mixed')
      expect(r.badges[0].severity).toBe('High')
    }
  })

  it('decorated rows have depth, hasChildren, expanded like normal rows', () => {
    const nodes = [
      mergedNode('root', null, 0, 'unchanged'),
      mergedNode('parent', 'root', 0, 'added'),
      mergedNode('child', 'parent', 0, 'added'),
    ]
    const tree = makeCompareTree(nodes)
    const rows = flattenTree(tree, new Set(['root', 'parent']), { compareMode: true })
    const parentRow = rows.find(r => r.id === 'parent')!
    const childRow = rows.find(r => r.id === 'child')!

    expect(parentRow.depth).toBe(1)
    expect(parentRow.hasChildren).toBe(true)
    if (parentRow.kind === 'decorated') expect(parentRow.expanded).toBe(true)

    expect(childRow.depth).toBe(2)
    expect(childRow.hasChildren).toBe(false)
  })

  it('order-changed emits decorated with status order-changed and Low badge', () => {
    const nodes = [
      mergedNode('root', null, 0, 'unchanged'),
      mergedNode('rack', 'root', 0, 'order-changed'),
    ]
    const tree = makeCompareTree(nodes)
    const rows = flattenTree(tree, new Set(['root']), { compareMode: true })
    const r = rows.find(r => r.id === 'rack')!
    expect(r.kind).toBe('decorated')
    if (r.kind === 'decorated') {
      expect(r.status).toBe('order-changed')
      expect(r.badges[0].severity).toBe('Low')
    }
  })
})
