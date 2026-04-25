// Project lifecycle: create, open, save, and node CRUD.
// All filesystem operations go through here.
// Never call fs directly from main/index.ts.
//
// State model:
//   - currentProject holds the in-memory project after open/create.
//   - All node mutations update currentProject then schedule an autosave.
//   - Autosave is debounced (AUTOSAVE_DEBOUNCE_MS). On close/quit,
//     call flushAutosave() to write immediately before clearing state.
//
// ┌─────────────────────────────────────────────┐
// │  IPC call (node:create / update / delete…)  │
// └────────────────────┬────────────────────────┘
//                      │
//                      ▼
//            mutate currentProject
//                      │
//                      ├──▶ scheduleAutosave() ──▶ debounce ──▶ writeManifest()
//                      │
//                      └──▶ return Result<Project>
//

import { existsSync, mkdirSync, writeFileSync, readFileSync, renameSync, statSync } from 'fs'
import { join } from 'path'
import { v7 as uuidv7 } from 'uuid'
import type {
  Project,
  ManifestNode,
  SearchResult,
  Result,
  Snapshot,
  DiffEntry,
  SnapshotRevertRequest,
  SnapshotRevertResult,
  SnapshotTimelineEvent,
  RecoveryPoint,
} from '../shared/types'
import { ok, err, ErrorCode } from '../shared/errors'
import { migrate, getCurrentVersion } from '../shared/migration'
import { validateNodeName, validatePropertyKey, validatePropertyValue, validateSnapshotName } from '../shared/validation'
import { diffProjects } from '../shared/diff-engine'
import { buildMergedTree } from '../shared/merged-tree'
import type { MergedTree } from '../shared/merged-tree'
import type { GitService } from './git-service'
import type { Logger } from './logger'
import { SearchIndexService } from './search-index'

const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024  // 50 MB
const AUTOSAVE_DEBOUNCE_MS = 2500              // 2.5 seconds

interface SnapshotHistoryState {
  version: 1
  currentBaseSnapshotId: string | null
  pendingRevertEventId: string | null
  snapshots: Record<string, {
    id: string
    basedOnSnapshotId: string | null
    createdAfterRevertEventId: string | null
    note: string | null
  }>
  events: SnapshotTimelineEvent[]
  recoveryPoints: RecoveryPoint[]
}

const EMPTY_HISTORY: SnapshotHistoryState = {
  version: 1,
  currentBaseSnapshotId: null,
  pendingRevertEventId: null,
  snapshots: {},
  events: [],
  recoveryPoints: [],
}

