// Lens morphing animation — pure helpers.
//
// When the lens's renderItems change (mode flip, fold toggle, fold split/
// merge), we don't snap. We compute a MERGED display containing both the
// outgoing items (fading their height to 0) and the incoming items (growing
// from 0), then drive an rAF loop that pushes interpolated sizes into the
// virtualizer's estimateSize.
//
// All functions in this module are pure: same inputs produce the same
// outputs, no DOM, no rAF. The animation timing (rAF, easing curves) lives
// in ManifestView.svelte; this file owns the math.

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Stable identity for any item in the render stream — drives Svelte keyed
 * {#each} blocks and the merge/diff pass below. Convention:
 *   - rows:  `row:${row.id}`     (uses the merged-tree node id)
 *   - folds: `fold:${foldId}`    (the deterministic id from density-layer)
 */
export type ItemKey = string

/**
 * Phase of an item during a transition.
 *  - stable: present in both prev and next layers; height stays at full size.
 *  - entering: present only in next; height grows 0 → full.
 *  - exiting: present only in prev; height shrinks full → 0.
 */
export type AnimPhase = 'stable' | 'entering' | 'exiting'

/**
 * One item in the merged display sequence rendered during a transition.
 * `payload` is opaque to this module — ManifestView holds the actual
 * `RenderItem` (row or fold) and uses `key` to look it up.
 */
export interface DisplayedItem<P> {
  key: ItemKey
  payload: P
  phase: AnimPhase
  /**
   * Position in the stagger order, 0..(transitioningCount-1). 0 means starts
   * first; higher values delay the start. Stable items have staggerIndex 0
   * but never animate.
   */
  staggerIndex: number
}

export interface MergeResult<P> {
  items: DisplayedItem<P>[]
  /** Count of entering + exiting items — used to drive stagger spacing. */
  transitioningCount: number
}

// ─── Merge two render-item sequences into a transitional display ─────────────

/**
 * Merge a `prev` and `next` sequence of payloads keyed by `keyOf`, producing
 * a single display sequence with each item phase-tagged. The order preserves
 * `next`'s sequence for stable + entering items; exiting items are inserted
 * at the position they held in `prev`, anchored to the nearest stable item.
 *
 * Algorithm: two-pointer walk over prev/next. When the keys match → stable.
 * When a prev key is missing from next → exiting (emit and advance prevI).
 * When a next key is missing from prev → entering (emit and advance nextI).
 * For "swap" cases (both keys exist in the other list), we bias toward
 * emitting next's entering first so the user sees the new layout settle into
 * place rather than the old one shuffle around.
 */
export function mergeDisplay<P>(
  prev: P[],
  next: P[],
  keyOf: (p: P) => ItemKey
): MergeResult<P> {
  const nextKeySet = new Set(next.map(keyOf))
  const prevKeySet = new Set(prev.map(keyOf))

  const items: DisplayedItem<P>[] = []
  let prevI = 0
  let nextI = 0

  while (prevI < prev.length || nextI < next.length) {
    if (prevI >= prev.length) {
      while (nextI < next.length) {
        items.push({ key: keyOf(next[nextI]), payload: next[nextI], phase: 'entering', staggerIndex: 0 })
        nextI++
      }
      break
    }
    if (nextI >= next.length) {
      while (prevI < prev.length) {
        items.push({ key: keyOf(prev[prevI]), payload: prev[prevI], phase: 'exiting', staggerIndex: 0 })
        prevI++
      }
      break
    }

    const pk = keyOf(prev[prevI])
    const nk = keyOf(next[nextI])

    if (pk === nk) {
      items.push({ key: nk, payload: next[nextI], phase: 'stable', staggerIndex: 0 })
      prevI++
      nextI++
      continue
    }

    const pkInNext = nextKeySet.has(pk)
    const nkInPrev = prevKeySet.has(nk)

    if (!pkInNext) {
      items.push({ key: pk, payload: prev[prevI], phase: 'exiting', staggerIndex: 0 })
      prevI++
    } else if (!nkInPrev) {
      items.push({ key: nk, payload: next[nextI], phase: 'entering', staggerIndex: 0 })
      nextI++
    } else {
      // Both keys exist on the other side — items reordered. Bias toward
      // emitting next's entering so the destination layout takes shape.
      items.push({ key: nk, payload: next[nextI], phase: 'entering', staggerIndex: 0 })
      nextI++
    }
  }

  let staggerIdx = 0
  let transitioningCount = 0
  for (const item of items) {
    if (item.phase !== 'stable') {
      item.staggerIndex = staggerIdx++
      transitioningCount++
    }
  }

  return { items, transitioningCount }
}

// ─── Per-item size at progress ───────────────────────────────────────────────

export interface AnimationTimings {
  /** Total transition duration. The last item finishes at this time. */
  totalDurationMs: number
  /** Per-item ramp duration (must be ≤ totalDurationMs). */
  itemDurationMs: number
}

export const DEFAULT_TIMINGS: AnimationTimings = {
  totalDurationMs: 280,
  itemDurationMs: 160,
}

/**
 * ease-in-out cubic, t in [0, 1].
 */
export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}

/**
 * Compute an item's interpolated size at a given moment in the transition.
 *
 *  - stable items: always return `fullSize`.
 *  - entering: 0 → `fullSize` over [delay, delay + itemDurationMs].
 *  - exiting: `fullSize` → 0 over the same window.
 *
 * Stagger: if `transitioningCount > 1`, items are spaced across the
 * (totalDurationMs - itemDurationMs) window so the LAST item begins at
 * `totalDurationMs - itemDurationMs` and finishes exactly at totalDurationMs.
 * If `transitioningCount === 1`, no stagger (single item starts at 0).
 *
 * `elapsedMs` is the time since the transition started. `elapsedMs >=
 * totalDurationMs` means the transition is settled; entering items are at
 * full size, exiting items are at 0.
 */
export function sizeAtTime(
  item: { phase: AnimPhase; staggerIndex: number },
  fullSize: number,
  elapsedMs: number,
  transitioningCount: number,
  timings: AnimationTimings = DEFAULT_TIMINGS
): number {
  if (item.phase === 'stable') return fullSize

  const staggerWindow = Math.max(0, timings.totalDurationMs - timings.itemDurationMs)
  const perItemDelay = transitioningCount > 1
    ? staggerWindow / (transitioningCount - 1)
    : 0
  const delay = item.staggerIndex * perItemDelay

  const itemElapsed = elapsedMs - delay
  const t = Math.max(0, Math.min(1, itemElapsed / timings.itemDurationMs))
  const eased = easeInOutCubic(t)

  return item.phase === 'entering' ? fullSize * eased : fullSize * (1 - eased)
}

/**
 * True if the user has system-level reduced-motion preference. Falls back to
 * `false` when window/matchMedia is unavailable (SSR, Node tests).
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}
