import type { DiffClassification, DiffEntry, TemplateDiffEntry } from '../../../shared/types'
import { DIFF_CLASSIFICATION_LABELS } from '../../../shared/diff-format'

export interface ReviewInsight {
  label: string
  detail: string
  severity: DiffEntry['severity']
  classification: DiffClassification
}

function plural(count: number, singular: string, pluralLabel = `${singular}s`): string {
  return count === 1 ? singular : pluralLabel
}

function changedPropertyKeys(diff: DiffEntry): string[] {
  if (diff.changeType !== 'property-changed') return []
  const before = (diff.oldValue ?? {}) as Record<string, unknown>
  const after = (diff.newValue ?? {}) as Record<string, unknown>
  return Array.from(new Set([...Object.keys(before), ...Object.keys(after)]))
    .filter(key => before[key] !== after[key])
    .sort()
}

function mostCommonClassification(diffs: DiffEntry[]): DiffClassification {
  const counts = new Map<DiffClassification, number>()
  for (const diff of diffs) {
    counts.set(diff.classification, (counts.get(diff.classification) ?? 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'structural'
}

function classificationBreakdown(diffs: DiffEntry[]): string {
  const counts = new Map<DiffClassification, number>()
  for (const diff of diffs) {
    counts.set(diff.classification, (counts.get(diff.classification) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([classification, count]) => `${count} ${DIFF_CLASSIFICATION_LABELS[classification].toLowerCase()}`)
    .join(', ')
}

function schemaSeverity(templateChanges: TemplateDiffEntry[]): DiffEntry['severity'] {
  return templateChanges.some(change =>
    change.changeType === 'template-removed' ||
    change.changeType === 'field-removed'
  ) ? 'High' : 'Medium'
}

export function buildReviewInsights(
  allDiffs: DiffEntry[],
  templateChanges: TemplateDiffEntry[] = []
): ReviewInsight[] {
  const insights: ReviewInsight[] = []

  let removalsWithReferences = 0
  let brokenReferenceCount = 0
  let cascadingRemovals = 0
  let removedDescendantCount = 0
  for (const diff of allDiffs) {
    if (diff.changeType !== 'removed') continue
    const impact = diff.context.removalImpact
    const descendants = impact?.descendants.length ?? 0
    const references = impact?.incomingReferences.length ?? 0
    if (references > 0) {
      removalsWithReferences++
      brokenReferenceCount += references
    }
    if (descendants > 0) {
      cascadingRemovals++
      removedDescendantCount += descendants
    }
  }

  if (brokenReferenceCount > 0) {
    insights.push({
      label: `${brokenReferenceCount} broken incoming ${plural(brokenReferenceCount, 'reference')}`,
      detail: `Dependency risk: ${removalsWithReferences} removed ${plural(removalsWithReferences, 'node')} still had dependents.`,
      severity: 'High',
      classification: 'dependency',
    })
  }

  if (removedDescendantCount > 0) {
    insights.push({
      label: `${cascadingRemovals} ${plural(cascadingRemovals, 'removal')} includes ${removedDescendantCount} ${plural(removedDescendantCount, 'descendant')}`,
      detail: 'Structural impact: review cascade impact before treating child removals individually.',
      severity: 'High',
      classification: 'structural',
    })
  }

  const highDiffs = allDiffs.filter(diff => diff.severity === 'High')
  if (highDiffs.length > 0) {
    insights.push({
      label: `${highDiffs.length} high-priority ${plural(highDiffs.length, 'change')}`,
      detail: `Priority mix: ${classificationBreakdown(highDiffs)}.`,
      severity: 'High',
      classification: mostCommonClassification(highDiffs),
    })
  }

  if (templateChanges.length > 0) {
    insights.push({
      label: `${templateChanges.length} schema ${plural(templateChanges.length, 'change')}`,
      detail: 'Schema impact: template or field definitions changed.',
      severity: schemaSeverity(templateChanges),
      classification: 'schema',
    })
  }

  const propertyCounts = new Map<string, number>()
  for (const diff of allDiffs) {
    for (const key of changedPropertyKeys(diff)) {
      propertyCounts.set(key, (propertyCounts.get(key) ?? 0) + 1)
    }
  }
  for (const [key, count] of [...propertyCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)) {
    if (count < 2) continue
    insights.push({
      label: `${count} changes to "${key}"`,
      detail: 'Data pattern: likely a repeated field update.',
      severity: 'Medium',
      classification: 'data',
    })
  }

  const parentCounts = new Map<string, number>()
  for (const diff of allDiffs) {
    const path = diff.context.path.join(' / ') || '(root)'
    parentCounts.set(path, (parentCounts.get(path) ?? 0) + 1)
  }
  const [path, count] = [...parentCounts.entries()].sort((a, b) => b[1] - a[1])[0] ?? []
  if (path && count >= 3) {
    insights.push({
      label: `${count} changes under ${path}`,
      detail: 'Structural concentration: this branch carries most of the activity.',
      severity: 'Medium',
      classification: 'structural',
    })
  }

  const displayOnly = allDiffs.filter(diff =>
    diff.classification === 'ordering' ||
    (diff.classification === 'data' && diff.severity === 'Low')
  ).length
  if (displayOnly > 0) {
    insights.push({
      label: `${displayOnly} display-only ${plural(displayOnly, 'change')}`,
      detail: 'Ordering and low-importance data changes can usually be skimmed after higher-risk findings.',
      severity: 'Low',
      classification: 'ordering',
    })
  }

  return insights.slice(0, 4)
}
