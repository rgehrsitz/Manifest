---
name: project_report_export
description: Diff/report export — turn the snapshot diff into a shareable Markdown/CSV report a test facility can attach to a record. Phase 4 differentiator. On branch feat/report-export.
metadata:
  type: project
---

Report export = the export half of the killer-query loop (typed properties →
import → snapshot → diff → **export**). Lets "what changed between snapshot X and
Y" leave the app. Built after CSV import (#10). Eng-plan-reviewed + Codex
outside-voice (11 findings folded) before implementation.

**Pieces (pure formatter over existing diff output; 0 new deps):**
- `src/shared/diff-format.ts` (NEW) — extracted the pure, consumer-agnostic
  helpers (`formatChangeType`, `formatTemplateRef`, `formatPath`,
  `describeTemplateChange`) OUT of `src/renderer/src/lib/diff-format.ts` so the
  main process can reuse them; the renderer lib re-exports them + keeps its
  Tailwind class maps and UI `formatValue`/`describePropertyChange`.
- `src/shared/csv.ts` — added `serializeCsv(rows)` (RFC-4180 quoting + **formula-
  injection escape**: cells starting with `= + - @`/tab/CR get a `'` prefix,
  because spreadsheets are the consumer). Symmetric with `parseCsv`.
- `src/shared/report.ts` (NEW, pure) — `formatDiffReportMarkdown`,
  `formatDiffReportCsv`, `diffPropertyMaps`, `ReportContext`, `ReportFormat`.
  Markdown = full report (all changeTypes + schema section via all
  TemplateChangeType). CSV = node changes only, property-changes expanded one row
  per changed key; moved shows old→new path; null/absent/empty rendered distinct
  (`(null)`/empty/`(empty)`). `generatedAt` + snapshot meta injected for testability.
- `src/main/project-manager.ts` — `buildReport(from, to, format)` reuses
  `loadAndDiff` (authoritative) + `diffTemplates`, resolves Snapshot metadata
  (date/hash) via `snapshotList`, builds path/label resolvers, returns
  `{content, suggestedName}`.
- IPC `report.export` (main builds → showSaveDialog → fs.writeFile; renderer never
  touches fs; canceled → savedPath null) + `report.build` (returns content for
  clipboard). Error code `REPORT_WRITE_FAILED`.
- UI: SnapshotsPanel compare header has Copy MD / Export MD / Export CSV
  (prop-driven: `onExportReport`/`onCopyReport`); App calls `window.api.report.*`
  using `mergedTree.fromSnapshot/toSnapshot`, writes clipboard, toasts result.

**Locked decisions:** diff-only (no inventory export); Markdown + CSV (no PDF —
Electron printToPDF is a cheap fast-follow); save-to-file + clipboard; CSV =
node-only with formula escaping.

**Deferred:** single-snapshot inventory export, PDF, independent snapshot picker,
schema changes in CSV.

**CSV schema-safety:** CSV is node-only, but a schema-ONLY diff would otherwise
produce a header-only CSV reading as "no changes" — violating the
never-silently-hide-a-change invariant. So `formatDiffReportCsv` takes
`templateDiffs` and emits a single `schema-change` notice row when any exist
(detail stays in Markdown). Caught by the pre-landing review.

Status: complete on branch `feat/report-export`; 411 unit + 40 E2E green;
typecheck + svelte-check clean. Passed a multi-agent pre-landing review (7
findings folded: the CSV schema-only trap + showSaveDialog-outside-try-catch +
5 test gaps). Plan + review report: `~/.claude/plans/diff-report-export.md`.
Related: [[project_csv_import]], [[project_target_domain]],
[[feedback-native-abi-rebuild-order]].
