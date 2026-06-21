import { mkdirSync, writeFileSync } from 'fs'
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

async function setDialogCanceled(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] })
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

async function createTemplateWithCount(appPage: Page): Promise<void> {
  await appPage.getByTestId('open-templates-btn').click()
  await appPage.getByTestId('template-label').fill('Software Item')
  await appPage.getByTestId('template-add-field').click()
  await appPage.getByTestId('field-key').nth(0).fill('count')
  await appPage.getByTestId('field-type').nth(0).selectOption('number')
  await appPage.getByTestId('template-save').click()
  await expect(appPage.getByTestId('template-list-item').filter({ hasText: 'Software Item' })).toBeVisible()
  await appPage.getByTestId('template-manager-close').click()
}

test('imports CSV: maps a spaced header, coerces typed cells, skips invalid + duplicate rows', async ({
  appPage,
  electronApp,
  workspaceDir,
}) => {
  await createProjectThroughUi(appPage, electronApp, workspaceDir, 'Import Lab')
  await createTemplateWithCount(appPage)

  // A spreadsheet-style CSV: a "Serial Number" header, an invalid count, and a
  // duplicate name.
  const csv = [
    'name,Serial Number,count',
    'B1,SN-1,5',
    'B2,SN-2,abc',   // invalid count → skipped
    'B1,SN-3,7',     // duplicate name → skipped
  ].join('\n') + '\n'
  const csvPath = join(workspaceDir, 'boards.csv')
  writeFileSync(csvPath, csv, 'utf8')

  await appPage.getByTestId('open-import-btn').click()
  await expect(appPage.getByTestId('import-dialog')).toBeVisible()

  await setDialogPath(electronApp, csvPath)
  await appPage.getByTestId('import-choose-file').click()

  // Name auto-detected; bind the template; rename the spaced header's key.
  await expect(appPage.getByTestId('import-name-column')).toHaveValue('name')
  await appPage.getByTestId('import-template').selectOption('software-item')
  await appPage.getByTestId('import-col-key-Serial Number').fill('serial')

  await appPage.getByTestId('import-validate').click()
  const summary = appPage.getByTestId('import-summary')
  await expect(summary).toContainText('1 will import')
  await expect(summary).toContainText('2 skipped')

  await appPage.getByTestId('import-apply').click()
  await expect(appPage.getByTestId('import-dialog')).toHaveCount(0)
  await expect(appPage.getByTestId('import-summary-banner')).toContainText('Imported 1')

  // The imported node carries a coerced number and the ad-hoc serial.
  await treeRow(appPage, 'B1').click()
  await expect(appPage.getByTestId('tpl-input-count')).toHaveValue('5')
  await expect(appPage.getByTestId('prop-value').filter({ hasText: 'SN-1' })).toBeVisible()
})

test('imported nodes show as added in a snapshot compare', async ({
  appPage,
  electronApp,
  workspaceDir,
}) => {
  await createProjectThroughUi(appPage, electronApp, workspaceDir, 'Import Diff Lab')

  await appPage.getByTestId('open-snapshots-btn').click()
  await appPage.getByTestId('snapshot-name-input').fill('before')
  await appPage.getByTestId('create-snapshot-btn').click()
  await expect(appPage.getByTestId('snapshot-row').filter({ hasText: 'before' })).toBeVisible()

  const csvPath = join(workspaceDir, 'rows.csv')
  writeFileSync(csvPath, 'name\nWidget A\nWidget B\n', 'utf8')
  await appPage.getByTestId('open-import-btn').click()
  await setDialogPath(electronApp, csvPath)
  await appPage.getByTestId('import-choose-file').click()
  await appPage.getByTestId('import-validate').click()
  await expect(appPage.getByTestId('import-summary')).toContainText('2 will import')
  await appPage.getByTestId('import-apply').click()
  await expect(appPage.getByTestId('import-dialog')).toHaveCount(0)

  await appPage.getByTestId('snapshot-name-input').fill('after')
  await appPage.getByTestId('create-snapshot-btn').click()
  await expect(appPage.getByTestId('snapshot-row').filter({ hasText: 'after' })).toBeVisible()

  await appPage.getByTestId('compare-from-select').selectOption('before')
  await appPage.getByTestId('compare-to-select').selectOption('after')
  await appPage.getByTestId('compare-snapshots-btn').click()
  await expect(appPage.getByTestId('snapshot-diff-list')).toBeVisible()
  await expect(appPage.getByTestId('snapshot-diff-row').filter({ hasText: 'Widget A' })).toBeVisible()
})

