import { BrowserWindow, Menu, shell, type MenuItem } from 'electron'
import { IPC } from '../shared/ipc'
import {
  MENU_COMMAND_IDS,
  normalizeMenuCommandState,
  type MenuCommandId,
  type MenuCommandState,
} from '../shared/menu-commands'
import { buildAppMenuTemplate } from './app-menu-template'
import type { RecentProjectMenuEntry } from './recent-projects'
import type { Logger } from './logger'

let commandItems = new Map<MenuCommandId, MenuItem>()
let commandState = normalizeMenuCommandState(null)
let installOptions: {
  platform: NodeJS.Platform
  isDev: boolean
  appName: string
  logsPath: string
  logger: Logger
  openRecentProject(path: string): void
  clearRecentProjects(): void
  openPreferences(): void
  openDocumentation(): void
  reportIssue(): void
  copyDiagnostics(): void
} | null = null
let recentProjects: RecentProjectMenuEntry[] = []

export function installApplicationMenu(options: {
  platform: NodeJS.Platform
  isDev: boolean
  appName: string
  logsPath: string
  logger: Logger
  recentProjects: RecentProjectMenuEntry[]
  openRecentProject(path: string): void
  clearRecentProjects(): void
  openPreferences(): void
  openDocumentation(): void
  reportIssue(): void
  copyDiagnostics(): void
}): void {
  installOptions = {
    platform: options.platform,
    isDev: options.isDev,
    appName: options.appName,
    logsPath: options.logsPath,
    logger: options.logger,
    openRecentProject: options.openRecentProject,
    clearRecentProjects: options.clearRecentProjects,
    openPreferences: options.openPreferences,
    openDocumentation: options.openDocumentation,
    reportIssue: options.reportIssue,
    copyDiagnostics: options.copyDiagnostics,
  }
  recentProjects = options.recentProjects
  rebuildApplicationMenu()
}

export function updateApplicationMenuRecentProjects(nextProjects: RecentProjectMenuEntry[]): void {
  recentProjects = nextProjects
  rebuildApplicationMenu()
}

function rebuildApplicationMenu(): void {
  if (!installOptions) return
  const options = installOptions
  const menu = Menu.buildFromTemplate(buildAppMenuTemplate({
    platform: options.platform,
    isDev: options.isDev,
    appName: options.appName,
    recentProjects,
    dispatch: dispatchMenuCommand,
    openRecentProject: options.openRecentProject,
    clearRecentProjects: options.clearRecentProjects,
    openPreferences: options.openPreferences,
    openDocumentation: options.openDocumentation,
    reportIssue: options.reportIssue,
    openLogsFolder: () => {
      shell.openPath(options.logsPath).catch((error: unknown) => {
        options.logger.error('failed to open logs folder from menu', { error: errorMessage(error), path: options.logsPath })
      })
    },
    copyDiagnostics: options.copyDiagnostics,
  }))

  Menu.setApplicationMenu(menu)
  commandItems = new Map<MenuCommandId, MenuItem>()
  for (const id of MENU_COMMAND_IDS) {
    const item = menu.getMenuItemById(id)
    if (item) commandItems.set(id, item)
  }
  updateApplicationMenuState(commandState)
}

export function updateApplicationMenuState(nextState: unknown): void {
  commandState = normalizeMenuCommandState(nextState)
  for (const id of MENU_COMMAND_IDS) {
    const item = commandItems.get(id)
    if (item) item.enabled = commandState[id]
  }
}

export function currentApplicationMenuState(): MenuCommandState {
  return { ...commandState }
}

function dispatchMenuCommand(command: MenuCommandId): void {
  if (!commandState[command]) return
  const target = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  if (!target || target.isDestroyed()) return
  target.webContents.send(IPC.MENU_COMMAND, command)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
