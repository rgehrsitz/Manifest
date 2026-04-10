// Row model consumed by the virtualizer.
//
// All tree rendering goes through VisibleRow[]. The flattener (flattenTree) walks
// the TreeNode tree, applies expansion state, and emits one VisibleRow per DOM row.
//
// PR #1 emits only 'normal' rows. The 'decorated' and 'ghost' variants are defined
// here so PR #2 can light them up without changing the discriminant shape.

import type { ManifestNode } from '../../../shared/types'
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
  /**
   * When true, the flattener emits 'decorated' and 'ghost' rows using the
   * merged-tree data attached to each node.
   *
   * @default false
   * @throws {Error} NOT_IMPLEMENTED until PR #2
   */
  compareMode?: boolean
}

/**
 * Walk the tree in DFS pre-order and emit one VisibleRow per visible node.
 * Collapsed subtrees are skipped entirely, so this scales to 10k+ node trees
 * without paying for invisible rows.
 *
 * The returned array is the exact input to the virtualizer.
 */
export function flattenTree(
  root: TreeNode,
  expandedIds: Set<string>,
  options: FlattenOptions = {}
): VisibleRow[] {
  if (options.compareMode) {
    throw new Error(
      'NOT_IMPLEMENTED: compareMode will be enabled in PR #2 (inline compare mode)'
    )
  }

  const result: VisibleRow[] = []

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

  // Root is always alone at the top level.
  walk(root, 0, 1)

  return result
}
