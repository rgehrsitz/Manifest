import type { DiffEntry, ManifestNode, Project } from './types'

const SEVERITY_WEIGHT = {
  High: 0,
  Medium: 1,
  Low: 2,
} as const

const CHANGE_WEIGHT = {
  added: 0,
  removed: 1,
  moved: 2,
  renamed: 3,
  'property-changed': 4,
  'order-changed': 5,
} as const

type NodeMap = Map<string, ManifestNode>

function buildNodeMap(nodes: ManifestNode[]): NodeMap {
  return new Map(nodes.map((node) => [node.id, node]))
}

function getPath(node: ManifestNode, nodeMap: NodeMap): string[] {
  const path: string[] = []
  let currentParentId = node.parentId

  while (currentParentId !== null) {
    const parent = nodeMap.get(currentParentId)
    if (!parent) break
    path.unshift(parent.name)
    currentParentId = parent.parentId
  }

  return path
}

function makeContext(node: ManifestNode, nodeMap: NodeMap) {
  const parent = node.parentId ? nodeMap.get(node.parentId) ?? null : null
  return {
    nodeName: node.name,
    parentName: parent?.name ?? null,
    path: getPath(node, nodeMap),
  }
}

function propertiesEqual(a: ManifestNode['properties'], b: ManifestNode['properties']): boolean {
  const aKeys = Object.keys(a).sort()
  const bKeys = Object.keys(b).sort()

  if (aKeys.length !== bKeys.length) return false

  for (let i = 0; i < aKeys.length; i++) {
    const key = aKeys[i]
    if (key !== bKeys[i]) return false
    if (a[key] !== b[key]) return false
  }

  return true
}

function compareEntries(a: DiffEntry, b: DiffEntry): number {
  const severityDiff = SEVERITY_WEIGHT[a.severity] - SEVERITY_WEIGHT[b.severity]
  if (severityDiff !== 0) return severityDiff

  const pathA = [...a.context.path, a.context.nodeName].join('/')
  const pathB = [...b.context.path, b.context.nodeName].join('/')
  const pathDiff = pathA.localeCompare(pathB)
  if (pathDiff !== 0) return pathDiff

  return CHANGE_WEIGHT[a.changeType] - CHANGE_WEIGHT[b.changeType]
}

export function diffProjects(projectA: Project, projectB: Project): DiffEntry[] {
  const nodesA = buildNodeMap(projectA.nodes)
  const nodesB = buildNodeMap(projectB.nodes)
  const ids = new Set([...nodesA.keys(), ...nodesB.keys()])
  const diffs: DiffEntry[] = []

  for (const id of ids) {
    const nodeA = nodesA.get(id)
    const nodeB = nodesB.get(id)

    if (!nodeA && nodeB) {
      diffs.push({
        nodeId: id,
        changeType: 'added',
        severity: 'High',
        newValue: nodeB,
        context: makeContext(nodeB, nodesB),
      })
      continue
    }

    if (nodeA && !nodeB) {
      diffs.push({
        nodeId: id,
        changeType: 'removed',
        severity: 'High',
        oldValue: nodeA,
        context: makeContext(nodeA, nodesA),
      })
      continue
    }

    if (!nodeA || !nodeB) continue

    if (nodeA.parentId !== nodeB.parentId) {
      diffs.push({
        nodeId: id,
        changeType: 'moved',
        severity: 'High',
        oldValue: nodeA.parentId,
        newValue: nodeB.parentId,
        context: makeContext(nodeB, nodesB),
      })
    }

    if (nodeA.name !== nodeB.name) {
      diffs.push({
        nodeId: id,
        changeType: 'renamed',
        severity: 'Medium',
        oldValue: nodeA.name,
        newValue: nodeB.name,
        context: makeContext(nodeB, nodesB),
      })
    }

    if (!propertiesEqual(nodeA.properties, nodeB.properties)) {
      diffs.push({
        nodeId: id,
        changeType: 'property-changed',
        severity: 'Medium',
        oldValue: nodeA.properties,
        newValue: nodeB.properties,
        context: makeContext(nodeB, nodesB),
      })
    }

    if (nodeA.parentId === nodeB.parentId && nodeA.order !== nodeB.order) {
      diffs.push({
        nodeId: id,
        changeType: 'order-changed',
        severity: 'Low',
        oldValue: nodeA.order,
        newValue: nodeB.order,
        context: makeContext(nodeB, nodesB),
      })
    }
  }

  return diffs.sort(compareEntries)
}
