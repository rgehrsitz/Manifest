import { describe, expect, it } from 'vitest'
import {
  computeBrowseSections,
  computeCompareSections,
  DEFAULT_MIN_FOLD_SIZE,
  type LensSection,
} from '../../../src/renderer/src/lib/density-layer'
import type { VisibleRow } from '../../../src/renderer/src/lib/tree-rows'
import type { ManifestNode } from '../../../src/shared/types'
import type { SubtreeSummary } from '../../../src/shared/merged-tree'

// ─── Fixtures ────────────────────────────────────────────────────────────────

function manifestNode(id: string): ManifestNode {
  return {
    id,
    parentId: null,
    name: id,
    order: 0,
    properties: {},
    created: '2026-01-01T00:00:00.000Z',
    modified: '2026-01-01T00:00:00.000Z',
  }
}

function normal(id: string, depth = 0, opts: { expanded?: boolean; hasChildren?: boolean } = {}): VisibleRow {
  return {
    kind: 'normal',
    id,
    depth,
    node: manifestNode(id),
    hasChildren: opts.hasChildren ?? false,
    childCount: 0,
    expanded: opts.expanded ?? false,
    isFirst: false,
    isLast: false,
  }
}

function decorated(id: string, depth = 0): VisibleRow {
  return {
    kind: 'decorated',
    id,
    depth,
    node: manifestNode(id),
    hasChildren: false,
    childCount: 0,
    expanded: false,
    isFirst: false,
    isLast: false,
    status: 'property-changed',
    badges: [{ kind: 'property-changed', label: 'Changed', severity: 'Medium' }],
  }
}

function ghost(originalId: string, depth = 0): VisibleRow {
  return {
    kind: 'ghost',
    id: `ghost:${originalId}`,
    depth,
    node: manifestNode(originalId),
    hasChildren: false,
    expanded: false,
    status: 'removed',
  }
}

const CTX = { snapshotFrom: 'snap-A', snapshotTo: 'snap-B' }

// Compact assertion helper — ignores foldId / breakdown details.
function shape(sections: LensSection[]): Array<[number, number, string, string]> {
  return sections.map(s => [s.startIndex, s.endIndex, s.density, s.reason])
}

// ─── computeBrowseSections ────────────────────────────────────────────────────

describe('computeBrowseSections', () => {
  it('returns empty for empty rows', () => {
    expect(computeBrowseSections([])).toEqual([])
  })

  it('returns one full section spanning all rows', () => {
    const rows = [normal('a'), normal('b'), normal('c')]
    expect(shape(computeBrowseSections(rows))).toEqual([[0, 2, 'full', 'default']])
  })

  it('does not look at row kind — even decorated/ghost stay full in browse mode', () => {
    const rows = [normal('a'), decorated('b'), ghost('c')]
    expect(shape(computeBrowseSections(rows))).toEqual([[0, 2, 'full', 'default']])
  })
})

// ─── computeCompareSections ───────────────────────────────────────────────────

describe('computeCompareSections — basic partitioning', () => {
  it('returns empty for empty rows', () => {
    expect(computeCompareSections([], CTX)).toEqual([])
  })

  it('all unchanged → one summarized section', () => {
    const rows = Array.from({ length: 5 }, (_, i) => normal(`n${i}`))
    expect(shape(computeCompareSections(rows, CTX))).toEqual([
      [0, 4, 'summarized', 'compare-unchanged'],
    ])
  })

  it('all decorated → one full section', () => {
    const rows = [decorated('d1'), decorated('d2'), decorated('d3')]
    expect(shape(computeCompareSections(rows, CTX))).toEqual([
      [0, 2, 'full', 'compare-changed'],
    ])
  })

  it('changed bracketing unchanged → full / summarized / full', () => {
    const rows = [
      decorated('d1'),
      normal('n1'), normal('n2'), normal('n3'),
      decorated('d2'),
    ]
    expect(shape(computeCompareSections(rows, CTX))).toEqual([
      [0, 0, 'full', 'compare-changed'],
      [1, 3, 'summarized', 'compare-unchanged'],
      [4, 4, 'full', 'compare-changed'],
    ])
  })

  it('ghost is always full — it splits an unchanged run into two', () => {
    const rows = [
      normal('n1'), normal('n2'),
      ghost('g1'),
      normal('n3'), normal('n4'),
    ]
    expect(shape(computeCompareSections(rows, CTX))).toEqual([
      [0, 1, 'summarized', 'compare-unchanged'],
      [2, 2, 'full', 'compare-changed'],
      [3, 4, 'summarized', 'compare-unchanged'],
    ])
  })
})

