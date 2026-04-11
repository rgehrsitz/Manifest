#!/usr/bin/env node

import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { basename, resolve } from 'path'
import { v7 as uuidv7 } from 'uuid'

const CURRENT_VERSION = 2
const DEFAULTS = {
  name: 'Generated Project',
  nodes: 2500,
  depth: 6,
  branching: 4,
  snapshots: 0,
  seed: 42,
  output: null,
  force: false,
}

const LEVEL_LABELS = ['Program', 'Region', 'Room', 'Rack', 'Shelf', 'Device', 'Module', 'Part']
const VENDORS = ['Acme', 'Vector', 'Northstar', 'Helix', 'Summit', 'Atlas']
const MODELS = ['A100', 'B220', 'C330', 'D440', 'E550', 'F660']
const STATUSES = ['active', 'standby', 'maintenance', 'ready', 'offline']
const OWNERS = ['platform', 'lab-ops', 'qa', 'infra', 'networking']
const NOTE_PHRASES = [
  'calibrated this quarter',
  'scheduled for audit',
  'paired with backup hardware',
  'supports local testing',
  'captures telemetry for search fixtures',
  'used in snapshot restore checks',
]

main(process.argv.slice(2))

function main(argv) {
  const options = parseArgs(argv)
  if (options.help) {
    printHelp()
    return
  }

  validateOptions(options)

  const projectDir = resolve(options.output ?? `./tmp/${slugify(options.name)}-${Date.now()}`)
  prepareOutputDir(projectDir, options.force)

  const clock = makeClock(new Date('2026-01-01T09:00:00.000Z'))
  const rng = createRng(options.seed)
  const project = createProjectSkeleton(options.name, clock.next())
  const metadata = new Map([[project.nodes[0].id, { depth: 0 }]])
  const siblingCounts = new Map([[project.nodes[0].id, 0]])

  populateNodes(project, metadata, siblingCounts, options, rng, clock)
  writeManifest(projectDir, project)
  initializeGit(projectDir)

  if (options.snapshots > 0) {
    for (let index = 1; index <= options.snapshots; index++) {
      applySnapshotChanges(project, metadata, siblingCounts, options, rng, clock, index)
      writeManifest(projectDir, project)
      createSnapshot(projectDir, `generated-${String(index).padStart(2, '0')}`)
    }
  }

  const summary = summarizeProject(project, metadata)
  console.log(`Generated Manifest project at ${projectDir}`)
  console.log(`Nodes: ${summary.nodeCount}`)
  console.log(`Depth: ${summary.maxDepth}`)
  console.log(`Leaf nodes: ${summary.leafCount}`)
  console.log(`Snapshots: ${options.snapshots}`)
  console.log(`Seed: ${options.seed}`)
}

function parseArgs(argv) {
  const options = { ...DEFAULTS, help: false }

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]

    if (arg === '--help' || arg === '-h') {
      options.help = true
      continue
    }
    if (arg === '--force') {
      options.force = true
      continue
    }

    const [flag, inlineValue] = arg.split('=')
    const value = inlineValue ?? argv[index + 1]

    switch (flag) {
      case '--output':
        options.output = requireValue(flag, value)
        if (inlineValue === undefined) index++
        break
      case '--name':
        options.name = requireValue(flag, value)
        if (inlineValue === undefined) index++
        break
      case '--nodes':
        options.nodes = parseInteger(flag, value)
        if (inlineValue === undefined) index++
        break
      case '--depth':
        options.depth = parseInteger(flag, value)
        if (inlineValue === undefined) index++
        break
      case '--branching':
        options.branching = parseInteger(flag, value)
        if (inlineValue === undefined) index++
        break
      case '--snapshots':
        options.snapshots = parseInteger(flag, value)
        if (inlineValue === undefined) index++
        break
      case '--seed':
        options.seed = parseInteger(flag, value)
        if (inlineValue === undefined) index++
        break
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return options
}

function validateOptions(options) {
  if (options.nodes < 1) throw new Error('--nodes must be at least 1')
  if (options.depth < 1) throw new Error('--depth must be at least 1')
  if (options.branching < 1) throw new Error('--branching must be at least 1')
  if (options.snapshots < 0) throw new Error('--snapshots cannot be negative')
}

