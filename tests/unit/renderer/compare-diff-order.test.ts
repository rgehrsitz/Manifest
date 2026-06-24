import { describe, expect, it } from 'vitest'
import { orderCompareDiffs } from '../../../src/renderer/src/lib/compare-diff-order'
import type { DiffEntry } from '../../../src/shared/types'

function diff(overrides: Partial<DiffEntry> & Pick<DiffEntry, 'nodeId' | 'changeType'>): DiffEntry {
  return {
    severity: 'Medium',
    context: {
      nodeName: overrides.nodeId,
      parentName: 'Lab',
      path: ['Lab'],
    },
    ...overrides,
  } as DiffEntry
}

describe('orderCompareDiffs', () => {
  it('preserves document order unchanged', () => {
    const diffs = [
      diff({ nodeId: 'low', changeType: 'order-changed', severity: 'Low' }),
      diff({ nodeId: 'high', changeType: 'moved', severity: 'High' }),
    ]

    expect(orderCompareDiffs(diffs, 'document')).toBe(diffs)
    expect(orderCompareDiffs(diffs, 'document').map(d => d.nodeId)).toEqual(['low', 'high'])
  })

  it('sorts priority order by severity first', () => {
    const diffs = [
      diff({ nodeId: 'low', changeType: 'order-changed', severity: 'Low' }),
      diff({ nodeId: 'medium', changeType: 'renamed', severity: 'Medium' }),
      diff({ nodeId: 'high', changeType: 'moved', severity: 'High' }),
    ]

    expect(orderCompareDiffs(diffs, 'priority').map(d => d.nodeId)).toEqual(['high', 'medium', 'low'])
  })

  it('sorts removed rows with impact before equal-severity clean removals', () => {
    const diffs = [
      diff({ nodeId: 'clean', changeType: 'removed', severity: 'High' }),
      diff({
        nodeId: 'descendants',
        changeType: 'removed',
        severity: 'High',
        context: {
          nodeName: 'Descendants',
          parentName: 'Lab',
          path: ['Lab'],
          removalImpact: {
            descendants: [{ id: 'child', name: 'Child', path: ['Lab', 'Descendants'] }],
            incomingReferences: [],
          },
        },
      }),
      diff({
        nodeId: 'references',
        changeType: 'removed',
        severity: 'High',
        context: {
          nodeName: 'References',
          parentName: 'Lab',
          path: ['Lab'],
          removalImpact: {
            descendants: [],
            incomingReferences: [{ nodeId: 'probe', nodeName: 'Probe', path: ['Lab'], fieldKey: 'controller' }],
          },
        },
      }),
    ]

    expect(orderCompareDiffs(diffs, 'priority').map(d => d.nodeId)).toEqual([
      'references',
      'descendants',
      'clean',
    ])
  })

  it('uses path as a stable final tiebreaker', () => {
    const diffs = [
      diff({ nodeId: 'b', changeType: 'renamed', context: { nodeName: 'Beta', parentName: 'Lab', path: ['Lab'] } }),
      diff({ nodeId: 'a', changeType: 'renamed', context: { nodeName: 'Alpha', parentName: 'Lab', path: ['Lab'] } }),
    ]

    expect(orderCompareDiffs(diffs, 'priority').map(d => d.nodeId)).toEqual(['a', 'b'])
  })

  it('handles an empty list', () => {
    expect(orderCompareDiffs([], 'priority')).toEqual([])
  })
})
