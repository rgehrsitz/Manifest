import { describe, expect, it } from 'vitest'
import { buildTree } from '../../../src/renderer/src/lib/tree'
import { collectTypeaheadMatches, splitHighlight, cycleIndex } from '../../../src/renderer/src/lib/tree-typeahead'
import type { ManifestNode } from '../../../src/shared/types'

function node(id: string, parentId: string | null, order = 0, name = id): ManifestNode {
  return { id, parentId, name, order, properties: {}, created: '', modified: '' }
}

// Lab → Room A (Rack 1 → Power Supply, Rack 2) , Room B (Backup Rack)
function labTree() {
  return buildTree([
    node('root', null, 0, 'Lab'),
    node('roomA', 'root', 0, 'Room A'),
    node('roomB', 'root', 1, 'Room B'),
    node('rack1', 'roomA', 0, 'Rack 1'),
    node('rack2', 'roomA', 1, 'Rack 2'),
    node('psu', 'rack1', 0, 'Power Supply'),
    node('backup', 'roomB', 0, 'Backup Rack'),
  ])
}

describe('collectTypeaheadMatches', () => {
  it('returns matching node ids in tree pre-order (depth-first, root-first)', () => {
    const matches = collectTypeaheadMatches(labTree(), 'rack')
    // pre-order: Room A's racks before Room B's backup rack.
    expect(matches).toEqual(['rack1', 'rack2', 'backup'])
  })

  it('is case-insensitive and matches substrings anywhere in the name', () => {
    expect(collectTypeaheadMatches(labTree(), 'POWER')).toEqual(['psu'])
    expect(collectTypeaheadMatches(labTree(), 'oom a')).toEqual(['roomA'])
  })

  it('never returns the root node even when its name matches', () => {
    expect(collectTypeaheadMatches(labTree(), 'lab')).toEqual([])
  })

  it('returns no matches for an empty/whitespace query or null tree', () => {
    expect(collectTypeaheadMatches(labTree(), '')).toEqual([])
    expect(collectTypeaheadMatches(labTree(), '   ')).toEqual([])
    expect(collectTypeaheadMatches(null, 'rack')).toEqual([])
  })

  it('returns an empty array when nothing matches', () => {
    expect(collectTypeaheadMatches(labTree(), 'zzz')).toEqual([])
  })

  it('returns a single match when only one node matches', () => {
    expect(collectTypeaheadMatches(labTree(), 'backup')).toEqual(['backup'])
  })

  it('treats internal/trailing spaces as significant (Space extends the query)', () => {
    // "rack " (trailing space) matches "Rack 1" / "Rack 2" but NOT "Backup Rack"
    // (no trailing space), so the space narrows the set rather than being trimmed.
    expect(collectTypeaheadMatches(labTree(), 'rack ')).toEqual(['rack1', 'rack2'])
  })
})

describe('cycleIndex', () => {
  it('steps forward and wraps at the end', () => {
    expect(cycleIndex(0, 3, false)).toBe(1)
    expect(cycleIndex(2, 3, false)).toBe(0) // wrap
  })

  it('steps backward and wraps at the start', () => {
    expect(cycleIndex(2, 3, true)).toBe(1)
    expect(cycleIndex(0, 3, true)).toBe(2) // wrap
  })

  it('is a no-op (0) for an empty match set', () => {
    expect(cycleIndex(0, 0, false)).toBe(0)
    expect(cycleIndex(0, 0, true)).toBe(0)
  })
})

describe('splitHighlight', () => {
  it('splits every occurrence into matched/unmatched segments (case-insensitive)', () => {
    expect(splitHighlight('Rack 1 rack', 'rack')).toEqual([
      { text: 'Rack', match: true },
      { text: ' 1 ', match: false },
      { text: 'rack', match: true },
    ])
  })

  it('returns a single unmatched segment when the query is empty or absent', () => {
    expect(splitHighlight('Power Supply', '')).toEqual([{ text: 'Power Supply', match: false }])
    expect(splitHighlight('Power Supply', 'xyz')).toEqual([{ text: 'Power Supply', match: false }])
  })

  it('preserves original casing of the matched text', () => {
    expect(splitHighlight('PowerSupply', 'supply')).toEqual([
      { text: 'Power', match: false },
      { text: 'Supply', match: true },
    ])
  })

  it('treats a whitespace-only query as empty (single unmatched segment)', () => {
    // The query is trimmed before matching, so spaces alone highlight nothing —
    // distinct code path from the literal empty string.
    expect(splitHighlight('Rack 1', '   ')).toEqual([{ text: 'Rack 1', match: false }])
  })

  it('handles consecutive matches with no unmatched gap between them', () => {
    // Each iteration finds the needle exactly at the cursor, so the
    // leading-unmatched push is skipped repeatedly; trailing text is still kept.
    expect(splitHighlight('aaab', 'a')).toEqual([
      { text: 'a', match: true },
      { text: 'a', match: true },
      { text: 'a', match: true },
      { text: 'b', match: false },
    ])
  })

  it('returns a single matched segment when the query equals the whole text', () => {
    expect(splitHighlight('Rack', 'rack')).toEqual([{ text: 'Rack', match: true }])
  })

  it('returns a single unmatched segment when the query is longer than the text', () => {
    expect(splitHighlight('ab', 'abcdef')).toEqual([{ text: 'ab', match: false }])
  })

  it('keeps spaces in the needle so the highlighted span includes them', () => {
    expect(splitHighlight('Rack 1', 'rack ')).toEqual([
      { text: 'Rack ', match: true },
      { text: '1', match: false },
    ])
  })
})
