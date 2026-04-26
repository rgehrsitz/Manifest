import { expect, test } from './fixtures'
import type { ElectronApplication, Page } from '@playwright/test'

function treeRow(page: Page, name: string) {
  return page.locator('[data-testid="tree-node"]', { hasText: name }).first()
}

async function setDialogPath(electronApp: ElectronApplication, selectedPath: string): Promise<void> {
  await electronApp.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, selectedPath)
}

async function createProjectThroughUi(
  appPage: Page,
  electronApp: ElectronApplication,
  parentDir: string,
  projectName: string,
): Promise<void> {
  await appPage.getByTestId('create-project-btn').click()
  await appPage.getByTestId('project-name-input').fill(projectName)
  await setDialogPath(electronApp, parentDir)
  await appPage.getByTestId('choose-folder-btn').click()
  await appPage.getByTestId('create-btn').click()
  await expect(appPage.getByTestId('project-view')).toBeVisible()
}

async function addChildNode(page: Page, parentName: string, childName: string): Promise<void> {
  await treeRow(page, parentName).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Add Child' }).click()
  await page.getByTestId('add-child-input').fill(childName)
  await page.getByTestId('add-child-commit').click()
  await expect(treeRow(page, childName)).toBeVisible()
}

async function openSnapshotsPanel(page: Page): Promise<void> {
  await page.getByTestId('open-snapshots-btn').click()
  await expect(page.getByTestId('snapshots-panel')).toBeVisible()
}

async function createSnapshot(page: Page, name: string): Promise<void> {
  await page.getByTestId('snapshot-name-input').fill(name)
  await page.getByTestId('create-snapshot-btn').click()
  await expect(page.getByTestId('snapshot-row').filter({ hasText: name })).toBeVisible()
}

async function closeSnapshotsPanel(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Close snapshots' }).click()
  await expect(page.getByTestId('snapshots-panel')).toHaveCount(0)
}

test('shows per-node history with creation, change, and snapshot events', async ({ appPage, electronApp, workspaceDir }) => {
  const projectName = 'History UI Lab'
  await createProjectThroughUi(appPage, electronApp, workspaceDir, projectName)
  await addChildNode(appPage, projectName, 'Server 1')

  // Select the new node so DetailPane shows it.
  await treeRow(appPage, 'Server 1').click()
  await expect(appPage.getByTestId('node-name')).toContainText('Server 1')

  // Switch to History tab. With no snapshots yet, the empty state should appear.
  await appPage.getByTestId('detail-tab-history').click()
  await expect(appPage.getByTestId('node-history-view')).toBeVisible()
  await expect(appPage.getByTestId('node-history-empty')).toBeVisible()
  await expect(appPage.getByTestId('node-history-empty')).toContainText('Server 1')

  // Switch back to Properties to take a snapshot.
  await appPage.getByTestId('detail-tab-properties').click()
  await openSnapshotsPanel(appPage)
  await createSnapshot(appPage, 'first-snap')
  await closeSnapshotsPanel(appPage)

  // History tab should now show one "Created" entry.
  await appPage.getByTestId('detail-tab-history').click()
  await expect(appPage.getByTestId('node-history-empty')).toHaveCount(0)
  const entries = appPage.getByTestId('node-history-entry')
  await expect(entries).toHaveCount(1)
  await expect(entries.first()).toContainText('Snapshot "first-snap"')
  await expect(entries.first()).toContainText('Created as "Server 1"')

  // Add a property to Server 1 via the Properties tab.
  await appPage.getByTestId('detail-tab-properties').click()
  await appPage.getByTestId('new-prop-key').fill('firmware')
  await appPage.getByTestId('new-prop-value').fill('1.2.0')
  await appPage.getByTestId('add-prop-btn').click()

  // Snapshot again.
  await openSnapshotsPanel(appPage)
  await createSnapshot(appPage, 'with-firmware')
  await closeSnapshotsPanel(appPage)

  // History should now show two entries; the second has the property change.
  await appPage.getByTestId('detail-tab-history').click()
  await expect(entries).toHaveCount(2)
  await expect(entries.nth(1)).toContainText('Snapshot "with-firmware"')
  await expect(entries.nth(1)).toContainText('Set firmware = "1.2.0"')
})
