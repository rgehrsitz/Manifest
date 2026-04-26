// Per-node history index. Tracks every node's state across every snapshot
// using delta encoding: a row is inserted only when the node's state differs
// from its previous row. Reverts and recoveries are NOT recorded here — they
// don't create snapshots. The query layer in project-manager synthesizes
// revert/recover entries by reading history.json + the manifest pair around
// each event.
//
// See docs/PLAN_NODE_HISTORY.md for the full design.
//
// Storage shape:
//
//   node_history          one row per (snapshot, node) WHEN node state changed
//                         delta-encoded: unchanged nodes get no row at this
//                         snapshot. Deletion is an explicit presence='absent'
//                         row (without it, "no row" would be ambiguous).
//
//   snapshot_index_state  one row per fully-indexed snapshot. complete=1 only
//                         after the per-snapshot transaction commits AND
//                         expected_count == actual_count. Anything missing or
//                         complete=0 is fair game for backfill.

import Database from 'better-sqlite3'
import { mkdirSync } from 'fs'
import { join } from 'path'
import type { ManifestNode, Project } from '../shared/types'

const SCHEMA_VERSION = 1

export interface NodeHistoryRow {
  snapshotId: string
  snapshotOrder: number
  nodeId: string
  presence: 'present' | 'absent'
  nodeName: string | null
  parentId: string | null
  nodeOrder: number | null
  properties: Record<string, string | number | boolean | null> | null
}

export interface RecordSnapshotOptions {
  snapshotId: string
  snapshotOrder: number
  project: Project
  // Previous snapshot's project, used for delta-encoding comparison.
  // null when this is the very first snapshot of the project.
  previousProject: Project | null
}

interface RawHistoryRow {
  snapshot_id: string
  snapshot_order: number
  node_id: string
  presence: 'present' | 'absent'
  node_name: string | null
  parent_id: string | null
  node_order: number | null
  properties_json: string | null
}

export class HistoryIndexService {
  private db: Database.Database | null = null
  private projectPath: string | null = null

  open(projectPath: string): void {
    this.close()
    const dbPath = join(projectPath, '.manifest', 'index', 'history.db')
    mkdirSync(join(projectPath, '.manifest', 'index'), { recursive: true })

    const db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = NORMAL')

    this.runMigrations(db)

    this.db = db
    this.projectPath = projectPath
  }

  close(): void {
    if (this.db?.open) this.db.close()
    this.db = null
    this.projectPath = null
  }

