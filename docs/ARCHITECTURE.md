# Manifest Architecture (Initial Draft)

## Goals

This document proposes the initial technical shape for Manifest as a **greenfield Electron + TypeScript + Svelte 5 + Tailwind** desktop application.

The goal is not to reproduce Archon’s Wails/Go architecture. The goal is to keep the strongest *concepts* while simplifying the implementation model and tightening the desktop UX.

---

## Proposed stack

| Layer | Choice | Notes |
|---|---|---|
| Desktop shell | `Electron` | Mainstream desktop runtime with strong ecosystem support |
| App language | `TypeScript` | Shared language across main, preload, renderer, and tooling |
| UI | `Svelte 5` | Reactive, fast, good fit for sophisticated desktop interactions |
| Styling | `Tailwind` | Rapid iteration with a clear design system path |
| Build tooling | `electron-vite` | Vite-based, handles main/preload/renderer separation, HMR, and node externals |
| Testing | `Vitest` + Playwright | Unit + desktop/UI verification |

---

## High-level system shape

Manifest should have four explicit layers:

### 1. Main process
Responsible for:

- project open/save lifecycle
- filesystem access
- snapshot/history orchestration
- search indexing
- background jobs and logging

### 2. Preload / IPC boundary
Responsible for:

- exposing a **small, typed API surface** to the renderer
- isolating privileged operations from the UI
- enforcing explicit contracts and error shapes

### 3. Renderer
Responsible for:

- hierarchy browsing and editing
- inspectors, panels, dialogs, commands
- diff/history UI
- settings and onboarding UX

**State management:** The renderer maintains a reactive store (Svelte 5 runes)
that mirrors the current project state. The flow is unidirectional:

1. User action in renderer (e.g., rename node)
2. Renderer sends IPC request to main (`node:update`)
3. Main validates, persists, updates search index
4. Main returns `Result<Node>` via IPC
5. Renderer updates its store from the response

No direct state mutation. The main process is always the source of truth.
The renderer store is a read-optimized mirror for fast UI rendering.

**Undo/redo:** The renderer maintains an operation stack (max 50 entries).
Each mutation sent via IPC returns an `UndoEntry`: `{ forward: IpcRequest,
reverse: IpcRequest }`.

