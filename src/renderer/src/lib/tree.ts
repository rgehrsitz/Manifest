// Tree utility functions for working with the flat ManifestNode array.
// All functions are pure — they take nodes and return derived data.
// The main process holds the authoritative state; these are read helpers for the renderer.

import type { ManifestNode } from '../../../shared/types'

// A node decorated with its children, depth, and ancestry path — ready for rendering.
// Generic over N so that ManifestNode subtypes (e.g. MergedTreeNode) can reuse
// the same tree builder without a second DFS implementation.
export interface TreeNode<N extends ManifestNode = ManifestNode> {
  node: N
  children: TreeNode<N>[]
  depth: number
  path: string[]  // ancestor names, root-first, not including self
}

// Build a full tree from the flat node array.
// Returns the single root TreeNode (parentId === null).
export function buildTree<N extends ManifestNode = ManifestNode>(nodes: N[]): TreeNode<N> | null {
  if (nodes.length === 0) return null

  const root = nodes.find(n => n.parentId === null)
  if (!root) return null

  const byParent = new Map<string | null, N[]>()
  for (const node of nodes) {
    const key = node.parentId
    if (!byParent.has(key)) byParent.set(key, [])
    byParent.get(key)!.push(node)
  }

  // Sort children by order at each level.
  for (const children of byParent.values()) {
    children.sort((a, b) => a.order - b.order)
  }

  function buildNode(node: N, depth: number, path: string[]): TreeNode<N> {
    const children = (byParent.get(node.id) ?? []).map(child =>
      buildNode(child, depth + 1, [...path, node.name])
    )
    return { node, children, depth, path }
  }

  return buildNode(root, 0, [])
}

// Return the IDs of all ancestors of nodeId, root-first.
export function getAncestorIds(nodeId: string, nodes: ManifestNode[]): string[] {
  const parentMap = new Map(nodes.map(n => [n.id, n.parentId]))
  const ancestors: string[] = []
  let current = parentMap.get(nodeId) ?? null
  while (current !== null) {
    ancestors.unshift(current)
    current = parentMap.get(current) ?? null
  }
  return ancestors
}

// Return the IDs of all descendants of nodeId (not including nodeId itself).
export function getDescendantIds(nodeId: string, nodes: ManifestNode[]): string[] {
  const result: string[] = []
  const queue = [nodeId]
  while (queue.length > 0) {
    const id = queue.shift()!
    const children = nodes.filter(n => n.parentId === id)
    for (const child of children) {
      result.push(child.id)
      queue.push(child.id)
    }
  }
  return result
}

// Return siblings of nodeId (same parent, sorted by order).
export function getSiblings(nodeId: string, nodes: ManifestNode[]): ManifestNode[] {
  const node = nodes.find(n => n.id === nodeId)
  if (!node) return []
  return nodes
    .filter(n => n.parentId === node.parentId && n.id !== nodeId)
    .sort((a, b) => a.order - b.order)
}

// Return the order index of nodeId among its siblings.
export function getSiblingIndex(nodeId: string, nodes: ManifestNode[]): number {
  const node = nodes.find(n => n.id === nodeId)
  if (!node) return -1
  const allSiblings = nodes
    .filter(n => n.parentId === node.parentId)
    .sort((a, b) => a.order - b.order)
  return allSiblings.findIndex(n => n.id === nodeId)
}
