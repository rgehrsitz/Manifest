import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { ProjectManager } from '../../../src/main/project-manager'

const noopLogger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }
const noopGit = {
  checkVersion: async () => ({ available: true, version: '2.50.0', meetsMinimum: true, minimumVersion: '2.25' }),
  initRepo: async () => {},
  initialCommit: async () => {},
  run: async () => ({ stdout: '', stderr: '' }),
  listSnapshots: async () => [],
}

let tmpRoot: string
let manager: ProjectManager

beforeEach(() => {
  tmpRoot = join(tmpdir(), `manifest-cloud-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(tmpRoot, { recursive: true })
  manager = new ProjectManager(noopGit as any, noopLogger as any)
})

afterEach(async () => {
  manager?.cancelAutosave()
  await manager?.flushAndClose()
  rmSync(tmpRoot, { recursive: true, force: true })
})

function manifest(name = 'Cloud Lab') {
  return {
    version: 3,
    id: 'cloud-project-id',
    name,
    created: '2026-01-01T00:00:00.000Z',
    modified: '2026-01-01T00:00:00.000Z',
    templates: {},
    nodes: [
      {
        id: 'root-id',
        parentId: null,
        name,
        order: 0,
        properties: {},
        created: '2026-01-01T00:00:00.000Z',
        modified: '2026-01-01T00:00:00.000Z',
      },
    ],
  }
}

describe('cloud sync project warnings', () => {
  it('returns a runtime warning when creating a project inside a synced folder', async () => {
    const parent = join(tmpRoot, 'Dropbox')
    const result = await manager.createProject('Cloud Lab', parent)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.projectWarnings).toEqual([
      expect.objectContaining({
        code: 'CLOUD_SYNC_PROJECT',
        provider: 'Dropbox',
        title: 'Project is inside Dropbox',
      }),
    ])

    const persisted = JSON.parse(readFileSync(join(parent, 'Cloud Lab', 'manifest.json'), 'utf8'))
    expect(persisted.projectWarnings).toBeUndefined()
  })

  it('returns a runtime warning when opening a project inside a synced folder', async () => {
    const projectDir = join(tmpRoot, 'OneDrive - Lab', 'Cloud Lab')
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, 'manifest.json'), JSON.stringify(manifest(), null, 2), 'utf8')

    const result = await manager.openProject(projectDir)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.projectWarnings).toEqual([
      expect.objectContaining({
        code: 'CLOUD_SYNC_PROJECT',
        provider: 'OneDrive',
        title: 'Project is inside OneDrive',
      }),
    ])
    expect(manager.getCurrent()?.projectWarnings).toBeUndefined()
  })

  it('does not warn for ordinary local paths', async () => {
    const result = await manager.createProject('Local Lab', tmpRoot)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.projectWarnings).toBeUndefined()
  })
})