function printHelp() {
  console.log(`
Usage:
  bun run generate:project -- [options]

Options:
  --output <dir>       Project directory to create
  --name <name>        Project name
  --nodes <count>      Total nodes, including the root node
  --depth <levels>     Maximum hierarchy depth
  --branching <count>  Target children per parent
  --snapshots <count>  Number of generated snapshots/tags
  --seed <number>      RNG seed for reproducible output
  --force              Remove an existing output directory first
  --help               Show this help

Example:
  bun run generate:project -- --output ./tmp/search-fixture --nodes 5000 --depth 6 --branching 4 --snapshots 8 --force
`.trim())
}

function requireValue(flag, value) {
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`Missing value for ${flag}`)
  }
  return value
}

function parseInteger(flag, value) {
  const parsed = Number.parseInt(requireValue(flag, value), 10)
  if (!Number.isFinite(parsed)) {
    throw new Error(`${flag} must be an integer`)
  }
  return parsed
}

function prepareOutputDir(projectDir, force) {
  if (!existsSync(projectDir)) {
    mkdirSync(projectDir, { recursive: true })
    return
  }

  const contents = readdirSync(projectDir)
  if (contents.length === 0) return

  if (!force) {
    throw new Error(`Output directory already exists and is not empty: ${projectDir}. Use --force to replace it.`)
  }

  rmSync(projectDir, { recursive: true, force: true })
  mkdirSync(projectDir, { recursive: true })
}

function createProjectSkeleton(name, timestamp) {
  const rootId = uuidv7()
  return {
    version: CURRENT_VERSION,
    id: uuidv7(),
    name,
    created: timestamp,
    modified: timestamp,
    nodes: [
      {
        id: rootId,
        parentId: null,
        name,
        order: 0,
        properties: {},
        created: timestamp,
        modified: timestamp,
      },
    ],
  }
}

function populateNodes(project, metadata, siblingCounts, options, rng, clock) {
  const rootId = project.nodes[0].id
  const expandable = [rootId]
  let cursor = 0

  while (project.nodes.length < options.nodes) {
    const parentId = expandable[cursor] ?? rootId
    cursor += 1

    const parentDepth = metadata.get(parentId)?.depth ?? 0
    const remaining = options.nodes - project.nodes.length
    const canNest = parentDepth < options.depth - 1
    const targetChildren = canNest
      ? Math.min(remaining, chooseChildCount(options.branching, remaining, rng))
      : Math.min(remaining, 1)

    for (let i = 0; i < targetChildren && project.nodes.length < options.nodes; i++) {
      const order = siblingCounts.get(parentId) ?? 0
      const childDepth = Math.min(parentDepth + 1, options.depth - 1)
      const node = createNode(project, parentId, childDepth, order, rng, clock)
      project.nodes.push(node)
      metadata.set(node.id, { depth: childDepth })
      siblingCounts.set(parentId, order + 1)
      siblingCounts.set(node.id, 0)
      if (childDepth < options.depth - 1) {
        expandable.push(node.id)
      }
    }

    if (cursor >= expandable.length) {
      expandable.push(rootId)
    }
  }
}

function createNode(project, parentId, depth, order, rng, clock) {
  const sequence = project.nodes.length
  const label = LEVEL_LABELS[Math.min(depth, LEVEL_LABELS.length - 1)]
  const serialNumber = String(sequence).padStart(5, '0')
  const timestamp = clock.next()
  const name = `${label} ${serialNumber}`

  return {
    id: uuidv7(),
    parentId,
    name,
    order,
    properties: buildProperties(label, sequence, depth, rng),
    created: timestamp,
    modified: timestamp,
  }
}

