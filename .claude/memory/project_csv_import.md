---
name: CSV import design
description: CSV import (from spreadsheet exports) — parse/plan in shared code, mutate once via ProjectManager; renderer stays filesystem-blind. Flat + path placement; skip-invalid-import-the-rest.
type: project
---

CSV import on branch `feat/csv-import` (built after typed-properties/templates +
synthetic generator). v1 = `.csv` only (native `.xlsx` deferred — no new dep;
own RFC-4180 parser).

**Pieces:**
- `src/shared/csv.ts` — `parseCsv()` (RFC-4180; BOM strip; trailing-blank drop;
  throws `CsvParseError` on unterminated quotes). Pure.
- `src/shared/import.ts` — `suggestKey()` (header → valid property key) and the
  **authoritative** pure `planImport(rows, headers, mapping, templates, nodes)`
  used by BOTH plan and apply so preview can't disagree with result.
- `src/main/project-manager.ts` — `inspectImport` (headers/sample/count, 50 MB
  cap), `planImportCsv` (full-file plan, issues capped ~100), `applyImportCsv`
  (re-plan, build nodes, ONE `commitProjectMutation` + `search.rebuild`).
- IPC: `DIALOG_OPEN_FILE` + `import` namespace (`inspect`/`plan`/`apply`).
- UI: `ImportDialog.svelte` (choose → map placement/name/path/template/per-column
  editable keys → Validate → Import); App `Import…` titlebar button + tree
  context-menu `Import rows here…`; emerald post-import summary banner (reuses
  the loadWarnings banner pattern).

**Locked behaviors (with Robert):**
- Placement: **flat** (all rows under one base parent) AND **path** (breadcrumb
  column resolves to an existing node, relative to baseParentId, tolerating a
  leading root/base-name segment so generator CSVs round-trip; unresolved →
  skip). A `parent_path`/`path` header auto-selects path mode in the dialog.
- **Auto-create missing parents** (opt-in checkbox, path mode only): missing
  breadcrumb ancestors are created as plain untyped nodes so a board-only
  hierarchical export loads into an empty project. planImport *stages* ancestors
  (synthetic `localId`) and commits them only when a row that needs them passes
  all checks (no orphans on skipped rows); applyImportCsv maps localId→real
  uuidv7 in create-order. Reported separately as "N parents created".
- **Unified in-batch namespace** (post-review fix): one `batchChildren` map
  keyed by `childKey(parentId, name)` (space separator — ids never contain
  spaces) tracks BOTH row-created nodes and auto-created ancestors. So a path
  can resolve THROUGH a node an earlier row created, and a leaf row collides
  with an auto-ancestor of the same name (and vice-versa) — no duplicate
  siblings. Every committed node (row or ancestor) gets a `localId`. The
  pre-review version used disjoint `batchNames` + `createdByKey`, which let a
  row-created node and an auto-ancestor become same-named siblings silently.
- Bad rows: **skip-invalid, import the rest** — invalid typed cell / unresolved
  path / name collision (vs existing AND in-batch) → skip the row; **missing
  required field → warning, keep the row** (required stays advisory).
- **Main is authoritative**; renderer only suggests (normalized keys, live
  issue counts). Per-column key mapping is IN v1 (real headers like
  "Serial Number" → editable key).

**Plan-review fixes folded in:** full-file `plan` step (not sample-only),
header→key mapping, required-advisory, honest "CSV (from spreadsheet exports)"
scope, path base = baseParentId.

**Deferred:** native `.xlsx`, NetBox relational adapter, update-on-key re-import,
import presets.

Status: complete on branch; 382 unit + 35 E2E green; typecheck + svelte-check
clean. Passed a multi-agent pre-landing review (12 findings; the namespace bug
above was the headline P2). Related: [[project_typed_properties]],
[[project_synthetic_data]], [[project_target_domain]], [[feedback-scan-nul-before-commit]].
