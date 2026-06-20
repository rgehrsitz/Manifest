import { describe, it, expect } from 'vitest'
import { planImport, suggestKey } from '../../../src/shared/import'
import type { ManifestNode, NodeTemplate, ImportMapping } from '../../../src/shared/types'

function node(id: string, parentId: string | null, name: string): ManifestNode {
  return { id, parentId, name, order: 0, properties: {}, created: '', modified: '' }
}

// Lab → Room A → Rack A-01 (with an existing child "Existing Board"); Room B.
const NODES: ManifestNode[] = [
  node('root', null, 'Lab'),
  node('rA', 'root', 'Room A'),
  node('kA1', 'rA', 'Rack A-01'),
  node('existing', 'kA1', 'Existing Board'),
  node('rB', 'root', 'Room B'),
]

const TEMPLATES: Record<string, NodeTemplate> = {
  board: {
    label: 'Board',
    fields: {
      revision: { type: 'version' },
      serial: { type: 'string' },
      count: { type: 'number' },
      status: { type: 'enum', options: ['active', 'spare'] },
      sku: { type: 'string', required: true },
      controller: { type: 'reference' },
    },
  },
}

function mapping(over: Partial<ImportMapping> = {}): ImportMapping {
  return {
    placement: 'flat',
    baseParentId: 'kA1',
    nameColumn: 'name',
    columns: [],
    ...over,
  }
}

describe('suggestKey', () => {
  it('normalizes headers into valid property keys', () => {
    expect(suggestKey('Serial Number')).toBe('serial_number')
    expect(suggestKey('firmware-rev')).toBe('firmware_rev')
    expect(suggestKey('  Foo Bar!  ')).toBe('foo_bar')
    expect(suggestKey('already_ok')).toBe('already_ok')
  })
})

describe('planImport — placement', () => {
  it('flat: rows become children of the base parent', () => {
    const out = planImport(
      [['B1', 'SN1'], ['B2', 'SN2']],
      ['name', 'serial'],
      mapping({ columns: [{ header: 'serial', key: 'serial', include: true }] }),
      TEMPLATES, NODES,
    )
    expect(out.mappingError).toBeUndefined()
    expect(out.create).toHaveLength(2)
    expect(out.create.every(n => n.parentId === 'kA1')).toBe(true)
    expect(out.create[0].properties).toEqual({ serial: 'SN1' })
  })

  it('path: resolves the breadcrumb relative to base', () => {
    const out = planImport(
      [['B1', 'Room A / Rack A-01']],
      ['name', 'parent_path'],
      mapping({ placement: 'path', baseParentId: 'root', pathColumn: 'parent_path' }),
      TEMPLATES, NODES,
    )
    expect(out.create).toHaveLength(1)
    expect(out.create[0].parentId).toBe('kA1')
  })

  it('path: tolerates a leading root-name segment', () => {
    const out = planImport(
      [['B1', 'Lab / Room A / Rack A-01']],
      ['name', 'parent_path'],
      mapping({ placement: 'path', baseParentId: 'root', pathColumn: 'parent_path' }),
      TEMPLATES, NODES,
    )
    expect(out.create[0]?.parentId).toBe('kA1')
  })

  it('path: unresolved path skips the row', () => {
    const out = planImport(
      [['B1', 'Room A / Rack Z-99']],
      ['name', 'parent_path'],
      mapping({ placement: 'path', baseParentId: 'root', pathColumn: 'parent_path' }),
      TEMPLATES, NODES,
    )
    expect(out.create).toHaveLength(0)
    expect(out.skipped[0].reason).toMatch(/path not found/)
    expect(out.skipped[0].row).toBe(2)
  })
})

