import { describe, it, expect } from 'vitest'
import {
  parseNetboxDump,
  inspectNetbox,
  planNetbox,
  NetboxParseError,
  NETBOX_TEMPLATE_IDS,
  type NetboxObject,
} from '../../../src/shared/netbox'
import type { ManifestNode } from '../../../src/shared/types'

// ── Fixture ──────────────────────────────────────────────────────────────────
// A small but adversarial NetBox dumpdata sample exercising: FK resolution
// (device_type→manufacturer, role, platform), nested placement (location, then
// rackless/locationless fallbacks), typed coercion (position number, status
// enum), omitted empties (blank serial, null platform), enum widening (a custom
// status value not in NetBox's standard set), a missing device_type FK, and a
// duplicate-sibling collision.
function fixture(): NetboxObject[] {
  return [
    { model: 'dcim.manufacturer', pk: 1, fields: { name: 'Cisco', slug: 'cisco' } },
    { model: 'dcim.manufacturer', pk: 2, fields: { name: 'Juniper', slug: 'juniper' } },
    { model: 'dcim.devicetype', pk: 10, fields: { manufacturer: 1, model: 'C9300', slug: 'c9300', part_number: 'WS-C9300', u_height: '1.0' } },
    { model: 'dcim.devicetype', pk: 11, fields: { manufacturer: 2, model: 'MX480', slug: 'mx480', part_number: '' } },
    { model: 'dcim.devicerole', pk: 20, fields: { name: 'Switch', slug: 'switch' } },
    { model: 'dcim.devicerole', pk: 21, fields: { name: 'Router', slug: 'router' } },
    { model: 'dcim.rackrole', pk: 30, fields: { name: 'Compute', slug: 'compute' } },
    { model: 'dcim.platform', pk: 40, fields: { name: 'IOS-XE', slug: 'ios-xe' } },

    { model: 'dcim.site', pk: 100, fields: { name: 'Site Alpha', status: 'active', facility: 'Bldg 1', time_zone: 'UTC', description: '', physical_address: '' } },
    { model: 'dcim.site', pk: 101, fields: { name: 'Site Beta', status: 'staging', facility: '', time_zone: '', description: '', physical_address: '' } },

    // Location under Site Alpha
    { model: 'dcim.location', pk: 200, fields: { name: 'Room 1', site: 100, parent: null, level: 0, status: 'active', description: '' } },

    // Rack under the location; rack under Site Beta directly (no location)
    { model: 'dcim.rack', pk: 300, fields: { name: 'Rack A', site: 100, location: 200, role: 30, status: 'active', type: '4-post-cabinet', width: 19, u_height: '42.0', serial: 'RK-1', asset_tag: null, facility_id: '', description: '' } },
    { model: 'dcim.rack', pk: 301, fields: { name: 'Rack B', site: 101, location: null, role: null, status: 'available', type: '2-post-frame', width: 19, u_height: '45.0', serial: '', asset_tag: null, facility_id: '', description: '' } },

    // dev1: full attrs under Rack A. dev2 under Rack B. dev3 rackless under Room 1.
    // dev4 rackless+locationless → falls back to its Site. dev5: duplicate name in
    // Rack A (collision → skipped). dev6: custom status (enum widening). dev7:
    // missing device_type FK (model/manufacturer omitted).
    { model: 'dcim.device', pk: 400, fields: { name: 'sw-01', site: 100, location: 200, rack: 300, position: '4.0', face: 'front', status: 'active', serial: 'SN-1', asset_tag: 'AT-1', device_type: 10, role: 20, platform: 40, description: 'core switch' } },
    { model: 'dcim.device', pk: 401, fields: { name: 'rtr-01', site: 101, location: null, rack: 301, position: '1.0', face: 'front', status: 'active', serial: '', asset_tag: null, device_type: 11, role: 21, platform: null, description: '' } },
    { model: 'dcim.device', pk: 402, fields: { name: 'probe-01', site: 100, location: 200, rack: null, position: null, face: '', status: 'active', serial: '', asset_tag: null, device_type: 10, role: 20, platform: null, description: '' } },
    { model: 'dcim.device', pk: 403, fields: { name: 'orphan-01', site: 101, location: null, rack: null, position: null, face: '', status: 'offline', serial: '', asset_tag: null, device_type: null, role: 21, platform: null, description: '' } },
    { model: 'dcim.device', pk: 404, fields: { name: 'sw-01', site: 100, location: 200, rack: 300, position: '5.0', face: 'front', status: 'active', serial: 'SN-DUP', asset_tag: null, device_type: 10, role: 20, platform: null, description: '' } },
    { model: 'dcim.device', pk: 405, fields: { name: 'sw-02', site: 100, location: 200, rack: 300, position: '6.0', face: 'rear', status: 'burn-in', serial: 'SN-2', asset_tag: null, device_type: 10, role: 20, platform: null, description: '' } },
    { model: 'dcim.device', pk: 406, fields: { name: 'unknown-type', site: 101, location: null, rack: 301, position: '2.0', face: 'front', status: 'active', serial: '', asset_tag: null, device_type: 999, role: 21, platform: null, description: '' } },
  ]
}

