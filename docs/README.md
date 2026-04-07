# Manifest — Docs

Planning and architecture documentation for Manifest.

Manifest is a local-first desktop app for managing structured, hierarchical projects with named snapshots, semantic change awareness, and a clean diff view. Built with Electron + TypeScript + Svelte 5 + Tailwind.

---

## Document map

| Doc | Purpose |
|-----|---------|
| [VISION.md](VISION.md) | Product intent, target users, and v1 success criteria |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Technical shape: stack, IPC contract, data model, storage, diff engine, security |
| [ROADMAP.md](ROADMAP.md) | Phase-by-phase delivery plan (Phases 1–5) |
| [UI_PRINCIPLES.md](UI_PRINCIPLES.md) | Visual and interaction principles for the renderer |
| [TODOS.md](TODOS.md) | Deferred work: accepted but out of v1 scope |

---

## Status

Phase 0 (direction and constraints) is complete. CEO review and engineering review are done. ARCHITECTURE.md is the authoritative technical spec.

Phase 1 (Electron shell, IPC bridge, project lifecycle) is next.

---

## Key decisions (locked)

- **Stack:** Electron + TypeScript + Svelte 5 + Tailwind + electron-vite
- **Storage:** Single `manifest.json` per project, Git-backed snapshots
- **Snapshots:** System `git` CLI only, hidden behind product UX
- **IPC:** Typed `contextBridge` with 13 defined channels, `Result<T>` envelope
- **Search:** SQLite FTS5 via `better-sqlite3`, rebuildable, non-authoritative
- **Diff:** Semantic, node-level, 6 change types, multi-change per node
- **Distribution:** `electron-builder` (macOS DMG, Windows NSIS, Linux AppImage)
