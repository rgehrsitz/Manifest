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

**Status:** Phase 1 (schema/core/change-visibility, no UI) DONE on branch
`feat/typed-properties-templates` — 311 unit tests green, typecheck + build
clean. Phase 2 = editing UI (componentized: `TemplateFieldControl.svelte`,
`PropertyEditor.svelte`, `TemplateManager.svelte`, load-warnings banner).
Phase 3 = diff/tree rendering polish. Full plan:
`~/.claude/plans/fluffy-swimming-wozniak.md`.
