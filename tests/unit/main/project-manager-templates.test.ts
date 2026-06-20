// Unit tests for template-driven typed properties in ProjectManager.
// Uses real filesystem via tmp directories, never mocks.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { ProjectManager } from '../../../src/main/project-manager'
import type { Project, NodeTemplate } from '../../../src/shared/types'

const noopLogger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }
const noopGit = {
  checkVersion: async () => ({ available: true, version: '2.50.0', meetsMinimum: true, minimumVersion: '2.25' }),
  initRepo: async () => {},
  initialCommit: async () => {},
  run: async () => ({ stdout: '', stderr: '' }),
}

let tmpDir: string
let manager: ProjectManager

function makeManifest(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    version: 2,
    id: 'test-project-id',
    name: 'Test Project',
    created: '2026-01-01T00:00:00.000Z',
    modified: '2026-01-01T00:00:00.000Z',
    nodes: [
      {
        id: 'root-id', parentId: null, name: 'Test Project', order: 0, properties: {},
        created: '2026-01-01T00:00:00.000Z', modified: '2026-01-01T00:00:00.000Z',
      },
    ],
    ...overrides,
  }
}

function writeFixture(dir: string, data: object) {
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(data, null, 2), 'utf8')
}

async function openWith(data: object): Promise<Project> {
  writeFixture(tmpDir, data)
  manager = new ProjectManager(noopGit as any, noopLogger as any)
  const result = await manager.openProject(tmpDir)
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.error.message)
  return result.data
}

const softwareItem: NodeTemplate = {
  label: 'Software Item',
  fields: {
    version: { type: 'version' },
    installed_date: { type: 'date' },
    status: { type: 'enum', options: ['approved', 'testing', 'retired'] },
    units: { type: 'number', default: 1 },
  },
}

const controllerLink: NodeTemplate = {
  label: 'Controlled Asset',
  fields: {
    controller: { type: 'reference' },
  },
}

