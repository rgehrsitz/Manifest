// DensityLayer — pure, deterministic computation of where the lens folds.
//
// Given a flat row stream (VisibleRow[]) and a mode-specific context, returns
// a non-overlapping, contiguous LensSection[] that partitions the rows into
// regions of uniform density (full / summarized / hidden).
//
// The renderer iterates these sections to decide what to draw at each index —
// individual rows for 'full', a single FoldMarker for 'summarized'.
//
// All functions in this module are pure: same inputs produce the same outputs,
// no I/O, no DOM. This is what gives the morphing its determinism and what
// makes the foldId stable across renders (driving Svelte keyed {#each}).

import type { VisibleRow } from './tree-rows'
import type { SubtreeSummary } from '../../../shared/merged-tree'

// ─── Types ────────────────────────────────────────────────────────────────────

export type LensDensity = 'full' | 'summarized' | 'hidden'

export type LensSectionReason =
  | 'compare-unchanged'
  | 'compare-changed'
  | 'search-non-match'
  | 'edit-distant'
  | 'default'

export interface LensSection {
  /** Inclusive start index into the source VisibleRow[]. */
  startIndex: number
  /** Inclusive end index into the source VisibleRow[]. */
  endIndex: number
  density: LensDensity
  reason: LensSectionReason
  /**
   * Stable identifier for this section across re-renders. Set on
   * density='summarized' sections (becomes the FoldMarker key for animation
   * interpolation). Undefined on 'full'/'hidden' sections.
   */
  foldId?: string
  /**
   * Diff-engine-derived summary of what's inside the section. Set on
   * compare-mode summarized sections (zeros for compare-unchanged folds —
   * the marker still says "47 unchanged shelves folded"). Null when the
   * section is not a fold or we're not in compare mode.
   */
  changeBreakdown?: ChangeBreakdown | null
}

export interface ChangeBreakdown {
  added: number
  removed: number
  renamed: number
  moved: number
  propertyChanged: number
}

export interface CompareSectionContext {
  snapshotFrom: string
  snapshotTo: string
  /**
   * Optional: per-node subtree change summaries (from
   * computeSubtreeSummaries in shared/merged-tree). When provided, fold
   * markers roll up changes from collapsed subtrees of fold rows — i.e., the
   * marker shows "47 unchanged · 3 added, 2 moved" instead of just the
   * count. Without it, fold markers only show the count.
   */
  subtreeSummaries?: Map<string, SubtreeSummary>
}

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Minimum run length that becomes a fold marker. Below this, the run renders
 * as individual rows — folding 1 row into a marker doesn't save space and
 * just confuses the user.
 */
export const DEFAULT_MIN_FOLD_SIZE = 2

const ZERO_BREAKDOWN: ChangeBreakdown = {
  added: 0,
  removed: 0,
  renamed: 0,
  moved: 0,
  propertyChanged: 0,
}

// ─── Browse / edit (no morphing) ──────────────────────────────────────────────

/**
 * One full section spanning the entire row stream. Used for browse and edit
 * modes where the layout stays rigid (per design doc premise 2).
 */
export function computeBrowseSections(rows: VisibleRow[]): LensSection[] {
  if (rows.length === 0) return []
  return [{
    startIndex: 0,
    endIndex: rows.length - 1,
    density: 'full',
    reason: 'default',
  }]
}

// ─── Compare mode ─────────────────────────────────────────────────────────────

export interface CompareSectionOptions {
  /** Runs shorter than this stay 'full' (default 2). */
  minFoldSize?: number
  /**
   * When true (default), fold runs split where depth *decreases* — i.e.,
   * returning up the tree breaks a fold, so a fold never spans across
   * sibling-of-different-parent boundaries. Going DEEPER into the same
   * subtree (e.g. an unchanged parent followed by its unchanged child) does
   * NOT split — those rows stay one fold. Closes the design doc's depth-jump
   * concern from Step 5.
   */
  splitOnDepthDecrease?: boolean
}

/**
 * Compute LensSections for compare mode. Per the design doc:
 *   - Live nodes with status 'unchanged' (VisibleRow.kind === 'normal') →
 *     fold candidates; contiguous runs collapse into one summarized section.
 *   - Live nodes with any other status (kind === 'decorated') → density='full'.
 *   - Ghost nodes (kind === 'ghost') → ALWAYS density='full'. Ghosts represent
 *     removed/moved-from changes — they ARE what the user came to see; folding
 *     them defeats the purpose.
 *   - Runs shorter than minFoldSize emit as 'full' instead of 'summarized'.
 *   - Adjacent 'full' sections are merged so consumers iterate fewer chunks.
 */
