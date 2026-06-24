import type {
  DiffEntry,
  ManifestNode,
  Project,
  NodeTemplate,
  TemplateField,
  TemplateDiffEntry,
  Severity,
} from './types'
import { templateFields, templateLabel } from './validation'
import { classifyDiff } from './diff-format'

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
type DraftDiffEntry = Omit<DiffEntry, 'classification'>
type RemovedDescendantImpact = NonNullable<DiffEntry['context']['removalImpact']>['descendants'][number]
type IncomingReferenceImpact = NonNullable<DiffEntry['context']['removalImpact']>['incomingReferences'][number]

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

function buildChildrenMap(nodes: ManifestNode[]): Map<string | null, ManifestNode[]> {
  const byParent = new Map<string | null, ManifestNode[]>()
  for (const node of nodes) {
    const children = byParent.get(node.parentId) ?? []
    children.push(node)
    byParent.set(node.parentId, children)
  }
  return byParent
}

function descendantImpact(
  nodeId: string,
  childrenByParent: Map<string | null, ManifestNode[]>,
  nodeMap: NodeMap,
): RemovedDescendantImpact[] {
  const out: RemovedDescendantImpact[] = []
  const queue = [...(childrenByParent.get(nodeId) ?? [])]
  for (let index = 0; index < queue.length; index++) {
    const node = queue[index]
    out.push({ id: node.id, name: node.name, path: getPath(node, nodeMap) })
    queue.push(...(childrenByParent.get(node.id) ?? []))
  }
  return out
}

function buildIncomingReferenceImpact(project: Project, nodeMap: NodeMap): Map<string, IncomingReferenceImpact[]> {
  const references = new Map<string, IncomingReferenceImpact[]>()
  const fieldsByTemplateId = new Map<string, Record<string, TemplateField>>()

  function fieldsFor(templateId: string): Record<string, TemplateField> {
    const cached = fieldsByTemplateId.get(templateId)
    if (cached) return cached
    const fields = templateFields(project.templates?.[templateId])
    fieldsByTemplateId.set(templateId, fields)
    return fields
  }

  for (const node of project.nodes) {
    if (!node.templateId) continue
    const fields = fieldsFor(node.templateId)
    for (const [key, field] of Object.entries(fields)) {
      const targetId = node.properties[key]
      if (field.type === 'reference' && typeof targetId === 'string' && targetId !== node.id) {
        const entry = {
          nodeId: node.id,
          nodeName: node.name,
          path: getPath(node, nodeMap),
          fieldKey: key,
        }
        references.set(targetId, [...(references.get(targetId) ?? []), entry])
      }
    }
  }

  return references
}

function hasRemovedAncestor(node: ManifestNode, nodes: NodeMap, removedIds: Set<string>): boolean {
  let currentParentId = node.parentId
  while (currentParentId !== null) {
    if (removedIds.has(currentParentId)) return true
    currentParentId = nodes.get(currentParentId)?.parentId ?? null
  }
  return false
}

function changedPropertyKeys(
  a: ManifestNode['properties'],
  b: ManifestNode['properties']
): string[] {
  return Array.from(new Set([...Object.keys(a), ...Object.keys(b)]))
    .filter(key => a[key] !== b[key])
    .sort()
}

function inferredFieldImportance(key: string, field: TemplateField | undefined): Severity {
  if (field?.compareImportance) return field.compareImportance
  if (!field) return 'Medium'
  const normalized = key.toLowerCase()
  if (
    field.type === 'reference' ||
    field.type === 'version' ||
    ['status', 'state', 'enabled', 'active', 'serial', 'serial_number', 'asset_tag', 'firmware', 'ip', 'ip_address'].includes(normalized)
  ) {
    return 'High'
  }
  return 'Medium'
}

function severityRank(severity: Severity): number {
  return severity === 'High' ? 0 : severity === 'Medium' ? 1 : 2
}

function mostImportantSeverity(values: Severity[]): Severity {
  if (values.length === 0) return 'Medium'
  return [...values].sort((a, b) => severityRank(a) - severityRank(b))[0]
}

