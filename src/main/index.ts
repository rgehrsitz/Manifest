import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { createLogger } from './logger'
import { ProjectManager } from './project-manager'
import { GitService } from './git-service'
import { IPC } from '../shared/ipc'
import { ok, err, ErrorCode } from '../shared/errors'

// ─── Logging ────────────────────────────────────────────────────────────────

const userData = app.getPath('userData')
const logDir   = join(userData, 'logs')

const appLogger     = createLogger('app',     join(logDir, 'app.log'))
const gitLogger     = createLogger('git',     join(logDir, 'git.log'))
const projectLogger = createLogger('project', join(logDir, 'project.log'))

// ─── Services ────────────────────────────────────────────────────────────────

const gitService     = new GitService(gitLogger)
const projectManager = new ProjectManager(gitService, projectLogger)

// ─── Window ──────────────────────────────────────────────────────────────────

function createWindow(): BrowserWindow {
  const iconPath = getBrandIconPath()
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'Manifest',
    icon: iconPath,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  win.once('ready-to-show', () => win.show())

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

// ─── IPC handlers ────────────────────────────────────────────────────────────

function registerIpcHandlers(): void {

  // ── Project lifecycle ────────────────────────────────────────────────────

  ipcMain.handle(IPC.PROJECT_CREATE, (_, { name, parentPath }: { name: string; parentPath: string }) =>
    projectManager.createProject(name, parentPath)
  )

  ipcMain.handle(IPC.PROJECT_OPEN, (_, { path }: { path: string }) =>
    projectManager.openProject(path)
  )

  ipcMain.handle(IPC.PROJECT_SAVE, async () =>
    projectManager.saveProject()
  )

  ipcMain.handle(IPC.PROJECT_GET_CURRENT, () => {
    const project = projectManager.getCurrent()
    return ok(project)
  })

  ipcMain.handle(IPC.PROJECT_CLOSE, async () =>
    projectManager.flushAndClose()
  )

  // ── Node CRUD ────────────────────────────────────────────────────────────

  ipcMain.handle(IPC.NODE_CREATE, (_, { parentId, name }: { parentId: string; name: string }) =>
    projectManager.nodeCreate(parentId, name)
  )

  ipcMain.handle(IPC.NODE_UPDATE, (
    _,
    { id, changes }: {
      id: string
      changes: { name?: string; properties?: Record<string, string | number | boolean | null> }
    }
  ) => projectManager.nodeUpdate(id, changes))

  ipcMain.handle(IPC.NODE_DELETE, (_, { id }: { id: string }) =>
    projectManager.nodeDelete(id)
  )

  ipcMain.handle(IPC.NODE_MOVE, (
    _,
    { id, newParentId, newOrder }: { id: string; newParentId: string; newOrder: number }
  ) => projectManager.nodeMove(id, newParentId, newOrder))

  // ── Search ───────────────────────────────────────────────────────────────

  ipcMain.handle(IPC.SEARCH_QUERY, (_, { query }: { query: string }) =>
    projectManager.searchNodes(query)
  )

  // ── Git ──────────────────────────────────────────────────────────────────

  ipcMain.handle(IPC.GIT_CHECK, async () => {
    const status = await gitService.checkVersion()
    return ok(status)
  })

  // ── Dialog helpers ───────────────────────────────────────────────────────

  ipcMain.handle(IPC.DIALOG_OPEN_FOLDER, async (_, { title }: { title: string }) => {
    const result = await dialog.showOpenDialog({
      title,
      properties: ['openDirectory', 'createDirectory'],
    })
    return result.canceled ? null : result.filePaths[0]
  })

  // ── Snapshots ────────────────────────────────────────────────────────────

  ipcMain.handle(IPC.SNAPSHOT_CREATE, (_, { name }: { name: string }) =>
    projectManager.snapshotCreate(name)
  )

  ipcMain.handle(IPC.SNAPSHOT_LIST, () =>
    projectManager.snapshotList()
  )

  ipcMain.handle(IPC.SNAPSHOT_COMPARE, (_, { a, b }: { a: string; b: string }) =>
    projectManager.snapshotCompare(a, b)
  )

  ipcMain.handle(IPC.SNAPSHOT_LOAD_COMPARE, (_, { a, b }: { a: string; b: string }) =>
    projectManager.snapshotLoadCompare(a, b)
  )

  ipcMain.handle(IPC.SNAPSHOT_REVERT, (_, request: { name: string; note?: string | null }) =>
    projectManager.snapshotRevert(request)
  )

  ipcMain.handle(IPC.SNAPSHOT_RESTORE, (_, { name }: { name: string }) =>
    projectManager.snapshotRestore(name)
  )
}

// ─── App lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  appLogger.info('app starting', { version: app.getVersion(), platform: process.platform })

  const gitStatus = await gitService.checkVersion()
  appLogger.info('git version check', { version: gitStatus.version, meetsMinimum: gitStatus.meetsMinimum })

  if (!gitStatus.available) {
    await dialog.showMessageBox({
      type: 'error',
      title: 'Git Not Found',
      message: 'Manifest requires Git to manage project history.',
      detail: getGitInstallInstructions(),
      buttons: ['OK'],
    })
    appLogger.warn('git not available — project creation disabled')
  } else if (!gitStatus.meetsMinimum) {
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      title: 'Git Version Too Old',
      message: `Manifest requires Git ${gitStatus.minimumVersion}+`,
      detail: `Found Git ${gitStatus.version}. Some features may not work correctly. Please update Git.`,
      buttons: ['Continue Anyway', 'Quit'],
      defaultId: 0,
    })
    if (response === 1) {
      app.quit()
      return
    }
  }

  registerIpcHandlers()
  const iconPath = getBrandIconPath()
  if (process.platform === 'darwin' && iconPath) {
    app.dock.setIcon(iconPath)
  }
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Flush autosave before quitting so no changes are lost.
app.on('before-quit', () => {
  projectManager.cancelAutosave()
  projectManager.saveProject()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

function getGitInstallInstructions(): string {
  switch (process.platform) {
    case 'darwin':
      return 'Install via Xcode Command Line Tools:\n  xcode-select --install\n\nOr download from https://git-scm.com'
    case 'win32':
      return 'Download and install from https://git-scm.com/download/win'
    default:
      return 'Install via your package manager:\n  sudo apt install git\n  sudo dnf install git\n\nOr visit https://git-scm.com'
  }
}

function getBrandIconPath(): string | undefined {
  const iconPath = join(app.getAppPath(), 'resources', 'icon.png')
  return existsSync(iconPath) ? iconPath : undefined
}
