// Unit tests for Phase 2 node CRUD operations in ProjectManager.
// Uses real filesystem via tmp directories, never mocks.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { ProjectManager } from '../../../src/main/project-manager'
import type { Project } from '../../../src/shared/types'

// Minimal logger stub — writes nothing, throws nothing.
const noopLogger = {
  error: () => {},
  warn:  () => {},
  info:  () => {},
  debug: () => {},
}

// Minimal git stub — we don't test git in this suite.
const noopGit = {
  checkVersion: async () => ({ available: true, version: '2.50.0', meetsMinimum: true, minimumVersion: '2.25' }),
  initRepo:     async () => {},
  initialCommit: async () => {},
  run: async () => ({ stdout: '', stderr: '' }),
}

function makeManager(): ProjectManager {
  return new ProjectManager(noopGit as any, noopLogger as any)
}

let tmpDir: string
let manager: ProjectManager
let project: Project

// ─── Helpers ──────────────────────────────────────────────────────────────────

function writeFixture(dir: string, data: object) {
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(data, null, 2), 'utf8')
}

// Build a minimal v2 manifest with a single root node.
function makeManifest(overrides: Partial<object> = {}) {
  return {
    version: 2,
    id: 'test-project-id',
    name: 'Test Project',
    created: '2026-01-01T00:00:00.000Z',
    modified: '2026-01-01T00:00:00.000Z',
    nodes: [
      {
        id: 'root-id',
        parentId: null,
        name: 'Test Project',
        order: 0,
        properties: {},
        created: '2026-01-01T00:00:00.000Z',
        modified: '2026-01-01T00:00:00.000Z',
      },
    ],
    ...overrides,
  }
}

