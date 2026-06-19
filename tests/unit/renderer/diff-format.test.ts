import { describe, expect, it } from 'vitest'
import {
  formatChangeType,
  formatPath,
  formatValue,
  formatTemplateRef,
  severityClass,
  severityBadgeClass,
  describePropertyChange,
  describeTemplateChange,
} from '../../../src/renderer/src/lib/diff-format'
import type { DiffEntry, TemplateDiffEntry } from '../../../src/shared/types'

// ─── formatChangeType ─────────────────────────────────────────────────────────

describe('formatChangeType', () => {
  it('formats property-changed as "Property Changed"', () => {
    expect(formatChangeType('property-changed')).toBe('Property Changed')
  })

  it('formats order-changed as "Order Changed"', () => {
    expect(formatChangeType('order-changed')).toBe('Order Changed')
  })

  it('capitalises single-word types', () => {
    expect(formatChangeType('added')).toBe('Added')
    expect(formatChangeType('removed')).toBe('Removed')
    expect(formatChangeType('moved')).toBe('Moved')
    expect(formatChangeType('renamed')).toBe('Renamed')
  })
})

// ─── formatPath ──────────────────────────────────────────────────────────────

describe('formatPath', () => {
  it('joins path segments and node name with " / "', () => {
    expect(formatPath(['Root', 'Zone A'], 'Rack 1')).toBe('Root / Zone A / Rack 1')
  })

  it('handles empty path (root-level node)', () => {
    expect(formatPath([], 'Root')).toBe('Root')
  })

  it('handles single ancestor', () => {
    expect(formatPath(['Parent'], 'Child')).toBe('Parent / Child')
  })
})

// ─── formatValue ─────────────────────────────────────────────────────────────

describe('formatValue', () => {
  it('returns "root" for null', () => {
    expect(formatValue(null)).toBe('root')
  })

  it('returns "root" for undefined', () => {
    expect(formatValue(undefined)).toBe('root')
  })

  it('returns strings as-is', () => {
    expect(formatValue('hello')).toBe('hello')
  })

  it('stringifies numbers', () => {
    expect(formatValue(42)).toBe('42')
  })

  it('stringifies booleans', () => {
    expect(formatValue(true)).toBe('true')
    expect(formatValue(false)).toBe('false')
  })

  it('JSON-stringifies objects', () => {
    expect(formatValue({ a: 1 })).toBe('{\n  "a": 1\n}')
  })
})

// ─── severityClass ───────────────────────────────────────────────────────────

describe('severityClass', () => {
  it('returns amber classes for High', () => {
    expect(severityClass('High')).toContain('amber')
  })

  it('returns sky classes for Medium', () => {
    expect(severityClass('Medium')).toContain('sky')
  })

  it('returns stone classes for Low', () => {
    expect(severityClass('Low')).toContain('stone')
  })
})

// ─── severityBadgeClass ───────────────────────────────────────────────────────

describe('severityBadgeClass', () => {
  it('returns amber badge for High', () => {
    expect(severityBadgeClass('High')).toContain('amber')
  })

  it('returns sky badge for Medium', () => {
    expect(severityBadgeClass('Medium')).toContain('sky')
  })

  it('returns stone badge for Low', () => {
    expect(severityBadgeClass('Low')).toContain('stone')
  })
})

// ─── describePropertyChange ───────────────────────────────────────────────────

function makeDiff(
  oldValue: Record<string, unknown>,
  newValue: Record<string, unknown>
): DiffEntry {
  return {
    nodeId: 'rack',
    changeType: 'property-changed',
    severity: 'Medium',
    oldValue,
    newValue,
    context: { nodeName: 'Rack', parentName: 'Root', path: ['Root'] },
  }
}

describe('describePropertyChange', () => {
  it('reports added key', () => {
    const lines = describePropertyChange(makeDiff({}, { serial: 'A-1' }))
    expect(lines).toContain('Added serial: A-1')
  })

  it('reports removed key', () => {
    const lines = describePropertyChange(makeDiff({ serial: 'A-1' }, {}))
    expect(lines).toContain('Removed serial')
  })

  it('reports changed value with arrow notation', () => {
    const lines = describePropertyChange(makeDiff({ serial: 'A-1' }, { serial: 'A-2' }))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toBe('serial: A-1 → A-2')
  })

  it('returns empty array when nothing changed', () => {
    const lines = describePropertyChange(makeDiff({ a: 1 }, { a: 1 }))
    expect(lines).toEqual([])
  })

  it('handles multiple changed keys', () => {
    const lines = describePropertyChange(
      makeDiff({ a: '1', b: '2', c: '3' }, { a: '1', b: '9', c: '3' })
    )
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('b')
  })

  it('reports keys sorted alphabetically', () => {
    const lines = describePropertyChange(
      makeDiff({ z: '1', a: '2' }, { z: '1', a: '9' })
    )
    // 'a: ...' comes before 'z: ...'
    expect(lines[0]).toMatch(/^a:/)
  })
})

// ─── template diffs ──────────────────────────────────────────────────────────

describe('formatChangeType — template-changed', () => {
  it('formats template-changed', () => {
    expect(formatChangeType('template-changed')).toBe('Template Changed')
  })
})

describe('formatTemplateRef', () => {
  it('renders null/empty as (none) and ids verbatim', () => {
    expect(formatTemplateRef(null)).toBe('(none)')
    expect(formatTemplateRef(undefined)).toBe('(none)')
    expect(formatTemplateRef('')).toBe('(none)')
    expect(formatTemplateRef('software-item')).toBe('software-item')
  })
})

describe('describeTemplateChange', () => {
  const base = { templateId: 'rack', templateLabel: 'Rack' }
  it('describes template add/remove/relabel', () => {
    expect(describeTemplateChange({ ...base, changeType: 'template-added' } as TemplateDiffEntry))
      .toBe('Added template "Rack"')
    expect(describeTemplateChange({ ...base, changeType: 'template-removed' } as TemplateDiffEntry))
      .toBe('Removed template "Rack"')
    expect(describeTemplateChange({
      ...base, changeType: 'template-relabeled', oldValue: 'Rack', newValue: 'Equipment Rack',
    } as TemplateDiffEntry)).toBe('Renamed template rack: "Rack" → "Equipment Rack"')
  })

  it('describes field add/remove/change', () => {
    expect(describeTemplateChange({
      ...base, changeType: 'field-added', fieldKey: 'firmware', newValue: { type: 'version' },
    } as TemplateDiffEntry)).toBe('Rack: added field "firmware" (version)')
    expect(describeTemplateChange({
      ...base, changeType: 'field-removed', fieldKey: 'capacity',
    } as TemplateDiffEntry)).toBe('Rack: removed field "capacity"')
    expect(describeTemplateChange({
      ...base, changeType: 'field-changed', fieldKey: 'location',
      oldValue: { type: 'string' }, newValue: { type: 'version' },
    } as TemplateDiffEntry)).toBe('Rack: field "location" changed (string → version)')
  })

  it('notes enum option and required changes when type is unchanged', () => {
    const txt = describeTemplateChange({
      ...base, changeType: 'field-changed', fieldKey: 'status',
      oldValue: { type: 'enum', options: ['a'] },
      newValue: { type: 'enum', options: ['a', 'b'], required: true },
    } as TemplateDiffEntry)
    expect(txt).toContain('options changed')
    expect(txt).toContain('now required')
  })
})
