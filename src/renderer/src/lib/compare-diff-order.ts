import type { DiffEntry } from '../../../shared/types'
import { formatPath } from './diff-format'

export type CompareOrderMode = 'document' | 'priority'

const SEVERITY_RANK: Record<DiffEntry['severity'], number> = {
  High: 0,
  Medium: 1,
  Low: 2,
}

function fullPath(diff: DiffEntry): string {
  return formatPath(diff.context.path, diff.context.nodeName)
}

function removalImpactScore(diff: DiffEntry): number {
  if (diff.changeType !== 'removed') return 0
  const impact = diff.context.removalImpact
  const references = impact?.incomingReferences.length ?? 0
  const descendants = impact?.descendants.length ?? 0
  return (references > 0 ? 1000 : 0) + references * 10 + descendants
}

export function orderCompareDiffs(diffs: DiffEntry[], mode: CompareOrderMode): DiffEntry[] {
  if (mode === 'document') return diffs

  return [...diffs].sort((a, b) => {
    const severity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
    if (severity !== 0) return severity

    const impact = removalImpactScore(b) - removalImpactScore(a)
    if (impact !== 0) return impact

    return fullPath(a).localeCompare(fullPath(b))
  })
}
