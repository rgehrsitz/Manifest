import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { ProjectManager } from '../../../src/main/project-manager'

const noopLogger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
}

const noopGit = {
  checkVersion: async () => ({ available: true, version: '2.50.0', meetsMinimum: true, minimumVersion: '2.25' }),
  initRepo: async () => {},
  initialCommit: async () => {},
  run: async () => ({ stdout: '', stderr: '' }),
}

let tmpDir: string
let manager: ProjectManager

beforeEach(async () => {
  tmpDir = join(tmpdir(), `manifest-close-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(tmpDir, { recursive: true })
  manager = new ProjectManager(noopGit as any, noopLogger as any)

  const created = await manager.createProject('Close Safety', tmpDir)
  expect(created.ok).toBe(true)
})

afterEach(() => {
  manager.cancelAutosave()
  manager.discardCurrentProject()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('ProjectManager close semantics', () => {
  it('keeps the project open when flushAndClose cannot save', async () => {
    const current = manager.getCurrent()
    expect(current).not.toBeNull()
    if (!current) return

    current.path = join(tmpDir, 'missing-parent', 'Close Safety')

    const result = await manager.flushAndClose()

    expect(result.ok).toBe(false)
    expect(manager.getCurrent()).not.toBeNull()
    expect(manager.getCurrent()?.path).toBe(current.path)
  })

  it('clears the project when the caller explicitly discards after failure', async () => {
    const current = manager.getCurrent()
    expect(current).not.toBeNull()
    if (!current) return

    current.path = join(tmpDir, 'missing-parent', 'Close Safety')
    const result = await manager.flushAndClose()
    expect(result.ok).toBe(false)

    manager.discardCurrentProject()

    expect(manager.getCurrent()).toBeNull()
  })
})
