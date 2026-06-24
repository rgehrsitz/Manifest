import { describe, expect, it } from 'vitest'
import {
  DIFF_CLASSIFICATION_LABELS,
  DIFF_CLASSIFICATION_WHY,
  classifyDiff,
} from '../../../src/shared/diff-format'
import type { DiffClassification, DiffEntry } from '../../../src/shared/types'

function diff(overrides: Pick<DiffEntry, 'changeType'> & Partial<DiffEntry>): DiffEntry {
  return {
    nodeId: 'node',
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

describe('classifyDiff', () => {
  it('classifies hierarchy changes as structural unless removal breaks references', () => {
    expect(classifyDiff(diff({ changeType: 'added' }))).toBe('structural')
    expect(classifyDiff(diff({ changeType: 'moved' }))).toBe('structural')
    expect(classifyDiff(diff({ changeType: 'removed' }))).toBe('structural')
    expect(classifyDiff(diff({
      changeType: 'removed',
      context: {
        nodeName: 'Node',
        parentName: 'Lab',
        path: ['Lab'],
        removalImpact: {
          descendants: [],
          incomingReferences: [
            { nodeId: 'probe', nodeName: 'Probe', path: ['Lab'], fieldKey: 'controller' },
          ],
        },
      },
    }))).toBe('dependency')
  })

  it('classifies reference property changes as dependency changes', () => {
    expect(classifyDiff(diff({
      changeType: 'property-changed',
      context: {
        nodeName: 'Node',
        parentName: 'Lab',
        path: ['Lab'],
        propertyValueLabels: {
          controller: { old: 'Controller A (a)', new: 'Controller B (b)' },
        },
      },
    }))).toBe('dependency')
  })

  it('does not treat unchanged reference labels as dependency changes', () => {
    expect(classifyDiff(diff({
      changeType: 'property-changed',
      context: {
        nodeName: 'Node',
        parentName: 'Lab',
        path: ['Lab'],
        propertyValueLabels: {
          controller: { old: 'Controller A (a)', new: 'Controller A (a)' },
        },
      },
    }))).toBe('data')
  })

  it('classifies data, schema, and ordering changes', () => {
    expect(classifyDiff(diff({ changeType: 'renamed' }))).toBe('data')
    expect(classifyDiff(diff({ changeType: 'property-changed' }))).toBe('data')
    expect(classifyDiff(diff({ changeType: 'template-changed' }))).toBe('schema')
    expect(classifyDiff(diff({ changeType: 'order-changed' }))).toBe('ordering')
  })

  it('has labels and rationale for every classification', () => {
    const classifications: DiffClassification[] = [
      'structural',
      'dependency',
      'data',
      'schema',
      'ordering',
    ]

    for (const classification of classifications) {
      expect(DIFF_CLASSIFICATION_LABELS[classification]).not.toBe('')
      expect(DIFF_CLASSIFICATION_WHY[classification]).not.toBe('')
    }
  })
})
