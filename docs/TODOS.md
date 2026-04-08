# Manifest TODOS

## P1 — Must do in Phase 2

### Playwright/Electron E2E Harness
**What:** Create `playwright.config.ts` with Electron app launch wiring. Add an `electronApp` test fixture that boots the built app and exposes the first BrowserWindow.
**Why:** `package.json` has `playwright test` but there is no config file and no Electron launch integration. The 6 Phase 2 E2E tests cannot run without this.
**Pros:** Unblocks all E2E testing. One-time setup that all future E2E tests build on.
**Cons:** Requires `@playwright/test` Electron integration (`_electron` launch API). Slight extra setup complexity.
**Context:** Identified during Phase 2 eng review (Codex outside voice). The Playwright Electron launch API (`_electron.launch({ args: ['out/main/index.js'] })`) is the standard path. Must be done before writing any E2E tests.
**Effort:** S (human) -> XS (CC+gstack)
**Priority:** P1 (blocks Phase 2 E2E)
**Depends on:** Phase 2 build completing successfully

Deferred work from CEO review (2026-04-07).

## P2 — Post-v1 or late v1

### CSV/JSON Import
**What:** Let pilot users import existing lab data (spreadsheets, Access exports) into Manifest hierarchies.
**Why:** Removes the biggest adoption barrier. Nobody wants to re-enter 200 rack items by hand.
**Pros:** Dramatically lowers onboarding friction. Enables migration from existing tools.
**Cons:** Column mapping UI needs design. Parent-child inference rules are non-trivial.
**Context:** Design doc recommends this. Deferred because we need pilot user feedback on actual data shapes before designing the mapping UI.
**Effort:** M (human) -> S (CC+gstack)
**Priority:** P2
**Depends on:** Stable manifest.json schema (Phase 2 complete)

### User-Defined Property Schema
**What:** Let users define expected properties per node type (e.g., "Instruments must have serial_number, firmware_version").
**Why:** Makes the diff engine domain-aware and the briefing view smarter. Properties can be classified by domain importance.
**Pros:** Stronger product differentiation. Enables domain-specific validation and richer diff output.
**Cons:** Schema UI design needs care to stay simple. Risk of over-engineering before validated.
**Context:** Deferred from CEO review. Start with freeform properties, let pilot usage inform schema design.
**Effort:** M (human) -> S (CC+gstack)
**Priority:** P2
**Depends on:** Pilot usage data, core diff engine working

### Virtual Tree Scrolling
**What:** Implement virtual scrolling for the hierarchy tree view to handle >500 visible nodes.
**Why:** Performance review identified DOM stress at >500 expanded nodes. Real projects may have 1000-5000+ nodes.
**Pros:** Smooth scrolling and rendering at any project size.
**Cons:** Adds complexity to tree interaction (drag-drop, keyboard nav with virtual scroll).
**Context:** Identified during CEO review performance section. Not blocking for initial v1 with sub-500 node projects.
**Effort:** S (human) -> S (CC+gstack)
**Priority:** P2
**Depends on:** Tree UI component (Phase 2)

### Fractional Indexing for Sibling Order
**What:** Replace integer `order` field with string-based fractional indexing (e.g., "a0", "a0V") for sibling ordering.
**Why:** Integer ordering requires O(n) renumbering when inserting between existing siblings. At >100 siblings with frequent reordering, this means every drag-and-drop mutates dozens of nodes and triggers corresponding search index updates.
**Pros:** O(1) inserts and moves. No cascading order updates. Fewer mutations per operation.
**Cons:** String ordering is less intuitive to inspect in raw JSON. Requires a fractional index library or implementation. Migration from integer to string order values.
**Context:** Identified during eng review. Integer ordering is correct for v1 scale (<100 siblings typical). Consider this if pilot usage reveals projects with many siblings and frequent reordering.
**Effort:** S (human) -> S (CC+gstack)
**Priority:** P2
**Depends on:** Pilot usage data showing >100 siblings in practice
