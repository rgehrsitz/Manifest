// Shared validation functions used by both renderer (UI feedback)
// and main process (security enforcement).
// Never duplicate these regexes. Import from here.

import type { ManifestNode, PropertyType, TemplateField, NodeTemplate } from './types'

export interface ValidationResult {
  valid: boolean
  message?: string
}

// /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/
// Must start with alphanumeric. Letters, numbers, hyphens, underscores, dots. Max 64 chars.
const SNAPSHOT_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/

// Alphanumeric + underscores only. Max 64 chars.
const PROPERTY_KEY_RE = /^[a-zA-Z0-9_]+$/

// Lowercase alphanumeric + hyphens. Must start alphanumeric. Max 64 chars.
// Used for template ids (slugs): human-readable and stable in manifest.json.
const TEMPLATE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

// Date values: strict calendar date YYYY-MM-DD.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const MAX_STRING_LEN = 10_000
const MAX_VERSION_LEN = 64

// True when a string contains any C0 control character (0x00–0x1F) or DEL
// (0x7F). Implemented via char codes to avoid embedding control literals in
// source. Used to reject control characters in version values (free-form
// string values are intentionally NOT restricted — they may hold multi-line text).
function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

const PROPERTY_TYPES: readonly PropertyType[] = [
  'string',
  'number',
  'boolean',
  'date',
  'version',
  'enum',
  'reference',
]

export function validateSnapshotName(name: string): ValidationResult {
  if (!name || name.trim().length === 0) {
    return { valid: false, message: 'Snapshot name cannot be empty' }
  }
  if (!SNAPSHOT_NAME_RE.test(name)) {
    return {
      valid: false,
      message: 'Snapshot names: letters, numbers, hyphens, underscores, dots. Max 64 chars.',
    }
  }
  return { valid: true }
}

export function validateNodeName(name: string): ValidationResult {
  if (!name || name.trim().length === 0) {
    return { valid: false, message: 'Node name cannot be empty' }
  }
  if (name.length > 255) {
    return { valid: false, message: 'Node names cannot exceed 255 characters' }
  }
  if (name.includes('/') || name.includes('\\')) {
    return { valid: false, message: 'Node names cannot contain slashes' }
  }
  return { valid: true }
}

export function validatePropertyKey(key: string): ValidationResult {
  if (!key || key.trim().length === 0) {
    return { valid: false, message: 'Property name cannot be empty' }
  }
  if (key.length > 64) {
    return { valid: false, message: 'Property names cannot exceed 64 characters' }
  }
  if (!PROPERTY_KEY_RE.test(key)) {
    return { valid: false, message: 'Property names: letters, numbers, underscores only' }
  }
  return { valid: true }
}

// Lenient validation for ad-hoc (untyped / non-template) property values.
export function validatePropertyValue(value: unknown): ValidationResult {
  if (typeof value === 'string' && value.length > MAX_STRING_LEN) {
    return { valid: false, message: 'Value too long (max 10,000 characters)' }
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return { valid: false, message: 'Invalid number value' }
  }
  return { valid: true }
}

// ─── Templates & typed property values ─────────────────────────────────────────

// Null-safe accessor for a template's `fields` map. Returns {} when the
// template or its fields are structurally invalid. Use this in every post-load
// consumer (renderer + main) so a hand-edited manifest with a malformed
// template — which loads non-fatally with a warning — can never throw
// `Object.entries(undefined)` downstream.
export function templateFields(
  template: NodeTemplate | null | undefined,
): Record<string, TemplateField> {
  if (
    !template ||
    typeof template.fields !== 'object' ||
    template.fields === null ||
    Array.isArray(template.fields)
  ) {
    return {}
  }
  return template.fields
}

// Structurally usable for binding/listing in pickers (valid label + fields +
// field defs). Built on validateTemplate so the definition of "usable" stays
// in one place. null/undefined → false.
export function isUsableTemplate(template: NodeTemplate | null | undefined): boolean {
  return validateTemplate(template as NodeTemplate).valid
}

