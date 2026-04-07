// Shared validation functions used by both renderer (UI feedback)
// and main process (security enforcement).
// Never duplicate these regexes. Import from here.

export interface ValidationResult {
  valid: boolean
  message?: string
}

// /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/
// Must start with alphanumeric. Letters, numbers, hyphens, underscores, dots. Max 64 chars.
const SNAPSHOT_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/

// Alphanumeric + underscores only. Max 64 chars.
const PROPERTY_KEY_RE = /^[a-zA-Z0-9_]+$/

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

export function validatePropertyValue(value: unknown): ValidationResult {
  if (typeof value === 'string' && value.length > 10_000) {
    return { valid: false, message: 'Value too long (max 10,000 characters)' }
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return { valid: false, message: 'Invalid number value' }
  }
  return { valid: true }
}
