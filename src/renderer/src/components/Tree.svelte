<svelte:options runes />

<script lang="ts">
  import { tick } from 'svelte'
  import { get } from 'svelte/store'
  import { createVirtualizer } from '@tanstack/svelte-virtual'
  import type { VisibleRow } from '../lib/tree-rows'
  import TreeRow from './TreeRow.svelte'

  // ─── Props ───────────────────────────────────────────────────────────────────

  interface Props {
    rows: VisibleRow[]
    selectedId: string | null
    onSelect: (id: string) => void
    onToggle: (id: string) => void
    onAddChild: (parentId: string) => void
    onMoveUp: (id: string) => void
    onMoveDown: (id: string) => void
    onRenameRequest: () => void
    onDelete: (id: string) => void
    onMoveTo: (id: string) => void
  }

  let {
    rows,
    selectedId,
    onSelect,
    onToggle,
    onAddChild,
    onMoveUp,
    onMoveDown,
    onRenameRequest,
    onDelete,
    onMoveTo,
  }: Props = $props()

  // ─── Context menu ────────────────────────────────────────────────────────────
  //
  // IMPORTANT: The menu must render here in Tree.svelte, NOT inside TreeRow.svelte.
  // Each virtualizer row is positioned with `transform: translateY(Npx)`. A CSS
  // transform creates a new containing block for `position: fixed`, so any fixed
  // element rendered inside a transformed row is positioned relative to that row,
  // not the viewport. Rendering the menu here avoids that entirely.

  interface ContextMenuState {
    row: VisibleRow
    x: number
    y: number
  }

  let contextMenu = $state<ContextMenuState | null>(null)

  function handleRowContextMenu(row: VisibleRow, x: number, y: number) {
    if (row.kind === 'ghost') return
    // Select the node first so the menu acts on the right item.
    onSelect(row.node.id)
    contextMenu = { row, x, y }
  }

  function closeContextMenu() {
    contextMenu = null
  }

  const menuRow = $derived(contextMenu?.row)
  const menuIsRoot = $derived(menuRow ? menuRow.depth === 0 : false)
  const menuIsFirst = $derived(
    menuRow && menuRow.kind !== 'ghost' ? menuRow.isFirst : false
  )
  const menuIsLast = $derived(
    menuRow && menuRow.kind !== 'ghost' ? menuRow.isLast : false
  )

  // ─── Virtualizer setup ───────────────────────────────────────────────────────

  const ROW_HEIGHT = 32 // px — matches h-8 in TreeRow

  let containerEl = $state<HTMLDivElement | null>(null)
  let virtualizerStore = $state<ReturnType<typeof createVirtualizer<HTMLDivElement, Element>> | null>(null)

  $effect(() => {
    if (!containerEl || virtualizerStore) return
    virtualizerStore = createVirtualizer<HTMLDivElement, Element>({
      count: rows.length,
      getScrollElement: () => containerEl!,
      estimateSize: () => ROW_HEIGHT,
      overscan: 12,
    })
  })

  $effect(() => {
    const count = rows.length
    if (!virtualizerStore) return
    get(virtualizerStore).setOptions({ count, estimateSize: () => ROW_HEIGHT })
  })

  // ─── Keyboard navigation ─────────────────────────────────────────────────────

  let focusedIndex = $state(-1)

  function currentFocusIndex(): number {
    if (focusedIndex >= 0 && focusedIndex < rows.length) return focusedIndex
    if (selectedId) {
      const idx = rows.findIndex(r => r.id === selectedId)
      if (idx >= 0) return idx
    }
    return 0
  }

  async function navigateTo(index: number) {
    if (index < 0 || index >= rows.length) return
    focusedIndex = index
    if (!virtualizerStore) return
    get(virtualizerStore).scrollToIndex(index, { align: 'auto' })
    await tick()
    const row = rows[index]
    if (!row) return
    const el = containerEl?.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(row.id)}"]`)
    el?.focus({ preventScroll: true })
  }

  function handleKeyDown(e: KeyboardEvent) {
    // If a context menu is open, let Escape close it.
    if (contextMenu && e.key === 'Escape') {
      e.preventDefault()
      closeContextMenu()
      return
    }
    const target = e.target as HTMLElement
    if (target.closest('[role="menu"]')) return

    const idx = currentFocusIndex()

    switch (e.key) {
      case 'ArrowDown': {
        e.preventDefault()
        let next = idx + 1
        while (next < rows.length && rows[next].kind === 'ghost') next++
        void navigateTo(next < rows.length ? next : idx)
        break
      }
      case 'ArrowUp': {
        e.preventDefault()
        let prev = idx - 1
        while (prev >= 0 && rows[prev].kind === 'ghost') prev--
        void navigateTo(prev >= 0 ? prev : idx)
        break
      }
      case 'ArrowRight': {
        e.preventDefault()
        const row = rows[idx]
        if (row && row.kind !== 'ghost' && row.hasChildren && !row.expanded) {
          onToggle(row.node.id)
        }
        break
      }
      case 'ArrowLeft': {
        e.preventDefault()
        const row = rows[idx]
        if (row && row.kind !== 'ghost') {
          if (row.expanded && row.hasChildren) {
            onToggle(row.node.id)
          } else if (row.depth > 0) {
            const parentIdx = rows.findLastIndex(
              (r, i) => i < idx && r.depth === row.depth - 1 && r.kind !== 'ghost'
            )
            if (parentIdx >= 0) void navigateTo(parentIdx)
          }
        }
        break
      }
      case 'Enter':
      case ' ': {
        e.preventDefault()
        const row = rows[idx]
        if (row && row.kind !== 'ghost') {
          onSelect(row.node.id)
          focusedIndex = idx
        }
        break
      }
      case 'F2': {
        e.preventDefault()
        const row = rows[idx]
        if (row && row.kind !== 'ghost') {
          onSelect(row.node.id)
          onRenameRequest()
        }
        break
      }
    }
  }

  $effect(() => {
    void rows
    if (focusedIndex >= rows.length) focusedIndex = -1
  })

  // Scroll the selected row into view whenever selectedId or rows changes.
  // align:'auto' is a no-op when the row is already fully visible, so clicking
  // directly in the tree causes no perceptible jump.
  $effect(() => {
    const id = selectedId
    void rows   // reactive dependency — re-runs when ancestors are expanded
    if (!id || !virtualizerStore) return
    const idx = rows.findIndex(r => r.id === id)
    if (idx < 0) return
    get(virtualizerStore).scrollToIndex(idx, { align: 'auto' })
  })
