// Core domain types shared between main process and renderer.
// No platform-specific imports allowed here.

export interface ManifestNode {
  id: string
  parentId: string | null
  name: string
  order: number
  properties: Record<string, string | number | boolean | null>
  // Optional reference to a NodeTemplate (by template id) that types this
  // node's properties. Absent/null means the node is freeform (ad-hoc,
  // untyped properties).
  templateId?: string | null
  created: string   // ISO 8601
  modified: string  // ISO 8601
}

// ─── Templates & typed properties ──────────────────────────────────────────────
//
// Type information lives ONCE here, in the project-level templates map. Node
// property VALUES stay clean JSON primitives on disk — no per-value wrappers.
// A node points to a template via templateId; properties whose key matches a
// template field are typed/validated against that field. Keys not in the
// template are ad-hoc and untyped (treated as strings) until promoted.

export type PropertyType = 'string' | 'number' | 'boolean' | 'date' | 'version' | 'enum'

export interface TemplateField {
  type: PropertyType
  label?: string
  required?: boolean
  default?: string | number | boolean | null
  // Required (non-empty) when type === 'enum'. The set of allowed values.
  options?: string[]
}

export interface NodeTemplate {
  label: string
  description?: string
  // Keyed by property key (the key used in ManifestNode.properties).
  fields: Record<string, TemplateField>
}

// Structured, path-qualified problem found while loading a manifest. Surfaced
// to the user rather than silently coerced/downgraded. Non-fatal: the project
// still loads with values left exactly as written on disk.
export interface ManifestWarning {
  // Dotted path to the offending value, e.g. "nodes[12].properties.firmware".
  path: string
  code: string
  message: string
}

export interface Project {
  version: number
  id: string
  name: string
  created: string   // ISO 8601
  modified: string  // ISO 8601
  nodes: ManifestNode[]
  // Keyed by template id (slug). Persisted to disk.
  templates?: Record<string, NodeTemplate>
  // Runtime-only: not persisted to disk
  path?: string
  // Runtime-only: structured warnings collected at load time. Stripped on write.
  loadWarnings?: ManifestWarning[]
}

// ─── CSV import ─────────────────────────────────────────────────────────────────

export type ImportPlacement = 'flat' | 'path'

// One CSV column mapped to a node property. `key` is the (editable) property
// key; `include: false` drops the column.
export interface ImportColumnMapping {
  header: string
  key: string
  include: boolean
}

export interface ImportMapping {
  placement: ImportPlacement
  // flat: every row becomes a child here. path: the base for resolving the
  // breadcrumb column (paths walk down from this node).
  baseParentId: string
  nameColumn: string
  pathColumn?: string
  pathSeparator?: string          // default ' / '
  // path placement only: create any missing breadcrumb ancestors (as plain
  // untyped nodes) instead of skipping the row. Ignored when placement is flat.
  autoCreateParents?: boolean
  templateId?: string | null
  columns: ImportColumnMapping[]   // property columns only (excludes name/path)
  // Update-on-key: when true, a row whose key matches an existing child of the
  // resolved parent UPDATES that node instead of being skipped as a collision.
  // keyColumn is a HEADER — the name column, or an included property column
  // (matched by that column's mapped `key`, not the header text).
  updateExisting?: boolean
  keyColumn?: string
}

// Cheap first look at a file, before any mapping: headers, a sample, total count.
export interface ImportInspect {
  headers: string[]
  sampleRows: string[][]
  rowCount: number
}

// A single per-row problem. `row` is the 1-based file row (header = row 1).
export interface ImportIssue {
  row: number
  column?: string
  reason: string
}

// Full-file validation result (issue arrays capped for transport/display).
export interface ImportPlan {
  acceptedCount: number           // rows that will CREATE a node (unchanged meaning)
  updatedCount: number            // existing nodes that will be UPDATED (update-on-key)
  skippedCount: number
  warningCount: number
  createdParents: number          // ancestors auto-created to satisfy paths
  skipped: ImportIssue[]
  warnings: ImportIssue[]
  capped: boolean
}

// Outcome of an applied import. Issue arrays are capped for transport (same as
// ImportPlan); the *Count fields carry the true totals.
export interface ImportResult {
  created: number
  updated: number                 // existing nodes updated (update-on-key)
  createdParents: number          // ancestors auto-created to satisfy paths
  skippedCount: number
  warningCount: number
  skipped: ImportIssue[]
  warnings: ImportIssue[]
  capped: boolean
}

export type ChangeType =
  | 'added'
  | 'removed'
  | 'moved'
  | 'renamed'
  | 'property-changed'
  | 'template-changed'
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

// Project-level template/schema change between two snapshots. Computed by
// diffTemplates(); surfaced through MergedTree.templateChanges so the compare
// view can show "Schema changes" separately from per-node diffs.
export type TemplateChangeType =
  | 'template-added'
  | 'template-removed'
  | 'template-relabeled'
  | 'template-redescribed'
  | 'field-added'
  | 'field-removed'
  | 'field-changed'

export interface TemplateDiffEntry {
  templateId: string
  templateLabel: string
  changeType: TemplateChangeType
  // Set for field-* changes: the property key whose field definition changed.
  fieldKey?: string
  oldValue?: unknown
  newValue?: unknown
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
  // Template bound to this node at this point in time (null = freeform).
  templateId?: string | null
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
