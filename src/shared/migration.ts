// Schema migration pipeline: forward-only, lossless.
// Each migration is a pure function (input manifest → output manifest).
// Unknown fields are preserved through migrations.

const CURRENT_VERSION = 1

// Key = target version. migrations[2] migrates v1 → v2.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const migrations: Record<number, (data: any) => any> = {
  // Example future migration:
  // 2: (data) => {
  //   data.nodes.forEach((n: any) => { n.newField = null })
  //   data.version = 2
  //   return data
  // },
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
