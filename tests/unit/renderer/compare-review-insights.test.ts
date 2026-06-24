import { describe, expect, it } from 'vitest'
import { buildReviewInsights } from '../../../src/renderer/src/lib/compare-review-insights'
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
      label: '1 broken incoming reference',
      detail: 'Dependency risk: 1 removed node still had dependents.',
      severity: 'High',
      classification: 'dependency',
    })
    expect(insights[1]).toMatchObject({
      label: '1 removal includes 2 descendants',
      detail: 'Structural impact: review cascade impact before treating child removals individually.',
      severity: 'High',
      classification: 'structural',
    })
    expect(insights[2].label).toBe('2 high-priority changes')
    expect(insights[2].detail).toContain('Priority mix:')
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

    expect(insights).toContainEqual({
      label: '2 changes to "firmware"',
      detail: 'Data pattern: likely a repeated field update.',
      severity: 'Medium',
      classification: 'data',
    })
    expect(insights).toContainEqual({
      label: '3 changes under Lab / Rack A',
      detail: 'Structural concentration: this branch carries most of the activity.',
      severity: 'Medium',
      classification: 'structural',
    })
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

    expect(insights).toContainEqual({
      label: '1 removal includes 2 descendants',
      detail: 'Structural impact: review cascade impact before treating child removals individually.',
      severity: 'High',
      classification: 'structural',
    })
  })

  it('surfaces schema changes as review focus items', () => {
    expect(buildReviewInsights([], [
      { templateId: 'device', templateLabel: 'Device', changeType: 'field-removed', fieldKey: 'firmware' },
    ])).toContainEqual({
      label: '1 schema change',
      detail: 'Schema impact: template or field definitions changed.',
      severity: 'High',
      classification: 'schema',
    })
  })

  it('adds a low-priority display-only rollup after higher-risk insights', () => {
    const insights = buildReviewInsights([
      diff({ nodeId: 'rack-a', changeType: 'order-changed', classification: 'ordering', severity: 'Low' }),
    ])

    expect(insights).toEqual([
      {
        label: '1 display-only change',
        detail: 'Ordering and low-importance data changes can usually be skimmed after higher-risk findings.',
        severity: 'Low',
        classification: 'ordering',
      },
    ])
  })
})
