<svelte:options runes />

<script lang="ts">
  import type { DiffEntry, Snapshot } from '../../../shared/types'

  interface Props {
    snapshots: Snapshot[]
    diffEntries: DiffEntry[]
    compareLoaded: boolean
    loading: boolean
    creating: boolean
    comparing: boolean
    restoringName: string | null
    error: string | null
    onClose: () => void
    onRefresh: () => Promise<void>
    onCreate: (name: string) => Promise<void>
    onCompare: (from: string, to: string) => Promise<void>
    onRestore: (name: string) => Promise<void>
  }

  let {
    snapshots,
    diffEntries,
    compareLoaded,
    loading,
    creating,
    comparing,
    restoringName,
    error,
    onClose,
    onRefresh,
    onCreate,
    onCompare,
    onRestore,
  }: Props = $props()

  let snapshotName = $state('')
  let compareFrom = $state('')
  let compareTo = $state('')

  const severityOrder = ['High', 'Medium', 'Low'] as const

  const severitySummary = $derived(
    severityOrder
      .map((severity) => ({
        severity,
        count: diffEntries.filter((entry) => entry.severity === severity).length,
      }))
      .filter((entry) => entry.count > 0)
  )

  const changeSummary = $derived(
    Array.from(new Set(diffEntries.map((entry) => entry.changeType))).map((changeType) => ({
      changeType,
      count: diffEntries.filter((entry) => entry.changeType === changeType).length,
    }))
  )

  const groupedDiffEntries = $derived(
    severityOrder
      .map((severity) => ({
        severity,
        entries: diffEntries.filter((entry) => entry.severity === severity),
      }))
      .filter((group) => group.entries.length > 0)
  )

  $effect(() => {
    const names = snapshots.map((snapshot) => snapshot.name)
    if (snapshots.length === 0) {
      compareFrom = ''
      compareTo = ''
      return
    }

    if (!compareTo || !names.includes(compareTo)) {
      compareTo = snapshots[0].name
    }

    if (!compareFrom || !names.includes(compareFrom) || compareFrom === compareTo) {
      compareFrom = snapshots[1]?.name ?? snapshots[0].name
    }
  })

  function handleBackdropClick(event: MouseEvent) {
    if (event.target === event.currentTarget) onClose()
  }

  function formatChangeType(changeType: DiffEntry['changeType']): string {
    switch (changeType) {
      case 'property-changed': return 'Property Changed'
      case 'order-changed': return 'Order Changed'
      default: return changeType.charAt(0).toUpperCase() + changeType.slice(1)
    }
  }

  function formatPath(path: string[], nodeName: string): string {
    return [...path, nodeName].join(' / ')
  }

  function severityClass(severity: DiffEntry['severity']): string {
    switch (severity) {
      case 'High': return 'border-amber-200 bg-amber-50/70'
      case 'Medium': return 'border-sky-200 bg-sky-50/60'
      case 'Low': return 'border-stone-200 bg-stone-50'
    }
  }

  function severityBadgeClass(severity: DiffEntry['severity']): string {
    switch (severity) {
      case 'High': return 'bg-amber-100 text-amber-700'
      case 'Medium': return 'bg-sky-100 text-sky-700'
      case 'Low': return 'bg-stone-200 text-stone-600'
    }
  }

  function formatValue(value: unknown): string {
    if (value === null || value === undefined) return 'root'
    if (typeof value === 'string') return value
    if (typeof value === 'number' || typeof value === 'boolean') return String(value)
    return JSON.stringify(value, null, 2)
  }

  function describePropertyChange(diff: DiffEntry): string[] {
    const before = (diff.oldValue ?? {}) as Record<string, unknown>
    const after = (diff.newValue ?? {}) as Record<string, unknown>
    const keys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)])).sort()

    return keys.flatMap((key) => {
      if (!(key in before)) return [`Added ${key}: ${formatValue(after[key])}`]
      if (!(key in after)) return [`Removed ${key}`]
      if (before[key] !== after[key]) return [`${key}: ${formatValue(before[key])} → ${formatValue(after[key])}`]
      return []
    })
  }

  function snapshotTagClass(snapshotName: string): string {
    if (snapshotName === compareFrom) return 'bg-stone-800 text-white'
    if (snapshotName === compareTo) return 'bg-sky-100 text-sky-700'
    return 'bg-stone-100 text-stone-500'
  }

  async function submitSnapshotCreate() {
    const trimmed = snapshotName.trim()
    if (!trimmed || creating) return
    await onCreate(trimmed)
    snapshotName = ''
  }

  async function submitSnapshotCompare() {
    if (!compareFrom || !compareTo || compareFrom === compareTo || comparing) return
    await onCompare(compareFrom, compareTo)
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4"
  onclick={handleBackdropClick}
  data-testid="snapshot-dialog"
>
  <div
    class="w-full max-w-5xl max-h-[90vh] overflow-hidden rounded-2xl bg-white shadow-2xl"
    role="dialog"
    aria-modal="true"
    aria-label="Snapshots"
  >
    <div class="flex items-center justify-between border-b border-stone-200 px-5 py-4">
      <div>
        <h2 class="text-base font-semibold text-stone-900">Snapshots</h2>
        <p class="text-sm text-stone-400">Named checkpoints, semantic diffs, and safe restores.</p>
      </div>
      <div class="flex items-center gap-2">
        <button
          onclick={onRefresh}
          class="rounded-lg border border-stone-200 px-3 py-1.5 text-sm text-stone-600
                 transition-colors hover:bg-stone-50 cursor-default"
          data-testid="refresh-snapshots-btn"
        >
          Refresh
        </button>
        <button
          onclick={onClose}
          class="rounded-lg px-2 py-1 text-stone-400 transition-colors hover:bg-stone-100
                 hover:text-stone-700 cursor-default"
          aria-label="Close snapshots"
        >
          ✕
        </button>
      </div>
    </div>

    <div class="grid max-h-[calc(90vh-72px)] grid-cols-1 overflow-hidden lg:grid-cols-[360px_1fr]">
      <div class="flex flex-col gap-5 overflow-y-auto border-b border-stone-200 bg-stone-50 px-5 py-5 lg:border-b-0 lg:border-r">
        <section class="space-y-3">
          <div>
            <h3 class="text-xs font-semibold uppercase tracking-wide text-stone-500">Create Snapshot</h3>
            <p class="mt-1 text-xs text-stone-400">Capture the current manifest state as a named checkpoint.</p>
          </div>
          <div class="space-y-2">
            <input
              type="text"
              bind:value={snapshotName}
              placeholder="phase-3-baseline"
              class="w-full rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm
                     text-stone-800 placeholder-stone-300 focus:outline-none focus:ring-1
                     focus:ring-stone-400 selectable"
              data-testid="snapshot-name-input"
              onkeydown={(event) => {
                if (event.key === 'Enter') submitSnapshotCreate()
              }}
            />
            <button
              onclick={submitSnapshotCreate}
              disabled={!snapshotName.trim() || creating}
              class="w-full rounded-lg bg-stone-800 px-3 py-2 text-sm font-medium text-white
                     transition-colors hover:bg-stone-700 disabled:bg-stone-300 cursor-default
                     disabled:cursor-not-allowed"
              data-testid="create-snapshot-btn"
            >
              {creating ? 'Creating…' : 'Create Snapshot'}
            </button>
          </div>
        </section>

        <section class="space-y-3">
          <div class="flex items-center justify-between">
            <div>
              <h3 class="text-xs font-semibold uppercase tracking-wide text-stone-500">Saved Snapshots</h3>
              <p class="mt-1 text-xs text-stone-400">
                {#if loading}
                  Loading history…
                {:else}
                  {snapshots.length} saved
                {/if}
              </p>
            </div>
          </div>

          {#if error}
            <div class="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" data-testid="snapshot-error">
              {error}
            </div>
          {/if}

          {#if !loading && snapshots.length === 0}
            <div class="rounded-lg border border-dashed border-stone-200 bg-white px-4 py-5 text-sm text-stone-400">
              No snapshots yet.
            </div>
          {:else}
            <div class="space-y-2">
              {#each snapshots as snapshot (snapshot.name)}
                <div
                  class="rounded-xl border border-stone-200 bg-white px-3 py-3 shadow-sm"
                  data-testid="snapshot-row"
                >
                  <div class="flex items-start justify-between gap-3">
                    <div class="min-w-0">
                      <div class="flex items-center gap-2">
                        <p class="truncate text-sm font-medium text-stone-800">{snapshot.name}</p>
                        {#if snapshots.length >= 2}
                          <span class={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${snapshotTagClass(snapshot.name)}`}>
                            {snapshot.name === compareFrom ? 'From' : snapshot.name === compareTo ? 'To' : 'Saved'}
                          </span>
                        {/if}
                      </div>
                      <p class="mt-0.5 text-xs text-stone-400">{new Date(snapshot.createdAt).toLocaleString()}</p>
                      <p class="mt-1 truncate font-mono text-[11px] text-stone-300">{snapshot.commitHash.slice(0, 12)}</p>
                    </div>
                    <button
                      onclick={() => onRestore(snapshot.name)}
                      disabled={restoringName === snapshot.name}
                      class="shrink-0 rounded-lg border border-stone-200 px-2.5 py-1.5 text-xs
                             font-medium text-stone-600 transition-colors hover:bg-stone-50
                             disabled:bg-stone-100 disabled:text-stone-400 cursor-default"
                      data-testid="restore-snapshot-btn"
                    >
                      {restoringName === snapshot.name ? 'Restoring…' : 'Restore'}
                    </button>
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        </section>
      </div>

      <div class="flex min-h-0 flex-col overflow-hidden bg-white">
        <div class="border-b border-stone-200 px-5 py-4">
          <div class="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <h3 class="text-xs font-semibold uppercase tracking-wide text-stone-500">Compare Snapshots</h3>
              <p class="mt-1 text-xs text-stone-400">See meaningful changes between two checkpoints.</p>
            </div>
            <div class="flex flex-col gap-2 sm:flex-row sm:items-end">
              <label class="flex flex-col gap-1 text-xs text-stone-500">
                From
                <select
                  bind:value={compareFrom}
                  class="rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm text-stone-700
                         focus:outline-none focus:ring-1 focus:ring-stone-400"
                  data-testid="compare-from-select"
                >
                  {#each snapshots as snapshot (snapshot.name)}
                    <option value={snapshot.name}>{snapshot.name}</option>
                  {/each}
                </select>
              </label>
              <label class="flex flex-col gap-1 text-xs text-stone-500">
                To
                <select
                  bind:value={compareTo}
                  class="rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm text-stone-700
                         focus:outline-none focus:ring-1 focus:ring-stone-400"
                  data-testid="compare-to-select"
                >
                  {#each snapshots as snapshot (snapshot.name)}
                    <option value={snapshot.name}>{snapshot.name}</option>
                  {/each}
                </select>
              </label>
              <button
                onclick={submitSnapshotCompare}
                disabled={snapshots.length < 2 || !compareFrom || !compareTo || compareFrom === compareTo || comparing}
                class="rounded-lg bg-stone-800 px-3 py-2 text-sm font-medium text-white
                       transition-colors hover:bg-stone-700 disabled:bg-stone-300 cursor-default
                       disabled:cursor-not-allowed"
                data-testid="compare-snapshots-btn"
              >
                {comparing ? 'Comparing…' : 'Compare'}
              </button>
            </div>
          </div>
        </div>

        <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {#if !compareLoaded}
            <div class="flex h-full items-center justify-center rounded-xl border border-dashed border-stone-200 bg-stone-50 px-6 text-center">
              <div class="max-w-md space-y-2">
                <p class="text-sm font-medium text-stone-600">No diff loaded</p>
                <p class="text-sm text-stone-400">Pick two snapshots and compare them to see adds, moves, renames, property changes, and reordering.</p>
              </div>
            </div>
          {:else if diffEntries.length === 0}
            <div class="flex h-full items-center justify-center rounded-xl border border-dashed border-emerald-200 bg-emerald-50/60 px-6 text-center">
              <div class="max-w-md space-y-2">
                <p class="text-sm font-medium text-emerald-700">No changes between these snapshots</p>
                <p class="text-sm text-emerald-600">{compareFrom} and {compareTo} describe the same manifest state.</p>
              </div>
            </div>
          {:else}
            <div class="space-y-3" data-testid="snapshot-diff-list">
              <div class="rounded-xl border border-stone-200 bg-stone-50 px-4 py-4">
                <div class="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <div>
                    <p class="text-sm font-medium text-stone-700">{diffEntries.length} changes found</p>
                    <p class="mt-1 text-xs text-stone-400">{compareFrom} → {compareTo}</p>
                  </div>
                  <div class="flex flex-wrap gap-2">
                    {#each severitySummary as item (item.severity)}
                      <span class={`rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide ${severityBadgeClass(item.severity)}`}>
                        {item.count} {item.severity}
                      </span>
                    {/each}
                  </div>
                </div>

                <div class="mt-3 flex flex-wrap gap-2">
                  {#each changeSummary as item (item.changeType)}
                    <span class="rounded-full bg-white px-2.5 py-1 text-[11px] font-medium text-stone-600 ring-1 ring-stone-200">
                      {item.count} {formatChangeType(item.changeType)}
                    </span>
                  {/each}
                </div>
              </div>

              {#each groupedDiffEntries as group (group.severity)}
                <section class="space-y-3">
                  <div class="flex items-center justify-between">
                    <h4 class="text-xs font-semibold uppercase tracking-wide text-stone-500">{group.severity} Priority</h4>
                    <span class={`rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide ${severityBadgeClass(group.severity)}`}>
                      {group.entries.length}
                    </span>
                  </div>

                  {#each group.entries as diff, index (`${diff.nodeId}-${diff.changeType}-${index}`)}
                    <div
                      class={`rounded-xl border px-4 py-4 shadow-sm ${severityClass(diff.severity)}`}
                      data-testid="snapshot-diff-row"
                    >
                      <div class="flex items-start justify-between gap-3">
                        <div class="min-w-0">
                          <div class="flex flex-wrap items-center gap-2">
                            <p class="text-sm font-medium text-stone-800">{formatChangeType(diff.changeType)}</p>
                            <span class="rounded-full bg-white px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-stone-500 ring-1 ring-stone-200">
                              {diff.context.parentName ?? 'Root'}
                            </span>
                          </div>
                          <p class="mt-1 text-sm text-stone-600">{formatPath(diff.context.path, diff.context.nodeName)}</p>
                        </div>
                        <span class={`rounded-full px-2 py-1 text-[11px] font-semibold uppercase tracking-wide ${severityBadgeClass(diff.severity)}`}>
                          {diff.severity}
                        </span>
                      </div>

                      {#if diff.changeType === 'renamed' || diff.changeType === 'moved' || diff.changeType === 'order-changed'}
                        <div class="mt-3 grid gap-2 sm:grid-cols-2">
                          <div class="rounded-lg bg-white/80 px-3 py-2 ring-1 ring-black/5">
                            <p class="text-[11px] font-semibold uppercase tracking-wide text-stone-400">Before</p>
                            <p class="mt-1 text-sm text-stone-700">{formatValue(diff.oldValue)}</p>
                          </div>
                          <div class="rounded-lg bg-white/80 px-3 py-2 ring-1 ring-black/5">
                            <p class="text-[11px] font-semibold uppercase tracking-wide text-stone-400">After</p>
                            <p class="mt-1 text-sm text-stone-700">{formatValue(diff.newValue)}</p>
                          </div>
                        </div>
                      {:else if diff.changeType === 'property-changed'}
                        <div class="mt-3 rounded-lg bg-white/80 px-3 py-3 ring-1 ring-black/5">
                          <p class="text-[11px] font-semibold uppercase tracking-wide text-stone-400">Property Delta</p>
                          <div class="mt-2 flex flex-wrap gap-2">
                            {#each describePropertyChange(diff) as line (line)}
                              <span class="rounded-full bg-stone-100 px-2.5 py-1 text-xs text-stone-600">{line}</span>
                            {/each}
                          </div>
                        </div>
                      {:else if diff.changeType === 'added'}
                        <p class="mt-3 text-xs text-stone-500">Node added in the destination snapshot. It now appears under <span class="font-medium text-stone-700">{diff.context.parentName ?? 'Root'}</span>.</p>
                      {:else if diff.changeType === 'removed'}
                        <p class="mt-3 text-xs text-stone-500">Node removed from the destination snapshot. It previously existed under <span class="font-medium text-stone-700">{diff.context.parentName ?? 'Root'}</span>.</p>
                      {/if}
                    </div>
                  {/each}
                </section>
              {/each}
            </div>
          {/if}
        </div>
      </div>
    </div>
  </div>
</div>
