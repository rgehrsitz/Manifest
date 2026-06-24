import { readFileSync } from 'fs'
import { join } from 'path'
import { expect, test } from './fixtures'

import type { ElectronApplication, Page } from '@playwright/test'

function treeRow(page: Page, name: string) {
  return page.locator('[data-testid="tree-node"]', { hasText: name }).first()
}

async function openContextMenuAction(page: Page, nodeName: string, actionLabel: string): Promise<void> {
  await treeRow(page, nodeName).click({ button: 'right' })
  await page.getByRole('menuitem', { name: actionLabel }).click()
}

async function setDialogPath(electronApp: ElectronApplication, path: string): Promise<void> {
  await electronApp.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] })
  }, path)
}

async function setSaveDialogPath(electronApp: ElectronApplication, path: string): Promise<void> {
  await electronApp.evaluate(({ dialog }, p) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: p })
  }, path)
}

async function setSaveDialogCanceled(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(({ dialog }) => {
    dialog.showSaveDialog = async () => ({ canceled: true, filePath: undefined })
  })
}

async function createProjectThroughUi(appPage: Page, electronApp: ElectronApplication, parentDir: string, name: string): Promise<void> {
  await appPage.getByTestId('create-project-btn').click()
  await appPage.getByTestId('project-name-input').fill(name)
  await setDialogPath(electronApp, parentDir)
  await appPage.getByTestId('choose-folder-btn').click()
  await appPage.getByTestId('create-btn').click()
  await expect(appPage.getByTestId('project-view')).toBeVisible()
}

async function createSnapshot(appPage: Page, name: string): Promise<void> {
  await appPage.getByTestId('snapshot-name-input').fill(name)
  await appPage.getByTestId('create-snapshot-btn').click()
  await expect(appPage.getByTestId('snapshot-row').filter({ hasText: name })).toBeVisible()
}

// Set up a project with a before→after diff (one added node), loaded into compare.
async function setUpCompare(appPage: Page, electronApp: ElectronApplication, workspaceDir: string, projectName: string): Promise<void> {
  await createProjectThroughUi(appPage, electronApp, workspaceDir, projectName)
  await appPage.getByTestId('open-snapshots-btn').click()
  await createSnapshot(appPage, 'before')

  await openContextMenuAction(appPage, projectName, 'Add Child')
  await appPage.getByTestId('add-child-input').fill('Widget')
  await appPage.getByTestId('add-child-commit').click()
  await expect(treeRow(appPage, 'Widget')).toBeVisible()

  await createSnapshot(appPage, 'after')
  await appPage.getByTestId('compare-from-select').selectOption('before')
  await appPage.getByTestId('compare-to-select').selectOption('after')
  await appPage.getByTestId('compare-snapshots-btn').click()
  await expect(appPage.getByTestId('snapshot-diff-list')).toBeVisible()
}

test('exports a CSV report of the snapshot diff', async ({ appPage, electronApp, workspaceDir }) => {
  await setUpCompare(appPage, electronApp, workspaceDir, 'CSV Report Lab')

  const outPath = join(workspaceDir, 'report.csv')
  await setSaveDialogPath(electronApp, outPath)
  await appPage.getByTestId('report-export-csv').click()
  await expect(appPage.getByTestId('toast')).toContainText('Report saved')

  const csv = readFileSync(outPath, 'utf8')
  expect(csv).toContain('path,node,change,severity,property,old,new,removed_descendants,broken_references')
  expect(csv).toContain('Widget')   // the added node appears in the diff
  expect(csv).toContain('added')
})

test('exports a Markdown report of the snapshot diff', async ({ appPage, electronApp, workspaceDir }) => {
  await setUpCompare(appPage, electronApp, workspaceDir, 'MD Report Lab')

  const outPath = join(workspaceDir, 'report.md')
  await setSaveDialogPath(electronApp, outPath)
  await appPage.getByTestId('report-export-md').click()
  await expect(appPage.getByTestId('toast')).toContainText('Report saved')

  const md = readFileSync(outPath, 'utf8')
  expect(md).toContain('# Change Report: MD Report Lab')
  expect(md).toContain('## Added (1)')
  expect(md).toContain('Widget')
})

