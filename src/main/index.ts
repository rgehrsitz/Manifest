import { app, BrowserWindow, ipcMain, dialog } from 'electron'
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
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'Manifest',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  win.once('ready-to-show', () => win.show())

  // electron-vite sets ELECTRON_RENDERER_URL in dev mode
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

// ─── IPC handlers ────────────────────────────────────────────────────────────

function registerIpcHandlers(): void {
  // Project lifecycle
  ipcMain.handle(IPC.PROJECT_CREATE, (_, { name, parentPath }: { name: string; parentPath: string }) =>
    projectManager.createProject(name, parentPath)
  )

  ipcMain.handle(IPC.PROJECT_OPEN, (_, { path }: { path: string }) =>
    projectManager.openProject(path)
  )

  ipcMain.handle(IPC.PROJECT_SAVE, (_, { project }) =>
    projectManager.saveProject(project)
  )

  // Git
  ipcMain.handle(IPC.GIT_CHECK, async () => {
    const status = await gitService.checkVersion()
    return ok(status)
  })

  // Native dialog helpers
  ipcMain.handle(IPC.DIALOG_OPEN_FOLDER, async (_, { title }: { title: string }) => {
    const result = await dialog.showOpenDialog({
      title,
      properties: ['openDirectory', 'createDirectory'],
    })
    return result.canceled ? null : result.filePaths[0]
  })

  // Phase 2+ stubs (return NOT_IMPLEMENTED so the renderer can handle gracefully)
  const notImplemented = () =>
    Promise.resolve(err(ErrorCode.NOT_IMPLEMENTED, 'Not implemented in Phase 1'))

  ipcMain.handle(IPC.NODE_CREATE,      notImplemented)
  ipcMain.handle(IPC.NODE_UPDATE,      notImplemented)
  ipcMain.handle(IPC.NODE_DELETE,      notImplemented)
  ipcMain.handle(IPC.NODE_MOVE,        notImplemented)
  ipcMain.handle(IPC.SEARCH_QUERY,     notImplemented)
  ipcMain.handle(IPC.SNAPSHOT_CREATE,  notImplemented)
  ipcMain.handle(IPC.SNAPSHOT_LIST,    notImplemented)
  ipcMain.handle(IPC.SNAPSHOT_COMPARE, notImplemented)
  ipcMain.handle(IPC.SNAPSHOT_RESTORE, notImplemented)
}

// ─── App lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  appLogger.info('app starting', { version: app.getVersion(), platform: process.platform })

  const gitStatus = await gitService.checkVersion()

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
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
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
