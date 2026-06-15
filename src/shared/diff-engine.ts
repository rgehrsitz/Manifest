import type {
  DiffEntry,
  ManifestNode,
  Project,
  NodeTemplate,
  TemplateField,
  TemplateDiffEntry,
} from './types'

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
  'template-changed': 4,
  'property-changed': 5,
  'order-changed': 6,
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

    if ((nodeA.templateId ?? null) !== (nodeB.templateId ?? null)) {
      diffs.push({
        nodeId: id,
        changeType: 'template-changed',
        severity: 'Medium',
        oldValue: nodeA.templateId ?? null,
        newValue: nodeB.templateId ?? null,
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

// ─── Template / schema diffs ────────────────────────────────────────────────────
//
// Project-level changes to the templates map between two snapshots. These are
// not tied to any single node, so they are returned separately from the node
// DiffEntry[] (surfaced through MergedTree.templateChanges). Without this, a
// snapshot whose only change is a template/schema edit would compare as
// "no changes" — Manifest must never silently hide a real change.

function fieldsEqual(a: TemplateField, b: TemplateField): boolean {
  if (a.type !== b.type) return false
  if ((a.label ?? '') !== (b.label ?? '')) return false
  if ((a.required ?? false) !== (b.required ?? false)) return false
  if ((a.default ?? null) !== (b.default ?? null)) return false
  const aOpts = a.options ?? []
  const bOpts = b.options ?? []
  if (aOpts.length !== bOpts.length) return false
  for (let i = 0; i < aOpts.length; i++) {
    if (aOpts[i] !== bOpts[i]) return false
  }
  return true
}

function diffTemplateFields(
  templateId: string,
  templateLabel: string,
  a: NodeTemplate,
  b: NodeTemplate,
  out: TemplateDiffEntry[]
): void {
  const keys = new Set([...Object.keys(a.fields), ...Object.keys(b.fields)])
  for (const key of [...keys].sort()) {
    const fieldA = a.fields[key]
    const fieldB = b.fields[key]
    if (!fieldA && fieldB) {
      out.push({ templateId, templateLabel, changeType: 'field-added', fieldKey: key, newValue: fieldB })
    } else if (fieldA && !fieldB) {
      out.push({ templateId, templateLabel, changeType: 'field-removed', fieldKey: key, oldValue: fieldA })
    } else if (fieldA && fieldB && !fieldsEqual(fieldA, fieldB)) {
      out.push({
        templateId,
        templateLabel,
        changeType: 'field-changed',
        fieldKey: key,
        oldValue: fieldA,
        newValue: fieldB,
      })
    }
  }
}

export function diffTemplates(projectA: Project, projectB: Project): TemplateDiffEntry[] {
  const templatesA = projectA.templates ?? {}
  const templatesB = projectB.templates ?? {}
  const ids = new Set([...Object.keys(templatesA), ...Object.keys(templatesB)])
  const out: TemplateDiffEntry[] = []

  for (const id of [...ids].sort()) {
    const tplA = templatesA[id]
    const tplB = templatesB[id]

    if (!tplA && tplB) {
      out.push({ templateId: id, templateLabel: tplB.label, changeType: 'template-added', newValue: tplB })
      continue
    }
    if (tplA && !tplB) {
      out.push({ templateId: id, templateLabel: tplA.label, changeType: 'template-removed', oldValue: tplA })
      continue
    }
    if (!tplA || !tplB) continue

    if (tplA.label !== tplB.label) {
      out.push({
        templateId: id,
        templateLabel: tplB.label,
        changeType: 'template-relabeled',
        oldValue: tplA.label,
        newValue: tplB.label,
      })
    }
    if ((tplA.description ?? '') !== (tplB.description ?? '')) {
      out.push({
        templateId: id,
        templateLabel: tplB.label,
        changeType: 'template-redescribed',
        oldValue: tplA.description ?? null,
        newValue: tplB.description ?? null,
      })
    }
    diffTemplateFields(id, tplB.label, tplA, tplB, out)
  }

  return out
}
