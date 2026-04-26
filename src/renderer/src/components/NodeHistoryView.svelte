<svelte:options runes />

<script lang="ts">
  import type { NodeHistoryEntry } from '../../../shared/types'
  import { onDestroy } from 'svelte'

  interface Props {
    nodeId: string
    nodeName: string
  }

  let { nodeId, nodeName }: Props = $props()

  let entries: NodeHistoryEntry[] = $state([])
  let loading = $state(false)
  let error: string | null = $state(null)
  let backfillStatus: { inProgress: boolean; completed: number; total: number } | null = $state(null)
  let pollTimer: ReturnType<typeof setTimeout> | null = null

  // (Re)load whenever the inspected node changes.
  $effect(() => {
    void load(nodeId)
  })

  onDestroy(() => {
    if (pollTimer) clearTimeout(pollTimer)
  })

  async function load(id: string): Promise<void> {
    loading = true
    error = null
    const [historyResult, statusResult] = await Promise.all([
      window.api.node.history(id),
      window.api.node.historyBackfillStatus(),
    ])
    loading = false

    if (!historyResult.ok) {
      error = historyResult.error.message
      return
    }
    entries = historyResult.data.entries

    if (statusResult.ok) {
      backfillStatus = statusResult.data
      if (statusResult.data.inProgress) schedulePoll(id)
    }
  }

  function schedulePoll(id: string): void {
    if (pollTimer) clearTimeout(pollTimer)
    pollTimer = setTimeout(async () => {
      const statusResult = await window.api.node.historyBackfillStatus()
      if (!statusResult.ok) return
      backfillStatus = statusResult.data
      if (statusResult.data.inProgress) {
        schedulePoll(id)
      } else {
        // Backfill finished — re-fetch entries to pick up any rows added.
        const historyResult = await window.api.node.history(id)
        if (historyResult.ok) entries = historyResult.data.entries
      }
    }, 800)
  }

  // Compute a short "what changed" summary for each entry by comparing it to
  // the previous entry. The first entry is the node's first appearance.
  type ChangeSummary = string[]
  const summaries: ChangeSummary[] = $derived.by(() => {
    const out: ChangeSummary[] = []
    for (let i = 0; i < entries.length; i++) {
      const curr = entries[i]
      const prev = i > 0 ? entries[i - 1] : null
      out.push(summarize(curr, prev))
    }
    return out
  })

  function summarize(curr: NodeHistoryEntry, prev: NodeHistoryEntry | null): ChangeSummary {
    if (curr.presence === 'absent') {
      return prev?.presence === 'present'
        ? ['Deleted']
        : ['Absent']
    }
    if (!prev || prev.presence === 'absent') {
      return [`Created as "${curr.nodeName}"`]
    }
    const changes: string[] = []
    if (curr.nodeName !== prev.nodeName) {
      changes.push(`Renamed "${prev.nodeName}" → "${curr.nodeName}"`)
    }
    if (curr.parentId !== prev.parentId) {
      changes.push('Moved to a different parent')
    }
    if (curr.nodeOrder !== prev.nodeOrder) {
      changes.push('Reordered among siblings')
    }
    const propChanges = diffProperties(prev.properties, curr.properties)
    changes.push(...propChanges)
    if (changes.length === 0) changes.push('Recorded (no field changes)')
    return changes
  }

  function diffProperties(
    a: Record<string, string | number | boolean | null> | null,
    b: Record<string, string | number | boolean | null> | null,
  ): string[] {
    const out: string[] = []
    const aKeys = new Set(Object.keys(a ?? {}))
    const bKeys = new Set(Object.keys(b ?? {}))
    for (const key of bKeys) {
      if (!aKeys.has(key)) out.push(`Set ${key} = ${formatVal(b?.[key])}`)
      else if (a?.[key] !== b?.[key]) out.push(`Changed ${key}: ${formatVal(a?.[key])} → ${formatVal(b?.[key])}`)
    }
    for (const key of aKeys) {
      if (!bKeys.has(key)) out.push(`Removed ${key}`)
    }
    return out
  }

  function formatVal(v: string | number | boolean | null | undefined): string {
    if (v === null || v === undefined) return '∅'
    if (typeof v === 'string') return `"${v}"`
    return String(v)
  }

  function entryTitle(entry: NodeHistoryEntry): string {
    if (entry.type === 'snapshot') return `Snapshot "${entry.snapshotName ?? '?'}"`
    if (entry.type === 'revert') return `Reverted to "${entry.revertTargetSnapshotId ?? '?'}"`
    return 'Recovered from a recovery point'
  }

  function badgeClass(type: NodeHistoryEntry['type']): string {
    if (type === 'snapshot') return 'bg-sky-50 text-sky-700 border-sky-200'
    if (type === 'revert') return 'bg-amber-50 text-amber-700 border-amber-200'
    return 'bg-emerald-50 text-emerald-700 border-emerald-200'
  }
</script>

<div class="flex flex-col gap-3" data-testid="node-history-view">
  {#if loading}
    <p class="text-xs text-stone-400">Loading history…</p>
  {:else if error}
    <div class="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
         data-testid="node-history-error">
      {error}
    </div>
  {:else}
    {#if backfillStatus?.inProgress}
      <div class="rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-xs text-stone-600"
           data-testid="node-history-indexing">
        Indexing snapshots… {backfillStatus.completed} of {backfillStatus.total}
      </div>
    {/if}

    {#if entries.length === 0}
      <div class="rounded-lg border border-dashed border-stone-200 bg-stone-50 px-3 py-4
                  text-xs text-stone-400 text-center"
           data-testid="node-history-empty">
        "{nodeName}" has not been snapshotted yet.
      </div>
    {:else}
      <ol class="space-y-2">
        {#each entries as entry, idx (entry.entryId + ':' + idx)}
          <li class="rounded-lg border border-stone-200 bg-white px-3 py-2"
              data-testid="node-history-entry">
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0">
                <p class="text-xs font-medium text-stone-800">{entryTitle(entry)}</p>
                <p class="mt-0.5 text-[10px] text-stone-400">
                  {new Date(entry.createdAt).toLocaleString()}
                </p>
              </div>
              <span class={`shrink-0 rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase
                           tracking-wide ${badgeClass(entry.type)}`}>
                {entry.type}
              </span>
            </div>

            <ul class="mt-2 space-y-0.5">
              {#each summaries[idx] as change (change)}
                <li class="text-[11px] text-stone-600">• {change}</li>
              {/each}
            </ul>

            {#if entry.note}
              <p class="mt-2 rounded border border-amber-100 bg-amber-50 px-2 py-1 text-[10px] text-amber-800">
                {entry.note}
              </p>
            {/if}
          </li>
        {/each}
      </ol>
    {/if}
  {/if}
</div>
