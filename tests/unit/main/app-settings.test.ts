import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  AppSettingsStore,
  resolveRestorableWindowBounds,
  type DesktopWindowState,
} from '../../../src/main/app-settings'
import type { Project } from '../../../src/shared/types'

let tmpDir: string

beforeEach(() => {
  tmpDir = join(tmpdir(), `manifest-app-settings-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(tmpDir, { recursive: true })
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

function storePath(): string {
  return join(tmpDir, 'settings', 'app-settings.json')
}

function project(projectPath: string, name = 'Workspace Lab'): Project {
  return {
    version: 1,
    id: 'project-id',
    name,
    created: '2026-07-01T00:00:00.000Z',
    modified: '2026-07-01T00:00:00.000Z',
    nodes: [],
    path: projectPath,
  }
}

describe('AppSettingsStore', () => {
  it('persists window state and workspace settings', () => {
    const store = new AppSettingsStore(storePath())
    store.updateWindowState({
      bounds: { x: 40, y: 50, width: 1200, height: 900 },
      isMaximized: true,
      isFullScreen: false,
    })
    store.updateWorkspaceSettings({
      treeWidth: 360,
      panelWidth: 420,
      lastOpenDirectory: '/tmp/open',
      lastCreateDirectory: '/tmp/create',
    })

    const reloaded = new AppSettingsStore(storePath())

    expect(reloaded.getWindowState()).toEqual({
      bounds: { x: 40, y: 50, width: 1200, height: 900 },
      isMaximized: true,
      isFullScreen: false,
    })
    expect(reloaded.getWorkspaceSettings()).toMatchObject({
      treeWidth: 360,
      panelWidth: 420,
      lastOpenDirectory: '/tmp/open',
      lastCreateDirectory: '/tmp/create',
    })
  })

  it('clamps pane widths to supported layout ranges', () => {
    const store = new AppSettingsStore(storePath())

    const low = store.updateWorkspaceSettings({ treeWidth: 1, panelWidth: 1 })
    const high = store.updateWorkspaceSettings({ treeWidth: 9999, panelWidth: 9999 })

    expect(low.treeWidth).toBe(160)
    expect(low.panelWidth).toBe(240)
    expect(high.treeWidth).toBe(520)
    expect(high.panelWidth).toBe(600)
  })

  it('does not write unchanged workspace settings after normalization', () => {
    const path = storePath()
    const store = new AppSettingsStore(path)

    const settings = store.updateWorkspaceSettings({ treeWidth: 288.2, panelWidth: 320.4 })

    expect(settings.treeWidth).toBe(288)
    expect(settings.panelWidth).toBe(320)
    expect(existsSync(path)).toBe(false)
  })

  it('clears stored workspace directories when null is supplied', () => {
    const store = new AppSettingsStore(storePath())
    store.updateWorkspaceSettings({
      lastOpenDirectory: '/tmp/open',
      lastCreateDirectory: '/tmp/create',
    })

    const cleared = store.updateWorkspaceSettings({
      lastOpenDirectory: null,
      lastCreateDirectory: null,
    })

    expect(cleared.lastOpenDirectory).toBeNull()
    expect(cleared.lastCreateDirectory).toBeNull()
  })

  it('tracks last project and marks missing projects', () => {
    const projectDir = join(tmpDir, 'Workspace Lab')
    mkdirSync(projectDir)
    writeFileSync(join(projectDir, 'manifest.json'), '{}', 'utf8')

    const store = new AppSettingsStore(storePath())
    store.recordLastProject(project(projectDir))
    expect(store.getWorkspaceSettings().lastProject).toMatchObject({
      path: projectDir,
      name: 'Workspace Lab',
      exists: true,
    })

    rmSync(join(projectDir, 'manifest.json'))
    expect(store.getWorkspaceSettings().lastProject).toMatchObject({
      path: projectDir,
      exists: false,
    })
  })

  it('falls back to defaults for invalid settings files', () => {
    mkdirSync(join(tmpDir, 'settings'), { recursive: true })
    writeFileSync(storePath(), '{"window":{"bounds":{"width":"wide"}}}', 'utf8')

    const store = new AppSettingsStore(storePath())

    expect(store.getWindowState()).toBeNull()
    expect(store.getWorkspaceSettings()).toMatchObject({
      treeWidth: 288,
      panelWidth: 320,
      lastProject: null,
    })
  })
})

describe('resolveRestorableWindowBounds', () => {
  const state: DesktopWindowState = {
    bounds: { x: 100, y: 100, width: 1200, height: 800 },
    isMaximized: false,
    isFullScreen: false,
  }

  it('restores bounds that intersect a current display work area', () => {
    expect(resolveRestorableWindowBounds(state, [
      { workArea: { x: 0, y: 0, width: 1440, height: 900 } },
    ])).toEqual(state.bounds)
  })

  it('rejects bounds that are fully off-screen after monitor changes', () => {
    expect(resolveRestorableWindowBounds(state, [
      { workArea: { x: 2000, y: 0, width: 1440, height: 900 } },
    ])).toBeNull()
  })
})