describe('planImport — auto-create parents', () => {
  const pmap = (over: Partial<ImportMapping> = {}) =>
    mapping({ placement: 'path', baseParentId: 'root', pathColumn: 'parent_path', autoCreateParents: true, ...over })

  it('stages missing ancestors and points the row at the deepest one', () => {
    const out = planImport(
      [['Server 1', 'Room C / Rack C-01']],
      ['name', 'parent_path'],
      pmap(),
      TEMPLATES, NODES,
    )
    expect(out.skipped).toHaveLength(0)
    // Room C, Rack C-01, then the row.
    expect(out.create).toHaveLength(3)
    const [roomC, rackC, row] = out.create
    expect(roomC).toMatchObject({ name: 'Room C', parentId: 'root', auto: true })
    expect(rackC).toMatchObject({ name: 'Rack C-01', parentId: roomC.localId, auto: true })
    expect(row).toMatchObject({ name: 'Server 1', parentId: rackC.localId })
    expect(row.auto).toBeFalsy()
  })

  it('reuses an ancestor across rows that share a path (no duplicates)', () => {
    const out = planImport(
      [['Server 1', 'Room C / Rack C-01'], ['Server 2', 'Room C / Rack C-01']],
      ['name', 'parent_path'],
      pmap(),
      TEMPLATES, NODES,
    )
    // 2 ancestors + 2 rows — not 4 ancestors.
    expect(out.create.filter(n => n.auto)).toHaveLength(2)
    const rows = out.create.filter(n => !n.auto)
    expect(rows).toHaveLength(2)
    expect(rows[0].parentId).toBe(rows[1].parentId)
  })

  it('grafts onto an existing ancestor, only creating the missing tail', () => {
    const out = planImport(
      [['Server 1', 'Room A / Rack A-09']],   // Room A exists; Rack A-09 does not
      ['name', 'parent_path'],
      pmap(),
      TEMPLATES, NODES,
    )
    const autos = out.create.filter(n => n.auto)
    expect(autos).toHaveLength(1)
    expect(autos[0]).toMatchObject({ name: 'Rack A-09', parentId: 'rA' })
  })

  it('leaves no orphan ancestors when the only row needing them is skipped', () => {
    const out = planImport(
      [['', 'Room C / Rack C-01']],   // blank name → row skipped
      ['name', 'parent_path'],
      pmap(),
      TEMPLATES, NODES,
    )
    expect(out.create).toHaveLength(0)
    expect(out.skipped).toHaveLength(1)
  })

  it('still skips unresolved paths when auto-create is off', () => {
    const out = planImport(
      [['Server 1', 'Room C / Rack C-01']],
      ['name', 'parent_path'],
      pmap({ autoCreateParents: false }),
      TEMPLATES, NODES,
    )
    expect(out.create).toHaveLength(0)
    expect(out.skipped[0].reason).toMatch(/path not found/)
  })

  it('resolves a path THROUGH a node an earlier row created (no duplicate sibling)', () => {
    // Row 1 creates "Rack 1" directly under base; row 2's path walks through it.
    const out = planImport(
      [['Rack 1', ''], ['Server', 'Rack 1']],
      ['name', 'parent_path'],
      pmap(),
      TEMPLATES, NODES,
    )
    expect(out.skipped).toHaveLength(0)
    const racks = out.create.filter(n => n.name === 'Rack 1')
    expect(racks).toHaveLength(1)          // exactly one — not a row + an auto dup
    expect(racks[0].auto).toBeFalsy()       // the row-created one, not auto
    const server = out.create.find(n => n.name === 'Server')!
    expect(server.parentId).toBe(racks[0].localId)  // nested under the row's Rack 1
  })

  it('skips a leaf row that collides with an auto-created ancestor of the same name', () => {
    // Row 1 auto-creates "Rack 1" as an ancestor; row 2 is a leaf "Rack 1" under base.
    const out = planImport(
      [['Server', 'Rack 1 / Sub'], ['Rack 1', '']],
      ['name', 'parent_path'],
      pmap(),
      TEMPLATES, NODES,
    )
    expect(out.create.filter(n => n.name === 'Rack 1')).toHaveLength(1) // only the auto ancestor
    expect(out.skipped).toHaveLength(1)
    expect(out.skipped[0].reason).toMatch(/already exists/)
  })

  it('a skipped row mid-batch leaves no ancestors; a later valid row creates them once', () => {
    // Row 1 (invalid number) and row 2 (valid) share the same new path.
    const out = planImport(
      [['Bad', 'Room C / Rack C-01', 'abc'], ['Good', 'Room C / Rack C-01', '7']],
      ['name', 'parent_path', 'count'],
      pmap({ templateId: 'board', columns: [{ header: 'count', key: 'count', include: true }] }),
      TEMPLATES, NODES,
    )
    expect(out.skipped).toHaveLength(1)                 // 'Bad' (invalid count)
    expect(out.create.filter(n => n.auto)).toHaveLength(2)  // Room C + Rack C-01, once
    const good = out.create.find(n => n.name === 'Good')!
    expect(good.properties).toEqual({ count: 7 })
  })

  it('skips a row whose auto-created segment name is invalid (too long)', () => {
    const longSeg = 'X'.repeat(256)
    const out = planImport(
      [['Server', `${longSeg} / Rack`]],
      ['name', 'parent_path'],
      pmap(),
      TEMPLATES, NODES,
    )
    expect(out.create).toHaveLength(0)
    expect(out.skipped[0].reason).toMatch(/cannot create path segment/)
  })
})

