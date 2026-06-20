# TODOS

## Completed

- Typeahead / search-in-tree: inline type-to-jump in the hierarchy tree. Type while the tree is focused to jump to nodes by name (case-insensitive); the active match is revealed and selected and all matches are highlighted. Enter/Shift+Enter cycle matches, Backspace edits the query, Escape clears. Core logic lives in `src/renderer/src/lib/tree-typeahead.ts` with unit (`tests/unit/renderer/tree-typeahead.test.ts`) and E2E (`tests/e2e/tree.e2e.ts`) coverage. Closes the P1.5 item deferred from the tree-rewrite plan. **Completed:** 2026-06-20 (31a4f14)
- Reference properties: add a force-delete / unlink workflow for mutual references across different subtrees. The delete guard now reports every incoming reference (live node references and stale template reference defaults) as a `ReferenceBlocker[]` in the error context, and `node.delete(id, { unlinkReferences: true })` force-deletes by nulling the blocking references on survivors and clearing stale template defaults, then re-indexing search. The renderer shows a confirm dialog listing the blockers before forcing. **Completed:** 2026-06-20 (ee99b61)
