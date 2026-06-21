// Pure NetBox-import planning. NetBox is a relational DCIM source exported as
// Django `dumpdata` JSON: a flat array of `{ model, pk, fields }` where relations
// are integer foreign keys (a device points at its site/rack/device_type by pk).
//
// This adapter resolves those relations into Manifest's hierarchy —
//   Site → Location → Rack → Device
// — with device/rack/site attributes as TYPED properties bound to auto-generated
// templates. Like the CSV planner (import.ts), it is the single source of truth
// used by BOTH the plan (preview) and apply paths, so the preview can never
// disagree with the result. No filesystem, no node creation: it returns the
// templates to add plus a flat list of PlannedNodes (parents before children,
// referenced by `localId`) that apply resolves to real uuids in order.

import type {
  ManifestNode,
  NodeTemplate,
  TemplateField,
  ImportIssue,
  NetboxInspect,
} from './types'
import type { PlannedNode } from './import'
import { coercePropertyValue, validateNodeName } from './validation'

// A single Django dumpdata record.
export interface NetboxObject {
  model: string
  pk: number
  fields: Record<string, unknown>
}

export class NetboxParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NetboxParseError'
  }
}

// Stable template ids the adapter creates and binds nodes to.
export const NETBOX_TEMPLATE_IDS = {
  site: 'netbox-site',
  location: 'netbox-location',
  rack: 'netbox-rack',
  device: 'netbox-device',
} as const

// NetBox's documented status/choice sets. Enum options are the UNION of these
// and the values actually present in the dump, so a value always validates
// (custom/extra statuses widen the enum instead of failing coercion) while the
// property still diffs as an enum.
const SITE_STATUS = ['planned', 'staging', 'active', 'decommissioning', 'retired']
// NetBox uses the same status choice set for sites and locations.
const LOCATION_STATUS = SITE_STATUS
const RACK_STATUS = ['reserved', 'available', 'planned', 'active', 'deprecated']
const DEVICE_STATUS = [
  'offline', 'active', 'planned', 'staged', 'failed', 'inventory', 'decommissioning',
]
const DEVICE_FACE = ['front', 'rear']
const RACK_TYPE = ['2-post-frame', '4-post-frame', '4-post-cabinet', 'wall-frame', 'wall-cabinet']

const MODELS = {
  site: 'dcim.site',
  location: 'dcim.location',
  rack: 'dcim.rack',
  device: 'dcim.device',
  deviceType: 'dcim.devicetype',
  manufacturer: 'dcim.manufacturer',
  deviceRole: 'dcim.devicerole',
  rackRole: 'dcim.rackrole',
  platform: 'dcim.platform',
} as const

/**
 * Parse + shape-validate a NetBox `dumpdata` JSON string. Throws NetboxParseError
 * on anything that isn't an array of `{ model, pk, fields }` records.
 */
