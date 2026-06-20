import { describe, it, expect } from 'vitest'
import {
  validateTemplateId,
  validateTemplate,
  validateTemplateField,
  validateTypedPropertyValue,
  validateReferenceTarget,
  coercePropertyValue,
  templateFields,
  isUsableTemplate,
  templateLabel,
} from '../../../src/shared/validation'
import type { NodeTemplate, TemplateField } from '../../../src/shared/types'

const NUL = String.fromCharCode(0)

describe('validateTemplateId', () => {
  it('accepts lowercase slugs', () => {
    expect(validateTemplateId('software-item').valid).toBe(true)
    expect(validateTemplateId('rack').valid).toBe(true)
    expect(validateTemplateId('a1').valid).toBe(true)
  })
  it('rejects empty, uppercase, leading-hyphen, and spaces', () => {
    expect(validateTemplateId('').valid).toBe(false)
    expect(validateTemplateId('Rack').valid).toBe(false)
    expect(validateTemplateId('-rack').valid).toBe(false)
    expect(validateTemplateId('soft ware').valid).toBe(false)
  })
})

describe('validateTemplateField', () => {
  it('requires enum fields to declare options', () => {
    expect(validateTemplateField('status', { type: 'enum' }).valid).toBe(false)
    expect(
      validateTemplateField('status', { type: 'enum', options: ['a', 'b'] }).valid
    ).toBe(true)
  })
  it('rejects unknown types', () => {
    expect(validateTemplateField('x', { type: 'whatever' as any }).valid).toBe(false)
  })
  it('rejects a default that is invalid for the type', () => {
    expect(validateTemplateField('n', { type: 'number', default: 'nope' as any }).valid).toBe(false)
    expect(validateTemplateField('n', { type: 'number', default: 5 }).valid).toBe(true)
  })
  it('rejects invalid property keys', () => {
    expect(validateTemplateField('bad key', { type: 'string' }).valid).toBe(false)
  })
})

describe('validateTemplate', () => {
  const good: NodeTemplate = {
    label: 'Software Item',
    fields: {
      version: { type: 'version' },
      installed_date: { type: 'date' },
      status: { type: 'enum', options: ['approved', 'testing', 'retired'] },
    },
  }
  it('accepts a well-formed template', () => {
    expect(validateTemplate(good).valid).toBe(true)
  })
  it('rejects an empty label', () => {
    expect(validateTemplate({ ...good, label: '' }).valid).toBe(false)
  })
  it('rejects a non-string label without throwing (hand-edited manifests)', () => {
    expect(validateTemplate({ ...good, label: 123 as any }).valid).toBe(false)
  })
  it('rejects array fields (typeof [] === "object")', () => {
    expect(validateTemplate({ label: 'X', fields: [] as any }).valid).toBe(false)
  })
  it('rejects when a field is malformed', () => {
    expect(validateTemplate({ label: 'X', fields: { s: { type: 'enum' } } }).valid).toBe(false)
  })
})

describe('validateTypedPropertyValue — version', () => {
  const version: TemplateField = { type: 'version' }
  it('accepts real-world firmware/vendor strings', () => {
    for (const v of ['v2.1.0', '2.3.1', '1.0', 'R2024b', 'A.17-rc3', 'build-2025.06']) {
      expect(validateTypedPropertyValue(v, version).valid).toBe(true)
    }
  })
  it('rejects empty and control characters', () => {
    expect(validateTypedPropertyValue('', version).valid).toBe(false)
    expect(validateTypedPropertyValue('2.1' + NUL, version).valid).toBe(false)
    expect(validateTypedPropertyValue('a\tb', version).valid).toBe(false)
  })
})

describe('validateTypedPropertyValue — other types', () => {
  it('date requires a real calendar date', () => {
    const date: TemplateField = { type: 'date' }
    expect(validateTypedPropertyValue('2026-06-14', date).valid).toBe(true)
    expect(validateTypedPropertyValue('2026-13-01', date).valid).toBe(false)
    expect(validateTypedPropertyValue('2026-02-30', date).valid).toBe(false)
    expect(validateTypedPropertyValue('06/14/2026', date).valid).toBe(false)
  })
  it('number must be a finite number (not a numeric string)', () => {
    const num: TemplateField = { type: 'number' }
    expect(validateTypedPropertyValue(42, num).valid).toBe(true)
    expect(validateTypedPropertyValue('42', num).valid).toBe(false)
    expect(validateTypedPropertyValue(Infinity, num).valid).toBe(false)
  })
  it('boolean must be a boolean', () => {
    const bool: TemplateField = { type: 'boolean' }
    expect(validateTypedPropertyValue(true, bool).valid).toBe(true)
    expect(validateTypedPropertyValue('true', bool).valid).toBe(false)
  })
  it('enum must be one of the declared options', () => {
    const e: TemplateField = { type: 'enum', options: ['approved', 'testing'] }
    expect(validateTypedPropertyValue('approved', e).valid).toBe(true)
    expect(validateTypedPropertyValue('nope', e).valid).toBe(false)
  })
  it('reference must be a non-empty node id string', () => {
    const ref: TemplateField = { type: 'reference' }
    expect(validateTypedPropertyValue('node-1', ref).valid).toBe(true)
    expect(validateTypedPropertyValue('', ref).valid).toBe(false)
    expect(validateTypedPropertyValue(123, ref).valid).toBe(false)
  })
})

