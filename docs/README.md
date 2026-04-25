<p align="center">
  <img src="../resources/manifest.svg" alt="Manifest logo" width="120" />
</p>

# Manifest — Docs

Planning and architecture documentation for Manifest.

Manifest is a local-first desktop app for managing structured, hierarchical projects with named snapshots, semantic change awareness, and a clean diff view. Built with Electron + TypeScript + Svelte 5 + Tailwind.

---

## Document map

| Doc | Purpose |
|-----|---------|
| [VISION.md](VISION.md) | Product intent, target users, and v1 success criteria |
| [PRODUCT_USAGE_MODEL.md](PRODUCT_USAGE_MODEL.md) | Product semantics, personas, and current-project/snapshot flows |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Technical shape: stack, IPC contract, data model, storage, diff engine, security |
| [ROADMAP.md](ROADMAP.md) | Phase-by-phase delivery plan (Phases 1–5) |
| [UI_PRINCIPLES.md](UI_PRINCIPLES.md) | Visual and interaction principles for the renderer |
| [TODOS.md](TODOS.md) | Active and deferred product/engineering work |
| [PILOT_DOGFOOD.md](PILOT_DOGFOOD.md) | Pilot-readiness dogfood checklist and import decision gate |

---

## Status

The core v1 surface is implemented: project lifecycle, hierarchy editing, search,
named snapshots, semantic compare, restore, E2E coverage, and packaging
verification.

The next phase is pilot readiness: dogfood the packaged app with representative
data, then use those notes to scope the CSV/JSON import MVP.

---

## Key decisions (locked)

- **Stack:** Electron + TypeScript + Svelte 5 + Tailwind + electron-vite
- **Storage:** Single `manifest.json` per project, Git-backed snapshots
- **Snapshots:** System `git` CLI only, hidden behind product UX
- **IPC:** Typed `contextBridge` with 13 defined channels, `Result<T>` envelope
- **Search:** SQLite FTS5 via `better-sqlite3`, rebuildable, non-authoritative
- **Diff:** Semantic, node-level, 6 change types, multi-change per node
- **Distribution:** `electron-builder` (macOS DMG, Windows NSIS, Linux AppImage)
