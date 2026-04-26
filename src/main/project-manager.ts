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

import { existsSync, mkdirSync, writeFileSync, readFileSync, renameSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'
import { v7 as uuidv7 } from 'uuid'
import type {
  Project,
  RecoveryPointApplyRequest,
  RecoveryPointApplyResult,
  ManifestNode,
  NodeHistory,
  NodeHistoryEntry,
  SearchResult,
  Result,
  Snapshot,
  DiffEntry,
  SnapshotRevertRequest,
  SnapshotRevertResult,
  SnapshotTimelineEvent,
  SnapshotTimeline,
  RecoveryPoint,
} from '../shared/types'
import { ok, err, ErrorCode } from '../shared/errors'
import { migrate, getCurrentVersion } from '../shared/migration'
import {
  emptySnapshotHistory,
  migrateSnapshotHistory,
  type SnapshotHistoryState,
} from '../shared/snapshot-history-migration'
import { validateNodeName, validatePropertyKey, validatePropertyValue, validateSnapshotName } from '../shared/validation'
import { diffProjects } from '../shared/diff-engine'
import { buildMergedTree } from '../shared/merged-tree'
import type { MergedTree } from '../shared/merged-tree'
import type { GitService } from './git-service'
import type { Logger } from './logger'
import { SearchIndexService } from './search-index'
import { HistoryIndexService } from './history-index'

const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024  // 50 MB
const AUTOSAVE_DEBOUNCE_MS = 2500              // 2.5 seconds
const MAX_RECOVERY_POINTS = 10                 // cap stored auto-saved recovery points


export interface HistoryBackfillStatus {
  inProgress: boolean
  completed: number
  total: number
}

export class ProjectManager {
  private currentProject: Project | null = null
  private autosaveTimer: ReturnType<typeof setTimeout> | null = null
  private backfillStatus: HistoryBackfillStatus = {
    inProgress: false, completed: 0, total: 0,
  }
  private backfillToken = 0  // bumped on close so a stale backfill exits early
  private backfillPromise: Promise<void> | null = null

  constructor(
    private readonly git: GitService,
    private readonly logger: Logger,
    private readonly search = new SearchIndexService(),
    private readonly history = new HistoryIndexService()
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
      this.openHistoryIndex(projectPath)

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
      this.openHistoryIndex(projectPath)

      this.currentProject = project
      this.logger.info('project opened', { name: project.name, path: projectPath, nodes: project.nodes.length })
      this.scheduleHistoryBackfill()
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
    this.backfillToken++  // signal any in-flight backfill to exit early
    const result = await this.saveProject()
    this.currentProject = null
    this.search.close()
    this.history.close()
    this.backfillStatus = { inProgress: false, completed: 0, total: 0 }
    return result
  }

  getHistoryBackfillStatus(): HistoryBackfillStatus {
    return { ...this.backfillStatus }
  }

  // Awaitable handle for the most recently scheduled backfill. Tests use this
  // to deterministically wait for backfill to finish without polling. UI does
  // not need this — it polls getHistoryBackfillStatus for the progress display.
  async waitForHistoryBackfill(): Promise<void> {
    if (this.backfillPromise) await this.backfillPromise
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

      // Per-node history index (best effort — failures recover via backfill).
      // Pass the just-updated history so we can derive chronological order
      // from event push order (authoritative, unlike git's second-precision
      // creatordate sort which is unstable for snapshots created the same
      // second).
      await this.recordSnapshotInHistory(snapshot.id, this.currentProject, history)

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

  async snapshotTimeline(): Promise<Result<SnapshotTimeline>> {
    if (!this.currentProject?.path) {
      return err(ErrorCode.PROJECT_NOT_FOUND, 'No project is currently open')
    }

    try {
      const history = this.readSnapshotHistory()
      const snapshots = await this.git.listSnapshots(this.currentProject.path)
      const recordedSnapshotIds = new Set(
        history.events
          .filter(event => event.type === 'snapshot')
          .map(event => event.snapshotId)
          .filter((id): id is string => Boolean(id))
      )
      const syntheticSnapshotEvents: SnapshotTimelineEvent[] = snapshots
        .filter(snapshot => !recordedSnapshotIds.has(snapshot.id))
        .map(snapshot => ({
          id: `snapshot:${snapshot.id}`,
          type: 'snapshot',
          createdAt: snapshot.createdAt,
          snapshotId: snapshot.id,
        }))
      // Recorded events keep their push order (the order they actually happened).
      // Sorting them by createdAt would shuffle revert/recover events relative to
      // snapshot events, because git tags carry second-resolution timestamps while
      // revert/recover events are recorded at millisecond resolution — so a snapshot
      // and a revert created in the same wall-clock second can swap.
      // Synthetic events (for snapshots that predate timeline tracking) are sorted
      // by createdAt and prepended.
      const sortedSynthetic = [...syntheticSnapshotEvents]
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
      const events = [...sortedSynthetic, ...history.events]

      return ok({
        events,
        recoveryPoints: history.recoveryPoints,
      })
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      this.logger.error('snapshot timeline failed', { path: this.currentProject.path, error: msg })
      return err(ErrorCode.SNAPSHOT_READ_FAILED, `Failed to read snapshot timeline: ${msg}`)
    }
  }

  // Per-node chronological history. Walks the timeline events in push order,
  // emitting an entry for each event that changed THIS node's state:
  //
  //   - 'snapshot' entries come from history.db rows (delta-encoded — only
  //     present when the node actually changed at that snapshot)
  //   - 'revert' entries are synthesized by reading the target snapshot's
  //     manifest and comparing the node's state to whatever was last shown
  //   - 'recover' entries are synthesized similarly from the recovery point's
  //     manifest file
  //
  // Snapshots, reverts, and recoveries that left this node unchanged emit
  // no entry — the result is a clean transition log.
  async nodeHistory(nodeId: string): Promise<Result<NodeHistory>> {
    if (!this.currentProject?.path) {
      return err(ErrorCode.PROJECT_NOT_FOUND, 'No project is currently open')
    }
    const projectPath = this.currentProject.path

    // Synchronously trigger a backfill probe before any await. This is
    // idempotent — already-running backfills pass through, and an
    // up-to-date index is detected and exits inside runHistoryBackfill.
    // The synchronous flip of inProgress=true (when scheduled) prevents
    // the renderer from seeing stale "not in progress" state.
    this.scheduleHistoryBackfill()

    let dbRowsBySnapshot = new Map<string, ReturnType<typeof this.history.nodeHistory>[number]>()
    try {
      const rows = this.history.nodeHistory(nodeId)
      dbRowsBySnapshot = new Map(rows.map(r => [r.snapshotId, r]))
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      this.logger.warn('history index query failed', { nodeId, error: msg })
      // Continue with empty DB rows — synthesis from revert/recover events
      // can still surface SOME entries.
    }

    const persistedHistory = this.readSnapshotHistory()

    // Build the complete chronological event list. For projects that pre-date
    // this feature (or were generated by scripts that bypassed snapshotCreate),
    // history.events doesn't include entries for every git tag. Synthesize
    // missing snapshot events the same way snapshotTimeline does — without
    // this, those snapshots are invisible to the per-node history walker even
    // though their rows exist in history.db.
    let allEvents: SnapshotTimelineEvent[] = persistedHistory.events
    try {
      const allSnapshots = await this.git.listSnapshots(projectPath)
      const recordedSnapshotIds = new Set(
        persistedHistory.events
          .filter(e => e.type === 'snapshot')
          .map(e => e.snapshotId)
          .filter((id): id is string => Boolean(id)),
      )
      const synthetic: SnapshotTimelineEvent[] = allSnapshots
        .filter(s => !recordedSnapshotIds.has(s.id))
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
        .map(s => ({
          id: `synthetic:${s.id}`,
          type: 'snapshot',
          createdAt: s.createdAt,
          snapshotId: s.id,
        }))
      allEvents = [...synthetic, ...persistedHistory.events]
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      this.logger.warn('nodeHistory: synthetic event build failed; using events as-is', { error: msg })
    }

    // Cache snapshot manifests so multiple reverts targeting the same
    // snapshot don't pay the read cost twice.
    const snapshotManifestCache = new Map<string, Project | null>()
    const readSnapshotProject = async (snapshotId: string): Promise<Project | null> => {
      if (snapshotManifestCache.has(snapshotId)) return snapshotManifestCache.get(snapshotId)!
      try {
        const raw = await this.git.readSnapshotManifest(projectPath, snapshotId)
        const parsed = this.parseManifestJson(raw)
        const result = parsed.ok ? parsed.data : null
        snapshotManifestCache.set(snapshotId, result)
        return result
      } catch {
        snapshotManifestCache.set(snapshotId, null)
        return null
      }
    }

    const entries: NodeHistoryEntry[] = []
    let lastState: NodeStateProjection = absentState()
    let order = 0

    for (const event of allEvents) {
      if (event.type === 'snapshot') {
        const snapshotId = event.snapshotId
        if (!snapshotId) continue
        const row = dbRowsBySnapshot.get(snapshotId)
        if (!row) continue  // delta-encoded skip — node unchanged at this snapshot
        const newState: NodeStateProjection = {
          presence: row.presence,
          nodeName: row.nodeName,
          parentId: row.parentId,
          nodeOrder: row.nodeOrder,
          properties: row.properties,
        }
        if (statesEqual(newState, lastState)) continue
        entries.push({
          type: 'snapshot',
          entryId: snapshotId,
          createdAt: event.createdAt,
          snapshotName: snapshotId,
          order: order++,
          ...newState,
        })
        lastState = newState
      } else if (event.type === 'revert') {
        const target = event.targetSnapshotId
        if (!target) continue
        const targetProject = await readSnapshotProject(target)
        if (!targetProject) continue
        const newState = projectStateForNode(targetProject, nodeId)
        if (statesEqual(newState, lastState)) continue
        entries.push({
          type: 'revert',
          entryId: event.id,
          createdAt: event.createdAt,
          snapshotName: null,
          order: order++,
          ...newState,
          revertTargetSnapshotId: target,
          note: event.note ?? null,
        })
        lastState = newState
      } else if (event.type === 'recover') {
        const recoveryPointId = event.recoveryPointId
        if (!recoveryPointId) continue
        const point = persistedHistory.recoveryPoints.find(p => p.id === recoveryPointId)
        if (!point) continue
        const recoveryFile = join(projectPath, point.manifestPath)
        let recoveredProject: Project | null = null
        try {
          if (existsSync(recoveryFile)) {
            const raw = readFileSync(recoveryFile, 'utf8')
            const parsed = this.parseManifestJson(raw)
            if (parsed.ok) recoveredProject = parsed.data
          }
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e)
          this.logger.warn('history: recovery manifest read failed', { recoveryPointId, error: msg })
        }
        if (!recoveredProject) continue
        const newState = projectStateForNode(recoveredProject, nodeId)
        if (statesEqual(newState, lastState)) continue
        entries.push({
          type: 'recover',
          entryId: event.id,
          createdAt: event.createdAt,
          snapshotName: null,
          order: order++,
          ...newState,
          recoveryPointId,
        })
        lastState = newState
      }
    }

    return ok({ entries, backfillStatus: this.getHistoryBackfillStatus() })
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
      this.pruneRecoveryPoints(history)
      this.writeSnapshotHistory(history)

      this.logger.info('snapshot reverted', { name, path: this.currentProject.path, eventId: event.id })
      return ok({ event, safetyRecoveryPoint })
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      this.logger.error('snapshot revert failed', { name: request.name, path: this.currentProject.path, error: msg })
      return err(ErrorCode.GIT_COMMIT_FAILED, `Failed to revert snapshot: ${msg}`)
    }
  }

  async recoveryPointApply(request: RecoveryPointApplyRequest): Promise<Result<RecoveryPointApplyResult>> {
    if (!this.currentProject?.path) {
      return err(ErrorCode.PROJECT_NOT_FOUND, 'No project is currently open')
    }

    this.cancelAutosave()

    try {
      const history = this.readSnapshotHistory()
      const recoveryPoint = history.recoveryPoints.find(point => point.id === request.id)
      if (!recoveryPoint) {
        return err(ErrorCode.VALIDATION_FAILED, `Recovery point not found: ${request.id}`)
      }

      const manifestPath = join(this.currentProject.path, recoveryPoint.manifestPath)
      if (!existsSync(manifestPath)) {
        return err(ErrorCode.SNAPSHOT_READ_FAILED, `Recovery manifest not found: ${recoveryPoint.manifestPath}`)
      }

      const recovered = this.parseManifestJson(readFileSync(manifestPath, 'utf8'))
      if (!recovered.ok) return recovered as Result<RecoveryPointApplyResult>

      const previousProject = this.currentProject
      const recoveredProject: Project = {
        ...recovered.data,
        path: previousProject.path,
      }

      const safetyRecoveryPoint = await this.createSafetyRecoveryPointIfNeeded(previousProject)

      const searchResult = this.rebuildSearchIndex(recoveredProject, 'rebuild')
      if (!searchResult.ok) {
        return searchResult as Result<RecoveryPointApplyResult>
      }

      this.currentProject = recoveredProject

      const writeResult = await this.writeManifest(this.currentProject, { touchModified: false })
      if (!writeResult.ok) {
        this.currentProject = previousProject
        this.restoreSearchIndex(previousProject)
        return writeResult as Result<RecoveryPointApplyResult>
      }

      const event: SnapshotTimelineEvent = {
        id: uuidv7(),
        type: 'recover',
        createdAt: new Date().toISOString(),
        recoveryPointId: recoveryPoint.id,
        safetyRecoveryPointId: safetyRecoveryPoint?.id ?? null,
      }
      history.events.push(event)
      history.currentBaseSnapshotId = null
      history.pendingRevertEventId = event.id
      if (safetyRecoveryPoint) {
        history.recoveryPoints.push(safetyRecoveryPoint)
      }
      this.pruneRecoveryPoints(history)
      this.writeSnapshotHistory(history)

      this.logger.info('recovery point applied', { id: request.id, path: this.currentProject.path, eventId: event.id })
      return ok({ event, safetyRecoveryPoint })
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      this.logger.error('recovery point apply failed', { id: request.id, path: this.currentProject.path, error: msg })
      return err(ErrorCode.SNAPSHOT_READ_FAILED, `Failed to apply recovery point: ${msg}`)
    }
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

  // ─── History index ──────────────────────────────────────────────────────────

  private openHistoryIndex(projectPath: string): void {
    try {
      this.history.open(projectPath)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      this.logger.warn('history index open failed', { path: projectPath, error: msg })
    }
  }

  // Record one snapshot's per-node state in the history index. Best-effort:
  // if anything fails (git read, parse, DB insert), log and continue. Backfill
  // on next project open will catch up.
  private async recordSnapshotInHistory(
    snapshotId: string,
    project: Project,
    history: SnapshotHistoryState,
  ): Promise<void> {
    if (!project.path) return
    try {
      // Authoritative chronological order comes from history.events push
      // order, not git tag creatordate (which is second-precision and
      // unstable for ties).
      const snapshotIdsInOrder = history.events
        .filter(e => e.type === 'snapshot' && e.snapshotId)
        .map(e => e.snapshotId as string)
      const myIndex = snapshotIdsInOrder.lastIndexOf(snapshotId)
      const snapshotOrder = myIndex >= 0 ? myIndex : snapshotIdsInOrder.length
      const previousSnapshotName = myIndex > 0 ? snapshotIdsInOrder[myIndex - 1] : null

      let previousProject: Project | null = null
      if (previousSnapshotName) {
        const raw = await this.git.readSnapshotManifest(project.path, previousSnapshotName)
        const parsed = this.parseManifestJson(raw)
        if (parsed.ok) previousProject = parsed.data
      }

      this.history.recordSnapshot({
        snapshotId, snapshotOrder, project, previousProject,
      })
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      this.logger.warn('history index record failed; backfill will retry on next open', {
        snapshotId, error: msg,
      })
    }
  }

  // Background backfill: walk all snapshots in chronological order and
  // populate history.db for any snapshot that's missing or marked complete=0.
  // Yields to the event loop between snapshots so IPC stays responsive.
  // Schedule a backfill in the background. Idempotent — calling repeatedly
  // while one is already running does NOT start a second pass; the existing
  // promise is returned. This lets nodeHistory and openProject both trigger
  // safely without coordinating.
  private scheduleHistoryBackfill(): void {
    if (this.backfillStatus.inProgress) return
    // Flip the flag synchronously so concurrent status queries don't see
    // a transient false-idle while runHistoryBackfill is still in its
    // pre-listSnapshots prelude.
    this.backfillStatus = { inProgress: true, completed: 0, total: 0 }
    this.backfillPromise = this.runHistoryBackfill().catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e)
      this.logger.error('history backfill crashed', { error: msg })
    })
  }

  private async runHistoryBackfill(): Promise<void> {
    const projectPath = this.currentProject?.path
    if (!projectPath) {
      this.backfillStatus = { inProgress: false, completed: 0, total: 0 }
      return
    }

    const myToken = ++this.backfillToken
    let allSnapshots
    try {
      allSnapshots = await this.git.listSnapshots(projectPath)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      this.logger.warn('history backfill: list snapshots failed', { error: msg })
      this.backfillStatus = { inProgress: false, completed: 0, total: 0 }
      return
    }

    if (allSnapshots.length === 0) {
      this.backfillStatus = { inProgress: false, completed: 0, total: 0 }
      return
    }

    const recorded = this.history.recordedSnapshotIds()
    const incomplete = new Set(this.history.incompleteSnapshotIds())
    const needsAny = allSnapshots.some(s => !recorded.has(s.name) || incomplete.has(s.name))
    if (!needsAny) {
      this.backfillStatus = { inProgress: false, completed: allSnapshots.length, total: allSnapshots.length }
      return
    }

    // Determine chronological order. For snapshots that have history.json
    // events, use event push order (authoritative). For legacy snapshots
    // without events, fall back to git's creatordate sort (second-precision,
    // best-effort). Legacy snapshots are placed before recorded ones since
    // events were added later in the project's life.
    const persistedHistory = this.readSnapshotHistory()
    const recordedIds = persistedHistory.events
      .filter(e => e.type === 'snapshot' && e.snapshotId)
      .map(e => e.snapshotId as string)
    const inRecorded = new Set(recordedIds)
    const tagsByName = new Map(allSnapshots.map(s => [s.name, s]))
    const legacyOrdered = allSnapshots
      .filter(s => !inRecorded.has(s.name))
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    const recordedOrdered = recordedIds
      .map(id => tagsByName.get(id))
      .filter((s): s is typeof allSnapshots[number] => s !== undefined)
    const chronological = [...legacyOrdered, ...recordedOrdered]
    // inProgress was set to true synchronously by scheduleHistoryBackfill;
    // here we update total now that we know how many snapshots we'll walk.
    this.backfillStatus = { inProgress: true, completed: 0, total: chronological.length }
    this.logger.info('history backfill started', { total: chronological.length })

    let previousProject: Project | null = null
    for (let i = 0; i < chronological.length; i++) {
      // Bail if the project was closed or another backfill superseded us.
      if (myToken !== this.backfillToken || this.currentProject?.path !== projectPath) {
        this.logger.info('history backfill cancelled', { completed: i, total: chronological.length })
        this.backfillStatus = { inProgress: false, completed: i, total: chronological.length }
        return
      }

      const snapshot = chronological[i]
      const snapshotId = snapshot.name

      let raw: string
      try {
        raw = await this.git.readSnapshotManifest(projectPath, snapshotId)
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e)
        this.logger.warn('history backfill: manifest read failed', { snapshotId, error: msg })
        previousProject = null  // can't trust delta against a snapshot we couldn't read
        this.backfillStatus.completed = i + 1
        await new Promise(resolve => setImmediate(resolve))
        continue
      }

      const parsed = this.parseManifestJson(raw)
      if (!parsed.ok) {
        this.logger.warn('history backfill: manifest parse failed', {
          snapshotId, error: parsed.error.message,
        })
        previousProject = null
        this.backfillStatus.completed = i + 1
        await new Promise(resolve => setImmediate(resolve))
        continue
      }

      const isFresh = !recorded.has(snapshotId) || incomplete.has(snapshotId)
      if (isFresh) {
        try {
          this.history.recordSnapshot({
            snapshotId, snapshotOrder: i,
            project: parsed.data, previousProject,
          })
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e)
          this.logger.warn('history backfill: insert failed', { snapshotId, error: msg })
        }
      }

      previousProject = parsed.data
      this.backfillStatus.completed = i + 1
      await new Promise(resolve => setImmediate(resolve))
    }

    this.backfillStatus = { inProgress: false, completed: chronological.length, total: chronological.length }
    this.logger.info('history backfill complete', { total: chronological.length })
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

  // Keep only the most recent MAX_RECOVERY_POINTS entries on disk and in history.
  // Mutates `history.recoveryPoints` in place; caller must writeSnapshotHistory.
  private pruneRecoveryPoints(history: SnapshotHistoryState): void {
    const projectPath = this.currentProject?.path
    if (!projectPath) return
    if (history.recoveryPoints.length <= MAX_RECOVERY_POINTS) return

    const sorted = [...history.recoveryPoints].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    )
    const removeCount = sorted.length - MAX_RECOVERY_POINTS
    const toRemove = sorted.slice(0, removeCount)
    const removeIds = new Set(toRemove.map(p => p.id))

    for (const point of toRemove) {
      const filePath = join(projectPath, point.manifestPath)
      try {
        if (existsSync(filePath)) unlinkSync(filePath)
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e)
        this.logger.warn('recovery point file delete failed', { id: point.id, path: filePath, error: msg })
      }
    }
    history.recoveryPoints = history.recoveryPoints.filter(p => !removeIds.has(p.id))
  }

  private readSnapshotHistory(): SnapshotHistoryState {
    const projectPath = this.currentProject?.path
    if (!projectPath) return emptySnapshotHistory()

    const historyPath = this.snapshotHistoryPath(projectPath)
    if (!existsSync(historyPath)) return emptySnapshotHistory()

    try {
      const parsed = JSON.parse(readFileSync(historyPath, 'utf8'))
      return migrateSnapshotHistory(parsed)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      this.logger.warn('snapshot history read failed; starting fresh history metadata', { path: historyPath, error: msg })
      return emptySnapshotHistory()
    }
  }

  private writeSnapshotHistory(history: SnapshotHistoryState): void {
    const projectPath = this.currentProject?.path
    if (!projectPath) return

    const manifestDir = join(projectPath, '.manifest')
    const historyPath = this.snapshotHistoryPath(projectPath)
    const tmpPath = `${historyPath}.tmp`
    mkdirSync(manifestDir, { recursive: true })
    writeFileSync(tmpPath, JSON.stringify(history, null, 2), 'utf8')
    renameSync(tmpPath, historyPath)
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

// ─── nodeHistory helpers (private, file-scope) ─────────────────────────────

interface NodeStateProjection {
  presence: 'present' | 'absent'
  nodeName: string | null
  parentId: string | null
  nodeOrder: number | null
  properties: Record<string, string | number | boolean | null> | null
}

function absentState(): NodeStateProjection {
  return { presence: 'absent', nodeName: null, parentId: null, nodeOrder: null, properties: null }
}

function projectStateForNode(project: Project, nodeId: string): NodeStateProjection {
  const node = project.nodes.find(n => n.id === nodeId)
  if (!node) return absentState()
  return {
    presence: 'present',
    nodeName: node.name,
    parentId: node.parentId,
    nodeOrder: node.order,
    properties: node.properties,
  }
}

function statesEqual(a: NodeStateProjection, b: NodeStateProjection): boolean {
  if (a.presence !== b.presence) return false
  if (a.nodeName !== b.nodeName) return false
  if (a.parentId !== b.parentId) return false
  if (a.nodeOrder !== b.nodeOrder) return false
  return propsEqualOrBothNull(a.properties, b.properties)
}

function propsEqualOrBothNull(
  a: Record<string, string | number | boolean | null> | null,
  b: Record<string, string | number | boolean | null> | null,
): boolean {
  if (a === null || b === null) return a === b
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false
  for (const key of aKeys) {
    if (!(key in b)) return false
    if (a[key] !== b[key]) return false
  }
  return true
}