describe('planImport — typed coercion (boolean / date / version)', () => {
  const COERCE_TEMPLATES: Record<string, NodeTemplate> = {
    widget: {
      label: 'Widget',
      fields: {
        enabled: { type: 'boolean' },
        installed: { type: 'date' },
        rev: { type: 'version' },
      },
    },
  }
  const cmap = (over: Partial<ImportMapping> = {}) => mapping({ templateId: 'widget', ...over })

  it('coerces boolean cells to real primitives and rejects non-boolean text', () => {
    const out = planImport(
      [['W1', 'true'], ['W2', 'FALSE'], ['W3', 'yes']],
      ['name', 'enabled'],
      cmap({ columns: [{ header: 'enabled', key: 'enabled', include: true }] }),
      COERCE_TEMPLATES, NODES,
    )
    expect(out.create).toHaveLength(2)
    expect(out.create[0].properties.enabled).toBe(true)
    expect(typeof out.create[0].properties.enabled).toBe('boolean')   // primitive, not 'true'
    expect(out.create[1].properties.enabled).toBe(false)
    expect(out.skipped[0].column).toBe('enabled')                     // 'yes' is invalid
  })

  it('validates date cells (rejects an impossible calendar date)', () => {
    const out = planImport(
      [['W1', '2026-02-30'], ['W2', '2026-03-15']],
      ['name', 'installed'],
      cmap({ columns: [{ header: 'installed', key: 'installed', include: true }] }),
      COERCE_TEMPLATES, NODES,
    )
    expect(out.skipped[0].column).toBe('installed')
    expect(out.create.find(n => n.name === 'W2')!.properties.installed).toBe('2026-03-15')
  })

  it('stores a coerced version value', () => {
    const out = planImport(
      [['W1', 'v1.2.3']],
      ['name', 'rev'],
      cmap({ columns: [{ header: 'rev', key: 'rev', include: true }] }),
      COERCE_TEMPLATES, NODES,
    )
    expect(out.create[0].properties.rev).toBe('v1.2.3')
  })
})

describe('planImport — path separator', () => {
  it('resolves with a custom separator', () => {
    const out = planImport(
      [['B1', 'Room A>Rack A-01']],
      ['name', 'parent_path'],
      mapping({ placement: 'path', baseParentId: 'root', pathColumn: 'parent_path', pathSeparator: '>' }),
      TEMPLATES, NODES,
    )
    expect(out.create[0]?.parentId).toBe('kA1')
  })

  it('falls back to the default separator when pathSeparator is empty', () => {
    const out = planImport(
      [['B1', 'Room A / Rack A-01']],
      ['name', 'parent_path'],
      mapping({ placement: 'path', baseParentId: 'root', pathColumn: 'parent_path', pathSeparator: '' }),
      TEMPLATES, NODES,
    )
    expect(out.create[0]?.parentId).toBe('kA1')
  })
})

describe('planImport — collisions', () => {
  it('skips a row colliding with an existing sibling (case-insensitive)', () => {
    const out = planImport(
      [['existing board']],
      ['name'],
      mapping(),
      TEMPLATES, NODES,
    )
    expect(out.create).toHaveLength(0)
    expect(out.skipped[0].reason).toMatch(/already exists/)
  })

  it('skips an in-batch duplicate name', () => {
    const out = planImport(
      [['Dup'], ['Dup']],
      ['name'],
      mapping(),
      TEMPLATES, NODES,
    )
    expect(out.create).toHaveLength(1)
    expect(out.skipped).toHaveLength(1)
  })
})

