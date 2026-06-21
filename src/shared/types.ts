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

export type PropertyType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'date'
  | 'version'
  | 'enum'
  | 'reference'

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

export interface ProjectWarning {
  code: string
  title: string
  message: string
  provider?: string
  path?: string
}

// One incoming reference that blocks deleting a node (or its subtree). Carried
// in the VALIDATION_FAILED error context so the renderer can list the blockers
// and offer a force-delete-and-unlink path. Two kinds:
//   - 'node': a surviving node whose live `reference`-typed property points into
//     the deletion set. Detection is gated on the CURRENT field type, so a value
//     left under a rebound/unbound key (now plain text) is intentionally NOT a
//     blocker — clearing arbitrary free-text would be silent data loss.
//   - 'template-default': a template `reference` field whose `default` points
//     into the deletion set. Left unprotected, nodeCreate would seed that stale
//     default into every node later created from the template.
export interface ReferenceBlocker {
  kind: 'node' | 'template-default'
  // The surviving node that holds the reference; null for 'template-default'.
  nodeId: string | null
  // Display name of the holder: the node name, or the template label for
  // 'template-default'.
  nodeName: string
  // The template id whose field default points in; set only for 'template-default'.
  templateId?: string
  // The reference property/field key.
  key: string
  // The node being deleted that the reference points at.
  targetId: string
  targetName: string
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
  // Runtime-only: project-level environment/storage warnings. Stripped on write.
  projectWarnings?: ProjectWarning[]
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

// ─── NetBox relational import ──────────────────────────────────────────────
// NetBox is a relational DCIM source (Django `dumpdata` JSON). Unlike the flat
// CSV importer, the adapter resolves FK relations into a Site → Location → Rack
// → Device tree with typed device attributes. See src/shared/netbox.ts.

// Counts surfaced before import so the user can confirm what will land.
export interface NetboxInspect {
  format: 'netbox-dumpdata'
  totalObjects: number
  sites: number
  locations: number
  racks: number
  devices: number
}

export interface NetboxImportOptions {
  baseParentId: string            // node the imported Site subtree is created under
}

// Preview/result counts mirror the CSV ImportPlan/ImportResult shapes so the
// renderer can reuse the same summary UI.
export interface NetboxImportPlan {
  templatesCreated: number        // netbox-* templates that will be added
  sites: number
  locations: number
  racks: number
  devices: number
  acceptedCount: number           // total nodes that will be created
  skippedCount: number
  warningCount: number
  skipped: ImportIssue[]
  warnings: ImportIssue[]
  capped: boolean
}

export interface NetboxImportResult {
  templatesCreated: number
  created: number                 // total nodes created
  sites: number
  locations: number
  racks: number
  devices: number
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
    propertyValueLabels?: Record<string, { old?: string; new?: string }>
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
  backfillStatus: NodeHistoryIndexStatus
}

export interface NodeHistoryIndexStatus {
  inProgress: boolean
  completed: number
  total: number
  incompleteCount: number
  incompleteSnapshotIds: string[]
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
