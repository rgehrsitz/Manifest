import { execFileSync } from 'child_process'
import { expect, test } from './fixtures'
import { CURRENT_PROJECT_REF } from '../../src/shared/snapshot-ref'

import type { ElectronApplication, Page } from '@playwright/test'

function treeRow(page: Page, name: string) {
  return page.locator('[data-testid="tree-node"]', { hasText: name }).first()
}

async function setDialogPath(electronApp: ElectronApplication, selectedPath: string): Promise<void> {
  await electronApp.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [path],
    })
  }, selectedPath)
}

async function createProjectThroughUi(
  appPage: Page,
  electronApp: ElectronApplication,
  parentDir: string,
  projectName: string
): Promise<void> {
  await appPage.getByTestId('create-project-btn').click()
  await appPage.getByTestId('project-name-input').fill(projectName)

  await setDialogPath(electronApp, parentDir)
  await appPage.getByTestId('choose-folder-btn').click()
  await appPage.getByTestId('create-btn').click()
  await expect(appPage.getByTestId('project-view')).toBeVisible()
}

async function openProjectThroughUi(
  appPage: Page,
  electronApp: ElectronApplication,
  projectDir: string
): Promise<void> {
  await setDialogPath(electronApp, projectDir)
  await appPage.getByTestId('open-project-btn').click()
  await expect(appPage.getByTestId('project-view')).toBeVisible()
}

async function openContextMenuAction(page: Page, nodeName: string, actionLabel: string): Promise<void> {
  await treeRow(page, nodeName).click({ button: 'right' })
  await page.getByRole('menuitem', { name: actionLabel }).click()
}

