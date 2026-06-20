// Inline "type-to-jump" search over the hierarchy tree. Matches node names
// (case-insensitive substring) and lets the user cycle matches without leaving
// the tree for the full search panel. Pure + framework-agnostic so it can be
// unit-tested and reused by the row renderer.

import type { TreeNode } from './tree'

/**
 * Node ids whose name matches `query` (case-insensitive substring), in tree
 * pre-order (depth-first, root-first) so "next match" cycles top→bottom the way
 * the user reads the tree. Expansion state is ignored: a collapsed match is
 * still reachable (the caller expands its ancestors to reveal it).
 *
 * The root node is skipped — it's the project itself, not a navigable child.
 * An empty/whitespace query yields no matches.
 */
export function collectTypeaheadMatches(root: TreeNode | null, query: string): string[] {
  // Trim only to decide "is there anything to match"; keep the raw query as the
  // needle so internal/trailing spaces are significant (typing `rack ` narrows
  // "Rack 1" away from "Rackmount" — the whole point of letting Space extend an
  // active query).
  if (!root || query.trim().length === 0) return []
  const needle = query.toLowerCase()
  const matches: string[] = []
  const walk = (node: TreeNode, isRoot: boolean): void => {
    if (!isRoot && node.node.name.toLowerCase().includes(needle)) {
      matches.push(node.node.id)
    }
    for (const child of node.children) walk(child, false)
  }
  walk(root, true)
  return matches
}

/**
 * Next index when cycling through `length` matches, wrapping at both ends.
 * `reverse` steps backward. Returns 0 for an empty match set (no-op).
 */
export function cycleIndex(current: number, length: number, reverse: boolean): number {
  if (length <= 0) return 0
  return (current + (reverse ? -1 : 1) + length) % length
}

export interface HighlightSegment {
  text: string
  match: boolean
}

/**
 * Split `text` into matched / unmatched segments for safe (non-HTML) highlight
 * rendering — every case-insensitive occurrence of `query` is flagged. Returns a
 * single unmatched segment when the query is empty or absent from the text, so
 * callers can always render the segments uniformly.
 */
export function splitHighlight(text: string, query: string): HighlightSegment[] {
  // Trim only for the empty/whitespace guard; the actual needle keeps spaces so
  // the highlighted span matches what collectTypeaheadMatches matched on.
  if (query.trim().length === 0) return [{ text, match: false }]
  const needle = query
  const lowerText = text.toLowerCase()
  const lowerNeedle = needle.toLowerCase()
  const segments: HighlightSegment[] = []
  let cursor = 0
  let found = lowerText.indexOf(lowerNeedle, cursor)
  while (found !== -1) {
    if (found > cursor) segments.push({ text: text.slice(cursor, found), match: false })
    segments.push({ text: text.slice(found, found + needle.length), match: true })
    cursor = found + needle.length
    found = lowerText.indexOf(lowerNeedle, cursor)
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), match: false })
  return segments.length > 0 ? segments : [{ text, match: false }]
}
