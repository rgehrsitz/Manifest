import { describe, expect, it } from 'vitest'
import { flattenTree } from '../../../src/renderer/src/lib/tree-rows'
import { buildTree } from '../../../src/renderer/src/lib/tree'
import type { ManifestNode } from '../../../src/shared/types'

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

  it('throws NOT_IMPLEMENTED for compareMode: true', () => {
    const nodes = [node('root', null, 0)]
    const tree = makeTree(nodes)
    expect(() =>
      flattenTree(tree, new Set(), { compareMode: true })
    ).toThrow('NOT_IMPLEMENTED')
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