test('a canceled save dialog is a silent no-op', async ({ appPage, electronApp, workspaceDir }) => {
  await setUpCompare(appPage, electronApp, workspaceDir, 'Cancel Report Lab')
  await setSaveDialogCanceled(electronApp)
  await appPage.getByTestId('report-export-csv').click()
  // No "Report saved" toast; compare view still present and usable.
  await expect(appPage.getByTestId('toast')).toHaveCount(0)
  await expect(appPage.getByTestId('report-export-csv')).toBeEnabled()
})

test('a write failure surfaces an error toast (no silent failure)', async ({ appPage, electronApp, workspaceDir }) => {
  await setUpCompare(appPage, electronApp, workspaceDir, 'Write Fail Lab')
  // Save into a directory that does not exist → writeFile throws → REPORT_WRITE_FAILED.
  await setSaveDialogPath(electronApp, join(workspaceDir, 'no-such-dir', 'report.csv'))
  await appPage.getByTestId('report-export-csv').click()
  await expect(appPage.getByTestId('toast')).toContainText('Export failed')
})

test('copy-as-Markdown builds report content', async ({ appPage, electronApp, workspaceDir }) => {
  await setUpCompare(appPage, electronApp, workspaceDir, 'Copy Report Lab')

  // The build IPC (used by Copy MD) returns the markdown content for the clipboard.
  const content = await appPage.evaluate(async () => {
    const res = await window.api.report.build('before', 'after', 'markdown')
    return res.ok ? res.data.content : `ERR:${res.error.message}`
  })
  expect(content).toContain('# Change Report: Copy Report Lab')
  expect(content).toContain('Widget')

  // Clicking the button does not crash (clipboard may be denied headless → toast).
  await appPage.getByTestId('report-copy-md').click()
})

test('report actions lock while an export is in flight', async ({ appPage, electronApp, workspaceDir }) => {
  await setUpCompare(appPage, electronApp, workspaceDir, 'Busy Report Lab')

  const outPath = join(workspaceDir, 'busy-report.md')
  await electronApp.evaluate(({ dialog }, path) => {
    const state = {} as {
      calls: number
      release: () => void
    }
    state.calls = 0
    dialog.showSaveDialog = async () => {
      state.calls++
      return new Promise((resolve) => {
        state.release = () => resolve({ canceled: false, filePath: path })
      })
    }
    ;(globalThis as unknown as { __reportSaveDialogTest: typeof state }).__reportSaveDialogTest = state
  }, outPath)

  await appPage.getByTestId('report-export-md').click()
  await expect(appPage.getByTestId('report-copy-md')).toBeDisabled()
  await expect(appPage.getByTestId('report-export-md')).toBeDisabled()
  await expect(appPage.getByTestId('report-export-csv')).toBeDisabled()
  await expect.poll(async () => electronApp.evaluate(() => (
    (globalThis as unknown as { __reportSaveDialogTest: { calls: number } }).__reportSaveDialogTest.calls
  ))).toBe(1)

  await electronApp.evaluate(() => {
    (globalThis as unknown as { __reportSaveDialogTest: { release: () => void } }).__reportSaveDialogTest.release()
  })
  await expect(appPage.getByTestId('toast')).toContainText('Report saved')
  await expect(appPage.getByTestId('report-export-md')).toBeEnabled()
  await expect(appPage.getByTestId('report-export-csv')).toBeEnabled()
  await expect(appPage.getByTestId('report-copy-md')).toBeEnabled()

  const md = readFileSync(outPath, 'utf8')
  expect(md).toContain('# Change Report: Busy Report Lab')
})
