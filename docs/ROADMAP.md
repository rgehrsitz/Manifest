# Manifest Roadmap (Initial)

This roadmap is intentionally biased toward a **smaller, sharper v1** than Archon’s full ambition.

---

## Phase 0 — Direction and constraints

**Goal:** lock in the product and technical shape before scaffolding too much code.

Deliverables:

- `VISION.md`
- `ARCHITECTURE.md`
- `WHAT_TO_KEEP.md`
- `WHAT_TO_RETHINK.md`
- initial UI/interaction principles
- explicit v1 non-goals

Exit criteria:

- confidence that Manifest is meaningfully distinct from Archon
- agreement on the first 2–3 milestones

---

## Phase 1 — Foundation

**Goal:** get the Electron app running with a clean, typed architecture.

Scope:

- Electron shell
- Svelte 5 renderer
- Tailwind setup
- typed preload bridge
- basic project open/create flow
- local persistence primitives
- logging and error envelope conventions

Exit criteria:

- app launches cleanly
- project files can be created/opened/saved
- IPC boundaries are explicit and testable

---

## Phase 2 — Core editing experience

**Goal:** deliver the first truly useful Manifest workflow.

Scope:

- hierarchy tree UI
- detail/editor pane
- create/rename/move/delete nodes
- meaningful ordering of children
- autosave and recovery
- fast local search

Exit criteria:

- a user can manage a real project without the app feeling fragile

---

## Phase 3 — History and change awareness

**Goal:** make changes understandable and recoverable.

Scope:

- named snapshots/checkpoints
- history browser
- basic diff summaries
- restore/revert flows

Stretch:

- first semantic diff presentation

Exit criteria:

- a user can confidently inspect and recover previous work

---

## Phase 4 — Differentiators

**Goal:** add the features that make Manifest feel special rather than merely competent.

Candidates:

- richer semantic diff UI
- conflict-aware merge workflows
- better comparison views across snapshots
- import/export for selected domains

Exit criteria:

- the product has at least one clearly memorable capability beyond CRUD + history

---

## Phase 5 — Controlled extensibility

**Goal:** open the platform carefully, after the core is stable.

Scope:

- minimal plugin or integration surface
- permission model
- first-party integrations only
- example extension(s)

Exit criteria:

- extension points exist without destabilizing the main product

---

## Scope discipline rules

To keep Manifest from inheriting too much early complexity:

- no broad plugin marketplace in v1
- no full parity rewrite of Archon
- no overbuilt merge engine before the history UX is strong
- no architecture decisions justified only by hypothetical future needs
