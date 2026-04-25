<svelte:options runes />

<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte'
  import type { Project, ManifestNode, Snapshot } from '../../shared/types'
  import type { MergedTree } from '../../shared/merged-tree'
  import { buildTree, getSiblingIndex, getAncestorIds } from './lib/tree'
  import { flattenTree } from './lib/tree-rows'
  import Tree from './components/Tree.svelte'
  import DetailPane from './components/DetailPane.svelte'
  import MoveToDialog from './components/MoveToDialog.svelte'
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
  let expandedIds: Set<string>   = $state(new Set())
  let searchQuery: string        = $state('')
  let searchResults              = $state<{ nodeId: string; nodeName: string }[]>([])
  let searching:   boolean       = $state(false)

  // Inline add-child state
  let addingChildTo: string | null = $state(null)
  let addingChildName: string      = $state('')
  let addingChildError: string | null = $state(null)
  let addChildInput: HTMLInputElement | null = $state(null)

  // Rename request signal — bumping this counter triggers DetailPane.startEditName().
  // Tree raises onRenameRequest → App increments → DetailPane $effect picks it up.
  let renameRequestId = $state(0)

  let moveToNodeId: string | null = $state(null)

  // Snapshot/history UI state
  let snapshotPanelOpen: boolean = $state(false)
  let snapshots: Snapshot[] = $state([])
  let snapshotLoading: boolean = $state(false)
  let snapshotCreating: boolean = $state(false)
  let snapshotComparing: boolean = $state(false)
  let snapshotRestoringName: string | null = $state(null)
  let snapshotError: string | null = $state(null)
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
  const brandMark = '/manifest-mark.svg'

  // ─── Derived ──────────────────────────────────────────────────────────────

  const tree = $derived.by(() => {
    if (!project) return null
    return buildTree(project.nodes)
  })

  const flatRows = $derived.by(() => {
    if (compareMode && mergedTree) {
      const mergedTreeBuilt = buildTree(mergedTree.nodes)
      if (!mergedTreeBuilt) return []
      return flattenTree(mergedTreeBuilt, compareExpanded, { compareMode: true })
    }
    if (!tree) return []
    return flattenTree(tree, expandedIds)
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
      return { ...project, nodes: mergedTree.nodes }
    }
    return project
  })

  const projectModeLabel = $derived.by(() => {
    if (compareMode && mergedTree) {
      return `Comparing ${mergedTree.fromSnapshot} -> ${mergedTree.toSnapshot}`
    }
    if (workingCopyBaseSnapshot) {
      return workingCopyDirty ? 'Unsnapshotted changes' : `Current project matches ${workingCopyBaseSnapshot}`
    }
    return workingCopyDirty ? 'Unsnapshotted changes' : 'Current Project'
  })

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  onMount(async () => {
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
    window.removeEventListener('mousemove', onDragMove)
    window.removeEventListener('mouseup', onDragEnd)
  })

  // ─── Helpers ──────────────────────────────────────────────────────────────

  function selectRoot(p: Project) {
    const root = p.nodes.find(n => n.parentId === null)
    if (root) {
      selectedId = root.id
      expandedIds = new Set([root.id])
    }
  }

  function showToast(msg: string) {
    toastMsg = msg
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = setTimeout(() => { toastMsg = null }, 4000)
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
    // If selected node was deleted, fall back to root.
    if (selectedId && !p.nodes.find(n => n.id === selectedId)) {
      const root = p.nodes.find(n => n.parentId === null)
      selectedId = root?.id ?? null
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

  // ─── Welcome actions ──────────────────────────────────────────────────────

  async function openProject() {
    error = null
    const folderPath = await window.api.dialog.openFolder('Open Project')
    if (!folderPath) return

    appState = 'loading'
    const result = await window.api.project.open(folderPath)
    if (result.ok) {
      project = result.data
      selectRoot(result.data)
      workingCopyBaseSnapshot = null
      workingCopyDirty = false
      appState = 'open'
    } else {
      error = result.error.message
      appState = 'welcome'
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
      appState = 'open'
    } else {
      error = result.error.message
    }
  }

  async function closeProject() {
    await window.api.project.close()
    project = null
    selectedId = null
    expandedIds = new Set()
    searchQuery = ''
    searchResults = []
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
  }

  // ─── Tree actions ─────────────────────────────────────────────────────────

  function handleSelect(id: string) {
    selectedId = id
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
    if (compareMode) {
      showToast('Exit compare to edit the current project.')
      return
    }
    addingChildTo = parentId
    addingChildName = ''
    addingChildError = null
    expandedIds = new Set([...expandedIds, parentId])
  }

  async function commitAddChild() {
    if (compareMode) {
      showToast('Exit compare to edit the current project.')
      return
    }
    if (!addingChildTo || !addingChildName.trim()) {
      addingChildError = 'Name is required'
      return
    }
    const result = await window.api.node.create(addingChildTo, addingChildName.trim())
    if (result.ok) {
      applyProject(result.data)
      markWorkingCopyChanged()
      // Select the new node (last child of parent).
      const newNode = result.data.nodes
        .filter(n => n.parentId === addingChildTo)
        .sort((a, b) => b.order - a.order)[0]
      if (newNode) selectedId = newNode.id
      addingChildTo = null
      addingChildName = ''
    } else {
      addingChildError = result.error.message
    }
  }

  function cancelAddChild() {
    addingChildTo = null
    addingChildName = ''
    addingChildError = null
  }

  async function handleMoveUp(id: string) {
    if (!project || compareMode) return
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
    if (!project || compareMode) return
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
    if (compareMode) {
      showToast('Exit compare to edit the current project.')
      return
    }
    moveToNodeId = id
  }

  async function confirmMoveTo(targetParentId: string) {
    if (!moveToNodeId || compareMode) return
    const result = await window.api.node.move(moveToNodeId, targetParentId, 999)
    moveToNodeId = null
    if (result.ok) {
      applyProject(result.data)
      markWorkingCopyChanged()
    }
    else showToast(result.error.message)
  }

  async function handleDelete(id: string) {
    if (!project || compareMode) return
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
    }
    else showToast(result.error.message)
  }

  function handleRenameRequest() {
    if (compareMode) {
      showToast('Exit compare to edit the current project.')
      return
    }
    // Bump the signal counter — DetailPane's $effect will call startEditName().
    renameRequestId += 1
  }

  async function handleNodeUpdate(
    id: string,
    changes: { name?: string; properties?: Record<string, string | number | boolean | null> }
  ) {
    if (compareMode) {
      showToast('Exit compare to edit the current project.')
      return
    }
    const result = await window.api.node.update(id, changes)
    if (result.ok) {
      applyProject(result.data)
      markWorkingCopyChanged()
    }
    else showToast(result.error.message)
  }

  // ─── Search ───────────────────────────────────────────────────────────────

  let searchTimer: ReturnType<typeof setTimeout> | null = null

  function handleSearchInput(e: Event) {
    searchQuery = (e.target as HTMLInputElement).value
    if (searchTimer) clearTimeout(searchTimer)
    if (!searchQuery.trim()) {
      searchResults = []
      searching = false
      return
    }
    searching = true
    searchTimer = setTimeout(async () => {
      const result = await window.api.search.query(searchQuery)
      searching = false
      if (result.ok) searchResults = result.data
    }, 200)
  }

  function handleSearchSelect(nodeId: string) {
    selectedId = nodeId
    searchQuery = ''
    searchResults = []
    // Expand ancestors so the node is visible.
    if (project) {
      const ancestors = getAncestorIds(nodeId, project.nodes)
      expandedIds = new Set([...expandedIds, ...ancestors, nodeId])
    }
  }

  // ─── Snapshots / history ────────────────────────────────────────────────

  async function refreshSnapshots() {
    if (!project) return
    snapshotLoading = true
    snapshotError = null

    const result = await window.api.snapshot.list()
    snapshotLoading = false

    if (result.ok) {
      snapshots = result.data
    } else {
      snapshotError = result.error.message
    }
  }

  async function openSnapshots() {
    snapshotPanelOpen = true
    await refreshSnapshots()
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
    if (project && selectedId && !project.nodes.find(node => node.id === selectedId)) {
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
    } else {
      snapshotError = result.error.message
    }
  }

  /** Called when user clicks a diff row — selects that node in the tree. */
  function handleDiffNodeSelect(nodeId: string) {
    if (compareMode && mergedTree) {
      const compareSelectionId = resolveCompareSelectionId(nodeId)
      selectedId = compareSelectionId
      const ancestors = getAncestorIds(compareSelectionId, mergedTree.nodes)
      compareExpanded = new Set([...compareExpanded, ...ancestors, compareSelectionId])
    } else if (project) {
      selectedId = nodeId
      const ancestors = getAncestorIds(nodeId, project.nodes)
      expandedIds = new Set([...expandedIds, ...ancestors, nodeId])
    }
  }

  async function handleSnapshotRestore(name: string) {
    let note: string | null = null
    const requiresNote = snapshotHasLaterSnapshots(name)

    if (requiresNote) {
      note = window.prompt(
        `Why are you reverting the current project to "${name}"? This note will be saved in the snapshot timeline.`
      )
      if (!note?.trim()) {
        snapshotError = 'A revert note is required because this snapshot has later snapshots in the timeline.'
        return
      }
    }

    const confirmed = window.confirm(`Revert the current project to snapshot "${name}"? The snapshot will not change, and later snapshots will remain in the timeline.`)
    if (!confirmed) return

    snapshotRestoringName = name
    snapshotError = null
    try {
      let result = await window.api.snapshot.revert({ name, note })

      if (!result.ok && result.error.code === 'VALIDATION_FAILED' && result.error.message.includes('revert note is required')) {
        note = window.prompt(
          `Why are you reverting the current project to "${name}"? This note will be saved in the snapshot timeline.`
        )
        if (note?.trim()) {
          result = await window.api.snapshot.revert({ name, note })
        }
      }

      snapshotRestoringName = null

      if (result.ok) {
        await reloadCurrentProject()
        exitCompareMode()
        workingCopyBaseSnapshot = name
        workingCopyDirty = false
        showToast(`Reverted current project to "${name}"`)
      } else {
        snapshotError = result.error.message
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      snapshotRestoringName = null
      snapshotError = `Failed to revert snapshot: ${message}`
    }
  }

  function snapshotHasLaterSnapshots(name: string): boolean {
    const index = snapshots.findIndex(snapshot => snapshot.name === name)
    // Snapshots are listed newest first; any earlier row is a later timeline snapshot.
    return index > 0
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
              text-sm px-4 py-2 rounded-lg shadow-lg max-w-sm text-center">
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
          onclick={() => { appState = 'creating'; error = null }}
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
          onclick={openSnapshots}
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
              type="text"
              value={searchQuery}
              oninput={handleSearchInput}
              placeholder="Search nodes…"
              class="w-full bg-white border border-stone-200 rounded-lg pl-8 pr-3 py-1.5
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
                onclick={() => { searchQuery = ''; searchResults = [] }}
                aria-label="Clear search"
              >✕</button>
            {/if}
          </div>
        </div>

        <!-- Search results overlay -->
        {#if searchQuery.trim()}
          <div class="flex-1 overflow-y-auto p-2" data-testid="search-results">
            {#if searching}
              <p class="text-xs text-stone-400 px-2 py-1">Searching…</p>
            {:else}
              {#each searchResults as r (r.nodeId)}
                <button
                  class="w-full text-left px-2 py-1.5 rounded text-sm text-stone-700
                         hover:bg-stone-100 truncate"
                  onclick={() => handleSearchSelect(r.nodeId)}
                  data-testid="search-result"
                >
                  {r.nodeName}
                </button>
              {/each}
              {#if searchResults.length === 0}
                <p class="text-xs text-stone-400 px-2 py-1" data-testid="search-no-results">No results</p>
              {/if}
            {/if}
          </div>

        <!-- Tree -->
        {:else}
          <div class="flex-1 flex flex-col overflow-hidden" data-testid="tree">
            <!-- Virtualised tree — takes all available space -->
            <div class="flex-1 overflow-hidden">
              <Tree
                rows={flatRows}
                {selectedId}
                onSelect={handleSelect}
                onToggle={handleToggle}
                onAddChild={handleAddChild}
                onMoveUp={handleMoveUp}
                onMoveDown={handleMoveDown}
                onRenameRequest={handleRenameRequest}
                onDelete={handleDelete}
                onMoveTo={handleMoveTo}
                editingDisabled={compareMode}
              />
            </div>

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
        {/if}

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
          readOnly={compareMode}
          readOnlyReason={compareMode && mergedTree
            ? `Viewing ${mergedTree.fromSnapshot} -> ${mergedTree.toSnapshot}. Snapshots are read-only; exit compare to edit the current project.`
            : undefined}
          onUpdate={handleNodeUpdate}
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
            {mergedTree}
            compareLoaded={compareMode}
            loading={snapshotLoading}
            creating={snapshotCreating}
            comparing={snapshotComparing}
            restoringName={snapshotRestoringName}
            error={snapshotError}
            {workingCopyBaseSnapshot}
            {workingCopyDirty}
            highlightedNodeId={selectedId}
            onDiffNodeSelect={handleDiffNodeSelect}
            onClose={closeSnapshots}
            onRefresh={refreshSnapshots}
            onCreate={handleSnapshotCreate}
            onCompare={handleSnapshotCompare}
            onExitCompare={exitCompareMode}
            onRestore={handleSnapshotRestore}
          />
        </div>
      {/if}

    </div>
  </div>
{/if}
