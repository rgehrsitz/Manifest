import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
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
  projectName: string
): Promise<void> {
  await appPage.getByTestId('create-project-btn').click()
  await appPage.getByTestId('project-name-input').fill(projectName)
  await setDialogPath(electronApp, parentDir)
  await appPage.getByTestId('choose-folder-btn').click()
  await appPage.getByTestId('create-btn').click()
  await expect(appPage.getByTestId('project-view')).toBeVisible()
}

async function openContextMenuAction(page: Page, nodeName: string, actionLabel: string): Promise<void> {
  await treeRow(page, nodeName).click({ button: 'right' })
  await page.getByRole('menuitem', { name: actionLabel }).click()
}

test('create template, type a node, promote, reject invalidating edit, delete unbinds', async ({
  appPage,
  electronApp,
  workspaceDir,
}) => {
  const projectName = 'TypedProps Lab'
  await createProjectThroughUi(appPage, electronApp, workspaceDir, projectName)

  // ── Create a "Software Item" template with version + enum + number fields ──
  await appPage.getByTestId('open-templates-btn').click()
  await expect(appPage.getByTestId('template-manager')).toBeVisible()

  await appPage.getByTestId('template-label').fill('Software Item')

  await appPage.getByTestId('template-add-field').click()
  await appPage.getByTestId('field-key').nth(0).fill('version')
  await appPage.getByTestId('field-type').nth(0).selectOption('version')

  await appPage.getByTestId('template-add-field').click()
  await appPage.getByTestId('field-key').nth(1).fill('status')
  await appPage.getByTestId('field-type').nth(1).selectOption('enum')
  await appPage.getByTestId('field-options').fill('approved, testing, retired')

  await appPage.getByTestId('template-add-field').click()
  await appPage.getByTestId('field-key').nth(2).fill('units')
  await appPage.getByTestId('field-type').nth(2).selectOption('number')

  await appPage.getByTestId('template-save').click()
  // Saved → it now appears in the list and there is no form error.
  await expect(appPage.getByTestId('template-list-item').filter({ hasText: 'Software Item' })).toBeVisible()
  await expect(appPage.getByTestId('template-form-error')).toHaveCount(0)
  await appPage.getByTestId('template-manager-close').click()

  // ── Create a node bound to the template ───────────────────────────────────
  await openContextMenuAction(appPage, projectName, 'Add Child')
  await appPage.getByTestId('add-child-template').selectOption('software-item')
  await appPage.getByTestId('add-child-input').fill('Flight Test App')
  await appPage.getByTestId('add-child-commit').click()
  await expect(treeRow(appPage, 'Flight Test App')).toBeVisible()

  // ── Edit typed fields ─────────────────────────────────────────────────────
  await treeRow(appPage, 'Flight Test App').click()
  await expect(appPage.getByTestId('node-name')).toContainText('Flight Test App')
  await expect(appPage.getByTestId('template-selector')).toHaveValue('software-item')

  const versionInput = appPage.getByTestId('tpl-input-version')
  await versionInput.fill('v2.3.1')
  await versionInput.press('Enter')

  await appPage.getByTestId('tpl-input-status').selectOption('approved')

  const unitsInput = appPage.getByTestId('tpl-input-units')
  await unitsInput.fill('5')
  await unitsInput.press('Enter')

  // Reselect to confirm the values persisted (control re-seeds from stored value).
  await treeRow(appPage, projectName).click()
  await treeRow(appPage, 'Flight Test App').click()
  await expect(appPage.getByTestId('tpl-input-version')).toHaveValue('v2.3.1')
  await expect(appPage.getByTestId('tpl-input-status')).toHaveValue('approved')
  await expect(appPage.getByTestId('tpl-input-units')).toHaveValue('5')

  // ── Add an ad-hoc property, then promote it to a typed field ───────────────
  await appPage.getByTestId('new-prop-key').fill('vendor')
  await appPage.getByTestId('new-prop-value').fill('Acme')
  await appPage.getByTestId('add-prop-btn').click()
  await expect(appPage.getByTestId('prop-value').filter({ hasText: 'Acme' })).toBeVisible()

  await appPage.getByTestId('promote-prop').first().click()
  await appPage.getByTestId('promote-type').selectOption('string')
  await appPage.getByTestId('promote-confirm').click()
  // 'vendor' is now a typed template field.
  await expect(appPage.getByTestId('tpl-input-vendor')).toBeVisible()

  // ── Template edit that would invalidate a bound value is rejected ─────────
  await appPage.getByTestId('open-templates-btn').click()
  await appPage.getByTestId('template-list-item').filter({ hasText: 'Software Item' }).click()
  // version is the first field row; change its type to number — "v2.3.1" is now invalid.
  await appPage.getByTestId('field-type').nth(0).selectOption('number')
  await appPage.getByTestId('template-save').click()
  await expect(appPage.getByTestId('template-form-error')).toBeVisible()

  // ── Delete the template: node unbinds but keeps its values ────────────────
  // Reselect the template fresh (the rejected edit left an unsaved type change).
  await appPage.getByTestId('template-list-item').filter({ hasText: 'Software Item' }).click()
  await appPage.getByTestId('template-delete').click()
  await expect(appPage.getByTestId('template-list-item')).toHaveCount(0)
  await appPage.getByTestId('template-manager-close').click()

  await treeRow(appPage, projectName).click()
  await treeRow(appPage, 'Flight Test App').click()
  await expect(appPage.getByTestId('template-selector')).toHaveValue('')
  // Former typed values survive as ad-hoc properties.
  await expect(appPage.getByTestId('prop-value').filter({ hasText: 'v2.3.1' })).toBeVisible()
  await expect(appPage.getByTestId('prop-value').filter({ hasText: 'approved' })).toBeVisible()
})

