import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { resolveProjectOpenTarget } from '../../../src/main/project-open-target'

let tmpDir: string

beforeEach(() => {
  tmpDir = join(tmpdir(), `manifest-open-target-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(tmpDir, { recursive: true })
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

function writeProject(name = 'Lab'): string {
  const projectDir = join(tmpDir, name)
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(join(projectDir, 'manifest.json'), '{}', 'utf8')
  return projectDir
}

describe('resolveProjectOpenTarget', () => {
  it('accepts a project directory containing manifest.json', () => {
    const projectDir = writeProject()

    const result = resolveProjectOpenTarget(projectDir)

    expect(result).toEqual({ ok: true, data: projectDir })
  })

  it('accepts a manifest.json file and resolves to its project directory', () => {
    const projectDir = writeProject()

    const result = resolveProjectOpenTarget(join(projectDir, 'manifest.json'))

    expect(result).toEqual({ ok: true, data: projectDir })
  })

  it('accepts a .manifestproject launcher with a relative projectPath', () => {
    const projectDir = writeProject('Relative Lab')
    const launcher = join(projectDir, 'Manifest.manifestproject')
    writeFileSync(launcher, JSON.stringify({ version: 1, projectPath: '.' }), 'utf8')

    const result = resolveProjectOpenTarget(launcher)

    expect(result).toEqual({ ok: true, data: projectDir })
  })

  it('accepts a .manifestproject launcher with an absolute projectPath', () => {
    const projectDir = writeProject('Absolute Lab')
    const launcher = join(tmpDir, 'Absolute.manifestproject')
    writeFileSync(launcher, JSON.stringify({ version: 1, projectPath: projectDir }), 'utf8')

    const result = resolveProjectOpenTarget(launcher)

    expect(result).toEqual({ ok: true, data: projectDir })
  })

  it('rejects unsupported files', () => {
    const path = join(tmpDir, 'notes.txt')
    writeFileSync(path, 'not a project', 'utf8')

    const result = resolveProjectOpenTarget(path)

    expect(result.ok).toBe(false)
  })

  it('rejects an existing folder that is not a Manifest project', () => {
    const folder = join(tmpDir, 'Not A Project')
    mkdirSync(folder)

    const result = resolveProjectOpenTarget(folder)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain('manifest.json was not found')
  })

  it('rejects malformed launchers', () => {
    const launcher = join(tmpDir, 'Broken.manifestproject')
    writeFileSync(launcher, '{', 'utf8')

    const result = resolveProjectOpenTarget(launcher)

    expect(result.ok).toBe(false)
  })
})
