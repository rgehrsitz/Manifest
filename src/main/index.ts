import { app, BrowserWindow, ipcMain, dialog, shell, screen } from 'electron'
import { existsSync } from 'fs'
import { writeFile } from 'fs/promises'
import { extname, join, resolve } from 'path'
import { createLogger } from './logger'
import { ProjectManager } from './project-manager'
import { GitService } from './git-service'
import { IPC, type FolderDialogPurpose } from '../shared/ipc'
import { ok, err, ErrorCode } from '../shared/errors'
import {
  installApplicationMenu,
  updateApplicationMenuRecentProjects,
  updateApplicationMenuState,
} from './app-menu'
import { resolveProjectOpenTarget } from './project-open-target'
import { RecentProjectsStore, getRecentDocumentPath } from './recent-projects'
import { AppSettingsStore, resolveRestorableWindowBounds, type WorkspaceSettingsPatch } from './app-settings'
import { desktopChromeForPlatform } from '../shared/desktop-chrome'
import {
  ensureFinalProjectSave,
  finalSaveFailureActionForResponse,
  finalSaveFailureDialogOptions,
  type FinalSaveContext,
  type FinalSaveFailureAction,
} from './final-save'
import type { Project, Result, NodeTemplate, ImportMapping, NetboxImportOptions } from '../shared/types'
import type { ReportFormat } from '../shared/report'

// ─── Logging ────────────────────────────────────────────────────────────────

const userData = app.getPath('userData')
const logDir   = join(userData, 'logs')

const appLogger     = createLogger('app',     join(logDir, 'app.log'))
const gitLogger     = createLogger('git',     join(logDir, 'git.log'))
const projectLogger = createLogger('project', join(logDir, 'project.log'))

// ─── Services ────────────────────────────────────────────────────────────────

const gitService     = new GitService(gitLogger)
const projectManager = new ProjectManager(gitService, projectLogger)
const recentProjects = new RecentProjectsStore(join(userData, 'recent-projects.json'))
const appSettings = new AppSettingsStore(join(userData, 'app-settings.json'))

// ─── Window ──────────────────────────────────────────────────────────────────

let mainWindow: BrowserWindow | null = null
const pendingOpenTargets: string[] = []
let ownsSingleInstanceLock = false
let quitAfterFinalSave = false
let finalQuitInProgress = false
const approvedWindowCloses = new WeakSet<BrowserWindow>()
let windowStateSaveTimer: ReturnType<typeof setTimeout> | null = null

