import type { GitStatus } from '../shared/types'

export interface DiagnosticsInfo {
  appName: string
  appVersion: string
  platform: NodeJS.Platform
  arch: string
  electronVersion: string
  chromeVersion: string
  nodeVersion: string
  gitStatus: GitStatus
  projectPath: string | null
  logsPath: string
  userDataPath: string
}

export function buildDiagnostics(info: DiagnosticsInfo): string {
  return [
    `${info.appName} diagnostics`,
    '',
    `App version: ${info.appVersion}`,
    `Platform: ${info.platform} ${info.arch}`,
    `Electron: ${info.electronVersion}`,
    `Chrome: ${info.chromeVersion}`,
    `Node: ${info.nodeVersion}`,
    `Git: ${formatGitStatus(info.gitStatus)}`,
    `Project path: ${info.projectPath ?? '(none open)'}`,
    `Logs path: ${info.logsPath}`,
    `User data path: ${info.userDataPath}`,
  ].join('\n')
}

function formatGitStatus(status: GitStatus): string {
  if (!status.available) return `not available (minimum ${status.minimumVersion})`
  const version = status.version ?? 'unknown'
  const suffix = status.meetsMinimum ? 'meets minimum' : `below minimum ${status.minimumVersion}`
  return `${version} (${suffix})`
}
