// Pure CSV-import planning. The single source of truth for what an import will
// do: used by both the `plan` (preview) and `apply` IPC paths so the preview
// can never disagree with the result. No filesystem, no node creation — it
// returns the planned (parentId, name, properties) tuples plus per-row issues.

import type {
  ManifestNode,
  NodeTemplate,
  ImportMapping,
  ImportIssue,
} from './types'
import {
  validateNodeName,
  validatePropertyKey,
  validatePropertyValue,
  validateTypedPropertyValue,
  coercePropertyValue,
  templateFields,
} from './validation'

export interface PlannedNode {
  // For auto-created ancestors, parentId may reference another planned node's
  // `localId` rather than an existing node id; apply resolves these in order.
  parentId: string
  name: string
  properties: Record<string, string | number | boolean | null>
  templateId: string | null
  // Set only on auto-created breadcrumb ancestors: a synthetic id that later
  // planned nodes reference as their parentId, plus a flag so callers can count
  // created parents separately from imported rows.
  localId?: string
  auto?: boolean
}

export interface PlanOutput {
  create: PlannedNode[]
  skipped: ImportIssue[]
  warnings: ImportIssue[]
  // A mapping-level error (not a per-row problem) — e.g. duplicate keys or a
  // missing name column. When set, nothing is imported.
  mappingError?: string
}

const DEFAULT_PATH_SEPARATOR = ' / '

// Suggest a valid property key from a spreadsheet header ("Serial Number" →
// "serial_number"). The user can edit it; this only seeds the mapping.
export function suggestKey(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64)
}

function lower(s: string): string {
  return s.toLowerCase()
}