// Safe display label for a (possibly malformed, hand-edited) template. Falls
// back to the id when the label is missing or not a non-empty string, so
// renderer code never dereferences `.label` on a null/garbage template.
export function templateLabel(
  template: NodeTemplate | null | undefined,
  fallbackId: string,
): string {
  return template && typeof template.label === 'string' && template.label.trim().length > 0
    ? template.label
    : fallbackId
}

export function validateTemplateId(id: string): ValidationResult {
  if (!id || id.trim().length === 0) {
    return { valid: false, message: 'Template id cannot be empty' }
  }
  if (!TEMPLATE_ID_RE.test(id)) {
    return {
      valid: false,
      message: 'Template ids: lowercase letters, numbers, hyphens; start alphanumeric. Max 64 chars.',
    }
  }
  return { valid: true }
}

function isPropertyType(t: unknown): t is PropertyType {
  return typeof t === 'string' && (PROPERTY_TYPES as readonly string[]).includes(t)
}

// Validate a single field definition (used by validateTemplate). `key` is the
// property key the field is stored under — it must be a valid property key.
export function validateTemplateField(key: string, field: TemplateField): ValidationResult {
  const keyCheck = validatePropertyKey(key)
  if (!keyCheck.valid) return keyCheck

  if (!field || typeof field !== 'object') {
    return { valid: false, message: `Field "${key}" must be an object` }
  }
  if (!isPropertyType(field.type)) {
    return { valid: false, message: `Field "${key}" has unknown type "${String(field.type)}"` }
  }
  if (field.type === 'enum') {
    if (!Array.isArray(field.options) || field.options.length === 0) {
      return { valid: false, message: `Enum field "${key}" must define at least one option` }
    }
    for (const opt of field.options) {
      if (typeof opt !== 'string' || opt.length === 0) {
        return { valid: false, message: `Enum field "${key}" options must be non-empty strings` }
      }
    }
  }
  // A declared default must itself be valid for the field's type.
  if (field.default !== undefined && field.default !== null) {
    const defCheck = validateTypedPropertyValue(field.default, field)
    if (!defCheck.valid) {
      return { valid: false, message: `Field "${key}" default is invalid: ${defCheck.message}` }
    }
  }
  return { valid: true }
}

export function validateTemplate(template: NodeTemplate): ValidationResult {
  if (!template || typeof template !== 'object' || Array.isArray(template)) {
    return { valid: false, message: 'Template must be an object' }
  }
  // Guard against hand-edited manifests: label may be a non-string (e.g. 123).
  if (typeof template.label !== 'string' || template.label.trim().length === 0) {
    return { valid: false, message: 'Template label must be a non-empty string' }
  }
  if (template.label.length > 255) {
    return { valid: false, message: 'Template label cannot exceed 255 characters' }
  }
  // typeof [] === 'object', so reject arrays explicitly — otherwise Object.entries
  // would interpret a fields array as numeric-keyed fields.
  if (!template.fields || typeof template.fields !== 'object' || Array.isArray(template.fields)) {
    return { valid: false, message: 'Template fields must be an object' }
  }
  for (const [key, field] of Object.entries(template.fields)) {
    const fieldCheck = validateTemplateField(key, field)
    if (!fieldCheck.valid) return fieldCheck
  }
  return { valid: true }
}

