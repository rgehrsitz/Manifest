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

## P1 — Tree Rewrite + Compare Mode (deferred scope items)

These items were explicitly deferred during the 2026-04-10 eng review of the tree rewrite + inline compare mode plan. They are known, reasoned decisions — not oversights.

### DnD Reorder for Tree Nodes
**What:** Drag-and-drop reordering of nodes within the tree (change parent or sibling order).
**Why:** Faster than the existing Move Up / Move Down context menu for multi-level restructuring.
**Pros:** More intuitive for large hierarchies.
**Cons:** Virtualized DnD is a hard problem. `svelte-dnd-action` doesn't play well with virtual lists. Would require either a custom DnD implementation or accepting that DnD only works on the visible rendered window, which is broken UX. The existing context menu (Move Up, Move Down, Move To) covers the base case.
**Context:** Deferred from tree rewrite plan (2026-04-10). The context menu solution ships with PR #1.
**Effort:** L (human) -> M (CC+gstack)
**Priority:** P1.5 (post-tree-rewrite, pre-v1 release if pilot feedback demands it)
**Depends on:** Tree rewrite (PR #1) landing

### Typeahead / Search-in-Tree
**What:** Typing in the tree filters/highlights matching nodes inline without leaving the tree to the search panel.
**Why:** Faster navigation in large hierarchies with known node names.
**Pros:** Common UX pattern in file trees. Reduces round-trip to search panel.
**Cons:** State management interplay with expanded set is non-trivial. Highlight rendering needs another VisibleRow decoration variant.
**Context:** Deferred from tree rewrite plan (2026-04-10). Existing search panel works; this is an enhancement.
**Effort:** S (human) -> S (CC+gstack)
**Priority:** P1.5
**Depends on:** Tree rewrite (PR #1) landing

### Inline Rename in Tree Row (F2 in-row)
**What:** Pressing F2 on a tree row shows a name input directly inside the row, without switching to the Detail pane.
**Why:** Faster for keyboard users who want to rename without looking right.
**Cons:** DetailPane already has inline rename. A second rename path means two places to maintain validation, error display, dedupe checking. Risk of drift.
**Context:** Explicitly deferred during tree rewrite plan (2026-04-10). F2 signal-based approach ships in PR #1: F2 bumps `renameRequestId` in App.svelte, DetailPane's `$effect` picks it up and starts editing. Users who prefer tree-row editing can be addressed post-v1.
**Effort:** S (human) -> S (CC+gstack)
**Priority:** P2 (post-v1)
**Depends on:** Tree rewrite (PR #1), DetailPane signal-based rename landing

### Fix ErrorCode.GIT_COMMIT_FAILED Mislabel in Snapshot Compare
**What:** `project-manager.ts` `snapshotCompare` and the new `snapshotLoadCompare` both use `ErrorCode.GIT_COMMIT_FAILED` when a compare fails. "Commit failed" is the wrong label for "read manifest failed."
**Why:** Code clarity, accurate error reporting to users.
**Cons:** Adds a new error code, small blast radius.
**Context:** Identified during code quality review (2026-04-10). Pre-existing issue, out of scope for the tree rewrite PRs.
**Effort:** XS
**Priority:** P2 (cleanup, any time)

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
**What:** ~~Implement virtual scrolling for the hierarchy tree view to handle >500 visible nodes.~~
**Status:** DONE — delivered in PR #1 (Tree rewrite, 2026-04-10). `@tanstack/svelte-virtual` ships with the tree rewrite. Closes this item.
**Was:** P2, identified during CEO review.

### Fractional Indexing for Sibling Order
**What:** Replace integer `order` field with string-based fractional indexing (e.g., "a0", "a0V") for sibling ordering.
**Why:** Integer ordering requires O(n) renumbering when inserting between existing siblings. At >100 siblings with frequent reordering, this means every drag-and-drop mutates dozens of nodes and triggers corresponding search index updates.
**Pros:** O(1) inserts and moves. No cascading order updates. Fewer mutations per operation.
**Cons:** String ordering is less intuitive to inspect in raw JSON. Requires a fractional index library or implementation. Migration from integer to string order values.
**Context:** Identified during eng review. Integer ordering is correct for v1 scale (<100 siblings typical). Consider this if pilot usage reveals projects with many siblings and frequent reordering.
**Effort:** S (human) -> S (CC+gstack)
**Priority:** P2
**Depends on:** Pilot usage data showing >100 siblings in practice