function buildProperties(label, sequence, depth, rng) {
  const octet = (sequence % 200) + 10
  return {
    kind: label.toLowerCase(),
    serial: `SN-${String(sequence).padStart(6, '0')}`,
    asset_tag: `AT-${String(100000 + sequence).padStart(6, '0')}`,
    vendor: VENDORS[sequence % VENDORS.length],
    model: MODELS[(sequence + depth) % MODELS.length],
    firmware: `v${1 + (sequence % 5)}.${depth}.${sequence % 9}`,
    status: STATUSES[(sequence + depth) % STATUSES.length],
    owner: OWNERS[(sequence + depth) % OWNERS.length],
    location_code: `L-${depth}-${String((sequence % 900) + 100)}`,
    ip_address: `10.${depth}.${Math.floor(sequence / 255) % 255}.${octet}`,
    notes: `${label} ${sequence} ${NOTE_PHRASES[Math.floor(rng() * NOTE_PHRASES.length)]}`,
  }
}

function chooseChildCount(branching, remaining, rng) {
  const min = Math.max(1, branching - 1)
  const max = Math.max(min, branching + 1)
  const count = min + Math.floor(rng() * (max - min + 1))
  return Math.min(remaining, count)
}

function applySnapshotChanges(project, metadata, siblingCounts, options, rng, clock, snapshotIndex) {
  const nonRoot = project.nodes.filter((node) => node.parentId !== null)
  const leafNodes = getLeafNodes(project)
  const propertyUpdates = Math.max(4, Math.floor(nonRoot.length / 120))
  const renameUpdates = Math.max(1, Math.floor(nonRoot.length / 900))
  const additions = Math.max(2, Math.floor(nonRoot.length / 500))
  const deletions = Math.min(Math.max(1, Math.floor(nonRoot.length / 1600)), leafNodes.length)
  const moves = Math.min(Math.max(1, Math.floor(nonRoot.length / 1800)), leafNodes.length)

  for (const node of sampleNodes(nonRoot, propertyUpdates, rng)) {
    node.properties.status = STATUSES[(snapshotIndex + node.order) % STATUSES.length]
    node.properties.firmware = `v${1 + (snapshotIndex % 6)}.${metadata.get(node.id)?.depth ?? 0}.${snapshotIndex}`
    node.properties.notes = `Snapshot ${snapshotIndex}: ${NOTE_PHRASES[(snapshotIndex + node.order) % NOTE_PHRASES.length]}`
    node.modified = clock.next()
  }

  for (const node of sampleNodes(nonRoot, renameUpdates, rng)) {
    const parentId = node.parentId
    if (!parentId) continue
    const nextName = `${stripGeneratedSuffix(node.name)} rev ${snapshotIndex}`
    if (hasSiblingNameConflict(project, parentId, nextName, node.id)) continue
    node.name = nextName
    node.modified = clock.next()
  }

  for (let i = 0; i < additions; i++) {
    const parent = pickParentForAddition(project, metadata, options.depth, rng)
    if (!parent) break
    const depth = (metadata.get(parent.id)?.depth ?? 0) + 1
    const order = siblingCounts.get(parent.id) ?? countChildren(project, parent.id)
    const node = createNode(project, parent.id, depth, order, rng, clock)
    node.name = `${node.name} snap ${snapshotIndex}`
    project.nodes.push(node)
    metadata.set(node.id, { depth })
    siblingCounts.set(parent.id, order + 1)
    siblingCounts.set(node.id, 0)
  }

  for (const node of sampleNodes(getLeafNodes(project), moves, rng)) {
    const targetParent = pickMoveTarget(project, metadata, node, options.depth, rng)
    if (!targetParent) continue

    const oldParentId = node.parentId
    node.parentId = targetParent.id
    node.order = countChildren(project, targetParent.id, node.id)
    node.modified = clock.next()

    renumberChildren(project, oldParentId)
    renumberChildren(project, targetParent.id)
    siblingCounts.set(oldParentId, countChildren(project, oldParentId))
    siblingCounts.set(targetParent.id, countChildren(project, targetParent.id))
  }

  for (const node of sampleNodes(getLeafNodes(project), deletions, rng)) {
    const parentId = node.parentId
    project.nodes = project.nodes.filter((candidate) => candidate.id !== node.id)
    metadata.delete(node.id)
    siblingCounts.delete(node.id)
    renumberChildren(project, parentId)
    siblingCounts.set(parentId, countChildren(project, parentId))
  }

  project.modified = clock.next()
}

