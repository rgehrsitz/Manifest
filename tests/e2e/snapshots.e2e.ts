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

  await appPage.getByTestId('open-snapshots-btn').click()
  await expect(appPage.getByTestId('snapshot-dialog')).toBeVisible()

  await appPage.getByTestId('snapshot-name-input').fill('baseline')
  await appPage.getByTestId('create-snapshot-btn').click()
  await expect(appPage.getByTestId('snapshot-row').filter({ hasText: 'baseline' })).toBeVisible()

  await appPage.getByRole('button', { name: 'Close snapshots' }).click()
  await expect(appPage.getByTestId('snapshot-dialog')).toHaveCount(0)

  await appPage.locator('[data-testid="tree-node"]', { hasText: 'Snapshot UI Lab' }).click({ button: 'right' })
  await appPage.getByRole('menuitem', { name: 'Add Child' }).click()
  await appPage.getByTestId('add-child-input').fill('Rack A')
  await appPage.getByTestId('add-child-commit').click()
  await expect(appPage.locator('[data-testid="tree-node"]', { hasText: 'Rack A' })).toBeVisible()

  await appPage.getByTestId('open-snapshots-btn').click()
  await appPage.getByTestId('snapshot-name-input').fill('with-rack')
  await appPage.getByTestId('create-snapshot-btn').click()
  await expect(appPage.getByTestId('snapshot-row').filter({ hasText: 'with-rack' })).toBeVisible()

  await appPage.getByTestId('compare-to-select').selectOption('with-rack')
  await appPage.getByTestId('compare-from-select').selectOption('baseline')
  await expect(appPage.getByTestId('compare-snapshots-btn')).toBeEnabled()
  await appPage.getByTestId('compare-snapshots-btn').click()

  await expect(appPage.getByTestId('snapshot-diff-list')).toBeVisible()
  await expect(appPage.getByTestId('snapshot-diff-row').filter({ hasText: 'Added' })).toBeVisible()
  await expect(appPage.getByTestId('snapshot-diff-row').filter({ hasText: 'Rack A' })).toBeVisible()

  appPage.once('dialog', (dialog) => dialog.accept())
  await appPage
    .getByTestId('snapshot-row')
    .filter({ hasText: 'baseline' })
    .getByTestId('restore-snapshot-btn')
    .click()
  await expect(appPage.getByTestId('snapshot-dialog')).toHaveCount(0)
  await expect(appPage.locator('[data-testid="tree-node"]', { hasText: 'Rack A' })).toHaveCount(0)

  const manifest = await appPage.evaluate(async () => {
    const result = await window.api.project.getCurrent()
    if (!result.ok || !result.data) return null
    return result.data.nodes.map((node) => node.name)
  })

  expect(manifest).toEqual(['Snapshot UI Lab'])
})
