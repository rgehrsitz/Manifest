// Unit tests for CSV import in ProjectManager. Real filesystem temp dirs.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { ProjectManager } from '../../../src/main/project-manager'
import type { ImportMapping } from '../../../src/shared/types'

const noopLogger = { error() {}, warn() {}, info() {}, debug() {} }
const noopGit = {
  checkVersion: async () => ({ available: true, version: '2.50.0', meetsMinimum: true, minimumVersion: '2.25' }),
  initRepo: async () => {},
  initialCommit: async () => {},
  run: async () => ({ stdout: '', stderr: '' }),
}

let tmpDir: string
let manager: ProjectManager

const TS = '2026-01-01T00:00:00.000Z'

function manifest() {
  return {
    version: 3,
    id: 'imp-id',
    name: 'Lab',
    created: TS,
    modified: TS,
    templates: {
      board: {
        label: 'Board',
        fields: {
          serial: { type: 'string' },
          count: { type: 'number' },
          sku: { type: 'string', required: true },
        },
      },
    },
    nodes: [
      { id: 'root-id', parentId: null, name: 'Lab', order: 0, properties: {}, created: TS, modified: TS },
      { id: 'rack-id', parentId: 'root-id', name: 'Rack A-01', order: 0, properties: {}, created: TS, modified: TS },
    ],
  }
}

async function open(): Promise<void> {
  writeFileSync(join(tmpDir, 'manifest.json'), JSON.stringify(manifest(), null, 2), 'utf8')
  manager = new ProjectManager(noopGit as any, noopLogger as any)
  const r = await manager.openProject(tmpDir)
  expect(r.ok).toBe(true)
}

function writeCsv(name: string, content: string): string {
  const p = join(tmpDir, name)
  writeFileSync(p, content, 'utf8')
  return p
}

function flatMapping(over: Partial<ImportMapping> = {}): ImportMapping {
  return { placement: 'flat', baseParentId: 'rack-id', nameColumn: 'name', columns: [], ...over }
}