export function planImport(
  rows: string[][],
  headers: string[],
  mapping: ImportMapping,
  templates: Record<string, NodeTemplate>,
  nodes: ManifestNode[],
): PlanOutput {
  const out: PlanOutput = { create: [], skipped: [], warnings: [] }

  // ── Mapping validation (preconditions) ──────────────────────────────────────
  const headerIndex = new Map(headers.map((h, i) => [h, i]))
  const mappingError = (msg: string): PlanOutput => ({ ...out, mappingError: msg })

  if (!mapping.nameColumn || !headerIndex.has(mapping.nameColumn)) {
    return mappingError('Name column is not set or not found in the file')
  }
  if (mapping.placement === 'path') {
    if (!mapping.pathColumn || !headerIndex.has(mapping.pathColumn)) {
      return mappingError('Path placement requires a path column that exists in the file')
    }
  }
  const baseNode = nodes.find(n => n.id === mapping.baseParentId)
  if (!baseNode) return mappingError('Target parent not found')

  const template = mapping.templateId ? templates[mapping.templateId] : undefined
  if (mapping.templateId && !template) return mappingError(`Template not found: ${mapping.templateId}`)
  const fields = templateFields(template)

  const included = mapping.columns.filter(c => c.include)
  const seenKeys = new Set<string>()
  for (const c of included) {
    if (c.header === mapping.nameColumn || c.header === mapping.pathColumn) {
      return mappingError(`Column "${c.header}" is already used as the name/path column`)
    }
    const keyCheck = validatePropertyKey(c.key)
    if (!keyCheck.valid) return mappingError(`Column "${c.header}": ${keyCheck.message}`)
    if (seenKeys.has(c.key)) return mappingError(`Duplicate property key "${c.key}" — each column needs a distinct key`)
    seenKeys.add(c.key)
  }

  const nameIdx = headerIndex.get(mapping.nameColumn)!
  const pathIdx = mapping.pathColumn ? headerIndex.get(mapping.pathColumn) : undefined
  const sep = mapping.pathSeparator || DEFAULT_PATH_SEPARATOR
  const rootName = nodes.find(n => n.parentId === null)?.name ?? ''

  // ── Indexes for parent resolution + collision checks ────────────────────────
  const childrenByParent = new Map<string, ManifestNode[]>()
  for (const n of nodes) {
    if (n.parentId === null) continue
    const arr = childrenByParent.get(n.parentId)
    if (arr) arr.push(n)
    else childrenByParent.set(n.parentId, [n])
  }
  const childByName = (parentId: string, name: string): ManifestNode | undefined =>
    (childrenByParent.get(parentId) ?? []).find(c => lower(c.name) === lower(name))

  // Single index of nodes created/claimed THIS batch, keyed by (parent, name).
  // Both leaf rows and auto-created ancestors register here, so collision checks
  // and path resolution share one namespace — a row-created node and an
  // auto-created ancestor can never end up as same-named siblings under one
  // parent, and a later path can resolve THROUGH a node an earlier row created.
  // The separator is a space; parent ids (uuids / synthetic ids) never contain
  // one, so the (parentId, name) key is unambiguous.
  const autoCreate = mapping.placement === 'path' && mapping.autoCreateParents === true
  const childKey = (parentId: string, name: string) => `${parentId} ${lower(name)}`
  const batchChildren = new Map<string, string>() // childKey → local id of the in-batch node
  let synthSeq = 0
  const nextLocalId = () => `__import_${synthSeq++}__`
  const claim = (parentId: string, name: string, localId: string) => {
    batchChildren.set(childKey(parentId, name), localId)
  }
  const taken = (parentId: string, name: string): boolean =>
    childByName(parentId, name) !== undefined || batchChildren.has(childKey(parentId, name))

  // Resolve a breadcrumb to a parent id. With autoCreate, missing segments are
  // *staged* (not yet committed) and returned in `pending`; the caller commits
  // them only after the row passes all checks, so a skipped row leaves no
  // orphan ancestors.
  const resolveParent = (
    pathValue: string,
  ): { id: string; pending: PlannedNode[] } | { error: string } => {
    if (mapping.placement === 'flat') return { id: mapping.baseParentId, pending: [] }
    let segments = pathValue.split(sep).map(s => s.trim()).filter(Boolean)
    // Tolerate a leading segment equal to the base's or root's name so generator
    // CSVs (whose breadcrumb starts at the project root) round-trip.
    if (segments.length > 0 && (lower(segments[0]) === lower(baseNode.name) || lower(segments[0]) === lower(rootName))) {
      segments = segments.slice(1)
    }
    let cur = mapping.baseParentId
    const pending: PlannedNode[] = []
    for (const seg of segments) {
      const child = childByName(cur, seg)
      if (child) { cur = child.id; continue }
      // A node already created (row OR ancestor) this batch at this level.
      const committed = batchChildren.get(childKey(cur, seg))
      if (committed) { cur = committed; continue }
      // A new ancestor created earlier in THIS walk (not yet committed).
      const staged = pending.find(p => p.parentId === cur && lower(p.name) === lower(seg))
      if (staged) { cur = staged.localId!; continue }
      if (!autoCreate) return { error: `path not found: "${pathValue}"` }
      // Hold auto-created segment names to the same standard as a row name.
      const segCheck = validateNodeName(seg)
      if (!segCheck.valid) {
        return { error: `cannot create path segment "${seg}": ${segCheck.message ?? 'invalid name'}` }
      }
      const id = nextLocalId()
      pending.push({ parentId: cur, name: seg, properties: {}, templateId: null, localId: id, auto: true })
      cur = id
    }
    return { id: cur, pending }
  }

  // ── Per-row planning ────────────────────────────────────────────────────────
  rows.forEach((cells, r) => {
    const fileRow = r + 2 // header is file row 1
    const name = (cells[nameIdx] ?? '').trim()

    const nameCheck = validateNodeName(name)
    if (!nameCheck.valid) {
      out.skipped.push({ row: fileRow, column: mapping.nameColumn, reason: nameCheck.message ?? 'Invalid name' })
      return
    }

    const resolved = resolveParent(pathIdx !== undefined ? (cells[pathIdx] ?? '') : '')
    if ('error' in resolved) {
      out.skipped.push({ row: fileRow, column: mapping.pathColumn, reason: resolved.error })
      return
    }
    const parentId = resolved.id

    if (taken(parentId, name)) {
      out.skipped.push({ row: fileRow, column: mapping.nameColumn, reason: `name "${name}" already exists under the target parent` })
      return
    }

    // Build properties; an invalid typed/ad-hoc cell skips the whole row.
    const properties: Record<string, string | number | boolean | null> = {}
    let rowFailed = false
    for (const col of included) {
      const raw = (cells[headerIndex.get(col.header)!] ?? '').trim()
      if (raw === '') continue // empty cell → leave unset
      const field = fields[col.key]
      if (field) {
        const result = coercePropertyValue(raw, field)
        if (!result.valid) {
          out.skipped.push({ row: fileRow, column: col.header, reason: result.message ?? 'Invalid value' })
          rowFailed = true
          break
        }
        properties[col.key] = result.value ?? null
      } else {
        const check = validatePropertyValue(raw)
        if (!check.valid) {
          out.skipped.push({ row: fileRow, column: col.header, reason: check.message ?? 'Invalid value' })
          rowFailed = true
          break
        }
        properties[col.key] = raw
      }
    }
    if (rowFailed) return

    // Missing required fields are advisory warnings — keep the row.
    for (const [key, field] of Object.entries(fields)) {
      const v = properties[key]
      if (field.required && (v === undefined || v === null || v === '')) {
        out.warnings.push({ row: fileRow, column: key, reason: `required field "${key}" is not set` })
      }
    }

    // Commit any staged ancestors this row needed, then the row itself. Each
    // gets a local id and is registered so later rows resolve THROUGH it (and
    // collide with it) instead of creating a duplicate sibling.
    for (const node of resolved.pending) {
      claim(node.parentId, node.name, node.localId!)
      out.create.push(node)
    }
    const rowLocalId = nextLocalId()
    claim(parentId, name, rowLocalId)
    out.create.push({ parentId, name, properties, templateId: mapping.templateId ?? null, localId: rowLocalId })
  })

  return out
}

// Re-exported for callers that want to validate a single value the same way the
// planner does (keeps the rule in one import surface).
export { validateTypedPropertyValue }
