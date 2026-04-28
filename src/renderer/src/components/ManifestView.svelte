<svelte:options runes />

<script lang="ts">
  import { tick, onDestroy, untrack } from 'svelte'
  import { get } from 'svelte/store'
  import { createVirtualizer } from '@tanstack/svelte-virtual'
  import type { VisibleRow } from '../lib/tree-rows'
  import {
    computeBrowseSections,
    computeCompareSections,
    type CompareSectionContext,
    type LensSection,
  } from '../lib/density-layer'
  import {
    mergeDisplay,
    sizeAtTime,
    prefersReducedMotion,
    DEFAULT_TIMINGS,
    type DisplayedItem,
  } from '../lib/lens-animation'
  import FoldMarker from './FoldMarker.svelte'
  import TreeRow from './TreeRow.svelte'

  type Mode = 'browse' | 'compare'

  interface Props {
    rows: VisibleRow[]
    mode: Mode
    /** Required when mode === 'compare'. Ignored otherwise. */
    compareContext?: CompareSectionContext
    /** foldIds the user has manually expanded — those sections render full. */
    expandedFolds?: Set<string>
    onFoldExpand?: (foldId: string) => void
    selectedId?: string | null
    onSelect?: (id: string) => void
    onToggle?: (id: string) => void
    onAddChild?: (parentId: string) => void
    onMoveUp?: (id: string) => void
    onMoveDown?: (id: string) => void
    onRenameRequest?: () => void
    onDelete?: (id: string) => void
    onMoveTo?: (id: string) => void
    editingDisabled?: boolean
  }

  let {
    rows,
    mode,
    compareContext,
    expandedFolds = new Set<string>(),
    onFoldExpand,
    selectedId = null,
    onSelect,
    onToggle,
    onAddChild,
    onMoveUp,
    onMoveDown,
    onRenameRequest,
    onDelete,
    onMoveTo,
    editingDisabled = false,
  }: Props = $props()

  const ROW_HEIGHT = 32
  const MARKER_HEIGHT = 36

  // ─── DensityLayer ────────────────────────────────────────────────────────────
  // Pure derivation: rows + mode → sections. User-expanded summarized sections
  // are demoted to 'full' here so the renderer just walks sections uniformly.

  const sections = $derived.by((): LensSection[] => {
    const raw = mode === 'compare'
      ? computeCompareSections(rows, compareContext ?? { snapshotFrom: '', snapshotTo: '' })
      : computeBrowseSections(rows)

    return raw.map(s =>
      s.density === 'summarized' && s.foldId && expandedFolds.has(s.foldId)
        ? { ...s, density: 'full' as const, foldId: undefined, changeBreakdown: undefined }
        : s
    )
  })

  // True when we're comparing two snapshots and they are byte-identical at
  // the node-graph level — every row is an unchanged live node. In that case
  // a single giant fold marker would just say "303 unchanged items folded"
  // and tell the user nothing useful. Empty-state copy reads better.
  const isCompareEmpty = $derived(
    mode === 'compare' &&
    rows.length > 0 &&
    rows.every(r => r.kind === 'normal')
  )

  // ─── Render items ────────────────────────────────────────────────────────────
  // Flatten sections into one entry per visible cell — either a row (full
  // section, one per VisibleRow) or a marker (summarized section, one per fold).

  type RenderItem =
    | { kind: 'row'; row: VisibleRow; rowIndex: number }
    | { kind: 'fold'; section: LensSection }

  const renderItems = $derived.by((): RenderItem[] => {
    const items: RenderItem[] = []
    for (const section of sections) {
      if (section.density === 'summarized') {
        items.push({ kind: 'fold', section })
      } else if (section.density === 'full') {
        for (let i = section.startIndex; i <= section.endIndex; i++) {
          items.push({ kind: 'row', row: rows[i], rowIndex: i })
        }
      }
      // 'hidden' sections emit no render items.
    }
    return items
  })

  // Stable identity for each render item — drives Svelte keyed {#each} so
  // FoldMarkers with stable foldIds animate in place across re-renders.
  function keyFor(item: RenderItem): string {
    return item.kind === 'fold' ? `fold:${item.section.foldId}` : `row:${item.row.id}`
  }

  function fullSizeOf(item: RenderItem): number {
    return item.kind === 'fold' ? MARKER_HEIGHT : ROW_HEIGHT
  }

  // ─── Animation state ─────────────────────────────────────────────────────────
  // displayedItems is what the template renders. When `renderItems` changes
  // (mode flip, fold toggle, fold split/merge), we don't snap — we compute a
  // merged display containing both outgoing and incoming items, drive an rAF
  // loop, and let `sizeAtDisplay` interpolate heights from the merge.
  // After the budget elapses we collapse to the destination's stable items.

  const ANIM = DEFAULT_TIMINGS

  let displayedItems = $state<DisplayedItem<RenderItem>[]>([])
  let transitionStartMs = $state<number | null>(null)
  let transitioningCount = $state(0)
  // Bumped on each rAF frame to invalidate any reactive read of size; the
  // virtualizer itself is the source of truth via setOptions+measure.
  let animTick = $state(0)
  let rafId: number | null = null
  let isInitial = true
  const reducedMotion = prefersReducedMotion()

  function settleTo(target: RenderItem[]) {
    displayedItems = target.map(payload => ({
      key: keyFor(payload),
      payload,
      phase: 'stable' as const,
      staggerIndex: 0,
    }))
    transitionStartMs = null
    transitioningCount = 0
  }

  function sizeAtDisplay(index: number): number {
    const item = displayedItems[index]
    if (!item) return ROW_HEIGHT
    const full = fullSizeOf(item.payload)
    if (transitionStartMs === null) return full
    const elapsed = performance.now() - transitionStartMs
    return sizeAtTime(item, full, elapsed, transitioningCount, ANIM)
  }

  function pushSizes() {
    if (!virtualizerStore) return
    const v = get(virtualizerStore)
    v.setOptions({ ...v.options, count: displayedItems.length, estimateSize: sizeAtDisplay })
    v.measure()
  }

  function startRAF() {
    if (rafId !== null) cancelAnimationFrame(rafId)
    const step = () => {
      if (transitionStartMs === null) {
        rafId = null
        return
      }
      const elapsed = performance.now() - transitionStartMs
      animTick++
      if (elapsed >= ANIM.totalDurationMs) {
        settleTo(renderItems)
        pushSizes()
        rafId = null
        return
      }
      pushSizes()
      rafId = requestAnimationFrame(step)
    }
    rafId = requestAnimationFrame(step)
  }

  onDestroy(() => {
    if (rafId !== null) cancelAnimationFrame(rafId)
  })

  // ─── Virtualizer ─────────────────────────────────────────────────────────────

  let containerEl = $state<HTMLDivElement | null>(null)
  let virtualizerStore = $state<ReturnType<typeof createVirtualizer<HTMLDivElement, Element>> | null>(null)

  $effect(() => {
    if (!containerEl || virtualizerStore) return
    virtualizerStore = createVirtualizer<HTMLDivElement, Element>({
      count: displayedItems.length,
      getScrollElement: () => containerEl!,
      estimateSize: sizeAtDisplay,
      overscan: 8,
    })
  })

  // ─── Anchor preservation ─────────────────────────────────────────────────────
  // Snapshot the topmost visible item BEFORE the displayedItems change, then
  // restore its screen position AFTER the new items are in place. Keyed by
  // item KEY so a row that survives the change stays pinned even though its
  // numeric index may have shifted.

  let anchorKey: string | null = null
  let anchorOffset = 0
  let prevDisplayedItems: DisplayedItem<RenderItem>[] = []

  // ─── React to renderItems change ─────────────────────────────────────────────
  // Drives both anchor preservation and animation start. We read the
  // CURRENT displayedItems for the merge so an in-flight transition is
  // restarted from where it visually was, not from the previous settled state.

  $effect.pre(() => {
    void renderItems
    untrack(() => {
      if (!virtualizerStore || !containerEl) return
      const scrollTop = containerEl.scrollTop
      const visible = get(virtualizerStore).getVirtualItems()
      anchorKey = null
      for (const v of visible) {
        if (v.end > scrollTop) {
          const item = displayedItems[v.index]
          if (item) {
            anchorKey = item.key
            anchorOffset = scrollTop - v.start
          }
          break
        }
      }
      prevDisplayedItems = displayedItems
    })
  })

  $effect(() => {
    void renderItems

    untrack(() => {
      if (!virtualizerStore) return

      if (isInitial) {
        isInitial = false
        settleTo(renderItems)
        pushSizes()
        return
      }

      // Compute merged display from the currently-displayed STABLE+ENTERING
      // items (drop exiting — they should not appear again) to the new
      // target. We `untrack` everything inside this effect so reading
      // displayedItems doesn't make this effect depend on its own writes.
      const prevPayloads = displayedItems
        .filter(d => d.phase !== 'exiting')
        .map(d => d.payload)
      const merged = mergeDisplay(prevPayloads, renderItems, x => keyFor(x))

      if (reducedMotion || merged.transitioningCount === 0) {
        settleTo(renderItems)
      } else {
        displayedItems = merged.items
        transitioningCount = merged.transitioningCount
        transitionStartMs = performance.now()
        startRAF()
      }
      pushSizes()

      if (anchorKey !== null && containerEl) {
        const newIndex = displayedItems.findIndex(item => item.key === anchorKey)
        if (newIndex >= 0) {
          const offset = computeOffsetForIndex(newIndex)
          containerEl.scrollTop = offset + anchorOffset
        }
        anchorKey = null
      }
    })
  })

  function computeOffsetForIndex(index: number): number {
    let offset = 0
    for (let i = 0; i < index; i++) offset += sizeAtDisplay(i)
    return offset
  }

  // ─── Context menu ────────────────────────────────────────────────────────────
  // The menu must render OUTSIDE the virtualizer transform: a CSS transform
  // creates a new containing block for position:fixed, so any fixed element
  // rendered inside a transformed row is positioned relative to that row, not
  // the viewport. Hence the menu lives at the component root, not in TreeRow.

  interface ContextMenuState {
    row: VisibleRow
    x: number
    y: number
  }

  let contextMenu = $state<ContextMenuState | null>(null)

  function handleRowContextMenu(row: VisibleRow, x: number, y: number) {
    if (editingDisabled) return
    if (row.kind === 'ghost') return
    onSelect?.(row.node.id)
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

  // ─── Selection auto-scroll ───────────────────────────────────────────────────
  // When selectedId changes (or the row stream changes around it), scroll the
  // matching render item into view. If the selected node lives inside a folded
  // section, scroll the fold marker into view instead — the user's selection
  // is preserved logically and they can see where it lives.

  $effect(() => {
    const id = selectedId
    void displayedItems
    if (!id || !virtualizerStore) return
    const idx = findDisplayedIndexForNode(id)
    if (idx < 0) return
    get(virtualizerStore).scrollToIndex(idx, { align: 'auto' })
  })

  function findDisplayedIndexForNode(nodeId: string): number {
    for (let i = 0; i < displayedItems.length; i++) {
      const item = displayedItems[i]
      if (item.payload.kind === 'row' && item.payload.row.node.id === nodeId) return i
      if (item.payload.kind === 'fold') {
        const section = item.payload.section
        for (let j = section.startIndex; j <= section.endIndex; j++) {
          if (rows[j]?.node.id === nodeId) return i
        }
      }
    }
    return -1
  }

  // ─── Keyboard navigation ─────────────────────────────────────────────────────
  // Nav stream is renderItems (rows + folds). Per design doc a11y contract,
  // ArrowDown on a FoldMarker moves PAST the fold (to the next render item),
  // not into it; Enter/Space activates the fold (calls onFoldExpand).

  let focusedIndex = $state(-1)

  // Keyboard nav iterates `displayedItems`. Exiting items are skipped — they
  // are visually present mid-transition but conceptually leaving; navigating
  // into one would be confusing.
  function isNavigable(index: number): boolean {
    const item = displayedItems[index]
    if (!item) return false
    if (item.phase === 'exiting') return false
    if (item.payload.kind === 'fold') return true
    return item.payload.row.kind !== 'ghost'
  }

  function currentFocusIndex(): number {
    if (focusedIndex >= 0 && focusedIndex < displayedItems.length) return focusedIndex
    if (selectedId) {
      const idx = findDisplayedIndexForNode(selectedId)
      if (idx >= 0 && isNavigable(idx)) return idx
    }
    for (let i = 0; i < displayedItems.length; i++) if (isNavigable(i)) return i
    return 0
  }

  async function navigateTo(index: number) {
    if (index < 0 || index >= displayedItems.length) return
    focusedIndex = index
    if (!virtualizerStore) return
    get(virtualizerStore).scrollToIndex(index, { align: 'auto' })
    await tick()
    const item = displayedItems[index]
    if (!item || !containerEl) return
    if (item.payload.kind === 'row') {
      const el = containerEl.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(item.payload.row.id)}"]`)
      el?.focus({ preventScroll: true })
    } else {
      const foldId = item.payload.section.foldId ?? ''
      const el = containerEl.querySelector<HTMLElement>(`[data-fold-id="${CSS.escape(foldId)}"]`)
      el?.focus({ preventScroll: true })
    }
  }

  function findParentDisplayedIndex(idx: number, depth: number): number {
    for (let i = idx - 1; i >= 0; i--) {
      const item = displayedItems[i]
      if (
        item.phase !== 'exiting' &&
        item.payload.kind === 'row' &&
        item.payload.row.kind !== 'ghost' &&
        item.payload.row.depth === depth - 1
      ) {
        return i
      }
    }
    return -1
  }

  function handleKeyDown(e: KeyboardEvent) {
    // Esc closes the context menu first.
    if (contextMenu && e.key === 'Escape') {
      e.preventDefault()
      closeContextMenu()
      return
    }
    // Ignore keystrokes that originated inside the context menu itself.
    const target = e.target as HTMLElement
    if (target.closest('[role="menu"]')) return

    const idx = currentFocusIndex()

    switch (e.key) {
      case 'ArrowDown': {
        e.preventDefault()
        let next = idx + 1
        while (next < displayedItems.length && !isNavigable(next)) next++
        void navigateTo(next < displayedItems.length ? next : idx)
        break
      }
      case 'ArrowUp': {
        e.preventDefault()
        let prev = idx - 1
        while (prev >= 0 && !isNavigable(prev)) prev--
        void navigateTo(prev >= 0 ? prev : idx)
        break
      }
      case 'ArrowRight': {
        e.preventDefault()
        const item = displayedItems[idx]?.payload
        if (item?.kind === 'row' && item.row.kind !== 'ghost' && item.row.hasChildren && !item.row.expanded) {
          onToggle?.(item.row.node.id)
        } else if (item?.kind === 'fold' && item.section.foldId) {
          onFoldExpand?.(item.section.foldId)
        }
        break
      }
      case 'ArrowLeft': {
        e.preventDefault()
        const item = displayedItems[idx]?.payload
        if (item?.kind === 'row' && item.row.kind !== 'ghost') {
          if (item.row.expanded && item.row.hasChildren) {
            onToggle?.(item.row.node.id)
          } else if (item.row.depth > 0) {
            const parentIdx = findParentDisplayedIndex(idx, item.row.depth)
            if (parentIdx >= 0) void navigateTo(parentIdx)
          }
        }
        break
      }
      case 'Enter':
      case ' ': {
        e.preventDefault()
        const item = displayedItems[idx]?.payload
        if (item?.kind === 'row' && item.row.kind !== 'ghost') {
          onSelect?.(item.row.node.id)
          focusedIndex = idx
        } else if (item?.kind === 'fold' && item.section.foldId) {
          onFoldExpand?.(item.section.foldId)
        }
        break
      }
      case 'F2': {
        e.preventDefault()
        if (editingDisabled) return
        const item = displayedItems[idx]?.payload
        if (item?.kind === 'row' && item.row.kind !== 'ghost') {
          onSelect?.(item.row.node.id)
          onRenameRequest?.()
        }
        break
      }
    }
  }

  // Reset focusedIndex when displayedItems shrinks past it.
  $effect(() => {
    void displayedItems
    if (focusedIndex >= displayedItems.length) focusedIndex = -1
  })