describe('validateReferenceTarget', () => {
  const nodes = [
    { id: 'root', parentId: null, name: 'Lab', order: 0, properties: {}, created: '', modified: '' },
    { id: 'target', parentId: 'root', name: 'Target', order: 0, properties: {}, created: '', modified: '' },
  ]

  it('requires the referenced node to exist', () => {
    expect(validateReferenceTarget('target', nodes).valid).toBe(true)
    expect(validateReferenceTarget('missing', nodes).valid).toBe(false)
  })

  it('rejects self-references when a current node id is provided', () => {
    expect(validateReferenceTarget('target', nodes, 'target').valid).toBe(false)
  })
})

describe('templateFields (null-safe accessor)', () => {
  it('returns the fields map for a valid template', () => {
    const t: NodeTemplate = { label: 'X', fields: { a: { type: 'string' } } }
    expect(templateFields(t)).toEqual({ a: { type: 'string' } })
  })
  it('returns {} for null/undefined or structurally-invalid templates', () => {
    expect(templateFields(null)).toEqual({})
    expect(templateFields(undefined)).toEqual({})
    expect(templateFields({ label: 'Bad' } as any)).toEqual({})       // missing fields
    expect(templateFields({ label: 'Bad', fields: [] } as any)).toEqual({})  // array fields
  })
})

describe('isUsableTemplate / templateLabel (safe renderer accessors)', () => {
  it('isUsableTemplate accepts valid and rejects malformed templates', () => {
    expect(isUsableTemplate({ label: 'Rack', fields: { a: { type: 'string' } } })).toBe(true)
    expect(isUsableTemplate(null)).toBe(false)
    expect(isUsableTemplate({ label: 'Bad' } as any)).toBe(false)         // no fields
    expect(isUsableTemplate({ label: 123, fields: {} } as any)).toBe(false) // non-string label
  })
  it('templateLabel returns the label or falls back to the id', () => {
    expect(templateLabel({ label: 'Rack', fields: {} }, 'rack')).toBe('Rack')
    expect(templateLabel(null, 'rack')).toBe('rack')
    expect(templateLabel({ label: 123 } as any, 'rack')).toBe('rack')
    expect(templateLabel({ label: '   ' } as any, 'rack')).toBe('rack')
  })
})

describe('coercePropertyValue', () => {
  it('coerces numeric strings to numbers', () => {
    const r = coercePropertyValue('5', { type: 'number' })
    expect(r.valid).toBe(true)
    expect(r.value).toBe(5)
  })
  it('rejects non-numeric strings for number fields', () => {
    expect(coercePropertyValue('abc', { type: 'number' }).valid).toBe(false)
  })
  it('coerces boolean strings', () => {
    expect(coercePropertyValue('true', { type: 'boolean' }).value).toBe(true)
    expect(coercePropertyValue('false', { type: 'boolean' }).value).toBe(false)
    expect(coercePropertyValue('yes', { type: 'boolean' }).valid).toBe(false)
  })
  it('passes through valid version/enum and trims dates', () => {
    expect(coercePropertyValue('v2.1.0', { type: 'version' }).value).toBe('v2.1.0')
    expect(coercePropertyValue(' 2026-06-14 ', { type: 'date' }).value).toBe('2026-06-14')
    expect(coercePropertyValue('node-1', { type: 'reference' }).value).toBe('node-1')
    const e = coercePropertyValue('bad', { type: 'enum', options: ['ok'] })
    expect(e.valid).toBe(false)
  })
  it('rejects non-primitive (object/array) input instead of stringifying it', () => {
    expect(coercePropertyValue({}, { type: 'string' }).valid).toBe(false)
    expect(coercePropertyValue({}, { type: 'version' }).valid).toBe(false)
    expect(coercePropertyValue(['a'], { type: 'enum', options: ['a'] }).valid).toBe(false)
  })
  it('still coerces primitive number/boolean into string-typed fields', () => {
    expect(coercePropertyValue(5, { type: 'string' }).value).toBe('5')
  })
})
