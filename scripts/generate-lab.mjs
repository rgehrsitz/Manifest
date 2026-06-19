#!/usr/bin/env node

// Domain-authentic synthetic data generator for dogfooding/perf/demo.
//
// Models a software-integration lab (the kind that mimics shipboard equipment
// at low voltage): Rooms → Racks → Devices. Computers carry a Hardware group
// (CPU/memory/GPU/NIC/storage) and a Software group (an OS plus several CSCIs,
// each version-tracked). Power supplies and waveform generators are calibrated
// test equipment; custom electronics boards fail and get repaired/replaced.
//
// Output is a v3 Manifest project (manifest.json with a `templates` map and
// typed property values) under a git repo, plus a timeline of daily snapshots
// (git commit + `snapshot/<name>` tag) applying realistic configuration churn:
// CSCI version bumps on test days, status changes, recalibrations, grouped
// maintenance events (a board fails → is replaced AND a co-located part is
// swapped AND a nearby supply is recalibrated, all in one snapshot), the odd
// quiet day, and a couple of additive template/schema edits.
//
// Snapshots are discovered by the app from git tags; notes live in history.json
// (not emitted here), so the event narrative is encoded in the snapshot NAME.

import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { isAbsolute, join, parse, relative, resolve } from 'path'
import { fileURLToPath } from 'url'

const CURRENT_VERSION = 3

// Written into a generated project dir so a later `--force` regeneration of the
// SAME dir is allowed, while refusing to wipe directories we didn't create.
const GEN_MARKER = '.manifest-generated-lab'

const DEFAULTS = {
  name: 'Software Integration Lab',
  rooms: 2,
  racksPerRoom: 60,
  computersPerRack: 4,
  customBoardsPerRack: 3,
  hwPerComputer: 5,
  csciPerComputer: 5,
  days: 40,
  seed: 42,
  output: null,
  force: false,
}

// ─── Templates (schema) ─────────────────────────────────────────────────────────
// Exercises every PropertyType: string, number, boolean, date, version, enum.

const TEMPLATES = {
  room: {
    label: 'Room',
    fields: {
      floor: { type: 'string' },
      square_feet: { type: 'number' },
    },
  },
  rack: {
    label: 'Rack',
    fields: {
      location: { type: 'string' },
      power_kw: { type: 'number' },
      status: { type: 'enum', options: ['active', 'standby', 'maintenance', 'offline'] },
    },
  },
  computer: {
    label: 'Shipboard Computer',
    description: 'Mission computer running shipboard or test software.',
    fields: {
      role: { type: 'enum', options: ['shipboard', 'test', 'spare'] },
      status: { type: 'enum', options: ['active', 'standby', 'maintenance', 'offline'] },
      serial: { type: 'string' },
      installed_date: { type: 'date' },
      air_gapped: { type: 'boolean' },
    },
  },
  'power-supply': {
    label: 'Power Supply',
    fields: {
      vendor: { type: 'string' },
      model: { type: 'string' },
      serial: { type: 'string' },
      max_voltage: { type: 'number' },
      firmware: { type: 'version' },
      status: { type: 'enum', options: ['active', 'standby', 'maintenance', 'failed'] },
      last_calibrated: { type: 'date' },
      calibration_due: { type: 'date' },
    },
  },
  'waveform-generator': {
    label: 'Waveform Generator',
    fields: {
      vendor: { type: 'string' },
      model: { type: 'string' },
      serial: { type: 'string' },
      channels: { type: 'number' },
      firmware: { type: 'version' },
      status: { type: 'enum', options: ['active', 'standby', 'maintenance', 'failed'] },
      last_calibrated: { type: 'date' },
      calibration_due: { type: 'date' },
    },
  },
  'custom-board': {
    label: 'Custom Board',
    description: 'In-house electronics board emulating shipboard hardware.',
    fields: {
      board_type: { type: 'string' },
      revision: { type: 'version' },
      serial: { type: 'string' },
      status: { type: 'enum', options: ['active', 'failed', 'repaired', 'spare'] },
      installed_date: { type: 'date' },
    },
  },
  'hw-component': {
    label: 'Hardware Component',
    fields: {
      type: { type: 'enum', options: ['cpu', 'memory', 'gpu', 'nic', 'storage'] },
      model: { type: 'string' },
      serial: { type: 'string' },
      status: { type: 'enum', options: ['active', 'degraded', 'failed', 'spare'] },
    },
  },
  os: {
    label: 'Operating System',
    fields: {
      version: { type: 'version' },
      variant: { type: 'enum', options: ['shipboard', 'test'] },
      patch_level: { type: 'string' },
    },
  },
  csci: {
    label: 'CSCI',
    description: 'Computer Software Configuration Item.',
    fields: {
      version: { type: 'version' },
      build: { type: 'enum', options: ['shipboard', 'test'] },
      status: { type: 'enum', options: ['active', 'deprecated'] },
      build_date: { type: 'date' },
    },
  },
}

