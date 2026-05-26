<svelte:options runes />

<script lang="ts">
  import { onMount, tick } from 'svelte'
  import type { ManifestNode } from '../../../shared/types'
  import { getDescendantIds } from '../lib/tree'

  interface Props {
    nodeId: string
    nodes: ManifestNode[]
    onConfirm: (targetParentId: string) => void
    onCancel: () => void
  }

  let { nodeId, nodes, onConfirm, onCancel }: Props = $props()

  const node = $derived(nodes.find(n => n.id === nodeId))
  const nodeMap = $derived(new Map(nodes.map(n => [n.id, n])))

  // Exclude the node itself and its descendants.
  const excludedIds = $derived(new Set([
    nodeId,
    ...getDescendantIds(nodeId, nodes),
  ]))

  const eligible = $derived(
    nodes
      .filter(n => !excludedIds.has(n.id))
      .sort((a, b) => a.name.localeCompare(b.name))
  )

  let query = $state('')
  let selectedId = $state<string | null>(null)
  let searchInput: HTMLInputElement | null = $state(null)

  const filtered = $derived.by(() => {
    const tokens = tokenize(query)
    if (tokens.length === 0) return eligible

    return eligible.filter((candidate) => {
      const haystack = [
        candidate.name,
        pathFor(candidate),
        Object.entries(candidate.properties)
          .map(([key, value]) => `${key} ${value === null ? 'null' : String(value)}`)
          .join(' '),
      ].join(' ').toLowerCase()

      return tokens.every(token => haystack.includes(token))
    })
  })

  onMount(async () => {
    await tick()
    searchInput?.focus()
  })

  $effect(() => {
    void filtered
    if (selectedId && !filtered.some(n => n.id === selectedId)) {
      selectedId = null
    }
  })

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') onCancel()
    if (e.key === 'Enter') {
      const destinationId = selectedId ?? filtered[0]?.id
      if (destinationId) onConfirm(destinationId)
    }
  }

  function tokenize(value: string): string[] {
    return value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  }

  function pathFor(candidate: ManifestNode): string {
    const parts = [candidate.name]
    let current = candidate
    const seen = new Set([candidate.id])
    while (current.parentId) {
      const parent = nodeMap.get(current.parentId)
      if (!parent || seen.has(parent.id)) break
      parts.unshift(parent.name)
      seen.add(parent.id)
      current = parent
    }
    return parts.join(' / ')
  }
</script>

<!-- Backdrop -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
  onclick={(e) => { if (e.target === e.currentTarget) onCancel() }}
  onkeydown={handleKeyDown}
>
  <div
    class="bg-white rounded-xl shadow-xl w-full max-w-md mx-4 flex flex-col overflow-hidden"
    role="dialog"
    aria-modal="true"
    aria-label="Move node to…"
  >
    <div class="px-5 py-4 border-b border-stone-100">
      <h2 class="text-sm font-semibold text-stone-800">Move "{node?.name}" to…</h2>
      <p class="text-xs text-stone-400 mt-0.5">The node will be added as the last child of the selected parent.</p>
      <input
        bind:this={searchInput}
        bind:value={query}
        type="text"
        placeholder="Search destinations…"
        class="mt-3 w-full rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm
               text-stone-700 placeholder-stone-300 focus:outline-none focus:ring-1
               focus:ring-stone-400 selectable"
        data-testid="move-search-input"
      />
    </div>

    <!-- Node list -->
    <div class="overflow-y-auto max-h-72">
      {#if eligible.length === 0}
        <p class="text-sm text-stone-400 px-5 py-4">No valid destinations.</p>
      {:else if filtered.length === 0}
        <p class="text-sm text-stone-400 px-5 py-4" data-testid="move-no-results">No destinations match "{query}".</p>
      {:else}
        {#each filtered as n (n.id)}
          <button
            class="w-full text-left px-5 py-2 text-sm hover:bg-stone-50 transition-colors
                   {selectedId === n.id ? 'bg-stone-100 text-stone-900 font-medium' : 'text-stone-700'}"
            onclick={() => { selectedId = n.id }}
            data-testid="move-target"
          >
            <span class="block truncate">
              {n.name}
              {#if n.parentId === null}
                <span class="text-xs text-stone-400 ml-1">(root)</span>
              {/if}
            </span>
            {#if n.parentId !== null}
              <span class="block truncate text-xs font-normal text-stone-400">{pathFor(n)}</span>
            {/if}
          </button>
        {/each}
      {/if}
    </div>

    <div class="flex gap-2 px-5 py-3 border-t border-stone-100">
      <button
        onclick={onCancel}
        class="flex-1 bg-white hover:bg-stone-50 text-stone-600 text-sm font-medium
               px-4 py-2 rounded-lg border border-stone-200 transition-colors cursor-default"
      >Cancel</button>
      <button
        onclick={() => { if (selectedId) onConfirm(selectedId) }}
        disabled={!selectedId}
        class="flex-1 bg-stone-800 hover:bg-stone-700 disabled:bg-stone-300
               text-white text-sm font-medium px-4 py-2 rounded-lg
               transition-colors cursor-default disabled:cursor-not-allowed"
        data-testid="move-confirm"
      >Move Here</button>
    </div>
  </div>
</div>
