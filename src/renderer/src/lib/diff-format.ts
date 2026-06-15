// Pure formatting helpers for diff display.
// Extracted from SnapshotDialog.svelte so SnapshotsPanel.svelte and any future
// diff-related components share one implementation.

import type { DiffEntry, TemplateField, TemplateDiffEntry } from '../../../shared/types'

export function formatChangeType(changeType: DiffEntry['changeType']): string {
  switch (changeType) {
    case 'property-changed': return 'Property Changed'
    case 'template-changed': return 'Template Changed'
    case 'order-changed':    return 'Order Changed'
    default: return changeType.charAt(0).toUpperCase() + changeType.slice(1)
  }
}

// A node's template binding shown in a diff. null / empty → "(none)".
export function formatTemplateRef(value: unknown): string {
  if (value === null || value === undefined || value === '') return '(none)'
  return String(value)
}

export function formatPath(path: string[], nodeName: string): string {
  return [...path, nodeName].join(' / ')
}

export function severityClass(severity: DiffEntry['severity']): string {
  switch (severity) {
    case 'High':   return 'border-amber-200 bg-amber-50/70'
    case 'Medium': return 'border-sky-200 bg-sky-50/60'
    case 'Low':    return 'border-stone-200 bg-stone-50'
  }
}

export function severityBadgeClass(severity: DiffEntry['severity']): string {
  switch (severity) {
    case 'High':   return 'bg-amber-100 text-amber-700'
    case 'Medium': return 'bg-sky-100 text-sky-700'
    case 'Low':    return 'bg-stone-200 text-stone-600'
  }
}

export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return 'root'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value, null, 2)
}

export function describePropertyChange(diff: DiffEntry): string[] {
  const before = (diff.oldValue ?? {}) as Record<string, unknown>
  const after  = (diff.newValue ?? {}) as Record<string, unknown>
  const keys   = Array.from(new Set([...Object.keys(before), ...Object.keys(after)])).sort()

  return keys.flatMap((key) => {
    if (!(key in before)) return [`Added ${key}: ${formatValue(after[key])}`]
    if (!(key in after))  return [`Removed ${key}`]
    if (before[key] !== after[key]) return [`${key}: ${formatValue(before[key])} → ${formatValue(after[key])}`]
    return []
  })
}

// ─── Template / schema diffs ────────────────────────────────────────────────────

function fieldType(value: unknown): string {
  const f = value as TemplateField | undefined
  return f?.type ?? 'field'
}

// Concise summary of how a single field definition changed (type/options/required).
function describeFieldChange(oldValue: unknown, newValue: unknown): string {
  const a = oldValue as TemplateField | undefined
  const b = newValue as TemplateField | undefined
  const parts: string[] = []
  if (a?.type !== b?.type) parts.push(`${a?.type ?? '?'} → ${b?.type ?? '?'}`)
  const aOpts = (a?.options ?? []).join(', ')
  const bOpts = (b?.options ?? []).join(', ')
  if (aOpts !== bOpts) parts.push('options changed')
  if ((a?.required ?? false) !== (b?.required ?? false)) {
    parts.push(b?.required ? 'now required' : 'no longer required')
  }
  return parts.length > 0 ? parts.join('; ') : 'updated'
}

export function describeTemplateChange(e: TemplateDiffEntry): string {
  const label = e.templateLabel || e.templateId
  switch (e.changeType) {
    case 'template-added':     return `Added template "${label}"`
    case 'template-removed':   return `Removed template "${label}"`
    case 'template-relabeled': return `Renamed template ${e.templateId}: "${String(e.oldValue)}" → "${String(e.newValue)}"`
    case 'field-added':        return `${label}: added field "${e.fieldKey}" (${fieldType(e.newValue)})`
    case 'field-removed':      return `${label}: removed field "${e.fieldKey}"`
    case 'field-changed':      return `${label}: field "${e.fieldKey}" changed (${describeFieldChange(e.oldValue, e.newValue)})`
  }
}
