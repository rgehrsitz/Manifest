// Row model consumed by the virtualizer.
//
// All tree rendering goes through VisibleRow[]. The flattener (flattenTree) walks
// the TreeNode tree, applies expansion state, and emits one VisibleRow per DOM row.
//
// PR #1 emits only 'normal' rows. The 'decorated' and 'ghost' variants are defined
// here so PR #2 can light them up without changing the discriminant shape.

import type { ManifestNode } from '../../../shared/types'
import type { MergedTreeNode, MergedStatus } from '../../../shared/merged-tree'
import type { TreeNode } from './tree'

// ─── Row variants ─────────────────────────────────────────────────────────────

export type VisibleRow = NormalRow | DecoratedRow | GhostRow

/** A live, undecorated node in normal browsing mode. */
export interface NormalRow {
  kind: 'normal'
  id: string
  depth: number
  node: ManifestNode
  hasChildren: boolean
  childCount: number
  expanded: boolean
  /** True if this node is first among its siblings (used by context menu Move Up). */
  isFirst: boolean
  /** True if this node is last among its siblings (used by context menu Move Down). */
  isLast: boolean
}

/** A live node in compare mode that has one or more changes relative to the other snapshot. */
export interface DecoratedRow {
  kind: 'decorated'
  id: string
  depth: number
  node: ManifestNode
  hasChildren: boolean
  childCount: number
  expanded: boolean
  isFirst: boolean
  isLast: boolean
  status: RowStatus
  badges: RowBadge[]
}

/**
 * A ghost placeholder in compare mode representing a removed node or the origin
 * position of a moved node. Ghosts are not selectable and not keyboard-navigable.
 *
 * ID is always `ghost:${originalId}` to keep Svelte keyed {#each} sane.
 */
export interface GhostRow {
  kind: 'ghost'
  id: string          // always `ghost:${originalNodeId}`
  depth: number
  node: ManifestNode  // the removed/moved node's data (from snapshot A)
  hasChildren: false
  expanded: false
  status: 'removed' | 'moved-from'
}

// ─── Status and badge types ───────────────────────────────────────────────────

export type RowStatus =
  | 'unchanged'
  | 'added'
  | 'removed'
  | 'moved-to'       // live row at the destination
  | 'moved-from'     // ghost row at the origin
  | 'renamed'
  | 'property-changed'
  | 'order-changed'
  | 'mixed'          // multiple non-Low-severity changes on the same node

export interface RowBadge {
  kind: RowStatus
  label: string
  severity: 'High' | 'Medium' | 'Low'
}

// ─── Flattener ───────────────────────────────────────────────────────────────

export interface FlattenOptions {
  /** When true, nodes are treated as MergedTreeNode and emit decorated/ghost rows. */
  compareMode?: boolean
}

/**
 * Walk the tree in DFS pre-order and emit one VisibleRow per visible node.
 * Collapsed subtrees are skipped entirely, so this scales to 10k+ node trees
 * without paying for invisible rows.
 *
 * In compareMode the tree must be built from MergedTreeNode[]; nodes with
 * status 'removed' or 'moved-from' emit GhostRows (always leaves).
 * All other nodes emit DecoratedRows (or NormalRows for 'unchanged').
 */
export function flattenTree(
  root: TreeNode,
  expandedIds: Set<string>,
  options: FlattenOptions = {}
): VisibleRow[] {
  const result: VisibleRow[] = []

  if (options.compareMode) {
    function walkCompare(treeNode: TreeNode, siblingIndex: number, siblingCount: number): void {
      const merged = treeNode.node as unknown as MergedTreeNode
      const isGhost = merged.status === 'removed' || merged.status === 'moved-from'

      if (isGhost) {
        // Ghost rows are always leaves — never expand.
        result.push({
          kind: 'ghost',
          id: merged.id,                   // already `ghost:${originalId}`
          depth: treeNode.depth,
          node: treeNode.node,
          hasChildren: false,
          expanded: false,
          status: merged.status as 'removed' | 'moved-from',
        })
        return // never recurse into ghost children
      }

      const hasChildren = treeNode.children.length > 0
      const isExpanded = expandedIds.has(merged.id)
      const rowStatus = mergedStatusToRowStatus(merged.status)

      if (merged.status === 'unchanged') {
        result.push({
          kind: 'normal',
          id: merged.id,
          depth: treeNode.depth,
          node: treeNode.node,
          hasChildren,
          childCount: treeNode.children.length,
          expanded: isExpanded,
          isFirst: siblingIndex === 0,
          isLast: siblingIndex === siblingCount - 1,
        })
      } else {
        result.push({
          kind: 'decorated',
          id: merged.id,
          depth: treeNode.depth,
          node: treeNode.node,
          hasChildren,
          childCount: treeNode.children.length,
          expanded: isExpanded,
          isFirst: siblingIndex === 0,
          isLast: siblingIndex === siblingCount - 1,
          status: rowStatus,
          badges: buildBadges(merged),
        })
      }

      if (hasChildren && isExpanded) {
        for (let i = 0; i < treeNode.children.length; i++) {
          walkCompare(treeNode.children[i], i, treeNode.children.length)
        }
      }
    }
    walkCompare(root, 0, 1)
    return result
  }

  // Normal mode — no compare data.
  function walk(treeNode: TreeNode, siblingIndex: number, siblingCount: number): void {
    const hasChildren = treeNode.children.length > 0
    const isExpanded = expandedIds.has(treeNode.node.id)

    result.push({
      kind: 'normal',
      id: treeNode.node.id,
      depth: treeNode.depth,
      node: treeNode.node,
      hasChildren,
      childCount: treeNode.children.length,
      expanded: isExpanded,
      isFirst: siblingIndex === 0,
      isLast: siblingIndex === siblingCount - 1,
    })

    if (hasChildren && isExpanded) {
      for (let i = 0; i < treeNode.children.length; i++) {
        walk(treeNode.children[i], i, treeNode.children.length)
      }
    }
  }

  walk(root, 0, 1)
  return result
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function mergedStatusToRowStatus(status: MergedStatus): RowStatus {
  switch (status) {
    case 'added':            return 'added'
    case 'moved':            return 'moved-to'
    case 'renamed':          return 'renamed'
    case 'property-changed': return 'property-changed'
    case 'order-changed':    return 'order-changed'
    case 'mixed':            return 'mixed'
    default:                 return 'unchanged'
  }
}

const BADGE_LABELS: Partial<Record<RowStatus, string>> = {
  added:            'Added',
  'moved-to':       'Moved',
  renamed:          'Renamed',
  'property-changed': 'Changed',
  'order-changed':  'Reordered',
  mixed:            'Modified',
}

const BADGE_SEVERITY: Partial<Record<RowStatus, 'High' | 'Medium' | 'Low'>> = {
  added:              'High',
  'moved-to':         'High',
  renamed:            'Medium',
  'property-changed': 'Medium',
  'order-changed':    'Low',
  mixed:              'High',
}

function buildBadges(merged: MergedTreeNode): RowBadge[] {
  const status = mergedStatusToRowStatus(merged.status)
  const label = BADGE_LABELS[status]
  const severity = BADGE_SEVERITY[status] ?? 'Medium'
  if (!label) return []
  return [{ kind: status, label, severity }]
}
