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
  NodeTemplate,
  Snapshot,
  DiffEntry,
  SearchResult,
  GitStatus,
  Result,
  NodeHistory,
  NodeHistoryIndexStatus,
  RecoveryPointApplyRequest,
  RecoveryPointApplyResult,
  SnapshotRevertRequest,
  SnapshotRevertResult,
  SnapshotTimeline,
  ImportMapping,
  ImportInspect,
  ImportPlan,
  ImportResult,
} from './types'
import type { MergedTree } from './merged-tree'
import type { ReportFormat } from './report'

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
  NODE_HISTORY:        'node:history',
  NODE_HISTORY_BACKFILL_STATUS: 'node:historyBackfillStatus',
  NODE_HISTORY_REINDEX: 'node:history:reindex',
  TEMPLATE_CREATE:     'template:create',
  TEMPLATE_UPDATE:     'template:update',
  TEMPLATE_DELETE:     'template:delete',
  IMPORT_INSPECT:      'import:inspect',
  IMPORT_PLAN:         'import:plan',
  IMPORT_APPLY:        'import:apply',
  SEARCH_QUERY:        'search:query',
  SNAPSHOT_CREATE:     'snapshot:create',
  SNAPSHOT_LIST:       'snapshot:list',
  SNAPSHOT_COMPARE:      'snapshot:compare',
  SNAPSHOT_LOAD_COMPARE: 'snapshot:loadCompare',
  SNAPSHOT_REVERT:       'snapshot:revert',
  SNAPSHOT_TIMELINE:     'snapshot:timeline',
  RECOVERY_APPLY:        'recovery:apply',
  GIT_CHECK:           'git:check',
  REPORT_EXPORT:       'report:export',
  REPORT_BUILD:        'report:build',
  // UI utility channels (not domain operations)
  DIALOG_OPEN_FOLDER:  'dialog:openFolder',
  DIALOG_OPEN_FILE:    'dialog:openFile',
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
    /** Create a child node under parentId, optionally bound to a template. Returns full updated Project. */
    create(parentId: string, name: string, templateId?: string | null): Promise<Result<Project>>
    /** Update node name, properties, and/or template binding. Returns full updated Project. */
    update(
      id: string,
      changes: {
        name?: string
        properties?: Record<string, string | number | boolean | null>
        templateId?: string | null
      }
    ): Promise<Result<Project>>
    /**
     * Delete node and all its descendants. Returns full updated Project.
     * Blocked by default when a surviving node's `reference` property — or a
     * template `reference` field default — points into the deletion set; the
     * blocking `ReferenceBlocker[]` rides in the error context. Pass
     * `{ unlinkReferences: true }` to clear those references/defaults and force
     * the delete.
     */
    delete(id: string, options?: { unlinkReferences?: boolean }): Promise<Result<Project>>
    /** Move node to newParentId (appended as last child) or reorder within same parent. */
    move(id: string, newParentId: string, newOrder: number): Promise<Result<Project>>
    /** Chronological history of one node across all snapshots, plus revert/recover events that changed it. */
    history(nodeId: string): Promise<Result<NodeHistory>>
    /** Status of the background per-node history backfill (populated on project open). */
    historyBackfillStatus(): Promise<Result<NodeHistoryIndexStatus>>
    /** Re-run per-node history indexing for any incomplete snapshots. */
    historyReindex(): Promise<Result<NodeHistoryIndexStatus>>
  }
  template: {
    /** Create a new node template (id must be a unique slug). Returns full updated Project. */
    create(id: string, template: NodeTemplate): Promise<Result<Project>>
    /** Update a template; rejected if it would invalidate a bound node's value. Returns full updated Project. */
    update(id: string, changes: Partial<NodeTemplate>): Promise<Result<Project>>
    /** Delete a template; bound nodes are unbound but keep their values. Returns full updated Project. */
    delete(id: string): Promise<Result<Project>>
  }
  import: {
    /** First look at a CSV: headers, a sample, and total row count. */
    inspect(path: string): Promise<Result<ImportInspect>>
    /** Full-file validation given a mapping: accepted/skipped/warning counts + capped issues. */
    plan(path: string, mapping: ImportMapping): Promise<Result<ImportPlan>>
    /** Apply the import (re-plans authoritatively). Returns the updated Project + a summary. */
    apply(path: string, mapping: ImportMapping): Promise<Result<{ project: Project; summary: ImportResult }>>
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
  }
  git: {
    check(): Promise<Result<GitStatus>>
  }
  report: {
    /** Build a diff report between two snapshots and write it via a save dialog. savedPath is null if canceled. */
    export(from: string, to: string, format: ReportFormat): Promise<Result<{ savedPath: string | null }>>
    /** Build a diff report and return its content (for clipboard copy). */
    build(from: string, to: string, format: ReportFormat): Promise<Result<{ content: string; suggestedName: string }>>
  }
  dialog: {
    openFolder(title: string): Promise<string | null>
    openFile(title: string): Promise<string | null>
  }
}