const VENDORS = ['Acme', 'Vector', 'Northstar', 'Helix', 'Summit', 'Atlas']
const PS_MODELS = ['PS-1200', 'PS-2400', 'PS-3600', 'DCX-500']
const WG_MODELS = ['WG-100', 'WG-200', 'AWG-7k', 'AWG-9k']
const HW_MODELS = {
  cpu: ['Xeon-6338', 'EPYC-7543', 'Core-i9'],
  memory: ['DDR4-64G', 'DDR4-128G', 'DDR5-256G'],
  gpu: ['RTX-A4000', 'RTX-A6000', 'MI210'],
  nic: ['X710-DA2', 'E810-CQDA2', 'ConnectX-6'],
  storage: ['NVMe-2TB', 'NVMe-4TB', 'SAS-8TB'],
}
const BOARD_TYPES = ['signal-conditioner', 'relay-driver', 'adc-frontend', 'power-stage', 'comms-bridge']
const CSCI_NAMES = ['nav', 'fire-control', 'comms', 'sensor-fusion', 'hmi', 'bit', 'recorder', 'telemetry']
// The one synthetic board that scheduledStructuralChurn adds (d6), moves (d16),
// then removes (d30) — declared here (not inside the function) because main()
// runs at module load, before a mid-file const would initialize (TDZ).
const ADDED_BOARD_NAME = 'Custom Board (added)'

// Only run the CLI when executed directly (e.g. `bun scripts/generate-lab.mjs`),
// so tests can import generateTimeline / sampleCsv without triggering a run.
const invokedAsScript =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedAsScript) main(process.argv.slice(2))

function main(argv) {
  const options = parseArgs(argv)
  if (options.help) { printHelp(); return }
  validateOptions(options)

  const projectDir = resolve(options.output ?? `./tmp/${slugify(options.name)}-${stamp()}`)
  prepareOutputDir(projectDir, options.force)
  writeFileSync(join(projectDir, GEN_MARKER), 'Generated by scripts/generate-lab.mjs — safe to delete/regenerate.\n', 'utf8')

  // Build the whole timeline in memory (pure), then persist it: the initial
  // commit, one tagged commit per churned day, and the sample CSV from the final
  // state. generateTimeline is the single source of truth shared with the
  // regression test, so what we ship is exactly what the test verifies.
  const { initial, snapshots, final } = generateTimeline(options)
  writeManifest(projectDir, initial)
  initGit(projectDir, '2025-02-03T00:00:00Z')

  for (const snap of snapshots) {
    writeManifest(projectDir, snap.project)
    // Commit/tag with the SIMULATED date so listSnapshots (sorted by
    // creatordate) shows a stable, chronological timeline.
    snapshot(projectDir, snap.name, snap.date)
  }

  // Export the sample CSV from the FINAL (post-churn) project, so it faithfully
  // matches the manifest a user actually opens. Writing it from the day-0 state
  // left it stale: maintenance churn re-serializes some boards, so the day-0 CSV
  // no longer round-trips against the day-N manifest.
  writeSampleCsv(projectDir, final)

  const s = summarize(final)
  console.log(`Generated lab project at ${projectDir}`)
  console.log(`  Nodes:     ${s.nodes}`)
  console.log(`  Templates: ${Object.keys(final.templates).length}`)
  console.log(`  Max depth: ${s.depth}`)
  console.log(`  Snapshots: ${options.days}`)
  console.log(`  Seed:      ${options.seed}`)
  console.log(`Open it in the app via "Open Project" → ${projectDir}`)
}

