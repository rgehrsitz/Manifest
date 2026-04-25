<svelte:options runes />

<script lang="ts">
  import { tick } from 'svelte'
  import type { ManifestNode, Project } from '../../../shared/types'
  import { validateNodeName, validatePropertyKey, validatePropertyValue } from '../../../shared/validation'

  interface Props {
    node: ManifestNode | null
    project: Project
    /** Bumped by App.svelte when the user presses F2 or "Rename" in the tree context menu. */
    renameRequestId?: number
    readOnly?: boolean
    readOnlyReason?: string
    onUpdate: (id: string, changes: {
      name?: string
      properties?: Record<string, string | number | boolean | null>
    }) => Promise<void>
    onError: (msg: string) => void
  }

  let {
    node,
    project,
    renameRequestId = 0,
    readOnly = false,
    readOnlyReason = 'Exit read-only mode to edit the current project.',
    onUpdate,
    onError,
  }: Props = $props()

  // When renameRequestId increments, start editing the name.
  // Skip the initial value (0) so we don't auto-edit on mount.
  let _prevRenameRequestId = 0
  $effect(() => {
    if (renameRequestId > 0 && renameRequestId !== _prevRenameRequestId) {
      _prevRenameRequestId = renameRequestId
      startEditName()
    }
  })

  // ─── Name editing ─────────────────────────────────────────────────────────

  let editingName = $state(false)
  let nameInput = $state('')
  let nameError = $state<string | null>(null)
  let nameInputEl = $state<HTMLInputElement | null>(null)

  function startEditName() {
    if (!node || readOnly) return
    nameInput = node.name
    nameError = null
    editingName = true
  }

  function cancelEditName() {
    editingName = false
    nameError = null
  }

  async function commitName() {
    if (!node || readOnly) return
    const trimmed = nameInput.trim()
    if (trimmed === node.name) { editingName = false; return }

    const validation = validateNodeName(trimmed)
    if (!validation.valid) {
      nameError = validation.message ?? 'Invalid name'
      return
    }

    // Check sibling collision client-side for immediate feedback.
    const siblings = project.nodes.filter(
      n => n.parentId === node!.parentId && n.id !== node!.id
    )
    if (siblings.some(s => s.name.toLowerCase() === trimmed.toLowerCase())) {
      nameError = `"${trimmed}" already exists under this parent`
      return
    }

    editingName = false
    nameError = null
    await onUpdate(node.id, { name: trimmed })
  }

  function handleNameKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter') commitName()
    if (e.key === 'Escape') cancelEditName()
  }

  // ─── Properties ───────────────────────────────────────────────────────────

  let newKey = $state('')
  let newValue = $state('')
  let newKeyError = $state<string | null>(null)
  let newValueError = $state<string | null>(null)

  async function addProperty() {
    if (!node || readOnly) {
      onError(readOnlyReason)
      return
    }
    const k = newKey.trim()
    const v = newValue.trim()
    if (!k) { newKeyError = 'Key is required'; return }

    const keyVal = validatePropertyKey(k)
    if (!keyVal.valid) { newKeyError = keyVal.message ?? 'Invalid key'; return }

    if (k in (node.properties ?? {})) { newKeyError = 'Key already exists'; return }

    const valVal = validatePropertyValue(v)
    if (!valVal.valid) { newValueError = valVal.message ?? 'Invalid value'; return }

    newKeyError = null
    newValueError = null
    newKey = ''
    newValue = ''
    await onUpdate(node.id, {
      properties: { ...(node.properties ?? {}), [k]: v },
    })
  }

  async function deleteProperty(key: string) {
    if (!node || readOnly) return
    const props = { ...(node.properties ?? {}) }
    delete props[key]
    await onUpdate(node.id, { properties: props })
  }

  let editingPropKey = $state<string | null>(null)
  let editingPropValue = $state('')
  let editingPropError = $state<string | null>(null)
  let propValueInputEl = $state<HTMLInputElement | null>(null)

  function startEditProp(key: string) {
    if (readOnly) return
    editingPropKey = key
    editingPropValue = String(node?.properties?.[key] ?? '')
    editingPropError = null
  }

  async function commitProp(key: string) {
    if (!node || readOnly) return
    const v = editingPropValue.trim()
    const valVal = validatePropertyValue(v)
    if (!valVal.valid) { editingPropError = valVal.message ?? 'Invalid value'; return }

    editingPropKey = null
    editingPropError = null
    await onUpdate(node.id, {
      properties: { ...(node.properties ?? {}), [key]: v },
    })
  }

  function handlePropKeyDown(e: KeyboardEvent, key: string) {
    if (e.key === 'Enter') commitProp(key)
    if (e.key === 'Escape') { editingPropKey = null; editingPropError = null }
  }

  // ─── Derived ──────────────────────────────────────────────────────────────

  const isRoot = $derived(node?.parentId === null)
  const parentNode = $derived(
    node?.parentId ? project.nodes.find(n => n.id === node!.parentId) : null
  )
  const propEntries = $derived(Object.entries(node?.properties ?? {}))

  async function focusInput(el: HTMLInputElement | null) {
    await tick()
    el?.focus()
    el?.select()
  }

  $effect(() => {
    if (editingName) {
      void focusInput(nameInputEl)
    }
  })

  $effect(() => {
    if (editingPropKey !== null) {
      void focusInput(propValueInputEl)
    }
  })
</script>

