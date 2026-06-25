import type { DiffClassification, DiffEntry, TemplateDiffEntry } from '../../../shared/types'
import { DIFF_CLASSIFICATION_LABELS } from '../../../shared/diff-format'

export interface ReviewInsight {
  id: string
  label: string
  detail: string
  severity: DiffEntry['severity']
  classification: DiffClassification
  match: {
    nodeIds: string[]
    diffKeys?: string[]
    schema?: boolean
    expandRemovalImpact?: boolean
  }
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

function uniqueNodeIds(diffs: DiffEntry[]): string[] {
  return Array.from(new Set(diffs.map(diff => diff.nodeId))).sort()
}

function diffKey(diff: DiffEntry): string {
  return `${diff.nodeId} ${diff.changeType}`
}

function uniqueDiffKeys(diffs: DiffEntry[]): string[] {
  return Array.from(new Set(diffs.map(diffKey))).sort()
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'root'
}

export function focusMatchesDiff(insight: ReviewInsight | null, diff: DiffEntry): boolean {
  if (!insight) return true
  if ((insight.match.diffKeys?.length ?? 0) > 0) return insight.match.diffKeys!.includes(diffKey(diff))
  return insight.match.nodeIds.includes(diff.nodeId)
}

export function filterDiffsByReviewInsight(
  diffs: DiffEntry[],
  insight: ReviewInsight | null
): DiffEntry[] {
  if (!insight) return diffs
  return diffs.filter(diff => focusMatchesDiff(insight, diff))
}

export function buildReviewInsights(
  allDiffs: DiffEntry[],
  templateChanges: TemplateDiffEntry[] = []
): ReviewInsight[] {
  const insights: ReviewInsight[] = []

  let cascadingRemovals = 0
  let removedDescendantCount = 0
  const cascadeNodeIds = new Set<string>()
  for (const diff of allDiffs) {
    if (diff.changeType !== 'removed') continue
    const impact = diff.context.removalImpact
    const descendants = impact?.descendants.length ?? 0
    if (descendants > 0) {
      cascadingRemovals++
      removedDescendantCount += descendants
      cascadeNodeIds.add(diff.nodeId)
      for (const descendant of impact?.descendants ?? []) cascadeNodeIds.add(descendant.id)
    }
  }

  const removedWithReferences = allDiffs
    .filter(diff => diff.changeType === 'removed' && (diff.context.removalImpact?.incomingReferences.length ?? 0) > 0)
    .sort((a, b) =>
      (b.context.removalImpact?.incomingReferences.length ?? 0) -
      (a.context.removalImpact?.incomingReferences.length ?? 0)
    )
  for (const diff of removedWithReferences) {
    const references = diff.context.removalImpact?.incomingReferences.length ?? 0
    insights.push({
      id: `dependency-removed-${diff.nodeId}`,
      label: `${references} broken incoming ${plural(references, 'reference')} to "${diff.context.nodeName}"`,
      detail: 'Dependency risk: this removed node still had dependents.',
      severity: 'High',
      classification: 'dependency',
      match: { nodeIds: [diff.nodeId], diffKeys: [diffKey(diff)], expandRemovalImpact: true },
    })
  }

  if (removedDescendantCount > 0) {
    insights.push({
      id: 'structural-removal-cascade',
      label: `${cascadingRemovals} ${plural(cascadingRemovals, 'removal')} includes ${removedDescendantCount} ${plural(removedDescendantCount, 'descendant')}`,
      detail: 'Structural impact: review cascade impact before treating child removals individually.',
      severity: 'High',
      classification: 'structural',
      match: { nodeIds: Array.from(cascadeNodeIds).sort(), expandRemovalImpact: true },
    })
  }

  const highDiffs = allDiffs.filter(diff => diff.severity === 'High')
  if (highDiffs.length > 0) {
    insights.push({
      id: 'priority-high',
      label: `${highDiffs.length} high-priority ${plural(highDiffs.length, 'change')}`,
      detail: `Priority mix: ${classificationBreakdown(highDiffs)}.`,
      severity: 'High',
      classification: mostCommonClassification(highDiffs),
      match: { nodeIds: uniqueNodeIds(highDiffs), diffKeys: uniqueDiffKeys(highDiffs) },
    })
  }

  if (templateChanges.length > 0) {
    insights.push({
      id: 'schema-template-changes',
      label: `${templateChanges.length} schema ${plural(templateChanges.length, 'change')}`,
      detail: 'Schema impact: template or field definitions changed.',
      severity: schemaSeverity(templateChanges),
      classification: 'schema',
      match: { nodeIds: [], schema: true },
    })
  }

  const propertyDiffs = new Map<string, DiffEntry[]>()
  for (const diff of allDiffs) {
    for (const key of changedPropertyKeys(diff)) {
      propertyDiffs.set(key, [...(propertyDiffs.get(key) ?? []), diff])
    }
  }
  for (const [index, [key, diffs]] of [...propertyDiffs.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 3).entries()) {
    if (diffs.length < 2) continue
    insights.push({
      id: `data-property-${index + 1}-${slug(key)}`,
      label: `${diffs.length} changes to "${key}"`,
      detail: 'Data pattern: likely a repeated field update.',
      severity: 'Medium',
      classification: 'data',
      match: { nodeIds: uniqueNodeIds(diffs), diffKeys: uniqueDiffKeys(diffs) },
    })
  }

  const parentDiffs = new Map<string, DiffEntry[]>()
  for (const diff of allDiffs) {
    const path = diff.context.path.join(' / ') || '(root)'
    parentDiffs.set(path, [...(parentDiffs.get(path) ?? []), diff])
  }
  const [path, diffs] = [...parentDiffs.entries()].sort((a, b) => b[1].length - a[1].length)[0] ?? []
  if (path && diffs.length >= 3) {
    insights.push({
      id: `structural-branch-${slug(path)}`,
      label: `${diffs.length} changes under ${path}`,
      detail: 'Structural concentration: this branch carries most of the activity.',
      severity: 'Medium',
      classification: 'structural',
      match: { nodeIds: uniqueNodeIds(diffs), diffKeys: uniqueDiffKeys(diffs) },
    })
  }

  const displayOnlyDiffs = allDiffs.filter(diff =>
    diff.classification === 'ordering' ||
    (diff.classification === 'data' && diff.severity === 'Low')
  )
  if (displayOnlyDiffs.length > 0) {
    insights.push({
      id: 'ordering-display-only',
      label: `${displayOnlyDiffs.length} display-only ${plural(displayOnlyDiffs.length, 'change')}`,
      detail: 'Ordering and low-importance data changes can usually be skimmed after higher-risk findings.',
      severity: 'Low',
      classification: 'ordering',
      match: { nodeIds: uniqueNodeIds(displayOnlyDiffs), diffKeys: uniqueDiffKeys(displayOnlyDiffs) },
    })
  }

  return insights.slice(0, 4)
}
