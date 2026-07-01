// Native app menu command contract shared by main, preload, and renderer.
// These are UI notifications, not domain IPC operations: main owns the native
// menu, while the renderer remains authoritative for view state and command
// validity.

export const MENU_COMMANDS = {
  'project:new': {
    label: 'New Project',
    accelerator: 'CommandOrControl+N',
  },
  'project:open': {
    label: 'Open Project...',
    accelerator: 'CommandOrControl+O',
  },
  'project:save': {
    label: 'Save Now',
    accelerator: 'CommandOrControl+S',
  },
  'project:close': {
    label: 'Close Project',
    accelerator: 'CommandOrControl+W',
  },
  'project:import': {
    label: 'Import...',
    accelerator: 'CommandOrControl+I',
  },
  'project:templates': {
    label: 'Templates',
    accelerator: 'CommandOrControl+Shift+T',
  },
  'project:snapshots': {
    label: 'Snapshots',
    accelerator: 'CommandOrControl+Shift+S',
  },
  'project:search': {
    label: 'Find in Tree',
    accelerator: 'CommandOrControl+F',
  },
  'compare:exit': {
    label: 'Exit Compare',
  },
  'report:copyMarkdown': {
    label: 'Copy Report as Markdown',
    accelerator: 'CommandOrControl+Shift+C',
  },
  'report:exportMarkdown': {
    label: 'Export Markdown Report...',
  },
  'report:exportCsv': {
    label: 'Export CSV Report...',
  },
  'node:addChild': {
    label: 'Add Child',
  },
  'node:rename': {
    label: 'Rename Selected',
    accelerator: 'F2',
  },
  'node:moveTo': {
    label: 'Move Selected To...',
  },
  'node:delete': {
    label: 'Delete Selected...',
  },
  'history:reindex': {
    label: 'Reindex History',
  },
} as const

export type MenuCommandId = keyof typeof MENU_COMMANDS
export type MenuCommandState = Record<MenuCommandId, boolean>

export const MENU_COMMAND_IDS = Object.keys(MENU_COMMANDS) as MenuCommandId[]

export function isMenuCommandId(value: unknown): value is MenuCommandId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(MENU_COMMANDS, value)
}

export function createDisabledMenuCommandState(): MenuCommandState {
  return Object.fromEntries(MENU_COMMAND_IDS.map(id => [id, false])) as MenuCommandState
}

export function normalizeMenuCommandState(input: unknown): MenuCommandState {
  const normalized = createDisabledMenuCommandState()
  if (!input || typeof input !== 'object') return normalized

  const source = input as Partial<Record<MenuCommandId, unknown>>
  for (const id of MENU_COMMAND_IDS) {
    normalized[id] = source[id] === true
  }
  return normalized
}
