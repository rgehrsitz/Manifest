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
})