test('auto-derives the template id from the label and validates field keys inline', async ({
  appPage,
  electronApp,
  workspaceDir,
}) => {
  await createProjectThroughUi(appPage, electronApp, workspaceDir, 'Template UX Lab')

  await appPage.getByTestId('open-templates-btn').click()
  await expect(appPage.getByTestId('template-manager')).toBeVisible()

  // Typing the label auto-fills a valid slug id (no manual id entry needed).
  await appPage.getByTestId('template-label').fill('Test Label')
  await expect(appPage.getByTestId('template-id')).toHaveValue('test-label')

  // A hyphenated key is rejected inline, and Save is blocked until it's valid.
  await appPage.getByTestId('template-add-field').click()
  await appPage.getByTestId('field-key').fill('bool-test')
  await expect(appPage.getByTestId('field-key-error')).toBeVisible()
  await expect(appPage.getByTestId('template-save')).toBeDisabled()

  await appPage.getByTestId('field-key').fill('bool_test')
  await expect(appPage.getByTestId('field-key-error')).toHaveCount(0)
  await expect(appPage.getByTestId('template-save')).toBeEnabled()

  await appPage.getByTestId('template-save').click()
  await expect(appPage.getByTestId('template-list-item').filter({ hasText: 'Test Label' })).toBeVisible()
})

test('surfaces load-time warnings for a hand-edited invalid value', async ({
  appPage,
  electronApp,
  workspaceDir,
}) => {
  // Hand-author a v3 manifest with a bound node whose enum value is invalid.
  const projectDir = join(workspaceDir, 'hand-edited')
  mkdirSync(projectDir, { recursive: true })
  const manifest = {
    version: 3,
    id: 'he-id',
    name: 'Hand Edited',
    created: '2026-01-01T00:00:00.000Z',
    modified: '2026-01-01T00:00:00.000Z',
    templates: {
      'software-item': {
        label: 'Software Item',
        fields: { status: { type: 'enum', options: ['approved', 'testing'] } },
      },
    },
    nodes: [
      {
        id: 'root', parentId: null, name: 'Hand Edited', order: 0, properties: {},
        created: '2026-01-01T00:00:00.000Z', modified: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'n1', parentId: 'root', name: 'App', order: 0,
        templateId: 'software-item', properties: { status: 'bogus' },
        created: '2026-01-01T00:00:00.000Z', modified: '2026-01-01T00:00:00.000Z',
      },
    ],
  }
  writeFileSync(join(projectDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')

  await setDialogPath(electronApp, projectDir)
  await appPage.getByTestId('open-project-btn').click()
  await expect(appPage.getByTestId('project-view')).toBeVisible()

  const banner = appPage.getByTestId('load-warnings-banner')
  await expect(banner).toBeVisible()
  await expect(banner).toContainText('nodes[1].properties.status')

  await appPage.getByTestId('dismiss-load-warnings').click()
  await expect(banner).toHaveCount(0)
})