test('a parent_path column defaults to path mode and places rows under the resolved node', async ({
  appPage,
  electronApp,
  workspaceDir,
}) => {
  await createProjectThroughUi(appPage, electronApp, workspaceDir, 'Path Lab')

  // Give the path a real target to resolve to.
  await openContextMenuAction(appPage, 'Path Lab', 'Add Child')
  await appPage.getByTestId('add-child-input').fill('Bay 1')
  await appPage.getByTestId('add-child-commit').click()
  await expect(treeRow(appPage, 'Bay 1')).toBeVisible()

  // Breadcrumb includes the root name; resolution tolerates the leading segment.
  const csv = 'name,parent_path\nWidget,Path Lab / Bay 1\n'
  const csvPath = join(workspaceDir, 'hier.csv')
  writeFileSync(csvPath, csv, 'utf8')

  // Import under the root explicitly so the path resolves from there.
  await openContextMenuAction(appPage, 'Path Lab', 'Import rows here…')
  await setDialogPath(electronApp, csvPath)
  await appPage.getByTestId('import-choose-file').click()

  // The presence of parent_path flips the default to path placement.
  await expect(appPage.getByTestId('import-placement-path')).toBeChecked()
  await expect(appPage.getByTestId('import-path-column')).toHaveValue('parent_path')

  await appPage.getByTestId('import-validate').click()
  await expect(appPage.getByTestId('import-summary')).toContainText('1 will import')
  await appPage.getByTestId('import-apply').click()
  await expect(appPage.getByTestId('import-dialog')).toHaveCount(0)

  // Widget landed under Bay 1, not under the root.
  await treeRow(appPage, 'Bay 1').dblclick()
  await expect(treeRow(appPage, 'Widget')).toBeVisible()
})

test('auto-create builds missing parents so a hierarchical export loads into an empty project', async ({
  appPage,
  electronApp,
  workspaceDir,
}) => {
  await createProjectThroughUi(appPage, electronApp, workspaceDir, 'AutoCreate Lab')

  // A board-only export: rows reference racks/rooms that do not exist yet.
  const csv =
    'name,parent_path\n' +
    'Server A,Room X / Rack 1\n' +
    'Server B,Room X / Rack 1\n'
  const csvPath = join(workspaceDir, 'flat-export.csv')
  writeFileSync(csvPath, csv, 'utf8')

  await openContextMenuAction(appPage, 'AutoCreate Lab', 'Import rows here…')
  await setDialogPath(electronApp, csvPath)
  await appPage.getByTestId('import-choose-file').click()

  // parent_path → path mode by default; without auto-create the rows can't resolve.
  await expect(appPage.getByTestId('import-placement-path')).toBeChecked()
  await appPage.getByTestId('import-validate').click()
  await expect(appPage.getByTestId('import-summary')).toContainText('0 will import')

  // Turn on auto-create and re-validate.
  await appPage.getByTestId('import-auto-create').check()
  await appPage.getByTestId('import-validate').click()
  await expect(appPage.getByTestId('import-summary')).toContainText('2 will import')
  await expect(appPage.getByTestId('import-summary')).toContainText('2 parents created')

  await appPage.getByTestId('import-apply').click()
  await expect(appPage.getByTestId('import-dialog')).toHaveCount(0)
  await expect(appPage.getByTestId('import-summary-banner')).toContainText('2 parents created')

  // The Room X → Rack 1 → Server chain now exists.
  await treeRow(appPage, 'Room X').dblclick()
  await treeRow(appPage, 'Rack 1').dblclick()
  await expect(treeRow(appPage, 'Server A')).toBeVisible()
})

test('canceled file picker leaves the dialog on the choose step', async ({
  appPage,
  electronApp,
  workspaceDir,
}) => {
  await createProjectThroughUi(appPage, electronApp, workspaceDir, 'Cancel Lab')
  await appPage.getByTestId('open-import-btn').click()
  await setDialogCanceled(electronApp)
  await appPage.getByTestId('import-choose-file').click()
  // Still on the choose step (no mapping controls), no crash.
  await expect(appPage.getByTestId('import-choose-file')).toBeVisible()
  await expect(appPage.getByTestId('import-name-column')).toHaveCount(0)
})

