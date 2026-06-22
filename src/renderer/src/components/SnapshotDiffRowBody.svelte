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

  let { diff }: Props = $props()
</script>

<div class="flex items-start justify-between gap-2">
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