function propertyImportance(
  nodeA: ManifestNode,
  nodeB: ManifestNode,
  projectA: Project,
  projectB: Project,
  keys: string[]
): Record<string, Severity> {
  const fieldsA = templateFields(nodeA.templateId ? projectA.templates?.[nodeA.templateId] : undefined)
  const fieldsB = templateFields(nodeB.templateId ? projectB.templates?.[nodeB.templateId] : undefined)
  const out: Record<string, Severity> = {}
  for (const key of keys) {
    const a = inferredFieldImportance(key, fieldsA[key])
    const b = inferredFieldImportance(key, fieldsB[key])
    out[key] = mostImportantSeverity([a, b])
  }
  return out
}

function propertySeverityReason(importance: Record<string, Severity>): { severity: Severity; reason: string } {
  const entries = Object.entries(importance)
  const severity = mostImportantSeverity(entries.map(([, value]) => value))
  const important = entries
    .filter(([, value]) => value === severity)
    .map(([key]) => `"${key}"`)
    .slice(0, 3)
    .join(', ')
  if (severity === 'High') return { severity, reason: `High: important field ${important} changed.` }
  if (severity === 'Low') return { severity, reason: `Low: only low-importance field ${important} changed.` }
  return { severity, reason: `Medium: field ${important} changed.` }
}

function referenceLabel(value: unknown, nodeMap: NodeMap): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  const target = nodeMap.get(value)
  if (!target) return `${value} (missing)`
  return `${target.name} (${value})`
}

