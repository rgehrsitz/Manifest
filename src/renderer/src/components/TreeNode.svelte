<svelte:options runes />

<script lang="ts">
  import type { TreeNode as TreeNodeData } from '../lib/tree'
  import TreeNode from './TreeNode.svelte'

  interface Props {
    node: TreeNodeData
    selectedId: string | null
    expandedIds: Set<string>
    onSelect: (id: string) => void
    onToggle: (id: string) => void
    onAddChild: (parentId: string) => void
    onMoveUp: (id: string) => void
    onMoveDown: (id: string) => void
    onRename: (id: string) => void
    onDelete: (id: string) => void
    onMoveTo: (id: string) => void
    isFirst: boolean
    isLast: boolean
    isRoot: boolean
  }

  let {
    node,
    selectedId,
    expandedIds,
    onSelect,
    onToggle,
    onAddChild,
    onMoveUp,
    onMoveDown,
    onRename,
    onDelete,
    onMoveTo,
    isFirst,
    isLast,
    isRoot,
  }: Props = $props()

  let showMenu = $state(false)
  let menuX = $state(0)
  let menuY = $state(0)

  const isSelected = $derived(selectedId === node.node.id)
  const isExpanded = $derived(expandedIds.has(node.node.id))
  const hasChildren = $derived(node.children.length > 0)

  function handleContextMenu(e: MouseEvent) {
    e.preventDefault()
    menuX = e.clientX
    menuY = e.clientY
    showMenu = true
  }

  function closeMenu() {
    showMenu = false
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') {
      onSelect(node.node.id)
      e.preventDefault()
    }
    if (e.key === 'ArrowRight' && !isExpanded && hasChildren) {
      onToggle(node.node.id)
      e.preventDefault()
    }
    if (e.key === 'ArrowLeft' && isExpanded) {
      onToggle(node.node.id)
      e.preventDefault()
    }
  }
</script>

<!-- Click-away to close context menu -->
{#if showMenu}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="fixed inset-0 z-40" onclick={closeMenu}></div>
{/if}

<div class="select-none">
  <!-- Row -->
  <div
    role="treeitem"
    aria-selected={isSelected}
    aria-expanded={hasChildren ? isExpanded : undefined}
    tabindex="0"
    data-testid="tree-node"
    data-node-id={node.node.id}
    class="flex items-center gap-1 px-2 py-1 rounded cursor-default text-sm
           hover:bg-stone-100 focus:outline-none focus:ring-1 focus:ring-stone-400
           {isSelected ? 'bg-stone-200 text-stone-900' : 'text-stone-700'}"
    style="padding-left: {node.depth * 16 + 8}px"
    onclick={() => onSelect(node.node.id)}
    oncontextmenu={handleContextMenu}
    onkeydown={handleKeyDown}
  >
    <!-- Expand/collapse chevron -->
    <button
      class="w-4 h-4 flex items-center justify-center shrink-0 text-stone-400
             hover:text-stone-600 [-webkit-app-region:no-drag]"
      onclick={(e) => { e.stopPropagation(); if (hasChildren) onToggle(node.node.id) }}
      tabindex="-1"
      aria-label={isExpanded ? 'Collapse' : 'Expand'}
    >
      {#if hasChildren}
        <svg class="w-3 h-3 transition-transform {isExpanded ? 'rotate-90' : ''}" viewBox="0 0 12 12" fill="currentColor">
          <path d="M4 2l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
        </svg>
      {/if}
    </button>

    <!-- Name -->
    <span class="flex-1 truncate">{node.node.name}</span>

    <!-- Child count badge (collapsed only) -->
    {#if hasChildren && !isExpanded}
      <span class="text-xs text-stone-400 tabular-nums">{node.children.length}</span>
    {/if}
  </div>

  <!-- Context menu -->
  {#if showMenu}
    <div
      class="fixed z-50 bg-white border border-stone-200 rounded-lg shadow-lg py-1 min-w-[160px]
             text-sm text-stone-700"
      style="left: {menuX}px; top: {menuY}px"
      role="menu"
    >
      <button
        class="w-full text-left px-3 py-1.5 hover:bg-stone-50 [-webkit-app-region:no-drag]"
        role="menuitem"
        onclick={() => { closeMenu(); onRename(node.node.id) }}
      >Rename</button>

      <button
        class="w-full text-left px-3 py-1.5 hover:bg-stone-50 [-webkit-app-region:no-drag]"
        role="menuitem"
        onclick={() => { closeMenu(); onAddChild(node.node.id) }}
      >Add Child</button>

      {#if !isRoot}
        <div class="border-t border-stone-100 my-1"></div>

        <button
          class="w-full text-left px-3 py-1.5 hover:bg-stone-50 disabled:text-stone-300
                 [-webkit-app-region:no-drag]"
          role="menuitem"
          disabled={isFirst}
          onclick={() => { closeMenu(); onMoveUp(node.node.id) }}
        >Move Up ↑</button>

        <button
          class="w-full text-left px-3 py-1.5 hover:bg-stone-50 disabled:text-stone-300
                 [-webkit-app-region:no-drag]"
          role="menuitem"
          disabled={isLast}
          onclick={() => { closeMenu(); onMoveDown(node.node.id) }}
        >Move Down ↓</button>

        <button
          class="w-full text-left px-3 py-1.5 hover:bg-stone-50 [-webkit-app-region:no-drag]"
          role="menuitem"
          onclick={() => { closeMenu(); onMoveTo(node.node.id) }}
        >Move To…</button>

        <div class="border-t border-stone-100 my-1"></div>

        <button
          class="w-full text-left px-3 py-1.5 hover:bg-red-50 text-red-600
                 [-webkit-app-region:no-drag]"
          role="menuitem"
          onclick={() => { closeMenu(); onDelete(node.node.id) }}
        >Delete…</button>
      {/if}
    </div>
  {/if}

  <!-- Children (recursive) -->
  {#if isExpanded && hasChildren}
    <div role="group">
      {#each node.children as child, i (child.node.id)}
        <TreeNode
          node={child}
          {selectedId}
          {expandedIds}
          {onSelect}
          {onToggle}
          {onAddChild}
          {onMoveUp}
          {onMoveDown}
          {onRename}
          {onDelete}
          {onMoveTo}
          isFirst={i === 0}
          isLast={i === node.children.length - 1}
          isRoot={false}
        />
      {/each}
    </div>
  {/if}
</div>
