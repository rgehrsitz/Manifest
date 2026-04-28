<svelte:options runes />

<script lang="ts">
  import type { VisibleRow } from '../lib/tree-rows'

  interface Props {
    row: VisibleRow
    selected: boolean
    focused: boolean
    onSelect: (id: string) => void
    onToggle: (id: string) => void
    /**
     * Called when the user right-clicks this row.
     * The context menu is rendered by Tree.svelte (outside the virtualizer transform)
     * so it doesn't get clipped by the CSS transform containing block.
     */
    onContextMenu: (row: VisibleRow, x: number, y: number) => void
  }

  let {
    row,
    selected,
    focused,
    onSelect,
    onToggle,
    onContextMenu,
  }: Props = $props()

  const isGhost = $derived(row.kind === 'ghost')
  const nodeId = $derived(row.node.id)

  function handleContextMenu(e: MouseEvent) {
    if (isGhost) return
    e.preventDefault()
    onContextMenu(row, e.clientX, e.clientY)
  }

  function handleDblClick(e: MouseEvent) {
    if (isGhost) return
    e.preventDefault()
    if (row.hasChildren) onToggle(nodeId)
  }

  const paddingLeft = $derived(`${row.depth * 16 + 8}px`)

  function getDecorationClass(): string {
    if (row.kind === 'decorated') {
      switch (row.status) {
        case 'added':            return 'bg-emerald-50 text-emerald-900'
        case 'removed':          return 'bg-red-50 text-red-800'
        case 'moved-to':         return 'bg-sky-50 text-sky-900'
        case 'renamed':          return 'bg-amber-50 text-amber-900'
        case 'property-changed': return 'bg-amber-50 text-amber-900'
        case 'order-changed':    return 'bg-stone-50 text-stone-600'
        case 'mixed':            return 'bg-purple-50 text-purple-900'
        default:                 return ''
      }
    }
    return ''
  }
</script>

{#if isGhost}
  <!-- Ghost: read-only, not keyboard-navigable, role="presentation" -->
  <div
    role="presentation"
    class="flex items-center gap-1 h-8 select-none text-sm text-stone-400 opacity-40 italic"
    style:padding-left={paddingLeft}
    data-testid="tree-node"
    data-node-id={nodeId}
    data-row-id={row.id}
    data-row-status={row.status}
  >
    <span class="w-4 h-4 shrink-0"></span>
    <span class="flex-1 truncate line-through decoration-stone-400">{row.node.name}</span>
    <span class="text-[10px] font-semibold uppercase tracking-wide text-stone-400 shrink-0 mr-2">
      {row.status === 'removed' ? 'removed' : 'was here'}
    </span>
  </div>
{:else}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    role="treeitem"
    aria-selected={selected}
    aria-expanded={row.hasChildren ? row.expanded : undefined}
    tabindex="-1"
    class="flex items-center gap-1 h-8 rounded cursor-default text-sm select-none
           hover:bg-stone-100 focus:outline-none focus:ring-1 focus:ring-stone-400
           {selected ? '!bg-stone-200 !text-stone-900' : 'text-stone-700'}
           {focused && !selected ? 'ring-1 ring-stone-300' : ''}
           {getDecorationClass()}"
    style:padding-left={paddingLeft}
    data-testid="tree-node"
    data-node-id={nodeId}
    data-row-id={row.id}
    data-row-status={row.kind === 'decorated' ? row.status : undefined}
    onclick={() => onSelect(nodeId)}
    ondblclick={handleDblClick}
    oncontextmenu={handleContextMenu}
  >
    <!-- Expand/collapse chevron -->
    <button
      class="w-4 h-4 flex items-center justify-center shrink-0 text-stone-400
             hover:text-stone-600 [-webkit-app-region:no-drag]"
      onclick={(e) => { e.stopPropagation(); if (row.hasChildren) onToggle(nodeId) }}
      tabindex="-1"
      aria-label={row.expanded ? 'Collapse' : 'Expand'}
    >
      {#if row.hasChildren}
        <svg
          class="w-3 h-3 transition-transform {row.expanded ? 'rotate-90' : ''}"
          viewBox="0 0 12 12"
        >
          <path
            d="M4 2l4 4-4 4"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
            fill="none"
          />
        </svg>
      {/if}
    </button>

    <!-- Node name -->
    <span class="flex-1 truncate">{row.node.name}</span>

    <!-- Decorated badges (compare mode, PR #2) -->
    {#if row.kind === 'decorated' && row.badges.length > 0}
      <div class="flex items-center gap-1 shrink-0">
        {#each row.badges as badge (badge.kind)}
          <span
            class="rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide
                   {badge.severity === 'High' ? 'bg-amber-100 text-amber-700' :
                    badge.severity === 'Medium' ? 'bg-sky-100 text-sky-700' :
                    'bg-stone-100 text-stone-500'}"
          >
            {badge.label}
          </span>
        {/each}
      </div>
    {/if}

    <!-- Collapsed child count — shown as a plain number, not a button -->
    {#if row.hasChildren && !row.expanded}
      <span class="text-xs text-stone-400 tabular-nums shrink-0 mr-1">
        {row.childCount}
      </span>
    {/if}
  </div>
{/if}
