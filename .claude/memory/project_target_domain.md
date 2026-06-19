---
name: Manifest target domain — test-facility configuration management
description: Validated problem space from Robert's first-hand experience — configuration status accounting for large test facilities and dev/test labs; the killer query is "what changed between test X and test Y".
type: project
---

Manifest's concrete target domain is **configuration management / configuration
status accounting for test facilities and labs**, drawn from two real cases
Robert lived (he ran these before retiring in 2026):

1. **Aircraft arresting-gear test site** — large mechanical/electrical/HW/SW
   facility with hundreds to thousands of parts. A daily report went to all
   stakeholders: maintenance performed, parts replaced (and why), HW/SW
   upgrades with versions. When a test anomaly occurred, the critical question
   was "what, if anything, changed between this test and the last one."
2. **Multi-room software dev/test lab** — tight configuration control so that
   the exact SW/HW versions in any rack at any point in time were knowable,
   for test, development, and cyber-compliance reporting.

In both cases spreadsheets/Access handled the daily report fine but failed
catastrophically at point-in-time comparison ("what changed June → September")
— answering took hours to days. That query is exactly Manifest's
snapshot-compare + semantic diff.

**Why:** This closes the "solution looking for a named problem" gap from the
first-look review. Local-first matters extra here: classified/air-gapped
environments cannot use cloud CMDBs.

**How to apply:** Prioritize features this domain demands: typed properties
(versions, part/serial numbers, dates), CSV/spreadsheet import (nobody
re-keys an Access DB), and exportable change reports (the end-of-day diff
report). Frame docs/positioning around test-lab CM rather than generic
"structured projects".
