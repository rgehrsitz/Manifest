<svelte:options runes />

<script lang="ts">
  import type { DiffEntry } from '../../../shared/types'
  import {
    severityBadgeClass,
    formatChangeType,
    formatPath,
    formatValue,
    formatTemplateRef,
    describePropertyChange,
  } from '../lib/diff-format'

  interface Props {
    diff: DiffEntry
  }

  const MAX_IMPACT_ITEMS = 5

  let { diff }: Props = $props()

  const removalImpact = $derived(
    diff.changeType === 'removed' ? diff.context.removalImpact : undefined
  )
  const descendantPreview = $derived(removalImpact?.descendants.slice(0, MAX_IMPACT_ITEMS) ?? [])
  const referencePreview = $derived(removalImpact?.incomingReferences.slice(0, MAX_IMPACT_ITEMS) ?? [])
  const hiddenDescendantCount = $derived(
    Math.max((removalImpact?.descendants.length ?? 0) - descendantPreview.length, 0)
  )
  const hiddenReferenceCount = $derived(
    Math.max((removalImpact?.incomingReferences.length ?? 0) - referencePreview.length, 0)
  )
  const impactCount = $derived(
    (removalImpact?.descendants.length ?? 0) + (removalImpact?.incomingReferences.length ?? 0)
  )
  const impactSummary = $derived.by(() => {
    if (!removalImpact) return ''
    const parts = [
      removalImpact.descendants.length > 0
        ? `${removalImpact.descendants.length} descendant${removalImpact.descendants.length === 1 ? '' : 's'}`
        : '',
      removalImpact.incomingReferences.length > 0
        ? `${removalImpact.incomingReferences.length} reference${removalImpact.incomingReferences.length === 1 ? '' : 's'}`
        : '',
    ].filter(Boolean)
    return parts.join(', ')
  })
</script>

<div class="flex items-start justify-between gap-2" data-testid="snapshot-diff-row-header">
  <div class="min-w-0">
    <p class="text-xs font-medium text-stone-800">{formatChangeType(diff.changeType)}</p>
    <p class="mt-0.5 text-xs text-stone-600 truncate">
      {formatPath(diff.context.path, diff.context.nodeName)}
    </p>
  </div>
  <span class={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold
                uppercase tracking-wide ${severityBadgeClass(diff.severity)}`}>
    {diff.severity}
  </span>
</div>

{#if diff.severityReason}
  <p class="mt-2 text-[11px] leading-snug text-stone-600" data-testid="diff-severity-reason">
    {diff.severityReason}
  </p>
{/if}

{#if removalImpact && impactCount > 0}
  <details
    class="mt-2 rounded bg-white/80 px-2 py-2 ring-1 ring-black/5"
    data-no-row-select="true"
    data-testid="removed-impact-details"
  >
    <summary class="cursor-pointer text-[9px] font-semibold uppercase tracking-wide text-stone-500">
      Removal impact
      <span class="ml-1 normal-case tracking-normal text-stone-400">{impactSummary}</span>
    </summary>

    <div class="mt-2 space-y-2">
      {#if descendantPreview.length > 0}
        <div data-testid="removed-impact-descendants">
          <p class="text-[9px] font-semibold uppercase tracking-wide text-stone-400">
            Descendants ({removalImpact.descendants.length})
          </p>
          <ul class="mt-1 space-y-1">
            {#each descendantPreview as item (item.id)}
              <li class="flex items-start justify-between gap-2 rounded bg-stone-50 px-2 py-1 text-[11px] text-stone-600">
                <span class="min-w-0 truncate">{formatPath(item.path, item.name)}</span>
                <span class="shrink-0 text-[9px] text-stone-400">{item.id}</span>
              </li>
            {/each}
          </ul>
          {#if hiddenDescendantCount > 0}
            <p class="mt-1 text-[10px] text-stone-400">+{hiddenDescendantCount} more</p>
          {/if}
        </div>
      {/if}

      {#if referencePreview.length > 0}
        <div data-testid="removed-impact-references">
          <p class="text-[9px] font-semibold uppercase tracking-wide text-stone-400">
            Incoming references ({removalImpact.incomingReferences.length})
          </p>
          <ul class="mt-1 space-y-1">
            {#each referencePreview as ref (`${ref.nodeId}-${ref.fieldKey}`)}
              <li class="flex items-start justify-between gap-2 rounded bg-stone-50 px-2 py-1 text-[11px] text-stone-600">
                <span class="min-w-0 truncate">{formatPath(ref.path, ref.nodeName)}</span>
                <span class="shrink-0 text-[9px] text-stone-400">field: {ref.fieldKey}</span>
              </li>
            {/each}
          </ul>
          {#if hiddenReferenceCount > 0}
            <p class="mt-1 text-[10px] text-stone-400">+{hiddenReferenceCount} more</p>
          {/if}
        </div>
      {/if}
    </div>
  </details>
{/if}

{#if diff.changeType === 'renamed' || diff.changeType === 'moved' || diff.changeType === 'order-changed'}
  <div class="mt-2 grid grid-cols-2 gap-1.5">
    <div class="rounded bg-white/80 px-2 py-1.5 ring-1 ring-black/5">
      <p class="text-[9px] font-semibold uppercase tracking-wide text-stone-400">Before</p>
      <p class="mt-0.5 text-xs text-stone-700">{formatValue(diff.oldValue)}</p>
    </div>
    <div class="rounded bg-white/80 px-2 py-1.5 ring-1 ring-black/5">
      <p class="text-[9px] font-semibold uppercase tracking-wide text-stone-400">After</p>
      <p class="mt-0.5 text-xs text-stone-700">{formatValue(diff.newValue)}</p>
    </div>
  </div>
{:else if diff.changeType === 'template-changed'}
  <div class="mt-2 grid grid-cols-2 gap-1.5">
    <div class="rounded bg-white/80 px-2 py-1.5 ring-1 ring-black/5">
      <p class="text-[9px] font-semibold uppercase tracking-wide text-stone-400">Template was</p>
      <p class="mt-0.5 text-xs text-stone-700">{formatTemplateRef(diff.oldValue)}</p>
    </div>
    <div class="rounded bg-white/80 px-2 py-1.5 ring-1 ring-black/5">
      <p class="text-[9px] font-semibold uppercase tracking-wide text-stone-400">Template now</p>
      <p class="mt-0.5 text-xs text-stone-700">{formatTemplateRef(diff.newValue)}</p>
    </div>
  </div>
{:else if diff.changeType === 'property-changed'}
  <div class="mt-2 rounded bg-white/80 px-2 py-2 ring-1 ring-black/5">
    <p class="text-[9px] font-semibold uppercase tracking-wide text-stone-400">Changes</p>
    <div class="mt-1 flex flex-wrap gap-1">
      {#each describePropertyChange(diff) as line (line)}
        <span class="rounded-full bg-stone-100 px-2 py-0.5 text-[10px] text-stone-600">
          {line}
        </span>
      {/each}
    </div>
  </div>
{/if}
