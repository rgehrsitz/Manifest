# TODOS

## Completed

- Unified search-in-tree: the visible search box filters the hierarchy to matching nodes plus ancestors, highlights matches in-tree, shows property-match snippets inline, and uses Enter/Shift+Enter/Escape for cycling and clearing. Typing while the tree is focused feeds the same search box instead of opening a hidden mode. **Updated:** 2026-06-22
- Reference properties: add a force-delete / unlink workflow for mutual references across different subtrees. The delete guard now reports every incoming reference (live node references and stale template reference defaults) as a `ReferenceBlocker[]` in the error context, and `node.delete(id, { unlinkReferences: true })` force-deletes by nulling the blocking references on survivors and clearing stale template defaults, then re-indexing search. The renderer shows a confirm dialog listing the blockers before forcing. **Completed:** 2026-06-20 (ee99b61)
