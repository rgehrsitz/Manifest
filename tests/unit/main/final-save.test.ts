import { describe, expect, it } from 'vitest'
import { err, ok, ErrorCode } from '../../../src/shared/errors'
import {
  ensureFinalProjectSave,
  finalSaveFailureActionForResponse,
  finalSaveFailureDialogOptions,
  type FinalSaveFailureAction,
} from '../../../src/main/final-save'

describe('ensureFinalProjectSave', () => {
  it('retries a failed project-close save before returning saved', async () => {
    let attempts = 0
    const prompts: string[] = []

    const outcome = await ensureFinalProjectSave({
      context: 'project-close',
      hasOpenProject: () => true,
      saveProject: async () => {
        attempts += 1
        return attempts === 1
          ? err(ErrorCode.AUTOSAVE_WRITE_FAILED, 'disk is full')
          : ok(undefined)
      },
      showFailurePrompt: async (prompt) => {
        prompts.push(prompt.message)
        return 'retry'
      },
      openLogsFolder: async () => {},
    })

    expect(outcome).toBe('saved')
    expect(attempts).toBe(2)
    expect(prompts).toEqual(['disk is full'])
  })

  it('opens logs and continues prompting during quit save failures', async () => {
    const actions: FinalSaveFailureAction[] = ['open-logs', 'proceed-anyway']
    let openedLogs = 0

    const outcome = await ensureFinalProjectSave({
      context: 'quit',
      hasOpenProject: () => true,
      saveProject: async () => err(ErrorCode.AUTOSAVE_WRITE_FAILED, 'permission denied'),
      showFailurePrompt: async () => actions.shift() ?? 'proceed-anyway',
      openLogsFolder: async () => {
        openedLogs += 1
      },
    })

    expect(outcome).toBe('proceed-anyway')
    expect(openedLogs).toBe(1)
  })

  it('skips save when no project is open', async () => {
    let saveCalled = false

    const outcome = await ensureFinalProjectSave({
      context: 'quit',
      hasOpenProject: () => false,
      saveProject: async () => {
        saveCalled = true
        return ok(undefined)
      },
      showFailurePrompt: async () => 'retry',
      openLogsFolder: async () => {},
    })

    expect(outcome).toBe('saved')
    expect(saveCalled).toBe(false)
  })

  it('stops retrying when the project is gone between prompts', async () => {
    let projectOpen = true
    let saveAttempts = 0

    const outcome = await ensureFinalProjectSave({
      context: 'quit',
      hasOpenProject: () => projectOpen,
      saveProject: async () => {
        saveAttempts += 1
        return err(ErrorCode.PROJECT_NOT_FOUND, 'No project is currently open')
      },
      showFailurePrompt: async () => {
        projectOpen = false
        return 'retry'
      },
      openLogsFolder: async () => {},
    })

    expect(outcome).toBe('saved')
    expect(saveAttempts).toBe(1)
  })
})

describe('finalSaveFailureDialogOptions', () => {
  it('uses Quit Anyway for quit failures', () => {
    const options = finalSaveFailureDialogOptions('quit', 'write failed')

    expect(options.buttons).toEqual(['Retry', 'Quit Anyway', 'Open Logs'])
    expect(options.defaultId).toBe(0)
    expect(options.cancelId).toBe(0)
  })

  it('uses Close Anyway for project and window close failures', () => {
    expect(finalSaveFailureDialogOptions('project-close', 'write failed').buttons)
      .toEqual(['Retry', 'Close Anyway', 'Open Logs'])
    expect(finalSaveFailureDialogOptions('window-close', 'write failed').buttons)
      .toEqual(['Retry', 'Close Anyway', 'Open Logs'])
  })
})

describe('finalSaveFailureActionForResponse', () => {
  it('maps dialog responses to final-save actions', () => {
    expect(finalSaveFailureActionForResponse(0)).toBe('retry')
    expect(finalSaveFailureActionForResponse(1)).toBe('proceed-anyway')
    expect(finalSaveFailureActionForResponse(2)).toBe('open-logs')
    expect(finalSaveFailureActionForResponse(-1)).toBe('retry')
  })
})
