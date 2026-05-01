---
name: Re-evaluate fold-spans-depth-jump in Step 5
description: Density layer currently folds contiguous unchanged rows regardless of depth — a fold that spans a depth jump may read confusingly. Decide at Step 5 with real data.
type: project
originSessionId: c054cf7b-1453-4e4d-b73e-d5e491e22c90
---
The Step 1 implementation of `computeCompareSections` matches the design
doc's literal rule: contiguous runs of `kind === 'normal'` rows collapse
into one fold, with no depth qualifier. In the Step 2 synthetic harness
this produced one fold of 35 spanning 5 slots at depth 2 and 30 regions
at depth 0 (an unchanged depth-2 leaf followed by unchanged depth-0
siblings).

**Why:** The current rule is what the doc literally specifies. The
question is whether folds spanning a depth jump read clearly to the user
("47 unchanged items folded" when those items mix grandchildren and
their grand-uncle) — observed in synthetic data, not yet in real data.

**How to apply:** At design doc Step 5 (compare-mode morphing wiring),
re-evaluate this with real Manifest data. If folds spanning depth jumps
read poorly, change the rule: split fold candidates at depth boundaries
in `density-layer.ts`. Until then, preserve the doc-literal behavior.
This question should not block Step 3 (data wiring) or Step 4 (integrations).
