import { describe, it, expect } from 'vitest'
import { diffProjects, diffTemplates } from '../../../src/shared/diff-engine'
import type { Project, ManifestNode, NodeTemplate } from '../../../src/shared/types'

function node(id: string, overrides: Partial<ManifestNode> = {}): ManifestNode {
  return {
    id,
    parentId: id === 'root' ? null : 'root',
    name: id,
    order: 0,
    properties: {},
    created: '2026-01-01T00:00:00.000Z',
    modified: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function project(nodes: ManifestNode[], templates?: Record<string, NodeTemplate>): Project {
  return {
    version: 3,
    id: 'p',
    name: 'P',
    created: '2026-01-01T00:00:00.000Z',
    modified: '2026-01-01T00:00:00.000Z',
    nodes,
    ...(templates ? { templates } : {}),
  }
}

describe('diffProjects — template-changed', () => {
  it('emits template-changed when a node gains a template', () => {
    const a = project([node('root'), node('a')])
    const b = project([node('root'), node('a', { templateId: 'rack' })])
    const diffs = diffProjects(a, b)
    const tc = diffs.find(d => d.changeType === 'template-changed')
    expect(tc).toBeDefined()
    expect(tc!.oldValue).toBeNull()
    expect(tc!.newValue).toBe('rack')
  })

  it('does not emit template-changed when templateId is unchanged', () => {
    const a = project([node('root'), node('a', { templateId: 'rack' })])
    const b = project([node('root'), node('a', { templateId: 'rack' })])
    expect(diffProjects(a, b).some(d => d.changeType === 'template-changed')).toBe(false)
  })

  it('treats absent and null templateId as equal (no false change)', () => {
    const a = project([node('root'), node('a')])
    const b = project([node('root'), node('a', { templateId: null })])
    expect(diffProjects(a, b).some(d => d.changeType === 'template-changed')).toBe(false)
  })
})

describe('diffTemplates', () => {
  const rackV1: NodeTemplate = { label: 'Rack', fields: { location: { type: 'string' } } }

  it('detects an added template', () => {
    const a = project([node('root')])
    const b = project([node('root')], { rack: rackV1 })
    const out = diffTemplates(a, b)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ templateId: 'rack', changeType: 'template-added' })
  })

  it('detects a removed template', () => {
    const a = project([node('root')], { rack: rackV1 })
    const b = project([node('root')])
    const out = diffTemplates(a, b)
    expect(out[0]).toMatchObject({ templateId: 'rack', changeType: 'template-removed' })
  })

  it('detects relabel, field add/remove, and field change', () => {
    const a = project([node('root')], {
      rack: { label: 'Rack', fields: { location: { type: 'string' }, capacity: { type: 'number' } } },
    })
    const b = project([node('root')], {
      rack: {
        label: 'Equipment Rack',                                   // relabel
        fields: {
          location: { type: 'version' },                          // field-changed (type)
          firmware: { type: 'version' },                          // field-added
        },                                                        // capacity removed
      },
    })
    const out = diffTemplates(a, b)
    const types = out.map(e => e.changeType)
    expect(types).toContain('template-relabeled')
    expect(types).toContain('field-added')
    expect(types).toContain('field-removed')
    expect(types).toContain('field-changed')
    const relabel = out.find(e => e.changeType === 'template-relabeled')!
    expect(relabel.oldValue).toBe('Rack')
    expect(relabel.newValue).toBe('Equipment Rack')
  })

  it('detects a description-only change (not just label/fields)', () => {
    const a = project([node('root')], { rack: { label: 'Rack', description: 'old', fields: {} } })
    const b = project([node('root')], { rack: { label: 'Rack', description: 'new', fields: {} } })
    const out = diffTemplates(a, b)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      templateId: 'rack',
      changeType: 'template-redescribed',
      oldValue: 'old',
      newValue: 'new',
    })
  })

  it('returns nothing for identical template maps', () => {
    const a = project([node('root')], { rack: rackV1 })
    const b = project([node('root')], { rack: { label: 'Rack', fields: { location: { type: 'string' } } } })
    expect(diffTemplates(a, b)).toEqual([])
  })

  it('does not throw when a side has a structurally-invalid template (snapshots are not quarantined)', () => {
    // tplA is missing `fields` (hand-edited); tplB is valid. Must not throw at
    // Object.keys(a.fields) and should report B's fields as added.
    const a = project([node('root')], { rack: { label: 'Bad' } as any })
    const b = project([node('root')], { rack: rackV1 })
    expect(() => diffTemplates(a, b)).not.toThrow()
    const out = diffTemplates(a, b)
    expect(out.some(e => e.changeType === 'field-added' && e.fieldKey === 'location')).toBe(true)
  })

  it('does not throw when a template entry is null', () => {
    const a = project([node('root')], { rack: null } as any)
    const b = project([node('root')], { rack: rackV1 })
    expect(() => diffTemplates(a, b)).not.toThrow()
  })

  it('a schema-only change is never silently hidden', () => {
    // Same nodes; only the template's enum options changed. Node diffs are
    // empty, but diffTemplates must surface the schema change.
    const a = project([node('root')], {
      st: { label: 'S', fields: { status: { type: 'enum', options: ['a'] } } },
    })
    const b = project([node('root')], {
      st: { label: 'S', fields: { status: { type: 'enum', options: ['a', 'b'] } } },
    })
    expect(diffProjects(a, b)).toEqual([])
    expect(diffTemplates(a, b)).toHaveLength(1)
  })

  it('detects compare importance changes as schema changes', () => {
    const a = project([node('root')], {
      device: { label: 'Device', fields: { firmware: { type: 'version', compareImportance: 'High' } } },
    })
    const b = project([node('root')], {
      device: { label: 'Device', fields: { firmware: { type: 'version', compareImportance: 'Low' } } },
    })

    const out = diffTemplates(a, b)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      templateId: 'device',
      fieldKey: 'firmware',
      changeType: 'field-changed',
    })
  })
})
