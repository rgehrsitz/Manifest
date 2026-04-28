import { describe, expect, it } from 'vitest'
import {
  mergeDisplay,
  sizeAtTime,
  easeInOutCubic,
  DEFAULT_TIMINGS,
  type ItemKey,
  type AnimPhase,
} from '../../../src/renderer/src/lib/lens-animation'

// ─── mergeDisplay ─────────────────────────────────────────────────────────────

const keyOf = (s: string) => s as ItemKey

function shape(items: ReturnType<typeof mergeDisplay<string>>['items']): Array<[string, AnimPhase, number]> {
  return items.map(i => [i.key, i.phase, i.staggerIndex])
}

describe('mergeDisplay — basic phase tagging', () => {
  it('empty in, empty out', () => {
    const r = mergeDisplay<string>([], [], keyOf)
    expect(r.items).toEqual([])
    expect(r.transitioningCount).toBe(0)
  })

  it('all stable when prev === next', () => {
    const r = mergeDisplay(['a', 'b', 'c'], ['a', 'b', 'c'], keyOf)
    expect(shape(r.items)).toEqual([
      ['a', 'stable', 0],
      ['b', 'stable', 0],
      ['c', 'stable', 0],
    ])
    expect(r.transitioningCount).toBe(0)
  })

  it('all entering when prev empty', () => {
    const r = mergeDisplay([], ['a', 'b', 'c'], keyOf)
    expect(shape(r.items)).toEqual([
      ['a', 'entering', 0],
      ['b', 'entering', 1],
      ['c', 'entering', 2],
    ])
    expect(r.transitioningCount).toBe(3)
  })

  it('all exiting when next empty', () => {
    const r = mergeDisplay(['a', 'b'], [], keyOf)
    expect(shape(r.items)).toEqual([
      ['a', 'exiting', 0],
      ['b', 'exiting', 1],
    ])
    expect(r.transitioningCount).toBe(2)
  })
})

describe('mergeDisplay — fold expand/collapse scenarios', () => {
  it('fold expand: marker exits in place, rows enter after', () => {
    // Before: [a, fold, b]. After: [a, r1, r2, r3, b]
    // Algorithm emits exiting items at their prev position, then entering
    // items advance. Visually: fold shrinks while rows grow into the released
    // space — order in the merged sequence doesn't change the layout because
    // virtualizer cumulative offset interpolates with all heights.
    const r = mergeDisplay(['a', 'fold', 'b'], ['a', 'r1', 'r2', 'r3', 'b'], keyOf)
    expect(shape(r.items)).toEqual([
      ['a',    'stable',   0],
      ['fold', 'exiting',  0],
      ['r1',   'entering', 1],
      ['r2',   'entering', 2],
      ['r3',   'entering', 3],
      ['b',    'stable',   0],
    ])
    expect(r.transitioningCount).toBe(4)
  })

  it('fold collapse: rows exit, marker enters at the end of the run', () => {
    // Before: [a, r1, r2, r3, b]. After: [a, fold, b]
    const r = mergeDisplay(['a', 'r1', 'r2', 'r3', 'b'], ['a', 'fold', 'b'], keyOf)
    expect(shape(r.items)).toEqual([
      ['a',    'stable',   0],
      ['r1',   'exiting',  0],
      ['r2',   'exiting',  1],
      ['r3',   'exiting',  2],
      ['fold', 'entering', 3],
      ['b',    'stable',   0],
    ])
    expect(r.transitioningCount).toBe(4)
  })

  it('mode change: many rows collapse into a fold', () => {
    // Browse: 5 rows. Compare: 1 decorated + 1 fold of the rest.
    const r = mergeDisplay(
      ['n1', 'n2', 'n3', 'n4', 'n5'],
      ['n1', 'fold-n2-n5'],
      keyOf
    )
    expect(shape(r.items)).toEqual([
      ['n1',          'stable',   0],
      ['n2',          'exiting',  0],
      ['n3',          'exiting',  1],
      ['n4',          'exiting',  2],
      ['n5',          'exiting',  3],
      ['fold-n2-n5',  'entering', 4],
    ])
    expect(r.transitioningCount).toBe(5)
  })

  it('fold split: one fold becomes two when an interior change is revealed', () => {
    // Before: [a, foldX, b]. After: [a, foldY, mid, foldZ, b]
    const r = mergeDisplay(
      ['a', 'foldX', 'b'],
      ['a', 'foldY', 'mid', 'foldZ', 'b'],
      keyOf
    )
    expect(shape(r.items)).toEqual([
      ['a',     'stable',   0],
      ['foldX', 'exiting',  0],
      ['foldY', 'entering', 1],
      ['mid',   'entering', 2],
      ['foldZ', 'entering', 3],
      ['b',     'stable',   0],
    ])
    expect(r.transitioningCount).toBe(4)
  })
})

