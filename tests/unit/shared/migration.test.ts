import { describe, it, expect } from 'vitest'
import { migrate, getCurrentVersion, SchemaVersionError } from '@shared/migration'

const CURRENT = getCurrentVersion()

// ─── Happy path ───────────────────────────────────────────────────────────────

describe('migrate — happy path', () => {
  it('returns the manifest unchanged when already at current version', () => {
    const manifest = { version: CURRENT, id: 'x', name: 'Test', nodes: [] }
    const result = migrate(manifest)
    expect(result.version).toBe(CURRENT)
    expect(result.id).toBe('x')
  })

  it('preserves unknown fields through migration', () => {
    const manifest = {
      version: CURRENT,
      id: 'x',
      name: 'Test',
      nodes: [],
      unknownFutureProp: 'preserve-me',
    }
    const result = migrate(manifest)
    expect(result.unknownFutureProp).toBe('preserve-me')
  })
})

// ─── Error cases ──────────────────────────────────────────────────────────────

describe('migrate — error cases', () => {
  it('throws SchemaVersionError when version field is missing', () => {
    const bad = { id: 'x', name: 'Test', nodes: [] }
    expect(() => migrate(bad)).toThrow(SchemaVersionError)
  })

  it('throws SchemaVersionError when version is not a number', () => {
    const bad = { version: 'one', id: 'x', name: 'Test', nodes: [] }
    expect(() => migrate(bad)).toThrow(SchemaVersionError)
  })

  it('throws an Error when version is newer than current', () => {
    const future = { version: CURRENT + 1, id: 'x', name: 'Test', nodes: [] }
    expect(() => migrate(future)).toThrow(/newer than this app supports/)
  })
})

// ─── getCurrentVersion ────────────────────────────────────────────────────────

describe('getCurrentVersion', () => {
  it('returns a positive integer', () => {
    expect(Number.isInteger(CURRENT)).toBe(true)
    expect(CURRENT).toBeGreaterThan(0)
  })
})