const baseRoot: ManifestNode = {
  id: 'base-1', parentId: null, name: 'Imported', order: 0,
  properties: {}, created: '2026-01-01T00:00:00Z', modified: '2026-01-01T00:00:00Z',
}

// Index plan.create by a stable key for assertions (localId for containers, or
// parent+name for leaf devices).
function findNode(create: ReturnType<typeof planNetbox>['create'], name: string) {
  return create.find((n) => n.name === name)
}

describe('parseNetboxDump', () => {
  it('parses a dumpdata array, keeping well-formed records', () => {
    const out = parseNetboxDump(JSON.stringify(fixture()))
    expect(out.length).toBe(fixture().length)
    expect(out[0]).toMatchObject({ model: 'dcim.manufacturer', pk: 1 })
  })

  it('drops malformed records but keeps valid ones', () => {
    const raw = JSON.stringify([
      { model: 'dcim.site', pk: 1, fields: { name: 'X' } },
      { model: 'dcim.site', pk: 'bad', fields: {} }, // pk not a number
      { nope: true },
      { model: 'dcim.site', pk: 2 }, // no fields
      { model: 'dcim.site', pk: 3, fields: [] }, // fields is an array, not an object
    ])
    const out = parseNetboxDump(raw)
    expect(out.map((o) => o.pk)).toEqual([1])
  })

  it('throws on non-JSON', () => {
    expect(() => parseNetboxDump('{not json')).toThrow(NetboxParseError)
  })

  it('throws when the top level is not an array', () => {
    expect(() => parseNetboxDump('{"model":"x"}')).toThrow(/dumpdata array/)
  })

  it('throws when no NetBox records are present', () => {
    expect(() => parseNetboxDump('[{"foo":1}]')).toThrow(/No NetBox records/)
  })
})

describe('inspectNetbox', () => {
  it('counts the core DCIM models', () => {
    const i = inspectNetbox(fixture())
    expect(i).toMatchObject({ format: 'netbox-dumpdata', sites: 2, locations: 1, racks: 2, devices: 7 })
    expect(i.totalObjects).toBe(fixture().length)
  })
})