{#if !node}
  <div class="flex h-full items-center justify-center text-stone-400 text-sm">
    Select a node to view details
  </div>
{:else}
  <div class="flex flex-col h-full overflow-hidden">

    <!-- Header / name -->
    <div class="px-5 py-4 border-b border-stone-100">
      {#if readOnly}
        <div
          class="mb-3 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-800"
          data-testid="detail-readonly-banner"
        >
          {readOnlyReason}
        </div>
      {/if}

      {#if editingName}
        <div class="flex flex-col gap-1">
          <input
            type="text"
            bind:this={nameInputEl}
            bind:value={nameInput}
            onkeydown={handleNameKeyDown}
            onblur={commitName}
            class="text-lg font-semibold text-stone-900 bg-white border border-stone-300
                   rounded px-2 py-0.5 focus:outline-none focus:ring-2 focus:ring-stone-400
                   selectable w-full"
            data-testid="name-input"
          />
          {#if nameError}
            <p class="text-xs text-red-600">{nameError}</p>
          {/if}
          <p class="text-xs text-stone-400">Enter to save · Esc to cancel</p>
        </div>
      {:else}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="group flex items-center gap-2 {readOnly ? '' : 'cursor-text'}"
          onclick={startEditName}
          data-testid="node-name"
        >
          <h2 class="text-lg font-semibold text-stone-900 truncate">{node.name}</h2>
          {#if !readOnly}
            <span class="text-xs text-stone-300 group-hover:text-stone-400 shrink-0">Edit</span>
          {/if}
        </div>
      {/if}

      <!-- Breadcrumb -->
      {#if parentNode}
        <p class="text-xs text-stone-400 mt-0.5 truncate">
          under {parentNode.name}
          {#if isRoot}<span class="ml-1 text-stone-300">(root)</span>{/if}
        </p>
      {:else}
        <p class="text-xs text-stone-400 mt-0.5">Root node</p>
      {/if}
    </div>

    <!-- Properties -->
    <div class="flex-1 overflow-y-auto px-5 py-4">
      <div class="flex items-center justify-between mb-3">
        <h3 class="text-xs font-semibold text-stone-500 uppercase tracking-wide">Properties</h3>
      </div>

      <!-- Existing properties -->
      {#if propEntries.length > 0}
        <div class="space-y-1 mb-4">
          {#each propEntries as [key, value] (key)}
            <div class="flex items-center gap-2 group">
              <span class="text-xs font-mono text-stone-500 w-32 shrink-0 truncate">{key}</span>

              {#if editingPropKey === key}
                <input
                  type="text"
                  bind:this={propValueInputEl}
                  bind:value={editingPropValue}
                  onkeydown={(e) => handlePropKeyDown(e, key)}
                  onblur={() => commitProp(key)}
                  class="flex-1 text-sm text-stone-700 border border-stone-300 rounded
                         px-2 py-0.5 focus:outline-none focus:ring-1 focus:ring-stone-400
                         selectable"
                  data-testid="prop-value-input"
                />
              {:else}
                <!-- svelte-ignore a11y_click_events_have_key_events -->
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <span
                  class="flex-1 text-sm text-stone-700 truncate cursor-text
                         hover:text-stone-900"
                  onclick={() => startEditProp(key)}
                  data-testid="prop-value"
                >
                  {String(value)}
                </span>
              {/if}

              <button
                class="text-stone-300 hover:text-red-400 opacity-0 group-hover:opacity-100
                       transition-opacity text-xs shrink-0 disabled:opacity-0"
                onclick={() => deleteProperty(key)}
                disabled={readOnly}
                aria-label="Delete property {key}"
                data-testid="delete-prop"
              >✕</button>
            </div>
            {#if editingPropKey === key && editingPropError}
              <p class="text-xs text-red-600 ml-34">{editingPropError}</p>
            {/if}
          {/each}
        </div>
      {:else}
        <p class="text-xs text-stone-400 mb-4">No properties yet</p>
      {/if}

      <!-- Add property form -->
      {#if !readOnly}
      <div class="border-t border-stone-100 pt-3">
        <p class="text-xs font-semibold text-stone-400 uppercase tracking-wide mb-2">
          Add Property
        </p>
        <div class="flex gap-2">
          <div class="flex flex-col gap-1 flex-1">
            <input
              type="text"
              bind:value={newKey}
              placeholder="key"
              class="text-sm border border-stone-200 rounded px-2 py-1.5 focus:outline-none
                     focus:ring-1 focus:ring-stone-400 selectable"
              data-testid="new-prop-key"
              onkeydown={(e) => { if (e.key === 'Enter') addProperty() }}
            />
            {#if newKeyError}
              <p class="text-xs text-red-600">{newKeyError}</p>
            {/if}
          </div>
          <div class="flex flex-col gap-1 flex-1">
            <input
              type="text"
              bind:value={newValue}
              placeholder="value"
              class="text-sm border border-stone-200 rounded px-2 py-1.5 focus:outline-none
                     focus:ring-1 focus:ring-stone-400 selectable"
              data-testid="new-prop-value"
              onkeydown={(e) => { if (e.key === 'Enter') addProperty() }}
            />
            {#if newValueError}
              <p class="text-xs text-red-600">{newValueError}</p>
            {/if}
          </div>
          <button
            onclick={addProperty}
            disabled={!newKey.trim()}
            class="shrink-0 bg-stone-800 hover:bg-stone-700 disabled:bg-stone-300
                   text-white text-sm px-3 py-1.5 rounded transition-colors
                   cursor-default disabled:cursor-not-allowed self-start"
            data-testid="add-prop-btn"
          >Add</button>
        </div>
      </div>
      {/if}
    </div>

    <!-- Metadata footer -->
    <div class="px-5 py-3 border-t border-stone-100 text-xs text-stone-400 space-y-0.5">
      <p>Created {new Date(node.created).toLocaleString()}</p>
      <p>Modified {new Date(node.modified).toLocaleString()}</p>
      <p class="font-mono text-stone-300">{node.id}</p>
    </div>

  </div>
{/if}
