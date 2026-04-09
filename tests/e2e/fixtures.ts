import { _electron as electron, expect, test as base, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const ROOT_DIR = process.cwd()
const MAIN_ENTRY = join(ROOT_DIR, 'out', 'main', 'index.js')

type ManifestFixtures = {
  electronApp: ElectronApplication
  appPage: Page
  workspaceDir: string
}

export const test = base.extend<ManifestFixtures>({
  workspaceDir: async ({}, use) => {
    const dir = mkdtempSync(join(tmpdir(), 'manifest-e2e-'))
    try {
      await use(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },

  electronApp: async ({}, use) => {
    if (!existsSync(MAIN_ENTRY)) {
      throw new Error(`Built Electron entrypoint not found at ${MAIN_ENTRY}. Run "bun run build" first.`)
    }

    const electronApp = await electron.launch({
      args: [MAIN_ENTRY],
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        NODE_ENV: 'test',
      },
    })

    try {
      await use(electronApp)
    } finally {
      await electronApp.close()
    }
  },

  appPage: async ({ electronApp }, use) => {
    const page = await electronApp.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTestId('create-project-btn')).toBeVisible()
    await use(page)
  },
})

export { expect }
