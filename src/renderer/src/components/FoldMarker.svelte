<svelte:options runes />

<script lang="ts">
  import type { ChangeBreakdown } from '../lib/density-layer'

  interface Props {
    /** Stable id; drives Svelte keyed {#each} for animation interpolation. */
    foldId: string
    /** Number of nodes folded into this marker. */
    nodeCount: number
    /**
     * Diff-engine-derived breakdown. Null when not in compare mode (v2+).
     * In compare-mode-unchanged folds (v1), this is all zeros — the marker
     * still renders the count, no breakdown chips.
     */
    changeBreakdown: ChangeBreakdown | null
    /** Indent depth, matching surrounding rows. */
    depth: number
    /** Called when the user activates the fold (click / Enter / Space). */
    onExpand: () => void
    /**
     * Names of the nodes folded into this marker. The first ~5 surface as a
     * native browser tooltip on hover so the user can peek without expanding.
     * Optional — empty array suppresses the tooltip.
     */
    nodeNames?: string[]
  }

  let { foldId, nodeCount, changeBreakdown, depth, onExpand, nodeNames = [] }: Props = $props()

  // Tooltip: surface the first few node names on hover so the user can peek
  // without committing to an expand. Capped to keep the tooltip readable;
  // the count gives a precise bound. Native `title` attribute = no extra
  // dependency, accessible to screen readers and pointer hover both.
  const TOOLTIP_PREVIEW_COUNT = 5
  const tooltipText = $derived.by(() => {
    if (nodeNames.length === 0) return undefined
    const preview = nodeNames.slice(0, TOOLTIP_PREVIEW_COUNT).join(', ')
    const more = nodeNames.length > TOOLTIP_PREVIEW_COUNT
      ? `, and ${nodeNames.length - TOOLTIP_PREVIEW_COUNT} more`
      : ''
    return `${preview}${more}`
  })

  // Match TreeRow's deep-hierarchy indent cap so a fold marker doesn't
  // visually mis-align with its sibling rows at depth > 12.
  const MAX_INDENT_DEPTH = 12
  const paddingLeft = $derived(`${Math.min(depth, MAX_INDENT_DEPTH) * 16 + 8}px`)

  // Aria label per design doc: "47 unchanged shelves folded; press Enter to expand".
  // We don't know the domain noun in v1, so generic "items".
  const ariaLabel = $derived(
    `${nodeCount} unchanged ${nodeCount === 1 ? 'item' : 'items'} folded; press Enter to expand`
  )

  // Breakdown chips render only when at least one count is non-zero. In v1
  // compare-unchanged folds, breakdown is all zeros and no chips render.
  const breakdownChips = $derived.by(() => {
    if (!changeBreakdown) return []
    const chips: Array<{ label: string; count: number; tone: string }> = []
    if (changeBreakdown.added > 0)          chips.push({ label: 'added',     count: changeBreakdown.added,          tone: 'bg-emerald-100 text-emerald-800' })
    if (changeBreakdown.removed > 0)        chips.push({ label: 'removed',   count: changeBreakdown.removed,        tone: 'bg-red-100 text-red-800' })
    if (changeBreakdown.moved > 0)          chips.push({ label: 'moved',     count: changeBreakdown.moved,          tone: 'bg-sky-100 text-sky-800' })
    if (changeBreakdown.renamed > 0)        chips.push({ label: 'renamed',   count: changeBreakdown.renamed,        tone: 'bg-amber-100 text-amber-800' })
    if (changeBreakdown.propertyChanged > 0) chips.push({ label: 'changed',  count: changeBreakdown.propertyChanged, tone: 'bg-amber-100 text-amber-800' })
    return chips
  })

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onExpand()
    }
  }
</script>

<button
  type="button"
  aria-expanded="false"
  aria-label={ariaLabel}
  title={tooltipText}
  data-fold-id={foldId}
  class="flex items-center gap-2 w-full h-full text-left
         rounded-md border border-amber-200 bg-amber-50/80
         hover:bg-amber-100 focus:outline-none focus:ring-2 focus:ring-amber-400
         text-amber-900 text-xs font-medium overflow-hidden"
  style:padding-left={paddingLeft}
  style:padding-right="8px"
  onclick={onExpand}
  onkeydown={handleKeyDown}
>
  <span aria-hidden="true" class="text-[10px] text-amber-700">▸</span>

  <span class="flex-1 truncate">
    {#if breakdownChips.length === 0}
      — {nodeCount} unchanged {nodeCount === 1 ? 'item' : 'items'} folded —
    {:else}
      {nodeCount} {nodeCount === 1 ? 'item' : 'items'} folded
    {/if}
  </span>

  {#each breakdownChips as chip (chip.label)}
    <span class="px-1.5 py-0.5 rounded {chip.tone} text-[10px] font-semibold">
      {chip.count} {chip.label}
    </span>
  {/each}

  <span class="px-2 py-0.5 rounded-full bg-amber-500 text-white text-[10px] font-semibold">
    {nodeCount}
  </span>
</button>
