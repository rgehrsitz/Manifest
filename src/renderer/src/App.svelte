<svelte:options runes />

<script lang="ts">
  import type { Project } from '../../shared/types'

  type AppState = 'welcome' | 'creating' | 'loading' | 'open'

  let state:   AppState      = $state('welcome')
  let project: Project | null = $state(null)
  let error:   string | null  = $state(null)
  let newName: string         = $state('')
  let newPath: string         = $state('')
  let creating: boolean       = $state(false)

  // ─── Actions ──────────────────────────────────────────────────────────────

  async function openProject() {
    error = null
    const folderPath = await window.api.dialog.openFolder('Open Project')
    if (!folderPath) return

    state = 'loading'
    const result = await window.api.project.open(folderPath)
    if (result.ok) {
      project = result.data
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
      state = 'open'
    } else {
      error = result.error.message
    }
  }

  function closeProject() {
    project = null
    state = 'welcome'
    newName = ''
    newPath = ''
    error = null
  }
</script>

<!-- ─── Drag region — always rendered so the window is draggable in every state ── -->
<!-- h-8 covers the macOS traffic-light zone; pointer-events-none prevents click capture -->
<div class="fixed top-0 left-0 right-0 h-8 [-webkit-app-region:drag] pointer-events-none z-50"></div>

<!-- ─── Welcome ────────────────────────────────────────────────────────────── -->
{#if state === 'welcome'}
  <div class="flex flex-col h-full items-center justify-center bg-stone-50">
    <div class="flex flex-col items-center gap-8 w-full max-w-sm px-6">

      <!-- Wordmark -->
      <div class="text-center">
        <h1 class="text-2xl font-semibold tracking-tight text-stone-800">Manifest</h1>
        <p class="text-sm text-stone-400 mt-1">Structured projects. Named history. Clear changes.</p>
      </div>

      <!-- Error -->
      {#if error}
        <div class="w-full bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      {/if}

      <!-- Actions -->
      <div class="flex flex-col gap-3 w-full">
        <button
          onclick={openProject}
          class="w-full bg-stone-800 hover:bg-stone-700 text-white text-sm font-medium
                 px-4 py-2.5 rounded-lg transition-colors duration-150 cursor-default"
        >
          Open Project
        </button>
        <button
          onclick={() => { state = 'creating'; error = null }}
          class="w-full bg-white hover:bg-stone-50 text-stone-700 text-sm font-medium
                 px-4 py-2.5 rounded-lg border border-stone-200 transition-colors duration-150 cursor-default"
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

      <!-- Name -->
      <div class="flex flex-col gap-1.5">
        <label class="text-xs font-medium text-stone-600 uppercase tracking-wide" for="proj-name">
          Project Name
        </label>
        <input
          id="proj-name"
          type="text"
          bind:value={newName}
          placeholder="My Lab Setup"
          class="w-full bg-white border border-stone-200 rounded-lg px-3 py-2 text-sm
                 text-stone-800 placeholder-stone-300 focus:outline-none focus:ring-2
                 focus:ring-stone-400 focus:border-transparent selectable"
          onkeydown={(e) => e.key === 'Enter' && createProject()}
        />
      </div>

      <!-- Location -->
      <div class="flex flex-col gap-1.5">
        <span class="text-xs font-medium text-stone-600 uppercase tracking-wide">
          Location
        </span>
        <div class="flex gap-2">
          <div class="flex-1 bg-white border border-stone-200 rounded-lg px-3 py-2 text-sm
                      text-stone-500 truncate min-w-0">
            {newPath || 'No folder selected'}
          </div>
          <button
            onclick={selectFolder}
            class="shrink-0 bg-white hover:bg-stone-50 text-stone-600 text-sm
                   px-3 py-2 rounded-lg border border-stone-200 transition-colors cursor-default"
          >
            Choose…
          </button>
        </div>
      </div>

      <!-- Buttons -->
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

<!-- ─── Project open (Phase 1 placeholder) ───────────────────────────────── -->
{:else if state === 'open' && project}
  <div class="flex flex-col h-full bg-stone-50">

    <!-- Titlebar area — [-webkit-app-region:drag] makes the bar draggable;
         interactive children opt out with [-webkit-app-region:no-drag] -->
    <div class="flex items-center justify-between px-4 py-3 border-b border-stone-200 bg-white pl-20
                [-webkit-app-region:drag]">
      <div class="flex flex-col [-webkit-app-region:no-drag]">
        <span class="text-sm font-semibold text-stone-800">{project.name}</span>
        <span class="text-xs text-stone-400">{project.nodes.length} nodes</span>
      </div>
      <button
        onclick={closeProject}
        class="text-xs text-stone-400 hover:text-stone-600 transition-colors cursor-default px-2 py-1
               [-webkit-app-region:no-drag]"
      >
        Close
      </button>
    </div>

    <!-- Body: placeholder for Phase 2 tree editor -->
    <div class="flex flex-1 items-center justify-center">
      <div class="text-center text-stone-400">
        <p class="text-sm font-medium">Project opened successfully</p>
        <p class="text-xs mt-1 text-stone-300">Tree editor coming in Phase 2</p>
        <p class="text-xs mt-3 text-stone-300 font-mono">{project.path}</p>
      </div>
    </div>

  </div>
{/if}