export function computeCompareSections(
  rows: VisibleRow[],
  context: CompareSectionContext,
  options: CompareSectionOptions = {}
): LensSection[] {
  if (rows.length === 0) return []

  const minFold = options.minFoldSize ?? DEFAULT_MIN_FOLD_SIZE
  const splitOnDepthDec = options.splitOnDepthDecrease ?? true
  const sections: LensSection[] = []
  let i = 0

  while (i < rows.length) {
    if (isCompareUnchangedFoldCandidate(rows[i])) {
      const startIndex = i
      i++
      while (
        i < rows.length &&
        isCompareUnchangedFoldCandidate(rows[i]) &&
        !(splitOnDepthDec && rows[i].depth < rows[i - 1].depth)
      ) {
        i++
      }
      const endIndex = i - 1
      const runLength = endIndex - startIndex + 1

      if (runLength >= minFold) {
        const anchorBefore = startIndex > 0 ? rows[startIndex - 1].id : null
        const anchorAfter = endIndex < rows.length - 1 ? rows[endIndex + 1].id : null
        pushSection(sections, {
          startIndex,
          endIndex,
          density: 'summarized',
          reason: 'compare-unchanged',
          foldId: makeCompareFoldId(context, anchorBefore, anchorAfter),
          changeBreakdown: rollupCollapsedSubtreeChanges(rows, startIndex, endIndex, context.subtreeSummaries),
        })
      } else {
        pushSection(sections, {
          startIndex,
          endIndex,
          density: 'full',
          reason: 'compare-changed',
        })
      }
    } else {
      const startIndex = i
      while (i < rows.length && !isCompareUnchangedFoldCandidate(rows[i])) i++
      const endIndex = i - 1
      pushSection(sections, {
        startIndex,
        endIndex,
        density: 'full',
        reason: 'compare-changed',
      })
    }
  }

  return sections
}

/**
 * Sum subtree-summary counts for fold rows whose subtrees are NOT in the
 * visible row stream (i.e., the row is collapsed). Expanded rows have their
 * descendants visible elsewhere, so we don't double-count.
 *
 * `subtreeSummaries` is keyed by node id (NormalRow.id === NormalRow.node.id).
 * `orderChanged` is omitted from `ChangeBreakdown` per the design doc's chip
 * palette — order changes are typically low-severity noise in summaries.
 */
function rollupCollapsedSubtreeChanges(
  rows: VisibleRow[],
  startIndex: number,
  endIndex: number,
  subtreeSummaries: Map<string, SubtreeSummary> | undefined
): ChangeBreakdown {
  const breakdown: ChangeBreakdown = { ...ZERO_BREAKDOWN }
  if (!subtreeSummaries) return breakdown

  for (let j = startIndex; j <= endIndex; j++) {
    const r = rows[j]
    if (r.kind !== 'normal') continue
    if (r.expanded) continue   // descendants visible in the stream — skip
    const s = subtreeSummaries.get(r.id)
    if (!s) continue
    breakdown.added           += s.added
    breakdown.removed         += s.removed
    breakdown.moved           += s.moved
    breakdown.renamed         += s.renamed
    breakdown.propertyChanged += s.propertyChanged
  }

  return breakdown
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isCompareUnchangedFoldCandidate(row: VisibleRow): boolean {
  return row.kind === 'normal'
}

/**
 * Stable, deterministic id for a fold. Encodes the snapshot pair plus the
 * boundary anchors (the row IDs immediately before and after the run).
 *
 * Why anchors-on-both-sides instead of the doc's `parent + runIndex`: anchors
 * directly encode the run's identity, so when a fold splits (an interior
 * change is revealed), the two new runs naturally get different foldIds —
 * the old marker animates out, two new markers animate in. No bookkeeping.
 */
function makeCompareFoldId(
  ctx: CompareSectionContext,
  anchorBeforeId: string | null,
  anchorAfterId: string | null
): string {
  const before = anchorBeforeId ?? '^'
  const after = anchorAfterId ?? '$'
  return `cmp_${ctx.snapshotFrom}_${ctx.snapshotTo}_${before}_${after}`
}

/**
 * Append a section, merging into the previous one if both are 'full' and
 * 'compare-changed' — keeps the section list compact for downstream iteration.
 */
function pushSection(sections: LensSection[], section: LensSection): void {
  const prev = sections[sections.length - 1]
  if (
    prev &&
    prev.density === 'full' &&
    section.density === 'full' &&
    prev.reason === section.reason &&
    prev.endIndex + 1 === section.startIndex
  ) {
    prev.endIndex = section.endIndex
    return
  }
  sections.push(section)
}
