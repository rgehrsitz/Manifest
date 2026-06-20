---
name: feedback-native-abi-rebuild-order
description: better-sqlite3 is a native module — rebuild it for the runtime you're about to use. Node ABI for unit tests, Electron ABI for E2E and the dev app; never leave it node-built.
metadata:
  type: feedback
---

`better-sqlite3` is a compiled native addon with a runtime-specific ABI
(NODE_MODULE_VERSION). Manifest runs it under two different runtimes:
- **Vitest unit tests run under Node** → `bun run rebuild:native:node` (ABI 127).
- **E2E (Playwright/Electron) and the dev app run under Electron** → `bun run rebuild:native:electron` (ABI 132).

**Why:** mid-session I ran `rebuild:native:node` for the unit suite, then launched
E2E (and the user's dev app was open) WITHOUT re-running the electron rebuild.
Every project-open failed with "compiled against a different Node.js version using
NODE_MODULE_VERSION 127 ... requires 132" — all E2E red, dev app's search index
broken. It looked like a code regression; it was just the wrong ABI.

**How to apply:**
- Rebuild for the runtime IMMEDIATELY before using it: `rebuild:native:electron`
  right before `build` + `playwright test` or `bun run dev`; `rebuild:native:node`
  right before `bun run test` (vitest).
- When interleaving unit and E2E in one verification pass, do unit first, then
  rebuild for electron and do E2E — so you END in the electron-built state the
  dev app needs. Never leave a session node-built if the app might be launched.

**RECURRING MISTAKE (flagged by Robert more than once) — do NOT chain unit then
E2E in a single shell command.** The trap:
`rebuild:native:node && vitest … && playwright test` leaves better-sqlite3
NODE-built when Playwright launches Electron → every E2E project-open fails on
the ABI mismatch. The chain rebuilds for node up front but NEVER rebuilds for
electron, so Playwright starts against node-built native modules.
- Prefer the package.json scripts, which self-rebuild: `bun run test` (node) and
  `bun run test:e2e` (electron rebuild + build + playwright). Run them as
  SEPARATE invocations, never `&&`-joined.
- If invoking `playwright`/`vitest` directly, run `rebuild:native:electron`
  (or `:node`) as its OWN command in the SAME invocation as that one suite only,
  with nothing for the other runtime after it.
Related: [[project_report_export]], [[project_csv_import]].
