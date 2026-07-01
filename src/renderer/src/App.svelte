<svelte:options runes />

<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte'
  import type { Project, ManifestNode, ManifestWarning, ProjectWarning, NodeTemplate, PropertyType, RecoveryPoint, ReferenceBlocker, SearchResult, Snapshot, SnapshotTimelineEvent, ImportResult } from '../../shared/types'
  import { isUsableTemplate, templateLabel } from '../../shared/validation'
  import { snapshotRefLabel } from '../../shared/snapshot-ref'
  import {
    createDisabledMenuCommandState,
    type MenuCommandId,
    type MenuCommandState,
  } from '../../shared/menu-commands'
  import type { MergedTree } from '../../shared/merged-tree'
  import { computeSubtreeSummaries, templatesForNode } from '../../shared/merged-tree'
  import { buildTree, getSiblingIndex, getAncestorIds } from './lib/tree'
  import { flattenTree } from './lib/tree-rows'
  import { cycleIndex } from './lib/tree-typeahead'
  import ManifestView from './components/ManifestView.svelte'
  import DetailPane from './components/DetailPane.svelte'
  import MoveToDialog from './components/MoveToDialog.svelte'
  import TemplateManager from './components/TemplateManager.svelte'
  import ImportDialog from './components/ImportDialog.svelte'
  import RecoveryDialog from './components/RecoveryDialog.svelte'
  import RevertDialog from './components/RevertDialog.svelte'
  import SnapshotsPanel from './components/SnapshotsPanel.svelte'

  type AppState = 'welcome' | 'creating' | 'loading' | 'open'

  // ─── State ────────────────────────────────────────────────────────────────

  let appState: AppState       = $state('welcome')
  let project:  Project | null = $state(null)
  let error:    string | null  = $state(null)
  let newName:  string         = $state('')
  let newPath:  string         = $state('')
  let creating: boolean        = $state(false)

  // Tree UI state
  let selectedId:  string | null = $state(null)
  // When the user has a ghost selected in compare mode and leaves compare mode
  // (closing the snapshot pair), the ghost id can't survive in `selectedId`
  // because nothing in the live project resolves it. We stash it here so the
  // next time the same snapshot pair is compared, the selection is restored.
  // Cleared whenever the user makes a fresh live selection (issue #3).
  let stashedGhostSelection: string | null = $state(null)
  let expandedIds: Set<string>   = $state(new Set())
  let searchQuery: string        = $state('')
  let searchResults: SearchResult[] = $state([])
  let searchResultIndex: number = $state(0)
  let searching:   boolean       = $state(false)
  let selectedScrollAlign: 'auto' | 'center' = $state('auto')
  let searchInputEl: HTMLInputElement | null = $state(null)

  const searchActive = $derived(searchQuery.trim().length > 0)
  const searchMatchSet = $derived(new Set(searchResults.map(r => r.nodeId)))
  const searchResultMap = $derived(new Map(searchResults.map(r => [r.nodeId, r])))
  const searchIncludeIds = $derived.by(() => {
    if (!project || !searchActive || searching) return null
    const parentMap = new Map(project.nodes.map(n => [n.id, n.parentId]))
    const ids = new Set<string>()
    for (const result of searchResults) {
      ids.add(result.nodeId)
      let current = parentMap.get(result.nodeId) ?? null
      while (current !== null) {
        ids.add(current)
        current = parentMap.get(current) ?? null
      }
    }
    return ids
  })

  // Inline add-child state
  let addingChildTo: string | null = $state(null)
  let addingChildName: string      = $state('')
  let addingChildError: string | null = $state(null)
  let addingChildTemplateId: string | null = $state(null)
  let addChildInput: HTMLInputElement | null = $state(null)
  // Only structurally-usable templates are offered in the node-create picker.
  const addChildTemplateIds = $derived.by<string[]>(() => {
    const p: Project | null = project
    const map = p?.templates ?? {}
    return Object.keys(map).filter(id => isUsableTemplate(map[id])).sort()
  })

  // Rename request signal — bumping this counter triggers DetailPane.startEditName().
  // Tree raises onRenameRequest → App increments → DetailPane $effect picks it up.
  let renameRequestId = $state(0)

  let moveToNodeId: string | null = $state(null)

  // Snapshot/history UI state
  let snapshotPanelOpen: boolean = $state(false)
  let snapshots: Snapshot[] = $state([])
  let snapshotTimelineEvents: SnapshotTimelineEvent[] = $state([])
  let snapshotRecoveryPoints: RecoveryPoint[] = $state([])
  let snapshotLoading: boolean = $state(false)
  let snapshotCreating: boolean = $state(false)
  let snapshotComparing: boolean = $state(false)
  let snapshotRestoringName: string | null = $state(null)
  let snapshotError: string | null = $state(null)
  let revertDialogSnapshotName: string | null = $state(null)
  let revertDialogNoteRequired: boolean = $state(false)
  let revertDialogError: string | null = $state(null)
  let recoveryDialogPoint: RecoveryPoint | null = $state(null)
  let recoveryApplyingId: string | null = $state(null)
  let recoveryDialogError: string | null = $state(null)
  let workingCopyBaseSnapshot: string | null = $state(null)
  let workingCopyDirty: boolean = $state(false)

  // Compare mode state — separate from normal expanded state so user's tree
  // position is preserved when exiting compare mode.
  let compareMode: boolean = $state(false)
  let mergedTree: MergedTree | null = $state(null)
  let compareExpanded: Set<string> = $state(new Set())

  // Resizable pane widths (px).
  let treeWidth:  number = $state(288)  // 18rem default
  let panelWidth: number = $state(320)  // 20rem default

  // foldIds the user has manually expanded inside the Space-Folding Lens.
  // Resets on project close / mode flip — handled in those flows below.
  let lensExpandedFolds: Set<string> = $state(new Set())

  // Drag-to-resize state.
  let draggingHandle: 'tree' | 'panel' | null = $state(null)
  let dragStartX = 0
  let dragStartWidth = 0

  function startDrag(handle: 'tree' | 'panel', e: MouseEvent) {
    draggingHandle = handle
    dragStartX = e.clientX
    dragStartWidth = handle === 'tree' ? treeWidth : panelWidth
    e.preventDefault()
  }

  function onDragMove(e: MouseEvent) {
    if (!draggingHandle) return
    const delta = e.clientX - dragStartX
    if (draggingHandle === 'tree') {
      treeWidth = Math.max(160, Math.min(520, dragStartWidth + delta))
    } else {
      // Panel handle is on its left edge — dragging left grows the panel.
      panelWidth = Math.max(240, Math.min(600, dragStartWidth - delta))
    }
  }

  function onDragEnd() {
    draggingHandle = null
  }

  // Non-blocking error toast
  let toastMsg:     string | null = $state(null)
  let toastTimer:   ReturnType<typeof setTimeout> | null = null
  let unsubscribeMenuCommands: (() => void) | null = null
  const brandMark = '/manifest-mark.svg'

  // ─── Derived ──────────────────────────────────────────────────────────────

  const tree = $derived.by(() => {
    if (!project) return null
    return buildTree(project.nodes)
  })

  // Subtree change summaries for the lens — populated only in compare mode,
  // so the FoldMarker can show "47 unchanged · 3 added, 2 moved" rollups
  // for collapsed subtrees inside a fold. Pure derivation from mergedTree.
  const compareSubtreeSummaries = $derived.by(() =>
    mergedTree ? computeSubtreeSummaries(mergedTree) : null
  )

  const flatRows = $derived.by(() => {
    if (compareMode && mergedTree) {
      const mergedTreeBuilt = buildTree(mergedTree.nodes)
      if (!mergedTreeBuilt) return []
      return flattenTree(mergedTreeBuilt, compareExpanded, { compareMode: true })
    }
    if (!tree) return []
    return flattenTree(tree, expandedIds, searchIncludeIds ? { includeIds: searchIncludeIds } : {})
  })

  const selectedNode = $derived.by(() => {
    if (!selectedId || !project) return null
    if (compareMode && mergedTree) {
      return mergedTree.nodes.find((node) => node.id === selectedId) ?? null
    }
    return project.nodes.find((node) => node.id === selectedId) ?? null
  })

  const detailProject = $derived.by(() => {
    if (!project) return null
    if (compareMode && mergedTree) {
      // Resolve the inspected node's typed fields against the side it belongs
      // to (ghost → from-snapshot templates, live → to-snapshot templates), so
      // a node bound to a template whose schema changed between the two
      // snapshots isn't mislabeled by the inspector. See templatesForNode.
      const templates = templatesForNode(selectedNode, mergedTree)
      return { ...project, nodes: mergedTree.nodes, templates }
    }
    return project
  })

  const projectModeLabel = $derived.by(() => {
    if (compareMode && mergedTree) {
      return `Comparing ${snapshotRefLabel(mergedTree.fromSnapshot)} -> ${snapshotRefLabel(mergedTree.toSnapshot)}`
    }
    if (workingCopyBaseSnapshot) {
      return workingCopyDirty ? 'Unsnapshotted changes' : `Current project matches ${workingCopyBaseSnapshot}`
    }
    return workingCopyDirty ? 'Unsnapshotted changes' : 'Current Project'
  })

  // Tree edits are locked while comparing, reverting, or applying a recovery point.
  // Each of those operations mutates currentProject in main; interleaving a renderer
  // mutation can leave the project in a half-restored state.
  const editingLocked = $derived(
    compareMode || snapshotRestoringName !== null || recoveryApplyingId !== null
  )

  function lockReason(): string {
    if (compareMode) return 'Exit compare to edit the current project.'
    if (snapshotRestoringName) return 'Wait for revert to finish before editing.'
    if (recoveryApplyingId) return 'Wait for recovery to finish before editing.'
    return ''
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  onMount(async () => {
    unsubscribeMenuCommands = window.api.menu.onCommand((command) => {
      void runMenuCommand(command)
    })

    // Rehydrate if main already has a project open (e.g. macOS activate).
    const result = await window.api.project.getCurrent()
    if (result.ok && result.data) {
      project = result.data
      selectRoot(result.data)
      appState = 'open'
    }

    // Resize drag — registered once here, cleaned up in onDestroy.
    window.addEventListener('mousemove', onDragMove)
    window.addEventListener('mouseup', onDragEnd)
  })

  onDestroy(() => {
    unsubscribeMenuCommands?.()
    unsubscribeMenuCommands = null
    window.removeEventListener('mousemove', onDragMove)
    window.removeEventListener('mouseup', onDragEnd)
  })

  // ─── Helpers ──────────────────────────────────────────────────────────────

  function selectRoot(p: Project) {
    const root = p.nodes.find(n => n.parentId === null)
    if (root) {
      setSelection(root.id)
      expandedIds = new Set([root.id])
    }
  }

  function showToast(msg: string) {
    toastMsg = msg
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = setTimeout(() => { toastMsg = null }, 4000)
  }

  // Export the loaded compare as a saved report. Main builds + writes (renderer
  // never touches the filesystem); a canceled save dialog is a silent no-op.
  async function handleExportReport(format: 'markdown' | 'csv') {
    if (!mergedTree) return
    const res = await window.api.report.export(mergedTree.fromSnapshot, mergedTree.toSnapshot, format)
    if (!res.ok) { showToast(`Export failed: ${res.error.message}`); return }
    if (res.data.savedPath) showToast(`Report saved to ${res.data.savedPath}`)
  }

  // Copy the loaded compare as Markdown. Clipboard is a renderer-side write, not
  // a filesystem touch, so it stays in the renderer.
  async function handleCopyReport() {
    if (!mergedTree) return
    const res = await window.api.report.build(mergedTree.fromSnapshot, mergedTree.toSnapshot, 'markdown')
    if (!res.ok) { showToast(`Copy failed: ${res.error.message}`); return }
    try {
      await navigator.clipboard.writeText(res.data.content)
      showToast('Report copied to clipboard')
    } catch {
      showToast('Could not access the clipboard')
    }
  }

  async function focusInput(el: HTMLInputElement | null) {
    await tick()
    el?.focus()
    el?.select()
  }

  $effect(() => {
    if (addingChildTo) {
      void focusInput(addChildInput)
    }
  })

  function applyProject(p: Project) {
    project = p
    // Search results are computed against the previous project; once the
    // project mutates, stale match ids can point at deleted or moved nodes.
    if (searchActive) clearSearch()
    // If selected node was deleted, fall back to root.
    // Ghost selections (issue #3) live in mergedTree.nodes, not project.nodes,
    // so don't clobber them just because the live project mutated.
    const isGhostSelection = selectedId?.startsWith('ghost:') ?? false
    if (selectedId && !isGhostSelection && !p.nodes.find(n => n.id === selectedId)) {
      const root = p.nodes.find(n => n.parentId === null)
      setSelection(root?.id ?? null)
    }
  }

  function markWorkingCopyChanged() {
    workingCopyDirty = true
  }

  async function reloadCurrentProject() {
    const result = await window.api.project.getCurrent()
    if (result.ok && result.data) {
      applyProject(result.data)
    }
  }

  function resetOpenProjectUi() {
    clearSearch()
    snapshotPanelOpen = false
    snapshots = []
    snapshotTimelineEvents = []
    snapshotRecoveryPoints = []
    snapshotError = null
    snapshotLoading = false
    snapshotCreating = false
    snapshotComparing = false
    snapshotRestoringName = null
    revertDialogSnapshotName = null
    revertDialogNoteRequired = false
    revertDialogError = null
    recoveryDialogPoint = null
    recoveryDialogError = null
    recoveryApplyingId = null
    workingCopyBaseSnapshot = null
    workingCopyDirty = false
    compareMode = false
    mergedTree = null
    compareExpanded = new Set()
    lensExpandedFolds = new Set()
    importDialogOpen = false
    importBaseParent = null
    importSummary = null
    importSummaryDismissed = false
    templateManagerOpen = false
    moveToNodeId = null
    addingChildTo = null
    addingChildName = ''
    addingChildError = null
    addingChildTemplateId = null
    stashedGhostSelection = null
  }

  function beginCreateProject() {
    if (project) {
      showToast('Close the current project before creating a new project.')
      return
    }
    appState = 'creating'
    error = null
  }

  async function saveCurrentProject() {
    if (!project) return
    const result = await window.api.project.save()
    if (result.ok) showToast('Project saved')
    else showToast(result.error.message)
  }

  async function focusSearch() {
    if (!project || compareMode) return
    await tick()
    searchInputEl?.focus()
    searchInputEl?.select()
  }

  async function reindexHistory() {
    if (!project) return
    const result = await window.api.node.historyReindex()
    if (result.ok) showToast('History index refreshed')
    else showToast(result.error.message)
  }

  function buildMenuCommandState(): MenuCommandState {
    const state = createDisabledMenuCommandState()
    const hasOpenProject = appState === 'open' && project !== null
    const projectBusy = snapshotRestoringName !== null || recoveryApplyingId !== null
    const canUseProject = hasOpenProject && !projectBusy
    const canEditProject = canUseProject && !editingLocked
    const selectedLiveNode = canEditProject && selectedNode && !selectedId?.startsWith('ghost:')
      ? selectedNode
      : null
    const selectedEditableChild = selectedLiveNode !== null && selectedLiveNode.parentId !== null
    const compareLoaded = hasOpenProject && compareMode && mergedTree !== null

    state['project:new'] = appState === 'welcome' && project === null
    state['project:open'] = appState !== 'loading' && appState !== 'creating' && !creating && !snapshotRestoringName && !recoveryApplyingId
    state['project:save'] = canUseProject
    state['project:close'] = canUseProject
    state['project:import'] = canEditProject
    state['project:templates'] = canEditProject
    state['project:snapshots'] = canUseProject
    state['project:search'] = canUseProject && !compareMode
    state['compare:exit'] = compareLoaded && !projectBusy
    state['report:copyMarkdown'] = compareLoaded && !projectBusy
    state['report:exportMarkdown'] = compareLoaded && !projectBusy
    state['report:exportCsv'] = compareLoaded && !projectBusy
    state['node:addChild'] = selectedLiveNode !== null
    state['node:rename'] = selectedLiveNode !== null
    state['node:moveTo'] = Boolean(selectedEditableChild)
    state['node:delete'] = Boolean(selectedEditableChild)
    state['history:reindex'] = canUseProject

    return state
  }

  function canRunMenuCommand(command: MenuCommandId): boolean {
    return buildMenuCommandState()[command]
  }

  async function runMenuCommand(command: MenuCommandId) {
    if (!canRunMenuCommand(command)) return

    switch (command) {
      case 'project:new':
        beginCreateProject()
        return
      case 'project:open':
        await openProject()
        return
      case 'project:save':
        await saveCurrentProject()
        return
      case 'project:close':
        await closeProject()
        return
      case 'project:import':
        openImportDialog()
        return
      case 'project:templates':
        openTemplateManager()
        return
      case 'project:snapshots':
        await toggleSnapshots()
        return
      case 'project:search':
        await focusSearch()
        return
      case 'compare:exit':
        exitCompareMode()
        return
      case 'report:copyMarkdown':
        await handleCopyReport()
        return
      case 'report:exportMarkdown':
        await handleExportReport('markdown')
        return
      case 'report:exportCsv':
        await handleExportReport('csv')
        return
      case 'node:addChild':
        if (selectedNode && !selectedId?.startsWith('ghost:')) handleAddChild(selectedNode.id)
        return
      case 'node:rename':
        handleRenameRequest()
        return
      case 'node:moveTo':
        if (selectedNode && !selectedId?.startsWith('ghost:')) handleMoveTo(selectedNode.id)
        return
      case 'node:delete':
        if (selectedNode && !selectedId?.startsWith('ghost:')) await handleDelete(selectedNode.id)
        return
      case 'history:reindex':
        await reindexHistory()
        return
    }
  }

  // Push enabled/disabled state to the native menu, but only when it actually
  // changes — the effect re-runs on every reactive dependency, and most UI
  // interactions leave the command map identical. Skipping no-op sends avoids a
  // high volume of redundant IPC messages and native menu mutations.
  let lastSentMenuState = ''
  $effect(() => {
    const next = buildMenuCommandState()
    const serialized = JSON.stringify(next)
    if (serialized === lastSentMenuState) return
    lastSentMenuState = serialized
    window.api.menu.updateState(next)
  })

  // ─── Welcome actions ──────────────────────────────────────────────────────

  async function openProject() {
    error = null
    const folderPath = await window.api.dialog.openFolder('Open Project')
    if (!folderPath) return

    const fallbackState = project ? 'open' : 'welcome'
    if (project) {
      const saved = await window.api.project.save()
      if (!saved.ok) {
        error = saved.error.message
        showToast(saved.error.message)
        return
      }
    }

    appState = 'loading'
    const result = await window.api.project.open(folderPath)
    if (result.ok) {
      resetOpenProjectUi()
      project = result.data
      selectRoot(result.data)
      workingCopyBaseSnapshot = null
      workingCopyDirty = false
      loadWarningsDismissed = false
      projectWarningsDismissed = false
      appState = 'open'
    } else {
      error = result.error.message
      appState = fallbackState
    }
  }

  async function selectFolder() {
    const folderPath = await window.api.dialog.openFolder('Choose Location')
    if (folderPath) newPath = folderPath
  }

  async function createProject() {
    if (!newName.trim() || !newPath) return
    creating = true
    error = null
    const result = await window.api.project.create(newName.trim(), newPath)
    creating = false
    if (result.ok) {
      project = result.data
      selectRoot(result.data)
      workingCopyBaseSnapshot = null
      workingCopyDirty = false
      projectWarningsDismissed = false
      appState = 'open'
    } else {
      error = result.error.message
    }
  }

  async function closeProject() {
    await window.api.project.close()
    project = null
    setSelection(null)
    expandedIds = new Set()
    clearSearch()
    appState = 'welcome'
    newName = ''
    newPath = ''
    error = null
    snapshotPanelOpen = false
    snapshots = []
    snapshotError = null
    workingCopyBaseSnapshot = null
    workingCopyDirty = false
    compareMode = false
    mergedTree = null
    compareExpanded = new Set()
    lensExpandedFolds = new Set()
    // stashedGhostSelection already cleared by setSelection(null) above.
  }

  // ─── Tree actions ─────────────────────────────────────────────────────────

  /**
   * Single entry point for changing `selectedId`. Always invalidates any
   * stashed ghost selection (issue #3): an explicit selection — whether
   * triggered by tree click, search, add-child, or diff-row navigation —
   * means the user has moved on, so don't surprise them by restoring a
   * stale ghost the next time compare mode is re-entered.
   *
   * Inside compare mode the stash is already null (handleSnapshotCompare
   * consumes it on entry), so the clear is a no-op there.
   */
  function setSelection(id: string | null): void {
    selectedId = id
    stashedGhostSelection = null
  }

  function handleSelect(id: string) {
    selectedScrollAlign = 'auto'
    setSelection(id)
    addingChildTo = null
  }

  function handleToggle(id: string) {
    if (compareMode) {
      const next = new Set(compareExpanded)
      if (next.has(id)) { next.delete(id) } else { next.add(id) }
      compareExpanded = next
    } else {
      const next = new Set(expandedIds)
      if (next.has(id)) { next.delete(id) } else { next.add(id) }
      expandedIds = next
    }
  }

  function handleAddChild(parentId: string) {
    if (editingLocked) {
      showToast(lockReason())
      return
    }
    addingChildTo = parentId
    addingChildName = ''
    addingChildError = null
    addingChildTemplateId = null
    expandedIds = new Set([...expandedIds, parentId])
  }

  async function commitAddChild() {
    if (editingLocked) {
      showToast(lockReason())
      return
    }
    if (!addingChildTo || !addingChildName.trim()) {
      addingChildError = 'Name is required'
      return
    }
    const result = await window.api.node.create(
      addingChildTo,
      addingChildName.trim(),
      addingChildTemplateId,
    )
    if (result.ok) {
      applyProject(result.data)
      markWorkingCopyChanged()
      // Select the new node (last child of parent).
      const newNode = result.data.nodes
        .filter(n => n.parentId === addingChildTo)
        .sort((a, b) => b.order - a.order)[0]
      if (newNode) setSelection(newNode.id)
      addingChildTo = null
      addingChildName = ''
      addingChildTemplateId = null
    } else {
      addingChildError = result.error.message
    }
  }

  function cancelAddChild() {
    addingChildTo = null
    addingChildName = ''
    addingChildError = null
    addingChildTemplateId = null
  }

  async function handleMoveUp(id: string) {
    if (!project || editingLocked) return
    const idx = getSiblingIndex(id, project.nodes)
    if (idx <= 0) return
    const result = await window.api.node.move(id, project.nodes.find(n => n.id === id)!.parentId!, idx - 1)
    if (result.ok) {
      applyProject(result.data)
      markWorkingCopyChanged()
    }
    else showToast(result.error.message)
  }

  async function handleMoveDown(id: string) {
    if (!project || editingLocked) return
    const node = project.nodes.find(n => n.id === id)
    if (!node) return
    const siblings = project.nodes.filter(n => n.parentId === node.parentId)
    const idx = getSiblingIndex(id, project.nodes)
    if (idx >= siblings.length - 1) return
    const result = await window.api.node.move(id, node.parentId!, idx + 1)
    if (result.ok) {
      applyProject(result.data)
      markWorkingCopyChanged()
    }
    else showToast(result.error.message)
  }

  function handleMoveTo(id: string) {
    if (editingLocked) {
      showToast(lockReason())
      return
    }
    moveToNodeId = id
  }

  async function confirmMoveTo(targetParentId: string) {
    if (!moveToNodeId || editingLocked) return
    const result = await window.api.node.move(moveToNodeId, targetParentId, 999)
    moveToNodeId = null
    if (result.ok) {
      applyProject(result.data)
      markWorkingCopyChanged()
    }
    else showToast(result.error.message)
  }

  async function handleDelete(id: string) {
    if (!project || editingLocked) return
    const node = project.nodes.find(n => n.id === id)
    if (!node) return

    const children = project.nodes.filter(n => n.parentId === id)
    const descendantCount = getDescendantCount(id, project.nodes)

    if (descendantCount > 0) {
      const confirmed = window.confirm(
        `Delete "${node.name}" and its ${descendantCount} descendant${descendantCount === 1 ? '' : 's'}?`
      )
      if (!confirmed) return
    }

    const result = await window.api.node.delete(id)
    if (result.ok) {
      applyProject(result.data)
      markWorkingCopyChanged()
      return
    }

    // Blocked by incoming references? Offer to clear them and force the delete.
    // Validate the shape — context crosses the IPC boundary as unknown.
    const rawBlockers = result.error.context?.blockers
    const blockers = Array.isArray(rawBlockers) ? (rawBlockers as ReferenceBlocker[]) : []
    if (blockers.length > 0) {
      const list = blockers
        .map(b => {
          const holder = b.kind === 'template-default' ? `Template "${b.nodeName}" default` : b.nodeName
          return `• ${holder} → ${b.key} (→ ${b.targetName})`
        })
        .join('\n')
      // Count distinct holders for accurate copy: a holder may contribute more
      // than one blocker (multiple reference keys), and template defaults aren't
      // nodes — so blockers.length is not a node count.
      const n = blockers.length
      const ref = `reference${n === 1 ? '' : 's'}`
      const confirmed = window.confirm(
        `"${node.name}" has ${n} incoming ${ref}:\n\n${list}\n\n` +
        `Delete "${node.name}" and clear ${n === 1 ? 'it' : `all ${n}`}?`
      )
      if (!confirmed) return
      const forced = await window.api.node.delete(id, { unlinkReferences: true })
      if (forced.ok) {
        applyProject(forced.data)
        markWorkingCopyChanged()
      }
      else showToast(forced.error.message)
      return
    }

    showToast(result.error.message)
  }

  function handleRenameRequest() {
    if (editingLocked) {
      showToast(lockReason())
      return
    }
    // Bump the signal counter — DetailPane's $effect will call startEditName().
    renameRequestId += 1
  }

  async function handleNodeUpdate(
    id: string,
    changes: {
      name?: string
      properties?: Record<string, string | number | boolean | null>
      templateId?: string | null
    }
  ) {
    if (editingLocked) {
      showToast(lockReason())
      return
    }
    const result = await window.api.node.update(id, changes)
    if (result.ok) {
      applyProject(result.data)
      markWorkingCopyChanged()
    }
    else showToast(result.error.message)
  }

  // Promote an ad-hoc property to a typed field on the node's template.
  async function handlePromoteField(nodeId: string, key: string, type: PropertyType) {
    if (!project || editingLocked) { showToast(lockReason()); return }
    const node = project.nodes.find(n => n.id === nodeId)
    const templateId = node?.templateId ?? null
    if (!templateId) { showToast('Assign a template before promoting a property.'); return }
    const template = project.templates?.[templateId]
    if (!template) { showToast('Template not found.'); return }

    // $state.snapshot: template.fields is a deep Svelte proxy; nested field
    // objects must be plain to survive structured-clone across the IPC boundary.
    const existingFields = $state.snapshot(template.fields) as Record<string, NodeTemplate['fields'][string]>
    const nextFields = { ...existingFields, [key]: { type } }
    const result = await window.api.template.update(templateId, { fields: nextFields })
    if (result.ok) {
      applyProject(result.data)
      markWorkingCopyChanged()
    } else {
      showToast(result.error.message)
    }
  }

  // ─── Templates ──────────────────────────────────────────────────────────────

  let templateManagerOpen = $state(false)

  // Load-time warnings (typed-value/integrity issues found when opening a
  // hand-edited manifest). Delivered once on open; cleared by any mutation.
  let loadWarningsDismissed = $state(false)
  const loadWarnings = $derived.by<ManifestWarning[]>(() => {
    const p: Project | null = project
    return p?.loadWarnings ?? []
  })
  const showLoadWarnings = $derived(loadWarnings.length > 0 && !loadWarningsDismissed)

  let projectWarningsDismissed = $state(false)
  const projectWarnings = $derived.by<ProjectWarning[]>(() => {
    const p: Project | null = project
    return p?.projectWarnings ?? []
  })
  const showProjectWarnings = $derived(projectWarnings.length > 0 && !projectWarningsDismissed)

  function openTemplateManager() {
    if (editingLocked) { showToast(lockReason()); return }
    templateManagerOpen = true
  }

  async function handleTemplateCreate(id: string, template: NodeTemplate): Promise<string | null> {
    const result = await window.api.template.create(id, template)
    if (result.ok) { applyProject(result.data); markWorkingCopyChanged(); return null }
    return result.error.message
  }

  async function handleTemplateUpdate(id: string, template: NodeTemplate): Promise<string | null> {
    const result = await window.api.template.update(id, template)
    if (result.ok) { applyProject(result.data); markWorkingCopyChanged(); return null }
    return result.error.message
  }

  async function handleTemplateDelete(id: string): Promise<string | null> {
    const result = await window.api.template.delete(id)
    if (result.ok) { applyProject(result.data); markWorkingCopyChanged(); return null }
    return result.error.message
  }

  // ─── CSV import ───────────────────────────────────────────────────────────────

  let importDialogOpen = $state(false)
  let importBaseParent = $state<ManifestNode | null>(null)
  let importSummary = $state<ImportResult | null>(null)
  let importSummaryDismissed = $state(false)
  const showImportSummary = $derived(importSummary !== null && !importSummaryDismissed)

  function resolveBaseParent(node?: ManifestNode): ManifestNode | null {
    if (!project) return null
    if (node) return node
    const sel = selectedId ? project.nodes.find(n => n.id === selectedId) : undefined
    return sel ?? project.nodes.find(n => n.parentId === null) ?? null
  }

  function openImportDialog(node?: ManifestNode) {
    if (editingLocked) { showToast(lockReason()); return }
    const base = resolveBaseParent(node)
    if (!base) return
    importBaseParent = base
    importDialogOpen = true
  }

  function handleImportHere(id: string) {
    const node = project?.nodes.find(n => n.id === id)
    openImportDialog(node)
  }

  function handleImported(next: Project, summary: ImportResult) {
    applyProject(next)
    markWorkingCopyChanged()
    // Reveal the imported rows by expanding the base parent (flat imports land
    // directly under it; path imports go deeper, but expanding the base is a
    // sensible starting point).
    if (importBaseParent) expandedIds = new Set([...expandedIds, importBaseParent.id])
    importSummary = summary
    importSummaryDismissed = false
  }

  // ─── Search ───────────────────────────────────────────────────────────────

  let searchTimer: ReturnType<typeof setTimeout> | null = null

  function revealSearchResult(index = searchResultIndex): void {
    const result = searchResults[index]
    if (!result) return
    searchResultIndex = index
    selectedScrollAlign = 'center'
    setSelection(result.nodeId)
  }

  function cycleSearchResult(reverse: boolean): void {
    if (searchResults.length === 0) return
    const next = cycleIndex(searchResultIndex, searchResults.length, reverse)
    revealSearchResult(next)
  }

  function runSearch(query: string): void {
    if (searchTimer) clearTimeout(searchTimer)
    if (!query.trim()) {
      searchResults = []
      searchResultIndex = 0
      searching = false
      return
    }
    searching = true
    searchResults = []
    searchResultIndex = 0
    searchTimer = setTimeout(async () => {
      const result = await window.api.search.query(query)
      if (query !== searchQuery) return
      searching = false
      if (result.ok) {
        searchResults = result.data
        searchResultIndex = 0
        await tick()
        revealSearchResult(0)
      }
    }, 200)
  }

  function handleSearchInput(e: Event) {
    searchQuery = (e.target as HTMLInputElement).value
    runSearch(searchQuery)
  }

  function handleSearchKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      if (!searchQuery) return
      e.preventDefault()
      clearSearch()
      searchInputEl?.focus()
      return
    }
    if (e.key === 'Enter') {
      if (!searchActive) return
      e.preventDefault()
      cycleSearchResult(e.shiftKey)
    }
  }

  function handleSearchShortcutInput(ch: string) {
    if (compareMode) return
    searchQuery += ch
    searchInputEl?.focus()
    runSearch(searchQuery)
  }

  function clearSearch() {
    if (searchTimer) clearTimeout(searchTimer)
    searchQuery = ''
    searchResults = []
    searchResultIndex = 0
    searching = false
  }

  // ─── Snapshots / history ────────────────────────────────────────────────

  async function refreshSnapshots() {
    if (!project) return
    snapshotLoading = true
    snapshotError = null

    const [result, timelineResult] = await Promise.all([
      window.api.snapshot.list(),
      window.api.snapshot.timeline(),
    ])
    snapshotLoading = false

    if (result.ok) {
      snapshots = result.data
    } else {
      snapshotError = result.error.message
    }

    if (timelineResult.ok) {
      snapshotTimelineEvents = timelineResult.data.events
      snapshotRecoveryPoints = timelineResult.data.recoveryPoints
    } else {
      snapshotError = timelineResult.error.message
    }
  }

  async function openSnapshots() {
    snapshotPanelOpen = true
    await refreshSnapshots()
  }

  async function toggleSnapshots() {
    if (snapshotPanelOpen) {
      closeSnapshots()
      return
    }
    await openSnapshots()
  }

  function closeSnapshots() {
    snapshotPanelOpen = false
    snapshotError = null
    snapshotCreating = false
    snapshotComparing = false
    snapshotRestoringName = null
    exitCompareMode()
  }

  function exitCompareMode() {
    compareMode = false
    mergedTree = null
    compareExpanded = new Set()
    // If a ghost is selected, stash it so we can restore on re-entering
    // compare mode (issue #3). Then fall back to a live selection.
    //
    // NB: the assignments below intentionally bypass setSelection() — that
    // helper clears stashedGhostSelection, which would defeat the stash we
    // just set. The stash is consumed by handleSnapshotCompare on re-entry.
    if (selectedId?.startsWith('ghost:')) {
      stashedGhostSelection = selectedId
      const root = project?.nodes.find(node => node.parentId === null)
      selectedId = root?.id ?? null
    } else if (project && selectedId && !project.nodes.find(node => node.id === selectedId)) {
      const root = project.nodes.find(node => node.parentId === null)
      selectedId = root?.id ?? null
    }
  }

  function resolveCompareSelectionId(nodeId: string): string {
    if (!mergedTree) return nodeId
    if (mergedTree.nodes.some(node => node.id === nodeId)) return nodeId

    const ghostId = `ghost:${nodeId}`
    if (mergedTree.nodes.some(node => node.id === ghostId)) return ghostId

    return nodeId
  }

  async function handleSnapshotCreate(name: string) {
    snapshotCreating = true
    snapshotError = null
    const result = await window.api.snapshot.create(name)
    snapshotCreating = false

    if (result.ok) {
      workingCopyBaseSnapshot = result.data.name
      workingCopyDirty = false
      await refreshSnapshots()
      showToast(`Snapshot "${result.data.name}" created`)
    } else {
      snapshotError = result.error.message
    }
  }

  async function handleSnapshotCompare(from: string, to: string) {
    snapshotComparing = true
    snapshotError = null
    const result = await window.api.snapshot.loadCompare(from, to)
    snapshotComparing = false

    if (result.ok) {
      mergedTree = result.data
      // Seed compareExpanded from normalExpanded ∪ ancestors of every changed node.
      const changedIds = result.data.nodes
        .filter(n => n.status !== 'unchanged')
        .map(n => n.id)
      const ancestors = new Set<string>()
      for (const id of changedIds) {
        for (const aid of getAncestorIds(id, result.data.nodes)) ancestors.add(aid)
        ancestors.add(id)
      }
      compareExpanded = new Set([...expandedIds, ...ancestors])
      compareMode = true
      clearSearch()  // search is a browse-mode aid; don't carry it into compare

      // Restore a stashed ghost selection if this snapshot pair still
      // contains the same ghost id (issue #3). Otherwise drop the stash —
      // a different comparison shouldn't carry a stale ghost selection.
      //
      // NB: assigns selectedId directly (not via setSelection) because the
      // stash is explicitly cleared two lines below; routing through the
      // helper would clear it before the side effects below could run.
      if (stashedGhostSelection) {
        if (result.data.nodes.some(n => n.id === stashedGhostSelection)) {
          selectedId = stashedGhostSelection
          // Expand ancestors so the restored ghost is visible.
          const ghostAncestors = getAncestorIds(stashedGhostSelection, result.data.nodes)
          compareExpanded = new Set([...compareExpanded, ...ghostAncestors, stashedGhostSelection])
        }
        stashedGhostSelection = null
      }
    } else {
      snapshotError = result.error.message
    }
  }

  /** Called when user clicks a diff row — selects that node in the tree. */
  function handleDiffNodeSelect(nodeId: string) {
    if (compareMode && mergedTree) {
      const compareSelectionId = resolveCompareSelectionId(nodeId)
      // Inside compare mode, the stash is already null (handleSnapshotCompare
      // consumed it on entry), so setSelection's clear is a defensive no-op.
      setSelection(compareSelectionId)
      const ancestors = getAncestorIds(compareSelectionId, mergedTree.nodes)
      compareExpanded = new Set([...compareExpanded, ...ancestors, compareSelectionId])
    } else if (project) {
      setSelection(nodeId)
      const ancestors = getAncestorIds(nodeId, project.nodes)
      expandedIds = new Set([...expandedIds, ...ancestors, nodeId])
    }
  }

  async function handleSnapshotRestore(name: string) {
    revertDialogSnapshotName = name
    revertDialogNoteRequired = false
    revertDialogError = null
    snapshotError = null
  }

  async function confirmSnapshotRevert(note: string | null) {
    const name = revertDialogSnapshotName
    if (!name) return
    snapshotRestoringName = name
    snapshotError = null
    revertDialogError = null

    try {
      const result = await window.api.snapshot.revert({ name, note })

      if (!result.ok && result.error.code === 'VALIDATION_FAILED' && result.error.message.includes('revert note is required')) {
        snapshotRestoringName = null
        revertDialogNoteRequired = true
        revertDialogError = result.error.message
        return
      }

      snapshotRestoringName = null

      if (result.ok) {
        revertDialogSnapshotName = null
        revertDialogNoteRequired = false
        revertDialogError = null
        await reloadCurrentProject()
        await refreshSnapshots()
        exitCompareMode()
        workingCopyBaseSnapshot = name
        workingCopyDirty = false
        showToast(`Reverted current project to "${name}"`)
      } else {
        revertDialogError = result.error.message
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      snapshotRestoringName = null
      revertDialogError = `Failed to revert snapshot: ${message}`
    }
  }

  function cancelSnapshotRevert() {
    if (snapshotRestoringName) return
    revertDialogSnapshotName = null
    revertDialogNoteRequired = false
    revertDialogError = null
  }

  async function handleApplyRecovery(id: string) {
    const recoveryPoint = snapshotRecoveryPoints.find(point => point.id === id)
    if (!recoveryPoint) {
      snapshotError = `Recovery point not found: ${id}`
      return
    }

    recoveryDialogPoint = recoveryPoint
    recoveryDialogError = null
    snapshotError = null
  }

  async function confirmRecoveryPointApply() {
    if (!recoveryDialogPoint) return

    recoveryApplyingId = recoveryDialogPoint.id
    recoveryDialogError = null
    snapshotError = null

    try {
      const result = await window.api.snapshot.applyRecovery({ id: recoveryDialogPoint.id })
      recoveryApplyingId = null

      if (result.ok) {
        recoveryDialogPoint = null
        recoveryDialogError = null
        await reloadCurrentProject()
        await refreshSnapshots()
        exitCompareMode()
        workingCopyBaseSnapshot = null
        workingCopyDirty = true
        showToast('Recovered current project from recovery point')
      } else {
        recoveryDialogError = result.error.message
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      recoveryApplyingId = null
      recoveryDialogError = `Failed to apply recovery point: ${message}`
    }
  }

  function cancelRecoveryPointApply() {
    if (recoveryApplyingId) return
    recoveryDialogPoint = null
    recoveryDialogError = null
  }

  // ─── Utilities ────────────────────────────────────────────────────────────

  function getDescendantCount(nodeId: string, nodes: ManifestNode[]): number {
    let count = 0
    const queue = [nodeId]
    while (queue.length > 0) {
      const id = queue.shift()!
      const children = nodes.filter(n => n.parentId === id)
      count += children.length
      queue.push(...children.map(c => c.id))
    }
    return count
  }
</script>

<!-- ─── Drag region (always present) ─────────────────────────────────────── -->
<div class="fixed top-0 left-0 right-0 h-8 [-webkit-app-region:drag] pointer-events-none z-50"></div>

<!-- ─── Toast ─────────────────────────────────────────────────────────────── -->
{#if toastMsg}
  <div class="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 bg-red-700 text-white
              text-sm px-4 py-2 rounded-lg shadow-lg max-w-sm text-center"
       data-testid="toast">
    {toastMsg}
  </div>
{/if}


<!-- ─── Move-to dialog ────────────────────────────────────────────────────── -->
{#if moveToNodeId && project}
  <MoveToDialog
    nodeId={moveToNodeId}
    nodes={project.nodes}
    onConfirm={confirmMoveTo}
    onCancel={() => { moveToNodeId = null }}
  />
{/if}

<!-- ─── Template manager ──────────────────────────────────────────────────── -->
{#if templateManagerOpen && project}
  <TemplateManager
    templates={project.templates ?? {}}
    onCreate={handleTemplateCreate}
    onUpdate={handleTemplateUpdate}
    onDelete={handleTemplateDelete}
    onClose={() => { templateManagerOpen = false }}
  />
{/if}

<!-- ─── Import dialog ─────────────────────────────────────────────────────── -->
{#if importDialogOpen && project && importBaseParent}
  <ImportDialog
    baseParent={importBaseParent}
    templates={project.templates ?? {}}
    onImported={handleImported}
    onClose={() => { importDialogOpen = false }}
  />
{/if}

<!-- ─── Welcome ────────────────────────────────────────────────────────────── -->
{#if appState === 'welcome'}
  <div class="flex flex-col h-full items-center justify-center bg-stone-50">
    <div class="flex flex-col items-center gap-8 w-full max-w-sm px-6">

      <div class="text-center">
        <div class="mx-auto mb-5 flex h-24 w-24 items-center justify-center rounded-[2rem]
                    bg-white shadow-[0_20px_45px_-28px_rgba(36,59,72,0.55)] ring-1 ring-stone-200/80">
          <img src={brandMark} alt="Manifest logo" class="h-14 w-14 drop-shadow-sm" />
        </div>
        <h1 class="text-2xl font-semibold tracking-tight text-stone-800">Manifest</h1>
        <p class="text-sm text-stone-400 mt-1">Structured projects. Named history. Clear changes.</p>
      </div>

      {#if error}
        <div class="w-full bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      {/if}

      <div class="flex flex-col gap-3 w-full">
        <button
          onclick={openProject}
          class="w-full bg-stone-800 hover:bg-stone-700 text-white text-sm font-medium
                 px-4 py-2.5 rounded-lg transition-colors duration-150 cursor-default"
          data-testid="open-project-btn"
        >
          Open Project
        </button>
        <button
          onclick={beginCreateProject}
          class="w-full bg-white hover:bg-stone-50 text-stone-700 text-sm font-medium
                 px-4 py-2.5 rounded-lg border border-stone-200 transition-colors duration-150 cursor-default"
          data-testid="create-project-btn"
        >
          Create Project
        </button>
      </div>

    </div>
  </div>

<!-- ─── Create project form ───────────────────────────────────────────────── -->
{:else if appState === 'creating'}
  <div class="flex flex-col h-full items-center justify-center bg-stone-50">
    <div class="flex flex-col gap-5 w-full max-w-sm px-6">

      <div class="flex items-center gap-3">
        <div class="flex h-12 w-12 items-center justify-center rounded-2xl bg-white ring-1 ring-stone-200">
          <img src={brandMark} alt="Manifest logo" class="h-7 w-7" />
        </div>
        <div>
          <h2 class="text-lg font-semibold text-stone-800">New Project</h2>
          <p class="text-sm text-stone-400 mt-0.5">A folder will be created at the chosen location.</p>
        </div>
      </div>

      {#if error}
        <div class="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      {/if}

      <div class="flex flex-col gap-1.5">
        <label class="text-xs font-medium text-stone-600 uppercase tracking-wide" for="proj-name">
          Project Name
        </label>
        <input
          id="proj-name"
          type="text"
          bind:value={newName}
          placeholder="Lab Bench A"
          class="w-full bg-white border border-stone-200 rounded-lg px-3 py-2 text-sm
                 text-stone-800 placeholder-stone-300 focus:outline-none focus:ring-2
                 focus:ring-stone-400 focus:border-transparent selectable"
          onkeydown={(e) => e.key === 'Enter' && createProject()}
          data-testid="project-name-input"
        />
      </div>

      <div class="flex flex-col gap-1.5">
        <span class="text-xs font-medium text-stone-600 uppercase tracking-wide">Location</span>
        <div class="flex gap-2">
          <div class="flex-1 bg-white border border-stone-200 rounded-lg px-3 py-2 text-sm
                      text-stone-500 truncate min-w-0" data-testid="selected-path">
            {newPath || 'No folder selected'}
          </div>
          <button
            onclick={selectFolder}
            class="shrink-0 bg-white hover:bg-stone-50 text-stone-600 text-sm
                   px-3 py-2 rounded-lg border border-stone-200 transition-colors cursor-default"
            data-testid="choose-folder-btn"
          >
            Choose…
          </button>
        </div>
      </div>

      <div class="flex gap-2 pt-1">
        <button
          onclick={() => { appState = 'welcome'; error = null }}
          class="flex-1 bg-white hover:bg-stone-50 text-stone-600 text-sm font-medium
                 px-4 py-2.5 rounded-lg border border-stone-200 transition-colors cursor-default"
        >
          Cancel
        </button>
        <button
          onclick={createProject}
          disabled={!newName.trim() || !newPath || creating}
          class="flex-1 bg-stone-800 hover:bg-stone-700 disabled:bg-stone-300
                 text-white text-sm font-medium px-4 py-2.5 rounded-lg
                 transition-colors cursor-default disabled:cursor-not-allowed"
          data-testid="create-btn"
        >
          {creating ? 'Creating…' : 'Create'}
        </button>
      </div>

    </div>
  </div>

<!-- ─── Loading ───────────────────────────────────────────────────────────── -->
{:else if appState === 'loading'}
  <div class="flex h-full items-center justify-center bg-stone-50">
    <p class="text-sm text-stone-400">Opening project…</p>
  </div>

<!-- ─── Project open ──────────────────────────────────────────────────────── -->
{:else if appState === 'open' && project}
  <div class="flex flex-col h-full bg-white" data-testid="project-view">

    <!-- Titlebar -->
    <div class="flex items-center justify-between px-4 py-2.5 border-b border-stone-200 bg-white
                pl-20 shrink-0 [-webkit-app-region:drag]">
      <div class="flex items-center gap-3 [-webkit-app-region:no-drag]">
        <div class="flex h-10 w-10 items-center justify-center rounded-2xl bg-stone-50 ring-1 ring-stone-200">
          <img src={brandMark} alt="Manifest logo" class="h-5 w-5" />
        </div>
        <div class="flex flex-col">
          <span class="text-[10px] font-semibold uppercase tracking-[0.18em] text-stone-400">Manifest</span>
          <span class="text-sm font-semibold text-stone-800">{project.name}</span>
          <span class="text-xs text-stone-400">{project.nodes.length} nodes</span>
        </div>
        <div
          class="max-w-[320px] truncate rounded-full border px-2.5 py-1 text-xs font-medium
                 {compareMode ? 'border-sky-200 bg-sky-50 text-sky-700' : 'border-emerald-200 bg-emerald-50 text-emerald-700'}"
          data-testid="project-mode-badge"
          title={projectModeLabel}
        >
          {projectModeLabel}
        </div>
      </div>
      <div class="flex items-center gap-2 [-webkit-app-region:no-drag]">
        <button
          onclick={() => openImportDialog()}
          class="rounded-lg border border-stone-200 px-3 py-1.5 text-xs font-medium text-stone-600
                 transition-colors hover:bg-stone-50 cursor-default"
          data-testid="open-import-btn"
        >
          Import…
        </button>
        <button
          onclick={openTemplateManager}
          class="rounded-lg border border-stone-200 px-3 py-1.5 text-xs font-medium text-stone-600
                 transition-colors hover:bg-stone-50 cursor-default"
          data-testid="open-templates-btn"
        >
          Templates
        </button>
        <button
          onclick={toggleSnapshots}
          aria-pressed={snapshotPanelOpen ? 'true' : 'false'}
          class="rounded-lg border border-stone-200 px-3 py-1.5 text-xs font-medium text-stone-600
                 transition-colors hover:bg-stone-50 cursor-default"
          data-testid="open-snapshots-btn"
        >
          Snapshots
        </button>
        <button
          onclick={closeProject}
          class="text-xs text-stone-400 hover:text-stone-600 transition-colors cursor-default
                 px-2 py-1"
          data-testid="close-project-btn"
        >
          Close
        </button>
      </div>
    </div>

    <!-- Project-level warnings banner (non-blocking; environmental risk) -->
    {#if showProjectWarnings}
      <div
        class="shrink-0 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900"
        data-testid="project-warnings-banner"
      >
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <p class="font-semibold">
              {projectWarnings[0].title}
              <span class="font-normal text-amber-700">— local indexes may corrupt under partial sync.</span>
            </p>
            <p class="mt-1 text-amber-800">
              {projectWarnings[0].message}
            </p>
          </div>
          <button
            onclick={() => { projectWarningsDismissed = true }}
            class="shrink-0 text-amber-700 hover:text-amber-900 cursor-default"
            aria-label="Dismiss project warning"
            data-testid="dismiss-project-warning"
          >✕</button>
        </div>
      </div>
    {/if}

    <!-- Load-time warnings banner (non-blocking; values left as-on-disk) -->
    {#if showLoadWarnings}
      <div
        class="shrink-0 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900"
        data-testid="load-warnings-banner"
      >
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <p class="font-semibold">
              {loadWarnings.length} data issue{loadWarnings.length === 1 ? '' : 's'} found on open
              <span class="font-normal text-amber-700">— values were left exactly as written on disk.</span>
            </p>
            <ul class="mt-1 space-y-0.5">
              {#each loadWarnings.slice(0, 5) as w (w.path)}
                <li class="truncate">
                  <span class="font-mono text-amber-700">{w.path}</span>
                  <span class="text-amber-800"> — {w.message}</span>
                </li>
              {/each}
              {#if loadWarnings.length > 5}
                <li class="text-amber-700">…and {loadWarnings.length - 5} more</li>
              {/if}
            </ul>
          </div>
          <button
            onclick={() => { loadWarningsDismissed = true }}
            class="shrink-0 text-amber-700 hover:text-amber-900 cursor-default"
            aria-label="Dismiss warnings"
            data-testid="dismiss-load-warnings"
          >✕</button>
        </div>
      </div>
    {/if}

    <!-- Post-import summary -->
    {#if showImportSummary && importSummary}
      <div
        class="shrink-0 border-b border-emerald-200 bg-emerald-50 px-4 py-2 text-xs text-emerald-900"
        data-testid="import-summary-banner"
      >
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <p class="font-semibold">
              Imported {importSummary.created} node{importSummary.created === 1 ? '' : 's'}
              {#if importSummary.updated > 0}<span class="font-normal text-emerald-800"> · {importSummary.updated} updated</span>{/if}
              {#if importSummary.createdParents > 0}<span class="font-normal text-emerald-800"> · {importSummary.createdParents} parent{importSummary.createdParents === 1 ? '' : 's'} created</span>{/if}
              {#if importSummary.skippedCount > 0}<span class="font-normal text-emerald-800"> · {importSummary.skippedCount} skipped</span>{/if}
              {#if importSummary.warningCount > 0}<span class="font-normal text-amber-700"> · {importSummary.warningCount} warnings</span>{/if}
            </p>
            {#if importSummary.skipped.length > 0}
              <ul class="mt-1 space-y-0.5">
                {#each importSummary.skipped.slice(0, 5) as s (s.row + (s.column ?? ''))}
                  <li class="truncate text-emerald-800">row {s.row}{s.column ? ` · ${s.column}` : ''} — {s.reason}</li>
                {/each}
                {#if importSummary.skippedCount > 5}
                  <li class="text-emerald-700">…and {importSummary.skippedCount - 5} more</li>
                {/if}
              </ul>
            {/if}
          </div>
          <button
            onclick={() => { importSummaryDismissed = true }}
            class="shrink-0 text-emerald-700 hover:text-emerald-900 cursor-default"
            aria-label="Dismiss import summary"
            data-testid="dismiss-import-summary"
          >✕</button>
        </div>
      </div>
    {/if}

    <!-- Three-pane body — tree | drag | detail | drag | snapshots -->
    <div
      class="flex flex-1 overflow-hidden"
      class:cursor-col-resize={draggingHandle !== null}
      class:select-none={draggingHandle !== null}
    >

      <!-- ── Left pane: tree + search ──────────────────────────────────── -->
      <div
        style="width: {treeWidth}px"
        class="shrink-0 flex flex-col bg-stone-50 overflow-hidden"
      >

        <!-- Search bar -->
        <div class="px-3 py-2 border-b border-stone-200">
          <div class="relative">
            <input
              bind:this={searchInputEl}
              type="text"
              value={searchQuery}
              oninput={handleSearchInput}
              onkeydown={handleSearchKeydown}
              placeholder="Search nodes…"
              class="w-full bg-white border border-stone-200 rounded-lg pl-8 pr-8 py-1.5
                     text-sm text-stone-700 placeholder-stone-300 focus:outline-none
                     focus:ring-1 focus:ring-stone-400 selectable"
              data-testid="search-input"
            />
            <svg class="absolute left-2.5 top-2 w-3.5 h-3.5 text-stone-400" fill="none" viewBox="0 0 16 16">
              <circle cx="6.5" cy="6.5" r="4.5" stroke="currentColor" stroke-width="1.5"/>
              <path d="M10.5 10.5l3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
            {#if searchQuery}
              <button
                class="absolute right-2.5 top-1.5 text-stone-400 hover:text-stone-600 text-xs"
                onclick={clearSearch}
                aria-label="Clear search"
              >✕</button>
            {/if}
          </div>
          {#if searchQuery.trim()}
            <div class="mt-2 flex items-center justify-between gap-2">
              <p class="truncate text-xs text-stone-500">
                {#if searching}
                  Searching…
                {:else if searchResults.length === 0}
                  No results for "{searchQuery}"
                {:else}
                  {searchResultIndex + 1}/{searchResults.length} result{searchResults.length === 1 ? '' : 's'} for "{searchQuery}"
                {/if}
              </p>
              {#if searchResults.length > 1}
                <span class="shrink-0 text-[10px] text-stone-400">Enter next · Shift+Enter prev</span>
              {/if}
            </div>
          {/if}
        </div>

        <!-- Tree -->
        <div class="flex-1 flex flex-col overflow-hidden" data-testid="tree">
          {#if searchActive && !searching && searchResults.length === 0}
            <div class="flex-1 p-3 text-sm text-stone-400" data-testid="search-no-results">No matching nodes</div>
          {:else}
            <div class="flex-1 overflow-hidden">
              <ManifestView
                rows={flatRows}
                mode={compareMode ? 'compare' : 'browse'}
                compareContext={compareMode && mergedTree
                  ? {
                      snapshotFrom: mergedTree.fromSnapshot,
                      snapshotTo: mergedTree.toSnapshot,
                      subtreeSummaries: compareSubtreeSummaries ?? undefined,
                    }
                  : undefined}
                expandedFolds={lensExpandedFolds}
                onFoldExpand={(foldId) => {
                  const next = new Set(lensExpandedFolds)
                  if (next.has(foldId)) next.delete(foldId)
                  else next.add(foldId)
                  lensExpandedFolds = next
                }}
                {selectedId}
                selectedScrollAlign={selectedScrollAlign}
                onSelect={handleSelect}
                onToggle={handleToggle}
                onAddChild={handleAddChild}
                onImportHere={handleImportHere}
                onMoveUp={handleMoveUp}
                onMoveDown={handleMoveDown}
                onRenameRequest={handleRenameRequest}
                onDelete={handleDelete}
                onMoveTo={handleMoveTo}
                editingDisabled={editingLocked}
                matchedIds={searchMatchSet}
                matchQuery={searchQuery}
                matchDetails={searchResultMap}
                searchActive={searchActive}
                onSearchShortcutInput={handleSearchShortcutInput}
                onSearchClear={clearSearch}
                onSearchCycle={cycleSearchResult}
              />
            </div>
          {/if}

            <!-- Inline add-child input — rendered below the tree, always visible -->
            {#if addingChildTo}
              <div class="border-t border-stone-200 px-3 py-2 flex flex-col gap-1 bg-stone-50 shrink-0">
                <input
                  type="text"
                  bind:this={addChildInput}
                  bind:value={addingChildName}
                  placeholder="Node name"
                  class="w-full text-sm border border-stone-300 rounded px-2 py-1
                         focus:outline-none focus:ring-1 focus:ring-stone-400 selectable"
                  data-testid="add-child-input"
                  onkeydown={(e) => {
                    if (e.key === 'Enter') commitAddChild()
                    if (e.key === 'Escape') cancelAddChild()
                  }}
                />
                {#if addingChildError}
                  <p class="text-xs text-red-600">{addingChildError}</p>
                {/if}
                {#if addChildTemplateIds.length > 0}
                  <select
                    bind:value={addingChildTemplateId}
                    class="w-full text-sm border border-stone-300 rounded px-2 py-1 bg-white
                           focus:outline-none focus:ring-1 focus:ring-stone-400"
                    data-testid="add-child-template"
                  >
                    <option value={null}>Freeform (no template)</option>
                    {#each addChildTemplateIds as id (id)}
                      <option value={id}>{templateLabel(project?.templates?.[id], id)}</option>
                    {/each}
                  </select>
                {/if}
                <div class="flex gap-1">
                  <button
                    onclick={commitAddChild}
                    class="text-xs bg-stone-800 text-white px-2 py-1 rounded cursor-default"
                    data-testid="add-child-commit"
                  >Add</button>
                  <button
                    onclick={cancelAddChild}
                    class="text-xs text-stone-500 px-2 py-1 rounded hover:bg-stone-100 cursor-default"
                  >Cancel</button>
                </div>
              </div>
            {/if}
        </div>

      </div>

      <!-- ── Drag handle: tree | detail ────────────────────────────────── -->
      <button
        type="button"
        aria-label="Resize tree panel"
        class="w-1 shrink-0 cursor-col-resize bg-stone-200 hover:bg-sky-400
               transition-colors duration-100 p-0"
        class:bg-sky-500={draggingHandle === 'tree'}
        onmousedown={(e) => startDrag('tree', e)}
      ></button>

      <!-- ── Right pane: detail ─────────────────────────────────────────── -->
      <div class="flex-1 overflow-hidden" data-testid="detail-pane">
        {#if detailProject}
        <DetailPane
          node={selectedNode}
          project={detailProject}
          {renameRequestId}
          readOnly={editingLocked}
          readOnlyReason={compareMode && mergedTree
            ? `Viewing ${snapshotRefLabel(mergedTree.fromSnapshot)} -> ${snapshotRefLabel(mergedTree.toSnapshot)}. Snapshots are read-only; exit compare to edit the current project.`
            : snapshotRestoringName
              ? 'Reverting current project — editing will resume when revert finishes.'
              : recoveryApplyingId
                ? 'Applying recovery point — editing will resume when recovery finishes.'
                : undefined}
          onUpdate={handleNodeUpdate}
          onPromoteField={handlePromoteField}
          onError={showToast}
        />
        {/if}
      </div>

      <!-- ── Snapshots panel (docked, non-blocking) ─────────────────────── -->
      {#if snapshotPanelOpen}
        <!-- Drag handle: detail | panel -->
        <button
          type="button"
          aria-label="Resize snapshots panel"
          class="w-1 shrink-0 cursor-col-resize bg-stone-200 hover:bg-sky-400
                 transition-colors duration-100 p-0"
          class:bg-sky-500={draggingHandle === 'panel'}
          onmousedown={(e) => startDrag('panel', e)}
        ></button>

        <!-- Controlled-width wrapper — SnapshotsPanel fills it with w-full -->
        <div style="width: {panelWidth}px" class="shrink-0 overflow-hidden">
          <SnapshotsPanel
            {snapshots}
            timelineEvents={snapshotTimelineEvents}
            recoveryPoints={snapshotRecoveryPoints}
            {mergedTree}
            compareLoaded={compareMode}
            loading={snapshotLoading}
            creating={snapshotCreating}
            comparing={snapshotComparing}
            restoringName={snapshotRestoringName}
            recoveringId={recoveryApplyingId}
            error={snapshotError}
            highlightedNodeId={selectedId}
            onDiffNodeSelect={handleDiffNodeSelect}
            onClose={closeSnapshots}
            onRefresh={refreshSnapshots}
            onCreate={handleSnapshotCreate}
            onCompare={handleSnapshotCompare}
            onExitCompare={exitCompareMode}
            onRestore={handleSnapshotRestore}
            onApplyRecovery={handleApplyRecovery}
            onExportReport={handleExportReport}
            onCopyReport={handleCopyReport}
          />
        </div>
      {/if}

      {#if revertDialogSnapshotName}
        <RevertDialog
          snapshotName={revertDialogSnapshotName}
          noteRequired={revertDialogNoteRequired}
          error={revertDialogError}
          reverting={snapshotRestoringName === revertDialogSnapshotName}
          onConfirm={confirmSnapshotRevert}
          onCancel={cancelSnapshotRevert}
        />
      {/if}

      {#if recoveryDialogPoint}
        <RecoveryDialog
          recoveryPoint={recoveryDialogPoint}
          applying={recoveryApplyingId === recoveryDialogPoint.id}
          error={recoveryDialogError}
          onConfirm={confirmRecoveryPointApply}
          onCancel={cancelRecoveryPointApply}
        />
      {/if}

    </div>
  </div>
{/if}