// ─── Min fold size threshold ──────────────────────────────────────────────────

describe('computeCompareSections — minFoldSize threshold', () => {
  it('default minFoldSize is 2 — single unchanged row stays full', () => {
    expect(DEFAULT_MIN_FOLD_SIZE).toBe(2)
    const rows = [decorated('d1'), normal('n1'), decorated('d2')]
    expect(shape(computeCompareSections(rows, CTX))).toEqual([
      [0, 2, 'full', 'compare-changed'],
    ])
  })

  it('two unchanged rows fold (meets default threshold)', () => {
    const rows = [decorated('d1'), normal('n1'), normal('n2'), decorated('d2')]
    expect(shape(computeCompareSections(rows, CTX))).toEqual([
      [0, 0, 'full', 'compare-changed'],
      [1, 2, 'summarized', 'compare-unchanged'],
      [3, 3, 'full', 'compare-changed'],
    ])
  })

  it('respects custom minFoldSize', () => {
    const rows = [decorated('d1'), normal('n1'), normal('n2'), decorated('d2')]
    const sections = computeCompareSections(rows, CTX, { minFoldSize: 5 })
    // Run of 2 < 5 → stays full and merges with adjacent full sections.
    expect(shape(sections)).toEqual([[0, 3, 'full', 'compare-changed']])
  })

  it('minFoldSize=1 folds even single rows', () => {
    const rows = [decorated('d1'), normal('n1'), decorated('d2')]
    expect(shape(computeCompareSections(rows, CTX, { minFoldSize: 1 }))).toEqual([
      [0, 0, 'full', 'compare-changed'],
      [1, 1, 'summarized', 'compare-unchanged'],
      [2, 2, 'full', 'compare-changed'],
    ])
  })
})

// ─── Adjacent-full merging ────────────────────────────────────────────────────

describe('computeCompareSections — section merging', () => {
  it('merges adjacent full sections', () => {
    const rows = [decorated('d1'), ghost('g1'), decorated('d2')]
    expect(shape(computeCompareSections(rows, CTX))).toEqual([
      [0, 2, 'full', 'compare-changed'],
    ])
  })

  it('a sub-threshold run between two changed runs collapses to one full section', () => {
    const rows = [decorated('d1'), normal('n1'), decorated('d2'), decorated('d3')]
    // Single normal between decorated → full (below default threshold of 2),
    // then merges with surrounding full sections.
    expect(shape(computeCompareSections(rows, CTX))).toEqual([
      [0, 3, 'full', 'compare-changed'],
    ])
  })
})

// ─── Fold breakdowns ──────────────────────────────────────────────────────────

describe('computeCompareSections — change breakdown on summarized sections', () => {
  it('compare-unchanged folds carry a zeroed breakdown (the marker still shows count)', () => {
    const rows = [normal('n1'), normal('n2'), normal('n3')]
    const [section] = computeCompareSections(rows, CTX)
    expect(section.density).toBe('summarized')
    expect(section.changeBreakdown).toEqual({
      added: 0, removed: 0, renamed: 0, moved: 0, propertyChanged: 0,
    })
  })

  it('full sections do not carry a breakdown', () => {
    const rows = [decorated('d1'), decorated('d2')]
    const [section] = computeCompareSections(rows, CTX)
    expect(section.density).toBe('full')
    expect(section.changeBreakdown).toBeUndefined()
  })
})

