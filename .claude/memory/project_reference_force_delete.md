---
name: project_reference_force_delete
description: Reference force-delete / unlink workflow — deleting a node blocked by incoming references can be forced, clearing the references. Detection is gated on live reference fields + template defaults, deliberately NOT a blanket string scan.
metadata:
  type: project
---

Reference force-delete / unlink workflow (merged to main via PR #19, squash
`5508aa0`). Completes the reference-property work started in #18.

**Problem:** `nodeDelete` hard-blocked whenever a surviving node's typed
`reference` property pointed into the deletion set — including mutual/cyclic
references across subtrees the user couldn't clear by hand. Error named only the
first blocker; no escape hatch.

**Shipped (`src/main/project-manager.ts`):**
- `findExternalReferencesTo(toDelete)` returns a serializable `ReferenceBlocker[]`
  (in `src/shared/types.ts`) — every blocker, not just the first — carried in the
  `VALIDATION_FAILED` error `context.blockers` so the renderer can list them.
  Discriminated `kind`: `'node'` (a live reference-typed property) or
  `'template-default'` (a template `reference` field whose `default` points in).
- `nodeDelete(id, { unlinkReferences: true })` is the explicit force path: in ONE
  `commitProjectMutation` it nulls the blocking reference properties on survivors
  (grouped by node), clears stale reference defaults on affected templates
  (immutably), then re-indexes the touched survivors in search.
- Renderer (`App.svelte` handleDelete): on a blocked delete, shows a confirm
  dialog listing each blocker (`• <node> → <key>` or `• Template "<label>"
  default → <key>`) and offers "delete and clear N references", then re-invokes
  with the force flag. Safe-by-default otherwise.

**KEY DESIGN DECISION (settled via cross-model adversarial review, with Robert):**
detection is gated on the CURRENT `reference` field type PLUS template defaults —
**deliberately NOT a blanket scan of every string property** for id-equality.
First implementation went fully structural (clear any string value equal to a
deleted id); both Claude and Codex adversarial passes flagged it as silent
data-corruption: **node ids are not loader-enforced uuidv7**, so a hand-authored
or imported (CSV) project could have a free-text/enum value legitimately equal to
a node id, which would be silently nulled on force-delete. So a value left under a
key rebound away from `reference` (or after template unbind) is treated as plain
text and left intact — not a blocker. If you ever revisit "dangling pointers
under rebound keys," do NOT reach for the blanket scan; that path is rejected.

`required` reference fields cleared by a force-delete stay advisory per the v1
decision (`MISSING_REQUIRED` load warning, not a hard block) — see
[[project_typed_properties]].

Next per work queue: **NetBox import adapter**. (Shipped since: compare current
project to snapshot #20, typeahead search-in-tree #21, compare-mode per-side
template resolution #22, docs refresh #24, ManifestAPI golden conformance suite
#25. Tauri migration is a documented feasibility plan at
`~/.claude/plans/tauri-migration-feasibility.md` — the contract suite #25 is its
cheap backend-parity insurance; the go/no-go spike is not yet executed.)
Related: [[project_csv_import]], [[project_report_export]], [[project_target_domain]].