export function parseNetboxDump(text: string): NetboxObject[] {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (e) {
    throw new NetboxParseError(`Not valid JSON: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (!Array.isArray(data)) {
    throw new NetboxParseError('Expected a NetBox dumpdata array (JSON array of objects).')
  }
  const out: NetboxObject[] = []
  for (const item of data) {
    if (
      item && typeof item === 'object' && !Array.isArray(item) &&
      typeof (item as Record<string, unknown>).model === 'string' &&
      typeof (item as Record<string, unknown>).pk === 'number' &&
      (item as Record<string, unknown>).fields != null &&
      typeof (item as Record<string, unknown>).fields === 'object'
    ) {
      out.push(item as NetboxObject)
    }
  }
  if (out.length === 0) {
    throw new NetboxParseError(
      'No NetBox records found. Expected Django dumpdata objects with model/pk/fields.',
    )
  }
  return out
}

function byModel(objects: NetboxObject[], model: string): NetboxObject[] {
  return objects.filter((o) => o.model === model)
}

/** First-look counts so the user can confirm what an import will land. */
export function inspectNetbox(objects: NetboxObject[]): NetboxInspect {
  return {
    format: 'netbox-dumpdata',
    totalObjects: objects.length,
    sites: byModel(objects, MODELS.site).length,
    locations: byModel(objects, MODELS.location).length,
    racks: byModel(objects, MODELS.rack).length,
    devices: byModel(objects, MODELS.device).length,
  }
}

export interface NetboxPlanOutput {
  templates: Record<string, NodeTemplate>
  create: PlannedNode[]
  skipped: ImportIssue[]
  warnings: ImportIssue[]
  counts: { sites: number; locations: number; racks: number; devices: number }
  // A whole-import error (not a per-record issue) — e.g. the base parent doesn't
  // exist, or a foreign template squats a netbox-* id. When set, nothing imports.
  mappingError?: string
}

const EMPTY_PLAN = (mappingError: string): NetboxPlanOutput => ({
  templates: {}, create: [], skipped: [], warnings: [],
  counts: { sites: 0, locations: 0, racks: 0, devices: 0 }, mappingError,
})

// Build an enum field whose options = union(standard, values present in dump),
// sorted, deduped. Falls back to the standard set when nothing is present.
function enumField(label: string, standard: string[], present: Set<string>): TemplateField {
  const options = Array.from(new Set([...standard, ...present])).filter((v) => v.length > 0).sort()
  return { type: 'enum', label, options: options.length > 0 ? options : standard }
}

// Two templates are coercion-compatible when they have the same field keys with
// the same types. Enum OPTIONS are intentionally ignored — they're data-derived
// and widen per import, so a re-import with a different status mix still matches.
function templateShapeMatches(a: NodeTemplate, b: NodeTemplate): boolean {
  const ak = Object.keys(a.fields).sort()
  const bk = Object.keys(b.fields).sort()
  if (ak.length !== bk.length || ak.some((k, i) => k !== bk[i])) return false
  return ak.every((k) => a.fields[k].type === b.fields[k].type)
}

// When reusing an existing (shape-compatible) template, widen its enum fields to
// include the current dump's values. Otherwise a re-import introducing a new
// status would coerce against stale options and drop the field with a warning —
// or worse, persist a value the existing template's enum rejects on load. Returns
// the widened template and whether any option set actually grew (so the caller
// only persists the update when needed). Assumes shapes already match.
function widenTemplateEnums(
  existing: NodeTemplate,
  wanted: NodeTemplate,
): { template: NodeTemplate; changed: boolean } {
  let changed = false
  const fields: Record<string, TemplateField> = {}
  for (const [k, ef] of Object.entries(existing.fields)) {
    const wf = wanted.fields[k]
    if (ef.type === 'enum' && wf?.type === 'enum') {
      const merged = Array.from(new Set([...(ef.options ?? []), ...(wf.options ?? [])])).sort()
      if (merged.length !== (ef.options?.length ?? 0)) changed = true
      fields[k] = { ...ef, options: merged }
    } else {
      fields[k] = ef
    }
  }
  return { template: { ...existing, fields }, changed }
}

function presentValues(objects: NetboxObject[], model: string, field: string): Set<string> {
  const out = new Set<string>()
  for (const o of byModel(objects, model)) {
    const v = o.fields[field]
    if (typeof v === 'string' && v.length > 0) out.add(v)
  }
  return out
}

function isEmpty(raw: unknown): boolean {
  return raw == null || (typeof raw === 'string' && raw.trim().length === 0)
}

/**
 * Plan a NetBox import: the templates to create and the node tree to add.
 * `existingTemplates`/`existingNodes` come from the open project so the planner
 * can avoid recreating templates and avoid colliding with existing children of
 * the base parent. Pure — no IO, no mutation.
 */
export function planNetbox(
  objects: NetboxObject[],
  baseParentId: string,
  existingTemplates: Record<string, NodeTemplate>,
  existingNodes: ManifestNode[],
): NetboxPlanOutput {
  const skipped: ImportIssue[] = []
  const warnings: ImportIssue[] = []

  // ── Base parent must exist (the IPC boundary is untrusted) ─────────────────
  // Without this, a stale/garbage baseParentId would create sites whose parentId
  // points at nothing — invisible orphan nodes. Mirrors the CSV planner's guard.
  if (!existingNodes.some((n) => n.id === baseParentId)) {
    return EMPTY_PLAN('Target parent not found')
  }

  // ── Templates (only those not already present in the project) ──────────────
  const templates: Record<string, NodeTemplate> = {}
  const siteTpl: NodeTemplate = {
    label: 'NetBox Site',
    fields: {
      status: enumField('Status', SITE_STATUS, presentValues(objects, MODELS.site, 'status')),
      facility: { type: 'string', label: 'Facility' },
      physical_address: { type: 'string', label: 'Physical address' },
      time_zone: { type: 'string', label: 'Time zone' },
      description: { type: 'string', label: 'Description' },
    },
  }
  const locationTpl: NodeTemplate = {
    label: 'NetBox Location',
    fields: {
      status: enumField('Status', LOCATION_STATUS, presentValues(objects, MODELS.location, 'status')),
      description: { type: 'string', label: 'Description' },
    },
  }
  const rackTpl: NodeTemplate = {
    label: 'NetBox Rack',
    fields: {
      status: enumField('Status', RACK_STATUS, presentValues(objects, MODELS.rack, 'status')),
      role: { type: 'string', label: 'Role' },
      type: enumField('Type', RACK_TYPE, presentValues(objects, MODELS.rack, 'type')),
      width: { type: 'number', label: 'Width (in)' },
      u_height: { type: 'number', label: 'Height (U)' },
      serial: { type: 'string', label: 'Serial' },
      asset_tag: { type: 'string', label: 'Asset tag' },
      facility_id: { type: 'string', label: 'Facility ID' },
      description: { type: 'string', label: 'Description' },
    },
  }
  const deviceTpl: NodeTemplate = {
    label: 'NetBox Device',
    fields: {
      status: enumField('Status', DEVICE_STATUS, presentValues(objects, MODELS.device, 'status')),
      manufacturer: { type: 'string', label: 'Manufacturer' },
      model: { type: 'string', label: 'Model' },
      role: { type: 'string', label: 'Role' },
      platform: { type: 'string', label: 'Platform' },
      serial: { type: 'string', label: 'Serial' },
      asset_tag: { type: 'string', label: 'Asset tag' },
      position: { type: 'number', label: 'Rack position (U)' },
      face: enumField('Face', DEVICE_FACE, presentValues(objects, MODELS.device, 'face')),
      part_number: { type: 'string', label: 'Part number' },
      description: { type: 'string', label: 'Description' },
    },
  }
  const wanted: Array<[string, NodeTemplate]> = [
    [NETBOX_TEMPLATE_IDS.site, siteTpl],
    [NETBOX_TEMPLATE_IDS.location, locationTpl],
    [NETBOX_TEMPLATE_IDS.rack, rackTpl],
    [NETBOX_TEMPLATE_IDS.device, deviceTpl],
  ]
  // Reuse an existing template of the same id (re-import), but ONLY if it's
  // coercion-compatible. A foreign template squatting a netbox-* id with a
  // different field shape would otherwise silently bind every imported node to
  // the wrong schema (dropping/mis-typing attributes with no error). Refuse
  // instead, so the user can rename their template. The effective template used
  // for coercion is existing (when compatible) else wanted.
  const effective: Record<string, NodeTemplate> = {}
  for (const [id, tpl] of wanted) {
    const existing = existingTemplates[id]
    if (existing) {
      if (!templateShapeMatches(existing, tpl)) {
        return EMPTY_PLAN(
          `A different template with id "${id}" already exists. Rename it before importing NetBox data.`,
        )
      }
      // Reuse the existing template, widened to cover this dump's enum values.
      const { template: widened, changed } = widenTemplateEnums(existing, tpl)
      effective[id] = widened
      if (changed) templates[id] = widened // persist the widening (apply merges it)
    } else {
      templates[id] = tpl
      effective[id] = tpl
    }
  }

  // ── Relation lookups ───────────────────────────────────────────────────────
  const map = (model: string) => new Map(byModel(objects, model).map((o) => [o.pk, o]))
  const sites = map(MODELS.site)
  const locations = map(MODELS.location)
  const racks = map(MODELS.rack)
  const devices = byModel(objects, MODELS.device)
  const deviceTypes = map(MODELS.deviceType)
  const manufacturers = map(MODELS.manufacturer)
  const deviceRoles = map(MODELS.deviceRole)
  const rackRoles = map(MODELS.rackRole)
  const platforms = map(MODELS.platform)

  const nameOf = (m: Map<number, NetboxObject>, pk: unknown): string | null => {
    if (typeof pk !== 'number') return null
    const o = m.get(pk)
    const n = o?.fields.name
    return typeof n === 'string' ? n : null
  }

  // ── Collision tracking ─────────────────────────────────────────────────────
  // Sibling names must be unique CASE-INSENSITIVELY (matching ProjectManager's
  // hasSiblingNameConflict), so the import can't persist a hierarchy the normal
  // API would reject. Buckets are keyed by lowercased name. Seed each real-parent
  // bucket from existing children; localId buckets start empty. `createdLocalIds`
  // lets a child verify its container got created (a skipped container skips its
  // subtree).
  const namesByParent = new Map<string, Set<string>>()
  for (const n of existingNodes) {
    if (n.parentId === null) continue
    let s = namesByParent.get(n.parentId)
    if (!s) namesByParent.set(n.parentId, (s = new Set()))
    s.add(n.name.toLowerCase())
  }
  const createdLocalIds = new Set<string>()
  const create: PlannedNode[] = []

  // Coerce raw NetBox fields into a typed property map against `tpl`. Empty/null
  // values are omitted; a value that fails coercion is dropped with a warning
  // (the node is still imported).
  const buildProps = (
    tpl: NodeTemplate,
    raw: Record<string, unknown>,
    issueRow: number,
    issueLabel: string,
  ): Record<string, string | number | boolean | null> => {
    const props: Record<string, string | number | boolean | null> = {}
    for (const [key, field] of Object.entries(tpl.fields)) {
      const value = raw[key]
      if (isEmpty(value)) continue
      const coerced = coercePropertyValue(value, field)
      if (coerced.valid && coerced.value !== undefined) {
        props[key] = coerced.value
      } else if (!coerced.valid) {
        warnings.push({
          row: issueRow,
          column: key,
          reason: `${issueLabel}: dropped field "${key}" — ${coerced.message ?? 'invalid value'}`,
        })
      }
    }
    return props
  }

  // Attempt to add a planned node under `parentKey` (a real id or a localId).
  // Returns true on success, false if skipped (collision / missing parent /
  // invalid name) — the caller uses false to skip dependent subtrees. Containers
  // pass a `localId` so children can reference them; leaf devices omit it.
  const addNode = (args: {
    localId?: string
    parentKey: string
    parentIsLocal: boolean
    name: string
    templateId: string
    props: Record<string, string | number | boolean | null>
    issueRow: number
    issueLabel: string
  }): boolean => {
    const { localId, parentKey, parentIsLocal, name, templateId, props, issueRow, issueLabel } = args
    if (parentIsLocal && !createdLocalIds.has(parentKey)) {
      skipped.push({ row: issueRow, reason: `${issueLabel}: parent was not imported` })
      return false
    }
    const nameCheck = validateNodeName(name)
    if (!nameCheck.valid) {
      skipped.push({ row: issueRow, reason: `${issueLabel}: ${nameCheck.message ?? 'invalid name'}` })
      return false
    }
    let siblings = namesByParent.get(parentKey)
    if (!siblings) namesByParent.set(parentKey, (siblings = new Set()))
    const nameKey = name.toLowerCase()
    if (siblings.has(nameKey)) {
      skipped.push({ row: issueRow, reason: `${issueLabel}: duplicate sibling name "${name}"` })
      return false
    }
    siblings.add(nameKey)
    create.push({ parentId: parentKey, name, properties: props, ...(localId ? { localId } : {}), templateId })
    if (localId) createdLocalIds.add(localId)
    return true
  }

  const counts = { sites: 0, locations: 0, racks: 0, devices: 0 }

  // ── Sites (under the base parent) ──────────────────────────────────────────
  for (const site of [...sites.values()].sort((a, b) => a.pk - b.pk)) {
    const name = typeof site.fields.name === 'string' ? site.fields.name : ''
    const added = addNode({
      localId: `site:${site.pk}`,
      parentKey: baseParentId,
      parentIsLocal: false,
      name,
      templateId: NETBOX_TEMPLATE_IDS.site,
      props: buildProps(effective[NETBOX_TEMPLATE_IDS.site], {
        status: site.fields.status,
        facility: site.fields.facility,
        physical_address: site.fields.physical_address,
        time_zone: site.fields.time_zone,
        description: site.fields.description,
      }, site.pk, `site "${name}"`),
      issueRow: site.pk,
      issueLabel: `site "${name}"`,
    })
    if (added) counts.sites++
  }

  // ── Locations (dependency order, parent-before-child) ──────────────────────
  // Don't trust NetBox's MPTT `level` field (trimmed/hand-built exports may omit
  // it): place any location whose parent-location is already placed, repeating
  // until no progress. Remaining ones (orphans / parent cycles) are then attempted
  // once so they record a proper "parent was not imported" skip.
  const pendingLocs = [...locations.values()].sort((a, b) => a.pk - b.pk)
  const tryAddLocation = (loc: NetboxObject) => {
    const name = typeof loc.fields.name === 'string' ? loc.fields.name : ''
    const parentLoc = loc.fields.parent
    const parentKey = typeof parentLoc === 'number' ? `loc:${parentLoc}` : `site:${loc.fields.site}`
    const added = addNode({
      localId: `loc:${loc.pk}`,
      parentKey,
      parentIsLocal: true,
      name,
      templateId: NETBOX_TEMPLATE_IDS.location,
      props: buildProps(effective[NETBOX_TEMPLATE_IDS.location], {
        status: loc.fields.status,
        description: loc.fields.description,
      }, loc.pk, `location "${name}"`),
      issueRow: loc.pk,
      issueLabel: `location "${name}"`,
    })
    if (added) counts.locations++
  }
  const placedLoc = new Set<number>()
  let progress = true
  while (progress) {
    progress = false
    for (const loc of pendingLocs) {
      if (placedLoc.has(loc.pk)) continue
      const parentLoc = loc.fields.parent
      // Defer only while the parent is an in-dump location not yet placed.
      if (typeof parentLoc === 'number' && locations.has(parentLoc) && !createdLocalIds.has(`loc:${parentLoc}`)) {
        continue
      }
      tryAddLocation(loc)
      placedLoc.add(loc.pk)
      progress = true
    }
  }
  // Leftovers form a parent cycle — attempt each so it records a skip (won't loop).
  for (const loc of pendingLocs) {
    if (!placedLoc.has(loc.pk)) tryAddLocation(loc)
  }

  // ── Racks (under their location, else their site) ──────────────────────────
  for (const rack of [...racks.values()].sort((a, b) => a.pk - b.pk)) {
    const name = typeof rack.fields.name === 'string' ? rack.fields.name : ''
    const loc = rack.fields.location
    const parentKey = typeof loc === 'number' ? `loc:${loc}` : `site:${rack.fields.site}`
    const added = addNode({
      localId: `rack:${rack.pk}`,
      parentKey,
      parentIsLocal: true,
      name,
      templateId: NETBOX_TEMPLATE_IDS.rack,
      props: buildProps(effective[NETBOX_TEMPLATE_IDS.rack], {
        status: rack.fields.status,
        role: nameOf(rackRoles, rack.fields.role),
        type: rack.fields.type,
        width: rack.fields.width,
        u_height: rack.fields.u_height,
        serial: rack.fields.serial,
        asset_tag: rack.fields.asset_tag,
        facility_id: rack.fields.facility_id,
        description: rack.fields.description,
      }, rack.pk, `rack "${name}"`),
      issueRow: rack.pk,
      issueLabel: `rack "${name}"`,
    })
    if (added) counts.racks++
  }

  // ── Devices (under their rack, else location, else site) ───────────────────
  for (const device of [...devices].sort((a, b) => a.pk - b.pk)) {
    const name = typeof device.fields.name === 'string' ? device.fields.name : ''
    const rack = device.fields.rack
    const loc = device.fields.location
    // All three parent options (rack/location/site) are localIds created above,
    // so the parent is always local.
    const parentIsLocal = true
    let parentKey: string
    if (typeof rack === 'number') parentKey = `rack:${rack}`
    else if (typeof loc === 'number') parentKey = `loc:${loc}`
    else parentKey = `site:${device.fields.site}`

    const dt = typeof device.fields.device_type === 'number' ? deviceTypes.get(device.fields.device_type) : undefined
    // Devices are leaves — route through addNode with no localId.
    const added = addNode({
      parentKey,
      parentIsLocal,
      name,
      templateId: NETBOX_TEMPLATE_IDS.device,
      props: buildProps(effective[NETBOX_TEMPLATE_IDS.device], {
        status: device.fields.status,
        manufacturer: dt ? nameOf(manufacturers, dt.fields.manufacturer) : null,
        model: dt?.fields.model ?? null,
        role: nameOf(deviceRoles, device.fields.role),
        platform: nameOf(platforms, device.fields.platform),
        serial: device.fields.serial,
        asset_tag: device.fields.asset_tag,
        position: device.fields.position,
        face: device.fields.face,
        part_number: dt?.fields.part_number ?? null,
        description: device.fields.description,
      }, device.pk, `device "${name}"`),
      issueRow: device.pk,
      issueLabel: `device "${name}"`,
    })
    if (added) counts.devices++
  }

  return { templates, create, skipped, warnings, counts }
}
