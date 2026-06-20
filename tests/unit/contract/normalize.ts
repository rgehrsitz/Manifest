// Normalizer for the ManifestAPI contract suite.
//
// The contract goldens must be reproducible by ANY backend that implements the
// same ManifestAPI (today's TypeScript ProjectManager; tomorrow a Rust/Tauri
// backend). So before a Result<T> is compared to a golden, we scrub the values
// that are legitimately nondeterministic across runs and implementations:
//
//   - uuidv7 node/project ids   → `<id:N>`  (stable, first-seen order, so
//                                  references between nodes stay referential)
//   - ISO-8601 timestamps        → `<ts>`
//   - git commit hashes (40 / 7) → `<hash>`
//   - the volatile tmp project path → `<path>`
//
// Everything else — names, structure, property values, statuses, diff/change
// types, counts, error codes, the Result ok/err shape — is the contract and is
// preserved verbatim.

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi
// Matches both UTC (`...Z`) and offset (`...-04:00`) forms — git tag
// creatordate surfaces snapshot timestamps with a local timezone offset.
const ISO_TS_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g
// Human-formatted `YYYY-MM-DD HH:MM` — the diff report header derives this from
// a snapshot's createdAt (`slice(0,16).replace('T',' ')`) and renders it as
// `(<date> · <hash>)`. Scope the scrub to that slot with a ` ·` lookahead so a
// node name / property value / CSV cell that merely contains a date-like
// substring isn't silently scrubbed (same over-scrub guard as the short hash).
const HUMAN_TS_RE = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?= ·)/g
const HASH40_RE = /\b[0-9a-f]{40}\b/gi
// The diff-report header is the only place a 7-char git short hash appears
// (`(<date> · <shorthash>)`). Scope the scrub to that slot rather than a global
// 7-hex rule, which would over-scrub any 7-hex token in names/properties/snippets
// and could mask a real regression (Codex review).
const REPORT_SHORT_HASH_RE = /(· )[0-9a-f]{7}(\))/gi

/**
 * Normalize a Result<T> (or any JSON value) into a deterministic, backend-
 * agnostic shape suitable for golden comparison. `scrub` lists literal strings
 * (e.g. the temp project directory) to replace with `<path>` before the
 * pattern-based scrubbing runs.
 */
export function normalize(value: unknown, scrub: string[] = []): unknown {
  let json = JSON.stringify(value)
  if (json === undefined) return value

  // 1. Literal path scrub first (longest-first so nested paths win). Scrub both
  //    the raw form and its JSON-escaped form — on Windows a `C:\dir` path
  //    serializes as `C:\\dir` inside the stringified JSON, so the raw string
  //    alone would never match (Codex review).
  for (const s of [...scrub].filter(Boolean).sort((a, b) => b.length - a.length)) {
    json = json.split(s).join('<path>')
    const escaped = s.replace(/\\/g, '\\\\')
    if (escaped !== s) json = json.split(escaped).join('<path>')
  }

  // 2. Stable uuid mapping — first-seen order, so a reference value pointing at
  //    a node id maps to the SAME placeholder as that node's id.
  const idMap = new Map<string, string>()
  json = json.replace(UUID_RE, (m) => {
    const key = m.toLowerCase()
    let placeholder = idMap.get(key)
    if (!placeholder) {
      placeholder = `<id:${idMap.size + 1}>`
      idMap.set(key, placeholder)
    }
    return placeholder
  })

  // 3. Timestamps, then hashes (uuids already gone, so their hex can't be hit).
  json = json.replace(ISO_TS_RE, '<ts>')
  json = json.replace(HUMAN_TS_RE, '<ts>')
  json = json.replace(HASH40_RE, '<hash>')
  json = json.replace(REPORT_SHORT_HASH_RE, '$1<hash>$2')

  return JSON.parse(json)
}
