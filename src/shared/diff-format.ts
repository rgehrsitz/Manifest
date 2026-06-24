// Pure, framework-free diff-formatting helpers shared by the renderer's diff
// display (src/renderer/src/lib/diff-format.ts re-exports these) and the
// main-process report exporter (src/shared/report.ts). Keeping them here lets the
// main process format reports without importing renderer code.
//
// NOTE: property-VALUE rendering is deliberately NOT here. The renderer's
// formatValue() renders null as "root" (right for a moved-node parent ref, wrong
// for a property value), and a report must keep null / absent / empty-string
// distinct. report.ts owns that rendering; this module covers the parts whose
// semantics are identical in both consumers.

import type { DiffClassification, DiffEntry, TemplateField, TemplateDiffEntry } from './types'

export const DIFF_CLASSIFICATION_LABELS: Record<DiffClassification, string> = {
  structural: 'Structural',
  dependency: 'Dependency',
  data: 'Data',
  schema: 'Schema',
  ordering: 'Ordering',
}

export const DIFF_CLASSIFICATION_WHY: Record<DiffClassification, string> = {
  structural: 'changes where nodes exist in the hierarchy',
  dependency: 'changes references between nodes',
  data: 'changes recorded names or property values',
  schema: 'changes the template that types this node',
  ordering: 'affects display order only',
}

type ClassifiableDiff = Pick<DiffEntry, 'changeType' | 'context'>

export function classifyDiff(diff: ClassifiableDiff): DiffClassification {
  switch (diff.changeType) {
    case 'added':
    case 'moved':
      return 'structural'
    case 'removed':
      return (diff.context.removalImpact?.incomingReferences.length ?? 0) > 0
        ? 'dependency'
        : 'structural'
    case 'property-changed':
      return Object.values(diff.context.propertyValueLabels ?? {}).some(label => label.old !== label.new)
        ? 'dependency'
        : 'data'
    case 'renamed':
      return 'data'
    case 'template-changed':
      return 'schema'
    case 'order-changed':
      return 'ordering'
  }

  const exhaustive: never = diff.changeType
  return exhaustive
}

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
    case 'template-redescribed': return `${label}: description changed`
    case 'field-added':        return `${label}: added field "${e.fieldKey}" (${fieldType(e.newValue)})`
    case 'field-removed':      return `${label}: removed field "${e.fieldKey}"`
    case 'field-changed':      return `${label}: field "${e.fieldKey}" changed (${describeFieldChange(e.oldValue, e.newValue)})`
  }
}
