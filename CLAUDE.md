# Manifest — Claude Code Instructions

## Project

Manifest is a local-first desktop app for structured project management.
Electron + TypeScript + Svelte 5 + Tailwind + electron-vite.

See `docs/ARCHITECTURE.md` for the full technical spec.
See `docs/ROADMAP.md` for the phase plan.

> **Project memory:** Read every file under `.claude/memory/` at the start of a
> session before responding. These files capture the current state of in-flight
> features, design decisions, and project conventions. They are committed to the
> repo so they are identical on every machine.

## Commands

<!-- Fill in once Phase 1 scaffold is wired up -->

```bash
# Development
bun run dev          # start electron-vite dev server with HMR

# Build
bun run build        # production build

# Tests
bun test             # run all tests (Vitest)
bun run test:e2e     # Playwright E2E tests

# Type check
bun run typecheck    # tsc --noEmit
```

## Testing

Framework: **Vitest** (unit + integration) + **Playwright** (E2E)

- Unit tests live in `tests/unit/`
- E2E tests live in `tests/e2e/`
- Test fixtures (sample manifest.json files) in `tests/fixtures/`
- Git service tests use real git repos in temp directories, never mocks
- Diff engine gets the heaviest unit test coverage (it is the core differentiator)

## Key architecture rules

- Renderer never touches the filesystem directly. All mutations go through IPC.
- All IPC channels are defined in `src/shared/ipc.ts` before implementation.
- All git CLI calls use `execFile`, never `exec`.
- Validation functions live in `src/shared/validation.ts`. Never duplicate them.
- Error codes live in `src/shared/errors.ts`. Use `SCREAMING_SNAKE` constants.
- All IPC responses use `Result<T>` — never throw across the IPC boundary.

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.

Key routing rules:
- Architecture review → invoke plan-eng-review
- Product/scope decisions → invoke plan-ceo-review
- Ship, push, create PR → invoke ship
- QA, test the app → invoke qa
- Code review, check diff → invoke review
- Bugs, errors, "why is this broken" → invoke investigate
