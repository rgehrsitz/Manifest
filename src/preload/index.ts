// Preload script: the only bridge between renderer and main process.
// Exposes a typed, minimal API surface via contextBridge.
// Nothing outside this whitelist is accessible from the renderer.

import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type { ManifestAPI } from '../shared/ipc'
import { isMenuCommandId } from '../shared/menu-commands'

const api: ManifestAPI = {
  project: {
    create: (name, parentPath) =>
      ipcRenderer.invoke(IPC.PROJECT_CREATE, { name, parentPath }),
    open: (path) =>
      ipcRenderer.invoke(IPC.PROJECT_OPEN, { path }),
    save: () =>
      ipcRenderer.invoke(IPC.PROJECT_SAVE),
    getCurrent: () =>
      ipcRenderer.invoke(IPC.PROJECT_GET_CURRENT),
    close: () =>
      ipcRenderer.invoke(IPC.PROJECT_CLOSE),
    onOpenedFromOs: (handler) => {
      const listener = (_event: Electron.IpcRendererEvent, result: unknown) => {
        handler(result as Awaited<ReturnType<ManifestAPI['project']['open']>>)
      }
      ipcRenderer.on(IPC.PROJECT_OPENED_FROM_OS, listener)
      return () => {
        ipcRenderer.removeListener(IPC.PROJECT_OPENED_FROM_OS, listener)
      }
    },
  },

  node: {
    create: (parentId, name, templateId) =>
      ipcRenderer.invoke(IPC.NODE_CREATE, { parentId, name, templateId }),
    update: (id, changes) =>
      ipcRenderer.invoke(IPC.NODE_UPDATE, { id, changes }),
    delete: (id, options) =>
      ipcRenderer.invoke(IPC.NODE_DELETE, { id, options }),
    move: (id, newParentId, newOrder) =>
      ipcRenderer.invoke(IPC.NODE_MOVE, { id, newParentId, newOrder }),
    history: (nodeId) =>
      ipcRenderer.invoke(IPC.NODE_HISTORY, { nodeId }),
    historyBackfillStatus: () =>
      ipcRenderer.invoke(IPC.NODE_HISTORY_BACKFILL_STATUS, {}),
    historyReindex: () =>
      ipcRenderer.invoke(IPC.NODE_HISTORY_REINDEX, {}),
  },

  template: {
    create: (id, template) =>
      ipcRenderer.invoke(IPC.TEMPLATE_CREATE, { id, template }),
    update: (id, changes) =>
      ipcRenderer.invoke(IPC.TEMPLATE_UPDATE, { id, changes }),
    delete: (id) =>
      ipcRenderer.invoke(IPC.TEMPLATE_DELETE, { id }),
  },

  import: {
    inspect: (path) =>
      ipcRenderer.invoke(IPC.IMPORT_INSPECT, { path }),
    plan: (path, mapping) =>
      ipcRenderer.invoke(IPC.IMPORT_PLAN, { path, mapping }),
    apply: (path, mapping) =>
      ipcRenderer.invoke(IPC.IMPORT_APPLY, { path, mapping }),
    netboxInspect: (path) =>
      ipcRenderer.invoke(IPC.IMPORT_NETBOX_INSPECT, { path }),
    netboxPlan: (path, options) =>
      ipcRenderer.invoke(IPC.IMPORT_NETBOX_PLAN, { path, options }),
    netboxApply: (path, options) =>
      ipcRenderer.invoke(IPC.IMPORT_NETBOX_APPLY, { path, options }),
  },

  search: {
    query: (query) =>
      ipcRenderer.invoke(IPC.SEARCH_QUERY, { query }),
  },

  snapshot: {
    create: (name) =>
      ipcRenderer.invoke(IPC.SNAPSHOT_CREATE, { name }),
    list: () =>
      ipcRenderer.invoke(IPC.SNAPSHOT_LIST, {}),
    compare: (a, b) =>
      ipcRenderer.invoke(IPC.SNAPSHOT_COMPARE, { a, b }),
    loadCompare: (a, b) =>
      ipcRenderer.invoke(IPC.SNAPSHOT_LOAD_COMPARE, { a, b }),
    revert: (request) =>
      ipcRenderer.invoke(IPC.SNAPSHOT_REVERT, request),
    timeline: () =>
      ipcRenderer.invoke(IPC.SNAPSHOT_TIMELINE, {}),
    applyRecovery: (request) =>
      ipcRenderer.invoke(IPC.RECOVERY_APPLY, request),
  },

  git: {
    check: () =>
      ipcRenderer.invoke(IPC.GIT_CHECK, {}),
  },

  report: {
    export: (from, to, format) =>
      ipcRenderer.invoke(IPC.REPORT_EXPORT, { from, to, format }),
    build: (from, to, format) =>
      ipcRenderer.invoke(IPC.REPORT_BUILD, { from, to, format }),
  },

  dialog: {
    openFolder: (title) =>
      ipcRenderer.invoke(IPC.DIALOG_OPEN_FOLDER, { title }),
    openFile: (title) =>
      ipcRenderer.invoke(IPC.DIALOG_OPEN_FILE, { title }),
  },

  menu: {
    onCommand: (handler) => {
      const listener = (_event: Electron.IpcRendererEvent, command: unknown) => {
        if (isMenuCommandId(command)) handler(command)
      }
      ipcRenderer.on(IPC.MENU_COMMAND, listener)
      return () => {
        ipcRenderer.removeListener(IPC.MENU_COMMAND, listener)
      }
    },
    updateState: (state) =>
      ipcRenderer.send(IPC.MENU_STATE_UPDATE, state),
  },
}

contextBridge.exposeInMainWorld('api', api)