</script>

<!--
  Scrollable viewport. Owns keyboard nav and tree semantics. The context
  menu is rendered as a sibling AFTER this div so it isn't inside any CSS
  transform (which would otherwise capture position:fixed).
-->
<div
  bind:this={containerEl}
  role="tree"
  aria-label="Project tree"
  class="h-full overflow-y-auto overscroll-contain bg-white focus:outline-none"
  tabindex="0"
  onkeydown={handleKeyDown}
  data-testid="manifest-view"
>
  {#if isCompareEmpty}
    <div
      class="flex h-full flex-col items-center justify-center px-6 text-center
             text-stone-500 select-none"
      data-testid="lens-empty-state"
    >
      <div class="mb-3 flex h-12 w-12 items-center justify-center rounded-full
                  bg-emerald-50 text-emerald-600 ring-1 ring-emerald-100">
        <svg viewBox="0 0 16 16" class="h-5 w-5" fill="none">
          <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" stroke-width="1.75"
                stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </div>
      <p class="text-sm font-medium text-stone-700">No changes</p>
      <p class="mt-1 max-w-[280px] text-xs text-stone-500">
        These two snapshots are structurally identical — the {rows.length} nodes
        are all unchanged.
      </p>
    </div>
  {:else if virtualizerStore}
    <div class="relative w-full" style:height="{$virtualizerStore!.getTotalSize()}px">
      {#each $virtualizerStore!.getVirtualItems() as virt (virt.key)}
        {@const display = displayedItems[virt.index]}
        {#if display}
          {@const item = display.payload}
          <div
            class="absolute top-0 left-0 right-0 px-1"
            style:transform="translateY({virt.start}px)"
            style:height="{virt.size}px"
          >
            {#if item.kind === 'fold'}
              <FoldMarker
                foldId={item.section.foldId ?? ''}
                nodeCount={item.section.endIndex - item.section.startIndex + 1}
                changeBreakdown={item.section.changeBreakdown ?? null}
                depth={rows[item.section.startIndex]?.depth ?? 0}
                nodeNames={rows
                  .slice(item.section.startIndex, item.section.endIndex + 1)
                  .map(r => r.node.name)}
                onExpand={() => onFoldExpand?.(item.section.foldId ?? '')}
              />
            {:else}
              <TreeRow
                row={item.row}
                selected={selectedId === item.row.node.id}
                focused={focusedIndex === virt.index}
                onSelect={(id) => onSelect?.(id)}
                onToggle={(id) => onToggle?.(id)}
                onContextMenu={handleRowContextMenu}
              />
            {/if}
          </div>
        {/if}
      {/each}
    </div>
  {/if}
</div>

<!-- ─── Context menu ─────────────────────────────────────────────────────── -->
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
      onclick={() => { closeContextMenu(); onRenameRequest?.() }}
    >Rename</button>

    <button
      class="w-full text-left px-3 py-1.5 hover:bg-stone-50 [-webkit-app-region:no-drag]"
      role="menuitem"
      onclick={() => { const id = menuRow!.node.id; closeContextMenu(); onAddChild?.(id) }}
    >Add Child</button>

    {#if !menuIsRoot}
      <div class="border-t border-stone-100 my-1"></div>

      <button
        class="w-full text-left px-3 py-1.5 hover:bg-stone-50 disabled:text-stone-300
               [-webkit-app-region:no-drag]"
        role="menuitem"
        disabled={menuIsFirst}
        onclick={() => { const id = menuRow!.node.id; closeContextMenu(); onMoveUp?.(id) }}
      >Move Up ↑</button>

      <button
        class="w-full text-left px-3 py-1.5 hover:bg-stone-50 disabled:text-stone-300
               [-webkit-app-region:no-drag]"
        role="menuitem"
        disabled={menuIsLast}
        onclick={() => { const id = menuRow!.node.id; closeContextMenu(); onMoveDown?.(id) }}
      >Move Down ↓</button>

      <button
        class="w-full text-left px-3 py-1.5 hover:bg-stone-50 [-webkit-app-region:no-drag]"
        role="menuitem"
        onclick={() => { const id = menuRow!.node.id; closeContextMenu(); onMoveTo?.(id) }}
      >Move To…</button>

      <div class="border-t border-stone-100 my-1"></div>

      <button
        class="w-full text-left px-3 py-1.5 hover:bg-red-50 text-red-600
               [-webkit-app-region:no-drag]"
        role="menuitem"
        onclick={() => { const id = menuRow!.node.id; closeContextMenu(); onDelete?.(id) }}
      >Delete…</button>
    {/if}
  </div>
{/if}
