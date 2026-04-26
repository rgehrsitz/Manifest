// Core domain types shared between main process and renderer.
// No platform-specific imports allowed here.

export interface ManifestNode {
  id: string
  parentId: string | null
  name: string
  order: number
  properties: Record<string, string | number | boolean | null>
  created: string   // ISO 8601
  modified: string  // ISO 8601
}

export interface Project {
  version: number
  id: string
  name: string
  created: string   // ISO 8601
  modified: string  // ISO 8601
  nodes: ManifestNode[]
  // Runtime-only: not persisted to disk
  path?: string
}

export type ChangeType =
  | 'added'
  | 'removed'
  | 'moved'
  | 'renamed'
  | 'property-changed'
  | 'order-changed'

export type Severity = 'High' | 'Medium' | 'Low'

export interface DiffEntry {
  nodeId: string
  changeType: ChangeType
  severity: Severity
  oldValue?: unknown
  newValue?: unknown
  context: {
    nodeName: string
    parentName: string | null
    path: string[]
  }
}

export interface Snapshot {
  id: string
  name: string
  commitHash: string
  createdAt: string // ISO 8601
  message: string
  basedOnSnapshotId: string | null
  createdAfterRevertEventId: string | null
  note: string | null
}

export type TimelineEventType = 'snapshot' | 'revert' | 'recover'

export interface SnapshotTimelineEvent {
  id: string
  type: TimelineEventType
  createdAt: string // ISO 8601
  snapshotId?: string
  targetSnapshotId?: string
  recoveryPointId?: string
  note?: string | null
  safetyRecoveryPointId?: string | null
}

export interface RecoveryPoint {
  id: string
  createdAt: string // ISO 8601
  reason: 'pre-revert'
  manifestPath: string
}

export interface SnapshotRevertRequest {
  name: string
  note?: string | null
}

export interface SnapshotRevertResult {
  event: SnapshotTimelineEvent
  safetyRecoveryPoint: RecoveryPoint | null
}

export interface RecoveryPointApplyRequest {
  id: string
}

export interface RecoveryPointApplyResult {
  event: SnapshotTimelineEvent
  safetyRecoveryPoint: RecoveryPoint | null
}

export interface SnapshotTimeline {
  events: SnapshotTimelineEvent[]
  recoveryPoints: RecoveryPoint[]
}

// Per-node history entry. One entry per transition (creation, change,
// deletion, revert that changed this node, recover that changed this node).
// Snapshots where the node did NOT change emit no entry — delta-encoded.
export type NodeHistoryEntryType = 'snapshot' | 'revert' | 'recover'

export interface NodeHistoryEntry {
  type: NodeHistoryEntryType
  // Stable id for this entry. For snapshots, it's the snapshot name. For
  // revert/recover, it's the timeline event id.
  entryId: string
  createdAt: string  // ISO 8601
  // For snapshot entries: the snapshot name. Null for revert/recover.
  snapshotName: string | null
  // Position in the chronological event order (0-based).
  order: number
  // Node state immediately after this entry's event was applied.
  presence: 'present' | 'absent'
  nodeName: string | null
  parentId: string | null
  nodeOrder: number | null
  properties: Record<string, string | number | boolean | null> | null
  // For revert entries: the snapshot the project was reverted to.
  revertTargetSnapshotId?: string | null
  // For recover entries: the recovery point that was applied.
  recoveryPointId?: string | null
  // For revert entries: the user-supplied reason (when required).
  note?: string | null
}

export interface NodeHistory {
  entries: NodeHistoryEntry[]
  // Bundled into the same IPC response so the renderer can render the
  // "Indexing N/M…" banner consistently with the entries it just received.
  // Without this, a parallel status query could race the entries query and
  // return stale inProgress=false alongside empty entries.
  backfillStatus: { inProgress: boolean; completed: number; total: number }
}

export interface SearchResult {
  nodeId: string
  nodeName: string
  parentName: string | null
  matchField: string
  snippet: string
}

export interface GitStatus {
  available: boolean
  version: string | null
  meetsMinimum: boolean
  minimumVersion: string
}

export interface AppError {
  code: string
  message: string
  context?: Record<string, unknown>
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: AppError }
