import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { ProjectManager } from '../../../src/main/project-manager'
import { GitService } from '../../../src/main/git-service'

const noopLogger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
}

// No-op search stub — better-sqlite3 is not available in Bun's test runner.
const noopSearch = {
  rebuild:     () => {},
  close:       () => {},
  upsertNode:  () => {},
  deleteNodes: () => {},
  query:       () => [],
}

let tmpDir: string
let git: GitService
let manager: ProjectManager
let projectDir: string

beforeEach(async () => {
  tmpDir = join(tmpdir(), `manifest-snapshots-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(tmpDir, { recursive: true })

  git = new GitService(noopLogger as any)
  manager = new ProjectManager(git, noopLogger as any, noopSearch as any)

  const created = await manager.createProject('Snapshot Project', tmpDir)
  expect(created.ok).toBe(true)
  if (!created.ok) throw new Error(created.error.message)

  projectDir = created.data.path!
})

afterEach(async () => {
  manager.cancelAutosave()
  await manager.flushAndClose()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('snapshot workflow', () => {
  it('creates and lists named snapshots in the git-backed project', async () => {
    manager.nodeCreate(manager.getCurrent()!.nodes[0].id, 'Rack A')
    const created = await manager.snapshotCreate('initial-setup')
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.data.name).toBe('initial-setup')

    const listed = await manager.snapshotList()
    expect(listed.ok).toBe(true)
    if (!listed.ok) return
    expect(listed.data.some((snapshot) => snapshot.name === 'initial-setup')).toBe(true)
    expect(listed.data.find((snapshot) => snapshot.name === 'initial-setup')?.message).toBe('initial-setup')
  })

  it('rejects duplicate snapshot names', async () => {
    const first = await manager.snapshotCreate('duplicate-name')
    expect(first.ok).toBe(true)

    const second = await manager.snapshotCreate('duplicate-name')
    expect(second.ok).toBe(false)
    if (second.ok) return
    expect(second.error.code).toBe('VALIDATION_FAILED')
  })

  it('compares two snapshots with semantic diffs', async () => {
    const rootId = manager.getCurrent()!.nodes.find((node) => node.parentId === null)!.id
    manager.nodeCreate(rootId, 'Rack A')
    const rackA = manager.getCurrent()!.nodes.find((node) => node.name === 'Rack A')!
    await manager.snapshotCreate('before-changes')

    manager.nodeUpdate(rackA.id, { name: 'Rack Alpha', properties: { serial: 'SN-100' } })
    const rootChildren = manager.getCurrent()!.nodes.filter((node) => node.parentId === rootId)
    const renamedRack = rootChildren.find((node) => node.id === rackA.id)!
    manager.nodeCreate(rootId, 'Rack B')
    const rackB = manager.getCurrent()!.nodes.find((node) => node.name === 'Rack B')!
    manager.nodeMove(renamedRack.id, rackB.id, 999)
    await manager.snapshotCreate('after-changes')

    const compared = await manager.snapshotCompare('before-changes', 'after-changes')
    expect(compared.ok).toBe(true)
    if (!compared.ok) return
    expect(compared.data.map((diff) => diff.changeType)).toEqual([
      'added',
      'moved',
      'renamed',
      'property-changed',
    ])
  })

  it('reports snapshot read failures distinctly from commit failures', async () => {
    const rootId = manager.getCurrent()!.nodes.find((node) => node.parentId === null)!.id
    manager.nodeCreate(rootId, 'Rack A')
    await manager.snapshotCreate('baseline')

    const originalRead = git.readSnapshotManifest.bind(git)
    ;(git as any).readSnapshotManifest = async () => {
      throw new Error('snapshot tag not found')
    }

    try {
      const compared = await manager.snapshotCompare('baseline', 'missing')
      expect(compared.ok).toBe(false)
      if (!compared.ok) {
        expect(compared.error.code).toBe('SNAPSHOT_READ_FAILED')
        expect(compared.error.message).toContain('Failed to compare snapshots')
      }

      const loaded = await manager.snapshotLoadCompare('baseline', 'missing')
      expect(loaded.ok).toBe(false)
      if (!loaded.ok) {
        expect(loaded.error.code).toBe('SNAPSHOT_READ_FAILED')
        expect(loaded.error.message).toContain('Failed to load compare')
      }
    } finally {
      ;(git as any).readSnapshotManifest = originalRead
    }
  })

  it('restores a previous snapshot onto disk and into current project state', async () => {
    const rootId = manager.getCurrent()!.nodes.find((node) => node.parentId === null)!.id
    manager.nodeCreate(rootId, 'Rack A')
    await manager.snapshotCreate('baseline')

    const rack = manager.getCurrent()!.nodes.find((node) => node.name === 'Rack A')!
    manager.nodeUpdate(rack.id, { name: 'Rack Alpha', properties: { serial: 'SN-42' } })

    const restored = await manager.snapshotRestore('baseline')
    expect(restored.ok).toBe(true)

    const current = manager.getCurrent()!
    expect(current.nodes.some((node) => node.name === 'Rack A')).toBe(true)
    expect(current.nodes.some((node) => node.name === 'Rack Alpha')).toBe(false)

    const manifest = JSON.parse(readFileSync(join(projectDir, 'manifest.json'), 'utf8'))
    expect(manifest.nodes.some((node: { name: string }) => node.name === 'Rack A')).toBe(true)
    expect(manifest.nodes.some((node: { name: string }) => node.name === 'Rack Alpha')).toBe(false)
  })
})