// Pure timeline builder shared by main() and the regression test. Builds the
// initial project, applies applyDailyChurn day-by-day, and captures a JSON deep
// clone after each day (JSON-clone mirrors the on-disk serialization). No
// filesystem or git — callers persist (main) or assert (tests) the result.
// Returns { initial, snapshots: [{ day, label, name, date, project }], final, csv }.
export function generateTimeline(options) {
  const opts = { ...DEFAULTS, ...options }
  validateOptions(opts)

  const rng = createRng(opts.seed)
  const clock = makeClock(new Date('2025-01-06T08:00:00.000Z')) // a Monday
  const ctx = { rng, clock, seq: 0, intRange: rng.intRange }

  const project = buildInitialProject(opts, ctx)
  const clone = (p) => JSON.parse(JSON.stringify(p))
  const initial = clone(project)

  const snapshots = []
  for (let day = 1; day <= opts.days; day++) {
    const label = applyDailyChurn(project, opts, ctx, day)
    const dayStr = isoDate(addDays(new Date('2025-02-03T00:00:00.000Z'), day))
    snapshots.push({
      day,
      label,
      name: `d${pad(day, 2)}-${dayStr}-${label}`,
      date: `${dayStr}T12:00:00Z`,
      project: clone(project),
    })
  }

  return { initial, snapshots, final: project, csv: sampleCsv(project) }
}

// ─── Build ────────────────────────────────────────────────────────────────────

function buildInitialProject(options, ctx) {
  // node() sets created === modified from one clock tick; reuse it for the
  // project so root and project timestamps stay in sync (no extra clock step).
  const root = node(ctx, null, options.name, null, {})
  const project = {
    version: CURRENT_VERSION,
    id: gid(ctx),
    name: options.name,
    created: root.created,
    modified: root.modified,
    templates: structuredClone(TEMPLATES),
    nodes: [root],
  }

  for (let r = 0; r < options.rooms; r++) {
    const roomLabel = colLabel(r)
    const room = addChild(project, ctx, root, `Room ${roomLabel}`, 'room', {
      floor: `${r + 1}`,
      square_feet: 1200 + r * 300,
    })
    for (let k = 0; k < options.racksPerRoom; k++) {
      const rackName = `Rack ${roomLabel}-${pad(k + 1, 2)}`
      const rack = addChild(project, ctx, room, rackName, 'rack', {
        location: `${roomLabel}-${pad(k + 1, 2)}`,
        power_kw: round1(3 + ctx.rng() * 9),
        status: pick(ctx, TEMPLATES.rack.fields.status.options),
      })
      buildRackContents(project, ctx, rack, options)
    }
  }
  return project
}

function buildRackContents(project, ctx, rack, options) {
  for (let c = 0; c < options.computersPerRack; c++) {
    const comp = addChild(project, ctx, rack, `Computer ${pad(c + 1, 2)}`, 'computer', {
      role: pick(ctx, TEMPLATES.computer.fields.role.options),
      status: pick(ctx, TEMPLATES.computer.fields.status.options),
      serial: serial(ctx, 'CMP'),
      installed_date: pastDate(ctx, 30, 900),
      air_gapped: ctx.rng() < 0.4,
    })

    const hw = addChild(project, ctx, comp, 'Hardware', null, {})
    const types = TEMPLATES['hw-component'].fields.type.options
    for (let h = 0; h < options.hwPerComputer; h++) {
      const t = types[h % types.length]
      addChild(project, ctx, hw, `${t.toUpperCase()} ${pad(h + 1, 2)}`, 'hw-component', {
        type: t,
        model: pick(ctx, HW_MODELS[t]),
        serial: serial(ctx, t.slice(0, 3).toUpperCase()),
        status: weighted(ctx, [['active', 0.85], ['degraded', 0.08], ['spare', 0.05], ['failed', 0.02]]),
      })
    }

    const sw = addChild(project, ctx, comp, 'Software', null, {})
    addChild(project, ctx, sw, 'OS', 'os', {
      version: version(2, ctx.intRange(2, 6), ctx.intRange(0, 9)),
      variant: ctx.rng() < 0.5 ? 'shipboard' : 'test',
      patch_level: `p${ctx.intRange(0, 40)}`,
    })
    for (let s = 0; s < options.csciPerComputer; s++) {
      // Keep sibling names unique even when csciPerComputer exceeds CSCI_NAMES.
      const cn = s < CSCI_NAMES.length ? CSCI_NAMES[s] : `${CSCI_NAMES[s % CSCI_NAMES.length]}-${s + 1}`
      addChild(project, ctx, sw, `CSCI ${cn}`, 'csci', {
        version: version(ctx.intRange(1, 4), ctx.intRange(0, 9), ctx.intRange(0, 9)),
        build: ctx.rng() < 0.5 ? 'shipboard' : 'test',
        status: ctx.rng() < 0.9 ? 'active' : 'deprecated',
        build_date: pastDate(ctx, 5, 400),
      })
    }
  }

  addChild(project, ctx, rack, 'Power Supply', 'power-supply', testEquipmentProps(ctx, 'PS', PS_MODELS, { max_voltage: pick(ctx, [48, 120, 250, 600]) }))
  addChild(project, ctx, rack, 'Waveform Generator', 'waveform-generator', testEquipmentProps(ctx, 'WG', WG_MODELS, { channels: pick(ctx, [2, 4, 8]) }))

  for (let b = 0; b < options.customBoardsPerRack; b++) {
    addChild(project, ctx, rack, `Custom Board ${pad(b + 1, 2)}`, 'custom-board', {
      board_type: pick(ctx, BOARD_TYPES),
      revision: version(ctx.intRange(1, 3), ctx.intRange(0, 9), ctx.intRange(0, 9)),
      serial: serial(ctx, 'BRD'),
      status: weighted(ctx, [['active', 0.88], ['spare', 0.06], ['repaired', 0.04], ['failed', 0.02]]),
      installed_date: pastDate(ctx, 10, 700),
    })
  }
}

