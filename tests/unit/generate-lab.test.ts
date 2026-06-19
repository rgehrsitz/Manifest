// Regression tests for the lab generator (scripts/generate-lab.mjs). These guard
// two bugs the dogfood pass fixed:
//   1. The sample CSV was serialized from the day-0 project (stale) instead of
//      the final post-churn manifest, so re-importing it no longer round-tripped.
//   2. Structural churn was probabilistic and never fired with seed 42, so the
//      generated timeline exercised only 1 of 7 node diff ChangeTypes.
// Pure functions only (generateTimeline / sampleCsv / planImport / diffProjects) —
// no filesystem, git, or sqlite, so the test is fast and runs under any ABI.
import { describe, it, expect } from 'vitest'
// @ts-expect-error — JS module without type declarations; typed as any at runtime.
import { generateTimeline } from '../../scripts/generate-lab.mjs'
import { parseCsv } from '../../src/shared/csv'
import { planImport } from '../../src/shared/import'
import { diffProjects } from '../../src/shared/diff-engine'
import type { ImportMapping, Project } from '../../src/shared/types'

// Small but structurally complete: needs racks A-01..A-07 for the scheduled
// structural events, and >= 35 days so d34 (the unbind) fires.
const OPTS = {
  seed: 42, days: 40, rooms: 1, racksPerRoom: 8,
  computersPerRack: 1, hwPerComputer: 1, csciPerComputer: 1, customBoardsPerRack: 3,
}

interface Snap { day: number; label: string; name: string; date: string; project: Project }
const timeline = generateTimeline(OPTS) as { initial: Project; snapshots: Snap[]; final: Project; csv: string }
const byDay = (d: number): Project => {
  const s = timeline.snapshots.find(x => x.day === d)
  if (!s) throw new Error(`no snapshot for day ${d}`)
  return s.project
}

describe('generate-lab — timeline regression guards', () => {
  it('generates the full 40-day timeline', () => {
    expect(timeline.snapshots).toHaveLength(40)
    expect(timeline.final.nodes.length).toBeGreaterThan(0)
  })

  it('sample CSV round-trips against the final manifest (0 create / 0 update / 0 skip)', () => {
    const rows = parseCsv(timeline.csv)
    const headers = rows[0]
    const data = rows.slice(1)
    expect(data.length).toBeGreaterThan(0)

    const root = timeline.final.nodes.find(n => n.parentId === null)!
    const mapping: ImportMapping = {
      placement: 'path', baseParentId: root.id, nameColumn: 'name',
      pathColumn: 'parent_path', pathSeparator: ' / ', templateId: 'custom-board',
      columns: [
        { header: 'board_type', key: 'board_type', include: true },
        { header: 'revision', key: 'revision', include: true },
        { header: 'serial', key: 'serial', include: true },
        { header: 'status', key: 'status', include: true },
        { header: 'installed_date', key: 'installed_date', include: true },
      ],
      updateExisting: true, keyColumn: 'serial',
    }
    const plan = planImport(data, headers, mapping, timeline.final.templates ?? {}, timeline.final.nodes)
    expect(plan.mappingError).toBeUndefined()
    expect(plan.create).toHaveLength(0)
    expect(plan.update).toHaveLength(0)
    expect(plan.skipped).toHaveLength(0)
  })

  it('each scheduled structural day produces exactly its diff ChangeType', () => {
    const transitions: [number, number, string][] = [
      [5, 6, 'added'], [9, 10, 'renamed'], [15, 16, 'moved'],
      [19, 20, 'order-changed'], [29, 30, 'removed'], [33, 34, 'template-changed'],
    ]
    for (const [from, to, expected] of transitions) {
      const diffs = diffProjects(byDay(from), byDay(to))
      const types = new Set(diffs.map(d => d.changeType))
      expect(types, `d${from}->d${to} should produce ${expected} (got ${[...types].join(',') || 'none'})`).toContain(expected)
    }
  })

  it('the timeline exercises every node diff ChangeType', () => {
    const seen = new Set<string>()
    let prev = timeline.initial
    for (const snap of timeline.snapshots) {
      for (const d of diffProjects(prev, snap.project)) seen.add(d.changeType)
      prev = snap.project
    }
    const ALL = ['added', 'removed', 'renamed', 'moved', 'property-changed', 'template-changed', 'order-changed']
    const missing = ALL.filter(t => !seen.has(t))
    expect(missing, `missing ChangeTypes: ${missing.join(', ') || 'none'}`).toHaveLength(0)
  })
})
