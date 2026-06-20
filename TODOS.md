# TODOS

## Completed

- Reference properties: add a force-delete / unlink workflow for mutual references across different subtrees. The delete guard now reports every incoming reference (live node references and stale template reference defaults) as a `ReferenceBlocker[]` in the error context, and `node.delete(id, { unlinkReferences: true })` force-deletes by nulling the blocking references on survivors and clearing stale template defaults, then re-indexing search. The renderer shows a confirm dialog listing the blockers before forcing. **Completed:** 2026-06-20 (ee99b61)
