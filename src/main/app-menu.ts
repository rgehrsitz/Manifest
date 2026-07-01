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

let commandItems = new Map<MenuCommandId, MenuItem>()
let commandState = normalizeMenuCommandState(null)
let installOptions: {
  platform: NodeJS.Platform
  isDev: boolean
  appName: string
  logsPath: string
  openRecentProject(path: string): void
  clearRecentProjects(): void
} | null = null
let recentProjects: RecentProjectMenuEntry[] = []

export function installApplicationMenu(options: {
  platform: NodeJS.Platform
  isDev: boolean
  appName: string
  logsPath: string
  recentProjects: RecentProjectMenuEntry[]
  openRecentProject(path: string): void
  clearRecentProjects(): void
}): void {
  installOptions = {
    platform: options.platform,
    isDev: options.isDev,
    appName: options.appName,
    logsPath: options.logsPath,
    openRecentProject: options.openRecentProject,
    clearRecentProjects: options.clearRecentProjects,
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
    openLogsFolder: () => {
      void shell.openPath(options.logsPath)
    },
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
