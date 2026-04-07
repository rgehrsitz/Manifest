import { describe, it, expect } from 'vitest'
import {
  validateSnapshotName,
  validateNodeName,
  validatePropertyKey,
  validatePropertyValue,
} from '@shared/validation'

// ─── validateSnapshotName ─────────────────────────────────────────────────────

describe('validateSnapshotName', () => {
  it('accepts valid names', () => {
    expect(validateSnapshotName('baseline').valid).toBe(true)
    expect(validateSnapshotName('v1.0.0').valid).toBe(true)
    expect(validateSnapshotName('my-snapshot').valid).toBe(true)
    expect(validateSnapshotName('test_run_2').valid).toBe(true)
    expect(validateSnapshotName('a').valid).toBe(true)
  })

  it('rejects empty string', () => {
    expect(validateSnapshotName('').valid).toBe(false)
    expect(validateSnapshotName('   ').valid).toBe(false)
  })

  it('rejects names that start with non-alphanumeric', () => {
    expect(validateSnapshotName('-bad').valid).toBe(false)
    expect(validateSnapshotName('.bad').valid).toBe(false)
    expect(validateSnapshotName('_bad').valid).toBe(false)
  })

  it('rejects names with invalid characters', () => {
    expect(validateSnapshotName('has space').valid).toBe(false)
    expect(validateSnapshotName('has/slash').valid).toBe(false)
    expect(validateSnapshotName('has@symbol').valid).toBe(false)
    expect(validateSnapshotName('unicode-ñ').valid).toBe(false)
  })

  it('rejects names over 64 characters', () => {
    const long = 'a' + 'x'.repeat(64)  // 65 chars
    expect(validateSnapshotName(long).valid).toBe(false)
  })

  it('accepts names exactly 64 characters', () => {
    const exact = 'a' + 'x'.repeat(63)  // 64 chars
    expect(validateSnapshotName(exact).valid).toBe(true)
  })

  it('includes a message on failure', () => {
    const result = validateSnapshotName('')
    expect(result.valid).toBe(false)
    expect(result.message).toBeTruthy()
  })
})

// ─── validateNodeName ─────────────────────────────────────────────────────────

describe('validateNodeName', () => {
  it('accepts normal names', () => {
    expect(validateNodeName('Rack A').valid).toBe(true)
    expect(validateNodeName('Server 1').valid).toBe(true)
    expect(validateNodeName('My Equipment').valid).toBe(true)
  })

  it('rejects empty or whitespace-only names', () => {
    expect(validateNodeName('').valid).toBe(false)
    expect(validateNodeName('   ').valid).toBe(false)
  })

  it('rejects names with forward slashes', () => {
    expect(validateNodeName('a/b').valid).toBe(false)
  })

  it('rejects names with backslashes', () => {
    expect(validateNodeName('a\\b').valid).toBe(false)
  })

  it('rejects names over 255 characters', () => {
    const long = 'x'.repeat(256)
    expect(validateNodeName(long).valid).toBe(false)
  })

  it('accepts names exactly 255 characters', () => {
    const exact = 'x'.repeat(255)
    expect(validateNodeName(exact).valid).toBe(true)
  })
})

// ─── validatePropertyKey ──────────────────────────────────────────────────────

describe('validatePropertyKey', () => {
  it('accepts valid keys', () => {
    expect(validatePropertyKey('serial_number').valid).toBe(true)
    expect(validatePropertyKey('firmware').valid).toBe(true)
    expect(validatePropertyKey('version2').valid).toBe(true)
    expect(validatePropertyKey('A').valid).toBe(true)
  })

  it('rejects empty keys', () => {
    expect(validatePropertyKey('').valid).toBe(false)
    expect(validatePropertyKey('   ').valid).toBe(false)
  })

  it('rejects keys with spaces or hyphens', () => {
    expect(validatePropertyKey('serial number').valid).toBe(false)
    expect(validatePropertyKey('serial-number').valid).toBe(false)
  })

  it('rejects keys over 64 characters', () => {
    const long = 'x'.repeat(65)
    expect(validatePropertyKey(long).valid).toBe(false)
  })
})

// ─── validatePropertyValue ────────────────────────────────────────────────────

describe('validatePropertyValue', () => {
  it('accepts valid types', () => {
    expect(validatePropertyValue('hello').valid).toBe(true)
    expect(validatePropertyValue(42).valid).toBe(true)
    expect(validatePropertyValue(true).valid).toBe(true)
    expect(validatePropertyValue(null).valid).toBe(true)
    expect(validatePropertyValue('').valid).toBe(true)
  })

  it('rejects strings over 10,000 characters', () => {
    const long = 'x'.repeat(10_001)
    expect(validatePropertyValue(long).valid).toBe(false)
  })

  it('accepts strings exactly 10,000 characters', () => {
    const exact = 'x'.repeat(10_000)
    expect(validatePropertyValue(exact).valid).toBe(true)
  })

  it('rejects non-finite numbers', () => {
    expect(validatePropertyValue(Infinity).valid).toBe(false)
    expect(validatePropertyValue(-Infinity).valid).toBe(false)
    expect(validatePropertyValue(NaN).valid).toBe(false)
  })
})
