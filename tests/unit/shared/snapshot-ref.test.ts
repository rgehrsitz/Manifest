import { describe, it, expect } from 'vitest'
import {
  CURRENT_PROJECT_REF,
  CURRENT_PROJECT_LABEL,
  isCurrentRef,
  snapshotRefLabel,
} from '../../../src/shared/snapshot-ref'
import { validateSnapshotName } from '../../../src/shared/validation'

describe('snapshot-ref sentinel', () => {
  it('the sentinel can never collide with a valid snapshot name', () => {
    // This is the load-bearing invariant: the whole sentinel-through-string-API
    // design depends on @current being impossible as a real snapshot name. If
    // validateSnapshotName's allowed charset ever widens to admit '@', this
    // test fails loudly instead of letting a user's snapshot shadow the sentinel.
    expect(validateSnapshotName(CURRENT_PROJECT_REF).valid).toBe(false)
  })

  it('isCurrentRef matches only the sentinel', () => {
    expect(isCurrentRef(CURRENT_PROJECT_REF)).toBe(true)
    expect(isCurrentRef('baseline')).toBe(false)
    expect(isCurrentRef('')).toBe(false)
  })

  it('snapshotRefLabel maps the sentinel to the label and passes names through', () => {
    expect(snapshotRefLabel(CURRENT_PROJECT_REF)).toBe(CURRENT_PROJECT_LABEL)
    expect(snapshotRefLabel('baseline')).toBe('baseline')
  })
})
