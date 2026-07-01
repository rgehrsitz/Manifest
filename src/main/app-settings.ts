import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { basename, dirname, join } from 'path'
import type { Project } from '../shared/types'

export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface DisplayLike {
  workArea: WindowBounds
}

export interface DesktopWindowState {
  bounds: WindowBounds
  isMaximized: boolean
  isFullScreen: boolean
}

export interface LastProjectState {
  path: string
  name: string
  exists: boolean
}

export interface WorkspaceSettings {
  treeWidth: number
  panelWidth: number
  lastOpenDirectory: string | null
  lastCreateDirectory: string | null
  lastProject: LastProjectState | null
}

interface StoredLastProject {
  path: string
  name: string
}

interface StoredSettings {
  window: DesktopWindowState | null
  workspace: {
    treeWidth: number
    panelWidth: number
    lastOpenDirectory: string | null
    lastCreateDirectory: string | null
    lastProject: StoredLastProject | null
  }
}

export interface WorkspaceSettingsPatch {
  treeWidth?: number
  panelWidth?: number
  lastOpenDirectory?: string | null
  lastCreateDirectory?: string | null
}

const DEFAULT_TREE_WIDTH = 288
const DEFAULT_PANEL_WIDTH = 320

function defaultSettings(): StoredSettings {
  return {
    window: null,
    workspace: {
      treeWidth: DEFAULT_TREE_WIDTH,
      panelWidth: DEFAULT_PANEL_WIDTH,
      lastOpenDirectory: null,
      lastCreateDirectory: null,
      lastProject: null,
    },
  }
}

export class AppSettingsStore {
  private settings: StoredSettings

  constructor(private readonly storePath: string) {
    this.settings = this.load()
  }

  getWindowState(): DesktopWindowState | null {
    return this.settings.window ? { ...this.settings.window, bounds: { ...this.settings.window.bounds } } : null
  }

  updateWindowState(state: DesktopWindowState): void {
    this.settings.window = normalizeWindowState(state)
    this.save()
  }

  getWorkspaceSettings(): WorkspaceSettings {
    const workspace = this.settings.workspace
    return {
      treeWidth: workspace.treeWidth,
      panelWidth: workspace.panelWidth,
      lastOpenDirectory: workspace.lastOpenDirectory,
      lastCreateDirectory: workspace.lastCreateDirectory,
      lastProject: workspace.lastProject
        ? {
            ...workspace.lastProject,
            exists: existsSync(join(workspace.lastProject.path, 'manifest.json')),
          }
        : null,
    }
  }

  updateWorkspaceSettings(patch: WorkspaceSettingsPatch): WorkspaceSettings {
    const workspace = this.settings.workspace
    let changed = false

    if (typeof patch.treeWidth === 'number') {
      const next = clampTreeWidth(patch.treeWidth)
      if (workspace.treeWidth !== next) {
        workspace.treeWidth = next
        changed = true
      }
    }
    if (typeof patch.panelWidth === 'number') {
      const next = clampPanelWidth(patch.panelWidth)
      if (workspace.panelWidth !== next) {
        workspace.panelWidth = next
        changed = true
      }
    }
    if (patch.lastOpenDirectory === null || typeof patch.lastOpenDirectory === 'string') {
      if (workspace.lastOpenDirectory !== patch.lastOpenDirectory) {
        workspace.lastOpenDirectory = patch.lastOpenDirectory
        changed = true
      }
    }
    if (patch.lastCreateDirectory === null || typeof patch.lastCreateDirectory === 'string') {
      if (workspace.lastCreateDirectory !== patch.lastCreateDirectory) {
        workspace.lastCreateDirectory = patch.lastCreateDirectory
        changed = true
      }
    }
    if (changed) this.save()
    return this.getWorkspaceSettings()
  }

  recordLastDirectory(kind: 'open' | 'create', directoryPath: string): void {
    if (kind === 'open') this.settings.workspace.lastOpenDirectory = directoryPath
    else this.settings.workspace.lastCreateDirectory = directoryPath
    this.save()
  }