function createWindow(): BrowserWindow {
  const iconPath = getBrandIconPath()
  const storedWindowState = appSettings.getWindowState()
  const restoredBounds = resolveRestorableWindowBounds(storedWindowState, screen.getAllDisplays())
  const desktopChrome = desktopChromeForPlatform(process.platform)
  const win = new BrowserWindow({
    x: restoredBounds?.x,
    y: restoredBounds?.y,
    width: restoredBounds?.width ?? 1280,
    height: restoredBounds?.height ?? 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'Manifest',
    icon: iconPath,
    titleBarStyle: desktopChrome.titleBarStyle,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  if (storedWindowState?.isMaximized) {
    win.maximize()
  }
  if (storedWindowState?.isFullScreen) {
    win.setFullScreen(true)
  }

  win.once('ready-to-show', () => win.show())
  win.on('move', () => scheduleWindowStateSave(win))
  win.on('resize', () => scheduleWindowStateSave(win))
  win.on('maximize', () => saveWindowState(win))
  win.on('unmaximize', () => saveWindowState(win))
  win.on('enter-full-screen', () => saveWindowState(win))
  win.on('leave-full-screen', () => saveWindowState(win))
  win.on('close', (event) => {
    saveWindowState(win)
    if (quitAfterFinalSave || approvedWindowCloses.has(win) || !projectManager.getCurrent()) return
    event.preventDefault()
    void closeWindowAfterFinalSave(win)
  })
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow = win
  return win
}

// ─── IPC handlers ────────────────────────────────────────────────────────────

function registerIpcHandlers(): void {

  // ── Project lifecycle ────────────────────────────────────────────────────

  ipcMain.handle(IPC.PROJECT_CREATE, async (_, { name, parentPath }: { name: string; parentPath: string }) => {
    const result = await projectManager.createProject(name, parentPath)
    trackRecentProject(result)
    return result
  })

  ipcMain.handle(IPC.PROJECT_OPEN, async (_, { path }: { path: string }) => {
    const result = await projectManager.openProject(path)
    trackRecentProject(result)
    return result
  })

  ipcMain.handle(IPC.PROJECT_SAVE, async () =>
    projectManager.saveProject()
  )

  ipcMain.handle(IPC.PROJECT_GET_CURRENT, () => {
    const project = projectManager.getCurrent()
    return ok(project)
  })

  ipcMain.handle(IPC.PROJECT_CLOSE, async () =>
    closeProjectAfterFinalSave(mainWindow ?? BrowserWindow.getFocusedWindow())
  )

  // ── Node CRUD ────────────────────────────────────────────────────────────

  ipcMain.handle(IPC.NODE_CREATE, (
    _,
    { parentId, name, templateId }: { parentId: string; name: string; templateId?: string | null }
  ) => projectManager.nodeCreate(parentId, name, templateId))

  ipcMain.handle(IPC.NODE_UPDATE, (
    _,
    { id, changes }: {
      id: string
      changes: {
        name?: string
        properties?: Record<string, string | number | boolean | null>
        templateId?: string | null
      }
    }
  ) => projectManager.nodeUpdate(id, changes))

  ipcMain.handle(IPC.NODE_DELETE, (
    _,
    { id, options }: { id: string; options?: { unlinkReferences?: boolean } }
  ) => projectManager.nodeDelete(id, options))

  ipcMain.handle(IPC.NODE_MOVE, (
    _,
    { id, newParentId, newOrder }: { id: string; newParentId: string; newOrder: number }
  ) => projectManager.nodeMove(id, newParentId, newOrder))

  ipcMain.handle(IPC.NODE_HISTORY, (_, { nodeId }: { nodeId: string }) =>
    projectManager.nodeHistory(nodeId)
  )

  ipcMain.handle(IPC.NODE_HISTORY_BACKFILL_STATUS, () =>
    ok(projectManager.getHistoryIndexStatus())
  )

  ipcMain.handle(IPC.NODE_HISTORY_REINDEX, () =>
    projectManager.reindexHistory()
  )

  // ── Templates ──────────────────────────────────────────────────────────────

  ipcMain.handle(IPC.TEMPLATE_CREATE, (
    _,
    { id, template }: { id: string; template: NodeTemplate }
  ) => projectManager.templateCreate(id, template))

  ipcMain.handle(IPC.TEMPLATE_UPDATE, (
    _,
    { id, changes }: { id: string; changes: Partial<NodeTemplate> }
  ) => projectManager.templateUpdate(id, changes))

  ipcMain.handle(IPC.TEMPLATE_DELETE, (_, { id }: { id: string }) =>
    projectManager.templateDelete(id)
  )

  // ── CSV import ─────────────────────────────────────────────────────────────

  ipcMain.handle(IPC.IMPORT_INSPECT, (_, { path }: { path: string }) =>
    projectManager.inspectImport(path)
  )

  ipcMain.handle(IPC.IMPORT_PLAN, (_, { path, mapping }: { path: string; mapping: ImportMapping }) =>
    projectManager.planImportCsv(path, mapping)
  )

  ipcMain.handle(IPC.IMPORT_APPLY, (_, { path, mapping }: { path: string; mapping: ImportMapping }) =>
    projectManager.applyImportCsv(path, mapping)
  )

  // ── NetBox import ──────────────────────────────────────────────────────────

  ipcMain.handle(IPC.IMPORT_NETBOX_INSPECT, (_, { path }: { path: string }) =>
    projectManager.inspectNetboxImport(path)
  )

  ipcMain.handle(
    IPC.IMPORT_NETBOX_PLAN,
    (_, { path, options }: { path: string; options: NetboxImportOptions }) =>
      projectManager.planNetboxImport(path, options)
  )

  ipcMain.handle(
    IPC.IMPORT_NETBOX_APPLY,
    (_, { path, options }: { path: string; options: NetboxImportOptions }) =>
      projectManager.applyNetboxImport(path, options)
  )

  // ── Search ───────────────────────────────────────────────────────────────

  ipcMain.handle(IPC.SEARCH_QUERY, (_, { query }: { query: string }) =>
    projectManager.searchNodes(query)
  )

  // ── Git ──────────────────────────────────────────────────────────────────

  ipcMain.handle(IPC.GIT_CHECK, async () => {
    const status = await gitService.checkVersion()
    return ok(status)
  })

  // ── Report export ──────────────────────────────────────────────────────────
  // Main builds the content authoritatively (ProjectManager.buildReport) and owns
  // the save dialog + file write — the renderer never touches the filesystem.

  ipcMain.handle(IPC.REPORT_EXPORT, async (_, { from, to, format }: { from: string; to: string; format: ReportFormat }) => {
    const built = await projectManager.buildReport(from, to, format)
    if (!built.ok) return built
    // showSaveDialog AND writeFile are both inside the try so a dialog or write
    // rejection resolves to a Result, never throwing across the IPC boundary.
    try {
      const result = await dialog.showSaveDialog({
        title: 'Export change report',
        defaultPath: built.data.suggestedName,
        filters: [format === 'csv' ? { name: 'CSV', extensions: ['csv'] } : { name: 'Markdown', extensions: ['md'] }],
      })
      if (result.canceled || !result.filePath) return ok({ savedPath: null })
      await writeFile(result.filePath, built.data.content, 'utf8')
      return ok({ savedPath: result.filePath })
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      return err(ErrorCode.REPORT_WRITE_FAILED, `Failed to write report: ${msg}`)
    }
  })

  ipcMain.handle(IPC.REPORT_BUILD, (_, { from, to, format }: { from: string; to: string; format: ReportFormat }) =>
    projectManager.buildReport(from, to, format)
  )

  // ── Dialog helpers ───────────────────────────────────────────────────────

  ipcMain.handle(IPC.DIALOG_OPEN_FOLDER, async (_, { title, purpose }: { title: string; purpose?: FolderDialogPurpose }) => {
    const directoryKind = directoryKindForFolderDialogPurpose(purpose)
    const result = await dialog.showOpenDialog({
      title,
      defaultPath: directoryKind ? appSettings.getLastDirectory(directoryKind) : undefined,
      properties: ['openDirectory', 'createDirectory'],
    })
    if (!result.canceled && result.filePaths[0] && directoryKind) {
      appSettings.recordLastDirectory(directoryKind, result.filePaths[0])
    }
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle(IPC.DIALOG_OPEN_FILE, async (_, { title }: { title: string }) => {
    const result = await dialog.showOpenDialog({
      title,
      properties: ['openFile'],
      filters: [
        { name: 'Importable (CSV, NetBox JSON)', extensions: ['csv', 'json'] },
        { name: 'CSV', extensions: ['csv'] },
        { name: 'NetBox JSON', extensions: ['json'] },
      ],
    })
    return result.canceled ? null : result.filePaths[0]
  })

  // ── Native menu state ────────────────────────────────────────────────────
  // Renderer-owned UI state drives native menu enablement. The renderer still
  // self-guards every command when a menu item or accelerator dispatches.
  ipcMain.on(IPC.MENU_STATE_UPDATE, (_, state: unknown) => {
    updateApplicationMenuState(state)
  })

  ipcMain.handle(IPC.SETTINGS_GET, () =>
    ok(appSettings.getWorkspaceSettings())
  )

  ipcMain.handle(IPC.SETTINGS_UPDATE_WORKSPACE, (_, patch: unknown) =>
    ok(appSettings.updateWorkspaceSettings(normalizeWorkspaceSettingsPatch(patch)))
  )

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

  ipcMain.handle(IPC.SNAPSHOT_TIMELINE, () =>
    projectManager.snapshotTimeline()
  )

  ipcMain.handle(IPC.RECOVERY_APPLY, (_, request: { id: string }) =>
    projectManager.recoveryPointApply(request)
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
  installApplicationMenu({
    platform: process.platform,
    isDev: Boolean(process.env['ELECTRON_RENDERER_URL']),
    appName: app.name || 'Manifest',
    logsPath: logDir,
    recentProjects: recentProjects.all(),
    openRecentProject: openRecentProject,
    clearRecentProjects: clearRecentProjects,
  })
  const iconPath = getBrandIconPath()
  if (process.platform === 'darwin' && iconPath) {
    app.dock.setIcon(iconPath)
  }
  await drainPendingOpenTargets()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  ownsSingleInstanceLock = true
  app.on('second-instance', (_event, argv) => {
    focusMainWindow()
    for (const target of collectOpenTargetsFromArgv(argv)) {
      void openProjectFromOsTarget(target, { notifyRenderer: true })
    }
  })
}

app.on('open-file', (event, path) => {
  event.preventDefault()
  queueOpenTarget(path)
})

// Flush autosave before quitting so no changes are lost. Electron cannot await
// before-quit listeners, so normal quits are paused and resumed after the final
// save either succeeds or the user explicitly chooses Quit Anyway.
app.on('before-quit', (event) => {
  if (quitAfterFinalSave || !projectManager.getCurrent()) return
  event.preventDefault()
  void quitAfterFinalSavePrompt()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

for (const target of collectOpenTargetsFromArgv(process.argv)) {
  queueOpenTarget(target)
}

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

function scheduleWindowStateSave(win: BrowserWindow): void {
  if (windowStateSaveTimer) clearTimeout(windowStateSaveTimer)
  windowStateSaveTimer = setTimeout(() => {
    windowStateSaveTimer = null
    saveWindowState(win)
  }, 250)
}

function saveWindowState(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  const bounds = (win.isMaximized() || win.isFullScreen())
    ? win.getNormalBounds()
    : win.getBounds()
  appSettings.updateWindowState({
    bounds,
    isMaximized: win.isMaximized(),
    isFullScreen: win.isFullScreen(),
  })
}

async function closeProjectAfterFinalSave(owner: BrowserWindow | null): Promise<Result<void>> {
  const outcome = await runFinalSaveFlow('project-close', owner)
  if (outcome === 'proceed-anyway') {
    projectLogger.warn('project closed after final save failure')
  }
  projectManager.discardCurrentProject()
  return ok(undefined)
}

async function closeWindowAfterFinalSave(win: BrowserWindow): Promise<void> {
  const outcome = await runFinalSaveFlow('window-close', win)
  if (outcome === 'proceed-anyway') {
    projectLogger.warn('window closed after final save failure')
  }
  projectManager.discardCurrentProject()
  if (win.isDestroyed()) return
  approvedWindowCloses.add(win)
  win.close()
}

async function quitAfterFinalSavePrompt(): Promise<void> {
  if (finalQuitInProgress) return
  finalQuitInProgress = true
  const outcome = await runFinalSaveFlow('quit', mainWindow ?? BrowserWindow.getFocusedWindow())
  if (outcome === 'proceed-anyway') {
    projectLogger.warn('app quit after final save failure')
  }
  quitAfterFinalSave = true
  finalQuitInProgress = false
  app.quit()
}

async function runFinalSaveFlow(
  context: FinalSaveContext,
  owner: BrowserWindow | null,
) {
  return ensureFinalProjectSave({
    context,
    window: owner,
    hasOpenProject: () => projectManager.getCurrent() !== null,
    saveProject: async () => {
      projectManager.cancelAutosave()
      return projectManager.saveProject()
    },
    showFailurePrompt: (prompt) => showFinalSaveFailurePrompt(prompt.context, prompt.message, prompt.window ?? null),
    openLogsFolder: async () => {
      await shell.openPath(logDir)
    },
  })
}

async function showFinalSaveFailurePrompt(
  context: FinalSaveContext,
  message: string,
  owner: BrowserWindow | null,
): Promise<FinalSaveFailureAction> {
  const options = finalSaveFailureDialogOptions(context, message)
  const result = owner && !owner.isDestroyed()
    ? await dialog.showMessageBox(owner, options)
    : await dialog.showMessageBox(options)
  return finalSaveFailureActionForResponse(result.response)
}

function queueOpenTarget(targetPath: string): void {
  if (!ownsSingleInstanceLock) return
  if (app.isReady()) {
    void openProjectFromOsTarget(targetPath, { notifyRenderer: true })
    return
  }
  pendingOpenTargets.push(targetPath)
}

async function drainPendingOpenTargets(): Promise<void> {
  while (pendingOpenTargets.length > 0) {
    const target = pendingOpenTargets.shift()
    if (!target) continue
    const result = await openProjectFromOsTarget(target, { notifyRenderer: false })
    if (!result.ok) {
      await dialog.showMessageBox({
        type: 'error',
        title: 'Could Not Open Project',
        message: result.error.message,
        buttons: ['OK'],
      })
    }
  }
}

async function openProjectFromOsTarget(
  targetPath: string,
  options: { notifyRenderer: boolean }
): Promise<Result<Project>> {
  const resolved = resolveProjectOpenTarget(targetPath)
  if (!resolved.ok) {
    notifyProjectOpenFromOs(resolved, options)
    return resolved
  }

  if (projectManager.getCurrent()) {
    const saved = await projectManager.saveProject()
    if (!saved.ok) {
      const failure: Result<Project> = { ok: false, error: saved.error }
      notifyProjectOpenFromOs(failure, options)
      return failure
    }
  }

  const opened = await projectManager.openProject(resolved.data)
  trackRecentProject(opened)
  notifyProjectOpenFromOs(opened, options)
  return opened
}

function openRecentProject(projectPath: string): void {
  void openProjectFromOsTarget(projectPath, { notifyRenderer: true })
}

function clearRecentProjects(): void {
  recentProjects.clear()
  app.clearRecentDocuments()
  updateApplicationMenuRecentProjects(recentProjects.all())
}

function trackRecentProject(result: Result<Project>): void {
  if (!result.ok) return
  if (typeof result.data.path !== 'string' || result.data.path.trim() === '') return
  appSettings.recordLastProject(result.data)
  recentProjects.add(result.data)
  const documentPath = getRecentDocumentPath(result.data.path)
  if (documentPath) app.addRecentDocument(documentPath)
  updateApplicationMenuRecentProjects(recentProjects.all())
}

function directoryKindForFolderDialogPurpose(purpose: FolderDialogPurpose | undefined): 'open' | 'create' | null {
  if (purpose === 'open-project') return 'open'
  if (purpose === 'create-project') return 'create'
  return null
}

function normalizeWorkspaceSettingsPatch(input: unknown): WorkspaceSettingsPatch {
  if (!input || typeof input !== 'object') return {}
  const source = input as Record<string, unknown>
  const patch: WorkspaceSettingsPatch = {}
  if (typeof source.treeWidth === 'number') patch.treeWidth = source.treeWidth
  if (typeof source.panelWidth === 'number') patch.panelWidth = source.panelWidth
  if (source.lastOpenDirectory === null || typeof source.lastOpenDirectory === 'string') {
    patch.lastOpenDirectory = source.lastOpenDirectory
  }
  if (source.lastCreateDirectory === null || typeof source.lastCreateDirectory === 'string') {
    patch.lastCreateDirectory = source.lastCreateDirectory
  }
  return patch
}

function notifyProjectOpenFromOs(
  result: Result<Project>,
  options: { notifyRenderer: boolean }
): void {
  if (!options.notifyRenderer) return
  const win = mainWindow ?? BrowserWindow.getAllWindows()[0]
  if (!win || win.isDestroyed()) {
    if (!result.ok) {
      void dialog.showMessageBox({
        type: 'error',
        title: 'Could Not Open Project',
        message: result.error.message,
        buttons: ['OK'],
      })
    }
    return
  }
  if (!result.ok) {
    void dialog.showMessageBox(win, {
      type: 'error',
      title: 'Could Not Open Project',
      message: result.error.message,
      buttons: ['OK'],
    })
  }
  win.webContents.send(IPC.PROJECT_OPENED_FROM_OS, result)
  if (result.ok) focusMainWindow()
}

function focusMainWindow(): void {
  const win = mainWindow ?? BrowserWindow.getAllWindows()[0]
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function collectOpenTargetsFromArgv(argv: string[]): string[] {
  return argv.slice(1).filter((arg, index) => {
    if (!arg || arg.startsWith('-')) return false
    return !isRuntimeEntrypointArg(arg, index)
  })
}

function isRuntimeEntrypointArg(arg: string, index: number): boolean {
  if (app.isPackaged || index !== 0) return false
  const extension = extname(arg)
  if (extension !== '.js' && extension !== '.mjs' && extension !== '.cjs') return false
  return resolve(arg).startsWith(resolve(app.getAppPath()))
}
