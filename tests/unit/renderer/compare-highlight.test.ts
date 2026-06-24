import { describe, expect, it } from 'vitest'
import { diffNodeIdFromSelection } from '../../../src/renderer/src/lib/compare-highlight'

describe('diffNodeIdFromSelection', () => {
  it('keeps live node ids unchanged', () => {
    expect(diffNodeIdFromSelection('rack-a')).toBe('rack-a')
  })

  it('maps ghost selections back to their diff node id', () => {
    expect(diffNodeIdFromSelection('ghost:rack-a')).toBe('rack-a')
  })
})
