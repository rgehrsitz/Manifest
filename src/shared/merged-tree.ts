// Merged-tree builder for snapshot compare mode.
//
// Takes two Project snapshots (A = "from", B = "to") and their DiffEntry[]
// and produces a single flat MergedTreeNode[] that represents BOTH snapshots
// simultaneously. Live nodes come from B; ghost nodes mark removed/moved-from
// positions from A. The renderer feeds this into buildTree() then flattenTree()
// to produce decorated and ghost VisibleRows.
//
// This is a pure function with no I/O. It runs in the main process (where the
// parsed snapshots are already available) and the result is serialised across
// the IPC boundary as a single payload.

import type { ManifestNode, DiffEntry, Project } from './types'

// ─── Types ────────────────────────────────────────────────────────────────────

export type MergedStatus =
  | 'unchanged'
  | 'added'
  | 'removed'        // ghost: only in A
  | 'moved'          // live node, different parent in B
  | 'moved-from'     // ghost: origin position of a moved node
  | 'renamed'
  | 'property-changed'
  | 'order-changed'
  | 'mixed'          // two or more non-Low-severity changes

/**
 * A ManifestNode extended with compare-mode metadata.
 * Structurally compatible with ManifestNode so buildTree<MergedTreeNode>()
 * reuses the same DFS without a second implementation.
 *
 * Ghost nodes (status 'removed' | 'moved-from') have id = `ghost:${originalId}`.
 */
export interface MergedTreeNode extends ManifestNode {
  status: MergedStatus
  /** Set when the node has values that changed from A to B. */
  previous?: {
    name?: string
    parentId?: string | null
    properties?: Record<string, string | number | boolean | null>
  }
  /** All DiffEntry records touching this node. Removed ghosts carry their removal diff. */
  diffs: DiffEntry[]
}

export interface MergedTree {
  /** Flat array — feed to buildTree<MergedTreeNode>() to get the hierarchy. */
  nodes: MergedTreeNode[]
  fromSnapshot: string
  toSnapshot: string
  summary: {
    added: number
    removed: number
    moved: number
    renamed: number
    propertyChanged: number
    orderChanged: number
  }
}

// ─── Builder ─────────────────────────────────────────────────────────────────

export function buildMergedTree(
  from: Project,
  to: Project,
  diffs: DiffEntry[],
  fromSnapshot: string,
  toSnapshot: string
): MergedTree {
  const nodesA = new Map(from.nodes.map(n => [n.id, n]))
  const nodesB = new Map(to.nodes.map(n => [n.id, n]))

  // Group diffs by node id for O(1) lookup.
  const diffsByNodeId = new Map<string, DiffEntry[]>()
  for (const d of diffs) {
    const arr = diffsByNodeId.get(d.nodeId) ?? []
    arr.push(d)
    diffsByNodeId.set(d.nodeId, arr)
  }

  const merged: MergedTreeNode[] = []
  const summary = { added: 0, removed: 0, moved: 0, renamed: 0, propertyChanged: 0, orderChanged: 0 }

  // ── Step 1: Emit live nodes (everything in B) ─────────────────────────────

  for (const nodeB of to.nodes) {
    const nodeDiffs = diffsByNodeId.get(nodeB.id) ?? []
    const nodeA = nodesA.get(nodeB.id)

    const status = deriveLiveStatus(nodeDiffs)
    const previous = nodeA ? buildPrevious(nodeA, nodeB, nodeDiffs) : undefined

    merged.push({ ...nodeB, status, previous, diffs: nodeDiffs })

    // Update summary counts for this live node.
    for (const d of nodeDiffs) {
      switch (d.changeType) {
        case 'added':            summary.added++;            break
        case 'moved':            summary.moved++;            break
        case 'renamed':          summary.renamed++;          break
        case 'property-changed': summary.propertyChanged++;  break
        case 'order-changed':    summary.orderChanged++;     break
      }
    }

    // ── Step 1b: If this node moved, also emit a ghost at its origin ────────
    if (nodeA && nodeDiffs.some(d => d.changeType === 'moved')) {
      merged.push(makeGhost(nodeA, 'moved-from', nodesB))
    }
  }

  // ── Step 2: Emit ghosts for nodes removed from B (only in A) ─────────────

  for (const nodeA of from.nodes) {
    if (nodesB.has(nodeA.id)) continue // still alive — handled in step 1
    const nodeDiffs = diffsByNodeId.get(nodeA.id) ?? []
    merged.push(makeGhost(nodeA, 'removed', nodesB, nodeDiffs))
    summary.removed++
  }

  return { nodes: merged, fromSnapshot, toSnapshot, summary }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function deriveLiveStatus(diffs: DiffEntry[]): MergedStatus {
  if (diffs.length === 0) return 'unchanged'

  const types = new Set(diffs.map(d => d.changeType))

  if (types.has('added'))   return 'added'

  // High-severity non-order changes.
  const highCount = diffs.filter(d => d.severity === 'High').length
  const medCount  = diffs.filter(d => d.severity === 'Medium').length

  // Mixed: more than one distinct meaningful change.
  if (highCount + medCount > 1) return 'mixed'

  if (types.has('moved'))            return 'moved'
  if (types.has('renamed'))          return 'renamed'
  if (types.has('property-changed')) return 'property-changed'
  if (types.has('order-changed'))    return 'order-changed'

  return 'unchanged'
}

function buildPrevious(
  nodeA: ManifestNode,
  nodeB: ManifestNode,
  diffs: DiffEntry[]
): MergedTreeNode['previous'] | undefined {
  const types = new Set(diffs.map(d => d.changeType))
  const prev: NonNullable<MergedTreeNode['previous']> = {}
  let hasAny = false

  if (types.has('renamed')) {
    prev.name = nodeA.name
    hasAny = true
  }
  if (types.has('moved')) {
    prev.parentId = nodeA.parentId
    hasAny = true
  }
  if (types.has('property-changed')) {
    prev.properties = nodeA.properties as Record<string, string | number | boolean | null>
    hasAny = true
  }

  return hasAny ? prev : undefined
}

/**
 * Create a ghost MergedTreeNode for a node that is absent from B (removed)
 * or represents the origin of a move.
 *
 * Ghost id = `ghost:${originalId}` to avoid colliding with the live row of a
 * moved node (which keeps the real id). This is the key that keeps Svelte's
 * keyed {#each} sane.
 *
 * Ghost parentId is resolved against B: if the original parent still exists in
 * B as a live node, we point to it. If it was also removed, we point to its
 * ghost (ghost:parentId). This lets buildTree() correctly nest ghosts.
 */
function makeGhost(
  nodeA: ManifestNode,
  status: 'removed' | 'moved-from',
  nodesB: Map<string, ManifestNode>,
  diffs: DiffEntry[] = []
): MergedTreeNode {
  const ghostParentId = resolveGhostParent(nodeA.parentId, nodesB)

  return {
    ...nodeA,
    id: `ghost:${nodeA.id}`,
    parentId: ghostParentId,
    status,
    diffs,
  }
}

function resolveGhostParent(
  originalParentId: string | null,
  nodesB: Map<string, ManifestNode>
): string | null {
  if (originalParentId === null) return null
  // If the parent still exists in B as a live node, point to it directly.
  if (nodesB.has(originalParentId)) return originalParentId
  // Parent was also removed → point to its ghost.
  return `ghost:${originalParentId}`
}
