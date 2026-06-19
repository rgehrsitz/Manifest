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

// An update to an existing node (update-on-key). `properties` is the FINAL merged
// map (existing ∪ row cells); `name` is the final name (renamed only on a
// property-key match whose row name differs). `templateId` present = set this
// binding; absent = leave the node's existing binding.
export interface PlannedUpdate {
  nodeId: string
  name: string
  templateId?: string | null
  properties: Record<string, string | number | boolean | null>
}

export interface PlanOutput {
  create: PlannedNode[]
  update: PlannedUpdate[]
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
  const out: PlanOutput = { create: [], update: [], skipped: [], warnings: [] }

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
    // Fail fast if a mapped header isn't in the file (stale mapping, or the file
    // changed between inspect and apply) — otherwise the cell silently reads as
    // empty and the row imports with the property quietly missing.
    if (!headerIndex.has(c.header)) {
      return mappingError(`Mapped column "${c.header}" is not in the file`)
    }
    if (c.header === mapping.nameColumn || c.header === mapping.pathColumn) {
      return mappingError(`Column "${c.header}" is already used as the name/path column`)
    }
    const keyCheck = validatePropertyKey(c.key)
    if (!keyCheck.valid) return mappingError(`Column "${c.header}": ${keyCheck.message}`)
    if (seenKeys.has(c.key)) return mappingError(`Duplicate property key "${c.key}" — each column needs a distinct key`)
    seenKeys.add(c.key)
  }

  // Update-on-key: resolve the key column to either name-matching (keyPropKey
  // null) or property-matching (keyPropKey = the column's mapped property key,
  // NOT its header). The key column must be the name column or an *included*
  // property column.
  const updateExisting = mapping.updateExisting === true
  let keyPropKey: string | null = null
  if (updateExisting) {
    if (!mapping.keyColumn) return mappingError('Update mode requires a key column')
    if (mapping.keyColumn === mapping.nameColumn) {
      keyPropKey = null
    } else {
      const keyCol = included.find(c => c.header === mapping.keyColumn)
      if (!keyCol) return mappingError(`Key column "${mapping.keyColumn}" must be the name column or an included property column`)
      keyPropKey = keyCol.key
    }
  }

  const nameIdx = headerIndex.get(mapping.nameColumn)!
  const keyIdx = mapping.keyColumn ? headerIndex.get(mapping.keyColumn) : undefined
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

  // ── Update-on-key matching ──────────────────────────────────────────────────
  const norm = (x: unknown): string => String(x ?? '').trim().toLowerCase()
  const updatedIds = new Set<string>()
  // Property-key values claimed by in-batch CREATEs, per parent — so two new rows
  // sharing a key value don't both create (which would make a re-import ambiguous).
  const batchKeyClaims = new Map<string, Set<string>>()
  // Lazy per-parent index of existing children by normalized key-property value.
  const propIndexByParent = new Map<string, Map<string, ManifestNode[]>>()
  const findMatches = (parentId: string, keyValue: string): ManifestNode[] => {
    if (keyPropKey === null) {                  // name is the key
      const m = childByName(parentId, keyValue)
      return m ? [m] : []
    }
    let idx = propIndexByParent.get(parentId)
    if (!idx) {
      idx = new Map()
      for (const c of childrenByParent.get(parentId) ?? []) {
        const v = c.properties[keyPropKey]
        if (v === undefined || v === null) continue   // null/absent never matches
        const nk = norm(v)
        const arr = idx.get(nk)
        if (arr) arr.push(c)
        else idx.set(nk, [c])
      }
      propIndexByParent.set(parentId, idx)
    }
    return idx.get(norm(keyValue)) ?? []
  }

  type FieldMap = ReturnType<typeof templateFields>
  type PropMap = Record<string, string | number | boolean | null>

  // Apply the row's included cells onto `base` ({} for a create, the existing
  // node's props for an update), coercing against `flds` (the EFFECTIVE template).
  // Blank cell ⇒ leave untouched (no wipe). Invalid cell ⇒ push skip + return null.
  const buildProperties = (cells: string[], flds: FieldMap, fileRow: number, base: PropMap): PropMap | null => {
    const properties: PropMap = { ...base }
    for (const col of included) {
      const raw = (cells[headerIndex.get(col.header)!] ?? '').trim()
      if (raw === '') continue
      const field = flds[col.key]
      if (field) {
        const result = coercePropertyValue(raw, field)
        if (!result.valid) { out.skipped.push({ row: fileRow, column: col.header, reason: result.message ?? 'Invalid value' }); return null }
        properties[col.key] = result.value ?? null
      } else {
        const check = validatePropertyValue(raw)
        if (!check.valid) { out.skipped.push({ row: fileRow, column: col.header, reason: check.message ?? 'Invalid value' }); return null }
        properties[col.key] = raw
      }
    }
    return properties
  }

  const requiredWarnings = (properties: PropMap, flds: FieldMap, fileRow: number): void => {
    for (const [key, field] of Object.entries(flds)) {
      const v = properties[key]
      if (field.required && (v === undefined || v === null || v === '')) {
        out.warnings.push({ row: fileRow, column: key, reason: `required field "${key}" is not set` })
      }
    }
  }

  const sameProps = (a: PropMap, b: PropMap): boolean => {
    const ak = Object.keys(a)
    if (ak.length !== Object.keys(b).length) return false
    for (const k of ak) if (a[k] !== b[k]) return false
    return true
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
    // Deferred until the create actually commits, so a row that later skips
    // (collision / invalid cell) does not falsely reserve its key value.
    let commitKeyClaim: (() => void) | null = null

    // ── Update-on-key: a keyed row matching an existing child updates it ───────
    if (updateExisting) {
      const keyValue = keyPropKey === null ? name : (cells[keyIdx!] ?? '').trim()
      if (keyValue === '') {
        out.skipped.push({ row: fileRow, column: mapping.keyColumn, reason: 'missing key value' })
        return
      }
      const matches = findMatches(parentId, keyValue)
      if (matches.length > 1) {
        out.skipped.push({ row: fileRow, column: mapping.keyColumn, reason: `ambiguous: ${matches.length} existing nodes match key "${keyValue}"` })
        return
      }
      if (matches.length === 1) {
        const m = matches[0]
        if (updatedIds.has(m.id)) {
          out.skipped.push({ row: fileRow, column: mapping.keyColumn, reason: `key "${keyValue}" already updated by an earlier row` })
          return
        }
        // Coerce/validate row cells against the node's EFFECTIVE template (the
        // mapping's if it binds one, else the node's own) — not the mapping's alone.
        const effTemplateId = mapping.templateId != null ? mapping.templateId : (m.templateId ?? null)
        const effFields = templateFields(effTemplateId ? templates[effTemplateId] : undefined)

        const merged = buildProperties(cells, effFields, fileRow, { ...m.properties })
        if (merged === null) return

        // Rebinding to a different template ⇒ every carried-over property must be
        // valid under the new template. Coerce them (mirrors nodeUpdate: a freeform
        // "5" becomes number 5), writing the coerced value back; skip only if a
        // value genuinely can't satisfy the new field. Never commit an invalid node.
        const rebinding = mapping.templateId != null && mapping.templateId !== (m.templateId ?? null)
        if (rebinding) {
          let bad = false
          for (const [key, value] of Object.entries(merged)) {
            const field = effFields[key]
            if (!field || value === null) continue
            const result = coercePropertyValue(value, field)
            if (!result.valid) {
              out.skipped.push({ row: fileRow, column: key, reason: `existing value invalid under new template: ${result.message ?? key}` })
              bad = true
              break
            }
            merged[key] = result.value ?? null
          }
          if (bad) return
        }

        // Rename only on a property-key match whose row name differs (exact, so a
        // case-only change still applies). The collision check excludes m itself.
        const finalName = keyPropKey !== null && name !== m.name ? name : m.name
        if (finalName !== m.name) {
          const other = childByName(parentId, finalName)
          if ((other && other.id !== m.id) || batchChildren.has(childKey(parentId, finalName))) {
            out.skipped.push({ row: fileRow, column: mapping.nameColumn, reason: `cannot rename to "${finalName}" — name already exists under the target parent` })
            return
          }
        }

        // No-op: nothing actually changes ⇒ don't emit (avoids a false dirty state
        // — modified would bump but the snapshot diff would show nothing).
        if (finalName === m.name && !rebinding && sameProps(merged, m.properties)) {
          return
        }

        requiredWarnings(merged, effFields, fileRow)
        // Claim the final name → the real node id, so later rows resolve through
        // and collide with the renamed/matched node. Mark it so a later row
        // can't update the same node twice.
        claim(parentId, finalName, m.id)
        updatedIds.add(m.id)
        out.update.push({
          nodeId: m.id,
          name: finalName,
          ...(mapping.templateId != null ? { templateId: mapping.templateId } : {}),
          properties: merged,
        })
        return
      }
      // 0 matches → CREATE. In property-key mode, guard against two new rows
      // sharing the same key value (name-key creates are already deduped by name).
      if (keyPropKey !== null) {
        let claims = batchKeyClaims.get(parentId)
        if (!claims) { claims = new Set(); batchKeyClaims.set(parentId, claims) }
        const nk = norm(keyValue)
        if (claims.has(nk)) {
          out.skipped.push({ row: fileRow, column: mapping.keyColumn, reason: `duplicate key value "${keyValue}" in this import` })
          return
        }
        commitKeyClaim = () => claims!.add(nk)   // recorded only once the create commits
      }
    }

    if (taken(parentId, name)) {
      out.skipped.push({ row: fileRow, column: mapping.nameColumn, reason: `name "${name}" already exists under the target parent` })
      return
    }

    const properties = buildProperties(cells, fields, fileRow, {})
    if (properties === null) return
    requiredWarnings(properties, fields, fileRow)

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
    commitKeyClaim?.()
  })

  return out
}

// Re-exported for callers that want to validate a single value the same way the
// planner does (keeps the rule in one import surface).
export { validateTypedPropertyValue }