beforeEach(() => {
  tmpDir = join(tmpdir(), `manifest-tpl-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(tmpDir, { recursive: true })
})

afterEach(async () => {
  manager?.cancelAutosave()
  await manager?.flushAndClose()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('migration on open', () => {
  it('opens a v2 project and adds an empty templates map (now v3)', async () => {
    const project = await openWith(makeManifest())
    expect(project.version).toBe(3)
    expect(project.templates).toEqual({})
  })
})

describe('templateCreate', () => {
  it('creates a valid template', async () => {
    await openWith(makeManifest())
    const r = manager.templateCreate('software-item', softwareItem)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.templates?.['software-item']?.label).toBe('Software Item')
  })
  it('rejects a non-slug id', async () => {
    await openWith(makeManifest())
    expect(manager.templateCreate('Software Item', softwareItem).ok).toBe(false)
  })
  it('rejects a duplicate id', async () => {
    await openWith(makeManifest())
    manager.templateCreate('software-item', softwareItem)
    expect(manager.templateCreate('software-item', softwareItem).ok).toBe(false)
  })
  it('rejects a malformed template (enum without options)', async () => {
    await openWith(makeManifest())
    const bad: NodeTemplate = { label: 'X', fields: { s: { type: 'enum' } } }
    expect(manager.templateCreate('x', bad).ok).toBe(false)
  })
  it('rejects a reference default that points at a missing node', async () => {
    await openWith(makeManifest())
    const badDefault: NodeTemplate = {
      label: 'Link',
      fields: { controller: { type: 'reference', default: 'missing-node' } },
    }
    expect(manager.templateCreate('link', badDefault).ok).toBe(false)
  })
})

describe('nodeCreate with template', () => {
  it('binds the template and seeds field defaults', async () => {
    await openWith(makeManifest())
    manager.templateCreate('software-item', softwareItem)
    const r = manager.nodeCreate('root-id', 'Flight Test App', 'software-item')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const node = r.data.nodes.find(n => n.name === 'Flight Test App')!
    expect(node.templateId).toBe('software-item')
    expect(node.properties).toEqual({ units: 1 })
  })
  it('rejects an unknown templateId', async () => {
    await openWith(makeManifest())
    expect(manager.nodeCreate('root-id', 'X', 'nope').ok).toBe(false)
  })
})

describe('nodeUpdate — coercion and validation', () => {
  it('coerces template-field values to typed primitives', async () => {
    await openWith(makeManifest())
    manager.templateCreate('software-item', softwareItem)
    const created = manager.nodeCreate('root-id', 'App', 'software-item')
    const id = (created as any).data.nodes.find((n: any) => n.name === 'App').id

    const r = manager.nodeUpdate(id, {
      properties: { version: 'v2.3.1', units: '5' as any, status: 'approved' },
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const node = r.data.nodes.find(n => n.id === id)!
    expect(node.properties.version).toBe('v2.3.1')
    expect(node.properties.units).toBe(5)           // coerced string → number
    expect(node.properties.status).toBe('approved')
  })

  it('rejects a value that cannot be coerced to the field type', async () => {
    await openWith(makeManifest())
    manager.templateCreate('software-item', softwareItem)
    const created = manager.nodeCreate('root-id', 'App', 'software-item')
    const id = (created as any).data.nodes.find((n: any) => n.name === 'App').id

    expect(manager.nodeUpdate(id, { properties: { status: 'nope' } }).ok).toBe(false)
    expect(manager.nodeUpdate(id, { properties: { units: 'abc' } }).ok).toBe(false)
  })

  it('leaves ad-hoc (non-template) keys untyped', async () => {
    await openWith(makeManifest())
    manager.templateCreate('software-item', softwareItem)
    const created = manager.nodeCreate('root-id', 'App', 'software-item')
    const id = (created as any).data.nodes.find((n: any) => n.name === 'App').id

    const r = manager.nodeUpdate(id, { properties: { note: 'free text 123' } })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.nodes.find(n => n.id === id)!.properties.note).toBe('free text 123')
  })

  it('accepts reference values that point at existing nodes', async () => {
    await openWith(makeManifest())
    manager.templateCreate('controlled-asset', controllerLink)
    const target = manager.nodeCreate('root-id', 'Power Supply')
    expect(target.ok).toBe(true)
    const targetId = target.ok ? target.data.nodes.find(n => n.name === 'Power Supply')!.id : ''
    const created = manager.nodeCreate('root-id', 'Chamber', 'controlled-asset')
    const id = (created as any).data.nodes.find((n: any) => n.name === 'Chamber').id

    const r = manager.nodeUpdate(id, { properties: { controller: targetId } })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.nodes.find(n => n.id === id)!.properties.controller).toBe(targetId)
  })

  it('rejects reference values that point at missing nodes', async () => {
    await openWith(makeManifest())
    manager.templateCreate('controlled-asset', controllerLink)
    const created = manager.nodeCreate('root-id', 'Chamber', 'controlled-asset')
    const id = (created as any).data.nodes.find((n: any) => n.name === 'Chamber').id

    expect(manager.nodeUpdate(id, { properties: { controller: 'missing-node' } }).ok).toBe(false)
  })
})

describe('templateUpdate — bound-node guard', () => {
  it('rejects a field-type change that would invalidate an existing bound value', async () => {
    await openWith(makeManifest())
    manager.templateCreate('software-item', softwareItem)
    const created = manager.nodeCreate('root-id', 'App', 'software-item')
    const id = (created as any).data.nodes.find((n: any) => n.name === 'App').id
    manager.nodeUpdate(id, { properties: { version: 'v2.3.1' } })

    // Change `version` from version-type to number-type — existing "v2.3.1"
    // becomes invalid, so the edit must be rejected.
    const r = manager.templateUpdate('software-item', {
      fields: { ...softwareItem.fields, version: { type: 'number' } },
    })
    expect(r.ok).toBe(false)
  })

  it('allows a compatible change and removing a field', async () => {
    await openWith(makeManifest())
    manager.templateCreate('software-item', softwareItem)
    const created = manager.nodeCreate('root-id', 'App', 'software-item')
    const id = (created as any).data.nodes.find((n: any) => n.name === 'App').id
    manager.nodeUpdate(id, { properties: { version: 'v2.3.1' } })

    const r = manager.templateUpdate('software-item', {
      label: 'SW Item',
      fields: { version: { type: 'version' } },   // dropped other fields — allowed
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.templates?.['software-item']?.label).toBe('SW Item')
  })

  it('rejects changing a field to reference when bound values do not target nodes', async () => {
    await openWith(makeManifest())
    manager.templateCreate('software-item', softwareItem)
    const created = manager.nodeCreate('root-id', 'App', 'software-item')
    const id = (created as any).data.nodes.find((n: any) => n.name === 'App').id
    manager.nodeUpdate(id, { properties: { version: 'not-a-node-id' } })

    const r = manager.templateUpdate('software-item', {
      fields: { ...softwareItem.fields, version: { type: 'reference' } },
    })
    expect(r.ok).toBe(false)
  })
})

describe('nodeDelete — reference guard', () => {
  it('blocks deleting a node referenced by a surviving typed property', async () => {
    await openWith(makeManifest())
    manager.templateCreate('controlled-asset', controllerLink)
    const target = manager.nodeCreate('root-id', 'Power Supply')
    const targetId = (target as any).data.nodes.find((n: any) => n.name === 'Power Supply').id
    const created = manager.nodeCreate('root-id', 'Chamber', 'controlled-asset')
    const chamberId = (created as any).data.nodes.find((n: any) => n.name === 'Chamber').id
    manager.nodeUpdate(chamberId, { properties: { controller: targetId } })

    const r = manager.nodeDelete(targetId)
    expect(r.ok).toBe(false)
  })

  it('allows deleting an entire subtree that contains both reference and target', async () => {
    await openWith(makeManifest())
    manager.templateCreate('controlled-asset', controllerLink)
    const rack = manager.nodeCreate('root-id', 'Rack')
    const rackId = (rack as any).data.nodes.find((n: any) => n.name === 'Rack').id
    const target = manager.nodeCreate(rackId, 'Power Supply')
    const targetId = (target as any).data.nodes.find((n: any) => n.name === 'Power Supply').id
    const chamber = manager.nodeCreate(rackId, 'Chamber', 'controlled-asset')
    const chamberId = (chamber as any).data.nodes.find((n: any) => n.name === 'Chamber').id
    manager.nodeUpdate(chamberId, { properties: { controller: targetId } })

    const r = manager.nodeDelete(rackId)
    expect(r.ok).toBe(true)
  })
})

describe('templateDelete — non-destructive unbind', () => {
  it('removes the template, unbinds nodes, and keeps their values', async () => {
    await openWith(makeManifest())
    manager.templateCreate('software-item', softwareItem)
    const created = manager.nodeCreate('root-id', 'App', 'software-item')
    const id = (created as any).data.nodes.find((n: any) => n.name === 'App').id
    manager.nodeUpdate(id, { properties: { version: 'v2.3.1' } })

    const r = manager.templateDelete('software-item')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.templates?.['software-item']).toBeUndefined()
    const node = r.data.nodes.find(n => n.id === id)!
    expect(node.templateId).toBeNull()
    expect(node.properties.version).toBe('v2.3.1')   // value preserved
  })
})

describe('load warnings — no silent coercion or downgrade', () => {
  it('surfaces a path-qualified warning for an invalid typed value', async () => {
    const manifest = makeManifest({
      version: 3,
      templates: { 'software-item': softwareItem },
      nodes: [
        {
          id: 'root-id', parentId: null, name: 'Test Project', order: 0, properties: {},
          created: '2026-01-01T00:00:00.000Z', modified: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 'n1', parentId: 'root-id', name: 'App', order: 0,
          templateId: 'software-item',
          properties: { status: 'bogus' },          // invalid enum value
          created: '2026-01-01T00:00:00.000Z', modified: '2026-01-01T00:00:00.000Z',
        },
      ],
    })
    const project = await openWith(manifest)
    expect(project.loadWarnings).toBeDefined()
    const w = project.loadWarnings!.find(x => x.path === 'nodes[1].properties.status')
    expect(w).toBeDefined()
    expect(w!.code).toBe('INVALID_TYPED_VALUE')
    // The value on disk is left exactly as written (not coerced/dropped).
    expect(project.nodes.find(n => n.id === 'n1')!.properties.status).toBe('bogus')
  })

  it('surfaces a warning for a dangling templateId', async () => {
    const manifest = makeManifest({
      version: 3,
      templates: {},
      nodes: [
        {
          id: 'root-id', parentId: null, name: 'Test Project', order: 0, properties: {},
          created: '2026-01-01T00:00:00.000Z', modified: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 'n1', parentId: 'root-id', name: 'App', order: 0,
          templateId: 'ghost-template', properties: {},
          created: '2026-01-01T00:00:00.000Z', modified: '2026-01-01T00:00:00.000Z',
        },
      ],
    })
    const project = await openWith(manifest)
    const w = project.loadWarnings!.find(x => x.path === 'nodes[1].templateId')
    expect(w).toBeDefined()
    expect(w!.code).toBe('TEMPLATE_NOT_FOUND')
  })

  it('surfaces a warning for a dangling reference property', async () => {
    const manifest = makeManifest({
      version: 3,
      templates: { 'controlled-asset': controllerLink },
      nodes: [
        {
          id: 'root-id', parentId: null, name: 'Test Project', order: 0, properties: {},
          created: '2026-01-01T00:00:00.000Z', modified: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 'n1', parentId: 'root-id', name: 'Chamber', order: 0,
          templateId: 'controlled-asset',
          properties: { controller: 'missing-node' },
          created: '2026-01-01T00:00:00.000Z', modified: '2026-01-01T00:00:00.000Z',
        },
      ],
    })
    const project = await openWith(manifest)
    const w = project.loadWarnings!.find(x => x.path === 'nodes[1].properties.controller')
    expect(w).toBeDefined()
    expect(w!.code).toBe('INVALID_REFERENCE')
  })

  it('has no warnings for a clean project', async () => {
    const project = await openWith(makeManifest({ version: 3, templates: {} }))
    expect(project.loadWarnings).toBeUndefined()
  })

  it('warns when a bound node is missing a required field', async () => {
    const requiredTpl: NodeTemplate = {
      label: 'Asset',
      fields: { serial: { type: 'string', required: true } },
    }
    const manifest = makeManifest({
      version: 3,
      templates: { asset: requiredTpl },
      nodes: [
        {
          id: 'root-id', parentId: null, name: 'Test Project', order: 0, properties: {},
          created: '2026-01-01T00:00:00.000Z', modified: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 'n1', parentId: 'root-id', name: 'Pump', order: 0,
          templateId: 'asset', properties: {},   // missing required 'serial'
          created: '2026-01-01T00:00:00.000Z', modified: '2026-01-01T00:00:00.000Z',
        },
      ],
    })
    const project = await openWith(manifest)
    const w = project.loadWarnings?.find(x => x.path === 'nodes[1].properties.serial')
    expect(w).toBeDefined()
    expect(w!.code).toBe('MISSING_REQUIRED')
  })

  it('opens (non-fatally, with a warning) when a node references a structurally-invalid template', async () => {
    const manifest = makeManifest({
      version: 3,
      // `bad` has no `fields` — structurally invalid. A node references it,
      // which previously threw on Object.entries(template.fields).
      templates: { bad: { label: 'Bad' } },
      nodes: [
        {
          id: 'root-id', parentId: null, name: 'Test Project', order: 0, properties: {},
          created: '2026-01-01T00:00:00.000Z', modified: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 'n1', parentId: 'root-id', name: 'App', order: 0,
          templateId: 'bad', properties: { anything: 'x' },
          created: '2026-01-01T00:00:00.000Z', modified: '2026-01-01T00:00:00.000Z',
        },
      ],
    })
    const project = await openWith(manifest)  // must not throw
    expect(project.loadWarnings?.some(w => w.path === 'templates.bad')).toBe(true)
  })
})

describe('nodeUpdate — template binding validates existing properties', () => {
  it('rejects binding a template when an existing ad-hoc value is invalid for it', async () => {
    await openWith(makeManifest())
    manager.templateCreate('software-item', softwareItem)
    const created = manager.nodeCreate('root-id', 'App')           // freeform
    const id = (created as any).data.nodes.find((n: any) => n.name === 'App').id
    manager.nodeUpdate(id, { properties: { status: 'bogus' } })    // ad-hoc, lenient

    // Binding the template (selector sends only { templateId }) must validate
    // the existing 'status' against the enum field — 'bogus' is not allowed.
    const r = manager.nodeUpdate(id, { templateId: 'software-item' })
    expect(r.ok).toBe(false)
  })

  it('binds and coerces existing values that fit the template', async () => {
    await openWith(makeManifest())
    manager.templateCreate('software-item', softwareItem)
    const created = manager.nodeCreate('root-id', 'App')
    const id = (created as any).data.nodes.find((n: any) => n.name === 'App').id
    manager.nodeUpdate(id, { properties: { status: 'approved', units: '5' } })  // ad-hoc strings

    const r = manager.nodeUpdate(id, { templateId: 'software-item' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const node = r.data.nodes.find(n => n.id === id)!
    expect(node.templateId).toBe('software-item')
    expect(node.properties.status).toBe('approved')
    expect(node.properties.units).toBe(5)   // coerced string → number on bind
  })
})
