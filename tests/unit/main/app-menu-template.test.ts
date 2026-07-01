import { describe, expect, it } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import { buildAppMenuTemplate } from '../../../src/main/app-menu-template'
import { MENU_COMMAND_IDS, type MenuCommandId } from '../../../src/shared/menu-commands'

function templateFor(platform: NodeJS.Platform, isDev = false): MenuItemConstructorOptions[] {
  return buildAppMenuTemplate({
    platform,
    isDev,
    appName: 'Manifest',
    dispatch: () => {},
    openLogsFolder: () => {},
  })
}

function submenu(item: MenuItemConstructorOptions): MenuItemConstructorOptions[] {
  return Array.isArray(item.submenu) ? item.submenu : []
}

function flatten(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  const all: MenuItemConstructorOptions[] = []
  for (const item of items) {
    all.push(item)
    all.push(...flatten(submenu(item)))
  }
  return all
}

describe('buildAppMenuTemplate', () => {
  it('uses a macOS app menu and omits File quit on darwin', () => {
    const template = templateFor('darwin')
    const labels = template.map(item => item.label)
    const fileMenu = template.find(item => item.label === 'File')

    expect(labels[0]).toBe('Manifest')
    expect(submenu(fileMenu!).some(item => item.role === 'quit')).toBe(false)
    expect(submenu(template[0]!).some(item => item.role === 'quit')).toBe(true)
  })

  it('puts quit under File on non-mac platforms', () => {
    const template = templateFor('win32')
    const labels = template.map(item => item.label)
    const fileMenu = template.find(item => item.label === 'File')

    expect(labels[0]).toBe('File')
    expect(submenu(fileMenu!).some(item => item.role === 'quit')).toBe(true)
  })

  it('renders every shared command exactly once and disabled by default', () => {
    const commands = flatten(templateFor('linux'))
      .filter(item => typeof item.id === 'string' && MENU_COMMAND_IDS.includes(item.id as MenuCommandId))

    expect(commands.map(item => item.id).sort()).toEqual([...MENU_COMMAND_IDS].sort())
    expect(commands.every(item => item.enabled === false)).toBe(true)
  })

  it('gates reload and devtools to development menus', () => {
    const productionRoles = flatten(templateFor('linux', false)).map(item => item.role)
    const devRoles = flatten(templateFor('linux', true)).map(item => item.role)

    expect(productionRoles).not.toContain('reload')
    expect(productionRoles).not.toContain('toggleDevTools')
    expect(devRoles).toContain('reload')
    expect(devRoles).toContain('toggleDevTools')
  })
})
