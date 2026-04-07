// Project lifecycle: create, open, save.
// All filesystem operations go through here.
// Never call fs directly from main/index.ts.

import { mkdirSync, writeFileSync, readFileSync, renameSync, statSync } from 'fs'
import { join } from 'path'
import { v7 as uuidv7 } from 'uuid'
import type { Project, ManifestNode, Result } from '../shared/types'
import { ok, err, ErrorCode } from '../shared/errors'
import { migrate } from '../shared/migration'
import type { GitService } from './git-service'
import type { Logger } from './logger'

const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024  // 50 MB

export class ProjectManager {
  constructor(
    private readonly git: GitService,
    private readonly logger: Logger
  ) {}

  // Create a new project at parentPath/name.
  // Initialises the directory, writes manifest.json, and creates the initial git commit.
  async createProject(name: string, parentPath: string): Promise<Result<Project>> {
    const projectPath = join(parentPath, name)
    try {
      mkdirSync(projectPath, { recursive: true })

      const now = new Date().toISOString()
      const project: Project = {
        version: 1,
        id: uuidv7(),
        name,
        created: now,
        modified: now,
        nodes: [],
        path: projectPath,
      }

      await this.writeManifest(project)
      await this.git.initRepo(projectPath)
      await this.git.initialCommit(projectPath)

      this.logger.info('project created', { name, path: projectPath })
      return ok(project)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      this.logger.error('project create failed', { name, path: projectPath, error: msg })
      return err(ErrorCode.PROJECT_NOT_FOUND, `Failed to create project: ${msg}`)
    }
  }

  // Open an existing project from a directory path.
  // Reads manifest.json, validates, migrates if needed.
  async openProject(projectPath: string): Promise<Result<Project>> {
    const manifestPath = join(projectPath, 'manifest.json')
    try {
      // Size guard before reading
      const stat = statSync(manifestPath)
      if (stat.size > MAX_FILE_SIZE_BYTES) {
        const mb = Math.round(stat.size / 1024 / 1024)
        return err(ErrorCode.FILE_TOO_LARGE, `Project file is ${mb}MB (limit: 50MB)`)
      }

      const raw = readFileSync(manifestPath, 'utf8')

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let data: any
      try {
        data = JSON.parse(raw)
      } catch {
        return err(ErrorCode.VALIDATION_FAILED, 'Project file is not valid JSON')
      }

      // Migrate if version is behind current
      try {
        data = migrate(data)
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e)
        return err(ErrorCode.SCHEMA_VERSION, msg)
      }

      // Validate required fields and hierarchy integrity
      const validation = this.validateManifest(data)
      if (!validation.ok) return validation as Result<Project>

      const project: Project = { ...data, path: projectPath }
      this.logger.info('project opened', { name: project.name, path: projectPath, nodes: project.nodes.length })
      return ok(project)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      this.logger.error('project open failed', { path: projectPath, error: msg })
      return err(ErrorCode.PROJECT_NOT_FOUND, `Could not open project: ${msg}`)
    }
  }

  // Atomic save: write to .tmp then rename into place.
  // Called by autosave (debounced) and snapshot flush (immediate).
  async saveProject(project: Project): Promise<Result<void>> {
    if (!project.path) {
      return err(ErrorCode.PROJECT_NOT_FOUND, 'Project has no path — cannot save')
    }
    const manifestPath = join(project.path, 'manifest.json')
    const tmpPath = `${manifestPath}.tmp`
    try {
      const { path: _path, ...persistable } = { ...project, modified: new Date().toISOString() }
      writeFileSync(tmpPath, JSON.stringify(persistable, null, 2), 'utf8')
      renameSync(tmpPath, manifestPath)
      this.logger.debug('project saved', { path: project.path })
      return ok(undefined as void)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      this.logger.error('project save failed', { path: project.path, error: msg })
      return err(ErrorCode.AUTOSAVE_WRITE_FAILED, `Failed to save project: ${msg}`)
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private validateManifest(data: any): Result<void> {
    if (!data.id || typeof data.id !== 'string') {
      return err(ErrorCode.VALIDATION_FAILED, 'Missing required field: id')
    }
    if (!data.name || typeof data.name !== 'string') {
      return err(ErrorCode.VALIDATION_FAILED, 'Missing required field: name')
    }
    if (!Array.isArray(data.nodes)) {
      return err(ErrorCode.VALIDATION_FAILED, 'Missing required field: nodes')
    }

    const ids = new Set<string>()
    for (const node of data.nodes as ManifestNode[]) {
      if (!node.id || !node.name || node.order === undefined || node.order === null) {
        return err(ErrorCode.VALIDATION_FAILED, `Node missing required fields (id/name/order)`)
      }
      if (ids.has(node.id)) {
        // Log and continue — auto-resolution happens at the node level in Phase 2
        this.logger.warn('duplicate node ID detected', { id: node.id })
      }
      ids.add(node.id)
    }

    if (this.hasCircularRefs(data.nodes)) {
      return err(ErrorCode.INVALID_HIERARCHY, 'Project contains circular parent references')
    }

    return ok(undefined as void)
  }

  private hasCircularRefs(nodes: ManifestNode[]): boolean {
    const parentMap = new Map<string, string | null>()
    for (const node of nodes) {
      parentMap.set(node.id, node.parentId ?? null)
    }
    for (const node of nodes) {
      const visited = new Set<string>()
      let current: string | null = node.id
      while (current !== null) {
        if (visited.has(current)) return true
        visited.add(current)
        current = parentMap.get(current) ?? null
      }
    }
    return false
  }

  private async writeManifest(project: Project): Promise<void> {
    const { path: _path, ...persistable } = project
    const manifestPath = join(project.path!, 'manifest.json')
    const tmpPath = `${manifestPath}.tmp`
    writeFileSync(tmpPath, JSON.stringify(persistable, null, 2), 'utf8')
    renameSync(tmpPath, manifestPath)
  }
}
