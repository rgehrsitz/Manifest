import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, rmSync } from 'fs'
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

let tmpDir: string
let manager: ProjectManager

beforeEach(async () => {
  tmpDir = join(tmpdir(), `manifest-nh-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(tmpDir, { recursive: true })
  const git = new GitService(noopLogger as any)
  manager = new ProjectManager(git, noopLogger as any)
  const created = await manager.createProject('NodeHistory Project', tmpDir)
  expect(created.ok).toBe(true)
  if (!created.ok) throw new Error(created.error.message)
})

afterEach(async () => {
  manager.cancelAutosave()
  await manager.flushAndClose()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('nodeHistory IPC', () => {
  it('returns empty entries for a node that has never been snapshotted', async () => {
    const rootId = manager.getCurrent()!.nodes.find(n => n.parentId === null)!.id
    manager.nodeCreate(rootId, 'Live Only')
    const live = manager.getCurrent()!.nodes.find(n => n.name === 'Live Only')!

    const result = await manager.nodeHistory(live.id)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.entries).toEqual([])
  })

  it('emits one entry per state change across snapshots, skipping unchanged snapshots', async () => {
    const rootId = manager.getCurrent()!.nodes.find(n => n.parentId === null)!.id
    manager.nodeCreate(rootId, 'Server')
    const server = manager.getCurrent()!.nodes.find(n => n.name === 'Server')!

    await manager.snapshotCreate('s1')
    // s2: unchanged — should NOT appear in history
    await manager.snapshotCreate('s2')
    // s3: rename — should appear
    manager.nodeUpdate(server.id, { name: 'Server Alpha' })
    await manager.snapshotCreate('s3')

    const result = await manager.nodeHistory(server.id)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.data.entries.map(e => [e.type, e.snapshotName, e.nodeName])).toEqual([
      ['snapshot', 's1', 'Server'],
      ['snapshot', 's3', 'Server Alpha'],
    ])
  })

  it('records deletion as a presence=absent entry', async () => {
    const rootId = manager.getCurrent()!.nodes.find(n => n.parentId === null)!.id
    manager.nodeCreate(rootId, 'Doomed')
    const doomed = manager.getCurrent()!.nodes.find(n => n.name === 'Doomed')!
    await manager.snapshotCreate('alive')
    manager.nodeDelete(doomed.id)
    await manager.snapshotCreate('gone')

    const result = await manager.nodeHistory(doomed.id)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.data.entries.map(e => [e.type, e.snapshotName, e.presence])).toEqual([
      ['snapshot', 'alive', 'present'],
      ['snapshot', 'gone', 'absent'],
    ])
  })

  it('synthesizes a revert entry when revert restores a previously-deleted node', async () => {
    const rootId = manager.getCurrent()!.nodes.find(n => n.parentId === null)!.id
    manager.nodeCreate(rootId, 'Phoenix')
    const phoenix = manager.getCurrent()!.nodes.find(n => n.name === 'Phoenix')!
    await manager.snapshotCreate('with-phoenix')

    manager.nodeDelete(phoenix.id)
    await manager.snapshotCreate('without-phoenix')

    const reverted = await manager.snapshotRevert({
      name: 'with-phoenix',
      note: 'Bring it back',
    })
    expect(reverted.ok).toBe(true)

    const result = await manager.nodeHistory(phoenix.id)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    // present (with-phoenix) → absent (without-phoenix) → present (revert restores)
    expect(result.data.entries.map(e => ({ type: e.type, presence: e.presence, name: e.snapshotName }))).toEqual([
      { type: 'snapshot', presence: 'present', name: 'with-phoenix' },
      { type: 'snapshot', presence: 'absent', name: 'without-phoenix' },
      { type: 'revert', presence: 'present', name: null },
    ])

    const revertEntry = result.data.entries.find(e => e.type === 'revert')!
    expect(revertEntry.revertTargetSnapshotId).toBe('with-phoenix')
    expect(revertEntry.note).toBe('Bring it back')
  })

  it('does not synthesize a revert entry when the revert leaves the node unchanged', async () => {
    const rootId = manager.getCurrent()!.nodes.find(n => n.parentId === null)!.id
    manager.nodeCreate(rootId, 'StableA')
    manager.nodeCreate(rootId, 'StableB')
    const stableA = manager.getCurrent()!.nodes.find(n => n.name === 'StableA')!
    await manager.snapshotCreate('s1')

    // Modify only StableB; StableA stays put.
    const stableB = manager.getCurrent()!.nodes.find(n => n.name === 'StableB')!
    manager.nodeUpdate(stableB.id, { name: 'StableB Renamed' })
    await manager.snapshotCreate('s2')

    // Revert to s1: both StableA and StableB return to s1 state.
    // For StableA, nothing changed across the revert — no entry should appear.
    await manager.snapshotRevert({ name: 's1', note: 'rollback' })

    const result = await manager.nodeHistory(stableA.id)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    // Only the s1 entry. The s2 snapshot didn't change StableA (so no row).
    // The revert didn't change StableA's state (so no synthetic entry).
    expect(result.data.entries.map(e => [e.type, e.snapshotName])).toEqual([
      ['snapshot', 's1'],
    ])
  })

  it('synthesizes a recover entry when applying a recovery point changes the node', async () => {
    const rootId = manager.getCurrent()!.nodes.find(n => n.parentId === null)!.id
    manager.nodeCreate(rootId, 'TempProbe')
    await manager.snapshotCreate('baseline')

    // Add an unsnapshotted edit so the next revert creates a safety recovery point.
    manager.nodeCreate(rootId, 'Lost Work')
    const lostWork = manager.getCurrent()!.nodes.find(n => n.name === 'Lost Work')!

    const reverted = await manager.snapshotRevert({ name: 'baseline' })
    expect(reverted.ok).toBe(true)
    if (!reverted.ok) return
    expect(reverted.data.safetyRecoveryPoint).not.toBeNull()
    const recoveryPointId = reverted.data.safetyRecoveryPoint!.id

    // After revert, Lost Work is gone. nodeHistory for it shows nothing yet
    // (it was never snapshotted).
    const beforeRecover = await manager.nodeHistory(lostWork.id)
    expect(beforeRecover.ok).toBe(true)
    if (!beforeRecover.ok) return
    expect(beforeRecover.data.entries).toEqual([])

    // Apply the recovery point — Lost Work comes back.
    const recoveryResult = await manager.recoveryPointApply({ id: recoveryPointId })
    expect(recoveryResult.ok).toBe(true)

    const afterRecover = await manager.nodeHistory(lostWork.id)
    expect(afterRecover.ok).toBe(true)
    if (!afterRecover.ok) return

    expect(afterRecover.data.entries.map(e => ({ type: e.type, presence: e.presence }))).toEqual([
      { type: 'recover', presence: 'present' },
    ])
    expect(afterRecover.data.entries[0].recoveryPointId).toBe(recoveryPointId)
  })

  it('returns chronologically ordered entries via the order field', async () => {
    const rootId = manager.getCurrent()!.nodes.find(n => n.parentId === null)!.id
    manager.nodeCreate(rootId, 'Sequenced')
    const sequenced = manager.getCurrent()!.nodes.find(n => n.name === 'Sequenced')!
    await manager.snapshotCreate('a')
    manager.nodeUpdate(sequenced.id, { properties: { v: 1 } })
    await manager.snapshotCreate('b')
    manager.nodeUpdate(sequenced.id, { properties: { v: 2 } })
    await manager.snapshotCreate('c')

    const result = await manager.nodeHistory(sequenced.id)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.data.entries.map(e => e.order)).toEqual([0, 1, 2])
    expect(result.data.entries.map(e => e.snapshotName)).toEqual(['a', 'b', 'c'])
  })
})