function testEquipmentProps(ctx, prefix, models, extra) {
  const lastCal = pastDate(ctx, 10, 350)
  return {
    vendor: pick(ctx, VENDORS),
    model: pick(ctx, models),
    serial: serial(ctx, prefix),
    firmware: version(1, ctx.intRange(0, 6), ctx.intRange(0, 9)),
    status: weighted(ctx, [['active', 0.9], ['standby', 0.06], ['maintenance', 0.04]]),
    last_calibrated: lastCal,
    calibration_due: isoDate(addDays(new Date(lastCal), 180)),
    ...extra,
  }
}

// ─── Daily churn ────────────────────────────────────────────────────────────────
// Returns a short snapshot-name slug describing the day.

function applyDailyChurn(project, options, ctx, day) {
  const today = isoDate(addDays(new Date('2025-02-03T00:00:00.000Z'), day))

  // Scheduled schema edits exercise the template/schema diff.
  if (day === 12) {
    project.templates['power-supply'].fields.warranty_expiry = { type: 'date' }
    project.modified = ctx.clock.next()
    return 'schema-warranty'
  }
  if (day === 26) {
    project.templates.csci.description = 'CSCI — tracked per software configuration baseline.'
    project.modified = ctx.clock.next()
    return 'schema-desc'
  }

  // Scheduled STRUCTURAL edits. The diff engine is the project's core
  // differentiator, so the canonical timeline must DETERMINISTICALLY exercise
  // every node ChangeType — added, removed, renamed, moved, order-changed, and
  // node-level template-changed — not leave them to a probabilistic roll that
  // some seeds never hit. Each is a single-purpose day (like the schema edits)
  // so the resulting snapshot diff isolates exactly one change type.
  const structural = scheduledStructuralChurn(project, ctx, day, today)
  if (structural) return structural

  // A quiet day changes nothing — leave the manifest byte-identical so the
  // snapshot is a genuine no-op (don't even bump project.modified).
  const roll = ctx.rng()
  if (roll < 0.15) return 'quiet'

  project.modified = ctx.clock.next()

  if (roll < 0.30) {
    maintenanceEvent(project, ctx, today)
    return 'maint'
  }

  // Routine: CSCI version bumps (test activity), status flips, recalibrations.
  const csciNodes = byTemplate(project, 'csci')
  for (const n of sample(ctx, csciNodes, ctx.intRange(2, 6))) {
    n.properties.version = bumpVersion(n.properties.version)
    n.properties.build_date = today
    n.modified = ctx.clock.next()
  }
  for (const n of sample(ctx, byTemplate(project, 'hw-component'), ctx.intRange(0, 3))) {
    n.properties.status = pick(ctx, TEMPLATES['hw-component'].fields.status.options)
    n.modified = ctx.clock.next()
  }
  recalibrate(project, ctx, today, ctx.intRange(1, 3))
  return 'routine'
}

