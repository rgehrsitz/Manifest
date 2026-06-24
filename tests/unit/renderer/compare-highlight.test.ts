import { describe, expect, it } from 'vitest'
import { diffNodeIdCandidatesFromSelection } from '../../../src/renderer/src/lib/compare-highlight'

describe('diffNodeIdCandidatesFromSelection', () => {
  it('keeps live node ids unchanged', () => {
    expect(diffNodeIdCandidatesFromSelection('rack-a')).toEqual(['rack-a'])
  })

  it('prefers exact ghost-prefixed ids before the stripped diff node id', () => {
    expect(diffNodeIdCandidatesFromSelection('ghost:rack-a')).toEqual(['ghost:rack-a', 'rack-a'])
  })

  it('does not add an empty stripped candidate for the prefix alone', () => {
    expect(diffNodeIdCandidatesFromSelection('ghost:')).toEqual(['ghost:'])
  })
})
