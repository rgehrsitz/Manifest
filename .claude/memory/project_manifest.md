---
name: Manifest project context
description: Greenfield Electron/TS/Svelte5/Tailwind desktop app succeeding Archon (Wails/Go). Structured project workspace with hierarchy, history, snapshots, semantic diff.
type: project
---

Manifest is a clean-slate reinvention of Archon (`<code-root>/Archon/`).
Archon was a Wails/Go desktop app that proved concepts but never matured beyond a tech showcase.

**Stack:** Electron + TypeScript + Svelte 5 + Tailwind + Vite + Vitest/Playwright
**Core concepts preserved:** hierarchical project model, stable immutable IDs, snapshots/history, semantic change awareness, local-first, rebuildable search index
**Deliberately deferred:** plugins, CLI, full semantic merge, broad scope

**Why:** Archon had good ideas but the Wails/Go stack and broad ambition prevented it from becoming a polished, usable product. Manifest aims to be the version that gets used by real users and the open source community.

**How to apply:** Treat every Archon concept as needing re-justification. Prefer simpler implementations. Keep v1 narrow and polished. Reference Archon docs at `<code-root>/Archon/docs/` for historical context but don't port code or complexity.