async function addChildNode(page: Page, parentName: string, childName: string): Promise<void> {
  await openContextMenuAction(page, parentName, 'Add Child')
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

async function compareSnapshots(page: Page, from: string, to: string): Promise<void> {
  await page.getByTestId('compare-from-select').selectOption(from)
  await page.getByTestId('compare-to-select').selectOption(to)
  await expect(page.getByTestId('compare-snapshots-btn')).toBeEnabled()
  await page.getByTestId('compare-snapshots-btn').click()
  await expect(page.getByTestId('snapshot-diff-list')).toBeVisible()
}

test('creates, compares, and reverts snapshots from the renderer surface', async ({ appPage, electronApp, workspaceDir }) => {
  const projectName = 'Snapshot UI Lab'

  await createProjectThroughUi(appPage, electronApp, workspaceDir, projectName)

  await openSnapshotsPanel(appPage)
  await expect(appPage.getByTestId('project-mode-badge')).toHaveText('Current Project')
  await expect(appPage.getByText('Timeline, checkpoints, and semantic diffs.')).toBeVisible()
  await expect(appPage.getByText('Current State', { exact: true })).toHaveCount(0)
  await expect(treeRow(appPage, projectName)).toBeVisible()

  await createSnapshot(appPage, 'baseline')
  await expect(appPage.getByTestId('project-mode-badge')).toHaveText('Current project matches baseline')
  await expect(appPage.getByTestId('snapshot-timeline-event').filter({ hasText: 'Saved snapshot "baseline"' })).toBeVisible()

  await appPage.getByRole('button', { name: 'Close snapshots' }).click()
  await expect(appPage.getByTestId('snapshots-panel')).toHaveCount(0)

  await addChildNode(appPage, projectName, 'Rack A')
  await expect(appPage.getByTestId('project-mode-badge')).toHaveText('Unsnapshotted changes')

  await openSnapshotsPanel(appPage)
  await createSnapshot(appPage, 'with-rack')
  await expect(appPage.getByTestId('project-mode-badge')).toHaveText('Current project matches with-rack')
  await compareSnapshots(appPage, 'baseline', 'with-rack')

  await expect(appPage.getByTestId('project-mode-badge')).toHaveText('Comparing baseline -> with-rack')
  await expect(appPage.getByTestId('snapshot-timeline')).toHaveCount(0)
  await expect(appPage.getByTestId('snapshot-name-input')).toHaveCount(0)
  await expect(appPage.getByTestId('compare-from-select')).toHaveCount(0)
  await expect(appPage.getByTestId('detail-readonly-banner')).toContainText('Snapshots are read-only')
  await expect(appPage.getByTestId('snapshot-diff-row').filter({ hasText: 'Added' })).toBeVisible()
  await expect(appPage.getByTestId('snapshot-diff-row').filter({ hasText: 'Rack A' })).toBeVisible()
  await expect(treeRow(appPage, 'Rack A')).toBeVisible()

  await appPage.getByRole('button', { name: 'Exit compare' }).click()
  await expect(appPage.getByTestId('snapshot-diff-list')).toHaveCount(0)
  await expect(appPage.getByTestId('snapshot-timeline')).toBeVisible()
  await expect(appPage.getByTestId('compare-from-select')).toBeVisible()
  await expect(appPage.getByTestId('project-mode-badge')).toHaveText('Current project matches with-rack')
  await addChildNode(appPage, projectName, 'Temporary Probe')
  await expect(appPage.getByTestId('project-mode-badge')).toHaveText('Unsnapshotted changes')

  await appPage
    .getByRole('button', { name: 'Revert Current Project to This Snapshot: baseline' })
    .click()
  await expect(appPage.getByTestId('revert-dialog')).toBeVisible()
  await appPage.getByTestId('revert-confirm-btn').click()
  await expect(appPage.getByTestId('revert-dialog-error')).toContainText('revert note is required')
  await appPage.getByTestId('revert-note-input').fill('Rolled back to retry the lab test')
  await appPage.getByTestId('revert-confirm-btn').click()
  await expect(appPage.getByTestId('revert-dialog')).toHaveCount(0)

  await expect(appPage.getByTestId('snapshot-diff-list')).toHaveCount(0)
  await expect(appPage.getByTestId('project-mode-badge')).toHaveText('Current project matches baseline')
  await expect(appPage.getByTestId('snapshots-panel')).toBeVisible()
  await expect(appPage.getByTestId('snapshot-timeline-event').filter({ hasText: 'Reverted current project to "baseline"' })).toBeVisible()
  await expect(appPage.getByText('Rolled back to retry the lab test')).toBeVisible()
  await expect(appPage.getByTestId('compare-from-select')).toBeVisible()
  await expect(treeRow(appPage, 'Rack A')).toHaveCount(0)
  await expect(treeRow(appPage, 'Temporary Probe')).toHaveCount(0)

  await appPage
    .getByTestId('snapshot-timeline-event')
    .filter({ hasText: 'Reverted current project to "baseline"' })
    .getByTestId('apply-recovery-btn')
    .click()
  await expect(appPage.getByTestId('recovery-dialog')).toBeVisible()
  await appPage.getByTestId('recovery-confirm-btn').click()
  await expect(appPage.getByTestId('recovery-dialog')).toHaveCount(0)
  await expect(appPage.getByTestId('project-mode-badge')).toHaveText('Unsnapshotted changes')
  await expect(treeRow(appPage, 'Rack A')).toBeVisible()
  await expect(treeRow(appPage, 'Temporary Probe')).toBeVisible()
  await expect(appPage.getByTestId('snapshot-timeline-event').filter({ hasText: 'Recovered current project from a recovery point' })).toBeVisible()
})

test('top-bar snapshots button toggles panel open and closed', async ({ appPage, electronApp, workspaceDir }) => {
  const projectName = 'Snapshots Toggle Lab'

  await createProjectThroughUi(appPage, electronApp, workspaceDir, projectName)

  const toggle = appPage.getByTestId('open-snapshots-btn')
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expect(appPage.getByTestId('snapshots-panel')).toHaveCount(0)

  await toggle.click()
  await expect(appPage.getByTestId('snapshots-panel')).toBeVisible()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')

  await toggle.click()
  await expect(appPage.getByTestId('snapshots-panel')).toHaveCount(0)
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
})

test('surfaces removed nodes in snapshot compare mode', async ({ appPage, electronApp, workspaceDir }) => {
  const projectName = 'Removal Compare Lab'

  await createProjectThroughUi(appPage, electronApp, workspaceDir, projectName)
  await addChildNode(appPage, projectName, 'Rack A')

  await openSnapshotsPanel(appPage)
  await createSnapshot(appPage, 'with-rack')

  await appPage.getByRole('button', { name: 'Close snapshots' }).click()
  appPage.once('dialog', (dialog) => dialog.accept())
  await openContextMenuAction(appPage, 'Rack A', 'Delete…')
  await expect(treeRow(appPage, 'Rack A')).toHaveCount(0)

  await openSnapshotsPanel(appPage)
  await createSnapshot(appPage, 'without-rack')
  await compareSnapshots(appPage, 'with-rack', 'without-rack')

  const removedRow = appPage.getByTestId('snapshot-diff-row').filter({ hasText: 'Removed' })
  await expect(removedRow).toBeVisible()
  await expect(removedRow).toContainText('Rack A')

  await removedRow.click()
  await expect(appPage.locator('[data-testid="tree-node"][data-row-status="removed"]', { hasText: 'Rack A' })).toBeVisible()
})

test('surfaces property-only snapshot diffs', async ({ appPage, electronApp, workspaceDir }) => {
  const projectName = 'Property Compare Lab'

  await createProjectThroughUi(appPage, electronApp, workspaceDir, projectName)
  await addChildNode(appPage, projectName, 'Rack A')

  await openSnapshotsPanel(appPage)
  await createSnapshot(appPage, 'baseline')

  await treeRow(appPage, 'Rack A').click()
  await appPage.getByTestId('new-prop-key').fill('serial')
  await appPage.getByTestId('new-prop-value').fill('SN-42')
  await appPage.getByTestId('add-prop-btn').click()
  await expect(appPage.getByTestId('prop-value').filter({ hasText: 'SN-42' })).toBeVisible()

  await createSnapshot(appPage, 'tagged')
  await compareSnapshots(appPage, 'baseline', 'tagged')

  const propertyRow = appPage.getByTestId('snapshot-diff-row').filter({ hasText: 'Property Changed' })
  await expect(propertyRow).toBeVisible()
  await expect(propertyRow).toContainText('Rack A')
  await expect(propertyRow.getByTestId('diff-severity-reason')).toContainText('Medium: field "serial" changed.')
  await expect(propertyRow).toContainText('Added serial: SN-42')
  await expect(appPage.getByTestId('compare-filter-all')).toHaveText('All 1')
  await expect(appPage.getByTestId('compare-filter-medium')).toHaveText('Medium 1')

  await appPage.getByTestId('compare-filter-high').click()
  await expect(appPage.getByTestId('snapshot-diff-row')).toHaveCount(0)
  await expect(appPage.getByTestId('compare-filter-empty')).toContainText('No high changes')

  await appPage.getByTestId('compare-filter-all').click()
  await expect(propertyRow).toBeVisible()

  await propertyRow.click()
  await expect(appPage.locator('[data-testid="tree-node"][data-row-status="property-changed"]', { hasText: 'Rack A' })).toBeVisible()
})

test('surfaces order-only snapshot diffs', async ({ appPage, electronApp, workspaceDir }) => {
  const projectName = 'Order Compare Lab'

  await createProjectThroughUi(appPage, electronApp, workspaceDir, projectName)
  await addChildNode(appPage, projectName, 'Alpha')
  await addChildNode(appPage, projectName, 'Beta')
  await addChildNode(appPage, projectName, 'Gamma')

  await openSnapshotsPanel(appPage)
  await createSnapshot(appPage, 'baseline')

  await openContextMenuAction(appPage, 'Gamma', 'Move Up ↑')
  await createSnapshot(appPage, 'reordered')
  await compareSnapshots(appPage, 'baseline', 'reordered')

  const orderRows = appPage.getByTestId('snapshot-diff-row').filter({ hasText: 'Order Changed' })
  await expect(orderRows).toHaveCount(2)
  await expect(orderRows.filter({ hasText: 'Gamma' })).toBeVisible()
  await expect(orderRows.filter({ hasText: 'Beta' })).toBeVisible()
  await expect(appPage.locator('[data-testid="tree-node"][data-row-status="order-changed"]')).toHaveCount(2)
})

test('surfaces move and rename snapshot diffs for the same node', async ({ appPage, electronApp, workspaceDir }) => {
  const projectName = 'Move Rename Lab'

  await createProjectThroughUi(appPage, electronApp, workspaceDir, projectName)
  await addChildNode(appPage, projectName, 'Alpha')
  await addChildNode(appPage, projectName, 'Beta')

  await openSnapshotsPanel(appPage)
  await createSnapshot(appPage, 'baseline')

  await openContextMenuAction(appPage, 'Alpha', 'Rename')
  await appPage.getByTestId('name-input').fill('Alpha Prime')
  await appPage.getByTestId('name-input').press('Enter')
  await expect(treeRow(appPage, 'Alpha Prime')).toBeVisible()

  await openContextMenuAction(appPage, 'Alpha Prime', 'Move To…')
  await appPage.getByTestId('move-target').filter({ hasText: 'Beta' }).click()
  await appPage.getByTestId('move-confirm').click()

  await createSnapshot(appPage, 'migrated')
  await compareSnapshots(appPage, 'baseline', 'migrated')

  const movedRow = appPage.getByTestId('snapshot-diff-row').filter({ hasText: 'Moved' }).filter({ hasText: 'Alpha Prime' })
  const renamedRow = appPage.getByTestId('snapshot-diff-row').filter({ hasText: 'Renamed' }).filter({ hasText: 'Alpha Prime' })

  await expect(movedRow).toBeVisible()
  await expect(renamedRow).toBeVisible()
  await expect(appPage.getByTestId('compare-filter-all')).toHaveText('All 3')
  await expect(appPage.getByTestId('compare-filter-high')).toHaveText('High 1')
  await expect(appPage.getByTestId('compare-filter-medium')).toHaveText('Medium 1')

  await appPage.getByTestId('compare-filter-high').click()
  await expect(appPage.getByTestId('compare-filter-summary')).toContainText('Showing 1 of 3 node changes.')
  await expect(movedRow).toBeVisible()
  await expect(renamedRow).toHaveCount(0)

  await appPage.getByTestId('compare-filter-medium').click()
  await expect(movedRow).toHaveCount(0)
  await expect(renamedRow).toBeVisible()

  await appPage.getByTestId('compare-filter-all').click()
  await expect(movedRow).toBeVisible()
  await expect(renamedRow).toBeVisible()

  await renamedRow.click()
  await expect(appPage.locator('[data-testid="tree-node"][data-row-status="mixed"]', { hasText: 'Alpha Prime' })).toBeVisible()
})

test('compares generated snapshot fixtures without dropping the diff list', async ({ appPage, electronApp, workspaceDir }) => {
  const projectDir = `${workspaceDir}/generated-compare`

  execFileSync(
    'bun',
    [
      'run',
      'generate:project',
      '--',
      '--output',
      projectDir,
      '--name',
      'Generated Compare Lab',
      '--nodes',
      '180',
      '--depth',
      '5',
      '--branching',
      '4',
      '--snapshots',
      '2',
      '--seed',
      '7',
      '--force',
    ],
    { cwd: process.cwd(), stdio: 'pipe' }
  )

  await openProjectThroughUi(appPage, electronApp, projectDir)
  await openSnapshotsPanel(appPage)
  await compareSnapshots(appPage, 'generated-01', 'generated-02')

  await expect(appPage.getByText('No changes')).toHaveCount(0)
  await expect.poll(async () => appPage.getByTestId('snapshot-diff-row').count()).toBeGreaterThan(0)
  await expect(treeRow(appPage, 'Generated Compare Lab')).toBeVisible()
})

// Issue #3: Ghost rows (removed nodes in compare mode) are selectable and load
// into the DetailPane in read-only "tombstone" mode so the user can inspect
// what the removed node contained.
test('selecting a ghost row shows the tombstone DetailPane (read-only)', async ({
  appPage,
  electronApp,
  workspaceDir,
}) => {
  const projectName = 'Tombstone Lab'

  await createProjectThroughUi(appPage, electronApp, workspaceDir, projectName)
  await addChildNode(appPage, projectName, 'Doomed Rack')

  // Give it a property so we can verify the tombstone view shows it read-only.
  await treeRow(appPage, 'Doomed Rack').click()
  await appPage.getByTestId('new-prop-key').fill('serial')
  await appPage.getByTestId('new-prop-value').fill('SN-99')
  await appPage.getByTestId('add-prop-btn').click()
  await expect(appPage.getByTestId('prop-value').filter({ hasText: 'SN-99' })).toBeVisible()

  await openSnapshotsPanel(appPage)
  await createSnapshot(appPage, 'with-doomed')

  // Delete the node, then create a second snapshot.
  await appPage.getByRole('button', { name: 'Close snapshots' }).click()
  appPage.once('dialog', (dialog) => dialog.accept())
  await openContextMenuAction(appPage, 'Doomed Rack', 'Delete…')
  await expect(treeRow(appPage, 'Doomed Rack')).toHaveCount(0)

  await openSnapshotsPanel(appPage)
  await createSnapshot(appPage, 'without-doomed')
  await compareSnapshots(appPage, 'with-doomed', 'without-doomed')

  // Click the diff row to surface and select the ghost.
  const removedRow = appPage.getByTestId('snapshot-diff-row').filter({ hasText: 'Removed' })
  await expect(removedRow).toBeVisible()
  await removedRow.click()

  // The ghost row is now visible in the tree and is the selected DetailPane target.
  const ghostRow = appPage.locator(
    '[data-testid="tree-node"][data-row-status="removed"][data-row-ghost="true"]',
    { hasText: 'Doomed Rack' },
  )
  await expect(ghostRow).toBeVisible()
  await ghostRow.click()

  // Tombstone banner is shown; the generic read-only banner is NOT.
  await expect(appPage.getByTestId('detail-tombstone-banner')).toBeVisible()
  await expect(appPage.getByTestId('detail-tombstone-banner')).toHaveAttribute(
    'data-ghost-status',
    'removed',
  )
  await expect(appPage.getByTestId('detail-readonly-banner')).toHaveCount(0)

  // The historical property value is rendered so the user can read it.
  await expect(appPage.getByTestId('prop-value').filter({ hasText: 'SN-99' })).toBeVisible()

  // No edit controls: Add Property form is suppressed.
  await expect(appPage.getByTestId('add-prop-btn')).toHaveCount(0)
  await expect(appPage.getByTestId('new-prop-key')).toHaveCount(0)
})

test('compares the current project against a snapshot without a throwaway snapshot', async ({ appPage, electronApp, workspaceDir }) => {
  const projectName = 'Current Compare Lab'

  await createProjectThroughUi(appPage, electronApp, workspaceDir, projectName)
  await addChildNode(appPage, projectName, 'Rack A')

  await openSnapshotsPanel(appPage)
  await createSnapshot(appPage, 'baseline')

  // Make an unsnapshotted edit, then compare it against the snapshot directly.
  await addChildNode(appPage, projectName, 'Rack B')
  await expect(appPage.getByTestId('project-mode-badge')).toHaveText('Unsnapshotted changes')

  // With a single snapshot present the compare picker is reachable (gate is >=1),
  // and "Current project" is offered on BOTH sides.
  await expect(appPage.getByTestId('compare-from-select')).toBeVisible()
  await expect(
    appPage.getByTestId('compare-from-select').locator('option', { hasText: 'Current project' }),
  ).toHaveCount(1)
  await expect(
    appPage.getByTestId('compare-to-select').locator('option', { hasText: 'Current project' }),
  ).toHaveCount(1)

  await compareSnapshots(appPage, 'baseline', CURRENT_PROJECT_REF)
  await expect(appPage.getByTestId('project-mode-badge')).toHaveText('Comparing baseline -> Current project')

  const addedRow = appPage.getByTestId('snapshot-diff-row').filter({ hasText: 'Added' })
  await expect(addedRow).toBeVisible()
  await expect(addedRow).toContainText('Rack B')

  await appPage.getByRole('button', { name: 'Exit compare' }).click()
  await expect(appPage.getByTestId('project-mode-badge')).toHaveText('Unsnapshotted changes')
})