function propertyValueLabels(
  nodeA: ManifestNode,
  nodeB: ManifestNode,
  projectA: Project,
  projectB: Project,
  nodesA: NodeMap,
  nodesB: NodeMap,
): Record<string, { old?: string; new?: string }> | undefined {
  const fieldsA = templateFields(nodeA.templateId ? projectA.templates?.[nodeA.templateId] : undefined)
  const fieldsB = templateFields(nodeB.templateId ? projectB.templates?.[nodeB.templateId] : undefined)
  const keys = new Set([...Object.keys(nodeA.properties), ...Object.keys(nodeB.properties)])
  const labels: Record<string, { old?: string; new?: string }> = {}

  for (const key of keys) {
    const oldIsReference = fieldsA[key]?.type === 'reference'
    const newIsReference = fieldsB[key]?.type === 'reference'
    if (!oldIsReference && !newIsReference) continue

    const oldLabel = oldIsReference ? referenceLabel(nodeA.properties[key], nodesA) : undefined
    const newLabel = newIsReference ? referenceLabel(nodeB.properties[key], nodesB) : undefined
    if (oldLabel !== undefined || newLabel !== undefined) {
      labels[key] = { ...(oldLabel !== undefined ? { old: oldLabel } : {}), ...(newLabel !== undefined ? { new: newLabel } : {}) }
    }
  }

  return Object.keys(labels).length > 0 ? labels : undefined
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
  const childrenA = buildChildrenMap(projectA.nodes)
  const incomingReferencesB = buildIncomingReferenceImpact(projectB, nodesB)
  const ids = new Set([...nodesA.keys(), ...nodesB.keys()])
  const removedIds = new Set([...nodesA.keys()].filter(id => !nodesB.has(id)))
  const diffs: DraftDiffEntry[] = []

  for (const id of ids) {
    const nodeA = nodesA.get(id)
    const nodeB = nodesB.get(id)

    if (!nodeA && nodeB) {
      diffs.push({
        nodeId: id,
        changeType: 'added',
        severity: 'High',
        severityReason: 'High: node was added to the hierarchy.',
        newValue: nodeB,
        context: makeContext(nodeB, nodesB),
      })
      continue
    }

    if (nodeA && !nodeB) {
      const descendants = hasRemovedAncestor(nodeA, nodesA, removedIds)
        ? []
        : descendantImpact(id, childrenA, nodesA)
      const references = incomingReferencesB.get(id) ?? []
      const impacts = [
        descendants.length > 0 ? `${descendants.length} descendant${descendants.length === 1 ? '' : 's'}` : '',
        references.length > 0 ? `${references.length} incoming reference${references.length === 1 ? '' : 's'}` : '',
      ].filter(Boolean)
      diffs.push({
        nodeId: id,
        changeType: 'removed',
        severity: 'High',
        severityReason: impacts.length > 0
          ? `High: removed node affected ${impacts.join(' and ')}.`
          : 'High: node was removed from the hierarchy.',
        oldValue: nodeA,
        context: {
          ...makeContext(nodeA, nodesA),
          ...((descendants.length > 0 || references.length > 0)
            ? { removalImpact: { descendants, incomingReferences: references } }
            : {}),
        },
      })
      continue
    }

    if (!nodeA || !nodeB) continue

    if (nodeA.parentId !== nodeB.parentId) {
      diffs.push({
        nodeId: id,
        changeType: 'moved',
        severity: 'High',
        severityReason: 'High: node moved to a different parent.',
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
        severityReason: 'Medium: node display name changed.',
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
        severityReason: 'Medium: node template binding changed.',
        oldValue: nodeA.templateId ?? null,
        newValue: nodeB.templateId ?? null,
        context: makeContext(nodeB, nodesB),
      })
    }

    if (!propertiesEqual(nodeA.properties, nodeB.properties)) {
      const labels = propertyValueLabels(nodeA, nodeB, projectA, projectB, nodesA, nodesB)
      const keys = changedPropertyKeys(nodeA.properties, nodeB.properties)
      const importance = propertyImportance(nodeA, nodeB, projectA, projectB, keys)
      const { severity, reason } = propertySeverityReason(importance)
      diffs.push({
        nodeId: id,
        changeType: 'property-changed',
        severity,
        severityReason: reason,
        oldValue: nodeA.properties,
        newValue: nodeB.properties,
        context: {
          ...makeContext(nodeB, nodesB),
          ...(labels ? { propertyValueLabels: labels } : {}),
          propertyImportance: importance,
        },
      })
    }

    if (nodeA.parentId === nodeB.parentId && nodeA.order !== nodeB.order) {
      diffs.push({
        nodeId: id,
        changeType: 'order-changed',
        severity: 'Low',
        severityReason: 'Low: sibling order changed without structural movement.',
        oldValue: nodeA.order,
        newValue: nodeB.order,
        context: makeContext(nodeB, nodesB),
      })
    }
  }

  return diffs
    .map(diff => ({ ...diff, classification: classifyDiff(diff) }))
    .sort(compareEntries)
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
  if ((a.compareImportance ?? null) !== (b.compareImportance ?? null)) return false
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
  label: string,
  a: NodeTemplate,
  b: NodeTemplate,
  out: TemplateDiffEntry[]
): void {
  // templateFields() is null-safe — snapshot manifests are parsed without
  // rejecting malformed templates, so a side with no/invalid `fields` (e.g.
  // a hand-edited `{ label: 'Bad' }`) must not throw here.
  const fieldsA = templateFields(a)
  const fieldsB = templateFields(b)
  const keys = new Set([...Object.keys(fieldsA), ...Object.keys(fieldsB)])
  for (const key of [...keys].sort()) {
    const fieldA = fieldsA[key]
    const fieldB = fieldsB[key]
    if (!fieldA && fieldB) {
      out.push({ templateId, templateLabel: label, changeType: 'field-added', fieldKey: key, newValue: fieldB })
    } else if (fieldA && !fieldB) {
      out.push({ templateId, templateLabel: label, changeType: 'field-removed', fieldKey: key, oldValue: fieldA })
    } else if (fieldA && fieldB && !fieldsEqual(fieldA, fieldB)) {
      out.push({
        templateId,
        templateLabel: label,
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
      out.push({ templateId: id, templateLabel: templateLabel(tplB, id), changeType: 'template-added', newValue: tplB })
      continue
    }
    if (tplA && !tplB) {
      out.push({ templateId: id, templateLabel: templateLabel(tplA, id), changeType: 'template-removed', oldValue: tplA })
      continue
    }
    if (!tplA || !tplB) continue

    // Compare on safe label strings — a hand-edited non-string label must not
    // leak into the entry or crash a downstream `.trim()`.
    const labelA = templateLabel(tplA, id)
    const labelB = templateLabel(tplB, id)
    if (labelA !== labelB) {
      out.push({
        templateId: id,
        templateLabel: labelB,
        changeType: 'template-relabeled',
        oldValue: labelA,
        newValue: labelB,
      })
    }
    if ((tplA.description ?? '') !== (tplB.description ?? '')) {
      out.push({
        templateId: id,
        templateLabel: labelB,
        changeType: 'template-redescribed',
        oldValue: tplA.description ?? null,
        newValue: tplB.description ?? null,
      })
    }
    diffTemplateFields(id, labelB, tplA, tplB, out)
  }

  return out
}