test('a malformed CSV shows an error and stays on the choose step', async ({
  appPage,
  electronApp,
  workspaceDir,
}) => {
  await createProjectThroughUi(appPage, electronApp, workspaceDir, 'Bad CSV Lab')
  const csvPath = join(workspaceDir, 'bad.csv')
  writeFileSync(csvPath, 'name\n"oops', 'utf8')   // unterminated quote
  await appPage.getByTestId('open-import-btn').click()
  await setDialogPath(electronApp, csvPath)
  await appPage.getByTestId('import-choose-file').click()
  // Inspect failed → error shown, no mapping controls, Choose still available.
  await expect(appPage.getByTestId('import-error')).toBeVisible()
  await expect(appPage.getByTestId('import-name-column')).toHaveCount(0)
  await expect(appPage.getByTestId('import-choose-file')).toBeEnabled()
})

test('duplicate keys block Validate, and editing after a plan re-disables Import', async ({
  appPage,
  electronApp,
  workspaceDir,
}) => {
  await createProjectThroughUi(appPage, electronApp, workspaceDir, 'Gating Lab')
  const csvPath = join(workspaceDir, 'g.csv')
  writeFileSync(csvPath, 'name,a,b\nN1,1,2\n', 'utf8')
  await appPage.getByTestId('open-import-btn').click()
  await setDialogPath(electronApp, csvPath)
  await appPage.getByTestId('import-choose-file').click()

  // Collide the two property keys → Validate disabled, duplicate hint shown.
  await appPage.getByTestId('import-col-key-a').fill('dup')
  await appPage.getByTestId('import-col-key-b').fill('dup')
  await expect(appPage.getByTestId('import-validate')).toBeDisabled()

  // Fix it → Validate enabled → a plan appears → Import enabled.
  await appPage.getByTestId('import-col-key-b').fill('bee')
  await expect(appPage.getByTestId('import-validate')).toBeEnabled()
  await appPage.getByTestId('import-validate').click()
  await expect(appPage.getByTestId('import-summary')).toContainText('1 will import')
  await expect(appPage.getByTestId('import-apply')).toBeEnabled()

  // Editing any mapping control invalidates the plan → Import disabled again.
  // (Testid is keyed by the CSV header 'b', not the property key.)
  await appPage.getByTestId('import-col-key-b').fill('beee')
  await expect(appPage.getByTestId('import-summary')).toHaveCount(0)
  await expect(appPage.getByTestId('import-apply')).toBeDisabled()
})

test('update-on-key: re-import updates a matched node instead of duplicating it', async ({ appPage, electronApp, workspaceDir }) => {
  await createProjectThroughUi(appPage, electronApp, workspaceDir, 'Update Lab')

  // First import creates Widget with note=first (flat under root, freeform).
  const v1 = join(workspaceDir, 'v1.csv')
  writeFileSync(v1, 'name,note\nWidget,first\n', 'utf8')
  await appPage.getByTestId('open-import-btn').click()
  await setDialogPath(electronApp, v1)
  await appPage.getByTestId('import-choose-file').click()
  await appPage.getByTestId('import-validate').click()
  await expect(appPage.getByTestId('import-summary')).toContainText('1 will import')
  await appPage.getByTestId('import-apply').click()
  await expect(appPage.getByTestId('import-dialog')).toHaveCount(0)
  await expect(treeRow(appPage, 'Widget')).toBeVisible()

  // Re-import with a changed note, update mode keyed on name.
  const v2 = join(workspaceDir, 'v2.csv')
  writeFileSync(v2, 'name,note\nWidget,second\n', 'utf8')
  await appPage.getByTestId('open-import-btn').click()
  await setDialogPath(electronApp, v2)
  await appPage.getByTestId('import-choose-file').click()
  await appPage.getByTestId('import-update-existing').check()
  await expect(appPage.getByTestId('import-key-column')).toHaveValue('name')
  await appPage.getByTestId('import-validate').click()
  await expect(appPage.getByTestId('import-summary')).toContainText('1 update')
  await appPage.getByTestId('import-apply').click()
  await expect(appPage.getByTestId('import-summary-banner')).toContainText('1 updated')

  // Exactly one Widget; its note is now "second".
  await expect(appPage.locator('[data-testid="tree-node"]', { hasText: 'Widget' })).toHaveCount(1)
  await treeRow(appPage, 'Widget').click()
  await expect(appPage.getByTestId('prop-value').filter({ hasText: 'second' })).toBeVisible()
})

