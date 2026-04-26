import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import Database from 'better-sqlite3'
import { HistoryIndexService } from '../../../src/main/history-index'
import type { ManifestNode, Project } from '../../../src/shared/types'

let tmpDir: string
let projectPath: string
let svc: HistoryIndexService

beforeEach(() => {
  tmpDir = join(tmpdir(), `manifest-history-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(tmpDir, { recursive: true })
  projectPath = tmpDir
  svc = new HistoryIndexService()
  svc.open(projectPath)
})

afterEach(() => {
  svc.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

function node(id: string, name: string, parentId: string | null, order = 0, properties: Record<string, string | number | boolean | null> = {}): ManifestNode {
  return {
    id, parentId, name, order, properties,
    created: '2026-01-01T00:00:00.000Z',
    modified: '2026-01-01T00:00:00.000Z',
  }
}

function project(nodes: ManifestNode[]): Project {
  return {
    version: 2,
    id: 'p',
    name: 'P',
    created: '2026-01-01T00:00:00.000Z',
    modified: '2026-01-01T00:00:00.000Z',
    nodes,
    path: projectPath,
  }
}

describe('HistoryIndexService', () => {
  describe('schema and lifecycle', () => {
    it('creates tables and sets user_version on first open', () => {
      // svc.open already ran in beforeEach. Inspect via a direct connection.
      const db = new Database(join(projectPath, '.manifest', 'index', 'history.db'))
      try {
        const version = db.pragma('user_version', { simple: true }) as number
        expect(version).toBe(1)

        const tables = db
          .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
          .all() as Array<{ name: string }>
        expect(tables.map(t => t.name)).toEqual(['node_history', 'snapshot_index_state'])
      } finally {
        db.close()
      }
    })

    it('is idempotent — opening an existing DB does not fail or wipe data', () => {
      svc.recordSnapshot({
        snapshotId: 'baseline',
        snapshotOrder: 0,
        project: project([node('root', 'Root', null)]),
        previousProject: null,
      })

      svc.close()
      svc.open(projectPath)

      const rows = svc.nodeHistory('root')
      expect(rows.length).toBe(1)
    })

    it('throws if used before open()', () => {
      svc.close()
      expect(() => svc.nodeHistory('any')).toThrow(/not open/i)
    })
  })

  describe('recordSnapshot — first snapshot', () => {
    it('inserts one present row per node when previousProject is null', () => {
      const root = node('root', 'Root', null)
      const child = node('a', 'Server A', 'root', 0, { rack: '1' })
      svc.recordSnapshot({
        snapshotId: 'baseline',
        snapshotOrder: 0,
        project: project([root, child]),
        previousProject: null,
      })

      expect(svc.nodeHistory('root').length).toBe(1)
      expect(svc.nodeHistory('root')[0].presence).toBe('present')
      expect(svc.nodeHistory('root')[0].nodeName).toBe('Root')

      expect(svc.nodeHistory('a').length).toBe(1)
      expect(svc.nodeHistory('a')[0].presence).toBe('present')
      expect(svc.nodeHistory('a')[0].properties).toEqual({ rack: '1' })
    })

    it('marks the snapshot complete in snapshot_index_state', () => {
      svc.recordSnapshot({
        snapshotId: 'baseline',
        snapshotOrder: 0,
        project: project([node('root', 'Root', null)]),
        previousProject: null,
      })
      expect(svc.recordedSnapshotIds().has('baseline')).toBe(true)
      expect(svc.incompleteSnapshotIds()).toEqual([])
    })
  })

  describe('recordSnapshot — delta encoding', () => {
    it('skips rows for nodes whose state did not change', () => {
      const root = node('root', 'Root', null)
      const a = node('a', 'A', 'root', 0, { v: 1 })

      svc.recordSnapshot({
        snapshotId: 's0', snapshotOrder: 0,
        project: project([root, a]), previousProject: null,
      })
      svc.recordSnapshot({
        snapshotId: 's1', snapshotOrder: 1,
        project: project([root, a]), previousProject: project([root, a]),
      })

      // Only the s0 row exists for each — s1 was a no-op (no changes).
      expect(svc.nodeHistory('root').length).toBe(1)
      expect(svc.nodeHistory('a').length).toBe(1)
      expect(svc.nodeHistory('a')[0].snapshotId).toBe('s0')

      // s1 still recorded as complete in snapshot_index_state.
      expect(svc.recordedSnapshotIds().has('s1')).toBe(true)
    })

    it('inserts a row when name changes', () => {
      const root = node('root', 'Root', null)
      const a0 = node('a', 'Server A', 'root', 0)
      const a1 = node('a', 'Server Alpha', 'root', 0)

      svc.recordSnapshot({ snapshotId: 's0', snapshotOrder: 0, project: project([root, a0]), previousProject: null })
      svc.recordSnapshot({ snapshotId: 's1', snapshotOrder: 1, project: project([root, a1]), previousProject: project([root, a0]) })

      const hist = svc.nodeHistory('a')
      expect(hist.map(r => [r.snapshotId, r.nodeName])).toEqual([
        ['s0', 'Server A'],
        ['s1', 'Server Alpha'],
      ])
    })

    it('inserts a row when properties change', () => {
      const root = node('root', 'Root', null)
      const a0 = node('a', 'A', 'root', 0, { firmware: '1.0' })
      const a1 = node('a', 'A', 'root', 0, { firmware: '2.0' })

      svc.recordSnapshot({ snapshotId: 's0', snapshotOrder: 0, project: project([root, a0]), previousProject: null })
      svc.recordSnapshot({ snapshotId: 's1', snapshotOrder: 1, project: project([root, a1]), previousProject: project([root, a0]) })

      const hist = svc.nodeHistory('a')
      expect(hist.length).toBe(2)
      expect(hist[1].properties).toEqual({ firmware: '2.0' })
    })

    it('inserts a row when parent or order changes', () => {
      const root = node('root', 'Root', null)
      const p2 = node('p2', 'Parent 2', 'root', 1)
      const a0 = node('a', 'A', 'root', 0)
      const aMoved = node('a', 'A', 'p2', 0)

      svc.recordSnapshot({ snapshotId: 's0', snapshotOrder: 0, project: project([root, p2, a0]), previousProject: null })
      svc.recordSnapshot({ snapshotId: 's1', snapshotOrder: 1, project: project([root, p2, aMoved]), previousProject: project([root, p2, a0]) })

      const hist = svc.nodeHistory('a')
      expect(hist.length).toBe(2)
      expect(hist[0].parentId).toBe('root')
      expect(hist[1].parentId).toBe('p2')
    })

    it('treats property key set differences as a change', () => {
      const root = node('root', 'Root', null)
      const a0 = node('a', 'A', 'root', 0, { x: 1 })
      const a1 = node('a', 'A', 'root', 0, { x: 1, y: 2 })

      svc.recordSnapshot({ snapshotId: 's0', snapshotOrder: 0, project: project([root, a0]), previousProject: null })
      svc.recordSnapshot({ snapshotId: 's1', snapshotOrder: 1, project: project([root, a1]), previousProject: project([root, a0]) })

      expect(svc.nodeHistory('a').length).toBe(2)
    })
  })

  describe('recordSnapshot — deletion', () => {
    it('inserts presence=absent row when a node disappears', () => {
      const root = node('root', 'Root', null)
      const a = node('a', 'A', 'root', 0)

      svc.recordSnapshot({ snapshotId: 's0', snapshotOrder: 0, project: project([root, a]), previousProject: null })
      svc.recordSnapshot({ snapshotId: 's1', snapshotOrder: 1, project: project([root]), previousProject: project([root, a]) })

      const hist = svc.nodeHistory('a')
      expect(hist.length).toBe(2)
      expect(hist[0].presence).toBe('present')
      expect(hist[1].presence).toBe('absent')
      expect(hist[1].nodeName).toBeNull()
      expect(hist[1].properties).toBeNull()
    })

    it('does not insert anything for a node that was never present', () => {
      const root = node('root', 'Root', null)
      svc.recordSnapshot({ snapshotId: 's0', snapshotOrder: 0, project: project([root]), previousProject: null })
      expect(svc.nodeHistory('phantom').length).toBe(0)
    })
  })

  describe('recordSnapshot — idempotency', () => {
    it('re-recording the same snapshot id replaces rows in place (no duplicates)', () => {
      const root = node('root', 'Root', null)

      svc.recordSnapshot({ snapshotId: 's0', snapshotOrder: 0, project: project([root]), previousProject: null })
      svc.recordSnapshot({ snapshotId: 's0', snapshotOrder: 0, project: project([root]), previousProject: null })

      expect(svc.nodeHistory('root').length).toBe(1)
    })
  })

  describe('nodeHistory ordering', () => {
    it('returns rows sorted by snapshot_order ascending', () => {
      const root = node('root', 'Root', null)
      const v1 = node('a', 'A', 'root', 0, { v: 1 })
      const v2 = node('a', 'A', 'root', 0, { v: 2 })
      const v3 = node('a', 'A', 'root', 0, { v: 3 })

      // Record out of chronological order to prove sort is by snapshot_order, not insert order.
      svc.recordSnapshot({ snapshotId: 's2', snapshotOrder: 2, project: project([root, v3]), previousProject: project([root, v2]) })
      svc.recordSnapshot({ snapshotId: 's0', snapshotOrder: 0, project: project([root, v1]), previousProject: null })
      svc.recordSnapshot({ snapshotId: 's1', snapshotOrder: 1, project: project([root, v2]), previousProject: project([root, v1]) })

      const hist = svc.nodeHistory('a')
      expect(hist.map(r => r.snapshotOrder)).toEqual([0, 1, 2])
    })
  })

  describe('snapshot completeness tracking', () => {
    it('exposes complete vs incomplete snapshot ids', () => {
      svc.recordSnapshot({
        snapshotId: 'good', snapshotOrder: 0,
        project: project([node('root', 'Root', null)]),
        previousProject: null,
      })

      // Manually inject an incomplete row to simulate a torn write.
      const db = new Database(join(projectPath, '.manifest', 'index', 'history.db'))
      try {
        db.prepare(
          `INSERT INTO snapshot_index_state (snapshot_id, expected_count, actual_count, complete)
           VALUES (?, ?, ?, ?)`
        ).run('partial', 5, 2, 0)
      } finally {
        db.close()
      }

      // Re-open so the new row is visible.
      svc.close()
      svc.open(projectPath)

      expect(svc.recordedSnapshotIds()).toEqual(new Set(['good']))
      expect(svc.incompleteSnapshotIds()).toEqual(['partial'])
    })
  })

  describe('persistence', () => {
    it('persists rows across close/open cycles', () => {
      svc.recordSnapshot({
        snapshotId: 's0', snapshotOrder: 0,
        project: project([node('root', 'Root', null)]),
        previousProject: null,
      })
      svc.close()

      // The .db file should survive.
      expect(existsSync(join(projectPath, '.manifest', 'index', 'history.db'))).toBe(true)

      svc.open(projectPath)
      expect(svc.nodeHistory('root').length).toBe(1)
    })
  })
})