function maintenanceEvent(project, ctx, today) {
  const boards = byTemplate(project, 'custom-board')
  if (boards.length === 0) return
  const board = pick(ctx, boards)
  // In-place repair/re-serialization (mirrors the spreadsheet workflow, which
  // recorded the item's new serial): status → repaired, new serial, revision
  // bump, installed date today — all in one snapshot.
  board.properties.status = 'repaired'
  board.properties.serial = serial(ctx, 'BRD')
  board.properties.revision = bumpVersion(board.properties.revision)
  board.properties.installed_date = today
  board.modified = ctx.clock.next()

  // A co-located hardware component swapped at the same time.
  const rack = findAncestorByTemplate(project, board, 'rack')
  if (rack) {
    const hw = descendantsByTemplate(project, rack, 'hw-component')
    for (const n of sample(ctx, hw, 1)) {
      n.properties.status = 'active'
      n.properties.serial = serial(ctx, String(n.properties.type ?? 'HW').slice(0, 3).toUpperCase())
      n.modified = ctx.clock.next()
    }
    // And the rack's power supply recalibrated as part of the action.
    const supplies = descendantsByTemplate(project, rack, 'power-supply')
    for (const ps of supplies) {
      ps.properties.last_calibrated = today
      ps.properties.calibration_due = isoDate(addDays(new Date(today), 180))
      ps.modified = ctx.clock.next()
    }
  }
  // NOTE: physical add/decommission churn used to live here behind a per-event
  // probability; with seed 42 over 40 days it never fired, so the canonical lab
  // exercised zero structural diffs. It is now scheduled deterministically in
  // scheduledStructuralChurn() so every structural ChangeType always appears.
}

// Deterministic, single-purpose structural edits keyed to fixed days (like the
// d12/d26 schema edits). Targets are chosen by structure — not the RNG — so the
// same change lands on the same node every run. Returns a snapshot-name slug, or
// null on a non-structural day. One synthetic board ("Custom Board (added)") is
// added (d6), moved (d16), then removed (d30), so node count nets back to
// baseline while the timeline still shows added/moved/removed in isolation.
function scheduledStructuralChurn(project, ctx, day, today) {
  // validateOptions guarantees the racks/boards these events target exist; a
  // missing target here means the validation thresholds and the churn targets
  // have drifted, so fail loudly rather than silently dropping a ChangeType.
  const must = (value, what) => {
    if (!value) throw new Error(`scheduledStructuralChurn(day ${day}): ${what} not found — validateOptions thresholds and churn targets have drifted`)
    return value
  }
  if (day === 6) {                                   // ADDED
    const rack = must(rackByName(project, 'Rack A-01'), 'Rack A-01')
    addChild(project, ctx, rack, ADDED_BOARD_NAME, 'custom-board', {
      board_type: pick(ctx, BOARD_TYPES),
      revision: version(1, 0, 0),
      serial: serial(ctx, 'BRD'),
      status: 'spare',
      installed_date: today,
    })
    project.modified = ctx.clock.next()
    return 'add-board'
  }
  if (day === 10) {                                  // RENAMED
    const b = must(firstBoard(project, 'Rack A-02'), 'a board under Rack A-02')
    b.name = `${b.name} (relabeled)`
    b.modified = ctx.clock.next()
    project.modified = ctx.clock.next()
    return 'rename'
  }
  if (day === 16) {                                  // MOVED (reparent to a sibling rack)
    const dst = must(rackByName(project, 'Rack A-05'), 'Rack A-05')
    const b = must(project.nodes.find(n => n.name === ADDED_BOARD_NAME), `the "${ADDED_BOARD_NAME}" board`)
    b.order = childrenOf(project, dst.id).length     // append index — count BEFORE reparenting
    b.parentId = dst.id
    b.modified = ctx.clock.next()
    project.modified = ctx.clock.next()
    return 'move'
  }
  if (day === 20) {                                  // ORDER-CHANGED (swap two siblings)
    const boards = boardsOf(project, 'Rack A-06')
    if (boards.length < 2) throw new Error(`scheduledStructuralChurn(day ${day}): Rack A-06 needs >= 2 custom boards to swap — validateOptions thresholds and churn targets have drifted`)
    const [x, y] = boards
    const t = x.order; x.order = y.order; y.order = t
    x.modified = ctx.clock.next()
    y.modified = ctx.clock.next()
    project.modified = ctx.clock.next()
    return 'reorder'
  }
  if (day === 30) {                                  // REMOVED (decommission the added board)
    const b = must(project.nodes.find(n => n.name === ADDED_BOARD_NAME), `the "${ADDED_BOARD_NAME}" board`)
    removeLeaf(project, b)
    project.modified = ctx.clock.next()
    return 'remove-board'
  }
  if (day === 34) {                                  // node TEMPLATE-CHANGED (unbind to freeform)
    // Target the rack's Power Supply, NOT a custom board: writeSampleCsv exports
    // only custom-board nodes, so unbinding a board would silently drop it from
    // the sample CSV (and forcing it back in would make a re-import rebind it,
    // breaking the clean round-trip). A power-supply unbind is invisible to the
    // CSV while still exercising the node-level template-changed diff.
    const rack = must(rackByName(project, 'Rack A-07'), 'Rack A-07')
    const ps = must(childrenOf(project, rack.id).find(n => n.templateId === 'power-supply'), 'a power supply under Rack A-07')
    ps.templateId = null
    ps.modified = ctx.clock.next()
    project.modified = ctx.clock.next()
    return 'unbind'
  }
  return null
}