function getLeafNodes(project) {
  const parentIds = new Set(project.nodes.map((node) => node.parentId).filter(Boolean))
  return project.nodes.filter((node) => node.parentId !== null && !parentIds.has(node.id))
}

function sampleNodes(nodes, count, rng) {
  const shuffled = [...nodes]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const temp = shuffled[i]
    shuffled[i] = shuffled[j]
    shuffled[j] = temp
  }
  return shuffled.slice(0, Math.min(count, shuffled.length))
}

function pickParentForAddition(project, metadata, maxDepth, rng) {
  const candidates = project.nodes.filter((node) => (metadata.get(node.id)?.depth ?? 0) < maxDepth - 1)
  if (candidates.length === 0) return null
  return candidates[Math.floor(rng() * candidates.length)]
}

function pickMoveTarget(project, metadata, node, maxDepth, rng) {
  const nodeDepth = metadata.get(node.id)?.depth ?? 0
  const candidates = project.nodes.filter((candidate) => {
    if (candidate.id === node.id) return false
    const candidateDepth = metadata.get(candidate.id)?.depth ?? 0
    if (candidateDepth >= maxDepth - 1) return false
    if (candidate.id === node.parentId) return false
    return !hasSiblingNameConflict(project, candidate.id, node.name, node.id) && candidateDepth + 1 >= nodeDepth - 1
  })

  if (candidates.length === 0) return null
  return candidates[Math.floor(rng() * candidates.length)]
}

function hasSiblingNameConflict(project, parentId, name, excludeId) {
  const lower = name.toLowerCase()
  return project.nodes.some((node) =>
    node.parentId === parentId &&
    node.id !== excludeId &&
    node.name.toLowerCase() === lower
  )
}

function renumberChildren(project, parentId) {
  const siblings = project.nodes
    .filter((node) => node.parentId === parentId)
    .sort((a, b) => a.order - b.order)

  for (let index = 0; index < siblings.length; index++) {
    siblings[index].order = index
  }
}

function countChildren(project, parentId, excludeId = null) {
  return project.nodes.filter((node) => node.parentId === parentId && node.id !== excludeId).length
}

function writeManifest(projectDir, project) {
  writeFileSync(`${projectDir}/manifest.json`, JSON.stringify(project, null, 2), 'utf8')
}

function initializeGit(projectDir) {
  runGit(projectDir, ['init'])
  runGit(projectDir, ['add', 'manifest.json'])
  runGit(projectDir, ['-c', 'user.email=manifest@local', '-c', 'user.name=Manifest', 'commit', '-m', 'Initial generated project'])
}

function createSnapshot(projectDir, name) {
  runGit(projectDir, ['add', 'manifest.json'])
  runGit(projectDir, ['-c', 'user.email=manifest@local', '-c', 'user.name=Manifest', 'commit', '--allow-empty', '-m', name])
  runGit(projectDir, ['tag', `snapshot/${name}`])
}

function runGit(projectDir, args) {
  execFileSync('git', args, {
    cwd: projectDir,
    stdio: 'pipe',
  })
}

function summarizeProject(project, metadata) {
  let maxDepth = 0
  let leafCount = 0
  const parentIds = new Set(project.nodes.map((node) => node.parentId).filter(Boolean))

  for (const node of project.nodes) {
    maxDepth = Math.max(maxDepth, metadata.get(node.id)?.depth ?? 0)
    if (node.parentId !== null && !parentIds.has(node.id)) {
      leafCount += 1
    }
  }

  return {
    nodeCount: project.nodes.length,
    maxDepth,
    leafCount,
  }
}

function stripGeneratedSuffix(name) {
  return name.replace(/ rev \d+$/, '')
}

function createRng(seed) {
  let state = seed >>> 0
  return () => {
    state += 0x6D2B79F5
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function makeClock(startDate) {
  let current = startDate.getTime()
  return {
    next() {
      const value = new Date(current).toISOString()
      current += 60_000
      return value
    },
  }
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || basename(process.cwd())
}
