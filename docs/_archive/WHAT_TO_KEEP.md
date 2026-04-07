# What Manifest Should Keep from Archon

This document lists the **ideas worth preserving** from Archon.

The emphasis is on **conceptual inheritance**, not implementation reuse.

| Concept from Archon | Why it matters | Manifest recommendation |
|---|---|---|
| Hierarchical project model | It gives the product a strong, opinionated center | Keep as the core abstraction |
| Stable immutable node IDs | Critical for identity, history, and future diff/merge | Keep; UUIDv7 remains a strong candidate |
| Sibling-level uniqueness + meaningful child order | Matches how real structures behave | Keep |
| Snapshot/checkpoint mindset | Gives users confidence and a durable workflow | Keep, but simplify initial implementation |
| Semantic change thinking | One of Archon’s most differentiated ideas | Keep as a long-term product pillar |
| Rebuildable local search index | Fast search without fragile coupling | Keep the pattern |
| Content-addressed attachments | Deduplication and integrity are strong long-term traits | Keep the concept; decide timing based on v1 needs |
| Error envelopes and reliability-first logging | Helps the app fail cleanly and recover well | Keep the discipline |
| Thoughtful plugin categories | Strong long-term extensibility model | Keep as reference, not day-one scope |

---

## Summary judgment

If Manifest keeps only a few deep ideas from Archon, these should be the priorities:

1. **hierarchy as a first-class model**
2. **stable identity**
3. **history/snapshots**
4. **meaningful change awareness**
5. **local-first reliability**

Those are the pieces most worth carrying forward.
