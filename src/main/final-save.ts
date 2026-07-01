import type { BrowserWindow, MessageBoxOptions } from 'electron'
import type { Result } from '../shared/types'

export type FinalSaveContext = 'project-close' | 'window-close' | 'quit'
export type FinalSaveFailureAction = 'retry' | 'proceed-anyway' | 'open-logs'
export type FinalSaveOutcome = 'saved' | 'proceed-anyway'

export interface FinalSaveFailurePrompt {
  context: FinalSaveContext
  message: string
  window?: BrowserWindow | null
}

export interface FinalSaveOptions {
  context: FinalSaveContext
  window?: BrowserWindow | null
  hasOpenProject(): boolean
  saveProject(): Promise<Result<void>>
  showFailurePrompt(prompt: FinalSaveFailurePrompt): Promise<FinalSaveFailureAction>
  openLogsFolder(): Promise<void>
}

export async function ensureFinalProjectSave(options: FinalSaveOptions): Promise<FinalSaveOutcome> {
  while (true) {
    if (!options.hasOpenProject()) return 'saved'

    const result = await options.saveProject()
    if (result.ok) return 'saved'

    const action = await options.showFailurePrompt({
      context: options.context,
      message: result.error.message,
      window: options.window,
    })

    if (action === 'retry') continue
    if (action === 'open-logs') {
      await options.openLogsFolder()
      continue
    }
    return 'proceed-anyway'
  }
}

export function finalSaveFailureDialogOptions(
  context: FinalSaveContext,
  message: string,
): MessageBoxOptions {
  const proceedLabel = context === 'quit' ? 'Quit Anyway' : 'Close Anyway'
  const contextText = {
    'project-close': 'closing the project',
    'window-close': 'closing the window',
    quit: 'quitting Manifest',
  }[context]

  return {
    type: 'error',
    title: 'Could Not Save Project',
    message: `Manifest could not save the current project before ${contextText}.`,
    detail: `${message}\n\nRetry the save, open the logs to inspect the failure, or continue anyway and risk losing unsaved changes.`,
    buttons: ['Retry', proceedLabel, 'Open Logs'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  }
}

export function finalSaveFailureActionForResponse(response: number): FinalSaveFailureAction {
  if (response === 1) return 'proceed-anyway'
  if (response === 2) return 'open-logs'
  return 'retry'
}
