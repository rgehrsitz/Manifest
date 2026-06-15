<svelte:options runes />

<script lang="ts">
  import { tick } from 'svelte'
  import type { ManifestNode, Project, PropertyType } from '../../../shared/types'
  import type { MergedTreeNode } from '../../../shared/merged-tree'
  import { validateNodeName } from '../../../shared/validation'
  import NodeHistoryView from './NodeHistoryView.svelte'
  import PropertyEditor from './PropertyEditor.svelte'

  interface Props {
    // Accepts a plain ManifestNode (browse mode) or a MergedTreeNode (compare
    // mode, which carries an extra `status` field on ghosts). The union makes
    // the runtime check `'status' in node` narrow cleanly without unknown casts.
    node: ManifestNode | MergedTreeNode | null
    project: Project
    /** Bumped by App.svelte when the user presses F2 or "Rename" in the tree context menu. */
    renameRequestId?: number
    readOnly?: boolean
    readOnlyReason?: string
    onUpdate: (id: string, changes: {
      name?: string
      properties?: Record<string, string | number | boolean | null>
      templateId?: string | null
    }) => Promise<void>
    /** Promote an ad-hoc property to a typed field on the node's template. */
    onPromoteField: (nodeId: string, key: string, type: PropertyType) => Promise<void>
    onError: (msg: string) => void
  }

  let {
    node,
    project,
    renameRequestId = 0,
    readOnly = false,
    readOnlyReason = 'Exit read-only mode to edit the current project.',
    onUpdate,
    onPromoteField,
    onError,
  }: Props = $props()

  // ─── Tab state ─────────────────────────────────────────────────────────────
  // Properties (default) edits the node. History shows its chronology across
  // snapshots. History is read-only; safe to view in compare/revert/recover modes.
  type DetailTab = 'properties' | 'history'
  let activeTab: DetailTab = $state('properties')

  // When the selected node changes, snap back to Properties so the user
  // doesn't accidentally see the History tab for a different node.
  let _prevNodeId: string | null = null
  $effect(() => {
    const nodeId = node?.id ?? null
    if (nodeId !== _prevNodeId) {
      _prevNodeId = nodeId
      activeTab = 'properties'
    }
  })

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
    if (!node || effectiveReadOnly) return
    nameInput = node.name
    nameError = null
    editingName = true
  }

  function cancelEditName() {
    editingName = false
    nameError = null
  }

  async function commitName() {
    if (!node || effectiveReadOnly) return
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

  // ─── Derived ──────────────────────────────────────────────────────────────

  const isRoot = $derived(node?.parentId === null)
  const parentNode = $derived(
    node?.parentId ? project.nodes.find(n => n.id === node!.parentId) : null
  )
  const projectTemplates = $derived(project.templates ?? {})

  // ─── Ghost (tombstone) mode (issue #3) ────────────────────────────────────
  // A ghost selection is a row in compare mode whose underlying node was
  // removed (or is the moved-from origin) in the destination snapshot. The
  // DetailPane renders it read-only with a distinctive banner so the user
  // can inspect what was there without being able to edit it.
  //
  // Ghost id format: `ghost:${originalNodeId}` (see merged-tree.ts). The
  // original id is what NodeHistoryView needs to find the live history,
  // and what the user expects to see in the footer.
  const isGhost = $derived(node?.id?.startsWith('ghost:') ?? false)
  const originalNodeId = $derived(
    isGhost && node ? node.id.slice('ghost:'.length) : node?.id ?? ''
  )
  const ghostStatus = $derived.by<'removed' | 'moved-from' | null>(() => {
    if (!isGhost || !node) return null
    // Narrow via the discriminating `status` field. Ghost nodes are always
    // MergedTreeNodes in practice (issue #3), so `'status' in node` is true.
    // Default to 'removed' if status is missing — defensive but unreachable.
    if ('status' in node) {
      return node.status === 'moved-from' ? 'moved-from' : 'removed'
    }
    return 'removed'
  })
  // Whether ANY edit-affecting code path should treat the node as read-only.
  // Composed of: explicit readOnly prop OR ghost selection.
  const effectiveReadOnly = $derived(readOnly || isGhost)
  // The reason text follows ghostStatus so a moved-from tombstone doesn't
  // claim the node was "removed" — same fix the banner uses.
  const effectiveReadOnlyReason = $derived.by(() => {
    if (ghostStatus === 'moved-from') {
      return 'This node was moved to a different parent in the newer snapshot. You are viewing the origin position, read-only.'
    }
    if (isGhost) {
      return 'This node was removed in the newer snapshot. You are viewing a read-only tombstone.'
    }
    return readOnlyReason
  })

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
</script>

{#if !node}
  <div class="flex h-full items-center justify-center text-stone-400 text-sm">
    Select a node to view details
  </div>
{:else}
  <div class="flex flex-col h-full overflow-hidden">

    <!-- Header / name -->
    <div class="px-5 py-4 border-b border-stone-100">
      {#if isGhost}
        <!--
          Tombstone banner: this node was removed (or is the moved-from origin
          of a moved node) in the destination snapshot. Distinct red tone
          separates it from the generic "you're in read-only mode" banner so
          the user immediately understands this is historical content.
        -->
        <div
          class="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800
                 flex items-start gap-2"
          data-testid="detail-tombstone-banner"
          data-ghost-status={ghostStatus}
        >
          <span aria-hidden="true" class="mt-px">⌫</span>
          <span>
            {#if ghostStatus === 'moved-from'}
              <strong class="font-semibold">Moved away.</strong>
              This is the origin position of a node that was relocated. Read-only.
            {:else}
              <strong class="font-semibold">Removed.</strong>
              This node was deleted in the newer snapshot. Read-only.
            {/if}
          </span>
        </div>
      {:else if readOnly}
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
          class="group flex items-center gap-2 {effectiveReadOnly ? '' : 'cursor-text'}"
          onclick={startEditName}
          data-testid="node-name"
        >
          <h2 class="text-lg font-semibold text-stone-900 truncate
                     {isGhost ? 'line-through decoration-stone-400 text-stone-500' : ''}">
            {node.name}
          </h2>
          {#if !effectiveReadOnly}
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
      {:else if isGhost && node.parentId}
        <!--
          Parent was also removed (parentId points to ghost:... so it's not
          in project.nodes). Avoid showing "Root node" — that would be wrong.
        -->
        <p class="text-xs text-stone-400 mt-0.5 italic">under a removed parent</p>
      {:else}
        <p class="text-xs text-stone-400 mt-0.5">Root node</p>
      {/if}
    </div>

    <!-- Tab strip -->
    <div class="flex shrink-0 border-b border-stone-100 px-5">
      <button
        type="button"
        onclick={() => activeTab = 'properties'}
        class={`px-3 py-2 text-xs font-medium border-b-2 -mb-px cursor-default
                ${activeTab === 'properties'
                  ? 'border-stone-700 text-stone-800'
                  : 'border-transparent text-stone-400 hover:text-stone-600'}`}
        data-testid="detail-tab-properties"
      >
        Properties
      </button>
      <button
        type="button"
        onclick={() => activeTab = 'history'}
        class={`px-3 py-2 text-xs font-medium border-b-2 -mb-px cursor-default
                ${activeTab === 'history'
                  ? 'border-stone-700 text-stone-800'
                  : 'border-transparent text-stone-400 hover:text-stone-600'}`}
        data-testid="detail-tab-history"
      >
        History
      </button>
    </div>

    {#if activeTab === 'history'}
      <div class="flex-1 overflow-y-auto px-5 py-4" data-testid="detail-history-pane">
        <!--
          For ghosts, strip the `ghost:` prefix so the history lookup finds
          the live (pre-removal) history of the original node. The history
          itself is read-only by design, so no extra gating is needed here.
        -->
        <NodeHistoryView nodeId={originalNodeId} nodeName={node.name} />
      </div>
    {:else}
    <!-- Properties -->
    <div class="flex-1 overflow-y-auto px-5 py-4">
      <div class="flex items-center justify-between mb-3">
        <h3 class="text-xs font-semibold text-stone-500 uppercase tracking-wide">Properties</h3>
      </div>

      <PropertyEditor
        {node}
        templates={projectTemplates}
        readOnly={effectiveReadOnly}
        {onUpdate}
        onPromoteField={(key, type) => onPromoteField(node!.id, key, type)}
        {onError}
      />
    </div>
    {/if}

    <!-- Metadata footer -->
    <div class="px-5 py-3 border-t border-stone-100 text-xs text-stone-400 space-y-0.5">
      <p>Created {new Date(node.created).toLocaleString()}</p>
      <p>Modified {new Date(node.modified).toLocaleString()}</p>
      <p class="font-mono text-stone-300">{originalNodeId}</p>
    </div>

  </div>
{/if}
