// Pure diff-report formatters: turn the existing diff output (DiffEntry[] +
// TemplateDiffEntry[]) into a shareable Markdown report or a tabular CSV. Used by
// the main-process report exporter (ProjectManager.buildReport). No filesystem,
// no Electron — deterministic given its inputs, so it is heavily unit-tested.
//
// Reuses the shared, consumer-agnostic helpers in ./diff-format. Property VALUE
// rendering is owned here (not by diff-format's UI formatValue) because a report
// must keep null / absent / empty-string distinct.

import type { DiffEntry, TemplateDiffEntry } from './types'
import { formatPath, describeTemplateChange } from './diff-format'
import { serializeCsv } from './csv'

export type ReportFormat = 'markdown' | 'csv'

export interface ReportSnapshotMeta {
  name: string
  date: string   // human-readable (caller formats)
  hash: string   // short commit hash
}

export interface ReportContext {
  projectName: string
  from: ReportSnapshotMeta
  to: ReportSnapshotMeta
  generatedAt: string
  // Full old-side path ("A / B / Name") for a node id, or null if it didn't
  // exist in the old snapshot. Used to show moved nodes as old → new path.
  oldPathById: (nodeId: string) => string | null
  // Resolve a template id (old/new side) to its label for template-changed rows.
  templateLabelOld: (id: unknown) => string
  templateLabelNew: (id: unknown) => string
}

// Render a single property value so null / empty-string are not silently lost.
// (absent keys are handled by diffPropertyMaps emitting added/removed.)
function renderValue(v: unknown): string {
  if (v === null) return '(null)'
  if (v === undefined) return ''
  if (v === '') return '(empty)'
  return String(v)
}

export interface PropertyChange {
  key: string
  kind: 'added' | 'removed' | 'changed'
  old: string
  new: string
}

// Expand the whole-map oldValue/newValue of a property-changed DiffEntry into the
// per-key delta. diffProjects emits one entry per node with both full maps, so the
// report must compute which keys actually changed.
export function diffPropertyMaps(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): PropertyChange[] {
  const keys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)])).sort()
  const out: PropertyChange[] = []
  for (const key of keys) {
    const inBefore = key in before
    const inAfter = key in after
    if (inBefore && !inAfter) out.push({ key, kind: 'removed', old: renderValue(before[key]), new: '' })
    else if (!inBefore && inAfter) out.push({ key, kind: 'added', old: '', new: renderValue(after[key]) })
    else if (before[key] !== after[key]) out.push({ key, kind: 'changed', old: renderValue(before[key]), new: renderValue(after[key]) })
  }
  return out
}

function propsOf(v: unknown): Record<string, unknown> {
  return (v ?? {}) as Record<string, unknown>
}

function byType(diffs: DiffEntry[], type: DiffEntry['changeType']): DiffEntry[] {
  return diffs.filter(d => d.changeType === type)
}

function ancestorPath(entry: DiffEntry): string {
  return entry.context.path.join(' / ')
}

function fullPath(entry: DiffEntry): string {
  return formatPath(entry.context.path, entry.context.nodeName)
}

// ─── Markdown ───────────────────────────────────────────────────────────────

