import { describe, expect, it } from 'vitest'
import { buildTree, getAncestorIds, getDescendantIds, getSiblings, getSiblingIndex } from '../../../src/renderer/src/lib/tree'
import type { ManifestNode } from '../../../src/shared/types'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function node(id: string, parentId: string | null, order = 0, name = id): ManifestNode {
  return { id, parentId, name, order, properties: {}, created: '', modified: '' }
}

function baseNodes(): ManifestNode[] {
  return [
    node('root', null, 0, 'Root'),
    node('a', 'root', 0, 'A'),
    node('b', 'root', 1, 'B'),
    node('a1', 'a', 0, 'A1'),
  ]
}

// ─── buildTree (non-generic, regression) ─────────────────────────────────────

describe('buildTree', () => {
  it('returns null for empty input', () => {
    expect(buildTree([])).toBeNull()
  })

  it('returns null when there is no root node (no parentId === null)', () => {
    expect(buildTree([node('orphan', 'missing', 0)])).toBeNull()
  })

  it('builds a single-node tree', () => {
    const tree = buildTree([node('root', null)])
    expect(tree).not.toBeNull()
    expect(tree!.node.id).toBe('root')
    expect(tree!.children).toHaveLength(0)
    expect(tree!.depth).toBe(0)
  })

  it('assigns depths correctly', () => {
    const tree = buildTree(baseNodes())!
    const a = tree.children[0]
    const a1 = a.children[0]
    expect(tree.depth).toBe(0)
    expect(a.depth).toBe(1)
    expect(a1.depth).toBe(2)
  })

  it('sorts children by order field', () => {
    const nodes = [
      node('root', null, 0),
      node('c', 'root', 2),
      node('a', 'root', 0),
      node('b', 'root', 1),
    ]
    const tree = buildTree(nodes)!
    expect(tree.children.map(c => c.node.id)).toEqual(['a', 'b', 'c'])
  })

  it('builds path correctly', () => {
    const tree = buildTree(baseNodes())!
    const a1 = tree.children[0].children[0]
    expect(a1.path).toEqual(['Root', 'A'])
    expect(a1.node.id).toBe('a1')
  })
})

// ─── buildTree generic variant ────────────────────────────────────────────────

describe('buildTree<N extends ManifestNode> (generic)', () => {
  interface ExtendedNode extends ManifestNode {
    tag: string
  }

  function extNode(id: string, parentId: string | null, order = 0, tag = 'default'): ExtendedNode {
    return { id, parentId, name: id, order, properties: {}, created: '', modified: '', tag }
  }

  it('accepts a subtype of ManifestNode and preserves extra fields', () => {
    const nodes: ExtendedNode[] = [
      extNode('root', null, 0, 'root-tag'),
      extNode('child', 'root', 0, 'child-tag'),
    ]
    const tree = buildTree<ExtendedNode>(nodes)
    expect(tree).not.toBeNull()
    expect(tree!.node.tag).toBe('root-tag')
    expect(tree!.children[0].node.tag).toBe('child-tag')
  })

  it('infers the generic bound when called with plain ManifestNode[]', () => {
    const nodes = baseNodes()
    const tree = buildTree(nodes)
    // TypeScript should infer ManifestNode — compiles and runs correctly.
    expect(tree).not.toBeNull()
    expect(tree!.node.id).toBe('root')
  })
})

// ─── getAncestorIds ───────────────────────────────────────────────────────────

describe('getAncestorIds', () => {
  it('returns empty array for root', () => {
    expect(getAncestorIds('root', baseNodes())).toEqual([])
  })

  it('returns single parent for direct child', () => {
    expect(getAncestorIds('a', baseNodes())).toEqual(['root'])
  })

  it('returns full chain root-first for grandchild', () => {
    expect(getAncestorIds('a1', baseNodes())).toEqual(['root', 'a'])
  })

  it('returns empty for unknown id', () => {
    expect(getAncestorIds('unknown', baseNodes())).toEqual([])
  })
})

// ─── getDescendantIds ─────────────────────────────────────────────────────────

describe('getDescendantIds', () => {
  it('returns empty for leaf node', () => {
    expect(getDescendantIds('a1', baseNodes())).toEqual([])
  })

  it('returns direct children for single-level parent', () => {
    expect(getDescendantIds('a', baseNodes())).toEqual(['a1'])
  })

  it('returns all descendants for root', () => {
    const ids = getDescendantIds('root', baseNodes())
    expect(ids.sort()).toEqual(['a', 'a1', 'b'].sort())
  })
})

// ─── getSiblings ──────────────────────────────────────────────────────────────

describe('getSiblings', () => {
  it('returns other children of the same parent, sorted by order', () => {
    const siblings = getSiblings('a', baseNodes())
    expect(siblings.map(s => s.id)).toEqual(['b'])
  })

  it('returns empty for unknown node', () => {
    expect(getSiblings('unknown', baseNodes())).toEqual([])
  })

  it('returns empty for the only child', () => {
    expect(getSiblings('a1', baseNodes())).toEqual([])
  })
})

// ─── getSiblingIndex ──────────────────────────────────────────────────────────

describe('getSiblingIndex', () => {
  it('returns 0 for first sibling', () => {
    expect(getSiblingIndex('a', baseNodes())).toBe(0)
  })

  it('returns 1 for second sibling', () => {
    expect(getSiblingIndex('b', baseNodes())).toBe(1)
  })

  it('returns -1 for unknown id', () => {
    expect(getSiblingIndex('unknown', baseNodes())).toBe(-1)
  })
})
