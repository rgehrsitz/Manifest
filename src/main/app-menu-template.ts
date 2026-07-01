import type { MenuItemConstructorOptions } from 'electron'
import { MENU_COMMANDS, type MenuCommandId } from '../shared/menu-commands'
import type { RecentProjectMenuEntry } from './recent-projects'

export interface AppMenuTemplateOptions {
  platform: NodeJS.Platform
  isDev: boolean
  appName: string
  recentProjects: RecentProjectMenuEntry[]
  dispatch(command: MenuCommandId): void
  openRecentProject(path: string): void
  clearRecentProjects(): void
  openPreferences(): void
  openDocumentation(): void
  reportIssue(): void
  openLogsFolder(): void
  copyDiagnostics(): void
}

function commandItem(command: MenuCommandId, dispatch: (command: MenuCommandId) => void): MenuItemConstructorOptions {
  const definition = MENU_COMMANDS[command]
  return {
    id: command,
    label: definition.label,
    accelerator: 'accelerator' in definition ? definition.accelerator : undefined,
    enabled: false,
    click: () => dispatch(command),
  }
}

function separator(): MenuItemConstructorOptions {
  return { type: 'separator' }
}

function recentProjectsSubmenu(options: AppMenuTemplateOptions): MenuItemConstructorOptions[] {
  const entries = options.recentProjects.map(entry => ({
    label: entry.exists ? entry.name : `${entry.name} (Missing)`,
    sublabel: entry.path,
    enabled: entry.exists,
    click: () => options.openRecentProject(entry.path),
  } satisfies MenuItemConstructorOptions))

  if (entries.length === 0) {
    return [
      { label: 'No Recent Projects', enabled: false },
      separator(),
      { label: 'Clear Menu', enabled: false },
    ]
  }

  return [
    ...entries,
    separator(),
    {
      label: 'Clear Menu',
      click: options.clearRecentProjects,
    },
  ]
}

export function buildAppMenuTemplate(options: AppMenuTemplateOptions): MenuItemConstructorOptions[] {
  const isMac = options.platform === 'darwin'
  const template: MenuItemConstructorOptions[] = []

  if (isMac) {
    template.push({
      label: options.appName,
      submenu: [
        { role: 'about' },
        {
          label: 'Settings...',
          accelerator: 'Command+,',
          click: options.openPreferences,
        },
        separator(),
        { role: 'services' },
        separator(),
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        separator(),
        { role: 'quit' },
      ],
    })
  }

  template.push({
    label: 'File',
    submenu: [
      commandItem('project:new', options.dispatch),
      commandItem('project:open', options.dispatch),
      {
        label: 'Open Recent',
        submenu: recentProjectsSubmenu(options),
      },
      separator(),
      commandItem('project:save', options.dispatch),
      commandItem('project:close', options.dispatch),
      separator(),
      commandItem('project:import', options.dispatch),
      separator(),
      {
        label: 'Export Report',
        submenu: [
          commandItem('report:exportMarkdown', options.dispatch),
          commandItem('report:exportCsv', options.dispatch),
        ],
      },
      commandItem('report:copyMarkdown', options.dispatch),
      ...(isMac
        ? []
        : [
            separator(),
            {
              label: 'Settings...',
              accelerator: 'Control+,',
              click: options.openPreferences,
            } satisfies MenuItemConstructorOptions,
            separator(),
            { role: 'quit' } satisfies MenuItemConstructorOptions,
          ]),
    ],
  })

  template.push({
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      separator(),
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      ...(isMac
        ? [
            { role: 'pasteAndMatchStyle' } satisfies MenuItemConstructorOptions,
            { role: 'delete' } satisfies MenuItemConstructorOptions,
          ]
        : [
            { role: 'delete' } satisfies MenuItemConstructorOptions,
          ]),
      { role: 'selectAll' },
      separator(),
      commandItem('project:search', options.dispatch),
    ],
  })

  template.push({
    label: 'View',
    submenu: [
      commandItem('project:templates', options.dispatch),
      commandItem('project:snapshots', options.dispatch),
      commandItem('compare:exit', options.dispatch),
      separator(),
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      ...(options.isDev
        ? [
            separator(),
            { role: 'reload' } satisfies MenuItemConstructorOptions,
            { role: 'toggleDevTools' } satisfies MenuItemConstructorOptions,
          ]
        : []),
    ],
  })

  template.push({
    label: 'Project',
    submenu: [
      commandItem('node:addChild', options.dispatch),
      commandItem('node:rename', options.dispatch),
      commandItem('node:moveTo', options.dispatch),
      commandItem('node:delete', options.dispatch),
      separator(),
      commandItem('history:reindex', options.dispatch),
    ],
  })

  template.push({
    label: 'Window',
    submenu: [
      { role: 'minimize' },
      { role: 'zoom' },
      ...(isMac
        ? [
            separator(),
            { role: 'front' } satisfies MenuItemConstructorOptions,
            separator(),
            { role: 'window' } satisfies MenuItemConstructorOptions,
          ]
        : []),
    ],
  })

  template.push({
    label: 'Help',
    submenu: [
      {
        label: 'Manifest Documentation',
        click: options.openDocumentation,
      },
      {
        label: 'Report an Issue...',
        click: options.reportIssue,
      },
      separator(),
      {
        label: 'Open Logs Folder',
        click: options.openLogsFolder,
      },
      {
        label: 'Copy Diagnostics',
        click: options.copyDiagnostics,
      },
      ...(isMac ? [] : [separator(), { role: 'about' } satisfies MenuItemConstructorOptions]),
    ],
  })

  return template
}
