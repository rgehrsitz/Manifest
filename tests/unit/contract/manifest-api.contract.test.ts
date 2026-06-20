// ManifestAPI contract / conformance suite.
//
// Scripted scenarios drive the core ManifestAPI surface end-to-end against the
// real backend (ProjectManager + real GitService + SQLite indices, in a temp
// git repo). Each call's Result<T> is normalized (see normalize.ts) and the
// ordered log is compared to a committed golden file.
//
// WHY: a backend-agnostic behavioral spec. The IPC handlers in
// src/main/index.ts are thin pass-throughs to ProjectManager, so this IS the
// API contract. A future backend (e.g. a Rust/Tauri rewrite) implementing the
// same ManifestAPI must reproduce these goldens when driven through the same
// scenarios — turning "did we preserve behavior?" into a runnable diff.
//
// Regenerate goldens after an intentional contract change:
//   UPDATE_GOLDENS=1 bun run test -- tests/unit/contract
// Review the golden diff like any other reviewed change.
//
// KNOWN LIMITATIONS (Codex review — acceptable for hardening today's TS backend;
// must be handled before this is a true cross-language conformance harness):
//   - Collection ORDER (nodes, search hits, diffs, ghosts, blockers, report
//     sections) is asserted as-is. Deterministic for the TS backend, but a Rust
//     backend would need to match ordering or the harness would need to sort.
//   - Object KEY order feeds the first-seen id-placeholder assignment; a backend
//     emitting equivalent JSON with different key order could renumber. A
//     cross-backend harness should canonicalize key order first.
//   - Search RELEVANCE ORDER is a deliberate non-goal. recordSearch re-sorts hits
//     by (name, parent, matchField) to strip SQLite bm25/locale ordering, so the
//     golden pins the result SET and field values, NOT the ranking. A regression
//     that broke bm25 ordering would NOT be caught here — assert rank separately
//     if/when ranking becomes a contract.
//   - The normalizer's UUID scrub is global (any uuid-shaped string → <id:N>), so
//     scenarios must not use uuid-shaped user values (names/property values); a
//     uuid-shaped serial would be mis-scrubbed as an id. All ids in this codebase
//     are uuidv7, which the regex's version nibble (1-8) matches.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { ProjectManager } from '../../../src/main/project-manager'
import { GitService } from '../../../src/main/git-service'
import { CURRENT_PROJECT_REF } from '../../../src/shared/snapshot-ref'
import type { Logger } from '../../../src/main/logger'
import type { ManifestNode, NodeTemplate, Project, Result } from '../../../src/shared/types'
import { MAX_VERSION_LEN } from '../../../src/shared/validation'
import { ok } from '../../../src/shared/errors'
import { normalize } from './normalize'

const noopLogger: Logger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }
const GOLDEN_DIR = join(__dirname, '__golden__')

// One past the real version-length limit — derived from the validation constant
// so the coercion-failure step stays valid if the limit ever changes.
const OVER_MAX_VERSION = 'x'.repeat(MAX_VERSION_LEN + 1)

let tmpDir: string
let managers: ProjectManager[] = []

