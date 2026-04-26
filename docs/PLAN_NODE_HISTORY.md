# Per-Node History — Implementation Plan

Status: cleared by `/plan-eng-review` on 2026-04-26. Ready to implement.

## Goal

Let users select a node and see its complete chronology across all snapshots and timeline events. Answers questions like "has the asset with tag XYZ ever been changed?", "when was this device's firmware updated?", "was this rack ever moved?".

The data already exists across N immutable snapshots in git. The plan adds a SQLite-backed index that makes per-node history queries fast and persistent across sessions.

## Architecture overview

```
.manifest/
  index/
    search.db       (existing — FTS5 for node name/property search)
    history.db      (NEW — per-node, per-snapshot state)
```

New service class: `HistoryIndexService` in `src/main/history-index.ts`.

`history.db` lives in its own SQLite file, separate from `search.db`. The two services do not share open/pragma code (intentional — see D10).

### Schema

```sql
PRAGMA user_version = 1;

CREATE TABLE node_history (
  snapshot_id     TEXT NOT NULL,
  snapshot_order  INTEGER NOT NULL,
  node_id         TEXT NOT NULL,
  presence        TEXT NOT NULL CHECK (presence IN ('present','absent')),
  node_name       TEXT,             -- null when absent
  parent_id       TEXT,
  node_order      INTEGER,
  properties_json TEXT,
  PRIMARY KEY (snapshot_id, node_id)
);
CREATE INDEX idx_node_history_node ON node_history (node_id, snapshot_order);

CREATE TABLE snapshot_index_state (
  snapshot_id     TEXT PRIMARY KEY,
  expected_count  INTEGER NOT NULL,
  actual_count    INTEGER NOT NULL,
  complete        INTEGER NOT NULL DEFAULT 0
);
```

### Delta encoding

`recordSnapshot(K)` only inserts a row when a node's state differs from its previous row. Three cases:

| Previous state (latest row for node_id) | At snapshot K | Action |
|---|---|---|
| `presence='present'`, same name/parent/order/props | Same | Skip — no insert |
| `presence='present'`, different name/parent/order/props | Present, changed | Insert `presence='present'` with new state |
| `presence='present'` | Absent (deleted) | Insert `presence='absent'` |
| `presence='absent'` | Present | Insert `presence='present'` |
| No previous row | Present | Insert `presence='present'` (first appearance) |
| No previous row | Absent | Skip — never existed |

**Why explicit `presence='absent'` rows:** with delta encoding, "no row at snapshot K" means "no change since previous", not "absent." Deletion needs an explicit signal.

### Atomicity

`git tag` + `history.json` write + `node_history` insert is NOT one transaction. Recovery strategy:

1. Each `recordSnapshot` does one transaction containing: INSERT delta rows + INSERT into `snapshot_index_state` with `complete=1, expected_count=N, actual_count=N`. Commit only after counts match.
2. On project open: `SELECT snapshot_id FROM snapshot_index_state WHERE complete=1` is the set of fully-indexed snapshots. Anything in git's tag list that's not in that set, or that has `complete=0`, gets re-indexed by backfill.

This is the same self-healing pattern as the existing `search.db` (rebuild from current project if missing).

### Backfill on first open after this feature ships

- Existing projects have N snapshots and 0 history rows.
- Strategy: **background async via `setImmediate` yield between per-snapshot transactions on the main thread.** Not `worker_threads` (better-sqlite3 in workers is more complexity than needed for a one-time 5-30s job).
- Project open returns immediately. Backfill runs cooperatively, yielding to the event loop after each per-snapshot transaction commits.
- History tab shows `"indexing N/M…"` if user clicks before complete.

### Reverts and recoveries in the History view

The schema only writes rows on `snapshotCreate`. But reverts and recoveries can change the live tree (e.g., revert restores a deleted node). To keep the History view honest:

`node:history(id)` IPC handler:
1. Query `node_history` rows for `node_id`, ordered by `snapshot_order`.
2. Read `history.json` events. For each `revert` or `recover` event, read the manifest pair (state before/after the event) and compute per-node diff.
3. Synthesize an entry for the revert/recover if it changed *this* node's state.
4. Merge DB rows + synthetic rows in chronological order.

The DB schema does not need new columns for this — the synthesis happens at query time using existing data.

### IPC

