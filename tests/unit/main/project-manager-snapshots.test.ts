import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
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

  it('reverts a previous snapshot onto disk and into current project state', async () => {
    const rootId = manager.getCurrent()!.nodes.find((node) => node.parentId === null)!.id
    manager.nodeCreate(rootId, 'Rack A')
    await manager.snapshotCreate('baseline')

    const rack = manager.getCurrent()!.nodes.find((node) => node.name === 'Rack A')!
    manager.nodeUpdate(rack.id, { name: 'Rack Alpha', properties: { serial: 'SN-42' } })

    const reverted = await manager.snapshotRevert({ name: 'baseline' })
    expect(reverted.ok).toBe(true)
    if (!reverted.ok) return
    expect(reverted.data.event.type).toBe('revert')
    expect(reverted.data.event.targetSnapshotId).toBe('baseline')
    expect(reverted.data.safetyRecoveryPoint).not.toBeNull()
    expect(existsSync(join(projectDir, reverted.data.safetyRecoveryPoint!.manifestPath))).toBe(true)
    const timeline = await manager.snapshotTimeline()
    expect(timeline.ok).toBe(true)
    if (!timeline.ok) return
    expect(timeline.data.events.some((event) => event.id === reverted.data.event.id)).toBe(true)
    expect(timeline.data.recoveryPoints.some((point) => point.id === reverted.data.safetyRecoveryPoint!.id)).toBe(true)

    expect(manager.getCurrent()!.nodes.some((node) => node.name === 'Rack A')).toBe(true)
    expect(manager.getCurrent()!.nodes.some((node) => node.name === 'Rack Alpha')).toBe(false)

    const recovered = await manager.recoveryPointApply({ id: reverted.data.safetyRecoveryPoint!.id })
    expect(recovered.ok).toBe(true)
    if (!recovered.ok) return
    expect(recovered.data.event.type).toBe('recover')
    expect(recovered.data.event.recoveryPointId).toBe(reverted.data.safetyRecoveryPoint!.id)

    const current = manager.getCurrent()!
    expect(current.nodes.some((node) => node.name === 'Rack Alpha')).toBe(true)

    const manifest = JSON.parse(readFileSync(join(projectDir, 'manifest.json'), 'utf8'))
    expect(manifest.nodes.some((node: { name: string }) => node.name === 'Rack Alpha')).toBe(true)
  })

  it('requires a note when reverting past later snapshots and records lineage on the next snapshot', async () => {
    const rootId = manager.getCurrent()!.nodes.find((node) => node.parentId === null)!.id
    manager.nodeCreate(rootId, 'Rack A')
    const baseline = await manager.snapshotCreate('baseline')
    expect(baseline.ok).toBe(true)

    const rack = manager.getCurrent()!.nodes.find((node) => node.name === 'Rack A')!
    manager.nodeUpdate(rack.id, { name: 'Rack Alpha' })
    const upgraded = await manager.snapshotCreate('upgraded')
    expect(upgraded.ok).toBe(true)

    const missingNote = await manager.snapshotRevert({ name: 'baseline' })
    expect(missingNote.ok).toBe(false)
    if (!missingNote.ok) {
      expect(missingNote.error.code).toBe('VALIDATION_FAILED')
    }

    const reverted = await manager.snapshotRevert({
      name: 'baseline',
      note: 'Rolled back from upgraded to retry failed test',
    })
    expect(reverted.ok).toBe(true)
    if (!reverted.ok) return
    expect(reverted.data.event.note).toBe('Rolled back from upgraded to retry failed test')
    expect(reverted.data.safetyRecoveryPoint).toBeNull()

    const currentRack = manager.getCurrent()!.nodes.find((node) => node.name === 'Rack A')!
    manager.nodeUpdate(currentRack.id, { properties: { firmware: '2.0.1-alt' } })
    const alternate = await manager.snapshotCreate('alternate')
    expect(alternate.ok).toBe(true)
    if (!alternate.ok) return
    expect(alternate.data.basedOnSnapshotId).toBe('baseline')
    expect(alternate.data.createdAfterRevertEventId).toBe(reverted.data.event.id)

    const listed = await manager.snapshotList()
    expect(listed.ok).toBe(true)
    if (!listed.ok) return
    const alternateListed = listed.data.find((snapshot) => snapshot.name === 'alternate')
    expect(alternateListed?.basedOnSnapshotId).toBe('baseline')
    expect(alternateListed?.createdAfterRevertEventId).toBe(reverted.data.event.id)

    const timeline = await manager.snapshotTimeline()
    expect(timeline.ok).toBe(true)
    if (!timeline.ok) return
    expect(timeline.data.events.map((event) => event.type)).toEqual([
      'snapshot',
      'snapshot',
      'revert',
      'snapshot',
    ])
    expect(timeline.data.events.find((event) => event.type === 'revert')?.note)
      .toBe('Rolled back from upgraded to retry failed test')
  })

  it('caps stored recovery points at MAX_RECOVERY_POINTS and deletes the oldest files', async () => {
    const rootId = manager.getCurrent()!.nodes.find((node) => node.parentId === null)!.id
    const baseline = await manager.snapshotCreate('baseline')
    expect(baseline.ok).toBe(true)

    // 12 revert cycles, each preceded by an unsnapshotted edit so a recovery
    // point is created. With MAX_RECOVERY_POINTS = 10, the two oldest must be
    // pruned from history.json AND deleted from disk.
    const recoveryFiles: string[] = []
    for (let i = 0; i < 12; i++) {
      const created = manager.nodeCreate(rootId, `Probe ${i}`)
      expect(created.ok).toBe(true)
      const reverted = await manager.snapshotRevert({ name: 'baseline' })
      expect(reverted.ok).toBe(true)
      if (!reverted.ok) return
      expect(reverted.data.safetyRecoveryPoint).not.toBeNull()
      recoveryFiles.push(reverted.data.safetyRecoveryPoint!.manifestPath)
    }

    const timeline = await manager.snapshotTimeline()
    expect(timeline.ok).toBe(true)
    if (!timeline.ok) return
    expect(timeline.data.recoveryPoints.length).toBe(10)

    // The two oldest recovery files should have been deleted; the newest 10 remain.
    expect(existsSync(join(projectDir, recoveryFiles[0]))).toBe(false)
    expect(existsSync(join(projectDir, recoveryFiles[1]))).toBe(false)
    for (let i = 2; i < 12; i++) {
      expect(existsSync(join(projectDir, recoveryFiles[i]))).toBe(true)
    }
  })

  it('reads malformed and newer-version history files by starting fresh', async () => {
    const rootId = manager.getCurrent()!.nodes.find((node) => node.parentId === null)!.id
    manager.nodeCreate(rootId, 'Rack')
    await manager.snapshotCreate('baseline')

    const historyPath = join(projectDir, '.manifest', 'history.json')

    // Malformed JSON — read should fall back to empty history; timeline still
    // works (synthesized from git tags).
    writeFileSync(historyPath, '{not valid json', 'utf8')
    const malformed = await manager.snapshotTimeline()
    expect(malformed.ok).toBe(true)
    if (!malformed.ok) return
    expect(malformed.data.events.length).toBe(1)
    expect(malformed.data.events[0].snapshotId).toBe('baseline')

    // Newer-than-known version — refuse silently and start fresh.
    writeFileSync(historyPath, JSON.stringify({ version: 999, events: [], recoveryPoints: [] }), 'utf8')
    const newer = await manager.snapshotTimeline()
    expect(newer.ok).toBe(true)
    if (!newer.ok) return
    expect(newer.data.events.length).toBe(1)
    expect(newer.data.recoveryPoints).toEqual([])
  })
})
