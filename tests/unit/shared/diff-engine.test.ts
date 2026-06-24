import { describe, expect, it } from 'vitest'
import { diffProjects } from '../../../src/shared/diff-engine'
import type { NodeTemplate, Project } from '../../../src/shared/types'

function makeProject(nodes: Project['nodes'], templates?: Record<string, NodeTemplate>): Project {
  return {
    version: 2,
    id: 'project-id',
    name: 'Test Project',
    created: '2026-01-01T00:00:00.000Z',
    modified: '2026-01-01T00:00:00.000Z',
    nodes,
    ...(templates ? { templates } : {}),
  }
}

function baseNodes(): Project['nodes'] {
  return [
    {
      id: 'root',
      parentId: null,
      name: 'Root',
      order: 0,
      properties: {},
      created: '2026-01-01T00:00:00.000Z',
      modified: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 'rack-a',
      parentId: 'root',
      name: 'Rack A',
      order: 0,
      properties: { serial: 'A-1' },
      created: '2026-01-01T00:00:00.000Z',
      modified: '2026-01-01T00:00:00.000Z',
    },
  ]
}

describe('diffProjects', () => {
  it('detects node additions and removals', () => {
    const before = makeProject(baseNodes())
    const after = makeProject([
      ...baseNodes(),
      {
        id: 'server-1',
        parentId: 'rack-a',
        name: 'Server 1',
        order: 0,
        properties: {},
        created: '2026-01-01T00:00:00.000Z',
        modified: '2026-01-01T00:00:00.000Z',
      },
    ])

    const added = diffProjects(before, after)
    expect(added).toHaveLength(1)
    expect(added[0].changeType).toBe('added')
    expect(added[0].severity).toBe('High')

    const removed = diffProjects(after, before)
    expect(removed).toHaveLength(1)
    expect(removed[0].changeType).toBe('removed')
    expect(removed[0].severity).toBe('High')
    expect(removed[0].severityReason).toContain('removed')
    expect(removed[0].context.removalImpact).toBeUndefined()
  })

  it('detects rename, property, and order changes on the same node', () => {
    const before = makeProject([
      ...baseNodes(),
      {
        id: 'rack-b',
        parentId: 'root',
        name: 'Rack B',
        order: 1,
        properties: { firmware: 'v1' },
        created: '2026-01-01T00:00:00.000Z',
        modified: '2026-01-01T00:00:00.000Z',
      },
    ])

    const after = makeProject([
      {
        ...baseNodes()[0],
      },
      {
        id: 'rack-b',
        parentId: 'root',
        name: 'Rack Beta',
        order: 0,
        properties: { firmware: 'v2' },
        created: '2026-01-01T00:00:00.000Z',
        modified: '2026-01-01T00:00:00.000Z',
      },
      {
        ...baseNodes()[1],
        order: 1,
      },
    ])

    const diffs = diffProjects(before, after)
    expect(diffs.map((diff) => diff.changeType)).toEqual([
      'renamed',
      'property-changed',
      'order-changed',
      'order-changed',
    ])
  })

  it('detects moves as high severity and uses the destination context', () => {
    const before = makeProject([
      ...baseNodes(),
      {
        id: 'rack-b',
        parentId: 'root',
        name: 'Rack B',
        order: 1,
        properties: {},
        created: '2026-01-01T00:00:00.000Z',
        modified: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'server-1',
        parentId: 'rack-a',
        name: 'Server 1',
        order: 0,
        properties: {},
        created: '2026-01-01T00:00:00.000Z',
        modified: '2026-01-01T00:00:00.000Z',
      },
    ])

    const after = makeProject([
      ...baseNodes(),
      {
        id: 'rack-b',
        parentId: 'root',
        name: 'Rack B',
        order: 1,
        properties: {},
        created: '2026-01-01T00:00:00.000Z',
        modified: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'server-1',
        parentId: 'rack-b',
        name: 'Server 1',
        order: 0,
        properties: {},
        created: '2026-01-01T00:00:00.000Z',
        modified: '2026-01-01T00:00:00.000Z',
      },
    ])

    const diffs = diffProjects(before, after)
    expect(diffs).toHaveLength(1)
    expect(diffs[0].changeType).toBe('moved')
    expect(diffs[0].severity).toBe('High')
    expect(diffs[0].context.parentName).toBe('Rack B')
    expect(diffs[0].context.path).toEqual(['Root', 'Rack B'])
  })

  it('adds display labels for changed reference properties', () => {
    const before = {
      ...makeProject([
        ...baseNodes(),
        {
          id: 'supply-alpha-id',
          parentId: 'root',
          name: 'Power Supply A',
          order: 1,
          properties: {},
          created: '2026-01-01T00:00:00.000Z',
          modified: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 'supply-bravo-id',
          parentId: 'root',
          name: 'Power Supply B',
          order: 2,
          properties: {},
          created: '2026-01-01T00:00:00.000Z',
          modified: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 'chamber',
          parentId: 'root',
          name: 'Chamber',
          order: 3,
          templateId: 'asset',
          properties: { controller: 'supply-alpha-id' },
          created: '2026-01-01T00:00:00.000Z',
          modified: '2026-01-01T00:00:00.000Z',
        },
      ]),
      templates: { asset: { label: 'Asset', fields: { controller: { type: 'reference' } } } },
    }
    const after = {
      ...before,
      nodes: before.nodes.map(n => n.id === 'chamber'
        ? { ...n, properties: { controller: 'supply-bravo-id' } }
        : n
      ),
    }

    const diff = diffProjects(before, after).find(d => d.changeType === 'property-changed')!
    expect(diff.context.propertyValueLabels?.controller).toEqual({
      old: 'Power Supply A (supply-alpha-id)',
      new: 'Power Supply B (supply-bravo-id)',
    })
  })

  it('uses template field importance to classify property changes', () => {
    const template: NodeTemplate = {
      label: 'Device',
      fields: {
        firmware: { type: 'version', compareImportance: 'High' },
        notes: { type: 'string', compareImportance: 'Low' },
      },
    }
    const before = makeProject([
      ...baseNodes(),
      {
        id: 'device',
        parentId: 'rack-a',
        name: 'Device',
        order: 0,
        templateId: 'device',
        properties: { firmware: '1.0', notes: 'old' },
        created: '2026-01-01T00:00:00.000Z',
        modified: '2026-01-01T00:00:00.000Z',
      },
    ], { device: template })
    const afterFirmware = makeProject(before.nodes.map(node => node.id === 'device'
      ? { ...node, properties: { firmware: '2.0', notes: 'old' } }
      : node
    ), { device: template })
    const afterNotes = makeProject(before.nodes.map(node => node.id === 'device'
      ? { ...node, properties: { firmware: '1.0', notes: 'new' } }
      : node
    ), { device: template })

    const firmware = diffProjects(before, afterFirmware).find(d => d.changeType === 'property-changed')!
    expect(firmware.severity).toBe('High')
    expect(firmware.severityReason).toBe('High: important field "firmware" changed.')
    expect(firmware.context.propertyImportance).toEqual({ firmware: 'High' })

    const notes = diffProjects(before, afterNotes).find(d => d.changeType === 'property-changed')!
    expect(notes.severity).toBe('Low')
    expect(notes.severityReason).toBe('Low: only low-importance field "notes" changed.')
    expect(notes.context.propertyImportance).toEqual({ notes: 'Low' })
  })

  it('explains removal impact for descendants and incoming references', () => {
    const before = {
      ...makeProject([
        ...baseNodes(),
        {
          id: 'child',
          parentId: 'rack-a',
          name: 'Child',
          order: 0,
          properties: {},
          created: '2026-01-01T00:00:00.000Z',
          modified: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 'controller',
          parentId: 'root',
          name: 'Controller',
          order: 1,
          templateId: 'controller',
          properties: { target: 'rack-a' },
          created: '2026-01-01T00:00:00.000Z',
          modified: '2026-01-01T00:00:00.000Z',
        },
      ]),
      templates: { controller: { label: 'Controller', fields: { target: { type: 'reference' } } } },
    }
    const after = makeProject(before.nodes.filter(node => node.id !== 'rack-a' && node.id !== 'child'), before.templates)

    const removed = diffProjects(before, after).find(d => d.nodeId === 'rack-a')!
    expect(removed.severityReason).toContain('1 descendant')
    expect(removed.severityReason).toContain('1 incoming reference')
    expect(removed.context.removalImpact?.descendants).toEqual([
      { id: 'child', name: 'Child', path: ['Root', 'Rack A'] },
    ])
    expect(removed.context.removalImpact?.incomingReferences).toEqual([
      { nodeId: 'controller', nodeName: 'Controller', path: ['Root'], fieldKey: 'target' },
    ])
  })

  it('attaches descendant impact only to top-level removed ancestors', () => {
    const before = makeProject([
      ...baseNodes(),
      {
        id: 'server-1',
        parentId: 'rack-a',
        name: 'Server 1',
        order: 0,
        properties: {},
        created: '2026-01-01T00:00:00.000Z',
        modified: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'disk-1',
        parentId: 'server-1',
        name: 'Disk 1',
        order: 0,
        properties: {},
        created: '2026-01-01T00:00:00.000Z',
        modified: '2026-01-01T00:00:00.000Z',
      },
    ])
    const after = makeProject(before.nodes.filter(node => (
      node.id !== 'rack-a' &&
      node.id !== 'server-1' &&
      node.id !== 'disk-1'
    )))

    const diffs = diffProjects(before, after)
    const rack = diffs.find(diff => diff.nodeId === 'rack-a')!
    const server = diffs.find(diff => diff.nodeId === 'server-1')!
    const disk = diffs.find(diff => diff.nodeId === 'disk-1')!

    expect(rack.context.removalImpact?.descendants).toEqual([
      { id: 'server-1', name: 'Server 1', path: ['Root', 'Rack A'] },
      { id: 'disk-1', name: 'Disk 1', path: ['Root', 'Rack A', 'Server 1'] },
    ])
    expect(server.context.removalImpact?.descendants).toBeUndefined()
    expect(disk.context.removalImpact).toBeUndefined()
  })

  it('ignores incoming references from nodes that are removed in the same compare', () => {
    const before = {
      ...makeProject([
        ...baseNodes(),
        {
          id: 'child-controller',
          parentId: 'rack-a',
          name: 'Child Controller',
          order: 0,
          templateId: 'controller',
          properties: { target: 'rack-a' },
          created: '2026-01-01T00:00:00.000Z',
          modified: '2026-01-01T00:00:00.000Z',
        },
      ]),
      templates: { controller: { label: 'Controller', fields: { target: { type: 'reference' } } } },
    }
    const after = makeProject(before.nodes.filter(node => (
      node.id !== 'rack-a' &&
      node.id !== 'child-controller'
    )), before.templates)

    const removed = diffProjects(before, after).find(diff => diff.nodeId === 'rack-a')!

    expect(removed.context.removalImpact?.incomingReferences).toEqual([])
    expect(removed.severityReason).toBe('High: removed node affected 1 descendant.')
  })
})
