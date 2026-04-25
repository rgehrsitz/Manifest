// IPC channel definitions. This file is the single source of truth
// for the contract between renderer and main process.
//
// Rules:
//   1. No channel exists unless it is listed here.
//   2. Add new channels here before implementing them.
//   3. All responses use Result<T> — never throw across the IPC boundary.

import type {
  Project,
  ManifestNode,
  Snapshot,
  DiffEntry,
  SearchResult,
  GitStatus,
  Result,
  RecoveryPointApplyRequest,
  RecoveryPointApplyResult,
  SnapshotRevertRequest,
  SnapshotRevertResult,
  SnapshotTimeline,
} from './types'
import type { MergedTree } from './merged-tree'

// Channel name constants — use these everywhere, never raw strings.
export const IPC = {
  PROJECT_CREATE:      'project:create',
  PROJECT_OPEN:        'project:open',
  PROJECT_SAVE:        'project:save',
  PROJECT_GET_CURRENT: 'project:getCurrent',
  PROJECT_CLOSE:       'project:close',
  NODE_CREATE:         'node:create',
  NODE_UPDATE:         'node:update',
  NODE_DELETE:         'node:delete',
  NODE_MOVE:           'node:move',
  SEARCH_QUERY:        'search:query',
  SNAPSHOT_CREATE:     'snapshot:create',
  SNAPSHOT_LIST:       'snapshot:list',
  SNAPSHOT_COMPARE:      'snapshot:compare',
  SNAPSHOT_LOAD_COMPARE: 'snapshot:loadCompare',
  SNAPSHOT_REVERT:       'snapshot:revert',
  SNAPSHOT_TIMELINE:     'snapshot:timeline',
  RECOVERY_APPLY:        'recovery:apply',
  SNAPSHOT_RESTORE:      'snapshot:restore',
  GIT_CHECK:           'git:check',
  // UI utility channels (not domain operations)
  DIALOG_OPEN_FOLDER:  'dialog:openFolder',
} as const

// Typed API surface exposed on window.api by the preload script.
// Renderer code should only interact with main process through this interface.
//
// Node mutation methods return Result<Project> — the full updated project state
// after each mutation. The renderer replaces its local store entirely, which
// eliminates any possibility of partial-sync bugs.
export interface ManifestAPI {
  project: {
    create(name: string, parentPath: string): Promise<Result<Project>>
    open(path: string): Promise<Result<Project>>
    save(): Promise<Result<void>>
    getCurrent(): Promise<Result<Project | null>>
    close(): Promise<Result<void>>
  }
  node: {
    /** Create a child node under parentId. Returns full updated Project. */
    create(parentId: string, name: string): Promise<Result<Project>>
    /** Update node name and/or properties. Returns full updated Project. */
    update(
      id: string,
      changes: { name?: string; properties?: Record<string, string | number | boolean | null> }
    ): Promise<Result<Project>>
    /** Delete node and all its descendants. Returns full updated Project. */
    delete(id: string): Promise<Result<Project>>
    /** Move node to newParentId (appended as last child) or reorder within same parent. */
    move(id: string, newParentId: string, newOrder: number): Promise<Result<Project>>
  }
  search: {
    query(query: string): Promise<Result<SearchResult[]>>
  }
  snapshot: {
    create(name: string): Promise<Result<Snapshot>>
    list(): Promise<Result<Snapshot[]>>
    compare(a: string, b: string): Promise<Result<DiffEntry[]>>
    /** Full compare: returns merged tree with per-node diffs embedded. */
    loadCompare(a: string, b: string): Promise<Result<MergedTree>>
    revert(request: SnapshotRevertRequest): Promise<Result<SnapshotRevertResult>>
    timeline(): Promise<Result<SnapshotTimeline>>
    applyRecovery(request: RecoveryPointApplyRequest): Promise<Result<RecoveryPointApplyResult>>
    /** @deprecated Use revert(). */
    restore(name: string): Promise<Result<void>>
  }
  git: {
    check(): Promise<Result<GitStatus>>
  }
  dialog: {
    openFolder(title: string): Promise<string | null>
  }
}