describe('planImport — typed values', () => {
  const tmap = mapping({
    templateId: 'board',
    columns: [
      { header: 'count', key: 'count', include: true },
      { header: 'status', key: 'status', include: true },
    ],
  })

  it('coerces typed cells (string "5" → number 5)', () => {
    const out = planImport([['B1', '5', 'active']], ['name', 'count', 'status'], tmap, TEMPLATES, NODES)
    expect(out.create).toHaveLength(1)
    expect(out.create[0].properties).toEqual({ count: 5, status: 'active' })
  })

  it('skips a row with an invalid typed cell', () => {
    const out = planImport([['B1', 'abc', 'active']], ['name', 'count', 'status'], tmap, TEMPLATES, NODES)
    expect(out.create).toHaveLength(0)
    expect(out.skipped[0].column).toBe('count')
  })

  it('leaves empty cells unset', () => {
    const out = planImport([['B1', '', 'spare']], ['name', 'count', 'status'], tmap, TEMPLATES, NODES)
    expect(out.create[0].properties).toEqual({ status: 'spare' })
  })

  it('validates reference cells against existing project nodes', () => {
    const refMap = mapping({
      templateId: 'board',
      columns: [{ header: 'controller', key: 'controller', include: true }],
    })
    const ok = planImport([['B1', 'existing']], ['name', 'controller'], refMap, TEMPLATES, NODES)
    expect(ok.create).toHaveLength(1)
    expect(ok.create[0].properties.controller).toBe('existing')

    const bad = planImport([['B2', 'missing-node']], ['name', 'controller'], refMap, TEMPLATES, NODES)
    expect(bad.create).toHaveLength(0)
    expect(bad.skipped[0].reason).toMatch(/Reference target not found/)
  })
})

describe('planImport — required is advisory (warn, not skip)', () => {
  it('imports a row missing a required field, with a warning', () => {
    const out = planImport(
      [['B1', 'v1.0.0']],
      ['name', 'revision'],
      mapping({ templateId: 'board', columns: [{ header: 'revision', key: 'revision', include: true }] }),
      TEMPLATES, NODES,
    )
    expect(out.create).toHaveLength(1)              // row kept
    expect(out.warnings.some(w => w.column === 'sku')).toBe(true)
  })
})

describe('planImport — mapping errors', () => {
  it('rejects duplicate mapped keys', () => {
    const out = planImport(
      [['B1', 'a', 'b']],
      ['name', 'x', 'y'],
      mapping({ columns: [
        { header: 'x', key: 'serial', include: true },
        { header: 'y', key: 'serial', include: true },
      ] }),
      TEMPLATES, NODES,
    )
    expect(out.mappingError).toMatch(/Duplicate property key/)
    expect(out.create).toHaveLength(0)
  })

  it('rejects an invalid property key', () => {
    const out = planImport(
      [['B1', 'a']],
      ['name', 'x'],
      mapping({ columns: [{ header: 'x', key: 'bad key', include: true }] }),
      TEMPLATES, NODES,
    )
    expect(out.mappingError).toBeTruthy()
  })

  it('rejects a missing name column', () => {
    const out = planImport([['a']], ['x'], mapping({ nameColumn: 'name' }), TEMPLATES, NODES)
    expect(out.mappingError).toMatch(/Name column/)
  })

  it('rejects path placement without a valid path column', () => {
    const out = planImport([['B1']], ['name'], mapping({ placement: 'path' }), TEMPLATES, NODES)
    expect(out.mappingError).toMatch(/path column/i)
  })

  it('rejects an included column whose header is not in the file (stale mapping)', () => {
    const out = planImport(
      [['B1', 'a']],
      ['name', 'x'],   // "ghost" is mapped but absent from the file
      mapping({ columns: [{ header: 'ghost', key: 'ghost', include: true }] }),
      TEMPLATES, NODES,
    )
    expect(out.mappingError).toMatch(/not in the file/)
    expect(out.create).toHaveLength(0)
  })
})

// ─── Update-on-key re-import ───────────────────────────────────────────────────