describe('planNetbox', () => {
  const plan = () => planNetbox(fixture(), 'base-1', {}, [baseRoot])

  it('creates the four typed templates with enum options widened by present values', () => {
    const { templates } = plan()
    expect(Object.keys(templates).sort()).toEqual(
      [NETBOX_TEMPLATE_IDS.device, NETBOX_TEMPLATE_IDS.location, NETBOX_TEMPLATE_IDS.rack, NETBOX_TEMPLATE_IDS.site].sort(),
    )
    // 'burn-in' is a custom status not in NetBox's standard device set; the enum
    // must widen to include it so the value validates.
    const deviceStatus = templates[NETBOX_TEMPLATE_IDS.device].fields.status
    expect(deviceStatus.type).toBe('enum')
    expect(deviceStatus.options).toContain('burn-in')
    expect(deviceStatus.options).toContain('active')
  })

  it('builds the Site → Location → Rack → Device hierarchy via localIds', () => {
    const { create } = plan()
    const siteA = findNode(create, 'Site Alpha')!
    const room = findNode(create, 'Room 1')!
    const rackA = findNode(create, 'Rack A')!
    const sw01 = create.find((n) => n.name === 'sw-01' && n.parentId === rackA.localId)!
    expect(siteA.parentId).toBe('base-1')
    expect(room.parentId).toBe(siteA.localId)
    expect(rackA.parentId).toBe(room.localId)
    expect(sw01.parentId).toBe(rackA.localId)
    // Parents always precede children in create-order (apply resolves in order).
    expect(create.indexOf(siteA)).toBeLessThan(create.indexOf(room))
    expect(create.indexOf(room)).toBeLessThan(create.indexOf(rackA))
    expect(create.indexOf(rackA)).toBeLessThan(create.indexOf(sw01))
  })

  it('falls back: locationless rack → site, rackless device → location, rack+locationless device → site', () => {
    const { create } = plan()
    const siteBeta = findNode(create, 'Site Beta')!
    const rackB = findNode(create, 'Rack B')!
    const room = findNode(create, 'Room 1')!
    expect(rackB.parentId).toBe(siteBeta.localId)              // locationless rack → site
    expect(findNode(create, 'probe-01')!.parentId).toBe(room.localId) // rackless → location
    expect(findNode(create, 'orphan-01')!.parentId).toBe(siteBeta.localId) // rack+locationless → site
  })

  it('resolves FK lookups and coerces typed device attributes', () => {
    const { create } = plan()
    const sw01 = create.find((n) => n.name === 'sw-01' && n.properties.serial === 'SN-1')!
    expect(sw01.properties).toMatchObject({
      status: 'active',
      manufacturer: 'Cisco',      // device_type 10 → manufacturer 1
      model: 'C9300',
      role: 'Switch',             // device role 20
      platform: 'IOS-XE',         // platform 40
      serial: 'SN-1',
      asset_tag: 'AT-1',
      position: 4,                // "4.0" coerced to number
      face: 'front',
      part_number: 'WS-C9300',
      description: 'core switch',
    })
    expect(sw01.templateId).toBe(NETBOX_TEMPLATE_IDS.device)
  })

  it('omits empty/null fields instead of storing blanks', () => {
    const { create } = plan()
    const rtr = findNode(create, 'rtr-01')!
    expect('serial' in rtr.properties).toBe(false)   // serial was ""
    expect('platform' in rtr.properties).toBe(false) // platform was null
    expect('asset_tag' in rtr.properties).toBe(false)
    expect(rtr.properties.model).toBe('MX480')
    // device_type 11 has part_number "" → omitted
    expect('part_number' in rtr.properties).toBe(false)
  })

  it('resolves rack typed attributes (role via rackrole, numeric u_height/width, enum type)', () => {
    const { create } = plan()
    const rackA = findNode(create, 'Rack A')!
    expect(rackA.properties).toMatchObject({
      status: 'active', role: 'Compute', type: '4-post-cabinet', width: 19, u_height: 42, serial: 'RK-1',
    })
  })

  it('omits model/manufacturer when the device_type FK is unresolved', () => {
    const { create } = plan()
    const dev = findNode(create, 'unknown-type')!
    expect('model' in dev.properties).toBe(false)
    expect('manufacturer' in dev.properties).toBe(false)
    expect(dev.properties.status).toBe('active') // node still imported
  })

  it('skips a duplicate-sibling device with an issue (no duplicate names)', () => {
    const { create, skipped } = plan()
    const swInRackA = create.filter((n) => n.name === 'sw-01')
    expect(swInRackA.length).toBe(1) // the second sw-01 under Rack A was skipped
    expect(skipped.some((s) => /duplicate sibling name "sw-01"/.test(s.reason))).toBe(true)
  })

  it('reports accurate per-type counts', () => {
    const { counts } = plan()
    // 7 devices in fixture; 1 skipped as duplicate → 6 created.
    expect(counts).toEqual({ sites: 2, locations: 1, racks: 2, devices: 6 })
  })

  it('reuses a shape-compatible existing template on re-import instead of recreating it', () => {
    // Feed a FIRST plan's generated templates back as existing → the second plan
    // must reuse them (shapes match exactly) and emit none.
    const first = planNetbox(fixture(), 'base-1', {}, [baseRoot])
    const { templates, create } = planNetbox(fixture(), 'base-1', first.templates, [baseRoot])
    expect(Object.keys(templates).length).toBe(0) // nothing re-emitted
    const sw01 = create.find((n) => n.name === 'sw-01')!
    expect(sw01.templateId).toBe(NETBOX_TEMPLATE_IDS.device) // still bound
  })

  it('refuses when a different template squats a netbox-* id (no silent mis-coercion)', () => {
    const existing = {
      [NETBOX_TEMPLATE_IDS.device]: { label: 'Mine', fields: { foo: { type: 'string' as const } } },
    }
    const out = planNetbox(fixture(), 'base-1', existing, [baseRoot])
    expect(out.mappingError).toMatch(/netbox-device/)
    expect(out.create.length).toBe(0)        // nothing imports on conflict
    expect(Object.keys(out.templates).length).toBe(0)
  })

  it('refuses when the base parent does not exist (untrusted IPC guard)', () => {
    const out = planNetbox(fixture(), 'no-such-parent', {}, [baseRoot])
    expect(out.mappingError).toBe('Target parent not found')
    expect(out.create.length).toBe(0)
  })

  it('treats sibling names case-insensitively (matches ProjectManager)', () => {
    const existingChild: ManifestNode = {
      id: 'x', parentId: 'base-1', name: 'site alpha', order: 0,
      properties: {}, created: '2026-01-01T00:00:00Z', modified: '2026-01-01T00:00:00Z',
    }
    const dump: NetboxObject[] = [{ model: 'dcim.site', pk: 1, fields: { name: 'Site Alpha', status: 'active' } }]
    const { create, skipped } = planNetbox(dump, 'base-1', {}, [baseRoot, existingChild])
    expect(create.find((n) => n.name === 'Site Alpha')).toBeUndefined()
    expect(skipped.some((s) => /duplicate sibling/.test(s.reason))).toBe(true)
  })

  it('widens a reused template enum so a new status value is not dropped on re-import', () => {
    const first = planNetbox(
      [{ model: 'dcim.site', pk: 1, fields: { name: 'S', status: 'active' } }], 'base-1', {}, [baseRoot],
    )
    // Second import introduces a custom status not in the first import's enum.
    const second = planNetbox(
      [{ model: 'dcim.site', pk: 2, fields: { name: 'S2', status: 'mothballed' } }],
      'base-1', first.templates, [baseRoot],
    )
    const site = second.create.find((n) => n.name === 'S2')!
    expect(site.properties.status).toBe('mothballed') // not dropped
    const widened = second.templates[NETBOX_TEMPLATE_IDS.site]
    expect(widened?.fields.status.options).toContain('mothballed') // persisted widening
  })

  it('places nested locations by dependency even when NetBox level is absent', () => {
    // No `level` field; child has a LOWER pk than its parent (worst case for a
    // pk-only sort) — the dependency fixpoint must still place parent first.
    const dump: NetboxObject[] = [
      { model: 'dcim.site', pk: 1, fields: { name: 'S', status: 'active' } },
      { model: 'dcim.location', pk: 5, fields: { name: 'Child', site: 1, parent: 9, status: 'active' } },
      { model: 'dcim.location', pk: 9, fields: { name: 'Parent', site: 1, parent: null, status: 'active' } },
    ]
    const { create } = planNetbox(dump, 'base-1', {}, [baseRoot])
    const parent = create.find((n) => n.name === 'Parent')!
    const child = create.find((n) => n.name === 'Child')!
    expect(child.parentId).toBe(parent.localId)
    expect(create.indexOf(parent)).toBeLessThan(create.indexOf(child))
  })

  it('keeps a node but emits a warning when a typed field cannot coerce', () => {
    const dump: NetboxObject[] = [
      { model: 'dcim.site', pk: 1, fields: { name: 'S', status: 'active' } },
      { model: 'dcim.rack', pk: 2, fields: { name: 'R', site: 1, status: 'active', width: 19, u_height: 'not-a-number' } },
    ]
    const { create, warnings } = planNetbox(dump, 'base-1', {}, [baseRoot])
    const rack = create.find((n) => n.name === 'R')!
    expect('u_height' in rack.properties).toBe(false) // failed coercion → dropped
    expect(rack.properties.status).toBe('active')      // node still imported
    expect(warnings.some((w) => /u_height/.test(w.reason))).toBe(true)
  })

  it('orders nested locations parent-before-child even when dump order is reversed', () => {
    const dump: NetboxObject[] = [
      { model: 'dcim.site', pk: 1, fields: { name: 'S', status: 'active' } },
      { model: 'dcim.location', pk: 11, fields: { name: 'Child Room', site: 1, parent: 10, level: 1, status: 'active' } },
      { model: 'dcim.location', pk: 10, fields: { name: 'Parent Room', site: 1, parent: null, level: 0, status: 'active' } },
    ]
    const { create } = planNetbox(dump, 'base-1', {}, [baseRoot])
    const parent = create.find((n) => n.name === 'Parent Room')!
    const child = create.find((n) => n.name === 'Child Room')!
    expect(child.parentId).toBe(parent.localId)
    expect(create.indexOf(parent)).toBeLessThan(create.indexOf(child))
  })

  it('skips a container with an invalid (empty) name and cascades to its subtree', () => {
    const dump: NetboxObject[] = [
      { model: 'dcim.site', pk: 1, fields: { name: '', status: 'active' } },
      { model: 'dcim.rack', pk: 2, fields: { name: 'R', site: 1, status: 'active', width: 19, u_height: '42.0' } },
    ]
    const { create, skipped } = planNetbox(dump, 'base-1', {}, [baseRoot])
    expect(create.length).toBe(0)
    expect(skipped.some((s) => /invalid|name/i.test(s.reason))).toBe(true)
    expect(skipped.some((s) => /parent was not imported/.test(s.reason))).toBe(true)
  })

  it('skips a rack/device whose site FK does not resolve', () => {
    const dump: NetboxObject[] = [
      { model: 'dcim.rack', pk: 2, fields: { name: 'R', site: 999, status: 'active', width: 19, u_height: '42.0' } },
      { model: 'dcim.device', pk: 3, fields: { name: 'D', site: 999, rack: null, location: null, status: 'active' } },
    ]
    const { create, skipped } = planNetbox(dump, 'base-1', {}, [baseRoot])
    expect(create.length).toBe(0)
    expect(skipped.length).toBeGreaterThanOrEqual(2)
  })

  it('skips a device whose rack was itself skipped as a duplicate sibling', () => {
    const dump: NetboxObject[] = [
      { model: 'dcim.site', pk: 1, fields: { name: 'S', status: 'active' } },
      { model: 'dcim.rack', pk: 2, fields: { name: 'Rack A', site: 1, status: 'active', width: 19, u_height: '42.0' } },
      { model: 'dcim.rack', pk: 3, fields: { name: 'Rack A', site: 1, status: 'active', width: 19, u_height: '42.0' } },
      { model: 'dcim.device', pk: 4, fields: { name: 'D', site: 1, rack: 3, location: null, status: 'active' } },
    ]
    const { create, skipped } = planNetbox(dump, 'base-1', {}, [baseRoot])
    expect(create.filter((n) => n.name === 'Rack A').length).toBe(1) // pk3 skipped as dup
    expect(create.find((n) => n.name === 'D')).toBeUndefined()       // device under skipped rack
    expect(skipped.some((s) => /device "D".*parent was not imported/.test(s.reason))).toBe(true)
  })

  it('skips locations forming a parent cycle without hanging', () => {
    const dump: NetboxObject[] = [
      { model: 'dcim.site', pk: 1, fields: { name: 'S', status: 'active' } },
      { model: 'dcim.location', pk: 10, fields: { name: 'A', site: 1, parent: 11, level: 1, status: 'active' } },
      { model: 'dcim.location', pk: 11, fields: { name: 'B', site: 1, parent: 10, level: 1, status: 'active' } },
    ]
    const { create, skipped } = planNetbox(dump, 'base-1', {}, [baseRoot])
    // Neither location's parent can ever be created first → both skipped, no loop.
    expect(create.filter((n) => n.name === 'A' || n.name === 'B').length).toBe(0)
    expect(skipped.filter((s) => /parent was not imported/.test(s.reason)).length).toBeGreaterThanOrEqual(2)
  })

  it('omits a lookup-resolved field when its FK is unresolved', () => {
    const dump: NetboxObject[] = [
      { model: 'dcim.site', pk: 1, fields: { name: 'S', status: 'active' } },
      { model: 'dcim.rack', pk: 2, fields: { name: 'R', site: 1, role: 888, status: 'active', width: 19, u_height: '42.0' } },
    ]
    const { create } = planNetbox(dump, 'base-1', {}, [baseRoot])
    const rack = create.find((n) => n.name === 'R')!
    expect('role' in rack.properties).toBe(false) // rackrole 888 missing → null → omitted
  })

  it('skips a site that collides with an existing child of the base parent', () => {
    const existingChild: ManifestNode = {
      id: 'x', parentId: 'base-1', name: 'Site Alpha', order: 0,
      properties: {}, created: '2026-01-01T00:00:00Z', modified: '2026-01-01T00:00:00Z',
    }
    const { create, skipped } = planNetbox(fixture(), 'base-1', {}, [baseRoot, existingChild])
    expect(findNode(create, 'Site Alpha')).toBeUndefined()
    expect(skipped.some((s) => /Site Alpha.*duplicate sibling/.test(s.reason))).toBe(true)
    // Everything under the skipped site is also skipped (parent not imported).
    expect(findNode(create, 'Room 1')).toBeUndefined()
    expect(skipped.some((s) => /Room 1.*parent was not imported/.test(s.reason))).toBe(true)
  })
})
