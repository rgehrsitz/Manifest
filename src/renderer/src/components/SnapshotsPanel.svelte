<svelte:options runes />

<script lang="ts">
  import type { RecoveryPoint, Snapshot, SnapshotTimelineEvent } from '../../../shared/types'
  import type { MergedTree } from '../../../shared/merged-tree'
  import {
    severityBadgeClass,
    severityClass,
    formatChangeType,
    formatPath,
    formatValue,
    describePropertyChange,
  } from '../lib/diff-format'

  interface Props {
    snapshots: Snapshot[]
    timelineEvents: SnapshotTimelineEvent[]
    recoveryPoints: RecoveryPoint[]
    mergedTree: MergedTree | null
    compareLoaded: boolean
    loading: boolean
    creating: boolean
    comparing: boolean
    restoringName: string | null
    error: string | null
    workingCopyBaseSnapshot?: string | null
    workingCopyDirty?: boolean
    /** Node id currently selected in the tree — highlights the matching diff row. */
    highlightedNodeId?: string | null
    /** Called when the user clicks a diff row — App selects the node in the tree. */
    onDiffNodeSelect?: (nodeId: string) => void
    onClose: () => void
    onRefresh: () => Promise<void>
    onCreate: (name: string) => Promise<void>
    onCompare: (from: string, to: string) => Promise<void>
    onExitCompare: () => void
    onRestore: (name: string) => Promise<void>
  }

  let {
    snapshots,
    timelineEvents,
    recoveryPoints,
    mergedTree,
    compareLoaded,
    loading,
    creating,
    comparing,
    restoringName,
    error,
    workingCopyBaseSnapshot = null,
    workingCopyDirty = false,
    highlightedNodeId = null,
    onDiffNodeSelect,
    onClose,
    onRefresh,
    onCreate,
    onCompare,
    onExitCompare,
    onRestore,
  }: Props = $props()

  let snapshotName = $state('')
  let compareFrom = $state('')
  let compareTo = $state('')

  // Ref to scrollable body — used to scroll highlighted diff into view.
  let scrollEl: HTMLElement | null = $state(null)

  // Scroll highlighted diff card into view whenever the selection changes.
  $effect(() => {
    if (!highlightedNodeId || !scrollEl) return
    const el = scrollEl.querySelector<HTMLElement>(`[data-node-id="${highlightedNodeId}"]`)
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  })

  const severityOrder = ['High', 'Medium', 'Low'] as const

  // Flatten all diffs from the merged tree nodes.
  const allDiffs = $derived(
    mergedTree ? mergedTree.nodes.flatMap(n => n.diffs) : []
  )

  const severitySummary = $derived(
    severityOrder
      .map(severity => ({
        severity,
        count: allDiffs.filter(e => e.severity === severity).length,
      }))
      .filter(e => e.count > 0)
  )

  const changeSummary = $derived(
    Array.from(new Set(allDiffs.map(e => e.changeType))).map(changeType => ({
      changeType,
      count: allDiffs.filter(e => e.changeType === changeType).length,
    }))
  )

  const workingCopyDescription = $derived.by(() => {
    if (workingCopyBaseSnapshot) {
      return workingCopyDirty
        ? 'The current project has changes that are not saved in a snapshot yet.'
        : `The current project matches "${workingCopyBaseSnapshot}".`
    }
    return workingCopyDirty
      ? 'The current project has changes that are not saved in a snapshot yet.'
      : 'You are editing the current project. Saved snapshots are read-only history points.'
  })

  const groupedDiffs = $derived(
    severityOrder
      .map(severity => ({
        severity,
        entries: allDiffs.filter(e => e.severity === severity),
      }))
      .filter(g => g.entries.length > 0)
  )

  $effect(() => {
    const names = snapshots.map(s => s.name)
    if (snapshots.length === 0) { compareFrom = ''; compareTo = ''; return }
    if (!compareTo || !names.includes(compareTo)) compareTo = snapshots[0].name
    if (!compareFrom || !names.includes(compareFrom)) {
      compareFrom = snapshots[1]?.name ?? snapshots[0].name
    }
  })

  async function submitCreate() {
    const trimmed = snapshotName.trim()
    if (!trimmed || creating) return
    await onCreate(trimmed)
    snapshotName = ''
  }

  async function submitCompare() {
    if (!compareFrom || !compareTo || compareFrom === compareTo || comparing) return
    await onCompare(compareFrom, compareTo)
  }

  function snapshotTagClass(name: string): string {
    if (name === compareFrom) return 'bg-stone-800 text-white'
    if (name === compareTo)   return 'bg-sky-100 text-sky-700'
    return 'bg-stone-100 text-stone-500'
  }

  function timelineBadgeClass(type: SnapshotTimelineEvent['type']): string {
    return type === 'snapshot'
      ? 'border-sky-200 bg-sky-50 text-sky-700'
      : 'border-amber-200 bg-amber-50 text-amber-700'
  }

  function snapshotById(id: string | undefined): Snapshot | null {
    if (!id) return null
    return snapshots.find(snapshot => snapshot.id === id || snapshot.name === id) ?? null
  }

  function recoveryPointById(id: string | null | undefined): RecoveryPoint | null {
    if (!id) return null
    return recoveryPoints.find(point => point.id === id) ?? null
  }

  function timelineTitle(event: SnapshotTimelineEvent): string {
    if (event.type === 'snapshot') {
      return `Saved snapshot "${event.snapshotId ?? 'unknown'}"`
    }
    return `Reverted current project to "${event.targetSnapshotId ?? 'unknown'}"`
  }

  function lineageText(event: SnapshotTimelineEvent): string | null {
    if (event.type !== 'snapshot') return null
    const snapshot = snapshotById(event.snapshotId)
    if (!snapshot?.basedOnSnapshotId) return null
    return `Based on ${snapshot.basedOnSnapshotId}`
  }