```typescript
// src/shared/ipc.ts
NODE_HISTORY: 'node:history',

// returns Result<{ entries: NodeHistoryEntry[] }>
type NodeHistoryEntry = {
  snapshotId: string                    // for snapshot events
  snapshotOrder: number
  snapshotName?: string                 // null for revert/recover synthetic entries
  createdAt: string                     // ISO 8601
  type: 'snapshot' | 'revert' | 'recover'
  presence: 'present' | 'absent'
  name: string | null                   // null when absent
  parentId: string | null
  nodeOrder: number | null
  properties: Record<string, ...>
  // The renderer doesn't need to compute diffs — every entry IS a transition.
}
```

### UI

New `History` tab in `DetailPane.svelte`, next to the property editor.

- Empty state (no rows): "This node has never been snapshotted yet."
- Loading state (backfill in progress): "Indexing N/M snapshots…"
- Each row: badge (snapshot/revert/recover), timestamp, what changed.

## The 11 decisions

| # | Decision | Outcome | Rationale |
|---|---|---|---|
| D1 | DB location | Separate `history.db` | `search.db`'s FTS rebuild path calls `rmSync(dbPath)` on error and would wipe history with it; isolation contains failures |
| D2 | Non-atomic git tag + DB write | Trust auto-backfill on next open | Matches existing `search.db` recovery pattern; self-healing, no new infra |
| D3 | Backfill UX on first open | Background async with progress in History tab | Invisible for the 95% of cases where user doesn't click History during backfill |
| D4 | DRY: shared open helper | (Reversed by D10) | — |
| D5 | Backfill transaction strategy | One transaction per snapshot | UI can query partial results; crash leaves consistent partial state |
| D6 | Completeness marker | `snapshot_index_state` table with `complete` flag | `SELECT DISTINCT` only catches missing snapshots, not half-written ones |
| D7 | Reverts/recoveries in History | Synthesize rows at query time from `history.json` events | Without this, the feature has unexplained gaps when reverts restore deleted nodes — lies of omission |
| D8 | "Background async" specifics | `setImmediate` yield between per-snapshot transactions | Simpler than `worker_threads` (no per-thread DB connection); enough for one-time 5-30s backfill |
| D9 | Delta encoding | Yes, from day one | 5–20× smaller storage; History rows == actual changes (cleaner UI semantics); hard to retrofit later |
| D10 | Shared `openProjectDatabase` helper | Duplicate the open code instead of extracting (reverses D4) | The whole point of separate files was blast-radius isolation; sharing the open helper undoes that |
| D11 | Schema versioning | `PRAGMA user_version = 1` from v1 | Cheap insurance (~10 lines); retrofitting migrations after data exists is significantly harder |

## Failure modes (and how the plan handles them)

| Codepath | Failure | Handled? |
|---|---|---|
| `recordSnapshot` mid-snapshotCreate | DB write fails (disk full, locked) | Yes — log + continue; backfill catches up on next open. Snapshot is still real, just missing per-node detail until reopen ⚠️ |
| `backfill` parsing an old manifest | One snapshot's JSON is corrupt | Yes — skip that snapshot, mark `complete=0`, log warning, continue |
| `nodeHistory(id)` query | DB unavailable | Yes — return `Result<...>` error; UI shows error state with retry |
| Synthetic revert row generation | Reading old manifest from git fails | Yes — skip that revert event, log. User won't see that revert in History ⚠️ |
| `setImmediate` backfill loop | Process exits during backfill | Implicit — `complete=0` flags resume on next open |

⚠️ Two cases produce silent gaps until next reopen. Tracked in [TODOS.md](../TODOS.md) as a v2 visibility-improvement.

## Implementation order

Four commits, sequential. Each ships its own tests. Each is independently revertable.

### Commit 1: Schema + HistoryIndexService

- `src/main/history-index.ts` (NEW) — `HistoryIndexService` class
  - `openDatabase(projectPath)` — opens `history.db`, applies pragmas, runs schema migrations
  - `recordSnapshot(snapshotId, snapshotOrder, project, previousProject?)` — delta-encoded insert in one transaction; updates `snapshot_index_state`
  - `nodeHistory(nodeId)` — `SELECT … WHERE node_id = ? ORDER BY snapshot_order`
  - `incompleteSnapshots()` — `SELECT snapshot_id FROM snapshot_index_state WHERE complete=0`
  - `recordedSnapshotIds()` — `SELECT snapshot_id FROM snapshot_index_state WHERE complete=1`
  - `close()` — release DB handle
- `tests/unit/main/history-index.test.ts` (NEW)
  - recordSnapshot: happy, idempotency (re-record produces same rows), delta encoding (no-op for identical state), deletion → `presence='absent'` row, recreation
  - nodeHistory: chronological order, empty for unknown id
  - Schema migration: opens, sets `user_version=1`

