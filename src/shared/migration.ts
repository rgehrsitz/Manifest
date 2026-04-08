// Schema migration pipeline: forward-only, lossless.
// Each migration is a pure function (input manifest → output manifest).
// Unknown fields are preserved through migrations.

import { v7 as uuidv7 } from 'uuid'

const CURRENT_VERSION = 2

// Key = target version. migrations[2] migrates v1 → v2.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const migrations: Record<number, (data: any) => any> = {
  // v1 → v2: introduce single persisted root node.
  //
  // v1 allowed multiple top-level nodes (parentId: null).
  // v2 requires exactly one root (parentId: null). Former top-level nodes
  // become children of a new root named after the project.
  //
  // Before:
  //   nodes: [
  //     { id: "A", parentId: null, name: "Rack A", order: 0, ... },
  //     { id: "B", parentId: null, name: "Rack B", order: 1, ... },
  //   ]
  //
  // After:
  //   nodes: [
  //     { id: "ROOT", parentId: null, name: "My Project", order: 0, ... },  ← new
  //     { id: "A", parentId: "ROOT", name: "Rack A", order: 0, ... },       ← reparented
  //     { id: "B", parentId: "ROOT", name: "Rack B", order: 1, ... },       ← reparented
  //   ]
  2: (data: any) => {
    const topLevel: any[] = (data.nodes ?? []).filter((n: any) => n.parentId === null)
    const rest: any[] = (data.nodes ?? []).filter((n: any) => n.parentId !== null)

    if (topLevel.length === 1) {
      // Already has a single root — no structural change needed, just bump version.
      data.version = 2
      return data
    }

    if (topLevel.length === 0) {
      // Empty nodes array — create a root node named after the project.
      const now = data.created ?? new Date().toISOString()
      data.nodes = [{
        id: uuidv7(),
        parentId: null,
        name: data.name ?? 'Project',
        order: 0,
        properties: {},
        created: now,
        modified: now,
      }]
      data.version = 2
      return data
    }

    // Create a synthetic root named after the project.
    const now = data.created ?? new Date().toISOString()
    const rootId = uuidv7()
    const root = {
      id: rootId,
      parentId: null,
      name: data.name ?? 'Project',
      order: 0,
      properties: {},
      created: now,
      modified: now,
    }

    // Re-parent former top-level nodes under root, preserving their order.
    const reparented = topLevel.map((n: any, i: number) => ({
      ...n,
      parentId: rootId,
      order: i,
    }))

    data.nodes = [root, ...reparented, ...rest]
    data.version = 2
    return data
  },
}

export class SchemaVersionError extends Error {
  constructor(
    public readonly fromVersion: number,
    public readonly toVersion: number
  ) {
    super(
      `Cannot migrate manifest from version ${fromVersion} to ${toVersion}: no migrator registered`
    )
    this.name = 'SchemaVersionError'
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function migrate(data: any): any {
  if (typeof data.version !== 'number') {
    throw new SchemaVersionError(0, CURRENT_VERSION)
  }
  if (data.version > CURRENT_VERSION) {
    throw new Error(
      `Manifest version ${data.version} is newer than this app supports (v${CURRENT_VERSION}). Please update Manifest.`
    )
  }
  while (data.version < CURRENT_VERSION) {
    const migrator = migrations[data.version + 1]
    if (!migrator) throw new SchemaVersionError(data.version, CURRENT_VERSION)
    data = migrator(data)
  }
  return data
}

export function getCurrentVersion(): number {
  return CURRENT_VERSION
}