  // Insert delta rows for one snapshot in a single transaction. Marks the
  // snapshot complete only if expected_count matches actual_count.
  recordSnapshot(opts: RecordSnapshotOptions): void {
    const db = this.requireDb()
    const { snapshotId, snapshotOrder, project, previousProject } = opts

    const prevById = new Map<string, ManifestNode>()
    if (previousProject) {
      for (const node of previousProject.nodes) prevById.set(node.id, node)
    }
    const currById = new Map<string, ManifestNode>()
    for (const node of project.nodes) currById.set(node.id, node)

    const inserts: NodeHistoryRow[] = []

    // Nodes present in the new snapshot — emit a row when state changed
    // vs previous (or when there was no previous row).
    for (const node of project.nodes) {
      const prev = prevById.get(node.id)
      const wasPresentAndUnchanged = prev !== undefined && nodeStatesEqual(prev, node)
      if (wasPresentAndUnchanged) continue
      inserts.push({
        snapshotId,
        snapshotOrder,
        nodeId: node.id,
        presence: 'present',
        nodeName: node.name,
        parentId: node.parentId,
        nodeOrder: node.order,
        properties: node.properties,
      })
    }

    // Nodes that disappeared since the previous snapshot — emit explicit
    // presence='absent' row so deletion is unambiguous in delta-encoded
    // history (without it, "no row" means "no change", not "absent").
    for (const [nodeId] of prevById) {
      if (currById.has(nodeId)) continue
      inserts.push({
        snapshotId,
        snapshotOrder,
        nodeId,
        presence: 'absent',
        nodeName: null,
        parentId: null,
        nodeOrder: null,
        properties: null,
      })
    }

    const expected = inserts.length
    const insertRow = db.prepare<[string, number, string, 'present' | 'absent', string | null, string | null, number | null, string | null]>(
      `INSERT OR REPLACE INTO node_history
        (snapshot_id, snapshot_order, node_id, presence, node_name, parent_id, node_order, properties_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const upsertState = db.prepare<[string, number, number, number]>(
      `INSERT OR REPLACE INTO snapshot_index_state
        (snapshot_id, expected_count, actual_count, complete)
       VALUES (?, ?, ?, ?)`
    )

    const run = db.transaction(() => {
      let actual = 0
      for (const row of inserts) {
        insertRow.run(
          row.snapshotId,
          row.snapshotOrder,
          row.nodeId,
          row.presence,
          row.nodeName,
          row.parentId,
          row.nodeOrder,
          row.properties === null ? null : JSON.stringify(row.properties),
        )
        actual++
      }
      const complete = actual === expected ? 1 : 0
      upsertState.run(snapshotId, expected, actual, complete)
    })

    run()
  }

  // Chronological history for a single node across all recorded snapshots.
  // Each row represents a transition (creation, change, deletion, reappearance).
  nodeHistory(nodeId: string): NodeHistoryRow[] {
    const db = this.requireDb()
    const rows = db
      .prepare<[string]>(
        `SELECT snapshot_id, snapshot_order, node_id, presence,
                node_name, parent_id, node_order, properties_json
         FROM node_history
         WHERE node_id = ?
         ORDER BY snapshot_order ASC`
      )
      .all(nodeId) as RawHistoryRow[]
    return rows.map(toNodeHistoryRow)
  }

  // Set of snapshot ids that are fully indexed (complete=1).
  recordedSnapshotIds(): Set<string> {
    const db = this.requireDb()
    const rows = db
      .prepare(
        `SELECT snapshot_id FROM snapshot_index_state WHERE complete = 1`
      )
      .all() as Array<{ snapshot_id: string }>
    return new Set(rows.map(r => r.snapshot_id))
  }

  // Snapshot ids that exist in the index but were not marked complete.
  // Backfill should re-process these.
  incompleteSnapshotIds(): string[] {
    const db = this.requireDb()
    const rows = db
      .prepare(
        `SELECT snapshot_id FROM snapshot_index_state WHERE complete = 0`
      )
      .all() as Array<{ snapshot_id: string }>
    return rows.map(r => r.snapshot_id)
  }

  private requireDb(): Database.Database {
    if (!this.db) {
      throw new Error('History index is not open')
    }
    return this.db
  }

  private runMigrations(db: Database.Database): void {
    const userVersion = (db.pragma('user_version', { simple: true }) as number) ?? 0
    if (userVersion >= SCHEMA_VERSION) return

    // Forward-only migrations. Each version's migrator is responsible for
    // bringing the schema from N-1 to N.
    if (userVersion < 1) {
      db.exec(`
        CREATE TABLE node_history (
          snapshot_id     TEXT NOT NULL,
          snapshot_order  INTEGER NOT NULL,
          node_id         TEXT NOT NULL,
          presence        TEXT NOT NULL CHECK (presence IN ('present','absent')),
          node_name       TEXT,
          parent_id       TEXT,
          node_order      INTEGER,
          properties_json TEXT,
          PRIMARY KEY (snapshot_id, node_id)
        );
        CREATE INDEX idx_node_history_node ON node_history (node_id, snapshot_order);

        CREATE TABLE snapshot_index_state (
          snapshot_id     TEXT PRIMARY KEY,
          expected_count  INTEGER NOT NULL,
          actual_count    INTEGER NOT NULL,
          complete        INTEGER NOT NULL DEFAULT 0
        );
      `)
    }

    db.pragma(`user_version = ${SCHEMA_VERSION}`)
  }
}

function toNodeHistoryRow(raw: RawHistoryRow): NodeHistoryRow {
  return {
    snapshotId: raw.snapshot_id,
    snapshotOrder: raw.snapshot_order,
    nodeId: raw.node_id,
    presence: raw.presence,
    nodeName: raw.node_name,
    parentId: raw.parent_id,
    nodeOrder: raw.node_order,
    properties: raw.properties_json === null
      ? null
      : (JSON.parse(raw.properties_json) as Record<string, string | number | boolean | null>),
  }
}

function nodeStatesEqual(a: ManifestNode, b: ManifestNode): boolean {
  if (a.name !== b.name) return false
  if (a.parentId !== b.parentId) return false
  if (a.order !== b.order) return false
  return propertiesEqual(a.properties, b.properties)
}

function propertiesEqual(
  a: Record<string, string | number | boolean | null>,
  b: Record<string, string | number | boolean | null>
): boolean {
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false
  for (const key of aKeys) {
    if (!(key in b)) return false
    if (a[key] !== b[key]) return false
  }
  return true
}
