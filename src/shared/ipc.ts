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
} from './types'

// Channel name constants — use these everywhere, never raw strings.
export const IPC = {
  PROJECT_CREATE:   'project:create',
  PROJECT_OPEN:     'project:open',
  PROJECT_SAVE:     'project:save',
  NODE_CREATE:      'node:create',
  NODE_UPDATE:      'node:update',
  NODE_DELETE:      'node:delete',
  NODE_MOVE:        'node:move',
  SEARCH_QUERY:     'search:query',
  SNAPSHOT_CREATE:  'snapshot:create',
  SNAPSHOT_LIST:    'snapshot:list',
  SNAPSHOT_COMPARE: 'snapshot:compare',
  SNAPSHOT_RESTORE: 'snapshot:restore',
  GIT_CHECK:        'git:check',
  // UI utility channels (not domain operations)
  DIALOG_OPEN_FOLDER: 'dialog:openFolder',
} as const

// Typed API surface exposed on window.api by the preload script.
// Renderer code should only interact with main process through this interface.
export interface ManifestAPI {
  project: {
    create(name: string, parentPath: string): Promise<Result<Project>>
    open(path: string): Promise<Result<Project>>
    save(project: Project): Promise<Result<void>>
  }
  node: {
    create(parentId: string | null, name: string, order: number): Promise<Result<ManifestNode>>
    update(
      id: string,
      changes: Partial<Omit<ManifestNode, 'id' | 'created'>>
    ): Promise<Result<ManifestNode>>
    delete(id: string): Promise<Result<void>>
    move(id: string, newParentId: string | null, newOrder: number): Promise<Result<void>>
  }
  search: {
    query(query: string): Promise<Result<SearchResult[]>>
  }
  snapshot: {
    create(name: string): Promise<Result<Snapshot>>
    list(): Promise<Result<Snapshot[]>>
    compare(a: string, b: string): Promise<Result<DiffEntry[]>>
    restore(name: string): Promise<Result<void>>
  }
  git: {
    check(): Promise<Result<GitStatus>>
  }
  dialog: {
    openFolder(title: string): Promise<string | null>
  }
}
