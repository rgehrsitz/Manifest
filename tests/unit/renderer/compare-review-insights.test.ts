import { describe, expect, it } from 'vitest'
import {
  buildReviewInsights,
  filterDiffsByReviewInsight,
  focusMatchesDiff,
} from '../../../src/renderer/src/lib/compare-review-insights'
import type { DiffEntry } from '../../../src/shared/types'

function diff(overrides: Partial<DiffEntry> & Pick<DiffEntry, 'changeType'>): DiffEntry {
  return {
    nodeId: 'node',
    changeType: overrides.changeType,
    classification: 'data',
    severity: 'Medium',
    context: {
      nodeName: 'Node',
      parentName: 'Lab',
      path: ['Lab'],
    },
    ...overrides,
  } as DiffEntry
}

describe('buildReviewInsights', () => {
  it('prioritizes removed-node broken references and cascade impact', () => {
    const insights = buildReviewInsights([
      diff({
        nodeId: 'rack-a',
        changeType: 'removed',
        classification: 'dependency',
        severity: 'High',
        context: {
          nodeName: 'Rack A',
          parentName: 'Lab',
          path: ['Lab'],
          removalImpact: {
            descendants: [
              { id: 'server-1', name: 'Server 1', path: ['Lab', 'Rack A'] },
              { id: 'server-2', name: 'Server 2', path: ['Lab', 'Rack A'] },
            ],
            incomingReferences: [
              { nodeId: 'probe', nodeName: 'Probe', path: ['Lab'], fieldKey: 'controller' },
            ],
          },
        },
      }),
      diff({ nodeId: 'server-1', changeType: 'removed', classification: 'structural', severity: 'High' }),
    ])

    expect(insights[0]).toMatchObject({
      id: 'dependency-removed-rack-a',
      label: '1 broken incoming reference to "Rack A"',
      detail: 'Dependency risk: this removed node still had dependents.',
      severity: 'High',
      classification: 'dependency',
      match: expect.objectContaining({ nodeIds: ['rack-a'], expandRemovalImpact: true }),
    })
    expect(insights[1]).toMatchObject({
      id: 'structural-removal-cascade',
      label: '1 removal includes 2 descendants',
      detail: 'Structural impact: review cascade impact before treating child removals individually.',
      severity: 'High',
      classification: 'structural',
      match: expect.objectContaining({ nodeIds: ['rack-a', 'server-1', 'server-2'], expandRemovalImpact: true }),
    })
    expect(insights[2].label).toBe('2 high-priority changes')
    expect(insights[2].detail).toContain('Priority mix:')
    expect(insights[2].match.nodeIds).toEqual(['rack-a', 'server-1'])
  })

  it('keeps repeated property and branch concentration insights', () => {
    const insights = buildReviewInsights([
      diff({
        nodeId: 'device-a',
        changeType: 'property-changed',
        classification: 'data',
        oldValue: { firmware: '1.0' },
        newValue: { firmware: '2.0' },
        context: { nodeName: 'Device A', parentName: 'Rack A', path: ['Lab', 'Rack A'] },
      }),
      diff({
        nodeId: 'device-b',
        changeType: 'property-changed',
        classification: 'data',
        oldValue: { firmware: '1.0' },
        newValue: { firmware: '2.0' },
        context: { nodeName: 'Device B', parentName: 'Rack A', path: ['Lab', 'Rack A'] },
      }),
      diff({
        nodeId: 'device-c',
        changeType: 'renamed',
        classification: 'data',
        oldValue: 'Device C',
        newValue: 'Device Gamma',
        context: { nodeName: 'Device Gamma', parentName: 'Rack A', path: ['Lab', 'Rack A'] },
      }),
    ])

    expect(insights).toContainEqual(expect.objectContaining({
      id: 'data-property-1-firmware',
      label: '2 changes to "firmware"',
      detail: 'Data pattern: likely a repeated field update.',
      severity: 'Medium',
      classification: 'data',
      match: expect.objectContaining({ nodeIds: ['device-a', 'device-b'] }),
    }))
    expect(insights).toContainEqual(expect.objectContaining({
      id: 'structural-branch-lab-rack-a',
      label: '3 changes under Lab / Rack A',
      detail: 'Structural concentration: this branch carries most of the activity.',
      severity: 'Medium',
      classification: 'structural',
      match: expect.objectContaining({ nodeIds: ['device-a', 'device-b', 'device-c'] }),
    }))
  })

  it('returns no insights when there are no node diffs', () => {
    expect(buildReviewInsights([])).toEqual([])
  })

  it('does not inflate cascade impact when nested removed rows have no descendant impact', () => {
    const insights = buildReviewInsights([
      diff({
        nodeId: 'rack-a',
        changeType: 'removed',
        classification: 'structural',
        severity: 'High',
        context: {
          nodeName: 'Rack A',
          parentName: 'Lab',
          path: ['Lab'],
          removalImpact: {
            descendants: [
              { id: 'server-1', name: 'Server 1', path: ['Lab', 'Rack A'] },
              { id: 'disk-1', name: 'Disk 1', path: ['Lab', 'Rack A', 'Server 1'] },
            ],
            incomingReferences: [],
          },
        },
      }),
      diff({ nodeId: 'server-1', changeType: 'removed', classification: 'structural', severity: 'High' }),
      diff({ nodeId: 'disk-1', changeType: 'removed', classification: 'structural', severity: 'High' }),
    ])

    expect(insights).toContainEqual(expect.objectContaining({
      id: 'structural-removal-cascade',
      label: '1 removal includes 2 descendants',
      detail: 'Structural impact: review cascade impact before treating child removals individually.',
      severity: 'High',
      classification: 'structural',
      match: expect.objectContaining({ nodeIds: ['disk-1', 'rack-a', 'server-1'], expandRemovalImpact: true }),
    }))
  })

  it('surfaces schema changes as review focus items', () => {
    expect(buildReviewInsights([], [
      { templateId: 'device', templateLabel: 'Device', changeType: 'field-removed', fieldKey: 'firmware' },
    ])).toContainEqual(expect.objectContaining({
      id: 'schema-template-changes',
      label: '1 schema change',
      detail: 'Schema impact: template or field definitions changed.',
      severity: 'High',
      classification: 'schema',
      match: expect.objectContaining({ nodeIds: [], schema: true }),
    }))
  })

  it('adds a low-priority display-only rollup after higher-risk insights', () => {
    const insights = buildReviewInsights([
      diff({ nodeId: 'rack-a', changeType: 'order-changed', classification: 'ordering', severity: 'Low' }),
    ])

    expect(insights).toEqual([
      expect.objectContaining({
        id: 'ordering-display-only',
        label: '1 display-only change',
        detail: 'Ordering and low-importance data changes can usually be skimmed after higher-risk findings.',
        severity: 'Low',
        classification: 'ordering',
        match: expect.objectContaining({ nodeIds: ['rack-a'] }),
      }),
    ])
  })

  it('returns stable unique ids for all emitted insights', () => {
    const insights = buildReviewInsights([
      diff({ nodeId: 'a', changeType: 'order-changed', classification: 'ordering', severity: 'Low' }),
      diff({ nodeId: 'b', changeType: 'order-changed', classification: 'ordering', severity: 'Low' }),
      diff({
        nodeId: 'c',
        changeType: 'property-changed',
        classification: 'data',
        oldValue: { firmware: '1.0' },
        newValue: { firmware: '2.0' },
      }),
      diff({
        nodeId: 'd',
        changeType: 'property-changed',
        classification: 'data',
        oldValue: { firmware: '1.0' },
        newValue: { firmware: '2.0' },
      }),
    ], [
      { templateId: 'device', templateLabel: 'Device', changeType: 'field-added', fieldKey: 'vendor' },
    ])

    const ids = insights.map(insight => insight.id)
    expect(ids.every(id => id.length > 0)).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('keeps property insight ids unique when property keys slug to the same text', () => {
    const insights = buildReviewInsights([
      diff({
        nodeId: 'a',
        changeType: 'property-changed',
        classification: 'data',
        oldValue: { ip_address: '1', 'ip.address': '1' },
        newValue: { ip_address: '2', 'ip.address': '2' },
      }),
      diff({
        nodeId: 'b',
        changeType: 'property-changed',
        classification: 'data',
        oldValue: { ip_address: '1', 'ip.address': '1' },
        newValue: { ip_address: '2', 'ip.address': '2' },
      }),
    ])

    const propertyIds = insights
      .filter(insight => insight.id.startsWith('data-property-'))
      .map(insight => insight.id)
    expect(propertyIds).toEqual(['data-property-1-ip-address', 'data-property-2-ip-address'])
  })

  it('filters diffs by review focus metadata', () => {
    const diffs = [
      diff({ nodeId: 'rack-a', changeType: 'removed', classification: 'structural', severity: 'High' }),
      diff({ nodeId: 'rack-b', changeType: 'removed', classification: 'structural', severity: 'High' }),
      diff({ nodeId: 'device-a', changeType: 'property-changed', classification: 'data', severity: 'Medium' }),
    ]
    const insight = {
      id: 'structural-removal-cascade',
      label: 'Cascade',
      detail: 'Structural impact.',
      severity: 'High',
      classification: 'structural',
      match: { nodeIds: ['rack-a', 'device-a'] },
    } as const

    expect(filterDiffsByReviewInsight(diffs, null)).toBe(diffs)
    expect(filterDiffsByReviewInsight(diffs, insight).map(diff => diff.nodeId)).toEqual(['rack-a', 'device-a'])
    expect(focusMatchesDiff(insight, diffs[0])).toBe(true)
    expect(focusMatchesDiff(insight, diffs[1])).toBe(false)
  })

  it('uses exact diff keys when an insight points to specific rows on the same node', () => {
    const diffs = [
      diff({ nodeId: 'alpha', changeType: 'moved', classification: 'structural', severity: 'High' }),
      diff({ nodeId: 'alpha', changeType: 'renamed', classification: 'data', severity: 'Medium' }),
    ]
    const highPriority = buildReviewInsights(diffs).find(insight => insight.id === 'priority-high')!

    expect(highPriority.match.nodeIds).toEqual(['alpha'])
    expect(filterDiffsByReviewInsight(diffs, highPriority).map(diff => diff.changeType)).toEqual(['moved'])
  })

  it('schema-only focus filters node rows to an empty set', () => {
    const diffs = [
      diff({ nodeId: 'rack-a', changeType: 'renamed', classification: 'data', severity: 'Medium' }),
    ]
    const insight = buildReviewInsights([], [
      { templateId: 'device', templateLabel: 'Device', changeType: 'field-added', fieldKey: 'vendor' },
    ])[0]

    expect(insight.match.schema).toBe(true)
    expect(filterDiffsByReviewInsight(diffs, insight)).toEqual([])
  })
})
