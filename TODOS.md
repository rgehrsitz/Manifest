# TODOS

Project-level follow-ups captured during planning. Each item has enough context that someone picking it up months from now can act without re-deriving the reasoning.

## Per-node history index — visibility into silent gaps

**What:** Surface a user-visible signal when the `node_history` index has gaps for the current project (e.g., a snapshot whose `recordSnapshot` failed mid-write, or a revert event whose pre/post manifests couldn't be read for synthesis).

**Why:** v1 of the per-node history feature relies on auto-backfill on next project open to recover from `recordSnapshot` failures, and silently skips revert events whose manifest pairs are unreadable. Both are rare, but a user with a corrupted snapshot might not realize their History view is incomplete.

**Pros:**
- Trust: user sees "1 snapshot couldn't be indexed — re-index" instead of an invisible hole.
- Cheap diagnostic: counts missing/incomplete snapshots from `snapshot_index_state`.

**Cons:**
- v1 logging may be sufficient for the actual frequency of these failures.
- Adds UI surface (toast or banner) and a manual "re-index" IPC.

**Context:** Discussed during `/plan-eng-review` of the per-node history feature on 2026-04-26. Decisions D6 (completeness marker) and D7 (revert/recover synthesis) explicitly accepted recovery via auto-backfill; this TODO captures the user-visibility layer that was deferred.

**Where to start:** `src/main/history-index.ts` should expose `getIncompleteSnapshots()` querying `snapshot_index_state WHERE complete=0`. Renderer surfaces a banner in the History tab if the count is non-zero, with a "Re-index now" action that calls a new `node:history:reindex` IPC.

**Depends on:** v1 of the per-node history feature shipping first.

---

## Cloud-storage sync corruption warning at project level

**What:** Detect when a Manifest project lives inside an iCloud/Dropbox/OneDrive synced folder and warn the user that the SQLite indexes (`search.db`, `history.db`, plus their `-wal` and `-shm` files) can corrupt under partial sync.

**Why:** SQLite's WAL mode produces multiple files that must be kept consistent. Cloud sync clients see them as independent files and can sync them out of order, leaving the database in an inconsistent state. Users who put their project folder in `~/Dropbox/Projects/MyLab` will eventually hit corruption.

**Pros:**
- Saves users from a frustrating data-loss class of bug that's invisible until it bites.
- Solution can be a one-time banner on project open with "ignore" / "move project" actions.

**Cons:**
- Detection isn't perfect — heuristics on path patterns can false-positive.
- Outside scope of the per-node history feature.

**Context:** Surfaced as point 6 of the outside-voice review during `/plan-eng-review` of the per-node history feature on 2026-04-26. Pre-existing concern for `search.db`; deferred to project-wide treatment because it's not specific to this feature.

**Where to start:** Add a project-open hook in `src/main/project-manager.ts` that checks the project path against known cloud-sync folder patterns (`~/Library/Mobile Documents/`, `~/Dropbox/`, `~/OneDrive/`, etc.) and surfaces a one-time banner via the existing toast mechanism in `App.svelte`.

**Depends on:** Nothing technical. Could ship anytime.

---

## Lab generator — round-trip + diff-coverage regression test

**Priority:** P2

**What:** A committed test that locks in two invariants the dogfood pass just fixed in `scripts/generate-lab.mjs`: (1) the sample CSV round-trips against the FINAL manifest (re-import with update-on-key on `serial` → 0 create / 0 update / 0 skip); (2) the 40-day timeline exercises every node diff `ChangeType` (added, removed, renamed, moved, order-changed, property-changed, template-changed).

**Why:** Both bugs (CSV serialized from day-0; structural churn never firing with seed 42) were silent — nothing in CI failed. A future edit to a scheduled day, rack name, or the add/move/remove lifecycle of `ADDED_BOARD_NAME` could silently stop exercising a ChangeType or desync the CSV again.

**Where to start:** Make the generator importable — guard the top-level `main(process.argv.slice(2))` call (only run when entry point) and export a pure `generateTimeline(options) => { final, snapshots:[{label,project}], csv }`. Then a fast in-process unit test runs it at a small config (`rooms:1, racksPerRoom:8, days:40, seed:42`), parses the CSV through `parseCsv` + `planImport` (serial-key update) asserting 0/0/0, and runs `diffProjects` (`src/shared/diff-engine.ts`) between the snapshots flanking the scheduled structural days (6/10/16/20/30/34) asserting each ChangeType. Pure functions only — no sqlite/git/subprocess.

**Depends on:** Nothing. The generator fixes it guards are already in this branch.

---

## Import — incremental search-index update on apply

**Priority:** P3

**What:** `applyImportCsv` in `src/main/project-manager.ts` rebuilds the ENTIRE search index on every import (`this.search.rebuild(nextProject)`), making import cost O(tree size) regardless of how few rows changed.

**Why:** At ~7.4k nodes this is ~50ms; at ~50k it becomes a noticeable hitch on every import. Pure optimization — no correctness impact (found during the dogfood pass, Workflow-rated Low).

**Where to start:** Replace the full rebuild with `search.upsertNode` for each created node in `newNodes` and each updated node in `out.update`/`updatedNodes` (both sets already in hand where the commit is built). See `src/main/search-index.ts` for the API; confirm `upsertNode` exists/is idempotent. Fall back to a full rebuild only if the index is uninitialized. Add a unit test asserting search returns both a created and an updated node after import.

**Depends on:** Nothing.