### Commit 2: snapshotCreate hook + backfill

- `src/main/project-manager.ts` — wire `HistoryIndexService` into `snapshotCreate` and project-open
  - On `openProject`: kick off background backfill if `incompleteSnapshots().length > 0` or `recordedSnapshotIds().length < git tag count`
  - On `snapshotCreate`: after `git.createSnapshot()`, call `history.recordSnapshot(...)`. If it throws, log and continue — backfill recovers.
- Backfill loop: `for (snapshot of allSnapshots)` walking chronologically, awaiting `setImmediate` between per-snapshot transactions. Reads `previousProject` from the previous snapshot for delta comparison.
- `tests/unit/main/project-manager-snapshots.test.ts` — extend with:
  - **Regression test**: `snapshotCreate` succeeds even if `history.recordSnapshot` throws (snapshot is in git, history empty for it)
  - Backfill on a project with snapshots predating the feature: history populates correctly
  - Backfill resumes from `complete=0` rows after simulated crash

### Commit 3: IPC + types

- `src/shared/types.ts` — `NodeHistoryEntry` type
- `src/shared/ipc.ts` — `NODE_HISTORY` channel + API method
- `src/preload/index.ts` — bridge
- `src/main/index.ts` — handler that calls into ProjectManager
- `src/main/project-manager.ts` — `nodeHistory(id)` method that queries `HistoryIndexService` AND synthesizes revert/recover rows from `history.json`
- `tests/unit/main/project-manager-node-history.test.ts` (NEW) — IPC end-to-end:
  - Create N snapshots with mutations on a node, query, assert chronology
  - Revert past a snapshot that affected the node, assert synthetic revert row appears
  - Node never in any snapshot: empty result

### Commit 4: History tab UI + e2e

- `src/renderer/src/components/DetailPane.svelte` — add tab toggle, History pane
- New `HistoryView.svelte` (or inline) — chronological list, badges, empty/loading states
- `tests/e2e/node-history.e2e.ts` (NEW) — user selects node → opens History → sees chronology with renames/property changes; click a row, etc.

## Performance budget

| Operation | Cost |
|---|---|
| `recordSnapshot` per snapshotCreate | O(nodes) reads (latest row per node) + O(changes) inserts. ~10ms typical. |
| `nodeHistory(id)` query | O(rows for this node) via index. Sub-ms. |
| Synthetic revert/recover synthesis | O(revert events) × cost of reading 2 manifests. Cacheable but not in v1. |
| Backfill (first open after feature ships) | O(snapshots × nodes) reads + O(total changes) inserts. ~1-2s for 100 snapshots × 1000 nodes. Background, yields to event loop. |
| Storage | O(changes), not O(snapshots × nodes). Realistic projects: tens of MB. |

## NOT in scope

- Cross-node history queries ("all changes affecting any node with property X")
- Pagination of history rows
- UI hint when a deleted node has a "near-twin" recreated later under a different uuid
- Cloud-storage sync warning (tracked in `TODOS.md`)
- `git tag -d` reconciliation (tag deletion isn't exposed in the app)
- Validation of node_id collisions across snapshots (no import path exists yet)
- Working-copy (live, unsaved) state shown at top of History view

## Tests planned (summary)

| File | Coverage |
|---|---|
| `tests/unit/main/history-index.test.ts` (NEW) | All HistoryIndexService methods + delta encoding + idempotency |
| `tests/unit/main/project-manager-snapshots.test.ts` (extend) | snapshotCreate regression test (history failure does NOT roll back the snapshot); backfill correctness |
| `tests/unit/main/project-manager-node-history.test.ts` (NEW) | IPC end-to-end including synthetic revert/recover rows |
| `tests/e2e/node-history.e2e.ts` (NEW) | History tab UX |

## What this plan reuses

- [src/main/git-service.ts](../src/main/git-service.ts) `readSnapshotManifest` — for backfill and revert/recover synthesis
- [src/main/project-manager.ts](../src/main/project-manager.ts) `loadAndDiff` — pattern for reading snapshot pairs
- [src/shared/diff-engine.ts](../src/shared/diff-engine.ts) `diffProjects` — to detect whether a revert/recover event changed a specific node
- [src/shared/snapshot-history-migration.ts](../src/shared/snapshot-history-migration.ts) — pattern for `history.db` schema migrations (mirror, don't share)
- Existing per-project SQLite plumbing pattern from [src/main/search-index.ts](../src/main/search-index.ts) (mirror, don't share — see D10)
