import { describe, it, expect } from 'vitest'
import {
  formatDiffReportMarkdown,
  formatDiffReportCsv,
  diffPropertyMaps,
  type ReportContext,
} from '../../../src/shared/report'
import { parseCsv } from '../../../src/shared/csv'
import type { DiffEntry, TemplateDiffEntry } from '../../../src/shared/types'

const ctx: ReportContext = {
  projectName: 'Lab',
  from: { name: 'before', date: '2026-01-01', hash: 'aaaaaaa' },
  to: { name: 'after', date: '2026-01-02', hash: 'bbbbbbb' },
  generatedAt: '2026-06-18T00:00:00.000Z',
  oldPathById: (id) => (id === 'n-moved' ? 'Lab / Old Rack / Widget' : null),
  templateLabelOld: (v) => (v ? `tplOld(${String(v)})` : '(none)'),
  templateLabelNew: (v) => (v ? `tplNew(${String(v)})` : '(none)'),
}

function entry(over: Partial<DiffEntry> & Pick<DiffEntry, 'changeType'>): DiffEntry {
  return {
    nodeId: 'n1',
    severity: 'Medium',
    context: { nodeName: 'Widget', parentName: 'Rack A-01', path: ['Lab', 'Rack A-01'] },
    ...over,
  } as DiffEntry
}

describe('diffPropertyMaps', () => {
  it('reports added, removed, and changed keys; ignores unchanged', () => {
    const out = diffPropertyMaps(
      { a: 1, gone: 'x', same: 'eq' },
      { a: 2, added: 'y', same: 'eq' },
    )
    expect(out).toEqual([
      { key: 'a', kind: 'changed', old: '1', new: '2' },
      { key: 'added', kind: 'added', old: '', new: 'y' },
      { key: 'gone', kind: 'removed', old: 'x', new: '' },
    ])
  })

  it('keeps null, empty-string, and absent distinct', () => {
    const out = diffPropertyMaps({ k: 'v', n: null }, { k: '', n: 'now' })
    expect(out).toEqual([
      { key: 'k', kind: 'changed', old: 'v', new: '(empty)' },
      { key: 'n', kind: 'changed', old: '(null)', new: 'now' },
    ])
  })
})

