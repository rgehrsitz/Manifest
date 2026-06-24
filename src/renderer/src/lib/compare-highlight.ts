import { GHOST_ID_PREFIX } from '../../../shared/merged-tree'

export function diffNodeIdFromSelection(selectedId: string): string {
  return selectedId.startsWith(GHOST_ID_PREFIX)
    ? selectedId.slice(GHOST_ID_PREFIX.length)
    : selectedId
}