</script>

<!--
  Docked snapshots panel — slides in from the right as a third column.
  Does NOT block the tree or detail pane. The user can click nodes, edit
  properties, and view diffs simultaneously.
  Width is controlled by the parent (App.svelte) via a wrapper div.
-->
<div
  class="flex flex-col h-full bg-white overflow-hidden"
  data-testid="snapshots-panel"
>
  <!-- Header -->
  <div class="flex items-center justify-between px-4 py-3 border-b border-stone-200 shrink-0">
    <div>
      <h2 class="text-sm font-semibold text-stone-900">Snapshots</h2>
      <p class="text-xs text-stone-400">Named checkpoints and semantic diffs.</p>
    </div>
    <div class="flex items-center gap-1">
      <button
        onclick={onRefresh}
        class="rounded-lg border border-stone-200 px-2 py-1 text-xs text-stone-600
               transition-colors hover:bg-stone-50 cursor-default"
        data-testid="refresh-snapshots-btn"
      >Refresh</button>
      <button
        onclick={onClose}
        aria-label="Close snapshots"
        class="rounded-lg px-2 py-1 text-stone-400 transition-colors hover:bg-stone-100
               hover:text-stone-700 cursor-default text-sm"
      >✕</button>
    </div>
  </div>

  <!-- Scrollable body -->
  <div class="flex-1 overflow-y-auto overscroll-contain" bind:this={scrollEl}>

    <!-- Create snapshot -->
    <section class="px-4 py-3 border-b border-stone-100 space-y-2">
      <div class="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2">
        <p class="text-[10px] font-semibold uppercase tracking-wide text-emerald-700">Current State</p>
        <p class="mt-0.5 text-xs text-emerald-800">
          {workingCopyDescription}
        </p>
      </div>
      <h3 class="text-[10px] font-semibold uppercase tracking-wide text-stone-500">Create Snapshot from Current Project</h3>
      <input
        type="text"
        bind:value={snapshotName}
        placeholder="phase-3-baseline"
        class="w-full rounded-lg border border-stone-200 bg-stone-50 px-3 py-1.5 text-sm
               text-stone-800 placeholder-stone-300 focus:outline-none focus:ring-1
               focus:ring-stone-400 selectable"
        data-testid="snapshot-name-input"
        onkeydown={(e) => { if (e.key === 'Enter') submitCreate() }}
      />
      <button
        onclick={submitCreate}
        disabled={!snapshotName.trim() || creating}
        class="w-full rounded-lg bg-stone-800 px-3 py-1.5 text-xs font-medium text-white
               transition-colors hover:bg-stone-700 disabled:bg-stone-300 cursor-default
               disabled:cursor-not-allowed"
        data-testid="create-snapshot-btn"
      >
        {creating ? 'Creating…' : 'Save Current Project as Snapshot'}
      </button>
    </section>

    <!-- Timeline -->
    <section class="px-4 py-3 border-b border-stone-100 space-y-2" data-testid="snapshot-timeline">
      <h3 class="text-[10px] font-semibold uppercase tracking-wide text-stone-500">
        Snapshot Timeline {#if !loading}({timelineEvents.length}){/if}
      </h3>

      {#if loading}
        <p class="text-xs text-stone-400">Loading…</p>
      {:else if timelineEvents.length === 0}
        <div class="rounded-lg border border-dashed border-stone-200 bg-stone-50 px-3 py-4
                    text-xs text-stone-400 text-center">
          No timeline events yet.
        </div>
      {:else}
        <div class="space-y-2">
          {#each timelineEvents as event (event.id)}
            {@const recoveryPoint = recoveryPointById(event.safetyRecoveryPointId)}
            {@const lineage = lineageText(event)}
            <div
              class="rounded-lg border border-stone-200 bg-white px-3 py-2"
              data-testid="snapshot-timeline-event"
            >
              <div class="flex items-start justify-between gap-2">
                <div class="min-w-0">
                  <p class="text-xs font-medium text-stone-800">{timelineTitle(event)}</p>
                  <p class="mt-0.5 text-[10px] text-stone-400">
                    {new Date(event.createdAt).toLocaleString()}
                  </p>
                </div>
                <span class={`shrink-0 rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase
                             tracking-wide ${timelineBadgeClass(event.type)}`}>
                  {event.type}
                </span>
              </div>
              {#if lineage}
                <p class="mt-1 text-[10px] text-stone-500">{lineage}</p>
              {/if}
              {#if event.note}
                <p class="mt-1 rounded border border-amber-100 bg-amber-50 px-2 py-1 text-[10px] text-amber-800">
                  {event.note}
                </p>
              {/if}
              {#if recoveryPoint}
                <p class="mt-1 break-all text-[10px] text-stone-500">
                  Recovery point: {recoveryPoint.manifestPath}
                </p>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </section>

    <!-- Saved snapshots list -->
    <section class="px-4 py-3 border-b border-stone-100 space-y-2">
      <h3 class="text-[10px] font-semibold uppercase tracking-wide text-stone-500">
        Saved Snapshots {#if !loading}({snapshots.length}){/if}
      </h3>

      {#if error}
        <div class="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
             data-testid="snapshot-error">
          {error}
        </div>
      {/if}

      {#if loading}
        <p class="text-xs text-stone-400">Loading…</p>
      {:else if snapshots.length === 0}
        <div class="rounded-lg border border-dashed border-stone-200 bg-stone-50 px-3 py-4
                    text-xs text-stone-400 text-center">
          No snapshots yet.
        </div>
      {:else}
        <div class="space-y-1.5">
          {#each snapshots as snapshot (snapshot.name)}
            <div
              class="rounded-xl border border-stone-200 bg-stone-50 px-3 py-2.5"
              data-testid="snapshot-row"
            >
              <div class="flex items-start justify-between gap-2">
                <div class="min-w-0">
                  <div class="flex items-center gap-1.5">
                    <p class="truncate text-xs font-medium text-stone-800">{snapshot.name}</p>
                    {#if snapshots.length >= 2}
                      <span class={`rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase
                                   tracking-wide ${snapshotTagClass(snapshot.name)}`}>
                        {snapshot.name === compareFrom ? 'From' : snapshot.name === compareTo ? 'To' : ''}
                      </span>
                    {/if}
                  </div>
                  <p class="mt-0.5 text-[10px] text-stone-400">
                    {new Date(snapshot.createdAt).toLocaleString()}
                  </p>
                </div>
                <button
                  onclick={() => onRestore(snapshot.name)}
                  disabled={restoringName !== null}
                  aria-label={`Revert Current Project to This Snapshot: ${snapshot.name}`}
                  class="shrink-0 rounded border border-stone-200 bg-white px-2 py-1 text-[10px]
                         font-medium text-stone-600 hover:bg-stone-50 disabled:text-stone-400
                         disabled:bg-stone-100 cursor-default"
                  data-testid="restore-snapshot-btn"
                >
                  {restoringName === snapshot.name ? '…' : 'Revert Current Project'}
                </button>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </section>

    <!-- Compare controls -->
    <section class="px-4 py-3 border-b border-stone-100 space-y-2">
      <h3 class="text-[10px] font-semibold uppercase tracking-wide text-stone-500">Compare</h3>
      <div class="flex gap-2">
        <label class="flex-1 flex flex-col gap-0.5 text-[10px] text-stone-500">
          From
          <select
            bind:value={compareFrom}
            class="rounded border border-stone-200 bg-stone-50 px-2 py-1.5 text-xs
                   text-stone-700 focus:outline-none focus:ring-1 focus:ring-stone-400"
            data-testid="compare-from-select"
          >
            {#each snapshots as snapshot (snapshot.name)}
              <option value={snapshot.name}>{snapshot.name}</option>
            {/each}
          </select>
        </label>
        <label class="flex-1 flex flex-col gap-0.5 text-[10px] text-stone-500">
          To
          <select
            bind:value={compareTo}
            class="rounded border border-stone-200 bg-stone-50 px-2 py-1.5 text-xs
                   text-stone-700 focus:outline-none focus:ring-1 focus:ring-stone-400"
            data-testid="compare-to-select"
          >
            {#each snapshots as snapshot (snapshot.name)}
              <option value={snapshot.name}>{snapshot.name}</option>
            {/each}
          </select>
        </label>
      </div>
      <button
        onclick={submitCompare}
        disabled={snapshots.length < 2 || !compareFrom || !compareTo || compareFrom === compareTo || comparing}
        class="w-full rounded-lg bg-stone-800 px-3 py-1.5 text-xs font-medium text-white
               transition-colors hover:bg-stone-700 disabled:bg-stone-300 cursor-default
               disabled:cursor-not-allowed"
        data-testid="compare-snapshots-btn"
      >
        {comparing ? 'Comparing…' : 'Compare'}
      </button>
    </section>

    <!-- Diff results -->
    {#if compareLoaded}
      <section class="px-4 py-3 space-y-3" data-testid="snapshot-diff-list">
        <!-- Summary bar -->
        <div class="flex items-center justify-between">
          <p class="text-xs font-medium text-stone-700">
            {allDiffs.length} {allDiffs.length === 1 ? 'change' : 'changes'}
            {#if mergedTree}
              — {mergedTree.fromSnapshot} → {mergedTree.toSnapshot}
            {/if}
          </p>
          {#if compareLoaded}
            <button
              onclick={onExitCompare}
              class="text-[10px] text-stone-400 hover:text-stone-600 cursor-default underline"
            >Exit compare</button>
          {/if}
        </div>

        {#if allDiffs.length === 0}
          <div class="rounded-xl border border-dashed border-emerald-200 bg-emerald-50/60
                      px-4 py-5 text-center">
            <p class="text-xs font-medium text-emerald-700">No changes</p>
            <p class="text-xs text-emerald-600 mt-0.5">These snapshots describe the same state.</p>
          </div>
        {:else}
          <!-- Severity chips -->
          <div class="flex flex-wrap gap-1.5">
            {#each severitySummary as item (item.severity)}
              <span class={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase
                            tracking-wide ${severityBadgeClass(item.severity)}`}>
                {item.count} {item.severity}
              </span>
            {/each}
          </div>
          <!-- Change type chips -->
          <div class="flex flex-wrap gap-1">
            {#each changeSummary as item (item.changeType)}
              <span class="rounded-full bg-stone-100 px-2 py-0.5 text-[10px] text-stone-600">
                {item.count} {formatChangeType(item.changeType)}
              </span>
            {/each}
          </div>

          <!-- Grouped diff rows -->
          {#each groupedDiffs as group (group.severity)}
            <div class="space-y-1.5">
              <h4 class="text-[10px] font-semibold uppercase tracking-wide text-stone-400">
                {group.severity} Priority
              </h4>
              {#each group.entries as diff, idx (`${diff.nodeId}-${diff.changeType}-${idx}`)}
                {@const isHighlighted = highlightedNodeId === diff.nodeId || highlightedNodeId === `ghost:${diff.nodeId}`}
                {#if onDiffNodeSelect}
                  <button
                    type="button"
                    onclick={() => onDiffNodeSelect(diff.nodeId)}
                    data-node-id={diff.nodeId}
                    class={`w-full rounded-xl border px-3 py-3 shadow-sm transition-shadow text-left
                      ${severityClass(diff.severity)}
                      ${isHighlighted ? 'ring-2 ring-sky-400 ring-offset-1' : ''}
                      cursor-pointer hover:shadow-md`}
                    data-testid="snapshot-diff-row"
                  >
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
                  </button>
                {:else}
                  <div
                    data-node-id={diff.nodeId}
                    class={`rounded-xl border px-3 py-3 shadow-sm transition-shadow
                      ${severityClass(diff.severity)}
                      ${isHighlighted ? 'ring-2 ring-sky-400 ring-offset-1' : ''}`}
                    data-testid="snapshot-diff-row"
                  >
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
                  </div>
                {/if}
              {/each}
            </div>
          {/each}
        {/if}
      </section>
    {/if}
  </div>
</div>
