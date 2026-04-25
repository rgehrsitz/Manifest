// Schema migration pipeline for `.manifest/history.json`.
// Mirrors the manifest migrate pattern in src/shared/migration.ts.
//
// History tracking shipped at version 1. Future versions plug in here:
// register a migrator under its target version, bump CURRENT_VERSION, done.

import type { SnapshotTimelineEvent, RecoveryPoint } from './types'

const CURRENT_VERSION = 1

export interface SnapshotHistoryState {
  version: number
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

export function emptySnapshotHistory(): SnapshotHistoryState {
  return {
    version: CURRENT_VERSION,
    currentBaseSnapshotId: null,
    pendingRevertEventId: null,
    snapshots: {},
    events: [],
    recoveryPoints: [],
  }
}

// Key = target version. migrations[2] would migrate v1 → v2.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const migrations: Record<number, (data: any) => any> = {}

export class SnapshotHistoryVersionError extends Error {
  constructor(public readonly fromVersion: number, public readonly toVersion: number) {
    super(
      `Cannot migrate snapshot history from version ${fromVersion} to ${toVersion}: no migrator registered`
    )
    this.name = 'SnapshotHistoryVersionError'
  }
}

// Forward-only migration. Files newer than CURRENT_VERSION reset to empty —
// history metadata is recoverable from git tags + a fresh start, so refusing
// to load is worse than starting clean.
export function migrateSnapshotHistory(raw: unknown): SnapshotHistoryState {
  if (!raw || typeof raw !== 'object') return emptySnapshotHistory()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let data: any = raw
  const version = typeof data.version === 'number' ? data.version : 1
  data.version = version

  if (version > CURRENT_VERSION) {
    // Newer-than-known: refuse silently and start fresh.
    return emptySnapshotHistory()
  }

  while (data.version < CURRENT_VERSION) {
    const migrator = migrations[data.version + 1]
    if (!migrator) throw new SnapshotHistoryVersionError(data.version, CURRENT_VERSION)
    data = migrator(data)
  }

  return {
    version: CURRENT_VERSION,
    currentBaseSnapshotId: data.currentBaseSnapshotId ?? null,
    pendingRevertEventId: data.pendingRevertEventId ?? null,
    snapshots: data.snapshots ?? {},
    events: Array.isArray(data.events) ? data.events : [],
    recoveryPoints: Array.isArray(data.recoveryPoints) ? data.recoveryPoints : [],
  }
}

export function getCurrentSnapshotHistoryVersion(): number {
  return CURRENT_VERSION
}
