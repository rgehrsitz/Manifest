import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { basename, dirname, join } from 'path'
import type { Project } from '../shared/types'
import { PROJECT_LAUNCHER_FILE } from './project-launcher'

const MAX_RECENT_PROJECTS = 10

interface StoredRecentProject {
  path: string
  name: string
  openedAt: string
}

export interface RecentProjectMenuEntry extends StoredRecentProject {
  exists: boolean
}

export class RecentProjectsStore {
  private entries: StoredRecentProject[] = []

  constructor(private readonly storePath: string) {
    this.load()
  }

  all(): RecentProjectMenuEntry[] {
    return this.entries.map(entry => ({
      ...entry,
      exists: projectPathLooksOpenable(entry.path),
    }))
  }

  add(project: Project): void {
    if (typeof project.path !== 'string' || project.path.trim() === '') return

    const entry: StoredRecentProject = {
      path: project.path,
      name: project.name || basename(project.path),
      openedAt: new Date().toISOString(),
    }

    this.entries = [
      entry,
      ...this.entries.filter(existing => existing.path !== entry.path),
    ].slice(0, MAX_RECENT_PROJECTS)
    this.save()
  }

  clear(): void {
    this.entries = []
    this.save()
  }

  private load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.storePath, 'utf8'))
      if (!raw || typeof raw !== 'object' || !Array.isArray(raw.projects)) {
        this.entries = []
        return
      }

      this.entries = raw.projects
        .filter(isStoredRecentProject)
        .slice(0, MAX_RECENT_PROJECTS)
    } catch {
      this.entries = []
    }
  }

  private save(): void {
    mkdirSync(dirname(this.storePath), { recursive: true })
    writeFileSync(this.storePath, JSON.stringify({ projects: this.entries }, null, 2), 'utf8')
  }
}

export function getRecentDocumentPath(projectPath: string): string | null {
  const launcherPath = join(projectPath, PROJECT_LAUNCHER_FILE)
  if (existsSync(launcherPath)) return launcherPath

  const manifestPath = join(projectPath, 'manifest.json')
  return existsSync(manifestPath) ? manifestPath : null
}

function projectPathLooksOpenable(projectPath: string): boolean {
  return existsSync(join(projectPath, 'manifest.json'))
}

function isStoredRecentProject(value: unknown): value is StoredRecentProject {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<StoredRecentProject>
  return typeof candidate.path === 'string'
    && candidate.path.trim() !== ''
    && typeof candidate.name === 'string'
    && candidate.name.trim() !== ''
    && typeof candidate.openedAt === 'string'
}
