// Client-side search is intentionally NOT used in Phase 2.
// search:query goes through main (IPC) even though main's implementation
// is currently a linear scan over the same in-memory data.
//
// This keeps the search contract stable: Phase 3 replaces the main-side
// linear scan with SQLite FTS5 without any renderer changes.
//
// This file is a placeholder for any search-related renderer utilities
// (e.g., highlighting matched text in results).

import type { SearchResult } from '../../../shared/types'

// Wrap matching substring in a <mark> tag for display.
export function highlightMatch(text: string, query: string): string {
  if (!query.trim()) return text
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return text.replace(new RegExp(`(${escaped})`, 'gi'), '<mark>$1</mark>')
}

// Group search results by parent name for display.
export function groupByParent(
  results: SearchResult[]
): Map<string | null, SearchResult[]> {
  const groups = new Map<string | null, SearchResult[]>()
  for (const r of results) {
    const key = r.parentName
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(r)
  }
  return groups
}
