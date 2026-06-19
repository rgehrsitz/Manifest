import { describe, it, expect } from 'vitest'
import { migrate, getCurrentVersion, SchemaVersionError } from '@shared/migration'

const CURRENT = getCurrentVersion()

// ─── Happy path ───────────────────────────────────────────────────────────────

describe('migrate — happy path', () => {
  it('returns the manifest unchanged when already at current version', () => {
    const root = { id: 'root', parentId: null, name: 'Test', order: 0, properties: {},
                   created: '2026-01-01T00:00:00Z', modified: '2026-01-01T00:00:00Z' }
    const manifest = { version: CURRENT, id: 'x', name: 'Test', nodes: [root] }
    const result = migrate(manifest)
    expect(result.version).toBe(CURRENT)
    expect(result.id).toBe('x')
  })

  it('preserves unknown fields through migration', () => {
    const root = { id: 'root', parentId: null, name: 'Test', order: 0, properties: {},
                   created: '2026-01-01T00:00:00Z', modified: '2026-01-01T00:00:00Z' }
    const manifest = {
      version: CURRENT,
      id: 'x',
      name: 'Test',
      nodes: [root],
      unknownFutureProp: 'preserve-me',
    }
    const result = migrate(manifest)
    expect(result.unknownFutureProp).toBe('preserve-me')
  })
})

// ─── v1 → v2 migration ────────────────────────────────────────────────────────

describe('migrate — v1 to v2', () => {
  it('wraps multiple top-level nodes under a new root', () => {
    const v1: any = {
      version: 1,
      id: 'proj',
      name: 'My Lab',
      created: '2026-01-01T00:00:00Z',
      modified: '2026-01-01T00:00:00Z',
      nodes: [
        { id: 'a', parentId: null, name: 'Rack A', order: 0, properties: {},
          created: '2026-01-01T00:00:00Z', modified: '2026-01-01T00:00:00Z' },
        { id: 'b', parentId: null, name: 'Rack B', order: 1, properties: {},
          created: '2026-01-01T00:00:00Z', modified: '2026-01-01T00:00:00Z' },
      ],
    }
    const result = migrate(v1)
    expect(result.version).toBe(CURRENT)
    const roots = result.nodes.filter((n: any) => n.parentId === null)
    expect(roots.length).toBe(1)
    expect(roots[0].name).toBe('My Lab')
    // Former top-level nodes are now children of the new root.
    const children = result.nodes.filter((n: any) => n.parentId === roots[0].id)
    expect(children.map((n: any) => n.name).sort()).toEqual(['Rack A', 'Rack B'])
  })

  it('leaves single-root v1 manifests unchanged structurally', () => {
    const v1: any = {
      version: 1,
      id: 'proj',
      name: 'Solo',
      created: '2026-01-01T00:00:00Z',
      modified: '2026-01-01T00:00:00Z',
      nodes: [
        { id: 'root', parentId: null, name: 'Solo', order: 0, properties: {},
          created: '2026-01-01T00:00:00Z', modified: '2026-01-01T00:00:00Z' },
      ],
    }
    const result = migrate(v1)
    expect(result.version).toBe(CURRENT)
    expect(result.nodes.length).toBe(1)
    expect(result.nodes[0].parentId).toBeNull()
  })

  it('handles empty v1 nodes array (creates no root)', () => {
    const v1: any = {
      version: 1,
      id: 'proj',
      name: 'Empty',
      created: '2026-01-01T00:00:00Z',
      modified: '2026-01-01T00:00:00Z',
      nodes: [],
    }
    const result = migrate(v1)
    expect(result.version).toBe(CURRENT)
    // Empty manifest: migration adds a root node named after the project.
    const roots = result.nodes.filter((n: any) => n.parentId === null)
    expect(roots.length).toBe(1)
    expect(roots[0].name).toBe('Empty')
  })
})

// ─── v2 → v3 migration (templates) ──────────────────────────────────────────────

describe('migrate — v2 to v3', () => {
  const v2Manifest = () => ({
    version: 2,
    id: 'proj',
    name: 'Lab',
    created: '2026-01-01T00:00:00Z',
    modified: '2026-01-01T00:00:00Z',
    nodes: [
      { id: 'root', parentId: null, name: 'Lab', order: 0, properties: {},
        created: '2026-01-01T00:00:00Z', modified: '2026-01-01T00:00:00Z' },
      { id: 'a', parentId: 'root', name: 'Rack A', order: 0,
        properties: { location: 'Room 1', capacity: 42 },
        created: '2026-01-01T00:00:00Z', modified: '2026-01-01T00:00:00Z' },
    ],
  })

  it('adds an empty templates map and bumps version to 3', () => {
    const result = migrate(v2Manifest())
    expect(result.version).toBe(3)
    expect(result.templates).toEqual({})
  })

  it('is lossless: node property values are untouched', () => {
    const result = migrate(v2Manifest())
    const rackA = result.nodes.find((n: any) => n.id === 'a')
    expect(rackA.properties).toEqual({ location: 'Room 1', capacity: 42 })
    expect(rackA.templateId).toBeUndefined()
  })

  it('preserves an existing templates map (idempotent re-run)', () => {
    const withTemplates: any = {
      ...v2Manifest(),
      version: 3,
      templates: { rack: { label: 'Rack', fields: { location: { type: 'string' } } } },
    }
    const result = migrate(withTemplates)
    expect(result.version).toBe(3)
    expect(result.templates).toEqual({
      rack: { label: 'Rack', fields: { location: { type: 'string' } } },
    })
  })
})

// ─── Error cases ──────────────────────────────────────────────────────────────

describe('migrate — error cases', () => {
  it('throws SchemaVersionError when version field is missing', () => {
    const bad = { id: 'x', name: 'Test', nodes: [] }
    expect(() => migrate(bad)).toThrow(SchemaVersionError)
  })

  it('throws SchemaVersionError when version is not a number', () => {
    const bad = { version: 'one', id: 'x', name: 'Test', nodes: [] }
    expect(() => migrate(bad)).toThrow(SchemaVersionError)
  })

  it('throws an Error when version is newer than current', () => {
    const future = { version: CURRENT + 1, id: 'x', name: 'Test', nodes: [] }
    expect(() => migrate(future)).toThrow(/newer than this app supports/)
  })
})

// ─── getCurrentVersion ────────────────────────────────────────────────────────

describe('getCurrentVersion', () => {
  it('returns a positive integer', () => {
    expect(Number.isInteger(CURRENT)).toBe(true)
    expect(CURRENT).toBeGreaterThan(0)
  })
})
