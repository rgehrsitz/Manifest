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
  await page.getByTestId('compare-snapshots-btn').click()
  await expect(page.getByTestId('snapshot-diff-list')).toBeVisible()
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

test('a schema-only change between snapshots is surfaced, not hidden as "No changes"', async ({
  appPage,
  electronApp,
  workspaceDir,
}) => {
  await createProjectThroughUi(appPage, electronApp, workspaceDir, 'Schema Diff Lab')

  // Template with one field, and a node bound to it.
  await appPage.getByTestId('open-templates-btn').click()
  await appPage.getByTestId('template-label').fill('Software Item')
  await appPage.getByTestId('template-add-field').click()
  await appPage.getByTestId('field-key').nth(0).fill('version')
  await appPage.getByTestId('field-type').nth(0).selectOption('version')
  await appPage.getByTestId('template-save').click()
  await expect(appPage.getByTestId('template-list-item').filter({ hasText: 'Software Item' })).toBeVisible()
  await appPage.getByTestId('template-manager-close').click()

  await openContextMenuAction(appPage, 'Schema Diff Lab', 'Add Child')
  await appPage.getByTestId('add-child-template').selectOption('software-item')
  await appPage.getByTestId('add-child-input').fill('App')
  await appPage.getByTestId('add-child-commit').click()
  await expect(treeRow(appPage, 'App')).toBeVisible()

  // Snapshot, then make a SCHEMA-ONLY change (add a field to the template).
  await openSnapshotsPanel(appPage)
  await createSnapshot(appPage, 'before')

  await appPage.getByTestId('open-templates-btn').click()
  await appPage.getByTestId('template-list-item').filter({ hasText: 'Software Item' }).click()
  await appPage.getByTestId('template-add-field').click()
  // The new (empty) field row is appended last.
  const keyInputs = appPage.getByTestId('field-key')
  await keyInputs.nth((await keyInputs.count()) - 1).fill('vendor')
  await appPage.getByTestId('template-save').click()
  await expect(appPage.getByTestId('template-form-error')).toHaveCount(0)
  await appPage.getByTestId('template-manager-close').click()

  await createSnapshot(appPage, 'after')
  await compareSnapshots(appPage, 'before', 'after')

  // The schema change must be visible — and the panel must NOT claim "No changes".
  await expect(appPage.getByTestId('schema-changes')).toBeVisible()
  await expect(appPage.getByTestId('schema-change-row').filter({ hasText: 'vendor' })).toBeVisible()
  await expect(appPage.getByTestId('compare-review-focus')).toContainText('1 schema change')
  await expect(appPage.getByTestId('review-focus-classification-badge')).toHaveText('Schema')
  const schemaFocus = appPage.getByTestId('review-focus-item').filter({ hasText: '1 schema change' })
  await schemaFocus.click()
  await expect(schemaFocus).toHaveAttribute('aria-pressed', 'true')
  await expect(appPage.getByTestId('compare-focus-summary')).toContainText('This finding is about schema changes above.')
  await expect(appPage.getByTestId('schema-changes')).toBeVisible()
  await appPage.getByTestId('compare-focus-clear').click()
  await expect(schemaFocus).toHaveAttribute('aria-pressed', 'false')
  await expect(appPage.getByTestId('snapshot-diff-list')).not.toContainText('No changes')
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

test('preserves a field default through a template-manager save (no data loss)', async ({
  appPage,
  electronApp,
  workspaceDir,
}) => {
  const projectDir = join(workspaceDir, 'defaults')
  mkdirSync(projectDir, { recursive: true })
  const manifest = {
    version: 3,
    id: 'def-id',
    name: 'Defaults Lab',
    created: '2026-01-01T00:00:00.000Z',
    modified: '2026-01-01T00:00:00.000Z',
    templates: {
      asset: { label: 'Asset', fields: { serial: { type: 'string', default: 'SN-DEFAULT' } } },
    },
    nodes: [
      {
        id: 'root', parentId: null, name: 'Defaults Lab', order: 0, properties: {},
        created: '2026-01-01T00:00:00.000Z', modified: '2026-01-01T00:00:00.000Z',
      },
    ],
  }
  writeFileSync(join(projectDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')

  await setDialogPath(electronApp, projectDir)
  await appPage.getByTestId('open-project-btn').click()
  await expect(appPage.getByTestId('project-view')).toBeVisible()

  // Save the template through the manager (round-trips through buildTemplate).
  await appPage.getByTestId('open-templates-btn').click()
  await appPage.getByTestId('template-list-item').filter({ hasText: 'Asset' }).click()
  await appPage.getByTestId('template-save').click()
  await expect(appPage.getByTestId('template-form-error')).toHaveCount(0)
  await appPage.getByTestId('template-manager-close').click()

  // A new node bound to the template must still be seeded with the default —
  // proving the save did not drop the field's `default`.
  await openContextMenuAction(appPage, 'Defaults Lab', 'Add Child')
  await appPage.getByTestId('add-child-template').selectOption('asset')
  await appPage.getByTestId('add-child-input').fill('Pump')
  await appPage.getByTestId('add-child-commit').click()
  await treeRow(appPage, 'Pump').click()
  await expect(appPage.getByTestId('tpl-input-serial')).toHaveValue('SN-DEFAULT')
})

test('selecting a node bound to a structurally-invalid template does not crash the renderer', async ({
  appPage,
  electronApp,
  workspaceDir,
}) => {
  const projectDir = join(workspaceDir, 'invalid-tpl')
  mkdirSync(projectDir, { recursive: true })
  const manifest = {
    version: 3,
    id: 'inv-id',
    name: 'Invalid Tpl Lab',
    created: '2026-01-01T00:00:00.000Z',
    modified: '2026-01-01T00:00:00.000Z',
    templates: { bad: { label: 'Bad' } },   // no `fields` — structurally invalid
    nodes: [
      {
        id: 'root', parentId: null, name: 'Invalid Tpl Lab', order: 0, properties: {},
        created: '2026-01-01T00:00:00.000Z', modified: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'n1', parentId: 'root', name: 'Widget', order: 0,
        templateId: 'bad', properties: { note: 'hi' },
        created: '2026-01-01T00:00:00.000Z', modified: '2026-01-01T00:00:00.000Z',
      },
    ],
  }
  writeFileSync(join(projectDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')

  await setDialogPath(electronApp, projectDir)
  await appPage.getByTestId('open-project-btn').click()
  await expect(appPage.getByTestId('project-view')).toBeVisible()
  await expect(appPage.getByTestId('load-warnings-banner')).toBeVisible()

  // Selecting the bound node must render the detail pane (previously this threw
  // Object.entries(undefined) on the invalid template's fields).
  await treeRow(appPage, 'Widget').click()
  await expect(appPage.getByTestId('node-name')).toContainText('Widget')
  await expect(appPage.getByTestId('template-selector')).toBeVisible()
  await expect(appPage.getByTestId('prop-value').filter({ hasText: 'hi' })).toBeVisible()
})

test('a typed number field normalizes its visible draft after a no-op commit', async ({
  appPage,
  electronApp,
  workspaceDir,
}) => {
  await createProjectThroughUi(appPage, electronApp, workspaceDir, 'Normalize Lab')

  await appPage.getByTestId('open-templates-btn').click()
  await appPage.getByTestId('template-label').fill('Counter')
  await appPage.getByTestId('template-add-field').click()
  await appPage.getByTestId('field-key').nth(0).fill('units')
  await appPage.getByTestId('field-type').nth(0).selectOption('number')
  await appPage.getByTestId('template-save').click()
  await appPage.getByTestId('template-manager-close').click()

  await openContextMenuAction(appPage, 'Normalize Lab', 'Add Child')
  await appPage.getByTestId('add-child-template').selectOption('counter')
  await appPage.getByTestId('add-child-input').fill('Item')
  await appPage.getByTestId('add-child-commit').click()
  await treeRow(appPage, 'Item').click()

  const units = appPage.getByTestId('tpl-input-units')
  await units.fill('5')
  await units.press('Enter')           // stored as 5
  await units.fill('05')
  await units.press('Enter')           // normalizes back to 5 (stored value unchanged)
  await expect(units).toHaveValue('5') // draft must reflect the canonical form
})

test('compare mode resolves typed fields per side (ghost uses the from-snapshot template)', async ({
  appPage,
  electronApp,
  workspaceDir,
}) => {
  const projectName = 'Per-Side Template Lab'
  await createProjectThroughUi(appPage, electronApp, workspaceDir, projectName)

  // Template "Gauge" with a single typed field, voltage.
  await appPage.getByTestId('open-templates-btn').click()
  await expect(appPage.getByTestId('template-manager')).toBeVisible()
  await appPage.getByTestId('template-label').fill('Gauge')
  await appPage.getByTestId('template-add-field').click()
  await appPage.getByTestId('field-key').nth(0).fill('voltage')
  await appPage.getByTestId('field-type').nth(0).selectOption('number')
  await appPage.getByTestId('template-save').click()
  await expect(appPage.getByTestId('template-list-item').filter({ hasText: 'Gauge' })).toBeVisible()
  await appPage.getByTestId('template-manager-close').click()

  // Two nodes bound to the template: one we'll keep, one we'll delete.
  for (const name of ['Keeper', 'Old Gauge']) {
    await openContextMenuAction(appPage, projectName, 'Add Child')
    await appPage.getByTestId('add-child-template').selectOption('gauge')
    await appPage.getByTestId('add-child-input').fill(name)
    await appPage.getByTestId('add-child-commit').click()
    await expect(treeRow(appPage, name)).toBeVisible()
  }

  await openSnapshotsPanel(appPage)
  await createSnapshot(appPage, 'v1')

  // After v1: delete Old Gauge (→ ghost in compare) and add a NEW field
  // 'amperage' to the template (so the current schema differs from v1's).
  appPage.once('dialog', (dialog) => dialog.accept())
  await openContextMenuAction(appPage, 'Old Gauge', 'Delete…')
  await expect(treeRow(appPage, 'Old Gauge')).toHaveCount(0)

  await appPage.getByTestId('open-templates-btn').click()
  await appPage.getByTestId('template-list-item').filter({ hasText: 'Gauge' }).click()
  await appPage.getByTestId('template-add-field').click()
  await appPage.getByTestId('field-key').nth(1).fill('amperage')
  await appPage.getByTestId('field-type').nth(1).selectOption('number')
  await appPage.getByTestId('template-save').click()
  await expect(appPage.getByTestId('template-form-error')).toHaveCount(0)
  await appPage.getByTestId('template-manager-close').click()

  // Edit Keeper's voltage so it's a CHANGED node (property-changed) — it then
  // stays full/visible in compare instead of being folded as unchanged, which
  // lets us assert the live (TO) side inside compare mode below.
  await treeRow(appPage, 'Keeper').click()
  await expect(appPage.getByTestId('tpl-field-amperage')).toBeVisible() // current schema has both
  const keeperVoltage = appPage.getByTestId('tpl-input-voltage')
  await keeperVoltage.fill('42')
  await keeperVoltage.press('Enter')

  await createSnapshot(appPage, 'v2')
  await compareSnapshots(appPage, 'v1', 'v2')

  // Live "Keeper" is a TO-side node → current template (voltage + amperage).
  // Asserts the live branch of the per-side resolution WHILE in compare mode.
  await treeRow(appPage, 'Keeper').click()
  await expect(appPage.getByTestId('tpl-field-voltage')).toBeVisible()
  await expect(appPage.getByTestId('tpl-field-amperage')).toBeVisible()

  // The ghost "Old Gauge" is a FROM-side node → it must render with v1's template
  // (voltage only). Before the fix it used the current template and showed an
  // amperage field that never existed when the node did. (Removed nodes are
  // changed, so the ghost stays visible — not folded like unchanged nodes.)
  const ghost = appPage.locator('[data-testid="tree-node"][data-row-ghost="true"]', { hasText: 'Old Gauge' })
  await expect(ghost).toBeVisible()
  await ghost.click()
  await expect(appPage.getByTestId('detail-tombstone-banner')).toBeVisible()
  await expect(appPage.getByTestId('tpl-field-voltage')).toBeVisible()
  await expect(appPage.getByTestId('tpl-field-amperage')).toHaveCount(0)
})