// ─── foldId stability ─────────────────────────────────────────────────────────

describe('computeCompareSections — foldId stability', () => {
  it('same inputs produce the same foldId (determinism)', () => {
    const rows = [decorated('d1'), normal('n1'), normal('n2'), decorated('d2')]
    const a = computeCompareSections(rows, CTX)
    const b = computeCompareSections(rows, CTX)
    expect(a[1].foldId).toBeDefined()
    expect(a[1].foldId).toBe(b[1].foldId)
  })

  it('different snapshot pair → different foldId', () => {
    const rows = [decorated('d1'), normal('n1'), normal('n2'), decorated('d2')]
    const a = computeCompareSections(rows, { snapshotFrom: 'A', snapshotTo: 'B' })
    const b = computeCompareSections(rows, { snapshotFrom: 'A', snapshotTo: 'C' })
    expect(a[1].foldId).not.toBe(b[1].foldId)
  })

  it('different anchors (split scenario) → different foldId', () => {
    // Original: [d1, n1, n2, n3, n4, d2] — one fold anchored by d1/d2.
    const before = [decorated('d1'), normal('n1'), normal('n2'), normal('n3'), normal('n4'), decorated('d2')]
    // After: a change is revealed in the middle → fold splits into two,
    //   anchored by d1/dMid and dMid/d2 respectively.
    const after = [decorated('d1'), normal('n1'), normal('n2'), decorated('dMid'), normal('n3'), normal('n4'), decorated('d2')]

    const beforeSections = computeCompareSections(before, CTX)
    const afterSections = computeCompareSections(after, CTX)

    const beforeFoldIds = beforeSections.filter(s => s.density === 'summarized').map(s => s.foldId)
    const afterFoldIds = afterSections.filter(s => s.density === 'summarized').map(s => s.foldId)

    expect(beforeFoldIds).toHaveLength(1)
    expect(afterFoldIds).toHaveLength(2)
    // No overlap — the original fold's id should appear in neither of the new folds.
    for (const id of afterFoldIds) {
      expect(beforeFoldIds).not.toContain(id)
    }
  })

  it('top-of-list and bottom-of-list folds get distinct anchor sentinels', () => {
    const topFold = [normal('n1'), normal('n2'), decorated('d1')]
    const bottomFold = [decorated('d1'), normal('n1'), normal('n2')]

    const top = computeCompareSections(topFold, CTX)[0]
    const bottom = computeCompareSections(bottomFold, CTX)[1]

    expect(top.foldId).toBeDefined()
    expect(bottom.foldId).toBeDefined()
    expect(top.foldId).not.toBe(bottom.foldId)
  })
})

// ─── Depth-decrease split ────────────────────────────────────────────────────

