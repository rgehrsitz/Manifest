import { join } from 'path'
import type { ElectronApplication, Page } from '@playwright/test'
import { expect, test } from './fixtures'
import type { MenuCommandId } from '../../src/shared/menu-commands'

async function menuEnabled(electronApp: ElectronApplication, command: MenuCommandId): Promise<boolean | null> {
  return electronApp.evaluate(({ Menu }, id) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(id)
    return item ? item.enabled : null
  }, command)
}

async function clickMenuCommand(electronApp: ElectronApplication, command: MenuCommandId): Promise<void> {
  await electronApp.evaluate(({ BrowserWindow, Menu }, id) => {
    const menu = Menu.getApplicationMenu()
    const item = menu?.getMenuItemById(id)
    const win = BrowserWindow.getAllWindows()[0]
    if (!item || !win) throw new Error(`Menu command not found: ${id}`)
    item.click(item, win, undefined as never)
  }, command)
}

async function createProjectThroughUi(
  appPage: Page,
  electronApp: ElectronApplication,
  parentDir: string,
  projectName: string,
): Promise<string> {
  await appPage.getByTestId('create-project-btn').click()
  await appPage.getByTestId('project-name-input').fill(projectName)

  await electronApp.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [path],
    })
  }, parentDir)
  await appPage.getByTestId('choose-folder-btn').click()
  await appPage.getByTestId('create-btn').click()
  await expect(appPage.getByTestId('project-view')).toBeVisible()

  return join(parentDir, projectName)
}

test('native menu starts with renderer-dependent project commands disabled', async ({ appPage, electronApp }) => {
  await expect(appPage.getByTestId('open-project-btn')).toBeVisible()
  await expect.poll(() => menuEnabled(electronApp, 'project:new')).toBe(true)
  await expect.poll(() => menuEnabled(electronApp, 'project:open')).toBe(true)

  expect(await menuEnabled(electronApp, 'project:save')).toBe(false)
  expect(await menuEnabled(electronApp, 'project:close')).toBe(false)
  expect(await menuEnabled(electronApp, 'node:addChild')).toBe(false)
  expect(await menuEnabled(electronApp, 'node:delete')).toBe(false)
  expect(await menuEnabled(electronApp, 'report:exportMarkdown')).toBe(false)

  await clickMenuCommand(electronApp, 'project:save')
  await expect(appPage.getByTestId('open-project-btn')).toBeVisible()
})

test('native menu dispatches enabled commands to renderer handlers', async ({ appPage, electronApp, workspaceDir }) => {
  await createProjectThroughUi(appPage, electronApp, workspaceDir, 'Menu Dispatch Lab')

  await expect.poll(() => menuEnabled(electronApp, 'project:save')).toBe(true)
  expect(await menuEnabled(electronApp, 'project:close')).toBe(true)
  expect(await menuEnabled(electronApp, 'project:search')).toBe(true)
  expect(await menuEnabled(electronApp, 'node:addChild')).toBe(true)
  expect(await menuEnabled(electronApp, 'node:delete')).toBe(false)

  await clickMenuCommand(electronApp, 'project:search')
  await expect(appPage.getByTestId('search-input')).toBeFocused()

  await clickMenuCommand(electronApp, 'node:addChild')
  await expect(appPage.getByTestId('add-child-input')).toBeVisible()

  await clickMenuCommand(electronApp, 'project:close')
  await expect(appPage.getByTestId('open-project-btn')).toBeVisible()
  await expect.poll(() => menuEnabled(electronApp, 'project:save')).toBe(false)
})