beforeEach(() => {
  tmpDir = join(tmpdir(), `manifest-import-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(tmpDir, { recursive: true })
})

afterEach(async () => {
  manager?.cancelAutosave()
  await manager?.flushAndClose()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('inspectImport', () => {
  it('returns headers, a sample, and the row count', async () => {
    await open()
    const path = writeCsv('x.csv', 'name,serial\nA,1\nB,2\nC,3\n')
    const r = manager.inspectImport(path)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.headers).toEqual(['name', 'serial'])
    expect(r.data.rowCount).toBe(3)
    expect(r.data.sampleRows[0]).toEqual(['A', '1'])
  })

  it('reports a malformed CSV as a validation error', async () => {
    await open()
    const path = writeCsv('bad.csv', 'name\n"oops')
    const r = manager.inspectImport(path)
    expect(r.ok).toBe(false)
  })
})

describe('applyImportCsv — flat', () => {
  it('imports valid rows, skips invalid, warns on missing required, and commits once', async () => {
    await open()
    const path = writeCsv('boards.csv', 'name,serial,count\nB1,SN1,5\nB2,SN2,abc\nB3,SN3,\n')
    const r = manager.applyImportCsv(path, flatMapping({
      templateId: 'board',
      columns: [
        { header: 'serial', key: 'serial', include: true },
        { header: 'count', key: 'count', include: true },
      ],
    }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.summary.created).toBe(2)             // B1, B3
    expect(r.data.summary.skipped).toHaveLength(1)     // B2 invalid count
    expect(r.data.summary.skipped[0].column).toBe('count')
    expect(r.data.summary.warnings.length).toBe(2)     // both missing required sku

    const b1 = r.data.project.nodes.find(n => n.name === 'B1')!
    expect(b1.parentId).toBe('rack-id')
    expect(b1.templateId).toBe('board')
    expect(b1.properties).toEqual({ serial: 'SN1', count: 5 })  // coerced number

    // rack-id had no children, so the two imported siblings get sequential order.
    const b3 = r.data.project.nodes.find(n => n.name === 'B3')!
    expect(b1.order).toBe(0)
    expect(b3.order).toBe(1)

    // Search index was rebuilt as part of the single commit.
    const search = await manager.searchNodes('SN3')
    expect(search.ok && search.data.length).toBeGreaterThan(0)
  })

  it('seeds order past existing siblings under a populated parent', async () => {
    await open()
    // root-id already has "Rack A-01" at order 0; imports must not collide at 0.
    const path = writeCsv('seed.csv', 'name\nRack B-01\nRack C-01\n')
    const r = manager.applyImportCsv(path, flatMapping({ baseParentId: 'root-id' }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const b = r.data.project.nodes.find(n => n.name === 'Rack B-01')!
    const c = r.data.project.nodes.find(n => n.name === 'Rack C-01')!
    expect(b.order).toBe(1)   // seeded past the existing Rack A-01 (order 0)
    expect(c.order).toBe(2)
  })

  it('skips a row that collides with an existing sibling', async () => {
    await open()
    const path = writeCsv('c.csv', 'name\nRack A-01\n') // already exists under root? no — under rack-id there is none; collide test under root
    const r = manager.applyImportCsv(path, flatMapping({ baseParentId: 'root-id' }))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.summary.skipped[0].reason).toMatch(/already exists/)
  })
})

describe('applyImportCsv — path placement', () => {
  it('places rows under the node resolved from the breadcrumb', async () => {
    await open()
    const path = writeCsv('p.csv', 'name,parent_path\nDev1,Lab / Rack A-01\nLost,Lab / Rack Z\n')
    const r = manager.applyImportCsv(path, {
      placement: 'path', baseParentId: 'root-id', nameColumn: 'name',
      pathColumn: 'parent_path', columns: [],
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.summary.created).toBe(1)
    expect(r.data.summary.skipped[0].reason).toMatch(/path not found/)
    expect(r.data.project.nodes.find(n => n.name === 'Dev1')!.parentId).toBe('rack-id')
  })

  it('auto-creates missing parents and wires the chain to real node ids', async () => {
    await open()
    const path = writeCsv('h.csv',
      'name,parent_path\n' +
      'Server 1,Room C / Rack C-09\n' +
      'Server 2,Room C / Rack C-09\n')
    const r = manager.applyImportCsv(path, {
      placement: 'path', baseParentId: 'root-id', nameColumn: 'name',
      pathColumn: 'parent_path', autoCreateParents: true, columns: [],
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.summary.created).toBe(2)         // the two servers
    expect(r.data.summary.createdParents).toBe(2)  // Room C + Rack C-09 (deduped)

    const nodes = r.data.project.nodes
    const roomC = nodes.find(n => n.name === 'Room C')!
    const rackC = nodes.find(n => n.name === 'Rack C-09')!
    expect(roomC.parentId).toBe('root-id')
    expect(rackC.parentId).toBe(roomC.id)          // synthetic id resolved to the real one
    const servers = nodes.filter(n => n.name.startsWith('Server '))
    expect(servers).toHaveLength(2)
    expect(servers.every(s => s.parentId === rackC.id)).toBe(true)
    // The two servers under the freshly-created Rack get sequential order.
    expect(servers.map(s => s.order).sort()).toEqual([0, 1])
    // No leftover synthetic ids leaked into the tree.
    expect(nodes.some(n => n.id.startsWith('__import'))).toBe(false)
  })
})

describe('planImportCsv', () => {
  it('catches invalid rows beyond the 50-row sample window', async () => {
    await open()
    const lines = ['name,count']
    for (let i = 1; i <= 60; i++) lines.push(`Row${i},${i === 55 ? 'abc' : i}`)
    const path = writeCsv('big.csv', lines.join('\n') + '\n')
    const r = manager.planImportCsv(path, flatMapping({
      templateId: 'board', columns: [{ header: 'count', key: 'count', include: true }],
    }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.acceptedCount).toBe(59)
    expect(r.data.skippedCount).toBe(1)
    expect(r.data.skipped[0].row).toBe(56) // file row (header=1, Row55 is the 55th data row → file row 56)
  })

  it('returns a mapping error for duplicate keys', async () => {
    await open()
    const path = writeCsv('d.csv', 'name,a,b\nX,1,2\n')
    const r = manager.planImportCsv(path, flatMapping({
      columns: [{ header: 'a', key: 'dup', include: true }, { header: 'b', key: 'dup', include: true }],
    }))
    expect(r.ok).toBe(false)
  })
})

describe('import without a project open', () => {
  it('errors for plan and apply', async () => {
    const pm = new ProjectManager(noopGit as any, noopLogger as any)
    const path = writeCsv('x.csv', 'name\nA\n')
    expect((pm.planImportCsv(path, flatMapping())).ok).toBe(false)
    expect((pm.applyImportCsv(path, flatMapping())).ok).toBe(false)
  })
})

describe('applyImportCsv — update-on-key', () => {
  const TPL = {
    board: { label: 'Board', fields: {
      serial: { type: 'string' }, count: { type: 'number' },
      status: { type: 'enum', options: ['active', 'spare'] }, sku: { type: 'string', required: true },
    } },
  }
  async function openSeeded(extra: unknown[]): Promise<void> {
    const m = {
      version: 3, id: 'imp-id', name: 'Lab', created: TS, modified: TS, templates: TPL,
      nodes: [
        { id: 'root-id', parentId: null, name: 'Lab', order: 0, properties: {}, created: TS, modified: TS },
        { id: 'rack-id', parentId: 'root-id', name: 'Rack A-01', order: 0, properties: {}, created: TS, modified: TS },
        ...extra,
      ],
    }
    writeFileSync(join(tmpDir, 'manifest.json'), JSON.stringify(m, null, 2), 'utf8')
    manager = new ProjectManager(noopGit as any, noopLogger as any)
    const r = await manager.openProject(tmpDir)
    expect(r.ok).toBe(true)
  }
  const board = (id: string, name: string, properties: Record<string, unknown>) =>
    ({ id, parentId: 'rack-id', name, order: 0, properties, templateId: 'board', created: TS, modified: TS })
  const umap = (over: Partial<ImportMapping> = {}): ImportMapping =>
    ({ placement: 'flat', baseParentId: 'rack-id', nameColumn: 'name', columns: [], updateExisting: true, ...over })

  it('updates a matched node: merges props, leaves blanks, bumps modified, commits once', async () => {
    await openSeeded([board('b1', 'Board 1', { serial: 'SN-1', sku: 'OLD' })])
    const path = writeCsv('u.csv', 'name,serial\nBoard 1,SN-2\n')
    const r = manager.applyImportCsv(path, umap({ keyColumn: 'name', columns: [{ header: 'serial', key: 'serial', include: true }] }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.summary.updated).toBe(1)
    expect(r.data.summary.created).toBe(0)
    const b1 = r.data.project.nodes.find(n => n.id === 'b1')!
    expect(b1.properties).toEqual({ serial: 'SN-2', sku: 'OLD' })   // serial overwritten, sku left
    expect(b1.modified).not.toBe(TS)
    const s = await manager.searchNodes('SN-2')
    expect(s.ok && s.data.length).toBeGreaterThan(0)
  })

  it('renames via a property-key match', async () => {
    await openSeeded([board('b1', 'Old Name', { serial: 'SN-1', sku: 'X' })])
    const path = writeCsv('r.csv', 'name,serial\nNew Name,SN-1\n')
    const r = manager.applyImportCsv(path, umap({ keyColumn: 'serial', columns: [{ header: 'serial', key: 'serial', include: true }] }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.summary.updated).toBe(1)
    expect(r.data.project.nodes.find(n => n.id === 'b1')!.name).toBe('New Name')
  })

  it('handles a create + update mix in one import', async () => {
    await openSeeded([board('b1', 'Board 1', { serial: 'SN-1', sku: 'X' })])
    const path = writeCsv('m.csv', 'name,serial\nBoard 1,SN-1b\nBoard 2,SN-2\n')
    const r = manager.applyImportCsv(path, umap({ keyColumn: 'name', columns: [{ header: 'serial', key: 'serial', include: true }] }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.summary.updated).toBe(1)
    expect(r.data.summary.created).toBe(1)
    expect(r.data.project.nodes.some(n => n.name === 'Board 2')).toBe(true)
  })

  it('a skipped rebind leaves the project unchanged (no commit)', async () => {
    const freeform = { id: 'f1', parentId: 'rack-id', name: 'Legacy', order: 0, properties: { count: 'abc' }, created: TS, modified: TS }
    await openSeeded([freeform])
    const path = writeCsv('rb.csv', 'name\nLegacy\n')
    const r = manager.applyImportCsv(path, umap({ keyColumn: 'name', templateId: 'board', columns: [] }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.summary.updated).toBe(0)
    expect(r.data.summary.created).toBe(0)
    expect(r.data.summary.skipped.length).toBe(1)
    const f1 = r.data.project.nodes.find(n => n.id === 'f1')!
    expect(f1.modified).toBe(TS)                       // untouched
    expect(f1.properties).toEqual({ count: 'abc' })    // not coerced/committed
    expect(f1.templateId).toBeUndefined()              // not rebound
  })

  it('a byte-identical re-import is a no-op: 0 updated, node not dirtied', async () => {
    await openSeeded([board('b1', 'Board 1', { serial: 'SN-1', sku: 'X' })])
    const path = writeCsv('noop.csv', 'name,serial,sku\nBoard 1,SN-1,X\n')
    const r = manager.applyImportCsv(path, umap({ keyColumn: 'name', columns: [
      { header: 'serial', key: 'serial', include: true }, { header: 'sku', key: 'sku', include: true },
    ] }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.summary.updated).toBe(0)
    expect(r.data.summary.created).toBe(0)
    expect(r.data.project.nodes.find(n => n.id === 'b1')!.modified).toBe(TS)   // untouched
  })

  it('incrementally indexes created + updated nodes (old value gone, unrelated kept)', async () => {
    // b1 will be UPDATED (serial ALPHA→BRAVO via name key); b2 is UNRELATED.
    await openSeeded([
      board('b1', 'Board 1', { serial: 'ALPHA', sku: 'X' }),
      board('b2', 'Board 2', { serial: 'CHARLIE', sku: 'Y' }),
    ])
    const path = writeCsv('idx.csv', 'name,serial\nBoard 1,BRAVO\nBoard NEW,DELTA\n')
    const r = manager.applyImportCsv(path, umap({ keyColumn: 'name', columns: [{ header: 'serial', key: 'serial', include: true }] }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.summary.updated).toBe(1)
    expect(r.data.summary.created).toBe(1)

    const hits = async (q: string) => {
      const s = await manager.searchNodes(q)
      return s.ok ? s.data.map(h => h.nodeId) : []
    }
    expect(await hits('BRAVO')).toContain('b1')   // updated node re-indexed
    expect((await hits('DELTA')).length).toBeGreaterThan(0)  // created node indexed
    expect(await hits('CHARLIE')).toContain('b2') // unrelated node still indexed (no full wipe)
    expect(await hits('ALPHA')).toHaveLength(0)    // old value removed by the upsert
  })
})

// ─── NetBox relational import (wrapper-layer guards + re-import) ─────────────

function writeNetbox(name: string, dump: unknown): string {
  const p = join(tmpDir, name)
  writeFileSync(p, JSON.stringify(dump), 'utf8')
  return p
}

function netboxDump() {
  return [
    { model: 'dcim.manufacturer', pk: 1, fields: { name: 'Cisco', slug: 'cisco' } },
    { model: 'dcim.devicetype', pk: 10, fields: { manufacturer: 1, model: 'C9300', slug: 'c9300', part_number: 'WS-C9300' } },
    { model: 'dcim.devicerole', pk: 20, fields: { name: 'Switch', slug: 'switch' } },
    { model: 'dcim.site', pk: 100, fields: { name: 'Site Alpha', status: 'active', facility: '', time_zone: '', description: '', physical_address: '' } },
    { model: 'dcim.rack', pk: 300, fields: { name: 'Rack A', site: 100, location: null, role: null, status: 'active', type: '4-post-cabinet', width: 19, u_height: '42.0', serial: '', asset_tag: null, facility_id: '', description: '' } },
    { model: 'dcim.device', pk: 400, fields: { name: 'sw-01', site: 100, location: null, rack: 300, position: '4.0', face: 'front', status: 'active', serial: 'SN-1', asset_tag: null, device_type: 10, role: 20, platform: null, description: '' } },
  ]
}

describe('NetBox import — wrapper guards', () => {
  it('inspectNetboxImport rejects a non-JSON / malformed file with VALIDATION_FAILED', async () => {
    await open()
    const bad = join(tmpDir, 'bad.json')
    writeFileSync(bad, '{not json', 'utf8')
    const r = manager.inspectNetboxImport(bad)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('VALIDATION_FAILED')
  })

  it('caps surfaced skipped issues at 100 and flags capped', async () => {
    await open()
    // 101 sites with invalid (empty) names → all skipped.
    const dump = Array.from({ length: 101 }, (_, i) => ({
      model: 'dcim.site', pk: i + 1, fields: { name: '', status: 'active' },
    }))
    const file = writeNetbox('many.json', dump)
    const r = manager.planNetboxImport(file, { baseParentId: 'root-id' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.skippedCount).toBe(101)   // exact total
    expect(r.data.skipped.length).toBe(100)  // surfaced sample capped
    expect(r.data.capped).toBe(true)
  })

  it('plan/apply require an open project (PROJECT_NOT_FOUND otherwise)', () => {
    const pm = new ProjectManager(noopGit as any, noopLogger as any)
    const file = writeNetbox('nb.json', netboxDump())
    const plan = pm.planNetboxImport(file, { baseParentId: 'root-id' })
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.error.code).toBe('PROJECT_NOT_FOUND')
    const apply = pm.applyNetboxImport(file, { baseParentId: 'root-id' })
    expect(apply.ok).toBe(false)
    if (!apply.ok) expect(apply.error.code).toBe('PROJECT_NOT_FOUND')
  })
})

describe('NetBox import — apply + re-import', () => {
  it('creates the typed tree + templates, then a re-import reuses templates and skips collisions', async () => {
    await open()
    const file = writeNetbox('nb.json', netboxDump())

    // First import: 4 templates + 3 nodes (site, rack, device) under root.
    const first = manager.applyNetboxImport(file, { baseParentId: 'root-id' })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.data.summary.templatesCreated).toBe(4)
    expect(first.data.summary.created).toBe(3)
    expect(first.data.summary.sites).toBe(1)
    expect(first.data.summary.devices).toBe(1)
    const tplCount = Object.keys(first.data.project.templates ?? {}).length
    const site = first.data.project.nodes.find((n) => n.name === 'Site Alpha')!
    expect(site.templateId).toBe('netbox-site')
    const device = first.data.project.nodes.find((n) => n.name === 'sw-01')!
    expect(device.properties).toMatchObject({ manufacturer: 'Cisco', model: 'C9300', position: 4 })

    // Re-import the same file: templates already exist (reused, not recreated),
    // and every node collides with the just-imported children → all skipped.
    const second = manager.applyNetboxImport(file, { baseParentId: 'root-id' })
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.data.summary.templatesCreated).toBe(0)   // reused, not recreated
    expect(second.data.summary.created).toBe(0)            // all collided → skipped
    expect(second.data.summary.skippedCount).toBeGreaterThan(0)
    // No duplicate templates or nodes leaked in.
    expect(Object.keys(second.data.project.templates ?? {}).length).toBe(tplCount)
    expect(second.data.project.nodes.filter((n) => n.name === 'Site Alpha').length).toBe(1)
  })
})