// Validate a property VALUE against its template field type. Strict: this is the
// gate for typed input. It does NOT coerce — see coercePropertyValue for that.
export function validateTypedPropertyValue(
  value: unknown,
  field: TemplateField,
): ValidationResult {
  switch (field.type) {
    case 'string':
      if (typeof value !== 'string') return { valid: false, message: 'Expected a string' }
      if (value.length > MAX_STRING_LEN) {
        return { valid: false, message: 'Value too long (max 10,000 characters)' }
      }
      return { valid: true }

    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return { valid: false, message: 'Expected a finite number' }
      }
      return { valid: true }

    case 'boolean':
      if (typeof value !== 'boolean') return { valid: false, message: 'Expected true or false' }
      return { valid: true }

    case 'date':
      if (typeof value !== 'string' || !DATE_RE.test(value) || !isRealDate(value)) {
        return { valid: false, message: 'Expected a calendar date (YYYY-MM-DD)' }
      }
      return { valid: true }

    case 'version':
      // Deliberately permissive: real-world firmware/vendor versions include
      // "v" prefixes, letters, build labels, odd revision schemes. We only
      // require a non-empty, reasonably short, control-char-free string.
      if (typeof value !== 'string') return { valid: false, message: 'Expected a version string' }
      if (value.trim().length === 0) return { valid: false, message: 'Version cannot be empty' }
      if (value.length > MAX_VERSION_LEN) {
        return { valid: false, message: `Version too long (max ${MAX_VERSION_LEN} characters)` }
      }
      if (hasControlChar(value)) {
        return { valid: false, message: 'Version cannot contain control characters' }
      }
      return { valid: true }

    case 'enum':
      if (typeof value !== 'string') {
        return { valid: false, message: 'Expected one of the allowed options' }
      }
      if (!field.options || !field.options.includes(value)) {
        return {
          valid: false,
          message: `Value must be one of: ${(field.options ?? []).join(', ')}`,
        }
      }
      return { valid: true }

    case 'reference':
      if (typeof value !== 'string') return { valid: false, message: 'Expected a node reference' }
      if (value.trim().length === 0) {
        return { valid: false, message: 'Reference cannot be empty' }
      }
      return { valid: true }

    default:
      return { valid: false, message: 'Unknown field type' }
  }
}

export function validateReferenceTarget(value: unknown, nodes: ManifestNode[]): ValidationResult {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return { valid: false, message: 'Expected a node reference' }
  }
  if (!nodes.some(n => n.id === value)) {
    return { valid: false, message: `Reference target not found: ${value}` }
  }
  return { valid: true }
}

export interface CoercionResult {
  valid: boolean
  message?: string
  // Present only when valid: the coerced, typed primitive to store.
  value?: string | number | boolean | null
}

// Coerce raw UI/IPC input into the typed primitive for a field, then validate.
// INPUT-PATH ONLY — never call this on file load (we do not silently rewrite
// hand-edited manifest values). Returns an error instead of throwing.
export function coercePropertyValue(raw: unknown, field: TemplateField): CoercionResult {
  switch (field.type) {
    case 'string':
    case 'version':
    case 'enum':
    case 'reference': {
      // Accept primitives only (string/number/boolean). Rejecting objects/arrays
      // here prevents untrusted IPC payloads from being stringified into garbage
      // like "[object Object]" and persisted.
      if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') {
        return { valid: false, message: 'Expected a text value' }
      }
      const value = String(raw)
      const check = validateTypedPropertyValue(value, field)
      return check.valid ? { valid: true, value } : { valid: false, message: check.message }
    }

    case 'number': {
      let n: number
      if (typeof raw === 'number') n = raw
      else if (typeof raw === 'string') {
        const trimmed = raw.trim()
        if (trimmed.length === 0) return { valid: false, message: 'Expected a number' }
        n = Number(trimmed)
      } else {
        return { valid: false, message: 'Expected a number' }
      }
      if (!Number.isFinite(n)) return { valid: false, message: 'Expected a finite number' }
      return { valid: true, value: n }
    }

    case 'boolean': {
      if (typeof raw === 'boolean') return { valid: true, value: raw }
      if (typeof raw === 'string') {
        const t = raw.trim().toLowerCase()
        if (t === 'true') return { valid: true, value: true }
        if (t === 'false') return { valid: true, value: false }
      }
      return { valid: false, message: 'Expected true or false' }
    }

    case 'date': {
      const value = typeof raw === 'string' ? raw.trim() : String(raw ?? '')
      const check = validateTypedPropertyValue(value, field)
      return check.valid ? { valid: true, value } : { valid: false, message: check.message }
    }

    default:
      return { valid: false, message: 'Unknown field type' }
  }
}

// True when a YYYY-MM-DD string is a real calendar date (rejects 2026-02-30).
function isRealDate(value: string): boolean {
  const [y, m, d] = value.split('-').map(Number)
  if (m < 1 || m > 12 || d < 1 || d > 31) return false
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}