export class ProjectManager {
  private currentProject: Project | null = null
  private autosaveTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly git: GitService,
    private readonly logger: Logger,
    private readonly search = new SearchIndexService()
  ) {}

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  getCurrent(): Project | null {
    return this.currentProject
  }

  // Create a new project at parentPath/name.
  // Auto-creates the root node and initialises git.
  async createProject(name: string, parentPath: string): Promise<Result<Project>> {
    const projectPath = join(parentPath, name)
    try {
      mkdirSync(projectPath, { recursive: true })

      const now = new Date().toISOString()
      const rootId = uuidv7()
      const project: Project = {
        version: getCurrentVersion(),
        id: uuidv7(),
        name,
        created: now,
        modified: now,
        nodes: [
          {
            id: rootId,
            parentId: null,
            name,
            order: 0,
            properties: {},
            created: now,
            modified: now,
          },
        ],
        path: projectPath,
      }

      await this.writeManifest(project)
      await this.git.initRepo(projectPath)
      await this.git.initialCommit(projectPath)
      const searchResult = this.rebuildSearchIndex(project, 'initialize')
      if (!searchResult.ok) return searchResult as Result<Project>

      this.currentProject = project
      this.logger.info('project created', { name, path: projectPath })
      return ok(project)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      this.logger.error('project create failed', { name, path: projectPath, error: msg })
      return err(ErrorCode.PROJECT_NOT_FOUND, `Failed to create project: ${msg}`)
    }
  }

  // Open an existing project from a directory path.
  // Reads manifest.json, validates, migrates if needed, rebuilds search index.
  async openProject(projectPath: string): Promise<Result<Project>> {
    const manifestPath = join(projectPath, 'manifest.json')
    try {
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

      const originalVersion = data.version
      try {
        data = migrate(data)
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e)
        return err(ErrorCode.SCHEMA_VERSION, msg)
      }

      const validation = this.validateManifest(data)
      if (!validation.ok) return validation as Result<Project>

      const project: Project = { ...data, path: projectPath }

      // If migration bumped the version, write the migrated file back immediately.
      if (data.version !== originalVersion) {
        await this.writeManifest(project)
        this.logger.info('project migrated', { from: originalVersion, to: data.version })
      }

      const searchResult = this.rebuildSearchIndex(project, 'rebuild')
      if (!searchResult.ok) {
        return searchResult as Result<Project>
      }

      this.currentProject = project
      this.logger.info('project opened', { name: project.name, path: projectPath, nodes: project.nodes.length })
      return ok(project)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      this.logger.error('project open failed', { path: projectPath, error: msg })
      return err(ErrorCode.PROJECT_NOT_FOUND, `Could not open project: ${msg}`)
    }
  }

  // Explicit save: called by autosave debounce and snapshot flush.
  // Uses atomic write (tmp → rename).
  async saveProject(): Promise<Result<void>> {
    if (!this.currentProject) {
      return err(ErrorCode.PROJECT_NOT_FOUND, 'No project is currently open')
    }
    return this.writeManifest(this.currentProject)
  }

  // Flush autosave immediately and clear in-memory state.
  // Call before quit, close, or snapshot.
  async flushAndClose(): Promise<Result<void>> {
    this.cancelAutosave()
    const result = await this.saveProject()
    this.currentProject = null
    this.search.close()
    return result
  }

  // ─── Node CRUD ──────────────────────────────────────────────────────────────

  // Create a child node under parentId.
  // New node is appended as the last child (order = sibling count).
  nodeCreate(parentId: string, name: string): Result<Project> {
    if (!this.currentProject) return err(ErrorCode.PROJECT_NOT_FOUND, 'No project open')

    const nameValidation = validateNodeName(name)
    if (!nameValidation.valid) {
      return err(ErrorCode.VALIDATION_FAILED, nameValidation.message ?? 'Invalid name')
    }

    // Parent must exist.
    const parent = this.currentProject.nodes.find(n => n.id === parentId)
    if (!parent) {
      return err(ErrorCode.INVALID_HIERARCHY, `Parent node not found: ${parentId}`)
    }

    // Sibling name uniqueness (case-insensitive).
    const siblings = this.currentProject.nodes.filter(n => n.parentId === parentId)
    if (this.hasSiblingNameConflict(name, parentId, null)) {
      return err(
        ErrorCode.VALIDATION_FAILED,
        `A node named "${name}" already exists under this parent`
      )
    }

    const now = new Date().toISOString()
    const newNode: ManifestNode = {
      id: uuidv7(),
      parentId,
      name,
      order: siblings.length,
      properties: {},
      created: now,
      modified: now,
    }

    const nextProject: Project = {
      ...this.currentProject,
      modified: now,
      nodes: [...this.currentProject.nodes, newNode],
    }

    return this.commitProjectMutation(nextProject, () => {
      this.search.upsertNode(nextProject.path!, newNode)
    })
  }

  // Update a node's name and/or properties.
  nodeUpdate(
    id: string,
    changes: { name?: string; properties?: Record<string, string | number | boolean | null> }
  ): Result<Project> {
    if (!this.currentProject) return err(ErrorCode.PROJECT_NOT_FOUND, 'No project open')

    const node = this.currentProject.nodes.find(n => n.id === id)
    if (!node) return err(ErrorCode.VALIDATION_FAILED, `Node not found: ${id}`)

    if (changes.name !== undefined) {
      const nameValidation = validateNodeName(changes.name)
      if (!nameValidation.valid) {
        return err(ErrorCode.VALIDATION_FAILED, nameValidation.message ?? 'Invalid name')
      }
      if (this.hasSiblingNameConflict(changes.name, node.parentId, id)) {
        return err(
          ErrorCode.VALIDATION_FAILED,
          `A node named "${changes.name}" already exists under this parent`
        )
      }
    }

    if (changes.properties !== undefined) {
      for (const [key, value] of Object.entries(changes.properties)) {
        const keyValidation = validatePropertyKey(key)
        if (!keyValidation.valid) {
          return err(ErrorCode.VALIDATION_FAILED, keyValidation.message ?? 'Invalid property key')
        }
        if (value !== null) {
          const valueValidation = validatePropertyValue(value)
          if (!valueValidation.valid) {
            return err(ErrorCode.VALIDATION_FAILED, valueValidation.message ?? 'Invalid property value')
          }
        }
      }
    }

    const now = new Date().toISOString()
    const updatedNode: ManifestNode = {
      ...node,
      ...(changes.name !== undefined ? { name: changes.name } : {}),
      ...(changes.properties !== undefined ? { properties: changes.properties } : {}),
      modified: now,
    }

    const nextProject: Project = {
      ...this.currentProject,
      modified: now,
      nodes: this.currentProject.nodes.map(n => n.id === id ? updatedNode : n),
    }

    return this.commitProjectMutation(nextProject, () => {
      this.search.upsertNode(nextProject.path!, updatedNode)
    })
  }

  // Delete a node and all its descendants.
  // Root node (parentId === null) cannot be deleted.
  nodeDelete(id: string): Result<Project> {
    if (!this.currentProject) return err(ErrorCode.PROJECT_NOT_FOUND, 'No project open')

    const node = this.currentProject.nodes.find(n => n.id === id)
    if (!node) return err(ErrorCode.VALIDATION_FAILED, `Node not found: ${id}`)

    if (node.parentId === null) {
      return err(ErrorCode.INVALID_HIERARCHY, 'Cannot delete the root node')
    }

    // Collect node + all descendants.
    const toDelete = this.collectDescendants(id)

    // Re-number siblings after deletion.
    const now = new Date().toISOString()
    const remaining = this.currentProject.nodes.filter(n => !toDelete.has(n.id))
    const reordered = this.renumberSiblings(remaining, node.parentId)

    const nextProject: Project = {
      ...this.currentProject,
      modified: now,
      nodes: reordered,
    }

    return this.commitProjectMutation(nextProject, () => {
      this.search.deleteNodes(nextProject.path!, Array.from(toDelete))
    })
  }

  // Move a node to a new parent (reparent) or reorder within current parent.
  // Reparented nodes are appended as the last child of the target parent.
  // For reordering within the same parent, newOrder specifies the target position.
  nodeMove(id: string, newParentId: string, newOrder: number): Result<Project> {
    if (!this.currentProject) return err(ErrorCode.PROJECT_NOT_FOUND, 'No project open')

    const node = this.currentProject.nodes.find(n => n.id === id)
    if (!node) return err(ErrorCode.VALIDATION_FAILED, `Node not found: ${id}`)

    if (node.parentId === null) {
      return err(ErrorCode.INVALID_HIERARCHY, 'Cannot move the root node')
    }

    const newParent = this.currentProject.nodes.find(n => n.id === newParentId)
    if (!newParent) {
      return err(ErrorCode.INVALID_HIERARCHY, `Target parent not found: ${newParentId}`)
    }

    // Reject circular reparent: newParentId must not be a descendant of node.
    if (this.isDescendant(newParentId, id)) {
      return err(ErrorCode.INVALID_HIERARCHY, 'Cannot move a node into its own descendant')
    }

    const isReparent = node.parentId !== newParentId
    const now = new Date().toISOString()
    let nextProject: Project

    if (isReparent) {
      // Sibling name check in new parent.
      if (this.hasSiblingNameConflict(node.name, newParentId, null)) {
        return err(
          ErrorCode.VALIDATION_FAILED,
          `A node named "${node.name}" already exists in the target location`
        )
      }

      // Remove from old parent, re-number old siblings.
      const withoutNode = this.currentProject.nodes.filter(n => n.id !== id)
      const reorderedOld = this.renumberSiblings(withoutNode, node.parentId)

      // Append to new parent as last child.
      const newSiblingCount = reorderedOld.filter(n => n.parentId === newParentId).length
      const movedNode: ManifestNode = {
        ...node,
        parentId: newParentId,
        order: newSiblingCount,
        modified: now,
      }

      nextProject = {
        ...this.currentProject,
        modified: now,
        nodes: [...reorderedOld, movedNode],
      }
    } else {
      // Reorder within same parent.
      const siblings = this.currentProject.nodes
        .filter(n => n.parentId === node.parentId)
        .sort((a, b) => a.order - b.order)

      const clamped = Math.max(0, Math.min(newOrder, siblings.length - 1))
      if (clamped === node.order) {
        // No-op: already in position.
        return ok(this.currentProject)
      }

      // Remove node from current position, insert at target.
      const without = siblings.filter(n => n.id !== id)
      without.splice(clamped, 0, node)

      // Assign clean 0..n-1 orders.
      const reordered = without.map((n, i) => ({ ...n, order: i, modified: now }))

      nextProject = {
        ...this.currentProject,
        modified: now,
        nodes: [
          ...this.currentProject.nodes.filter(n => n.parentId !== node.parentId),
          ...reordered,
        ],
      }
    }

    const movedNode = nextProject.nodes.find(n => n.id === id)!
    return this.commitProjectMutation(nextProject, () => {
      this.search.upsertNode(nextProject.path!, movedNode)
    })
  }

  // ─── Search ─────────────────────────────────────────────────────────────────

  // Linear scan over in-memory nodes. Matches name + property values.
  // Phase 3 will replace this with a SQLite FTS5 index.
  searchNodes(query: string): Result<SearchResult[]> {
    if (!this.currentProject) return ok([])

    const q = query.trim().toLowerCase()
    if (!q) return ok([])

    const nodeMap = new Map(this.currentProject.nodes.map(n => [n.id, n]))
    const project = this.currentProject

    try {
      const results = this.search.query(project.path!, q)
        .reduce<SearchResult[]>((acc, hit) => {
          const node = nodeMap.get(hit.nodeId)
          if (!node) return acc
          const parent = node.parentId ? nodeMap.get(node.parentId) : null
          acc.push({
            nodeId: node.id,
            nodeName: node.name,
            parentName: parent?.name ?? null,
            matchField: hit.matchField,
            snippet: hit.snippet || node.name,
          })
          return acc
        }, [])

      return ok(results)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      this.logger.warn('search query failed; attempting index rebuild', {
        path: project.path,
        error: msg,
      })

      const rebuildResult = this.rebuildSearchIndex(project, 'rebuild')
      if (!rebuildResult.ok) {
        return err(
          ErrorCode.SQLITE_CAPABILITY,
          `Search is unavailable: ${rebuildResult.error.message}`
        )
      }

      try {
        const retried = this.search.query(project.path!, q)
          .reduce<SearchResult[]>((acc, hit) => {
            const node = nodeMap.get(hit.nodeId)
            if (!node) return acc
            const parent = node.parentId ? nodeMap.get(node.parentId) : null
            acc.push({
              nodeId: node.id,
              nodeName: node.name,
              parentName: parent?.name ?? null,
              matchField: hit.matchField,
              snippet: hit.snippet || node.name,
            })
            return acc
          }, [])

        return ok(retried)
      } catch (retryError: unknown) {
        const retryMsg = retryError instanceof Error ? retryError.message : String(retryError)
        this.logger.error('search query failed after rebuild', { path: project.path, error: retryMsg })
        return err(ErrorCode.SQLITE_CAPABILITY, `Search is unavailable: ${retryMsg}`)
      }
    }
  }

  // ─── Snapshots / history ───────────────────────────────────────────────────

  async snapshotCreate(name: string): Promise<Result<Snapshot>> {
    if (!this.currentProject) {
      return err(ErrorCode.PROJECT_NOT_FOUND, 'No project is currently open')
    }

    const validation = validateSnapshotName(name)
    if (!validation.valid) {
      return err(ErrorCode.VALIDATION_FAILED, validation.message ?? 'Invalid snapshot name')
    }

    const flushResult = await this.flushPendingAutosave()
    if (!flushResult.ok) {
      return flushResult as Result<Snapshot>
    }

    try {
      const snapshot = await this.git.createSnapshot(this.currentProject.path!, name)
      const history = this.readSnapshotHistory()
      const event: SnapshotTimelineEvent = {
        id: uuidv7(),
        type: 'snapshot',
        createdAt: snapshot.createdAt,
        snapshotId: snapshot.id,
      }
      const snapshotMeta = {
        id: snapshot.id,
        basedOnSnapshotId: history.currentBaseSnapshotId,
        createdAfterRevertEventId: history.pendingRevertEventId,
        note: null,
      }
      history.snapshots[snapshot.id] = snapshotMeta
      history.events.push(event)
      history.currentBaseSnapshotId = snapshot.id
      history.pendingRevertEventId = null
      this.writeSnapshotHistory(history)
      this.logger.info('snapshot created', { name, path: this.currentProject.path })
      return ok({
        ...snapshot,
        basedOnSnapshotId: snapshotMeta.basedOnSnapshotId,
        createdAfterRevertEventId: snapshotMeta.createdAfterRevertEventId,
        note: snapshotMeta.note,
      })
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      const code = msg.includes('already exists') ? ErrorCode.VALIDATION_FAILED : ErrorCode.GIT_COMMIT_FAILED
      const message = code === ErrorCode.VALIDATION_FAILED
        ? `Snapshot "${name}" already exists`
        : `Failed to create snapshot: ${msg}`
      this.logger.error('snapshot create failed', { name, path: this.currentProject.path, error: msg })
      return err(code, message)
    }
  }

  async snapshotList(): Promise<Result<Snapshot[]>> {
    if (!this.currentProject?.path) {
      return err(ErrorCode.PROJECT_NOT_FOUND, 'No project is currently open')
    }

    try {
      const snapshots = await this.git.listSnapshots(this.currentProject.path)
      return ok(this.withSnapshotMetadata(snapshots))
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      this.logger.error('snapshot list failed', { path: this.currentProject.path, error: msg })
      return err(ErrorCode.GIT_COMMIT_FAILED, `Failed to list snapshots: ${msg}`)
    }
  }

  async snapshotCompare(a: string, b: string): Promise<Result<DiffEntry[]>> {
    if (!this.currentProject?.path) {
      return err(ErrorCode.PROJECT_NOT_FOUND, 'No project is currently open')
    }
    try {
      const loaded = await this.loadAndDiff(a, b)
      if (!loaded.ok) return loaded as Result<DiffEntry[]>
      this.logger.info('snapshot compare complete', {
        path: this.currentProject.path,
        from: a,
        to: b,
        diffCount: loaded.data.diffs.length,
      })
      return ok(loaded.data.diffs)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      this.logger.error('snapshot compare failed', { path: this.currentProject.path, from: a, to: b, error: msg })
      return err(ErrorCode.SNAPSHOT_READ_FAILED, `Failed to compare snapshots: ${msg}`)
    }
  }

  async snapshotLoadCompare(a: string, b: string): Promise<Result<MergedTree>> {
    if (!this.currentProject?.path) {
      return err(ErrorCode.PROJECT_NOT_FOUND, 'No project is currently open')
    }
    try {
      const loaded = await this.loadAndDiff(a, b)
      if (!loaded.ok) return loaded as Result<MergedTree>
      const { projectA, projectB, diffs } = loaded.data
      const merged = buildMergedTree(projectA, projectB, diffs, a, b)
      this.logger.info('snapshot loadCompare complete', {
        path: this.currentProject.path,
        from: a,
        to: b,
        nodeCount: merged.nodes.length,
      })
      return ok(merged)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      this.logger.error('snapshot loadCompare failed', { path: this.currentProject.path, from: a, to: b, error: msg })
      return err(ErrorCode.SNAPSHOT_READ_FAILED, `Failed to load compare: ${msg}`)
    }
  }

  /** Shared inner logic: read both snapshots from git and diff them. */
  private async loadAndDiff(a: string, b: string): Promise<Result<{ projectA: Project; projectB: Project; diffs: DiffEntry[] }>> {
    const path = this.currentProject!.path!
    const [rawA, rawB] = await Promise.all([
      this.git.readSnapshotManifest(path, a),
      this.git.readSnapshotManifest(path, b),
    ])
    const projectA = this.parseManifestJson(rawA)
    if (!projectA.ok) return projectA as Result<{ projectA: Project; projectB: Project; diffs: DiffEntry[] }>
    const projectB = this.parseManifestJson(rawB)
    if (!projectB.ok) return projectB as Result<{ projectA: Project; projectB: Project; diffs: DiffEntry[] }>
    const diffs = diffProjects(projectA.data, projectB.data)
    return ok({ projectA: projectA.data, projectB: projectB.data, diffs })
  }

  async snapshotRevert(request: SnapshotRevertRequest): Promise<Result<SnapshotRevertResult>> {
    if (!this.currentProject?.path) {
      return err(ErrorCode.PROJECT_NOT_FOUND, 'No project is currently open')
    }

    this.cancelAutosave()

    try {
      const name = request.name
      const note = request.note?.trim() || null
      const noteRequirement = await this.requiresRevertNote(name)
      if (!noteRequirement.ok) return noteRequirement as Result<SnapshotRevertResult>
      if (noteRequirement.data && !note) {
        return err(
          ErrorCode.VALIDATION_FAILED,
          'A revert note is required because this snapshot has later snapshots in the timeline.'
        )
      }

      const raw = await this.git.readSnapshotManifest(this.currentProject.path, name)
      const restored = this.parseManifestJson(raw)
      if (!restored.ok) return restored as Result<SnapshotRevertResult>

      const previousProject = this.currentProject
      const restoredProject: Project = {
        ...restored.data,
        path: previousProject.path,
      }

      const safetyRecoveryPoint = await this.createSafetyRecoveryPointIfNeeded(previousProject)

      const searchResult = this.rebuildSearchIndex(restoredProject, 'rebuild')
      if (!searchResult.ok) {
        return searchResult as Result<SnapshotRevertResult>
      }

      this.currentProject = restoredProject

      const writeResult = await this.writeManifest(this.currentProject, { touchModified: false })
      if (!writeResult.ok) {
        this.currentProject = previousProject
        this.restoreSearchIndex(previousProject)
        return writeResult as Result<SnapshotRevertResult>
      }

      const event: SnapshotTimelineEvent = {
        id: uuidv7(),
        type: 'revert',
        createdAt: new Date().toISOString(),
        targetSnapshotId: name,
        note,
        safetyRecoveryPointId: safetyRecoveryPoint?.id ?? null,
      }
      const history = this.readSnapshotHistory()
      history.events.push(event)
      history.currentBaseSnapshotId = name
      history.pendingRevertEventId = event.id
      if (safetyRecoveryPoint) {
        history.recoveryPoints.push(safetyRecoveryPoint)
      }
      this.writeSnapshotHistory(history)

      this.logger.info('snapshot reverted', { name, path: this.currentProject.path, eventId: event.id })
      return ok({ event, safetyRecoveryPoint })
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      this.logger.error('snapshot revert failed', { name: request.name, path: this.currentProject.path, error: msg })
      return err(ErrorCode.GIT_COMMIT_FAILED, `Failed to revert snapshot: ${msg}`)
    }
  }

  /** @deprecated Use snapshotRevert. */
  async snapshotRestore(name: string): Promise<Result<void>> {
    const reverted = await this.snapshotRevert({ name })
    return reverted.ok ? ok(undefined as void) : reverted
  }

  // ─── Autosave ───────────────────────────────────────────────────────────────

  private async flushPendingAutosave(): Promise<Result<void>> {
    this.cancelAutosave()
    return this.saveProject()
  }

  private scheduleAutosave(): void {
    this.cancelAutosave()
    this.autosaveTimer = setTimeout(() => {
      this.saveProject().then(result => {
        if (!result.ok) {
          this.logger.error('autosave failed', { error: result.error.message })
        }
      })
    }, AUTOSAVE_DEBOUNCE_MS)
  }

  cancelAutosave(): void {
    if (this.autosaveTimer !== null) {
      clearTimeout(this.autosaveTimer)
      this.autosaveTimer = null
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private parseManifestJson(raw: string): Result<Project> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let data: any

    try {
      data = JSON.parse(raw)
    } catch {
      return err(ErrorCode.VALIDATION_FAILED, 'Project file is not valid JSON')
    }

    try {
      data = migrate(data)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      return err(ErrorCode.SCHEMA_VERSION, msg)
    }

    const validation = this.validateManifest(data)
    if (!validation.ok) return validation as Result<Project>

    return ok(data as Project)
  }

  private commitProjectMutation(
    nextProject: Project,
    syncSearch: () => void
  ): Result<Project> {
    const previousProject = this.currentProject
    if (!previousProject?.path) {
      return err(ErrorCode.PROJECT_NOT_FOUND, 'No project open')
    }

    try {
      syncSearch()
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      this.restoreSearchIndex(previousProject)
      this.logger.error('search index sync failed', { path: previousProject.path, error: msg })
      return err(ErrorCode.SQLITE_CAPABILITY, `Failed to update search index: ${msg}`)
    }

    this.currentProject = nextProject
    this.scheduleAutosave()
    return ok(nextProject)
  }

  private rebuildSearchIndex(project: Project, action: 'initialize' | 'rebuild'): Result<void> {
    try {
      this.search.rebuild(project)
      return ok(undefined as void)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      this.logger.error(`search index ${action} failed`, { path: project.path, error: msg })
      return err(
        ErrorCode.SQLITE_CAPABILITY,
        `Failed to ${action} search index: ${msg}`
      )
    }
  }

  private restoreSearchIndex(project: Project | null): void {
    if (!project) {
      this.search.close()
      return
    }

    const rebuilt = this.rebuildSearchIndex(project, 'rebuild')
    if (!rebuilt.ok) {
      this.search.close()
    }
  }

  private withSnapshotMetadata(snapshots: Snapshot[]): Snapshot[] {
    const history = this.readSnapshotHistory()
    return snapshots.map(snapshot => {
      const meta = history.snapshots[snapshot.id]
      return {
        ...snapshot,
        basedOnSnapshotId: meta?.basedOnSnapshotId ?? null,
        createdAfterRevertEventId: meta?.createdAfterRevertEventId ?? null,
        note: meta?.note ?? null,
      }
    })
  }

  private async requiresRevertNote(targetSnapshotName: string): Promise<Result<boolean>> {
    if (!this.currentProject?.path) {
      return err(ErrorCode.PROJECT_NOT_FOUND, 'No project is currently open')
    }

    const history = this.readSnapshotHistory()
    const targetEventIndex = history.events.findIndex(
      event => event.type === 'snapshot' && event.snapshotId === targetSnapshotName
    )
    if (targetEventIndex >= 0) {
      return ok(history.events
        .slice(targetEventIndex + 1)
        .some(event => event.type === 'snapshot'))
    }

    const snapshots = await this.git.listSnapshots(this.currentProject.path)
    const targetIndex = snapshots.findIndex(snapshot => snapshot.name === targetSnapshotName)
    if (targetIndex < 0) return ok(false)

    // listSnapshots sorts newest first; any earlier array item is a later timeline snapshot.
    return ok(targetIndex > 0)
  }

  private async createSafetyRecoveryPointIfNeeded(project: Project): Promise<RecoveryPoint | null> {
    if (!project.path) return null

    const current = this.serializeProjectForPersistence(project)
    let head = ''
    try {
      head = this.canonicalizeManifestJson(await this.git.readHeadManifest(project.path))
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      this.logger.warn('could not compare current project to HEAD before revert', { path: project.path, error: msg })
    }

    if (head && head === current) return null

    const id = `recovery-${uuidv7()}`
    const recoveryDir = join(project.path, '.manifest', 'recovery')
    const manifestPath = join('.manifest', 'recovery', `${id}.manifest.json`)
    mkdirSync(recoveryDir, { recursive: true })
    writeFileSync(join(project.path, manifestPath), current, 'utf8')

    return {
      id,
      createdAt: new Date().toISOString(),
      reason: 'pre-revert',
      manifestPath,
    }
  }

  private readSnapshotHistory(): SnapshotHistoryState {
    const projectPath = this.currentProject?.path
    if (!projectPath) return { ...EMPTY_HISTORY, snapshots: {}, events: [], recoveryPoints: [] }

    const historyPath = this.snapshotHistoryPath(projectPath)
    if (!existsSync(historyPath)) {
      return { ...EMPTY_HISTORY, snapshots: {}, events: [], recoveryPoints: [] }
    }

    try {
      const parsed = JSON.parse(readFileSync(historyPath, 'utf8')) as Partial<SnapshotHistoryState>
      return {
        version: 1,
        currentBaseSnapshotId: parsed.currentBaseSnapshotId ?? null,
        pendingRevertEventId: parsed.pendingRevertEventId ?? null,
        snapshots: parsed.snapshots ?? {},
        events: parsed.events ?? [],
        recoveryPoints: parsed.recoveryPoints ?? [],
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      this.logger.warn('snapshot history read failed; starting fresh history metadata', { path: historyPath, error: msg })
      return { ...EMPTY_HISTORY, snapshots: {}, events: [], recoveryPoints: [] }
    }
  }

  private writeSnapshotHistory(history: SnapshotHistoryState): void {
    const projectPath = this.currentProject?.path
    if (!projectPath) return

    const manifestDir = join(projectPath, '.manifest')
    mkdirSync(manifestDir, { recursive: true })
    writeFileSync(this.snapshotHistoryPath(projectPath), JSON.stringify(history, null, 2), 'utf8')
  }

  private snapshotHistoryPath(projectPath: string): string {
    return join(projectPath, '.manifest', 'history.json')
  }

  private serializeProjectForPersistence(project: Project): string {
    const { path: _path, ...persistable } = project
    return JSON.stringify(persistable, null, 2)
  }

  private canonicalizeManifestJson(raw: string): string {
    return JSON.stringify(JSON.parse(raw), null, 2)
  }

  // Collect id of node + all its descendants.
  private collectDescendants(rootId: string): Set<string> {
    const result = new Set<string>()
    const queue = [rootId]
    while (queue.length > 0) {
      const id = queue.shift()!
      result.add(id)
      if (this.currentProject) {
        for (const n of this.currentProject.nodes) {
          if (n.parentId === id) queue.push(n.id)
        }
      }
    }
    return result
  }

  // Return true if candidateId is a descendant of ancestorId.
  private isDescendant(candidateId: string, ancestorId: string): boolean {
    return this.collectDescendants(ancestorId).has(candidateId)
  }

  // Re-assign 0..n-1 order values to siblings of parentId within nodes.
  private renumberSiblings(nodes: ManifestNode[], parentId: string | null): ManifestNode[] {
    const siblings = nodes
      .filter(n => n.parentId === parentId)
      .sort((a, b) => a.order - b.order)
      .map((n, i) => ({ ...n, order: i }))

    const siblingsById = new Map(siblings.map(n => [n.id, n]))
    return nodes.map(n => siblingsById.get(n.id) ?? n)
  }

  // Case-insensitive sibling name check. excludeId skips self during rename.
  private hasSiblingNameConflict(
    name: string,
    parentId: string | null,
    excludeId: string | null
  ): boolean {
    if (!this.currentProject) return false
    const lower = name.toLowerCase()
    return this.currentProject.nodes.some(
      n =>
        n.parentId === parentId &&
        n.id !== excludeId &&
        n.name.toLowerCase() === lower
    )
  }

  // Atomic write: tmp then rename.
  private async writeManifest(
    project: Project,
    options: { touchModified?: boolean } = {}
  ): Promise<Result<void>> {
    if (!project.path) {
      return err(ErrorCode.PROJECT_NOT_FOUND, 'Project has no path — cannot save')
    }
    const manifestPath = join(project.path, 'manifest.json')
    const tmpPath = `${manifestPath}.tmp`
    const touchModified = options.touchModified ?? true
    try {
      const persistedProject = {
        ...project,
        modified: touchModified ? new Date().toISOString() : project.modified,
      }
      const { path: _path, ...persistable } = persistedProject
      writeFileSync(tmpPath, JSON.stringify(persistable, null, 2), 'utf8')
      renameSync(tmpPath, manifestPath)
      if (this.currentProject?.path === project.path && this.currentProject.id === project.id) {
        this.currentProject = persistedProject
      }
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
        return err(ErrorCode.VALIDATION_FAILED, 'Node missing required fields (id/name/order)')
      }
      if (ids.has(node.id)) {
        this.logger.warn('duplicate node ID detected', { id: node.id })
      }
      ids.add(node.id)
    }

    // Exactly one root node required (v2+).
    const roots = (data.nodes as ManifestNode[]).filter(n => n.parentId === null)
    if (roots.length !== 1) {
      return err(
        ErrorCode.INVALID_HIERARCHY,
        `Expected exactly one root node, found ${roots.length}`
      )
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
}