  getLastDirectory(kind: 'open' | 'create'): string | undefined {
    return (kind === 'open'
      ? this.settings.workspace.lastOpenDirectory
      : this.settings.workspace.lastCreateDirectory) ?? undefined
  }

  recordLastProject(project: Project): void {
    if (typeof project.path !== 'string' || project.path.trim() === '') return
    this.settings.workspace.lastProject = {
      path: project.path,
      name: project.name || basename(project.path),
    }
    this.save()
  }

  private load(): StoredSettings {
    try {
      const raw = JSON.parse(readFileSync(this.storePath, 'utf8'))
      return normalizeSettings(raw)
    } catch {
      return defaultSettings()
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.storePath), { recursive: true })
      writeFileSync(this.storePath, JSON.stringify(this.settings, null, 2), 'utf8')
    } catch {
      // App settings are convenience metadata; persistence failure must not
      // block project workflows.
    }
  }
}

export function resolveRestorableWindowBounds(
  state: DesktopWindowState | null,
  displays: DisplayLike[],
): WindowBounds | null {
  if (!state) return null
  const bounds = normalizeBounds(state.bounds)
  if (!bounds) return null
  return displays.some(display => intersects(bounds, display.workArea)) ? bounds : null
}

function normalizeSettings(raw: unknown): StoredSettings {
  const settings = defaultSettings()
  if (!raw || typeof raw !== 'object') return settings
  const source = raw as Partial<StoredSettings>

  const windowState = normalizeWindowState(source.window)
  if (windowState) settings.window = windowState

  const workspace = source.workspace
  if (workspace && typeof workspace === 'object') {
    if (typeof workspace.treeWidth === 'number') {
      settings.workspace.treeWidth = clampTreeWidth(workspace.treeWidth)
    }
    if (typeof workspace.panelWidth === 'number') {
      settings.workspace.panelWidth = clampPanelWidth(workspace.panelWidth)
    }
    if (typeof workspace.lastOpenDirectory === 'string') {
      settings.workspace.lastOpenDirectory = workspace.lastOpenDirectory
    }
    if (typeof workspace.lastCreateDirectory === 'string') {
      settings.workspace.lastCreateDirectory = workspace.lastCreateDirectory
    }
    if (isStoredLastProject(workspace.lastProject)) {
      settings.workspace.lastProject = workspace.lastProject
    }
  }
  return settings
}

function normalizeWindowState(raw: unknown): DesktopWindowState | null {
  if (!raw || typeof raw !== 'object') return null
  const source = raw as Partial<DesktopWindowState>
  const bounds = normalizeBounds(source.bounds)
  if (!bounds) return null
  return {
    bounds,
    isMaximized: source.isMaximized === true,
    isFullScreen: source.isFullScreen === true,
  }
}

function normalizeBounds(raw: unknown): WindowBounds | null {
  if (!raw || typeof raw !== 'object') return null
  const source = raw as Partial<WindowBounds>
  const { x, y, width, height } = source
  if (typeof x !== 'number' || typeof y !== 'number'
    || typeof width !== 'number' || typeof height !== 'number'
    || !Number.isFinite(x) || !Number.isFinite(y)
    || !Number.isFinite(width) || !Number.isFinite(height)) {
    return null
  }
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.max(900, Math.round(width)),
    height: Math.max(600, Math.round(height)),
  }
}

function intersects(a: WindowBounds, b: WindowBounds): boolean {
  return a.x < b.x + b.width
    && a.x + a.width > b.x
    && a.y < b.y + b.height
    && a.y + a.height > b.y
}

function clampTreeWidth(width: number): number {
  return Math.max(160, Math.min(520, Math.round(width)))
}

function clampPanelWidth(width: number): number {
  return Math.max(240, Math.min(600, Math.round(width)))
}

function isStoredLastProject(value: unknown): value is StoredLastProject {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<StoredLastProject>
  return typeof candidate.path === 'string'
    && candidate.path.trim() !== ''
    && typeof candidate.name === 'string'
    && candidate.name.trim() !== ''
}
