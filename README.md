<p align="center">
  <img src="resources/manifest.svg" alt="Manifest logo" width="160" />
</p>

<h1 align="center">Manifest</h1>

<p align="center">
  Local-first project structure, named snapshots, and a diff view that explains what changed.
</p>

<p align="center">
  Built with Electron, TypeScript, Svelte 5, Tailwind, SQLite FTS5, and Git.
</p>

Manifest is a desktop app for managing structured, hierarchical projects without hiding your data behind a service.

The core idea is simple. Your project lives as a readable `manifest.json` file on disk. Manifest gives you a native UI for editing that structure, saving named snapshots, searching nodes and properties, and comparing project states with semantic diffs instead of raw text churn.

## Why Manifest

- Local-first. Your project data stays in your folder, under your control.
- Human-readable storage. State is persisted to `manifest.json`, not locked in an opaque database.
- Named history. Snapshots are backed by Git, but surfaced as product features.
- Semantic diffs. Compare changes like added, removed, moved, renamed, reordered, and property-changed nodes.
- Fast search. SQLite FTS5 indexes names and properties for renderer-side search.

## Current Features

- Create and open Manifest projects from the desktop app.
- Manage hierarchical node trees with add, rename, delete, reorder, and move operations.
- Edit node properties in the detail pane.
- Autosave project changes back to disk.
- Create named snapshots and restore prior states.
- Compare snapshots with a merged diff/tree view.
- Search node names and property values.

## Stack

- Electron
- TypeScript
- Svelte 5
- Tailwind CSS
- `better-sqlite3` for local FTS5 search
- System Git for snapshot history

## Requirements

You will need:

- [Bun](https://bun.sh/)
- Git available on your system `PATH`
- macOS, Windows, or Linux for Electron development

`better-sqlite3` is a native dependency, so rebuild steps matter. The provided scripts already handle that.

## Quick Start

```bash
bun install
bun run dev
```

## Scripts

```bash
bun run dev             # start Electron in dev mode
bun run build           # production build
bun run test            # unit test suite
bun run test:e2e        # Electron end-to-end tests
bun run package         # build distributable desktop packages
bun run generate:brand  # regenerate app/web icons from resources/manifest.svg
```

## Project Layout

```text
src/main         Electron main process, IPC handlers, project lifecycle
src/preload      contextBridge API exposed to the renderer
src/renderer     Svelte renderer app
src/shared       shared types, IPC contracts, diff logic
tests/unit       unit tests
tests/e2e        Playwright Electron tests
resources        source branding assets and generated desktop icons
docs             product, architecture, and roadmap documentation
```

## Data Model

Each Manifest project is stored in a folder containing a `manifest.json` file.

That file is the source of truth. Search indexes are rebuildable. Snapshot history is Git-backed. The app is designed so the durable project state remains inspectable and portable.

## Branding

The repository branding is generated from [resources/manifest.svg](resources/manifest.svg).

To refresh app icons and web assets after updating the mark:

```bash
bun run generate:brand
```

This regenerates:

- desktop packaging icons in `resources/`
- renderer favicon and logo assets in `src/renderer/public/`

## Documentation

Start here for project docs:

- [docs/README.md](docs/README.md)
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- [docs/ROADMAP.md](docs/ROADMAP.md)
- [docs/UI_PRINCIPLES.md](docs/UI_PRINCIPLES.md)

## Status

Manifest is still early-stage open source software.

The core desktop workflows are in place and covered by unit and Electron end-to-end tests, but the product is still being refined. Expect iteration around UX, packaging, and polish.

## Contributing

There is no formal `CONTRIBUTING.md` yet.

If you want to contribute, start by:

1. Reading [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
2. Running the test suite locally.
3. Keeping changes aligned with the local-first model and semantic diff direction.

## License

Manifest is licensed under the [MIT License](LICENSE).