describe('computeCompareSections — depth-decrease split (Step 5)', () => {
  it('splits a fold run when depth decreases (returning up the tree)', () => {
    // [shelf d2, shelf d2, region d0, region d0]
    // Without the split: one fold of 4. With the split: two folds.
    const rows = [
      normal('s1', 2), normal('s2', 2),
      normal('r1', 0), normal('r2', 0),
    ]
    const sections = computeCompareSections(rows, CTX)
    expect(shape(sections)).toEqual([
      [0, 1, 'summarized', 'compare-unchanged'],
      [2, 3, 'summarized', 'compare-unchanged'],
    ])
  })

  it('does NOT split when depth INCREASES (going deeper into the same subtree)', () => {
    // Parent at depth 1, its child at depth 2 — same subtree.
    const rows = [
      normal('parent', 1, { expanded: true, hasChildren: true }),
      normal('child', 2),
    ]
    const sections = computeCompareSections(rows, CTX)
    expect(shape(sections)).toEqual([
      [0, 1, 'summarized', 'compare-unchanged'],
    ])
  })

  it('produces distinct foldIds for the two halves of a depth-split run', () => {
    const rows = [
      normal('s1', 2), normal('s2', 2),
      normal('r1', 0), normal('r2', 0),
    ]
    const sections = computeCompareSections(rows, CTX)
    expect(sections[0].foldId).toBeDefined()
    expect(sections[1].foldId).toBeDefined()
    expect(sections[0].foldId).not.toBe(sections[1].foldId)
  })

  it('opt-out via splitOnDepthDecrease: false → one fold, doc-literal behavior preserved', () => {
    const rows = [
      normal('s1', 2), normal('s2', 2),
      normal('r1', 0), normal('r2', 0),
    ]
    const sections = computeCompareSections(rows, CTX, { splitOnDepthDecrease: false })
    expect(shape(sections)).toEqual([
      [0, 3, 'summarized', 'compare-unchanged'],
    ])
  })

  it('a sub-threshold half after split falls back to full', () => {
    // [s d2, s d2, r d0]: split into [2 shelves] [1 region].
    // Second half (1 row) is below minFoldSize → emits as full.
    const rows = [normal('s1', 2), normal('s2', 2), normal('r1', 0)]
    const sections = computeCompareSections(rows, CTX)
    expect(shape(sections)).toEqual([
      [0, 1, 'summarized', 'compare-unchanged'],
      [2, 2, 'full', 'compare-changed'],
    ])
  })
})

// ─── Subtree-change rollup into fold breakdown ────────────────────────────────

describe('computeCompareSections — collapsed subtree rollup (Step 5)', () => {
  function summary(s: Partial<SubtreeSummary>): SubtreeSummary {
    return { added: 0, removed: 0, renamed: 0, moved: 0, propertyChanged: 0, orderChanged: 0, ...s }
  }

  it('without subtreeSummaries, breakdown stays all zeros (Step 1 behavior preserved)', () => {
    const rows = [normal('n1'), normal('n2'), normal('n3')]
    const [section] = computeCompareSections(rows, CTX)
    expect(section.changeBreakdown).toEqual({
      added: 0, removed: 0, renamed: 0, moved: 0, propertyChanged: 0,
    })
  })

  it('with subtreeSummaries, sums collapsed rows in the fold', () => {
    const rows = [
      normal('n1'),  // collapsed, subtree has 2 added
      normal('n2'),  // collapsed, subtree has 1 moved + 1 renamed
      normal('n3'),  // collapsed, subtree has 3 property-changed
    ]
    const subtreeSummaries = new Map<string, SubtreeSummary>([
      ['n1', summary({ added: 2 })],
      ['n2', summary({ moved: 1, renamed: 1 })],
      ['n3', summary({ propertyChanged: 3 })],
    ])
    const [section] = computeCompareSections(rows, { ...CTX, subtreeSummaries })
    expect(section.changeBreakdown).toEqual({
      added: 2, removed: 0, renamed: 1, moved: 1, propertyChanged: 3,
    })
  })

  it('expanded rows are skipped — their descendants are visible elsewhere in the stream', () => {
    const rows = [
      normal('expanded', 0, { expanded: true, hasChildren: true }),  // expanded, skipped
      normal('collapsed', 0),                                          // collapsed, contributes
    ]
    const subtreeSummaries = new Map<string, SubtreeSummary>([
      ['expanded',  summary({ added: 99 })],   // would double-count if not skipped
      ['collapsed', summary({ added: 1 })],
    ])
    const [section] = computeCompareSections(rows, { ...CTX, subtreeSummaries })
    expect(section.changeBreakdown).toEqual({
      added: 1, removed: 0, renamed: 0, moved: 0, propertyChanged: 0,
    })
  })

  it('rows missing from the summaries map contribute zero (no crash)', () => {
    const rows = [normal('n1'), normal('n2')]
    const subtreeSummaries = new Map<string, SubtreeSummary>([
      ['n1', summary({ added: 5 })],
      // n2 absent
    ])
    const [section] = computeCompareSections(rows, { ...CTX, subtreeSummaries })
    expect(section.changeBreakdown?.added).toBe(5)
  })
})
