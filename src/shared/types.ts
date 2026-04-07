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
  name: string
  commitHash: string
  createdAt: string // ISO 8601
  message: string
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
