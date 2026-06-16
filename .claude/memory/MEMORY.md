# Memory Index

Project-scoped memory for Manifest. User-scoped preferences and Svelte 5 gotchas (untrack-in-effects, store-deref) live in `~/.claude/memory/`; user role/style lives in `~/.claude/memory/user_role.md`.

- [Manifest project context](project_manifest.md) — Greenfield Electron/TS/Svelte5 successor to Archon, focused on hierarchy/history/snapshots
- [Lens animation = always staggered](project_lens_animation_stagger.md) — Closed design doc Open Q1; no count threshold, stagger self-attenuates
- [Re-evaluate fold-spans-depth-jump in Step 5](project_lens_depth_fold_concern.md) — Folds currently ignore depth (doc-literal); revisit if it reads confusingly in real data
- [Manifest target domain](project_target_domain.md) — Test-facility/lab configuration management; killer query is "what changed between test X and Y"; drives typed properties, import, report export
- [Typed properties & templates design](project_typed_properties.md) — Template-driven typing, primitive values; templates are first-class state so diff/history must reflect template changes; merged via PR #8
- [Synthetic lab data generator + scale findings](project_synthetic_data.md) — generate-lab.mjs builds a ~7.4k-node test-lab with templates + 40-snapshot timeline; surfaced+fixed a git-show maxBuffer scale bug