function rackByName(project, name) {
  return project.nodes.find(n => n.templateId === 'rack' && n.name === name)
}
function boardsOf(project, rackName) {
  const rack = rackByName(project, rackName)
  if (!rack) return []
  return childrenOf(project, rack.id)
    .filter(n => n.templateId === 'custom-board')
    .sort((a, b) => a.order - b.order)
}
function firstBoard(project, rackName) {
  return boardsOf(project, rackName)[0]
}

function removeLeaf(project, n) {
  project.nodes = project.nodes.filter(x => x.id !== n.id)
  const sibs = project.nodes.filter(x => x.parentId === n.parentId).sort((a, b) => a.order - b.order)
  sibs.forEach((s, i) => { s.order = i })
}

function recalibrate(project, ctx, today, count) {
  const equip = [...byTemplate(project, 'power-supply'), ...byTemplate(project, 'waveform-generator')]
  for (const n of sample(ctx, equip, count)) {
    n.properties.last_calibrated = today
    n.properties.calibration_due = isoDate(addDays(new Date(today), 180))
    n.modified = ctx.clock.next()
  }
}

// ─── Node helpers ────────────────────────────────────────────────────────────────

function node(ctx, parentId, name, templateId, properties) {
  const ts = ctx.clock.next()
  ctx.seq += 1
  const n = {
    id: gid(ctx),
    parentId,
    name,
    order: 0,
    properties,
    created: ts,
    modified: ts,
  }
  if (templateId) n.templateId = templateId
  return n
}

// Deterministic UUID-shaped id derived purely from the seeded RNG, so the same
// --seed reproduces the same manifest.json byte-for-byte (uuidv7 would mix in
// wall-clock/random state and break reproducibility).
function gid(ctx) {
  let h = ''
  for (let i = 0; i < 32; i++) h += Math.floor(ctx.rng() * 16).toString(16)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

function addChild(project, ctx, parent, name, templateId, properties) {
  const order = project.nodes.filter(n => n.parentId === parent.id).length
  const child = node(ctx, parent.id, name, templateId, properties)
  child.order = order
  project.nodes.push(child)
  return child
}

function byTemplate(project, templateId) {
  return project.nodes.filter(n => n.templateId === templateId)
}

function childrenOf(project, id) {
  return project.nodes.filter(n => n.parentId === id)
}

function findAncestorByTemplate(project, n, templateId) {
  const byId = new Map(project.nodes.map(x => [x.id, x]))
  let cur = n.parentId ? byId.get(n.parentId) : null
  while (cur) {
    if (cur.templateId === templateId) return cur
    cur = cur.parentId ? byId.get(cur.parentId) : null
  }
  return null
}

function descendantsByTemplate(project, root, templateId) {
  const out = []
  const stack = [root.id]
  while (stack.length) {
    const id = stack.pop()
    for (const c of childrenOf(project, id)) {
      if (c.templateId === templateId) out.push(c)
      stack.push(c.id)
    }
  }
  return out
}

function summarize(project) {
  const byId = new Map(project.nodes.map(n => [n.id, n]))
  let depth = 0
  for (const n of project.nodes) {
    let d = 0
    let cur = n
    while (cur.parentId) { d++; cur = byId.get(cur.parentId) }
    depth = Math.max(depth, d)
  }
  return { nodes: project.nodes.length, depth }
}

// ─── Value helpers ──────────────────────────────────────────────────────────────

function version(maj, min, patch) { return `v${maj}.${min}.${patch}` }

function bumpVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v))
  if (!m) return `${v}.1`
  const [, a, b, c] = m
  return `v${a}.${b}.${Number(c) + 1}`
}

function serial(ctx, prefix) {
  return `${prefix}-${String(Math.floor(ctx.rng() * 1e6)).padStart(6, '0')}`
}

function pastDate(ctx, minDays, maxDays) {
  const base = new Date('2025-02-03T00:00:00.000Z')
  const back = ctx.intRange(minDays, maxDays)
  return isoDate(addDays(base, -back))
}

