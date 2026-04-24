// All error codes in SCREAMING_SNAKE format.
// Import and use these constants — never use raw strings as error codes.

import type { Result, AppError } from './types'

export const ErrorCode = {
  GIT_CORRUPT:           'GIT_CORRUPT',
  GIT_COMMIT_FAILED:     'GIT_COMMIT_FAILED',
  SNAPSHOT_READ_FAILED:  'SNAPSHOT_READ_FAILED',
  GIT_NOT_FOUND:         'GIT_NOT_FOUND',
  DIFF_TIMEOUT:          'DIFF_TIMEOUT',
  INVALID_HIERARCHY:     'INVALID_HIERARCHY',
  DUPLICATE_ID:          'DUPLICATE_ID',
  SQLITE_CAPABILITY:     'SQLITE_CAPABILITY',
  PDF_GENERATION:        'PDF_GENERATION',
  VALIDATION_FAILED:     'VALIDATION_FAILED',
  PROJECT_NOT_FOUND:     'PROJECT_NOT_FOUND',
  SCHEMA_VERSION:        'SCHEMA_VERSION',
  FILE_TOO_LARGE:        'FILE_TOO_LARGE',
  AUTOSAVE_WRITE_FAILED: 'AUTOSAVE_WRITE_FAILED',
  NOT_IMPLEMENTED:       'NOT_IMPLEMENTED',
} as const

export type ErrorCode = typeof ErrorCode[keyof typeof ErrorCode]

export function ok<T>(data: T): Result<T> {
  return { ok: true, data }
}

export function err(
  code: ErrorCode,
  message: string,
  context?: Record<string, unknown>
): Result<never> {
  const error: AppError = { code, message, ...(context ? { context } : {}) }
  return { ok: false, error }
}
