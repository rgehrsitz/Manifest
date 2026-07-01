import { existsSync, readFileSync, statSync } from 'fs'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'path'
import { err, ok, ErrorCode } from '../shared/errors'
import type { Result } from '../shared/types'
import { PROJECT_LAUNCHER_EXTENSION } from './project-launcher'

export function resolveProjectOpenTarget(targetPath: string): Result<string> {
  try {
    const stat = statSync(targetPath)

    if (stat.isDirectory()) {
      return validateProjectDirectory(targetPath)
    }

    if (!stat.isFile()) {
      return err(ErrorCode.PROJECT_NOT_FOUND, `Cannot open ${targetPath}: not a project file or folder`)
    }

    if (basename(targetPath) === 'manifest.json') {
      return validateProjectDirectory(dirname(targetPath))
    }

    if (extname(targetPath) === PROJECT_LAUNCHER_EXTENSION) {
      return resolveProjectLauncher(targetPath)
    }

    return err(
      ErrorCode.PROJECT_NOT_FOUND,
      `Cannot open ${targetPath}: expected a Manifest project folder, manifest.json, or .manifestproject file`
    )
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return err(ErrorCode.PROJECT_NOT_FOUND, `Cannot open ${targetPath}: ${msg}`)
  }
}

function validateProjectDirectory(projectPath: string): Result<string> {
  if (!existsSync(join(projectPath, 'manifest.json'))) {
    return err(ErrorCode.PROJECT_NOT_FOUND, `Cannot open ${projectPath}: manifest.json was not found`)
  }
  return ok(projectPath)
}

function resolveProjectLauncher(launcherPath: string): Result<string> {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(launcherPath, 'utf8'))
  } catch {
    return err(ErrorCode.VALIDATION_FAILED, 'Manifest project launcher is not valid JSON')
  }

  if (!raw || typeof raw !== 'object') {
    return err(ErrorCode.VALIDATION_FAILED, 'Manifest project launcher must be a JSON object')
  }

  const projectPath = (raw as { projectPath?: unknown }).projectPath
  if (typeof projectPath !== 'string' || projectPath.trim() === '') {
    return err(ErrorCode.VALIDATION_FAILED, 'Manifest project launcher must include a projectPath string')
  }

  const resolvedPath = isAbsolute(projectPath)
    ? projectPath
    : resolve(dirname(launcherPath), projectPath)

  return validateProjectDirectory(resolvedPath)
}