function isoDate(d) { return d.toISOString().slice(0, 10) }
function addDays(d, n) { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x }
function round1(n) { return Math.round(n * 10) / 10 }
function pad(n, w) { return String(n).padStart(w, '0') }

// Excel-style column label so room labels stay unique past 26 (A..Z, AA, AB…).
function colLabel(i) {
  let n = i + 1
  let s = ''
  while (n > 0) {
    const m = (n - 1) % 26
    s = String.fromCharCode(65 + m) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

function pick(ctx, arr) { return arr[Math.floor(ctx.rng() * arr.length)] }

function weighted(ctx, pairs) {
  const total = pairs.reduce((s, [, w]) => s + w, 0)
  let r = ctx.rng() * total
  for (const [val, w] of pairs) { if ((r -= w) <= 0) return val }
  return pairs[0][0]
}

function sample(ctx, arr, count) {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(ctx.rng() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a.slice(0, Math.min(count, a.length))
}

// ─── CSV export (a flat sheet for the upcoming importer) ─────────────────────────

// Pure: serialize the project's custom-board nodes to a CSV string (exported so
// the regression test can round-trip it without touching the filesystem).
export function sampleCsv(project) {
  const byId = new Map(project.nodes.map(n => [n.id, n]))
  const pathOf = (n) => {
    const parts = []
    let cur = n.parentId ? byId.get(n.parentId) : null
    while (cur) { parts.unshift(cur.name); cur = cur.parentId ? byId.get(cur.parentId) : null }
    return parts.join(' / ')
  }
  const cols = ['parent_path', 'name', 'board_type', 'revision', 'serial', 'status', 'installed_date']
  const esc = (v) => {
    const s = String(v ?? '')
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const rows = [cols.join(',')]
  for (const n of byTemplate(project, 'custom-board')) {
    rows.push([
      pathOf(n), n.name, n.properties.board_type, n.properties.revision,
      n.properties.serial, n.properties.status, n.properties.installed_date,
    ].map(esc).join(','))
  }
  return rows.join('\n') + '\n'
}

function writeSampleCsv(projectDir, project) {
  writeFileSync(join(projectDir, 'import-sample-custom-boards.csv'), sampleCsv(project), 'utf8')
}

// ─── IO / git ────────────────────────────────────────────────────────────────────

function writeManifest(projectDir, project) {
  writeFileSync(join(projectDir, 'manifest.json'), JSON.stringify(project, null, 2), 'utf8')
}

function initGit(projectDir, dateIso) {
  git(projectDir, ['init'])
  git(projectDir, ['add', 'manifest.json'])
  commit(projectDir, 'Initial lab project', dateIso)
}

function snapshot(projectDir, name, dateIso) {
  git(projectDir, ['add', 'manifest.json'])
  commit(projectDir, name, dateIso)
  // Lightweight tag — its creatordate is the commit's committer date, which we
  // pin to the simulated day below.
  git(projectDir, ['tag', `snapshot/${name}`])
}

function commit(projectDir, message, dateIso) {
  git(
    projectDir,
    ['-c', 'user.email=manifest@local', '-c', 'user.name=Manifest', 'commit', '--allow-empty', '-m', message],
    { GIT_AUTHOR_DATE: dateIso, GIT_COMMITTER_DATE: dateIso }
  )
}

function git(projectDir, args, extraEnv) {
  execFileSync('git', args, {
    cwd: projectDir,
    stdio: 'pipe',
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
  })
}

// ─── CLI ──────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const o = { ...DEFAULTS, help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') { o.help = true; continue }
    if (arg === '--force') { o.force = true; continue }
    const [flag, inline] = arg.split('=')
    const val = inline ?? argv[i + 1]
    const take = () => { if (inline === undefined) i++; return val }
    switch (flag) {
      case '--output': o.output = take(); break
      case '--name': o.name = take(); break
      case '--rooms': o.rooms = int(flag, take()); break
      case '--racks-per-room': o.racksPerRoom = int(flag, take()); break
      case '--computers-per-rack': o.computersPerRack = int(flag, take()); break
      case '--custom-boards-per-rack': o.customBoardsPerRack = int(flag, take()); break
      case '--hw-per-computer': o.hwPerComputer = int(flag, take()); break
      case '--csci-per-computer': o.csciPerComputer = int(flag, take()); break
      case '--days': o.days = int(flag, take()); break
      case '--seed': o.seed = int(flag, take()); break
      default: throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return o
}

function validateOptions(o) {
  // Report the actual kebab-case CLI flag, not the internal camelCase property.
  const FLAGS = {
    rooms: 'rooms',
    racksPerRoom: 'racks-per-room',
    computersPerRack: 'computers-per-rack',
    hwPerComputer: 'hw-per-computer',
    csciPerComputer: 'csci-per-computer',
  }
  for (const [k, flag] of Object.entries(FLAGS)) {
    if (o[k] < 1) throw new Error(`--${flag} must be at least 1`)
  }
  if (o.days < 0) throw new Error('--days cannot be negative')

  // Enforce the shape the scheduled structural churn needs, so the generator can
  // never SILENTLY produce a lab that skips a node diff ChangeType. These events
  // fire on fixed days against specific racks/boards (see scheduledStructuralChurn):
  // a config that can't satisfy them is rejected rather than degrading to routine.
  // Keep these thresholds in sync with the days/racks/boards that churn targets.
  if (o.racksPerRoom < 7) {
    throw new Error('--racks-per-room must be at least 7: the scheduled structural events target racks A-01..A-07 (the day-34 template-changed unbind needs A-07)')
  }
  if (o.customBoardsPerRack < 2) {
    throw new Error('--custom-boards-per-rack must be at least 2: the day-20 order-changed event swaps two sibling boards under one rack')
  }
  if (o.days < 34) {
    throw new Error('--days must be at least 34: the last scheduled structural event (the day-34 template-changed unbind) must fire')
  }
}

function printHelp() {
  console.log(`
Usage:
  bun run generate:lab -- [options]

Options:
  --output <dir>                Project directory to create
  --name <name>                 Lab/project name
  --rooms <n>                   Rooms (default 2)
  --racks-per-room <n>          Racks per room (default 60)
  --computers-per-rack <n>      Computers per rack (default 4)
  --custom-boards-per-rack <n>  Custom boards per rack (default 3)
  --hw-per-computer <n>         Hardware components per computer (default 5)
  --csci-per-computer <n>       CSCIs per computer (default 5)
  --days <n>                    Daily snapshots to generate (default 40)
  --seed <number>               RNG seed (default 42)
  --force                       Replace a non-empty output directory
  --help                        Show this help

Examples:
  bun run generate:lab -- --output ./tmp/lab --force
  bun run generate:lab -- --output ./tmp/lab-big --racks-per-room 100 --days 60 --force
`.trim())
}

function int(flag, value) {
  if (value === undefined || String(value).startsWith('--')) throw new Error(`Missing value for ${flag}`)
  const n = Number.parseInt(value, 10)
  if (!Number.isFinite(n)) throw new Error(`${flag} must be an integer`)
  return n
}

function prepareOutputDir(dir, force) {
  if (!existsSync(dir)) { mkdirSync(dir, { recursive: true }); return }
  if (readdirSync(dir).length === 0) return
  if (!force) throw new Error(`Output directory exists and is not empty: ${dir}. Use --force.`)
  assertSafeToForce(dir)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
}

// --force does an rmSync of the whole output dir. Refuse to wipe anything we
// can't be confident we created — the cwd or any ancestor of it, the home dir
// or any ancestor, the filesystem root, or a real git repo lacking our marker.
function assertSafeToForce(dir) {
  const cwd = process.cwd()
  const home = homedir()
  const root = parse(dir).root
  const contains = (parent, child) => {
    const rel = relative(parent, child)
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  }
  const refuse = (why) => { throw new Error(`Refusing to --force ${dir}: ${why}. Choose an empty directory or one previously generated by this tool.`) }

  if (dir === root) refuse('it is the filesystem root')
  if (dir === home) refuse('it is your home directory')
  if (contains(dir, cwd)) refuse('it contains the current working directory')
  if (contains(dir, home)) refuse('it contains your home directory')
  if (existsSync(join(dir, '.git')) && !existsSync(join(dir, GEN_MARKER))) {
    refuse(`it looks like a real git repo (no ${GEN_MARKER} marker)`)
  }
}

function createRng(seed) {
  let state = seed >>> 0
  const rng = () => {
    state += 0x6d2b79f5
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  rng.intRange = (min, max) => min + Math.floor(rng() * (max - min + 1))
  return rng
}

function makeClock(start) {
  let cur = start.getTime()
  return { next() { const v = new Date(cur).toISOString(); cur += 60_000; return v } }
}

function slugify(v) {
  return v.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'lab'
}

function stamp() {
  return new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)
}