beforeEach(async () => {
  tmpDir = join(tmpdir(), `manifest-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(tmpDir, { recursive: true })
  writeFixture(tmpDir, makeManifest())

  manager = makeManager()
  const result = await manager.openProject(tmpDir)
  expect(result.ok).toBe(true)
  project = (result as any).data
})

afterEach(() => {
  manager.cancelAutosave()
  rmSync(tmpDir, { recursive: true, force: true })
})

// ─── nodeCreate ───────────────────────────────────────────────────────────────

describe('nodeCreate', () => {
  it('creates a child under the root', () => {
    const result = manager.nodeCreate('root-id', 'Server 1')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const newNode = result.data.nodes.find(n => n.name === 'Server 1')
    expect(newNode).toBeDefined()
    expect(newNode!.parentId).toBe('root-id')
    expect(newNode!.order).toBe(0)
  })

  it('assigns sequential order to siblings', () => {
    manager.nodeCreate('root-id', 'Alpha')
    const result = manager.nodeCreate('root-id', 'Beta')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const beta = result.data.nodes.find(n => n.name === 'Beta')
    expect(beta!.order).toBe(1)
  })

  it('rejects empty name', () => {
    const result = manager.nodeCreate('root-id', '')
    expect(result.ok).toBe(false)
    expect((result as any).error.code).toBe('VALIDATION_FAILED')
  })

  it('rejects name with slash', () => {
    const result = manager.nodeCreate('root-id', 'bad/name')
    expect(result.ok).toBe(false)
  })

  it('rejects duplicate sibling name (case-insensitive)', () => {
    manager.nodeCreate('root-id', 'Server 1')
    const result = manager.nodeCreate('root-id', 'server 1')
    expect(result.ok).toBe(false)
    expect((result as any).error.code).toBe('VALIDATION_FAILED')
  })

  it('rejects non-existent parent', () => {
    const result = manager.nodeCreate('no-such-parent', 'Orphan')
    expect(result.ok).toBe(false)
    expect((result as any).error.code).toBe('INVALID_HIERARCHY')
  })

  it('returns the full updated project', () => {
    const result = manager.nodeCreate('root-id', 'New Node')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // Root + new node
    expect(result.data.nodes.length).toBe(2)
  })
})

// ─── nodeUpdate ───────────────────────────────────────────────────────────────

describe('nodeUpdate', () => {
  beforeEach(() => {
    manager.nodeCreate('root-id', 'Server 1')
  })

  it('renames a node', () => {
    const node = manager.getCurrent()!.nodes.find(n => n.name === 'Server 1')!
    const result = manager.nodeUpdate(node.id, { name: 'Server Renamed' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.nodes.find(n => n.id === node.id)!.name).toBe('Server Renamed')
  })

  it('rejects rename to existing sibling name', () => {
    manager.nodeCreate('root-id', 'Server 2')
    const node = manager.getCurrent()!.nodes.find(n => n.name === 'Server 1')!
    const result = manager.nodeUpdate(node.id, { name: 'server 2' })
    expect(result.ok).toBe(false)
    expect((result as any).error.code).toBe('VALIDATION_FAILED')
  })

  it('allows renaming root node', () => {
    const result = manager.nodeUpdate('root-id', { name: 'New Root Name' })
    expect(result.ok).toBe(true)
  })

  it('adds a property', () => {
    const node = manager.getCurrent()!.nodes.find(n => n.name === 'Server 1')!
    const result = manager.nodeUpdate(node.id, { properties: { serial: 'SN-001' } })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.nodes.find(n => n.id === node.id)!.properties['serial']).toBe('SN-001')
  })

  it('rejects invalid property key', () => {
    const node = manager.getCurrent()!.nodes.find(n => n.name === 'Server 1')!
    const result = manager.nodeUpdate(node.id, { properties: { 'bad key!': 'value' } })
    expect(result.ok).toBe(false)
    expect((result as any).error.code).toBe('VALIDATION_FAILED')
  })

  it('rejects property value over 10,000 chars', () => {
    const node = manager.getCurrent()!.nodes.find(n => n.name === 'Server 1')!
    const result = manager.nodeUpdate(node.id, { properties: { notes: 'x'.repeat(10001) } })
    expect(result.ok).toBe(false)
  })

  it('returns error for non-existent node', () => {
    const result = manager.nodeUpdate('ghost-id', { name: 'Ghost' })
    expect(result.ok).toBe(false)
  })
})

// ─── nodeDelete ───────────────────────────────────────────────────────────────

describe('nodeDelete', () => {
  it('deletes a leaf node', () => {
    manager.nodeCreate('root-id', 'Leaf')
    const leaf = manager.getCurrent()!.nodes.find(n => n.name === 'Leaf')!
    const result = manager.nodeDelete(leaf.id)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.nodes.find(n => n.id === leaf.id)).toBeUndefined()
  })

  it('cascades: deletes node and all descendants', () => {
    manager.nodeCreate('root-id', 'Parent')
    const parent = manager.getCurrent()!.nodes.find(n => n.name === 'Parent')!
    manager.nodeCreate(parent.id, 'Child A')
    manager.nodeCreate(parent.id, 'Child B')
    const childA = manager.getCurrent()!.nodes.find(n => n.name === 'Child A')!
    manager.nodeCreate(childA.id, 'Grandchild')

    const result = manager.nodeDelete(parent.id)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // Only root survives.
    expect(result.data.nodes.length).toBe(1)
    expect(result.data.nodes[0].id).toBe('root-id')
  })

  it('rejects deleting root node', () => {
    const result = manager.nodeDelete('root-id')
    expect(result.ok).toBe(false)
    expect((result as any).error.code).toBe('INVALID_HIERARCHY')
  })

  it('rejects deleting non-existent node', () => {
    const result = manager.nodeDelete('ghost-id')
    expect(result.ok).toBe(false)
  })

  it('renumbers siblings after deletion', () => {
    manager.nodeCreate('root-id', 'A')
    manager.nodeCreate('root-id', 'B')
    manager.nodeCreate('root-id', 'C')
    const b = manager.getCurrent()!.nodes.find(n => n.name === 'B')!
    const result = manager.nodeDelete(b.id)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const siblings = result.data.nodes
      .filter(n => n.parentId === 'root-id')
      .sort((a, b) => a.order - b.order)
    expect(siblings.map(n => n.order)).toEqual([0, 1])
    expect(siblings.map(n => n.name)).toEqual(['A', 'C'])
  })
})

// ─── nodeMove (reorder) ───────────────────────────────────────────────────────

describe('nodeMove — reorder', () => {
  beforeEach(() => {
    manager.nodeCreate('root-id', 'A')
    manager.nodeCreate('root-id', 'B')
    manager.nodeCreate('root-id', 'C')
  })

  it('moves a node up within siblings', () => {
    const b = manager.getCurrent()!.nodes.find(n => n.name === 'B')!
    const result = manager.nodeMove(b.id, 'root-id', 0)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const siblings = result.data.nodes
      .filter(n => n.parentId === 'root-id')
      .sort((a, b) => a.order - b.order)
    expect(siblings.map(n => n.name)).toEqual(['B', 'A', 'C'])
  })

  it('moves a node down within siblings', () => {
    const b = manager.getCurrent()!.nodes.find(n => n.name === 'B')!
    const result = manager.nodeMove(b.id, 'root-id', 2)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const siblings = result.data.nodes
      .filter(n => n.parentId === 'root-id')
      .sort((a, b) => a.order - b.order)
    expect(siblings.map(n => n.name)).toEqual(['A', 'C', 'B'])
  })

  it('no-op when already in position', () => {
    const b = manager.getCurrent()!.nodes.find(n => n.name === 'B')!
    const before = manager.getCurrent()!.nodes.map(n => n.order)
    const result = manager.nodeMove(b.id, 'root-id', 1)
    expect(result.ok).toBe(true)
  })
})

// ─── nodeMove (reparent) ──────────────────────────────────────────────────────

describe('nodeMove — reparent', () => {
  it('reparents a node to a different parent', () => {
    manager.nodeCreate('root-id', 'Rack A')
    manager.nodeCreate('root-id', 'Rack B')
    const rackA = manager.getCurrent()!.nodes.find(n => n.name === 'Rack A')!
    const rackB = manager.getCurrent()!.nodes.find(n => n.name === 'Rack B')!
    manager.nodeCreate(rackA.id, 'Server 1')
    const server = manager.getCurrent()!.nodes.find(n => n.name === 'Server 1')!

    const result = manager.nodeMove(server.id, rackB.id, 999)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.nodes.find(n => n.id === server.id)!.parentId).toBe(rackB.id)
  })

  it('rejects moving a node into its own descendant', () => {
    manager.nodeCreate('root-id', 'Parent')
    const parent = manager.getCurrent()!.nodes.find(n => n.name === 'Parent')!
    manager.nodeCreate(parent.id, 'Child')
    const child = manager.getCurrent()!.nodes.find(n => n.name === 'Child')!

    const result = manager.nodeMove(parent.id, child.id, 0)
    expect(result.ok).toBe(false)
    expect((result as any).error.code).toBe('INVALID_HIERARCHY')
  })

  it('rejects moving root node', () => {
    manager.nodeCreate('root-id', 'Other')
    const other = manager.getCurrent()!.nodes.find(n => n.name === 'Other')!
    const result = manager.nodeMove('root-id', other.id, 0)
    expect(result.ok).toBe(false)
    expect((result as any).error.code).toBe('INVALID_HIERARCHY')
  })

  it('rejects move to non-existent parent', () => {
    manager.nodeCreate('root-id', 'Node')
    const node = manager.getCurrent()!.nodes.find(n => n.name === 'Node')!
    const result = manager.nodeMove(node.id, 'ghost-parent', 0)
    expect(result.ok).toBe(false)
    expect((result as any).error.code).toBe('INVALID_HIERARCHY')
  })
})

// ─── searchNodes ──────────────────────────────────────────────────────────────

describe('searchNodes', () => {
  beforeEach(() => {
    manager.nodeCreate('root-id', 'Oscilloscope')
    const osc = manager.getCurrent()!.nodes.find(n => n.name === 'Oscilloscope')!
    manager.nodeUpdate(osc.id, { properties: { serial: 'MSO-4054C', firmware: 'v3.2' } })
    manager.nodeCreate('root-id', 'Power Supply')
  })

  it('matches by node name', () => {
    const result = manager.searchNodes('Oscilloscope')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.some(r => r.nodeName === 'Oscilloscope')).toBe(true)
  })

  it('matches by property value', () => {
    const result = manager.searchNodes('MSO-4054C')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.length).toBeGreaterThan(0)
  })

  it('is case-insensitive', () => {
    const result = manager.searchNodes('oscilloscope')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.some(r => r.nodeName === 'Oscilloscope')).toBe(true)
  })

  it('returns empty array for no match', () => {
    const result = manager.searchNodes('xyzzy-no-match')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data).toEqual([])
  })

  it('returns empty array for empty query', () => {
    const result = manager.searchNodes('')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data).toEqual([])
  })

  it('returns empty array for whitespace-only query', () => {
    const result = manager.searchNodes('   ')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data).toEqual([])
  })
})