describe('planImport — update-on-key', () => {
  const UROOT: ManifestNode = { id: 'root', parentId: null, name: 'Lab', order: 0, properties: {}, created: '', modified: '' }
  const RACK: ManifestNode = { id: 'rack', parentId: 'root', name: 'Rack', order: 0, properties: {}, created: '', modified: '' }
  function child(id: string, name: string, properties: Record<string, string | number | boolean | null> = {}, templateId?: string): ManifestNode {
    return { id, parentId: 'rack', name, order: 0, properties, created: '', modified: '', ...(templateId ? { templateId } : {}) }
  }
  const umap = (over: Partial<ImportMapping> = {}): ImportMapping =>
    mapping({ baseParentId: 'rack', updateExisting: true, ...over })

  it('updates an existing sibling matched by name (not skip, not create)', () => {
    const out = planImport(
      [['Board 1', 'SN-9']],
      ['name', 'serial'],
      umap({ keyColumn: 'name', columns: [{ header: 'serial', key: 'serial', include: true }] }),
      TEMPLATES, [UROOT, RACK, child('b1', 'Board 1', { serial: 'SN-1' })],
    )
    expect(out.create).toHaveLength(0)
    expect(out.skipped).toHaveLength(0)
    expect(out.update).toEqual([{ nodeId: 'b1', name: 'Board 1', properties: { serial: 'SN-9' } }])
  })

  it('matches by the column’s mapped key, not its header text', () => {
    // Header "Serial Number" maps to property key "serial"; existing nodes store
    // by "serial". Matching must use the key, not the header.
    const out = planImport(
      [['Board 1', 'SN-1', 'spare']],
      ['name', 'Serial Number', 'status'],
      umap({ keyColumn: 'Serial Number', columns: [
        { header: 'Serial Number', key: 'serial', include: true },
        { header: 'status', key: 'status', include: true },
      ] }),
      TEMPLATES, [UROOT, RACK, child('b1', 'Board 1', { serial: 'SN-1', status: 'active' })],
    )
    expect(out.update).toHaveLength(1)
    expect(out.update[0].properties).toEqual({ serial: 'SN-1', status: 'spare' })
  })

  it('compares a non-string key value via normalization', () => {
    const out = planImport(
      [['Board 1', '5', 'spare']],
      ['name', 'count', 'status'],
      umap({ keyColumn: 'count', templateId: 'board', columns: [
        { header: 'count', key: 'count', include: true },
        { header: 'status', key: 'status', include: true },
      ] }),
      TEMPLATES, [UROOT, RACK, child('b1', 'Board 1', { count: 5, status: 'active' }, 'board')],
    )
    expect(out.update).toHaveLength(1)
    expect(out.update[0].nodeId).toBe('b1')
    expect(out.update[0].properties.status).toBe('spare')
  })

  it('creates when no existing node matches the key', () => {
    const out = planImport(
      [['Board 99', 'SN-99']],
      ['name', 'serial'],
      umap({ keyColumn: 'name', columns: [{ header: 'serial', key: 'serial', include: true }] }),
      TEMPLATES, [UROOT, RACK, child('b1', 'Board 1', { serial: 'SN-1' })],
    )
    expect(out.update).toHaveLength(0)
    expect(out.create).toHaveLength(1)
    expect(out.create[0]).toMatchObject({ name: 'Board 99', parentId: 'rack' })
  })

  it('skips with a key-aware reason when the key matches nothing but the name is taken', () => {
    // Property-key update where serial SN-99 matches no existing node, yet a node
    // named "Board 1" already exists → must explain BOTH (key miss + name taken),
    // not the bare "name already exists" (which hides that the key failed to match).
    const out = planImport(
      [['Board 1', 'SN-99']],
      ['name', 'serial'],
      umap({ keyColumn: 'serial', columns: [{ header: 'serial', key: 'serial', include: true }] }),
      TEMPLATES, [UROOT, RACK, child('b1', 'Board 1', { serial: 'SN-1' })],
    )
    expect(out.update).toHaveLength(0)
    expect(out.create).toHaveLength(0)
    expect(out.skipped).toHaveLength(1)
    expect(out.skipped[0].column).toBe('serial')
    expect(out.skipped[0].reason).toMatch(/no existing node matched serial "SN-99"/)
    expect(out.skipped[0].reason).toMatch(/already exists/)
  })

  it('leaves an existing value when the cell is blank (no wipe)', () => {
    const out = planImport(
      [['Board 1', '', 'spare']],
      ['name', 'serial', 'status'],
      umap({ keyColumn: 'name', columns: [
        { header: 'serial', key: 'serial', include: true },
        { header: 'status', key: 'status', include: true },
      ] }),
      TEMPLATES, [UROOT, RACK, child('b1', 'Board 1', { serial: 'SN-1', status: 'active' })],
    )
    expect(out.update[0].properties).toEqual({ serial: 'SN-1', status: 'spare' })
  })

  it('renames on a property-key match whose row name differs', () => {
    const out = planImport(
      [['New Name', 'SN-1']],
      ['name', 'serial'],
      umap({ keyColumn: 'serial', columns: [{ header: 'serial', key: 'serial', include: true }] }),
      TEMPLATES, [UROOT, RACK, child('b1', 'Old Name', { serial: 'SN-1' })],
    )
    expect(out.update).toHaveLength(1)
    expect(out.update[0]).toMatchObject({ nodeId: 'b1', name: 'New Name' })
  })

  it('skips a rename that would collide with another sibling', () => {
    const out = planImport(
      [['Board 2', 'SN-1']],
      ['name', 'serial'],
      umap({ keyColumn: 'serial', columns: [{ header: 'serial', key: 'serial', include: true }] }),
      TEMPLATES, [UROOT, RACK, child('b1', 'Board 1', { serial: 'SN-1' }), child('b2', 'Board 2', { serial: 'SN-2' })],
    )
    expect(out.update).toHaveLength(0)
    expect(out.skipped[0].reason).toMatch(/already exists/)
  })

  it('coerces row cells against the node’s effective template when the mapping has none', () => {
    const out = planImport(
      [['Board 1', '5']],
      ['name', 'count'],
      umap({ keyColumn: 'name', columns: [{ header: 'count', key: 'count', include: true }] }),
      TEMPLATES, [UROOT, RACK, child('b1', 'Board 1', {}, 'board')],
    )
    expect(out.update).toHaveLength(1)
    expect(out.update[0].properties.count).toBe(5)          // number, coerced via board.count
    expect(typeof out.update[0].properties.count).toBe('number')
  })

  it('skips an update that would make a reference point at the same node', () => {
    const out = planImport(
      [['Board 1', 'b1']],
      ['name', 'controller'],
      umap({ keyColumn: 'name', columns: [{ header: 'controller', key: 'controller', include: true }] }),
      TEMPLATES, [UROOT, RACK, child('b1', 'Board 1', {}, 'board')],
    )
    expect(out.update).toHaveLength(0)
    expect(out.skipped[0].reason).toMatch(/same node/)
  })

  it('skips a rebind when an existing property cannot be coerced under the new template', () => {
    const out = planImport(
      [['Board 1']],
      ['name'],
      umap({ keyColumn: 'name', templateId: 'board', columns: [] }),
      TEMPLATES, [UROOT, RACK, child('b1', 'Board 1', { count: 'abc' })],   // 'abc' can't coerce to board.count(number)
    )
    expect(out.update).toHaveLength(0)
    expect(out.skipped[0].reason).toMatch(/invalid under new template/)
  })

  it('coerces a carried-over value on rebind (mirrors nodeUpdate)', () => {
    // Freeform node with serial "5"; rebinding to board (serial:string) leaves it,
    // but a numeric-string under a number field coerces rather than being rejected.
    const out = planImport(
      [['Board 1']],
      ['name'],
      umap({ keyColumn: 'name', templateId: 'board', columns: [] }),
      TEMPLATES, [UROOT, RACK, child('b1', 'Board 1', { count: '5' })],   // "5" → number 5 under board.count
    )
    expect(out.skipped).toHaveLength(0)
    expect(out.update).toHaveLength(1)
    expect(out.update[0].properties.count).toBe(5)
    expect(out.update[0].templateId).toBe('board')
  })

  it('applies a case-only rename (exact-name comparison, no false no-op)', () => {
    const out = planImport(
      [['old name', 'SN-1']],
      ['name', 'serial'],
      umap({ keyColumn: 'serial', columns: [{ header: 'serial', key: 'serial', include: true }] }),
      TEMPLATES, [UROOT, RACK, child('b1', 'Old Name', { serial: 'SN-1' })],
    )
    expect(out.update).toHaveLength(1)
    expect(out.update[0].name).toBe('old name')
  })

  it('a skipped row does not reserve its key value for a later row', () => {
    // Row 1 (serial SN-9) skips on an invalid cell; row 2 reuses SN-9 and creates.
    const out = planImport(
      [['B-a', 'SN-9', 'abc'], ['B-b', 'SN-9', '7']],
      ['name', 'serial', 'count'],
      umap({ keyColumn: 'serial', templateId: 'board', columns: [
        { header: 'serial', key: 'serial', include: true },
        { header: 'count', key: 'count', include: true },
      ] }),
      TEMPLATES, [UROOT, RACK],
    )
    expect(out.create).toHaveLength(1)
    expect(out.create[0].name).toBe('B-b')
    expect(out.skipped).toHaveLength(1)
    expect(out.skipped[0].reason).not.toMatch(/duplicate key/)   // skipped for invalid count, not dup
  })

  it('skips a second NEW row that shares a property-key value (would dup the key)', () => {
    const out = planImport(
      [['Board A', 'SN-9'], ['Board B', 'SN-9']],   // neither matches; same serial
      ['name', 'serial'],
      umap({ keyColumn: 'serial', columns: [{ header: 'serial', key: 'serial', include: true }] }),
      TEMPLATES, [UROOT, RACK],
    )
    expect(out.create).toHaveLength(1)
    expect(out.skipped[0].reason).toMatch(/duplicate key value/)
  })

  it('does not emit a no-op update (row identical to the node)', () => {
    const out = planImport(
      [['Board 1', 'SN-1']],
      ['name', 'serial'],
      umap({ keyColumn: 'name', columns: [{ header: 'serial', key: 'serial', include: true }] }),
      TEMPLATES, [UROOT, RACK, child('b1', 'Board 1', { serial: 'SN-1' })],
    )
    expect(out.update).toHaveLength(0)
    expect(out.create).toHaveLength(0)
    expect(out.skipped).toHaveLength(0)
  })

  it('skips an ambiguous match (2+ existing share the key value)', () => {
    const out = planImport(
      [['Board X', 'SN-1']],
      ['name', 'serial'],
      umap({ keyColumn: 'serial', columns: [{ header: 'serial', key: 'serial', include: true }] }),
      TEMPLATES, [UROOT, RACK, child('a', 'A', { serial: 'SN-1' }), child('b', 'B', { serial: 'SN-1' })],
    )
    expect(out.update).toHaveLength(0)
    expect(out.skipped[0].reason).toMatch(/ambiguous/)
  })

  it('skips a second row that matches an already-updated node', () => {
    const out = planImport(
      [['Board 1', 'spare'], ['Board 1', 'active']],
      ['name', 'status'],
      umap({ keyColumn: 'name', columns: [{ header: 'status', key: 'status', include: true }] }),
      TEMPLATES, [UROOT, RACK, child('b1', 'Board 1', { status: 'active' })],
    )
    expect(out.update).toHaveLength(1)
    expect(out.update[0].properties.status).toBe('spare')
    expect(out.skipped[0].reason).toMatch(/already updated/)
  })

  it('skips a row with a blank key value', () => {
    const out = planImport(
      [['Board 1', '', 'spare']],
      ['name', 'serial', 'status'],
      umap({ keyColumn: 'serial', columns: [
        { header: 'serial', key: 'serial', include: true },
        { header: 'status', key: 'status', include: true },
      ] }),
      TEMPLATES, [UROOT, RACK, child('b1', 'Board 1', { serial: 'SN-1' })],
    )
    expect(out.skipped[0].reason).toMatch(/missing key/)
  })

  it('rejects update mode with no key column, or an excluded key column', () => {
    const base = [UROOT, RACK, child('b1', 'Board 1')]
    expect(planImport([['Board 1']], ['name'], umap({ columns: [] }), TEMPLATES, base).mappingError).toMatch(/key column/i)
    const out = planImport(
      [['Board 1', 'SN-1']],
      ['name', 'serial'],
      umap({ keyColumn: 'serial', columns: [{ header: 'serial', key: 'serial', include: false }] }),
      TEMPLATES, base,
    )
    expect(out.mappingError).toMatch(/key column/i)
  })
})
