import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { ElectronApplication, Page } from '@playwright/test'
import { expect, test } from './fixtures'

type PersistedProject = {
  name: string
  nodes: Array<{
    id: string
    parentId: string | null
    name: string
    order: number
    properties: Record<string, string | number | boolean | null>
  }>
}

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
): Promise<string> {
  await appPage.getByTestId('create-project-btn').click()
  await appPage.getByTestId('project-name-input').fill(projectName)

  await setDialogPath(electronApp, parentDir)
  await appPage.getByTestId('choose-folder-btn').click()
  await expect(appPage.getByTestId('selected-path')).toContainText(parentDir)

  await appPage.getByTestId('create-btn').click()
  await expect(appPage.getByTestId('project-view')).toBeVisible()
  await expect(treeRow(appPage, projectName)).toBeVisible()

  return join(parentDir, projectName)
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

async function currentProject(page: Page): Promise<PersistedProject> {
  const result = await page.evaluate(() => window.api.project.getCurrent())
  expect(result.ok).toBe(true)
  if (!result.ok || !result.data) {
    throw new Error('Expected an open project in the main process')
  }
  return result.data
}

async function writeFixtureProject(targetDir: string, fixtureName: string): Promise<void> {
  mkdirSync(targetDir, { recursive: true })
  const fixturePath = join(process.cwd(), 'tests', 'fixtures', fixtureName)
  writeFileSync(join(targetDir, 'manifest.json'), readFileSync(fixturePath, 'utf8'), 'utf8')
}

test('creates a new project from the welcome flow', async ({ appPage, electronApp, workspaceDir }) => {
  const projectDir = await createProjectThroughUi(appPage, electronApp, workspaceDir, 'Bench Alpha')
  const manifestPath = join(projectDir, 'manifest.json')

  expect(existsSync(manifestPath)).toBe(true)
  expect(existsSync(join(projectDir, '.git'))).toBe(true)

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as PersistedProject
  expect(manifest.name).toBe('Bench Alpha')
  expect(manifest.nodes).toHaveLength(1)
  expect(manifest.nodes[0]?.parentId).toBeNull()
})

test('opens an existing project and renders its hierarchy', async ({ appPage, electronApp, workspaceDir }) => {
  const projectDir = join(workspaceDir, 'Lab Setup')
  await writeFixtureProject(projectDir, 'project-with-nodes.json')

  await openProjectThroughUi(appPage, electronApp, projectDir)

  await expect(treeRow(appPage, 'Rack A')).toBeVisible()
  await treeRow(appPage, 'Rack A').click()
  await expect(appPage.getByTestId('node-name')).toContainText('Rack A')
  await expect(appPage.getByText('4 nodes')).toBeVisible()
})

test('adds, renames, and deletes a node through the tree UI', async ({ appPage, electronApp, workspaceDir }) => {
  await createProjectThroughUi(appPage, electronApp, workspaceDir, 'Bench CRUD')

  await openContextMenuAction(appPage, 'Bench CRUD', 'Add Child')
  await appPage.getByTestId('add-child-input').fill('Rack A')
  await appPage.getByTestId('add-child-commit').click()
  await expect(treeRow(appPage, 'Rack A')).toBeVisible()

  await openContextMenuAction(appPage, 'Rack A', 'Rename')
  await expect(appPage.getByTestId('name-input')).toBeVisible()
  await appPage.getByTestId('name-input').fill('Rack Alpha')
  await appPage.getByTestId('name-input').press('Enter')
  await expect(treeRow(appPage, 'Rack Alpha')).toBeVisible()

  await openContextMenuAction(appPage, 'Rack Alpha', 'Delete…')
  await expect(treeRow(appPage, 'Rack Alpha')).toHaveCount(0)

  const project = await currentProject(appPage)
  expect(project.nodes).toHaveLength(1)
})

test('reorders siblings and reparents nodes', async ({ appPage, electronApp, workspaceDir }) => {
  const projectDir = join(workspaceDir, 'Reorder Lab')
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(
    join(projectDir, 'manifest.json'),
    JSON.stringify({
      version: 2,
      id: '01900000-0000-7000-8000-000000000100',
      name: 'Reorder Lab',
      created: '2026-01-01T00:00:00.000Z',
      modified: '2026-01-01T00:00:00.000Z',
      nodes: [
        {
          id: '01900000-0000-7000-8000-000000000101',
          parentId: null,
          name: 'Reorder Lab',
          order: 0,
          properties: {},
          created: '2026-01-01T00:00:00.000Z',
          modified: '2026-01-01T00:00:00.000Z',
        },
        {
          id: '01900000-0000-7000-8000-000000000102',
          parentId: '01900000-0000-7000-8000-000000000101',
          name: 'Alpha',
          order: 0,
          properties: {},
          created: '2026-01-01T00:00:00.000Z',
          modified: '2026-01-01T00:00:00.000Z',
        },
        {
          id: '01900000-0000-7000-8000-000000000103',
          parentId: '01900000-0000-7000-8000-000000000101',
          name: 'Beta',
          order: 1,
          properties: {},
          created: '2026-01-01T00:00:00.000Z',
          modified: '2026-01-01T00:00:00.000Z',
        },
        {
          id: '01900000-0000-7000-8000-000000000104',
          parentId: '01900000-0000-7000-8000-000000000101',
          name: 'Gamma',
          order: 2,
          properties: {},
          created: '2026-01-01T00:00:00.000Z',
          modified: '2026-01-01T00:00:00.000Z',
        },
      ],
    }, null, 2),
    'utf8'
  )

  await openProjectThroughUi(appPage, electronApp, projectDir)

  await openContextMenuAction(appPage, 'Gamma', 'Move Up ↑')
  let project = await currentProject(appPage)
  const rootId = project.nodes.find((node) => node.parentId === null)?.id
  expect(rootId).toBeTruthy()
  let rootChildren = project.nodes
    .filter((node) => node.parentId === rootId)
    .sort((a, b) => a.order - b.order)
    .map((node) => node.name)
  expect(rootChildren).toEqual(['Alpha', 'Gamma', 'Beta'])

  await openContextMenuAction(appPage, 'Alpha', 'Move To…')
  await appPage.getByTestId('move-target').filter({ hasText: 'Beta' }).click()
  await appPage.getByTestId('move-confirm').click()

  project = await currentProject(appPage)
  const alpha = project.nodes.find((node) => node.name === 'Alpha')
  const beta = project.nodes.find((node) => node.name === 'Beta')
  expect(alpha?.parentId).toBe(beta?.id)

  await treeRow(appPage, 'Beta').getByRole('button', { name: 'Expand' }).click()
  await expect(treeRow(appPage, 'Alpha')).toBeVisible()
})

test('searches by property value and focuses the selected node', async ({ appPage, electronApp, workspaceDir }) => {
  const projectDir = join(workspaceDir, 'Search Lab')
  await writeFixtureProject(projectDir, 'project-with-nodes.json')

  await openProjectThroughUi(appPage, electronApp, projectDir)

  await appPage.getByTestId('search-input').fill('SN-0002')
  await expect(appPage.getByTestId('search-results')).toBeVisible()
  await appPage.getByTestId('search-result').filter({ hasText: 'Server 2' }).click()

  await expect(appPage.getByTestId('node-name')).toContainText('Server 2')
  await expect(appPage.getByTestId('search-input')).toHaveValue('')
})

test('autosaves edits to disk and reopens them cleanly', async ({ appPage, electronApp, workspaceDir }) => {
  const projectDir = await createProjectThroughUi(appPage, electronApp, workspaceDir, 'Autosave Lab')
  const manifestPath = join(projectDir, 'manifest.json')

  await openContextMenuAction(appPage, 'Autosave Lab', 'Add Child')
  await appPage.getByTestId('add-child-input').fill('Rack A')
  await appPage.getByTestId('add-child-commit').click()
  await expect(treeRow(appPage, 'Rack A')).toBeVisible()

  await appPage.getByTestId('new-prop-key').fill('serial')
  await appPage.getByTestId('new-prop-value').fill('SN-42')
  await appPage.getByTestId('add-prop-btn').click()
  await expect(appPage.getByTestId('prop-value').filter({ hasText: 'SN-42' })).toBeVisible()

  await expect.poll(() => {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as PersistedProject
    return manifest.nodes.find((node) => node.name === 'Rack A')?.properties.serial ?? null
  }).toBe('SN-42')

  await appPage.getByTestId('close-project-btn').click()
  await expect(appPage.getByTestId('create-project-btn')).toBeVisible()

  await openProjectThroughUi(appPage, electronApp, projectDir)
  await treeRow(appPage, 'Rack A').click()
  await expect(appPage.getByTestId('node-name')).toContainText('Rack A')
  await expect(appPage.getByTestId('prop-value').filter({ hasText: 'SN-42' })).toBeVisible()
})