</script>

<!--
  Scrollable tree viewport. role="tree" is declared on the wrapper in App.svelte.
  The context menu is rendered as a sibling to this div (after it in the DOM),
  so it is never inside a CSS-transformed element.
-->
<div
  bind:this={containerEl}
  class="h-full overflow-y-auto overscroll-contain focus:outline-none"
  tabindex="0"
  onkeydown={handleKeyDown}
  data-testid="tree-viewport"
>
  {#if virtualizerStore}
    <div
      class="relative w-full"
      style:height="{$virtualizerStore.getTotalSize()}px"
    >
      {#each $virtualizerStore.getVirtualItems() as item (item.key)}
        {@const row = rows[item.index]}
        {#if row}
          <div
            class="absolute top-0 left-0 right-0"
            style:transform="translateY({item.start}px)"
            style:height="{ROW_HEIGHT}px"
          >
            <TreeRow
              {row}
              selected={selectedId === row.node.id}
              focused={focusedIndex === item.index}
              {onSelect}
              {onToggle}
              onContextMenu={handleRowContextMenu}
            />
          </div>
        {/if}
      {/each}
    </div>
  {/if}
</div>

<!-- ─── Context menu ─────────────────────────────────────────────────────────── -->
<!-- Rendered outside the scrollable/transformed container so position:fixed works. -->
{#if contextMenu && menuRow && menuRow.kind !== 'ghost'}
  <!-- Click-away overlay -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="fixed inset-0 z-40" onclick={closeContextMenu}></div>

  <div
    class="fixed z-50 bg-white border border-stone-200 rounded-lg shadow-lg py-1 min-w-[160px]
           text-sm text-stone-700"
    style:left="{contextMenu.x}px"
    style:top="{contextMenu.y}px"
    role="menu"
  >
    <button
      class="w-full text-left px-3 py-1.5 hover:bg-stone-50 [-webkit-app-region:no-drag]"
      role="menuitem"
      onclick={() => { closeContextMenu(); onRenameRequest() }}
    >Rename</button>

    <button
      class="w-full text-left px-3 py-1.5 hover:bg-stone-50 [-webkit-app-region:no-drag]"
      role="menuitem"
      onclick={() => { const id = menuRow!.node.id; closeContextMenu(); onAddChild(id) }}
    >Add Child</button>

    {#if !menuIsRoot}
      <div class="border-t border-stone-100 my-1"></div>

      <button
        class="w-full text-left px-3 py-1.5 hover:bg-stone-50 disabled:text-stone-300
               [-webkit-app-region:no-drag]"
        role="menuitem"
        disabled={menuIsFirst}
        onclick={() => { const id = menuRow!.node.id; closeContextMenu(); onMoveUp(id) }}
      >Move Up ↑</button>

      <button
        class="w-full text-left px-3 py-1.5 hover:bg-stone-50 disabled:text-stone-300
               [-webkit-app-region:no-drag]"
        role="menuitem"
        disabled={menuIsLast}
        onclick={() => { const id = menuRow!.node.id; closeContextMenu(); onMoveDown(id) }}
      >Move Down ↓</button>

      <button
        class="w-full text-left px-3 py-1.5 hover:bg-stone-50 [-webkit-app-region:no-drag]"
        role="menuitem"
        onclick={() => { const id = menuRow!.node.id; closeContextMenu(); onMoveTo(id) }}
      >Move To…</button>

      <div class="border-t border-stone-100 my-1"></div>

      <button
        class="w-full text-left px-3 py-1.5 hover:bg-red-50 text-red-600
               [-webkit-app-region:no-drag]"
        role="menuitem"
        onclick={() => { const id = menuRow!.node.id; closeContextMenu(); onDelete(id) }}
      >Delete…</button>
    {/if}
  </div>
{/if}
