import type { DiffEntry } from '../../../shared/types'

export interface ReviewInsight {
  label: string
  detail: string
  severity: DiffEntry['severity']
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

export function buildReviewInsights(allDiffs: DiffEntry[]): ReviewInsight[] {
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
      detail: `${removalsWithReferences} removed ${plural(removalsWithReferences, 'node')} still had dependents.`,
      severity: 'High',
    })
  }

  if (removedDescendantCount > 0) {
    insights.push({
      label: `${cascadingRemovals} ${plural(cascadingRemovals, 'removal')} includes ${removedDescendantCount} ${plural(removedDescendantCount, 'descendant')}`,
      detail: 'Review cascade impact before treating child removals individually.',
      severity: 'High',
    })
  }

  const high = allDiffs.filter(diff => diff.severity === 'High').length
  if (high > 0) {
    insights.push({
      label: `${high} high-priority ${plural(high, 'change')}`,
      detail: 'Review these before lower-priority edits.',
      severity: 'High',
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
      detail: 'Likely a repeated field update.',
      severity: 'Medium',
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
      detail: 'This branch carries most of the activity.',
      severity: 'Medium',
    })
  }

  return insights.slice(0, 4)
}