export function formatDiffReportMarkdown(
  diffs: DiffEntry[],
  templateDiffs: TemplateDiffEntry[],
  ctx: ReportContext,
): string {
  const added = byType(diffs, 'added')
  const removed = byType(diffs, 'removed')
  const renamed = byType(diffs, 'renamed')
  const moved = byType(diffs, 'moved')
  const propChanged = byType(diffs, 'property-changed')
  const tplChanged = byType(diffs, 'template-changed')
  const orderChanged = byType(diffs, 'order-changed')

  const lines: string[] = []
  lines.push(`# Change Report: ${ctx.projectName}`)
  lines.push('')
  lines.push(`**From:** ${ctx.from.name} (${ctx.from.date} · ${ctx.from.hash})  `)
  lines.push(`**To:** ${ctx.to.name} (${ctx.to.date} · ${ctx.to.hash})  `)
  lines.push(`**Generated:** ${ctx.generatedAt}`)
  lines.push('')

  if (diffs.length === 0 && templateDiffs.length === 0) {
    lines.push(`No changes between ${ctx.from.name} and ${ctx.to.name}.`)
    lines.push('')
    return lines.join('\n')
  }

  lines.push('## Summary')
  lines.push(`- Added: ${added.length}`)
  lines.push(`- Removed: ${removed.length}`)
  lines.push(`- Renamed: ${renamed.length}`)
  lines.push(`- Moved: ${moved.length}`)
  lines.push(`- Property changes: ${propChanged.length} node(s)`)
  lines.push(`- Template changes: ${tplChanged.length}`)
  lines.push(`- Order changes: ${orderChanged.length}`)
  lines.push(`- Schema changes: ${templateDiffs.length}`)
  lines.push('')

  if (added.length > 0) {
    lines.push(`## Added (${added.length})`)
    for (const e of added) lines.push(`- ${fullPath(e)}`)
    lines.push('')
  }
  if (removed.length > 0) {
    lines.push(`## Removed (${removed.length})`)
    for (const e of removed) lines.push(`- ${fullPath(e)}`)
    lines.push('')
  }
  if (renamed.length > 0) {
    lines.push(`## Renamed (${renamed.length})`)
    for (const e of renamed) {
      const where = ancestorPath(e)
      const prefix = where ? `${where} / ` : ''
      lines.push(`- ${prefix}"${String(e.oldValue)}" → "${String(e.newValue)}"`)
    }
    lines.push('')
  }
  if (moved.length > 0) {
    lines.push(`## Moved (${moved.length})`)
    for (const e of moved) {
      const oldP = ctx.oldPathById(e.nodeId) ?? `"${e.context.nodeName}"`
      lines.push(`- ${oldP} → ${fullPath(e)}`)
    }
    lines.push('')
  }
  if (propChanged.length > 0) {
    lines.push(`## Property changes (${propChanged.length} node(s))`)
    for (const e of propChanged) {
      lines.push(`- ${fullPath(e)}`)
      for (const pc of diffPropertyMaps(propsOf(e.oldValue), propsOf(e.newValue))) {
        if (pc.kind === 'added') lines.push(`  - + ${pc.key}: ${pc.new}`)
        else if (pc.kind === 'removed') lines.push(`  - − ${pc.key} (was ${pc.old})`)
        else lines.push(`  - ${pc.key}: ${pc.old} → ${pc.new}`)
      }
    }
    lines.push('')
  }
  if (tplChanged.length > 0) {
    lines.push(`## Template changes (${tplChanged.length})`)
    for (const e of tplChanged) {
      lines.push(`- ${fullPath(e)}: ${ctx.templateLabelOld(e.oldValue)} → ${ctx.templateLabelNew(e.newValue)}`)
    }
    lines.push('')
  }
  if (orderChanged.length > 0) {
    lines.push(`## Order changes (${orderChanged.length})`)
    for (const e of orderChanged) {
      lines.push(`- ${fullPath(e)}: ${String(e.oldValue)} → ${String(e.newValue)}`)
    }
    lines.push('')
  }
  if (templateDiffs.length > 0) {
    lines.push(`## Schema changes (${templateDiffs.length})`)
    for (const t of templateDiffs) lines.push(`- ${describeTemplateChange(t)}`)
    lines.push('')
  }

  return lines.join('\n')
}

// ─── CSV (node changes only; one row per change, property-changes expanded) ───

const CSV_HEADER = ['path', 'node', 'change', 'severity', 'property', 'old', 'new']

// CSV carries node changes only (schema detail lives in the Markdown report). But
// it must never read as "no changes" when a schema-only diff happened — so a
// single notice row records that schema changes exist and where to find them.
export function formatDiffReportCsv(
  diffs: DiffEntry[],
  templateDiffs: TemplateDiffEntry[],
  ctx: ReportContext,
): string {
  const rows: string[][] = [CSV_HEADER]

  if (templateDiffs.length > 0) {
    const n = templateDiffs.length
    rows.push(['', '(schema changes)', 'schema-change', '', '', '', `${n} schema change${n === 1 ? '' : 's'} — see the Markdown report for detail`])
  }

  for (const e of diffs) {
    const path = ancestorPath(e)
    const node = e.context.nodeName
    const base = (change: string, property: string, oldV: string, newV: string): string[] =>
      [path, node, change, e.severity, property, oldV, newV]

    switch (e.changeType) {
      case 'added':
      case 'removed':
        rows.push(base(e.changeType, '', '', ''))
        break
      case 'renamed':
        rows.push(base('renamed', '', String(e.oldValue ?? ''), String(e.newValue ?? '')))
        break
      case 'moved':
        rows.push(base('moved', '', ctx.oldPathById(e.nodeId) ?? '', fullPath(e)))
        break
      case 'template-changed':
        rows.push(base('template-changed', '', ctx.templateLabelOld(e.oldValue), ctx.templateLabelNew(e.newValue)))
        break
      case 'order-changed':
        rows.push(base('order-changed', '', String(e.oldValue ?? ''), String(e.newValue ?? '')))
        break
      case 'property-changed':
        for (const pc of diffPropertyMaps(propsOf(e.oldValue), propsOf(e.newValue))) {
          rows.push(base(`property-${pc.kind}`, pc.key, pc.old, pc.new))
        }
        break
    }
  }

  return serializeCsv(rows)
}