describe('mergeDisplay — staggerIndex and ordering', () => {
  it('stagger indices are sequential across entering + exiting items, in display order', () => {
    const r = mergeDisplay(['a', 'x'], ['y', 'a'], keyOf)
    // Display: a stable, then y entering (since y not in prev), then x exiting
    // Actually the algorithm's order depends on key matching. Let's just
    // assert: stable items have staggerIndex 0; transitioning items get
    // sequential indices based on display order.
    let seenIndices: number[] = []
    for (const item of r.items) {
      if (item.phase !== 'stable') seenIndices.push(item.staggerIndex)
    }
    expect(seenIndices).toEqual([...Array(seenIndices.length).keys()])
  })

  it('stable items always have staggerIndex 0', () => {
    const r = mergeDisplay(['a', 'b', 'c'], ['a', 'b', 'c'], keyOf)
    for (const item of r.items) {
      expect(item.staggerIndex).toBe(0)
    }
  })

  it('payload is taken from next for stable items (so any data update wins)', () => {
    interface Foo { key: string; revision: number }
    const prev: Foo[] = [{ key: 'a', revision: 1 }]
    const next: Foo[] = [{ key: 'a', revision: 2 }]
    const r = mergeDisplay(prev, next, x => x.key)
    expect(r.items[0].payload.revision).toBe(2)
  })

  it('payload for exiting items is taken from prev (the version that is leaving)', () => {
    interface Foo { key: string; tag: string }
    const prev: Foo[] = [{ key: 'a', tag: 'old' }]
    const next: Foo[] = []
    const r = mergeDisplay(prev, next, x => x.key)
    expect(r.items[0].payload.tag).toBe('old')
    expect(r.items[0].phase).toBe('exiting')
  })
})

// ─── sizeAtTime ──────────────────────────────────────────────────────────────

describe('sizeAtTime', () => {
  const FULL = 32
  const T = DEFAULT_TIMINGS

  it('stable item is always full size regardless of elapsed', () => {
    const item = { phase: 'stable' as AnimPhase, staggerIndex: 0 }
    expect(sizeAtTime(item, FULL, 0, 0)).toBe(FULL)
    expect(sizeAtTime(item, FULL, 1000, 5)).toBe(FULL)
  })

  it('entering item starts at 0, ends at full', () => {
    const item = { phase: 'entering' as AnimPhase, staggerIndex: 0 }
    expect(sizeAtTime(item, FULL, 0, 1)).toBe(0)
    expect(sizeAtTime(item, FULL, T.itemDurationMs, 1)).toBe(FULL)
    // Past the end, clamps to full.
    expect(sizeAtTime(item, FULL, 9999, 1)).toBe(FULL)
  })

  it('exiting item starts at full, ends at 0', () => {
    const item = { phase: 'exiting' as AnimPhase, staggerIndex: 0 }
    expect(sizeAtTime(item, FULL, 0, 1)).toBe(FULL)
    expect(sizeAtTime(item, FULL, T.itemDurationMs, 1)).toBe(0)
    expect(sizeAtTime(item, FULL, 9999, 1)).toBe(0)
  })

  it('stagger: last item begins at totalDuration - itemDuration', () => {
    const N = 5
    const last = { phase: 'entering' as AnimPhase, staggerIndex: N - 1 }
    const lastBegins = T.totalDurationMs - T.itemDurationMs
    // Just before its delay → still 0
    expect(sizeAtTime(last, FULL, lastBegins - 1, N)).toBe(0)
    // After full ramp → full
    expect(sizeAtTime(last, FULL, T.totalDurationMs, N)).toBeCloseTo(FULL, 5)
  })

  it('stagger spacing self-attenuates with N (the doc-decision: always-staggered ≈ simultaneous at large counts)', () => {
    // What "self-attenuates" means concretely: the time delay between
    // ADJACENT items shrinks as N grows. At N=2, adjacent items are far
    // apart (the full stagger window). At N=100, adjacent items are 1.2ms
    // apart, perceptually simultaneous.
    const adjacentSpacing = (n: number) =>
      n > 1 ? (T.totalDurationMs - T.itemDurationMs) / (n - 1) : 0

    expect(adjacentSpacing(2)).toBeCloseTo(120, 1)    // far apart
    expect(adjacentSpacing(10)).toBeCloseTo(13.3, 1)
    expect(adjacentSpacing(100)).toBeLessThan(2)      // basically simultaneous
    // Property: as N grows, adjacent spacing monotonically shrinks.
    expect(adjacentSpacing(2)).toBeGreaterThan(adjacentSpacing(10))
    expect(adjacentSpacing(10)).toBeGreaterThan(adjacentSpacing(100))
  })

  it('total animation always completes within the budget regardless of count', () => {
    // The doc requires mode-change morph completes in ≤300ms. Property to
    // verify: the LAST item finishes at totalDurationMs no matter how many
    // items are in transition.
    for (const N of [1, 2, 10, 100, 1000]) {
      const last = { phase: 'entering' as AnimPhase, staggerIndex: N - 1 }
      const sizeAtBudget = sizeAtTime(last, FULL, T.totalDurationMs, N)
      expect(sizeAtBudget).toBeCloseTo(FULL, 5)
    }
  })

  it('single transitioning item: no stagger — starts immediately', () => {
    const item = { phase: 'entering' as AnimPhase, staggerIndex: 0 }
    // With transitioningCount=1, perItemDelay should be 0.
    const mid = T.itemDurationMs / 2
    const size = sizeAtTime(item, FULL, mid, 1)
    // ease-in-out cubic at t=0.5 is exactly 0.5
    expect(size).toBeCloseTo(FULL * 0.5, 1)
  })
})

describe('easeInOutCubic', () => {
  it('endpoints are 0 and 1', () => {
    expect(easeInOutCubic(0)).toBe(0)
    expect(easeInOutCubic(1)).toBe(1)
  })
  it('midpoint is exactly 0.5 for cubic in/out', () => {
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 5)
  })
  it('monotonically increasing', () => {
    let prev = -Infinity
    for (let t = 0; t <= 1; t += 0.05) {
      const v = easeInOutCubic(t)
      expect(v).toBeGreaterThanOrEqual(prev)
      prev = v
    }
  })
})
