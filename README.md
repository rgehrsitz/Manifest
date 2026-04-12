<p align="center">
  <img src="resources/manifest.svg" alt="Manifest logo" width="160" />
</p>

<h1 align="center">Manifest</h1>

<p align="center">
  Structured projects. Named history. Clear changes.
</p>

Manifest is a local-first desktop app for managing structured, hierarchical projects with snapshot history and semantic diffs. It is built with Electron, TypeScript, Svelte 5, Tailwind, SQLite FTS5, and Git-backed history.

## Highlights

- Manage nested project structures in a desktop-native workflow.
- Save named snapshots and compare project states with semantic change summaries.
- Search node names and properties with SQLite FTS5.
- Keep project state in a readable `manifest.json` file with local-first ownership.

## Development

```bash
bun install
bun run dev
```

Useful commands:

- `bun run test`
- `bun run test:e2e`
- `bun run build`
- `python3 scripts/generate_brand_assets.py`

## Docs

Project documentation lives in [docs/README.md](docs/README.md).
