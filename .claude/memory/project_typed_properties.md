---
name: Typed properties & templates design
description: Manifest uses template-driven typing — types live once in a project-level templates map; node property values stay clean JSON primitives. Templates are first-class project state so diff/history must reflect template changes.
type: project
---

Decision (locked 2026-06, with Robert) for typed node properties:

**Template-driven, primitive values.** Type info lives ONCE in a project-level
`templates: Record<id, NodeTemplate>` map (id = slug). Node property VALUES
stay clean JSON primitives in `manifest.json` — NO `{type,value}` wrappers, NO
per-node type maps. A node points to a template via `templateId`. Properties
whose key matches a template field are typed/validated; keys not in the
template are ad-hoc/untyped strings until "promoted" into a template field.
This preserves the human-readable-storage promise and makes consistency the
default (the product value for facility/lab config management).

**v1 type set:** string, number, boolean, date, version, enum.
`version` is a constrained non-empty string (≤64 chars, no control chars),
deliberately NOT semver — must accept `v2.1.0`, vendor/build labels.
`reference` (node→node) is the planned NEXT step (needs target validation,
deleted-target policy, target-name diff rendering).

**Core correctness principle:** templates are project state, so diff AND
history treat them as first-class. `diffProjects` emits `template-changed` on
templateId change; `diffTemplates()` produces project-level `TemplateDiffEntry[]`
surfaced via `MergedTree.templateChanges`; history-index tracks `templateId`
(schema v2) and `nodeStatesEqual` includes it. Without this a schema/template
edit would compare as "no changes" — which would break the product's promise.

**Enforcement:** strict + coercion on INPUT paths only (`coercePropertyValue`).
NEVER coerce on file load — `collectLoadWarnings()` returns path-qualified
`ManifestWarning[]` (e.g. `nodes[12].properties.firmware`) on `project.loadWarnings`
(runtime-only, stripped on write). `templateUpdate` rejects field changes that
would invalidate a currently-bound node value; `templateDelete` unbinds nodes
(templateId→null) but keeps their values.

Manifest schema: `CURRENT_VERSION` bumped 2→3 (additive: ensures `templates: {}`).

**Status:** Phase 1 (schema/core/change-visibility) committed (9bf269e) and
Phase 2 (editing UI) DONE on branch `feat/typed-properties-templates`.
Phase 2 added: `TemplateFieldControl.svelte` (typed inputs; keyed per
node+field, seeds draft once — `svelte-ignore state_referenced_locally`),
`PropertyEditor.svelte` (template selector + typed fields + ad-hoc rows +
promote-to-typed; reuses `prop-value`/`new-prop-*`/`delete-prop` testids for
back-compat), `TemplateManager.svelte` (CRUD modal, Templates titlebar
button), node-create template picker, load-warnings banner. 311 unit + 23
E2E green; typecheck + svelte-check clean.

**Svelte 5 IPC gotcha (found + fixed in Phase 2):** sending `$state`-proxied
NESTED objects over `ipcRenderer.invoke` throws "An object could not be
cloned" (structured clone can't serialize Svelte proxies). Node/property
updates are safe because property VALUES are primitives, but template field
maps are nested — `handlePromoteField` must `$state.snapshot(template.fields)`
before sending. Rule: snapshot any proxied non-primitive before IPC.

Phase 3 (diff/tree rendering polish) DONE: SnapshotsPanel renders
`MergedTree.templateChanges` as a "Schema changes" section and `template-changed`
node diffs (Before/After with null→"(none)"); empty-state now keys off
`allDiffs + templateChanges` so a schema-only change is never reported as
"No changes". Helpers `describeTemplateChange` / `formatTemplateRef` /
`formatChangeType('template-changed')` in lib/diff-format.ts (unit-tested).
E2E proves a schema-only snapshot delta is surfaced. 316 unit + 25 E2E green.
Deferred (optional): per-row template badge in TreeRow (needs template labels
threaded through the virtualized tree — node only carries templateId) and
type-aware value formatting (date humanized / boolean Yes-No) — values are
already readable, low payoff vs. threading template types into the flat diff.

Typed-properties feature (Phases 1–3) **MERGED to main** via PR #8
(merge commit 9de37a6; feature branch deleted). Three review rounds addressed:
- nodeUpdate re-validates existing props on template (re)bind; collectLoadWarnings
  never throws on invalid referenced templates; template-changed surfaced in
  NodeHistoryView, tree-rows/TreeRow badges, density-layer fold chips.
- Field default/label preserved through TemplateManager save; diffTemplates
  detects description-only changes (template-redescribed).
- Malformed-template hardening centralized in shared safe accessors in
  `src/shared/validation.ts`: `templateFields()`, `isUsableTemplate()`,
  `templateLabel()` — used by every renderer + main + diff consumer so a
  hand-edited/garbage template never throws. coercePropertyValue rejects
  non-primitive input.
Final on main: 332 unit + 28 E2E green.

**Decision (settled):** `required` fields are ADVISORY in v1 — a visible
"Required — not set" cue + a `MISSING_REQUIRED` load warning, NOT a hard
save-block. Revisit only if a config-control workflow demands hard enforcement.

Next per roadmap: `reference` property type → CSV import → diff report export → Tauri.
Full plan: `~/.claude/plans/fluffy-swimming-wozniak.md`.
