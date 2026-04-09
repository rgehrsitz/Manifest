import { describe, expect, it } from 'vitest'
import { diffProjects } from '../../../src/shared/diff-engine'
import type { Project } from '../../../src/shared/types'

function makeProject(nodes: Project['nodes']): Project {
  return {
    version: 2,
    id: 'project-id',
    name: 'Test Project',
    created: '2026-01-01T00:00:00.000Z',
    modified: '2026-01-01T00:00:00.000Z',
    nodes,
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
})
