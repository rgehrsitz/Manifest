import { BrowserWindow, Menu, shell, type MenuItem } from 'electron'
import { IPC } from '../shared/ipc'
import {
  MENU_COMMAND_IDS,
  normalizeMenuCommandState,
  type MenuCommandId,
  type MenuCommandState,
} from '../shared/menu-commands'
import { buildAppMenuTemplate } from './app-menu-template'

let commandItems = new Map<MenuCommandId, MenuItem>()
let commandState = normalizeMenuCommandState(null)

export function installApplicationMenu(options: {
  platform: NodeJS.Platform
  isDev: boolean
  appName: string
  logsPath: string
}): void {
  const menu = Menu.buildFromTemplate(buildAppMenuTemplate({
    platform: options.platform,
    isDev: options.isDev,
    appName: options.appName,
    dispatch: dispatchMenuCommand,
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
