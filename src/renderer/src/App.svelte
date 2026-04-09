<svelte:options runes />

<script lang="ts">
  import { onMount, tick } from 'svelte'
  import type { Project, ManifestNode } from '../../shared/types'
  import { buildTree, getSiblingIndex, getAncestorIds } from './lib/tree'
  import TreeNode from './components/TreeNode.svelte'
  import DetailPane from './components/DetailPane.svelte'
  import MoveToDialog from './components/MoveToDialog.svelte'

  type AppState = 'welcome' | 'creating' | 'loading' | 'open'

  // ─── State ────────────────────────────────────────────────────────────────

  let state:    AppState       = $state('welcome')
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

  // Inline rename state (double-click on tree — delegates to DetailPane, but
  // we also support F2 on the tree row)
  let moveToNodeId: string | null = $state(null)

  // Non-blocking error toast
  let toastMsg:     string | null = $state(null)
  let toastTimer:   ReturnType<typeof setTimeout> | null = null

  // ─── Derived ──────────────────────────────────────────────────────────────

  const tree = $derived(project ? buildTree(project.nodes) : null)

  const selectedNode = $derived(
    selectedId && project
      ? (project.nodes.find(n => n.id === selectedId) ?? null)
      : null
  )

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  onMount(async () => {
    // Rehydrate if main already has a project open (e.g. macOS activate).
    const result = await window.api.project.getCurrent()
    if (result.ok && result.data) {
      project = result.data
      selectRoot(result.data)
      state = 'open'
    }
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

  // ─── Welcome actions ──────────────────────────────────────────────────────

  async function openProject() {
    error = null
    const folderPath = await window.api.dialog.openFolder('Open Project')
    if (!folderPath) return

    state = 'loading'
    const result = await window.api.project.open(folderPath)
    if (result.ok) {
      project = result.data
      selectRoot(result.data)
      state = 'open'
    } else {
      error = result.error.message
      state = 'welcome'
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
      state = 'open'
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
    state = 'welcome'
    newName = ''
    newPath = ''
    error = null
  }

  // ─── Tree actions ─────────────────────────────────────────────────────────

  function handleSelect(id: string) {
    selectedId = id
    addingChildTo = null
  }

  function handleToggle(id: string) {
    const next = new Set(expandedIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    expandedIds = next
  }

  function handleAddChild(parentId: string) {
    addingChildTo = parentId
    addingChildName = ''
    addingChildError = null
    expandedIds = new Set([...expandedIds, parentId])
  }

  async function commitAddChild() {
    if (!addingChildTo || !addingChildName.trim()) {
      addingChildError = 'Name is required'
      return
    }
    const result = await window.api.node.create(addingChildTo, addingChildName.trim())
    if (result.ok) {
      applyProject(result.data)
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
    if (!project) return
    const idx = getSiblingIndex(id, project.nodes)
    if (idx <= 0) return
    const result = await window.api.node.move(id, project.nodes.find(n => n.id === id)!.parentId!, idx - 1)
    if (result.ok) applyProject(result.data)
    else showToast(result.error.message)
  }

  async function handleMoveDown(id: string) {
    if (!project) return
    const node = project.nodes.find(n => n.id === id)
    if (!node) return
    const siblings = project.nodes.filter(n => n.parentId === node.parentId)
    const idx = getSiblingIndex(id, project.nodes)
    if (idx >= siblings.length - 1) return
    const result = await window.api.node.move(id, node.parentId!, idx + 1)
    if (result.ok) applyProject(result.data)
    else showToast(result.error.message)
  }

  function handleMoveTo(id: string) {
    moveToNodeId = id
  }

  async function confirmMoveTo(targetParentId: string) {
    if (!moveToNodeId) return
    const result = await window.api.node.move(moveToNodeId, targetParentId, 999)
    moveToNodeId = null
    if (result.ok) applyProject(result.data)
    else showToast(result.error.message)
  }

  async function handleDelete(id: string) {
    if (!project) return
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
    if (result.ok) applyProject(result.data)
    else showToast(result.error.message)
  }

  function handleRename(id: string) {
    // Focus the detail pane name field — select the node first.
    selectedId = id
    // The DetailPane handles the actual rename interaction.
    // We dispatch a custom event that DetailPane listens for.
    setTimeout(() => {
      const el = document.querySelector<HTMLElement>('[data-testid="node-name"]')
      el?.click()
    }, 50)
  }

  async function handleNodeUpdate(
    id: string,
    changes: { name?: string; properties?: Record<string, string | number | boolean | null> }
  ) {
    const result = await window.api.node.update(id, changes)
    if (result.ok) applyProject(result.data)
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
{#if state === 'welcome'}
  <div class="flex flex-col h-full items-center justify-center bg-stone-50">
    <div class="flex flex-col items-center gap-8 w-full max-w-sm px-6">

      <div class="text-center">
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
          onclick={() => { state = 'creating'; error = null }}
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
{:else if state === 'creating'}
  <div class="flex flex-col h-full items-center justify-center bg-stone-50">
    <div class="flex flex-col gap-5 w-full max-w-sm px-6">

      <div>
        <h2 class="text-lg font-semibold text-stone-800">New Project</h2>
        <p class="text-sm text-stone-400 mt-0.5">A folder will be created at the chosen location.</p>
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
          onclick={() => { state = 'welcome'; error = null }}
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
{:else if state === 'loading'}
  <div class="flex h-full items-center justify-center bg-stone-50">
    <p class="text-sm text-stone-400">Opening project…</p>
  </div>

<!-- ─── Project open ──────────────────────────────────────────────────────── -->
{:else if state === 'open' && project}
  <div class="flex flex-col h-full bg-white" data-testid="project-view">

    <!-- Titlebar -->
    <div class="flex items-center justify-between px-4 py-2.5 border-b border-stone-200 bg-white
                pl-20 shrink-0 [-webkit-app-region:drag]">
      <div class="flex flex-col [-webkit-app-region:no-drag]">
        <span class="text-sm font-semibold text-stone-800">{project.name}</span>
        <span class="text-xs text-stone-400">{project.nodes.length} nodes</span>
      </div>
      <button
        onclick={closeProject}
        class="text-xs text-stone-400 hover:text-stone-600 transition-colors cursor-default
               px-2 py-1 [-webkit-app-region:no-drag]"
        data-testid="close-project-btn"
      >
        Close
      </button>
    </div>

    <!-- Two-pane body -->
    <div class="flex flex-1 overflow-hidden">

      <!-- ── Left pane: tree + search ──────────────────────────────────── -->
      <div class="w-72 shrink-0 flex flex-col border-r border-stone-200 bg-stone-50 overflow-hidden">

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
        {#if searchQuery && (searchResults.length > 0 || searching)}
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
                <p class="text-xs text-stone-400 px-2 py-1">No results</p>
              {/if}
            {/if}
          </div>

        <!-- Tree -->
        {:else}
          <div class="flex-1 overflow-y-auto p-2" role="tree" aria-label="Project tree" data-testid="tree">
            {#if tree}
              <TreeNode
                node={tree}
                {selectedId}
                {expandedIds}
                onSelect={handleSelect}
                onToggle={handleToggle}
                onAddChild={handleAddChild}
                onMoveUp={handleMoveUp}
                onMoveDown={handleMoveDown}
                onRename={handleRename}
                onDelete={handleDelete}
                onMoveTo={handleMoveTo}
                isFirst={true}
                isLast={true}
                isRoot={true}
              />
            {/if}

            <!-- Inline add-child input -->
            {#if addingChildTo}
              <div class="mt-1 ml-8 flex flex-col gap-1">
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

      <!-- ── Right pane: detail ─────────────────────────────────────────── -->
      <div class="flex-1 overflow-hidden" data-testid="detail-pane">
        <DetailPane
          node={selectedNode}
          {project}
          onUpdate={handleNodeUpdate}
          onError={showToast}
        />
      </div>

    </div>
  </div>
{/if}
