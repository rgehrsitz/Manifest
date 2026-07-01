import { describe, expect, it } from 'vitest'
import { buildDiagnostics } from '../../../src/main/diagnostics'

describe('buildDiagnostics', () => {
  it('includes app, runtime, git, project, and path details', () => {
    const diagnostics = buildDiagnostics({
      appName: 'Manifest',
      appVersion: '0.1.0',
      platform: 'darwin',
      arch: 'arm64',
      electronVersion: '34.5.8',
      chromeVersion: '132.0.0',
      nodeVersion: '22.0.0',
      gitStatus: {
        available: true,
        version: '2.50.0',
        meetsMinimum: true,
        minimumVersion: '2.25.0',
      },
      projectPath: '/tmp/Bench',
      logsPath: '/tmp/logs',
      userDataPath: '/tmp/userData',
    })

    expect(diagnostics).toContain('Manifest diagnostics')
    expect(diagnostics).toContain('App version: 0.1.0')
    expect(diagnostics).toContain('Platform: darwin arm64')
    expect(diagnostics).toContain('Git: 2.50.0 (meets minimum)')
    expect(diagnostics).toContain('Project path: /tmp/Bench')
    expect(diagnostics).toContain('Logs path: /tmp/logs')
  })

  it('reports unavailable Git and no open project clearly', () => {
    const diagnostics = buildDiagnostics({
      appName: 'Manifest',
      appVersion: '0.1.0',
      platform: 'linux',
      arch: 'x64',
      electronVersion: '34.5.8',
      chromeVersion: '132.0.0',
      nodeVersion: '22.0.0',
      gitStatus: {
        available: false,
        version: null,
        meetsMinimum: false,
        minimumVersion: '2.25.0',
      },
      projectPath: null,
      logsPath: '/tmp/logs',
      userDataPath: '/tmp/userData',
    })

    expect(diagnostics).toContain('Git: not available (minimum 2.25.0)')
    expect(diagnostics).toContain('Project path: (none open)')
  })
})