- **Undo:** pop the stack, send the reverse IPC request.
- **Redo:** push to a redo stack, send the forward IPC request.
- The stack resets on project open or snapshot restore (both are
  wholesale state changes that can't be incrementally undone).
- Batch operations (e.g., delete a subtree) produce a single undo
  entry that reverses the entire batch.
- **What counts as one operation:** Each IPC mutation call is one operation.
  Multi-select actions (move 5 nodes) are batched into one entry.
  Property edits are debounced: rapid keystrokes on the same field
  collapse into one undo entry (debounce 1 second).
- **Undo does not reverse autosave.** Undo replays the reverse IPC call,
  which triggers a new autosave of the resulting state.

### 4. Shared contracts
Responsible for:

- common types
- error envelopes
- IPC request/response definitions
- domain model helpers safe for both sides
- **validation functions** (snapshot name, node name, property key/value rules).
  Both renderer (for UI feedback) and main (for security) import from the
  same `src/shared/validation.ts`. Never duplicate validation regexes.

### IPC channel contract (v1)

All channels are renderer-to-main. All responses use the `Result<T>` envelope.

| Channel | Request | Response |
|---------|---------|----------|
| `project:create` | `{ name, path }` | `Result<Project>` |
| `project:open` | `{ path }` | `Result<Project>` |
| `project:save` | `{ project }` | `Result<void>` |
| `node:create` | `{ parentId, name, order }` | `Result<Node>` |
| `node:update` | `{ id, changes }` | `Result<Node>` |
| `node:delete` | `{ id }` | `Result<void>` |
| `node:move` | `{ id, newParentId, newOrder }` | `Result<void>` |
| `search:query` | `{ query }` | `Result<SearchResult[]>` |
| `snapshot:create` | `{ name }` | `Result<Snapshot>` |
| `snapshot:list` | `{}` | `Result<Snapshot[]>` |
| `snapshot:compare` | `{ a, b }` | `Result<DiffEntry[]>` |
| `snapshot:restore` | `{ name }` | `Result<void>` |
| `git:check` | `{}` | `Result<GitStatus>` |

This table is the whitelist for `contextBridge.exposeInMainWorld`. No channel
exists unless it's in this table. Add new channels here before implementing them.

---

## Initial repository shape

A straightforward app layout should be enough for v1:

```text
manifest/
  src/
    main/
    preload/
    renderer/
    shared/
  tests/
  docs/
```

If the codebase grows, shared logic can later move into separate packages. It should not start as a premature monorepo.

---

## Data model direction

Based on Archon’s strongest ideas, Manifest should likely preserve:

- **stable immutable IDs** for nodes
- **sibling-local naming rules** rather than global uniqueness
- **meaningful child order**
- a **hierarchical project model** as the core abstraction

### On-disk layout (locked)

```text
myproject/
  manifest.json                    # single canonical file, all nodes inline
  .git/                            # auto-initialized, hidden behind snapshot UX
  .manifest/
    index/search.db                # derived, rebuildable SQLite + FTS5
    logs/                          # structured rotating logs
```

**Why single file:** Simplest to inspect, version, and debug. Covers the validated
use case (low-thousands of records). Sharding to per-node files can be earned later
if benchmarks demand it.

**Performance targets:**
- Project open (parse + validate + index rebuild): <1 second for 5000 nodes
- Show a loading indicator during project open
- Diff computation: <2 seconds for comparing two 5000-node manifests
- Search query: <100ms response time
- Autosave write: <200ms for 5000 nodes

**manifest.json envelope:**

```json
{
  "version": 1,
  "id": "<project-uuid>",
  "name": "My Lab Bench",
  "created": "2026-04-07T12:00:00Z",
  "modified": "2026-04-07T14:30:00Z",
  "nodes": [
    {
      "id": "<uuidv7>",
      "parentId": "<uuidv7 | null for root>",
      "name": "Rack A",
      "order": 0,
      "properties": {
        "serial_number": "SN-12345",
        "firmware": "v2.1.0"
      },
      "created": "2026-04-07T12:00:00Z",
      "modified": "2026-04-07T14:30:00Z"
    }
  ]
}
```

**Key constraints:**
- `id` is immutable UUIDv7 (time-sortable)
- `name` must be unique among siblings (case-insensitive)
- `order` is an integer for sibling ordering
- `properties` is a flat string-keyed map (values: string, number, boolean, null)
- `parentId: null` denotes a root node (exactly one root per project)

---

## History and snapshots (locked)

Snapshots are the core differentiator. They are Git commits + tags, hidden behind
a product UX that never exposes Git directly.

### Git integration mechanics

- **Auto-init:** On "Create Project," Manifest runs `git init` in the project directory.
  The `.git` directory is never shown in the UI.
- **Snapshot creation:** User clicks "Create Snapshot" and provides a name.
  Manifest runs: `git add manifest.json && git commit -m "<name>" && git tag "snapshot/<name>"`.
- **Snapshot listing:** `git tag --list "snapshot/*" --sort=-creatordate` to enumerate.
- **Snapshot compare:** `git show snapshot/<name1>:manifest.json` vs
  `git show snapshot/<name2>:manifest.json`, then run the semantic diff engine.
- **Restore:** `git show snapshot/<name>:manifest.json > manifest.json` to restore
  a prior state (creates a new working state, does not rewrite history).
- **Concurrency guard (UI):** Disable snapshot UI controls (create, restore) while
  any git operation is in flight. Re-enable on success or failure.
- **Serial operation queue (implementation):** All git operations and file writes
  run through a single async queue in the main process. Operations are enqueued
  and executed one at a time. If a git op is in flight, subsequent requests wait.
  This prevents `.git/index.lock` contention at the implementation level, not
  just the UI level.

### Semantic diff engine

Compares two manifest.json snapshots node-by-node using stable `id` as the join key:

| Change type | Detection | Severity |
|---|---|---|
| Node added | id exists in B but not A | High |
| Node removed | id exists in A but not B | High |
| Node moved | same id, different parentId | High |
| Node renamed | same id, different name | Medium |
| Property changed | same id, different property value | Medium |
| Order changed | same id + parentId, different order | Low |

Output: a list of `DiffEntry` objects, each with: nodeId, changeType, severity,
oldValue, newValue, and context (parent name + path).

**Multi-change rule:** A single node can produce multiple `DiffEntry` records
(e.g., moved + renamed + property changed). Each change type is checked
independently. In the briefing view, the node's highest severity determines
its grouping position.

### Diff engine pipeline

```
  Snapshot A (JSON)          Snapshot B (JSON)
       |                          |
       v                          v
  Parse + build               Parse + build
  Map<id, NodeA>              Map<id, NodeB>
       |                          |
       +----------+  +------------+
                  |  |
                  v  v
           Merge keys (union of all IDs)
                  |
                  v
          For each ID, classify:
          +---------------------------+
          | ID in B only?  -> Added   |
          | ID in A only?  -> Removed |
          | parentId diff? -> Moved   |
          | name diff?     -> Renamed |
          | props diff?    -> Changed |
          | order diff?    -> Reorder |
          +---------------------------+
                  |
                  v
          Assign severity per change type
                  |
                  v
          Build context (parent path for each node)
                  |
                  v
          Sort by severity (High > Medium > Low)
                  |
                  v
            DiffEntry[]
```

### Implementation stance

- **v1:** Named snapshots, semantic diff, operational briefing view
- **v1.1+:** Richer diff views, timeline visualization
- **Later:** Three-way merge only when collaboration demands it

### Autosave vs snapshot boundary

- **Autosave** writes `manifest.json` to disk only. No Git operations.
  Debounce at 2-3 seconds. Uses atomic write (temp file + rename).
- **Snapshot** writes to disk, then runs `git add + commit + tag`.
  Only triggered by explicit user action ("Create Snapshot").
- Between snapshots, the Git working tree is intentionally dirty.
  `manifest.json` on disk is always the latest state. Snapshots are
  explicit named checkpoints in Git history.
- **Snapshot flush rule:** Before any snapshot git operations, flush pending
  autosave state. Cancel the debounce timer, write current in-memory state
  to disk via atomic write, then proceed with git add + commit + tag.
  This ensures the snapshot always captures the exact current state,
  never a stale or mid-write version.
- If the app crashes between autosaves, the last successful atomic write
  is the recovery point. If `.git` exists, the last snapshot is also recoverable.

### Schema migration

On project open, check `manifest.json` `version` field:

```typescript
// Migration pipeline: run sequentially, each step is lossless
const migrations: Record<number, (data: any) => any> = {
  // 1 -> 2: example future migration
  // 2: (data) => { data.nodes.forEach(n => n.newField = defaultValue); data.version = 2; return data; }
}

function migrate(data: any): any {
  while (data.version < CURRENT_VERSION) {
    const migrator = migrations[data.version + 1]
    if (!migrator) throw new SchemaVersionError(data.version, CURRENT_VERSION)
    data = migrator(data)
  }
  return data
}
```

Rules:
- Migrations are always forward-only and lossless
- Each migration is a pure function (input manifest -> output manifest)
- After migration, auto-save the upgraded file to disk
- If migration fails, show error with the version mismatch and do not modify the file
- Never silently drop fields. Unknown fields are preserved through migrations.

### Git operational constraints

- System Git CLI only. No libgit2, no go-git, no hybrid implementation.
- **Version check on launch:** Run `git --version` on first app launch. If Git
  is not found or version is < 2.25, show a dialog with OS-specific install
  instructions and a link. Do not allow project creation until Git is available.
  Cache the check result; re-check on app update.
- Projects on cloud-synced folders (Dropbox, iCloud): warn user on project create
  that `.git` may conflict with sync. Recommend local-only storage.
- Minimum Git version: 2.25+ (for `git tag --sort` support).

---

## Search and indexing

Archon’s rebuildable SQLite index is a strong precedent and should likely carry over.

### Recommended rule

- the **project files are authoritative**
- the **search index is derived and disposable**

This keeps search fast without making the index a source of truth.

### Implementation: better-sqlite3

Use `better-sqlite3` for synchronous SQLite access with FTS5 in the main process.
Requires `@electron/rebuild` to compile for Electron's Node version. Add a
postinstall script: `electron-rebuild -f -w better-sqlite3`.

### Search index lifecycle

- **Full rebuild:** On project open, or if `search.db` is missing/corrupt.
  Delete and recreate from `manifest.json`. For 5000 nodes, target <1 second.
- **Incremental sync:** On each node create/update/delete, update the
  corresponding FTS5 row. This is a single INSERT/UPDATE/DELETE per
  operation, not a full reindex.
- **No rebuild on autosave.** Autosave writes `manifest.json` to disk;
  the search index is already current from incremental sync.

---

## Error handling and logging

### Error envelope

All IPC responses use a typed envelope:

```typescript
type Result<T> = { ok: true; data: T } | { ok: false; error: AppError }
type AppError = { code: string; message: string; context?: Record<string, unknown> }
```

No catch-all handlers. Every error has a named code and a user-facing message.

### Error codes

All error codes are `SCREAMING_SNAKE` strings defined in `src/shared/errors.ts`:

```typescript
export const ErrorCode = {
  GIT_CORRUPT: 'GIT_CORRUPT',
  GIT_COMMIT_FAILED: 'GIT_COMMIT_FAILED',
  GIT_NOT_FOUND: 'GIT_NOT_FOUND',
  DIFF_TIMEOUT: 'DIFF_TIMEOUT',
  INVALID_HIERARCHY: 'INVALID_HIERARCHY',
  DUPLICATE_ID: 'DUPLICATE_ID',
  SQLITE_CAPABILITY: 'SQLITE_CAPABILITY',
  PDF_GENERATION: 'PDF_GENERATION',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  PROJECT_NOT_FOUND: 'PROJECT_NOT_FOUND',
  SCHEMA_VERSION: 'SCHEMA_VERSION',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  AUTOSAVE_WRITE_FAILED: 'AUTOSAVE_WRITE_FAILED',
} as const
```

### Error rescue map (v1 critical paths)

| Error | Rescue action | User sees |
|---|---|---|
| GitCorruptError | Attempt `git fsck --full`. If repairable, fix silently. If not, offer to re-init .git from current manifest.json (loses history but preserves current state). Log full diagnostics. | "Project history may be damaged. [Repair] [Start fresh history]" |
| GitCommitError | Log stderr from Git. If auth-related, surface. If lock-related, retry once after 500ms. Otherwise show dialog with raw error. | "Could not save snapshot. [Details] [Retry]" |
| DiffTimeoutError | Cap diff computation at 5 seconds. If exceeded, show partial results with a warning. Log the node count and elapsed time. | "Comparison is taking too long (N nodes). Showing partial results." |
| InvalidHierarchyError | Log the specific violation (circular ref, orphaned node). Refuse to save. Show diagnostic with node IDs. | "Project structure has an error: [specific issue]. Please fix before saving." |
| DuplicateIdError | Log both nodes. On load, auto-assign a new UUIDv7 to the duplicate and warn the user. | "Found duplicate node IDs. Automatically resolved. Please review." |
| SQLiteCapabilityError | Fall back to in-memory linear scan (Array.filter over the node list). Slower but functional at <5000 nodes. Log the SQLite version/capabilities. | Search works but may be slower. No blocking dialog. |
| PDFGenerationError | Log the Electron error. Show dialog with option to retry or copy briefing text to clipboard instead. | "PDF export failed. [Retry] [Copy as text]" |
| AutosaveWriteError | Log the filesystem error. Show a persistent warning banner (not a blocking dialog). Retry on next debounce cycle. If 3 consecutive failures, show a blocking dialog. | "Unable to save changes to disk. [Details]" |

**PDF export (Phase 4):** Use Electron's `BrowserWindow.webContents.printToPDF()`
on the briefing view. Requires a print-optimized CSS stylesheet. No external
libraries needed.

### Logging

- Structured JSON logs, namespaced by subsystem (e.g., `git`, `persistence`, `diff`, `search`)
- Rotating file logs in `.manifest/logs/`, max 5 files x 5MB each
- Log levels: error, warn, info, debug
- Every rescued error logs: what was attempted, with what arguments, what failed, what recovery was taken
- Logs are never shown in the UI by default but are accessible via a "Show Logs" developer menu item

---

## Testing strategy

### Framework

- **Unit:** Vitest (shared/, main/ modules)
- **E2E:** Playwright (user flows, multi-step interactions)
- **Integration:** Vitest with real git repo in temp dir (git-service tests)

### Organization

```text
tests/
  unit/
    shared/     # validation, diff-engine, migration
    main/       # project-manager, git-service, search-index
  e2e/          # full user flows via Playwright
  fixtures/     # sample manifest.json files for testing
```

### Coverage targets per phase

- **Phase 1:** project lifecycle, IPC bridge, validation, migration
- **Phase 2:** tree CRUD operations, search index, autosave
- **Phase 3:** diff engine (heaviest coverage), snapshot workflow,
  briefing view, command palette
- **Phase 4:** example projects, PDF export

### Diff engine: test-heavy

The diff engine is the core differentiator. It gets:

- One test per change type (6 types)
- Multi-change scenarios (moved + renamed)
- Edge cases (empty manifests, 5000 nodes, root changes)
- Property type variations (string, number, boolean, null)

### Git service: integration tests

Git tests use real git repos in temp directories, not mocks.
Mocking git hides real failure modes (lock files, version differences,
corrupt repos). Each test creates a fresh temp dir, runs real git commands,
and cleans up after.

---

## Input validation and security

### Shell-out safety

All Git CLI calls MUST use `child_process.execFile` (array form), never
`child_process.exec` (string form). This prevents shell metacharacter injection.

```typescript
// CORRECT
execFile('git', ['tag', `snapshot/${name}`], { cwd: projectDir })

// NEVER DO THIS
exec(`git tag "snapshot/${name}"`, { cwd: projectDir })
```

### Input validation rules

| Input | Validation | Rejection message |
|---|---|---|
| Snapshot name | `/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/` | "Snapshot names: letters, numbers, hyphens, underscores, dots. Max 64 chars." |
| Node name | Non-empty, max 255 chars, no path separators (`/`, `\`) | "Node names cannot contain slashes" |
| Project path | Must be a local filesystem path. Warn on cloud-synced dirs. | "Choose a local directory" |
| Search query | Parameterized SQL only. Never interpolate into query strings. | N/A (internal) |
| Property keys | Non-empty, max 64 chars, alphanumeric + underscores | "Property names: letters, numbers, underscores" |
| Property values | Max 10,000 chars (string), standard numeric range (number) | "Value too long" |

### Electron security

- `contextIsolation: true` (mandatory)
- `nodeIntegration: false` in renderer (mandatory)
- `sandbox: true` for renderer (mandatory)
- Preload script uses `contextBridge.exposeInMainWorld` with a whitelist of IPC channels
- No `remote` module usage
- Content Security Policy: restrict to `self` only, no external resource loading

### Manifest.json parsing

- Use `JSON.parse` with a size check first (reject files > 50MB)
- Validate schema version before processing nodes
- Validate each node has required fields (`id`, `name`, `parentId`, `order`)
- Detect and reject circular parent references on load

---

## Distribution and packaging

### Packaging tool

`electron-builder` for all platforms. Mature, well-documented, handles code signing
and installer generation.

### Target platforms

| Platform | Format | Notes |
|----------|--------|-------|
| macOS | DMG | Universal binary (Intel + ARM via `--universal`) |
| Windows | NSIS | Standard installer, auto-elevate for per-machine install |
| Linux | AppImage | Broadest compatibility across distros |

### Code signing

Deferred for initial development. Required before public distribution:
- macOS: Apple Developer ID + notarization (required for Gatekeeper)
- Windows: EV code signing certificate (required for SmartScreen trust)
- Linux: No signing required for AppImage

### Auto-update

Deferred to post-v1. When implemented, use `electron-updater` (part of
electron-builder ecosystem). GitHub Releases as the update source.

### Build configuration

electron-builder config lives in `electron-builder.yml` at project root.
CI/CD pipeline (GitHub Actions) deferred until Phase 1 is functional.

---

## Plugin/integration stance

Archon’s plugin taxonomy is strong, but Manifest should be much more conservative early on.

### Recommendation

- do **not** make plugins a v1 requirement
- keep the architecture open to future extension
- define only a minimal integration surface until the core product is stable

---

## Key architecture decisions to hold for now

1. **Manifest is local-first.**
2. **The renderer never talks directly to the filesystem.**
3. **Project data stays inspectable on disk.**
4. **The search index is rebuildable and non-authoritative.**
5. **Snapshots are first-class; advanced merge is deferred.**
6. **Plugins are optional, not foundational for v1.**

---

## Open questions

Resolved:
1. ~~Git?~~ Required, hidden behind snapshot UX. System Git CLI only.
2. ~~Sharded vs single file?~~ Single manifest.json. Sharding earned later.
3. ~~Thinnest diff?~~ Node add/remove/move/rename + property changes + order changes.

Still open:
4. How much of Archon’s attachment model belongs in the first release?
   (Recommendation: defer attachments entirely for v1. Files can be referenced
   by path in properties, but content-addressed storage is post-v1.)
5. When should integrations and plugins enter the roadmap?
   (Locked: Phase 5, per ROADMAP.md. Not v1 scope.)