beforeEach(() => {
  tmpDir = join(tmpdir(), `manifest-contract-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(tmpDir, { recursive: true })
  managers = []
})

afterEach(async () => {
  for (const m of managers) {
    // Only close managers that still have a project open — a scenario may have
    // already closed one mid-test (e.g. persistence closes session 1 before
    // reopening). flushAndClose() nulls currentProject, so getCurrent() is the
    // reliable "already closed" signal; double-closing would no-op into a
    // PROJECT_NOT_FOUND Result we'd be ignoring anyway.
    if (!m.getCurrent()) continue
    m.cancelAutosave()
    await m.flushAndClose()
  }
  rmSync(tmpDir, { recursive: true, force: true })
})

interface Ctx {
  record: (step: string, result: unknown) => void
  /** Record a searchNodes result with hit order canonicalized — see recordSearch. */
  recordSearch: (step: string, result: Result<Array<{ nodeName: string; parentName: string | null; matchField: string }>>) => void
  makeManager: () => ProjectManager
  /** Create a project in tmpDir, scrub its path, return the manager + root id. */
  setupProject: (name: string) => Promise<{ m: ProjectManager; created: Result<Project>; rootId: string }>
  scrub: string[]
}

/** Run a scenario, normalize its full log once (shared id-map), compare golden. */
async function runScenario(goldenName: string, fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const rawLog: Array<{ step: string; result: unknown }> = []
  const scrub: string[] = [tmpDir]
  const makeManager = () => {
    const m = new ProjectManager(new GitService(noopLogger), noopLogger)
    managers.push(m)
    return m
  }
  const ctx: Ctx = {
    record: (step, result) => rawLog.push({ step, result }),
    recordSearch: (step, result) => {
      // bm25 rank + a locale-default name tiebreak (and the LIKE-fallback's
      // scan-order ranks) make raw search-hit order machine/SQLite-build
      // dependent. Canonicalize by deterministic fields (name, then parent,
      // then matched field — all fixed 'en' locale) so the committed golden is
      // stable across machines and reproducible by another backend. The hit's
      // nodeId is a fresh uuid per run, so it CANNOT be a tiebreak key.
      // Trade-off: this pins the result SET and names, NOT bm25 relevance order
      // (see KNOWN LIMITATIONS) — relevance ranking is backend-specific.
      if (result.ok) {
        const sorted = [...result.data].sort(
          (a, b) =>
            a.nodeName.localeCompare(b.nodeName, 'en') ||
            (a.parentName ?? '').localeCompare(b.parentName ?? '', 'en') ||
            a.matchField.localeCompare(b.matchField, 'en'),
        )
        rawLog.push({ step, result: { ...result, data: sorted } })
      } else {
        rawLog.push({ step, result })
      }
    },
    makeManager,
    setupProject: async (name) => {
      const m = makeManager()
      const created = await m.createProject(name, tmpDir)
      if (!created.ok) throw new Error(created.error.message)
      scrub.push(created.data.path!)
      const rootId = created.data.nodes.find((n) => n.parentId === null)!.id
      return { m, created, rootId }
    },
    scrub,
  }
  await fn(ctx)

  const log = normalize(rawLog, scrub)
  const golden = join(GOLDEN_DIR, goldenName)
  // Generate ONLY under the explicit UPDATE_GOLDENS=1 (not any non-empty value,
  // so a stray `UPDATE_GOLDENS=0` can't silently regenerate baselines). A missing
  // golden is a hard failure — it must never write-and-pass, or a deleted/
  // uncommitted golden would self-bless whatever the backend emits.
  if (process.env.UPDATE_GOLDENS === '1') {
    mkdirSync(GOLDEN_DIR, { recursive: true })
    writeFileSync(golden, JSON.stringify(log, null, 2) + '\n', 'utf8')
    return
  }
  if (!existsSync(golden)) {
    throw new Error(`Golden missing: ${goldenName}. Run UPDATE_GOLDENS=1 to (re)generate it, then review and commit the file.`)
  }
  expect(log).toEqual(JSON.parse(readFileSync(golden, 'utf8')))
}

const nodeId = (project: { nodes: ManifestNode[] }, name: string) =>
  project.nodes.find((n) => n.name === name)!.id

const instrumentTemplate: NodeTemplate = {
  label: 'Instrument',
  fields: {
    firmware: { type: 'version' },
    status: { type: 'enum', options: ['active', 'maintenance', 'retired'] },
    controller: { type: 'reference' },
  },
}

describe('ManifestAPI contract', () => {
  it('canonical lifecycle — full backend surface', async () => {
    await runScenario('lifecycle.json', async ({ record, recordSearch, setupProject }) => {
      const { m, created, rootId } = await setupProject('Contract Lab')
      record('createProject', created)

      record('templateCreate', m.templateCreate('instrument', instrumentTemplate))

      const rackA = m.nodeCreate(rootId, 'Rack A')
      record('nodeCreate(Rack A)', rackA)
      if (!rackA.ok) throw new Error('rackA')
      const rackAId = nodeId(rackA.data, 'Rack A')

      const probe = m.nodeCreate(rootId, 'Probe', 'instrument')
      record('nodeCreate(Probe, instrument)', probe)
      if (!probe.ok) throw new Error('probe')
      const probeId = nodeId(probe.data, 'Probe')

      record('nodeUpdate(Probe typed+ref)', m.nodeUpdate(probeId, {
        properties: { firmware: 'v1.2.0', status: 'active', controller: rackAId },
      }))
      record('nodeUpdate(rename Rack A)', m.nodeUpdate(rackAId, { name: 'Rack Alpha' }))
      record('snapshotCreate(v1)', await m.snapshotCreate('v1'))

      const rackB = m.nodeCreate(rootId, 'Rack B')
      record('nodeCreate(Rack B)', rackB)
      if (!rackB.ok) throw new Error('rackB')
      record('nodeMove(Probe under Rack B)', m.nodeMove(probeId, nodeId(rackB.data, 'Rack B'), 0))

      recordSearch('searchNodes(rack)', m.searchNodes('rack'))
      record('snapshotCompare(v1,@current)', await m.snapshotCompare('v1', CURRENT_PROJECT_REF))
      record('snapshotLoadCompare(v1,@current)', await m.snapshotLoadCompare('v1', CURRENT_PROJECT_REF))
      record('buildReport(v1,@current,markdown)', await m.buildReport('v1', CURRENT_PROJECT_REF, 'markdown'))
      record('nodeDelete(Rack Alpha) blocked', m.nodeDelete(rackAId))
      record('nodeDelete(Rack Alpha) force', m.nodeDelete(rackAId, { unlinkReferences: true }))
      // getCurrent is the one method whose IPC handler wraps the bare
      // ProjectManager return in ok() — record the Result<Project|null> envelope
      // so the golden matches the actual ManifestAPI contract, not the internal.
      record('getCurrent', ok(m.getCurrent()))
    })
  })

  it('error contracts — deterministic Result.err shapes', async () => {
    await runScenario('error-contracts.json', async ({ record, setupProject }) => {
      const { m, rootId } = await setupProject('Errors Lab')

      // not found
      record('nodeUpdate(nonexistent)', m.nodeUpdate('nonexistent-node-id', { name: 'x' }))
      record('nodeDelete(nonexistent)', m.nodeDelete('nonexistent-node-id'))

      // root protection
      record('nodeDelete(root) invalid-hierarchy', m.nodeDelete(rootId))

      // typed coercion failure
      m.templateCreate('instrument', instrumentTemplate)
      const probe = m.nodeCreate(rootId, 'Probe', 'instrument')
      if (!probe.ok) throw new Error('probe')
      const probeId = nodeId(probe.data, 'Probe')
      record('nodeUpdate(bad enum) coercion', m.nodeUpdate(probeId, { properties: { status: 'bogus' } }))
      record('nodeUpdate(bad version) coercion',
        m.nodeUpdate(probeId, { properties: { firmware: OVER_MAX_VERSION } }))

      // move into own descendant
      const parent = m.nodeCreate(rootId, 'Parent')
      if (!parent.ok) throw new Error('parent')
      const parentId = nodeId(parent.data, 'Parent')
      const child = m.nodeCreate(parentId, 'Child')
      if (!child.ok) throw new Error('child')
      record('nodeMove(into descendant) invalid-hierarchy',
        m.nodeMove(parentId, nodeId(child.data, 'Child'), 0))

      // duplicate sibling name
      record('nodeCreate(duplicate sibling)', m.nodeCreate(rootId, 'Parent'))

      // invalid template id (not a slug)
      record('templateCreate(bad slug)', m.templateCreate('Not A Slug', instrumentTemplate))

      // unknown template binding
      record('nodeCreate(unknown template)', m.nodeCreate(rootId, 'X', 'ghost-template'))

      // Snapshot-read failure: the CODE is the contract, but the message is
      // git-version dependent, so assert the code directly (on this scenario's
      // own manager) rather than baking the message into a golden.
      const missing = await m.snapshotCompare('nope-a', 'nope-b')
      expect(missing.ok).toBe(false)
      if (!missing.ok) expect(missing.error.code).toBe('SNAPSHOT_READ_FAILED')
    })
  })

  it('all node diff types surface in a single compare', async () => {
    await runScenario('diff-types.json', async ({ record, setupProject }) => {
      const { m, rootId } = await setupProject('Diff Lab')

      m.templateCreate('alpha', { label: 'Alpha', fields: { a: { type: 'string' } } })
      m.templateCreate('beta', { label: 'Beta', fields: { b: { type: 'string' } } })

      // before: siblings + one bound to template alpha + one nested under Keep
      for (const n of ['Keep', 'ToRemove', 'ToRename', 'ToProp', 'ToReorder']) m.nodeCreate(rootId, n)
      const bound = m.nodeCreate(rootId, 'ToRebind', 'alpha')
      if (!bound.ok) throw new Error('bound')
      const keepId = nodeId(bound.data, 'Keep')
      const toMove = m.nodeCreate(keepId, 'ToMove') // nested so it can be reparented → moved
      if (!toMove.ok) throw new Error('toMove')
      const ids = Object.fromEntries(
        ['ToRemove', 'ToRename', 'ToProp', 'ToReorder', 'ToRebind', 'ToMove'].map((n) => [
          n,
          nodeId(toMove.data, n),
        ]),
      )
      await m.snapshotCreate('before')

      // mutate to produce every node-level change type
      m.nodeCreate(rootId, 'Added')                                       // added
      m.nodeDelete(ids.ToRemove)                                          // removed
      m.nodeUpdate(ids.ToRename, { name: 'Renamed' })                     // renamed
      m.nodeUpdate(ids.ToProp, { properties: { note: 'changed' } })       // property-changed
      m.nodeMove(ids.ToReorder, rootId, 0)                                // order-changed (same parent)
      m.nodeMove(ids.ToMove, rootId, 1)                                   // moved (reparent Keep→root)
      m.nodeUpdate(ids.ToRebind, { templateId: 'beta' })                  // template-changed

      record('snapshotCompare(before,@current)', await m.snapshotCompare('before', CURRENT_PROJECT_REF))
      const merged = await m.snapshotLoadCompare('before', CURRENT_PROJECT_REF)
      // Capture just the summary + per-node {name,status} to keep the golden
      // focused on the diff contract (not the full node payloads).
      record('loadCompare summary', merged.ok ? { ok: true, summary: merged.data.summary } : merged)
      record('loadCompare node statuses', merged.ok
        ? { ok: true, nodes: merged.data.nodes.map((n) => ({ name: n.name, status: n.status })) }
        : merged)
    })
  })

  it('persistence — state round-trips through close + reopen', async () => {
    let projectDir = ''
    await runScenario('persistence.json', async ({ record, recordSearch, makeManager, setupProject }) => {
      // Session 1: build + snapshot + an unsnapshotted change, then close.
      const { m: m1, created, rootId } = await setupProject('Persist Lab')
      projectDir = created.ok ? created.data.path! : ''
      m1.templateCreate('instrument', instrumentTemplate)
      const probe = m1.nodeCreate(rootId, 'Probe', 'instrument')
      if (!probe.ok) throw new Error('probe')
      m1.nodeUpdate(nodeId(probe.data, 'Probe'), { properties: { firmware: 'v3.0.0', status: 'active' } })
      await m1.snapshotCreate('v1')
      m1.nodeCreate(rootId, 'Unsnapshotted Rack')
      m1.cancelAutosave()
      await m1.flushAndClose()

      // Session 2: reopen the same directory and assert state survived.
      const m2 = makeManager()
      record('reopen openProject', await m2.openProject(projectDir))
      record('reopen getCurrent', ok(m2.getCurrent())) // Result envelope — see lifecycle
      record('reopen snapshotList', await m2.snapshotList())
      recordSearch('reopen searchNodes(probe)', m2.searchNodes('probe'))
    })
  })

  it('CSV import + property-value search', async () => {
    await runScenario('import-search.json', async ({ record, recordSearch, setupProject }) => {
      const { m, rootId } = await setupProject('Import Lab')

      const csv = join(tmpDir, 'rows.csv')
      writeFileSync(csv, 'name,serial,firmware\nProbe X,SN-100,v1.0.0\nProbe Y,SN-200,v2.0.0\n', 'utf8')

      record('inspectImport', m.inspectImport(csv))
      const mapping = {
        placement: 'flat' as const,
        baseParentId: rootId,
        nameColumn: 'name',
        templateId: null,
        columns: [
          { header: 'serial', key: 'serial', include: true },
          { header: 'firmware', key: 'firmware', include: true },
        ],
      }
      record('planImportCsv', m.planImportCsv(csv, mapping))
      record('applyImportCsv', m.applyImportCsv(csv, mapping))

      // property-value search hits the imported serial
      recordSearch('searchNodes(SN-200)', m.searchNodes('SN-200'))
    })
  })
})
