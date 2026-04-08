// Preload script: the only bridge between renderer and main process.
// Exposes a typed, minimal API surface via contextBridge.
// Nothing outside this whitelist is accessible from the renderer.

import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type { ManifestAPI } from '../shared/ipc'

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
  },

  node: {
    create: (parentId, name) =>
      ipcRenderer.invoke(IPC.NODE_CREATE, { parentId, name }),
    update: (id, changes) =>
      ipcRenderer.invoke(IPC.NODE_UPDATE, { id, changes }),
    delete: (id) =>
      ipcRenderer.invoke(IPC.NODE_DELETE, { id }),
    move: (id, newParentId, newOrder) =>
      ipcRenderer.invoke(IPC.NODE_MOVE, { id, newParentId, newOrder }),
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
    restore: (name) =>
      ipcRenderer.invoke(IPC.SNAPSHOT_RESTORE, { name }),
  },

  git: {
    check: () =>
      ipcRenderer.invoke(IPC.GIT_CHECK, {}),
  },

  dialog: {
    openFolder: (title) =>
      ipcRenderer.invoke(IPC.DIALOG_OPEN_FOLDER, { title }),
  },
}

contextBridge.exposeInMainWorld('api', api)
