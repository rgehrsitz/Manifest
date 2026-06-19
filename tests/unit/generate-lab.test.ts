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

// Small but structurally complete. The shape requirements (racks A-01..A-07,
// >= 2 boards/rack, >= 34 days) are now ENFORCED by validateOptions, so an
// under-spec config is rejected rather than silently skipping a ChangeType.
const OPTS = {
  seed: 42, days: 40, rooms: 1, racksPerRoom: 8,
  computersPerRack: 1, hwPerComputer: 1, csciPerComputer: 1, customBoardsPerRack: 3,
}

const ALL_CHANGE_TYPES = ['added', 'removed', 'renamed', 'moved', 'property-changed', 'template-changed', 'order-changed']
function changeTypesAcross(tl: { initial: Project; snapshots: Snap[] }): Set<string> {
  const seen = new Set<string>()
  let prev = tl.initial
  for (const snap of tl.snapshots) {
    for (const d of diffProjects(prev, snap.project)) seen.add(d.changeType)
    prev = snap.project
  }
  return seen
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
    const seen = changeTypesAcross(timeline)
    const missing = ALL_CHANGE_TYPES.filter(t => !seen.has(t))
    expect(missing, `missing ChangeTypes: ${missing.join(', ') || 'none'}`).toHaveLength(0)
  })

  // The structural events fire on fixed days against specific racks/boards, so a
  // too-small config can't produce the full timeline. Rather than silently drop a
  // ChangeType, validateOptions must reject such configs up front.
  it('rejects configs that cannot produce the full structural timeline', () => {
    expect(() => generateTimeline({ ...OPTS, customBoardsPerRack: 1 }))
      .toThrow(/custom-boards-per-rack must be at least 2/)   // day-20 order-changed needs 2 boards
    expect(() => generateTimeline({ ...OPTS, racksPerRoom: 6 }))
      .toThrow(/racks-per-room must be at least 7/)           // day-34 template-changed needs Rack A-07
    expect(() => generateTimeline({ ...OPTS, days: 33 }))
      .toThrow(/days must be at least 34/)                    // day-34 unbind must fire
  })

  // Bracket the validation: the smallest config it accepts must still produce
  // full coverage, so the thresholds are correct (not arbitrary).
  it('the minimum accepted config still exercises every ChangeType', () => {
    const min = generateTimeline({
      seed: 42, rooms: 1, racksPerRoom: 7, customBoardsPerRack: 2, days: 34,
      computersPerRack: 1, hwPerComputer: 1, csciPerComputer: 1,
    }) as { initial: Project; snapshots: Snap[] }
    const missing = ALL_CHANGE_TYPES.filter(t => !changeTypesAcross(min).has(t))
    expect(missing, `missing ChangeTypes at minimum config: ${missing.join(', ') || 'none'}`).toHaveLength(0)
  })
})
