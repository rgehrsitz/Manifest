---
name: feedback-scan-nul-before-commit
description: Scan Write/Edit-authored files for NUL/control bytes before committing — a stray NUL makes git treat the file as binary.
metadata:
  type: feedback
---

When authoring code with the Write/Edit tools, a literal control byte (NUL,
`\x00`) can get embedded where a visible separator was intended — e.g. a
composite map-key like `` `${parentId}<SEP>${name}` ``. The file still compiles
and tests pass, but git treats it as **binary** (`git diff --numstat` shows
`-  -`, `file` reports `data`), so it has no readable diff and is unreviewable.

**Why:** happened in `src/shared/import.ts` (CSV import) — `childKey` went in as
a real NUL. Caught only because the ship pre-flight diff showed `Bin 0 -> 9842`.

**How to apply:** before committing files just written/edited, scan for NULs:
`LC_ALL=C grep -aPc '\x00' <file>` and check `file <path>` says "text". Fix by
using a plain-text separator (a space is safe when keys are ids that can't
contain one), or write the NUL as a six-character backslash-u-zero-zero-zero-zero
escape so the source stays plain text. Related: [[CSV import design]].
