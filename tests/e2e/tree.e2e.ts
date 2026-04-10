import { expect, test } from './fixtures'

/**
 * E2E tests for the virtualized Tree component (PR #1).
 *
 * These tests exercise:
 *   - Basic tree rendering (nodes visible, testids present)
 *   - Keyboard navigation (Arrow keys, Enter, F2)
 *   - Double-click to expand/collapse
 *   - Context menu actions (Add Child, Rename routing to DetailPane)
 *   - Virtualized viewport renders correctly for normal-size projects
 */

test('tree renders the project root node', async ({ appPage, electronApp, workspaceDir }) => {
  const projectName = 'Tree Test'

  await appPage.getByTestId('create-project-btn').click()
  await appPage.getByTestId('project-name-input').fill(projectName)

  await electronApp.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, workspaceDir)

  await appPage.getByTestId('choose-folder-btn').click()
  await appPage.getByTestId('create-btn').click()
  await expect(appPage.getByTestId('project-view')).toBeVisible()

  // Root node should be visible.
  await expect(
    appPage.locator('[data-testid="tree-node"]', { hasText: projectName })
  ).toBeVisible()
})

test('context menu Add Child creates a new node', async ({ appPage, electronApp, workspaceDir }) => {
  await appPage.getByTestId('create-project-btn').click()
  await appPage.getByTestId('project-name-input').fill('Menu Test')

  await electronApp.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, workspaceDir)

  await appPage.getByTestId('choose-folder-btn').click()
  await appPage.getByTestId('create-btn').click()
  await expect(appPage.getByTestId('project-view')).toBeVisible()

  // Right-click on the root node → Add Child.
  await appPage.locator('[data-testid="tree-node"]', { hasText: 'Menu Test' }).click({ button: 'right' })
  await appPage.getByRole('menuitem', { name: 'Add Child' }).click()
  await appPage.getByTestId('add-child-input').fill('Rack A')
  await appPage.getByTestId('add-child-commit').click()

  await expect(
    appPage.locator('[data-testid="tree-node"]', { hasText: 'Rack A' })
  ).toBeVisible()
})

test('double-click on a node with children toggles expand/collapse', async ({
  appPage,
  electronApp,
  workspaceDir,
}) => {
  await appPage.getByTestId('create-project-btn').click()
  await appPage.getByTestId('project-name-input').fill('Dblclick Test')

  await electronApp.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, workspaceDir)

  await appPage.getByTestId('choose-folder-btn').click()
  await appPage.getByTestId('create-btn').click()
  await expect(appPage.getByTestId('project-view')).toBeVisible()

  // Add a child so root has children.
  await appPage
    .locator('[data-testid="tree-node"]', { hasText: 'Dblclick Test' })
    .click({ button: 'right' })
  await appPage.getByRole('menuitem', { name: 'Add Child' }).click()
  await appPage.getByTestId('add-child-input').fill('Child Node')
  await appPage.getByTestId('add-child-commit').click()
  await expect(
    appPage.locator('[data-testid="tree-node"]', { hasText: 'Child Node' })
  ).toBeVisible()

  // Double-click root → should collapse (hide child).
  await appPage
    .locator('[data-testid="tree-node"]', { hasText: 'Dblclick Test' })
    .dblclick()
  await expect(
    appPage.locator('[data-testid="tree-node"]', { hasText: 'Child Node' })
  ).toHaveCount(0)

  // Double-click again → should expand (show child).
  await appPage
    .locator('[data-testid="tree-node"]', { hasText: 'Dblclick Test' })
    .dblclick()
  await expect(
    appPage.locator('[data-testid="tree-node"]', { hasText: 'Child Node' })
  ).toBeVisible()
})

test('F2 triggers rename in DetailPane', async ({ appPage, electronApp, workspaceDir }) => {
  await appPage.getByTestId('create-project-btn').click()
  await appPage.getByTestId('project-name-input').fill('F2 Rename Test')

  await electronApp.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, workspaceDir)

  await appPage.getByTestId('choose-folder-btn').click()
  await appPage.getByTestId('create-btn').click()
  await expect(appPage.getByTestId('project-view')).toBeVisible()

  // Click the root node to select it, then press F2.
  await appPage.locator('[data-testid="tree-node"]').first().click()
  await appPage.getByTestId('tree-viewport').focus()
  await appPage.getByTestId('tree-viewport').press('F2')

  // DetailPane should enter name-editing mode: the name input becomes visible.
  await expect(appPage.getByTestId('name-input')).toBeVisible()
})

test('arrow key navigation moves through visible nodes', async ({
  appPage,
  electronApp,
  workspaceDir,
}) => {
  await appPage.getByTestId('create-project-btn').click()
  await appPage.getByTestId('project-name-input').fill('Keyboard Nav Test')

  await electronApp.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, workspaceDir)

  await appPage.getByTestId('choose-folder-btn').click()
  await appPage.getByTestId('create-btn').click()
  await expect(appPage.getByTestId('project-view')).toBeVisible()

  // Add two children.
  for (const name of ['Alpha', 'Beta']) {
    await appPage
      .locator('[data-testid="tree-node"]', { hasText: 'Keyboard Nav Test' })
      .click({ button: 'right' })
    await appPage.getByRole('menuitem', { name: 'Add Child' }).click()
    await appPage.getByTestId('add-child-input').fill(name)
    await appPage.getByTestId('add-child-commit').click()
    await expect(
      appPage.locator('[data-testid="tree-node"]', { hasText: name })
    ).toBeVisible()
  }

  // Focus the tree viewport, press ArrowDown twice to move from root → Alpha → Beta.
  await appPage.getByTestId('tree-viewport').focus()
  await appPage.getByTestId('tree-viewport').press('ArrowDown')
  await appPage.getByTestId('tree-viewport').press('ArrowDown')

  // The detail pane should show "Beta" after two ArrowDown presses select it.
  // (Selection is updated by Enter/Space, not just navigation, so we press Enter.)
  await appPage.getByTestId('tree-viewport').press('Enter')
  await expect(appPage.getByTestId('detail-pane')).toContainText('Beta')
})
