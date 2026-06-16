---
name: Synthetic lab data generator + scale findings
description: scripts/generate-lab.mjs produces a realistic ~7.4k-node test-lab project (v3 templates + typed props) with a ~40-day snapshot timeline; built it because Robert no longer has access to the real (government) datasets.
type: project
---

`scripts/generate-lab.mjs` (`bun run generate:lab`) generates a domain-authentic
synthetic project for dogfooding/perf/demo, since Robert no longer has access to
the original test-site/lab datasets (government data) and can't import the
team's NetBox export without burdening them.

**Shape:** Lab → Rooms → Racks → Devices. Computers carry a Hardware group
(CPU/memory/GPU/NIC/storage) and a Software group (OS + ~5 CSCIs, version-tracked).
Power supplies / waveform generators are calibrated test equipment (last_calibrated
/ calibration_due dates); custom boards fail and get repaired/replaced. 9 templates
exercise every PropertyType (string/number/boolean/date/version/enum). Defaults
~7.4k nodes, ~5 deep, 40 daily snapshots (git commit + `snapshot/<name>` tag —
the app discovers snapshots from tags and synthesizes timeline events, so no
history.json needed; notes aren't emitted, the event is encoded in the snapshot
name). Timeline applies realistic churn: CSCI version bumps, status changes,
recalibrations, GROUPED maintenance events (board + co-located part + supply in
one snapshot), occasional quiet days (0-change), structural add/remove, and two
additive template/schema edits. Also emits a flat `import-sample-custom-boards.csv`
for the upcoming importer. Seeded/reproducible. Verified through the REAL pipeline:
migrate→v3, 0 load warnings, sane diffs, and opens via ProjectManager.

**Scale bug found + fixed:** at ~7.4k nodes a manifest.json is ~1.2 MB, which
exceeded Node's default 1 MB execFile stdout buffer in
`src/main/git-service.ts` (`readSnapshotManifest`/`readHeadManifest`/`listSnapshots`
ran `git show`/`for-each-ref` with no maxBuffer) → snapshot compare/revert failed
with ENOBUFS on large projects. Fixed with `MAX_GIT_BUFFER = 64 MB`; regression
test in `tests/unit/main/git-service.test.ts`. Measured at 7.4k×40: open ~130ms,
history backfill ~1.8s, loadCompare ~100ms, search ~4ms, nodeHistory ~40ms.

**Public dataset for import testing:** netbox-community/netbox-demo-data
(github) — SQL dumps (current) + older JSON (Django dumpdata) parseable directly.
Use as the real-world NetBox-import validation target. The lab used NetBox (poor
fit for labs) so the importer must accommodate NetBox-format input.
Related: [[project_target_domain]], [[project_typed_properties]].
