import { GHOST_ID_PREFIX } from '../../../shared/merged-tree'

export function diffNodeIdCandidatesFromSelection(selectedId: string): string[] {
  if (!selectedId.startsWith(GHOST_ID_PREFIX)) return [selectedId]

  const rawGhostTargetId = selectedId.slice(GHOST_ID_PREFIX.length)
  return rawGhostTargetId.length > 0
    ? [selectedId, rawGhostTargetId]
    : [selectedId]
}
