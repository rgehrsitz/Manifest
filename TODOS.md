# TODOS

Project-level follow-ups captured during planning. Each item has enough context that someone picking it up months from now can act without re-deriving the reasoning.

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
