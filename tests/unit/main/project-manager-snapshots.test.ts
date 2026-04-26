import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { ProjectManager } from '../../../src/main/project-manager'
import { GitService } from '../../../src/main/git-service'
import { HistoryIndexService } from '../../../src/main/history-index'
import { SearchIndexService } from '../../../src/main/search-index'

const noopLogger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
}

let tmpDir: string
let git: GitService
let manager: ProjectManager
let projectDir: string

beforeEach(async () => {
  tmpDir = join(tmpdir(), `manifest-snapshots-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(tmpDir, { recursive: true })

  git = new GitService(noopLogger as any)
  manager = new ProjectManager(git, noopLogger as any)

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

describe('per-node history index integration', () => {
  // These tests need direct access to the history index, so they use their own
  // ProjectManager instance instead of the shared `manager` from beforeEach.

  let isolatedTmp: string
  let isolatedManager: ProjectManager
  let isolatedHistory: HistoryIndexService
  let isolatedProjectDir: string

  beforeEach(async () => {
    isolatedTmp = join(tmpdir(), `manifest-history-int-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(isolatedTmp, { recursive: true })

    const igit = new GitService(noopLogger as any)
    isolatedHistory = new HistoryIndexService()
    isolatedManager = new ProjectManager(igit, noopLogger as any, new SearchIndexService(), isolatedHistory)

    const created = await isolatedManager.createProject('History Project', isolatedTmp)
    expect(created.ok).toBe(true)
    if (!created.ok) throw new Error(created.error.message)
    isolatedProjectDir = created.data.path!
  })

  afterEach(async () => {
    isolatedManager.cancelAutosave()
    await isolatedManager.flushAndClose()
    rmSync(isolatedTmp, { recursive: true, force: true })
  })

  it('writes per-node history rows on snapshotCreate', async () => {
    const rootId = isolatedManager.getCurrent()!.nodes.find((n) => n.parentId === null)!.id
    isolatedManager.nodeCreate(rootId, 'Rack A')
    const created = await isolatedManager.snapshotCreate('baseline')
    expect(created.ok).toBe(true)
    if (!created.ok) return

    const rack = isolatedManager.getCurrent()!.nodes.find((n) => n.name === 'Rack A')!
    expect(isolatedHistory.recordedSnapshotIds().has('baseline')).toBe(true)

    const rackHistory = isolatedHistory.nodeHistory(rack.id)
    expect(rackHistory.length).toBe(1)
    expect(rackHistory[0].presence).toBe('present')
    expect(rackHistory[0].nodeName).toBe('Rack A')
  })

  it('delta-encodes across snapshots — only changed nodes get new rows', async () => {
    const rootId = isolatedManager.getCurrent()!.nodes.find((n) => n.parentId === null)!.id
    isolatedManager.nodeCreate(rootId, 'Rack A')
    isolatedManager.nodeCreate(rootId, 'Rack B')
    await isolatedManager.snapshotCreate('s1')

    const rackA = isolatedManager.getCurrent()!.nodes.find((n) => n.name === 'Rack A')!
    isolatedManager.nodeUpdate(rackA.id, { properties: { firmware: '2.0' } })
    await isolatedManager.snapshotCreate('s2')

    // Rack A changed — two rows. Rack B did not — one row.
    expect(isolatedHistory.nodeHistory(rackA.id).length).toBe(2)
    const rackB = isolatedManager.getCurrent()!.nodes.find((n) => n.name === 'Rack B')!
    expect(isolatedHistory.nodeHistory(rackB.id).length).toBe(1)
  })

  it('records deletion as presence=absent', async () => {
    const rootId = isolatedManager.getCurrent()!.nodes.find((n) => n.parentId === null)!.id
    isolatedManager.nodeCreate(rootId, 'Doomed')
    await isolatedManager.snapshotCreate('s1')

    const doomed = isolatedManager.getCurrent()!.nodes.find((n) => n.name === 'Doomed')!
    isolatedManager.nodeDelete(doomed.id)
    await isolatedManager.snapshotCreate('s2')

    const hist = isolatedHistory.nodeHistory(doomed.id)
    expect(hist.map((r) => [r.snapshotId, r.presence])).toEqual([
      ['s1', 'present'],
      ['s2', 'absent'],
    ])
  })

  it('snapshotCreate succeeds even when history.recordSnapshot throws (regression test for D2)', async () => {
    // Build a faulty history service that throws on record. Every other method
    // returns benign defaults so project lifecycle continues normally.
    const faultyHistory = {
      open: () => {},
      close: () => {},
      recordSnapshot: () => { throw new Error('forced history failure') },
      nodeHistory: () => [],
      recordedSnapshotIds: () => new Set<string>(),
      incompleteSnapshotIds: () => [],
    } as unknown as HistoryIndexService

    const tmp = join(tmpdir(), `manifest-history-faulty-${Date.now()}`)
    mkdirSync(tmp, { recursive: true })
    const localGit = new GitService(noopLogger as any)
    const faultyManager = new ProjectManager(localGit, noopLogger as any, new SearchIndexService(), faultyHistory)

    try {
      const created = await faultyManager.createProject('Faulty', tmp)
      expect(created.ok).toBe(true)
      if (!created.ok) return
      const projectDir = created.data.path!

      const rootId = faultyManager.getCurrent()!.nodes.find((n) => n.parentId === null)!.id
      faultyManager.nodeCreate(rootId, 'Will Survive')

      const snap = await faultyManager.snapshotCreate('still-works')
      expect(snap.ok).toBe(true)

      // The git tag is real — listing returns the snapshot.
      const listed = await faultyManager.snapshotList()
      expect(listed.ok).toBe(true)
      if (!listed.ok) return
      expect(listed.data.some((s) => s.name === 'still-works')).toBe(true)
    } finally {
      await faultyManager.flushAndClose()
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('backfill on project open populates history rows for snapshots predating the index', async () => {
    // Create some snapshots, then nuke the history.db to simulate a project
    // that existed before the feature shipped.
    const rootId = isolatedManager.getCurrent()!.nodes.find((n) => n.parentId === null)!.id
    isolatedManager.nodeCreate(rootId, 'A')
    await isolatedManager.snapshotCreate('s1')
    isolatedManager.nodeCreate(rootId, 'B')
    await isolatedManager.snapshotCreate('s2')

    const a = isolatedManager.getCurrent()!.nodes.find((n) => n.name === 'A')!
    expect(isolatedHistory.nodeHistory(a.id).length).toBe(1)

    // Close, wipe history.db, reopen — backfill should run on openProject.
    await isolatedManager.flushAndClose()
    rmSync(join(isolatedProjectDir, '.manifest', 'index', 'history.db'), { force: true })
    rmSync(join(isolatedProjectDir, '.manifest', 'index', 'history.db-shm'), { force: true })
    rmSync(join(isolatedProjectDir, '.manifest', 'index', 'history.db-wal'), { force: true })

    const igit = new GitService(noopLogger as any)
    const refreshedHistory = new HistoryIndexService()
    const refreshedManager = new ProjectManager(igit, noopLogger as any, new SearchIndexService(), refreshedHistory)
    try {
      const reopened = await refreshedManager.openProject(isolatedProjectDir)
      expect(reopened.ok).toBe(true)

      // Backfill is async — wait for it to finish.
      await refreshedManager.waitForHistoryBackfill()

      expect(refreshedHistory.recordedSnapshotIds()).toEqual(new Set(['s1', 's2']))
      expect(refreshedHistory.nodeHistory(a.id).length).toBe(1)
    } finally {
      await refreshedManager.flushAndClose()
    }
  })

  it('backfill resumes from snapshots marked complete=0', async () => {
    const rootId = isolatedManager.getCurrent()!.nodes.find((n) => n.parentId === null)!.id
    isolatedManager.nodeCreate(rootId, 'A')
    await isolatedManager.snapshotCreate('s1')

    // Manually inject a snapshot in `complete=0` state plus a partial row.
    // Simulates a torn write that's been recovered to git but not the index.
    isolatedManager.nodeCreate(rootId, 'B')
    await isolatedManager.snapshotCreate('s2')

    // Now corrupt s2's complete flag.
    const Database = (await import('better-sqlite3')).default
    const dbPath = join(isolatedProjectDir, '.manifest', 'index', 'history.db')
    await isolatedManager.flushAndClose()  // release WAL handle so direct write is safe
    const db = new Database(dbPath)
    try {
      db.prepare(`UPDATE snapshot_index_state SET complete=0 WHERE snapshot_id='s2'`).run()
    } finally {
      db.close()
    }

    const igit = new GitService(noopLogger as any)
    const refreshedHistory = new HistoryIndexService()
    const refreshedManager = new ProjectManager(igit, noopLogger as any, new SearchIndexService(), refreshedHistory)
    try {
      const reopened = await refreshedManager.openProject(isolatedProjectDir)
      expect(reopened.ok).toBe(true)
      await refreshedManager.waitForHistoryBackfill()

      // s2 should now be complete after backfill catches up.
      expect(refreshedHistory.recordedSnapshotIds().has('s2')).toBe(true)
      expect(refreshedHistory.incompleteSnapshotIds()).toEqual([])
    } finally {
      await refreshedManager.flushAndClose()
    }
  })
})