test('update-on-key: a byte-identical re-import is a no-op (import disabled)', async ({ appPage, electronApp, workspaceDir }) => {
  await createProjectThroughUi(appPage, electronApp, workspaceDir, 'Noop Lab')
  const csv = join(workspaceDir, 'n.csv')
  writeFileSync(csv, 'name,note\nWidget,same\n', 'utf8')

  await appPage.getByTestId('open-import-btn').click()
  await setDialogPath(electronApp, csv)
  await appPage.getByTestId('import-choose-file').click()
  await appPage.getByTestId('import-validate').click()
  await appPage.getByTestId('import-apply').click()
  await expect(appPage.getByTestId('import-dialog')).toHaveCount(0)

  // Re-import the identical file with update mode → nothing to do.
  await appPage.getByTestId('open-import-btn').click()
  await setDialogPath(electronApp, csv)
  await appPage.getByTestId('import-choose-file').click()
  await appPage.getByTestId('import-update-existing').check()
  await appPage.getByTestId('import-validate').click()
  await expect(appPage.getByTestId('import-summary')).toContainText('0 will import')
  await expect(appPage.getByTestId('import-apply')).toBeDisabled()
})

test('imports a NetBox dumpdata JSON into a typed Site → Rack → Device tree', async ({
  appPage,
  electronApp,
  workspaceDir,
}) => {
  await createProjectThroughUi(appPage, electronApp, workspaceDir, 'NetBox Lab')

  // Minimal NetBox dumpdata: 1 site → 1 location → 1 rack → 2 devices, with FK
  // lookups (device_type → manufacturer, role, platform) to resolve.
  const dump = [
    { model: 'dcim.manufacturer', pk: 1, fields: { name: 'Cisco', slug: 'cisco' } },
    { model: 'dcim.devicetype', pk: 10, fields: { manufacturer: 1, model: 'C9300', slug: 'c9300', part_number: 'WS-C9300' } },
    { model: 'dcim.devicerole', pk: 20, fields: { name: 'Switch', slug: 'switch' } },
    { model: 'dcim.platform', pk: 40, fields: { name: 'IOS-XE', slug: 'ios-xe' } },
    { model: 'dcim.rackrole', pk: 30, fields: { name: 'Compute', slug: 'compute' } },
    { model: 'dcim.site', pk: 100, fields: { name: 'Site Alpha', status: 'active', facility: 'Bldg 1', time_zone: 'UTC', description: '', physical_address: '' } },
    { model: 'dcim.location', pk: 200, fields: { name: 'Room 1', site: 100, parent: null, level: 0, status: 'active', description: '' } },
    { model: 'dcim.rack', pk: 300, fields: { name: 'Rack A', site: 100, location: 200, role: 30, status: 'active', type: '4-post-cabinet', width: 19, u_height: '42.0', serial: 'RK-1', asset_tag: null, facility_id: '', description: '' } },
    { model: 'dcim.device', pk: 400, fields: { name: 'sw-01', site: 100, location: 200, rack: 300, position: '4.0', face: 'front', status: 'active', serial: 'SN-1', asset_tag: 'AT-1', device_type: 10, role: 20, platform: 40, description: '' } },
    { model: 'dcim.device', pk: 401, fields: { name: 'sw-02', site: 100, location: 200, rack: 300, position: '6.0', face: 'rear', status: 'active', serial: '', asset_tag: null, device_type: 10, role: 20, platform: null, description: '' } },
  ]
  const jsonPath = join(workspaceDir, 'netbox.json')
  writeFileSync(jsonPath, JSON.stringify(dump), 'utf8')

  await appPage.getByTestId('open-import-btn').click()
  await expect(appPage.getByTestId('import-dialog')).toBeVisible()

  // Choosing a .json routes to the NetBox flow (no column mapping).
  await setDialogPath(electronApp, jsonPath)
  await appPage.getByTestId('import-choose-file').click()
  await expect(appPage.getByTestId('netbox-counts')).toContainText('1 site')
  await expect(appPage.getByTestId('netbox-counts')).toContainText('2 devices')

  await appPage.getByTestId('netbox-validate').click()
  await expect(appPage.getByTestId('netbox-summary')).toContainText('5 nodes will import')

  await appPage.getByTestId('netbox-apply').click()
  await expect(appPage.getByTestId('import-dialog')).toHaveCount(0)
  await expect(appPage.getByTestId('import-summary-banner')).toContainText('Imported 5')

  // The Site landed in the tree as the top of the imported subtree.
  await expect(treeRow(appPage, 'Site Alpha')).toBeVisible()
})
