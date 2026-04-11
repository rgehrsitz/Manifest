import { expect, test } from './fixtures'

test('creates, compares, and restores snapshots from the renderer surface', async ({ appPage, electronApp, workspaceDir }) => {
  const parentDir = workspaceDir
  const projectName = 'Snapshot UI Lab'

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

  // Panel opens docked — does NOT block the tree.
  await appPage.getByTestId('open-snapshots-btn').click()
  await expect(appPage.getByTestId('snapshots-panel')).toBeVisible()

  // Tree is still interactive while panel is open (non-blocking).
  await expect(appPage.locator('[data-testid="tree-node"]', { hasText: projectName })).toBeVisible()

  // Create first snapshot.
  await appPage.getByTestId('snapshot-name-input').fill('baseline')
  await appPage.getByTestId('create-snapshot-btn').click()
  await expect(appPage.getByTestId('snapshot-row').filter({ hasText: 'baseline' })).toBeVisible()

  // Close and re-open to confirm panel slides back.
  await appPage.getByRole('button', { name: 'Close snapshots' }).click()
  await expect(appPage.getByTestId('snapshots-panel')).toHaveCount(0)

  // Add a child node to the tree while panel is closed.
  await appPage.locator('[data-testid="tree-node"]', { hasText: projectName }).click({ button: 'right' })
  await appPage.getByRole('menuitem', { name: 'Add Child' }).click()
  await appPage.getByTestId('add-child-input').fill('Rack A')
  await appPage.getByTestId('add-child-commit').click()
  await expect(appPage.locator('[data-testid="tree-node"]', { hasText: 'Rack A' })).toBeVisible()

  // Re-open panel and create second snapshot.
  await appPage.getByTestId('open-snapshots-btn').click()
  await expect(appPage.getByTestId('snapshots-panel')).toBeVisible()

  await appPage.getByTestId('snapshot-name-input').fill('with-rack')
  await appPage.getByTestId('create-snapshot-btn').click()
  await expect(appPage.getByTestId('snapshot-row').filter({ hasText: 'with-rack' })).toBeVisible()

  // Compare baseline → with-rack.
  await appPage.getByTestId('compare-to-select').selectOption('with-rack')
  await appPage.getByTestId('compare-from-select').selectOption('baseline')
  await expect(appPage.getByTestId('compare-snapshots-btn')).toBeEnabled()
  await appPage.getByTestId('compare-snapshots-btn').click()

  // Diff list appears.
  await expect(appPage.getByTestId('snapshot-diff-list')).toBeVisible()
  await expect(appPage.getByTestId('snapshot-diff-row').filter({ hasText: 'Added' })).toBeVisible()
  await expect(appPage.getByTestId('snapshot-diff-row').filter({ hasText: 'Rack A' })).toBeVisible()

  // Tree is still visible and has a decorated row for Rack A.
  await expect(appPage.locator('[data-testid="tree-node"]', { hasText: 'Rack A' })).toBeVisible()

  // Exit compare mode restores normal tree.
  await appPage.getByRole('button', { name: 'Exit compare' }).click()
  await expect(appPage.getByTestId('snapshot-diff-list')).toHaveCount(0)

  // Restore baseline.
  appPage.once('dialog', (dialog) => dialog.accept())
  await appPage
    .getByTestId('snapshot-row')
    .filter({ hasText: 'baseline' })
    .getByTestId('restore-snapshot-btn')
    .click()

  // After restore, panel stays open (it is docked, not modal).
  await expect(appPage.getByTestId('snapshots-panel')).toBeVisible()

  // Rack A should be gone from the tree.
  await expect(appPage.locator('[data-testid="tree-node"]', { hasText: 'Rack A' })).toHaveCount(0)

  const manifest = await appPage.evaluate(async () => {
    const result = await window.api.project.getCurrent()
    if (!result.ok || !result.data) return null
    return result.data.nodes.map((node) => node.name)
  })

  expect(manifest).toEqual([projectName])
})
