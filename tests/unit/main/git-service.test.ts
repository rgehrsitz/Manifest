// Git service tests use real git repos in temp directories, never mocks.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { GitService } from '../../../src/main/git-service'

const noopLogger = { error() {}, warn() {}, info() {}, debug() {} } as any

let tmpDir: string
let git: GitService

beforeEach(() => {
  tmpDir = join(tmpdir(), `manifest-git-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(tmpDir, { recursive: true })
  git = new GitService(noopLogger)
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

function runGit(args: string[]) {
  execFileSync('git', args, { cwd: tmpDir, stdio: 'pipe' })
}

// Build a manifest.json string larger than Node's default 1 MB execFile buffer,
// so we exercise the maxBuffer path in readSnapshotManifest / readHeadManifest.
function largeManifestJson(): string {
  const nodes = Array.from({ length: 6000 }, (_, i) => ({
    id: `node-${i}`,
    parentId: i === 0 ? null : 'node-0',
    name: `Component ${i}`,
    order: i,
    properties: { serial: `SN-${i}`, note: 'x'.repeat(40) },
    created: '2026-01-01T00:00:00.000Z',
    modified: '2026-01-01T00:00:00.000Z',
  }))
  return JSON.stringify({ version: 3, id: 'big', name: 'Big', nodes, templates: {} }, null, 2)
}

describe('GitService — large manifests exceed the default execFile buffer', () => {
  it('reads a snapshot/head manifest larger than 1 MB without ENOBUFS', async () => {
    const json = largeManifestJson()
    expect(json.length).toBeGreaterThan(1024 * 1024) // > 1 MB

    writeFileSync(join(tmpDir, 'manifest.json'), json, 'utf8')
    runGit(['init'])
    runGit(['add', 'manifest.json'])
    runGit(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'big'])
    runGit(['tag', 'snapshot/big-snap'])

    const fromTag = await git.readSnapshotManifest(tmpDir, 'big-snap')
    expect(fromTag.length).toBe(json.length)

    const fromHead = await git.readHeadManifest(tmpDir)
    expect(fromHead.length).toBe(json.length)
  })
})
