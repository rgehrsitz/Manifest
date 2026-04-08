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
    expect(result.version).toBe(2)
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
    expect(result.version).toBe(2)
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
    expect(result.version).toBe(2)
    // Empty manifest: migration adds a root node named after the project.
    const roots = result.nodes.filter((n: any) => n.parentId === null)
    expect(roots.length).toBe(1)
    expect(roots[0].name).toBe('Empty')
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
