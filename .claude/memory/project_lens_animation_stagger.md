---
name: Space-Folding Lens animation = always staggered
description: Decided 2026-04-27 — fold animations always stagger per-row, never simultaneous. Closes Open Question 1 from the design doc.
type: project
originSessionId: c054cf7b-1453-4e4d-b73e-d5e491e22c90
---
Fold animations in the Space-Folding Lens always use a per-row staggered
collapse, never simultaneous. Total animation duration is capped at ~300ms;
per-row delay = stagger_window / row_count, so stagger shrinks gracefully
to imperceptible at large counts and small counts alike.

**Why:** The doc's Open Question 1 proposed a count-threshold rule
(simultaneous below N, stagger above). Robert chose "always stagger"
because it's a simpler invariant with the same effective behavior at the
extremes — no threshold to pick or defend, and no surprise mode-switch
between visually-similar fold sizes.

**How to apply:** When building the animation pass (design doc Step 6),
do not implement a count-threshold branch. The stagger formula must
self-attenuate: at count=2 the stagger should be visually
indistinguishable from simultaneous; at count=500 it must complete
within the 300ms budget. Closes design doc Open Question 1.