describe('formatDiffReportMarkdown', () => {
  it('renders the header with both snapshots and generated time', () => {
    const md = formatDiffReportMarkdown([], [], ctx)
    expect(md).toContain('# Change Report: Lab')
    expect(md).toContain('**From:** before (2026-01-01 · aaaaaaa)')
    expect(md).toContain('**To:** after (2026-01-02 · bbbbbbb)')
    expect(md).toContain('**Generated:** 2026-06-18T00:00:00.000Z')
  })

  it('says "no changes" only when both node and schema diffs are empty', () => {
    expect(formatDiffReportMarkdown([], [], ctx)).toContain('No changes between before and after.')
    // Schema-only change is NOT "no changes".
    const schemaOnly = formatDiffReportMarkdown([], [
      { templateId: 't1', templateLabel: 'Board', changeType: 'field-added', fieldKey: 'sku', newValue: { type: 'string' } },
    ], ctx)
    expect(schemaOnly).not.toContain('No changes between')
    expect(schemaOnly).toContain('## Schema changes (1)')
  })

  it('renders each node-change section', () => {
    const md = formatDiffReportMarkdown([
      entry({ changeType: 'added', severity: 'High', nodeId: 'a' }),
      entry({ changeType: 'removed', severity: 'High', nodeId: 'r' }),
      entry({ changeType: 'renamed', oldValue: 'Old', newValue: 'Widget', nodeId: 'rn' }),
      entry({ changeType: 'order-changed', severity: 'Low', oldValue: 0, newValue: 3, nodeId: 'o' }),
    ], [], ctx)
    expect(md).toContain('## Added (1)')
    expect(md).toContain('- Lab / Rack A-01 / Widget')
    expect(md).toContain('## Removed (1)')
    expect(md).toContain('## Renamed (1)')
    expect(md).toContain('"Old" → "Widget"')
    expect(md).toContain('## Order changes (1)')
    expect(md).toContain(': 0 → 3')
  })

  it('shows moved as old path → new path', () => {
    const md = formatDiffReportMarkdown([
      entry({ changeType: 'moved', severity: 'High', nodeId: 'n-moved' }),
    ], [], ctx)
    expect(md).toContain('- Lab / Old Rack / Widget → Lab / Rack A-01 / Widget')
  })

  it('expands property changes per key with null/empty markers', () => {
    const md = formatDiffReportMarkdown([
      entry({
        changeType: 'property-changed',
        oldValue: { serial: 'SN-1', note: null },
        newValue: { serial: 'SN-2', note: 'ok', extra: '' },
      }),
    ], [], ctx)
    expect(md).toContain('  - serial: SN-1 → SN-2')
    expect(md).toContain('  - note: (null) → ok')
    expect(md).toContain('  - + extra: (empty)')
  })

  it('resolves template-change labels for both sides', () => {
    const md = formatDiffReportMarkdown([
      entry({ changeType: 'template-changed', oldValue: 'board', newValue: 'panel' }),
    ], [], ctx)
    expect(md).toContain(': tplOld(board) → tplNew(panel)')
  })

  it('renders (none) for a gained/lost template binding (null side)', () => {
    const md = formatDiffReportMarkdown([
      entry({ changeType: 'template-changed', oldValue: null, newValue: 'panel' }),
    ], [], ctx)
    expect(md).toContain(': (none) → tplNew(panel)')
  })

  it('falls back to the node name when a moved node has no resolvable old path', () => {
    const md = formatDiffReportMarkdown([
      entry({ changeType: 'moved', severity: 'High', nodeId: 'unknown' }),
    ], [], ctx)
    expect(md).toContain('- "Widget" → Lab / Rack A-01 / Widget')
  })

  it('escapes Markdown so a value cannot inject structure or markup', () => {
    const out = formatDiffReportMarkdown([
      entry({ changeType: 'added', context: { nodeName: 'Evil\n## Removed', parentName: null, path: ['Lab'] } }),
      entry({ changeType: 'renamed', oldValue: 'a*b', newValue: '[link](x)' }),
    ], [], ctx)
    expect(out).not.toMatch(/\n## Removed/)   // newline collapsed → no injected heading
    expect(out).toContain('Lab / Evil ## Removed')
    expect(out).toContain('a\\*b')             // emphasis escaped
    expect(out).toContain('\\[link\\](x)')     // link brackets escaped
  })

  it('renders all template/schema change kinds via the shared helper', () => {
    const tpl: TemplateDiffEntry[] = [
      { templateId: 't1', templateLabel: 'Board', changeType: 'template-added' },
      { templateId: 't2', templateLabel: 'Panel', changeType: 'field-removed', fieldKey: 'volts' },
    ]
    const md = formatDiffReportMarkdown([], tpl, ctx)
    expect(md).toContain('- Added template "Board"')
    expect(md).toContain('- Panel: removed field "volts"')
  })
})

describe('formatDiffReportCsv', () => {
  it('emits a header and one row per node change', () => {
    const csv = formatDiffReportCsv([
      entry({ changeType: 'added', severity: 'High', nodeId: 'a' }),
      entry({ changeType: 'renamed', oldValue: 'Old', newValue: 'Widget' }),
    ], [], ctx)
    const rows = parseCsv(csv)
    expect(rows[0]).toEqual(['path', 'node', 'change', 'severity', 'property', 'old', 'new'])
    expect(rows[1]).toEqual(['Lab / Rack A-01', 'Widget', 'added', 'High', '', '', ''])
    expect(rows[2]).toEqual(['Lab / Rack A-01', 'Widget', 'renamed', 'Medium', '', 'Old', 'Widget'])
  })

  it('expands a property-changed node to one row per changed key', () => {
    const csv = formatDiffReportCsv([
      entry({
        changeType: 'property-changed',
        oldValue: { serial: 'SN-1', gone: 'x' },
        newValue: { serial: 'SN-2', added: 'y' },
      }),
    ], [], ctx)
    const rows = parseCsv(csv).slice(1) // drop header — keys sorted alphabetically
    expect(rows).toEqual([
      ['Lab / Rack A-01', 'Widget', 'property-added', 'Medium', 'added', '', 'y'],
      ['Lab / Rack A-01', 'Widget', 'property-removed', 'Medium', 'gone', 'x', ''],
      ['Lab / Rack A-01', 'Widget', 'property-changed', 'Medium', 'serial', 'SN-1', 'SN-2'],
    ])
  })

  it('emits rows for removed, moved, template-changed, and order-changed', () => {
    const csv = formatDiffReportCsv([
      entry({ changeType: 'removed', severity: 'High', nodeId: 'r' }),
      entry({ changeType: 'moved', severity: 'High', nodeId: 'n-moved' }),
      entry({ changeType: 'template-changed', oldValue: 'board', newValue: 'panel' }),
      entry({ changeType: 'order-changed', severity: 'Low', oldValue: 0, newValue: 2 }),
    ], [], ctx)
    const rows = parseCsv(csv).slice(1)
    expect(rows[0]).toEqual(['Lab / Rack A-01', 'Widget', 'removed', 'High', '', '', ''])
    // moved: old = resolved old path, new = full new path.
    expect(rows[1]).toEqual(['Lab / Rack A-01', 'Widget', 'moved', 'High', '', 'Lab / Old Rack / Widget', 'Lab / Rack A-01 / Widget'])
    // template-changed: old/new = resolved labels.
    expect(rows[2]).toEqual(['Lab / Rack A-01', 'Widget', 'template-changed', 'Medium', '', 'tplOld(board)', 'tplNew(panel)'])
    expect(rows[3]).toEqual(['Lab / Rack A-01', 'Widget', 'order-changed', 'Low', '', '0', '2'])
  })

  it('resolves a null template side to (none) [gain/lose binding]', () => {
    const csv = formatDiffReportCsv([
      entry({ changeType: 'template-changed', oldValue: null, newValue: 'panel' }),
    ], [], ctx)
    expect(parseCsv(csv)[1]).toEqual(['Lab / Rack A-01', 'Widget', 'template-changed', 'Medium', '', '(none)', 'tplNew(panel)'])
  })

  it('falls back to an empty old-path cell when a moved node has no resolvable old path', () => {
    const csv = formatDiffReportCsv([
      entry({ changeType: 'moved', severity: 'High', nodeId: 'unknown' }),
    ], [], ctx)
    expect(parseCsv(csv)[1]).toEqual(['Lab / Rack A-01', 'Widget', 'moved', 'High', '', '', 'Lab / Rack A-01 / Widget'])
  })

  it('records a schema-only diff as a notice row (never a silently empty CSV)', () => {
    const tpl: TemplateDiffEntry[] = [
      { templateId: 't1', templateLabel: 'Board', changeType: 'field-added', fieldKey: 'sku', newValue: { type: 'string' } },
    ]
    const rows = parseCsv(formatDiffReportCsv([], tpl, ctx))
    expect(rows[0]).toEqual(['path', 'node', 'change', 'severity', 'property', 'old', 'new'])
    expect(rows[1][2]).toBe('schema-change')
    expect(rows[1][6]).toContain('1 schema change')
  })

  it('is a well-formed header-only CSV when there are no changes at all', () => {
    expect(parseCsv(formatDiffReportCsv([], [], ctx))).toEqual([
      ['path', 'node', 'change', 'severity', 'property', 'old', 'new'],
    ])
  })

  it('neutralizes a formula-injection node name', () => {
    const csv = formatDiffReportCsv([
      entry({ changeType: 'added', context: { nodeName: '=cmd()', parentName: null, path: ['Lab'] } }),
    ], [], ctx)
    // serializeCsv prefixes a single quote on =/+/-/@ leaders.
    expect(csv).toContain("'=cmd()")
    expect(parseCsv(csv)[1][1]).toBe("'=cmd()")
  })
})
