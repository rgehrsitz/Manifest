// Git service: all git CLI operations.
// Uses execFile (never exec) to prevent shell injection.
// Runs operations through a serial queue to prevent .git/index.lock contention.

import { execFile } from 'child_process'
import { promisify } from 'util'
import type { GitStatus } from '../shared/types'
import type { Logger } from './logger'

const execFileAsync = promisify(execFile)

const MIN_GIT_VERSION: [number, number, number] = [2, 25, 0]
const MIN_GIT_VERSION_STRING = MIN_GIT_VERSION.join('.')

// Serial async queue — all git + file write operations enqueue here.
// Prevents .git/index.lock contention from concurrent operations.
class SerialQueue {
  private queue: Array<() => Promise<void>> = []
  private running = false

  async enqueue<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push(async () => {
        try {
          resolve(await fn())
        } catch (e) {
          reject(e)
        }
      })
      this.drain()
    })
  }

  private async drain(): Promise<void> {
    if (this.running) return
    this.running = true
    while (this.queue.length > 0) {
      const task = this.queue.shift()!
      await task()
    }
    this.running = false
  }
}

function parseVersion(output: string): [number, number, number] | null {
  const match = output.match(/git version (\d+)\.(\d+)\.(\d+)/)
  if (!match) return null
  return [parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10)]
}

function meetsMinimum(version: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) {
    if (version[i] > MIN_GIT_VERSION[i]) return true
    if (version[i] < MIN_GIT_VERSION[i]) return false
  }
  return true
}

export class GitService {
  private readonly queue = new SerialQueue()

  constructor(private readonly logger: Logger) {}

  async checkVersion(): Promise<GitStatus> {
    try {
      const { stdout } = await execFileAsync('git', ['--version'])
      const parsed = parseVersion(stdout.trim())
      if (!parsed) {
        this.logger.warn('unrecognised git --version output', { stdout })
        return { available: true, version: stdout.trim(), meetsMinimum: false, minimumVersion: MIN_GIT_VERSION_STRING }
      }
      const meets = meetsMinimum(parsed)
      const version = parsed.join('.')
      this.logger.info('git version check', { version, meetsMinimum: meets })
      return { available: true, version, meetsMinimum: meets, minimumVersion: MIN_GIT_VERSION_STRING }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      this.logger.error('git not found', { error: msg })
      return { available: false, version: null, meetsMinimum: false, minimumVersion: MIN_GIT_VERSION_STRING }
    }
  }

  async initRepo(projectDir: string): Promise<void> {
    await this.queue.enqueue(async () => {
      await execFileAsync('git', ['init'], { cwd: projectDir })
      this.logger.info('git init', { dir: projectDir })
    })
  }

  async initialCommit(projectDir: string): Promise<void> {
    await this.queue.enqueue(async () => {
      await execFileAsync('git', ['add', 'manifest.json'], { cwd: projectDir })
      await execFileAsync(
        'git',
        ['-c', 'user.email=manifest@local', '-c', 'user.name=Manifest', 'commit', '-m', 'Initial project'],
        { cwd: projectDir }
      )
      this.logger.info('initial git commit', { dir: projectDir })
    })
  }
}
