# Memory Index

Project-scoped memory for Manifest. User-scoped preferences and Svelte 5 gotchas (untrack-in-effects, store-deref) live in `~/.claude/memory/`; user role/style lives in `~/.claude/memory/user_role.md`.

- [Manifest project context](project_manifest.md) — Greenfield Electron/TS/Svelte5 successor to Archon, focused on hierarchy/history/snapshots
- [Lens animation = always staggered](project_lens_animation_stagger.md) — Closed design doc Open Q1; no count threshold, stagger self-attenuates
- [Re-evaluate fold-spans-depth-jump in Step 5](project_lens_depth_fold_concern.md) — Folds currently ignore depth (doc-literal); revisit if it reads confusingly in real data
- [Manifest target domain](project_target_domain.md) — Test-facility/lab configuration management; killer query is "what changed between test X and Y"; drives typed properties, import, report export
- [Typed properties & templates design](project_typed_properties.md) — Template-driven typing, primitive values; templates are first-class state so diff/history must reflect template changes; merged via PR #8
- [Synthetic lab data generator + scale findings](project_synthetic_data.md) — generate-lab.mjs builds a ~7.4k-node test-lab with templates + 40-snapshot timeline; surfaced+fixed a git-show maxBuffer scale bug
- [CSV import design](project_csv_import.md) — shared parser + authoritative planImport; flat + path placement; auto-create parents; unified in-batch namespace; on branch feat/csv-import
- [Scan for NUL before commit](feedback-scan-nul-before-commit.md) — Write/Edit can embed a literal NUL where a separator was meant, making the file binary in git; scan before committing
- [Diff/report export](project_report_export.md) — Markdown/CSV export of the snapshot diff; pure formatter over diffProjects/diffTemplates; on branch feat/report-export
- [Native ABI rebuild order](feedback-native-abi-rebuild-order.md) — better-sqlite3: rebuild:native:node for unit, rebuild:native:electron for E2E/dev; never leave it node-built
