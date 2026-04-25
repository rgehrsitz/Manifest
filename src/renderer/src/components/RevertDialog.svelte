<svelte:options runes />

<script lang="ts">
  interface Props {
    snapshotName: string
    noteRequired: boolean
    error: string | null
    reverting: boolean
    onConfirm: (note: string | null) => Promise<void>
    onCancel: () => void
  }

  let { snapshotName, noteRequired, error, reverting, onConfirm, onCancel }: Props = $props()

  let note = $state('')

  async function submit() {
    if (reverting) return
    if (noteRequired && !note.trim()) return
    await onConfirm(note.trim() || null)
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape' && !reverting) onCancel()
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit()
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
  onclick={(e) => { if (e.target === e.currentTarget && !reverting) onCancel() }}
  onkeydown={handleKeyDown}
>
  <div
    class="bg-white rounded-xl shadow-xl w-full max-w-md mx-4 flex flex-col overflow-hidden"
    role="dialog"
    aria-modal="true"
    aria-label={`Revert current project to ${snapshotName}`}
    data-testid="revert-dialog"
  >
    <div class="px-5 py-4 border-b border-stone-100">
      <h2 class="text-sm font-semibold text-stone-800">Revert Current Project</h2>
      <p class="text-xs text-stone-400 mt-0.5">
        The current project will match "{snapshotName}". Saved snapshots and later timeline events will remain unchanged.
      </p>
    </div>

    <div class="px-5 py-4 space-y-3">
      {#if error}
        <div class="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
             data-testid="revert-dialog-error">
          {error}
        </div>
      {/if}

      <label class="block">
        <span class="text-xs font-medium text-stone-700">
          Revert note {noteRequired ? '' : '(optional)'}
        </span>
        <textarea
          bind:value={note}
          rows="4"
          required={noteRequired}
          disabled={reverting}
          class="mt-1 w-full resize-none rounded-lg border border-stone-200 bg-stone-50 px-3 py-2
                 text-sm text-stone-800 placeholder-stone-300 focus:outline-none focus:ring-1
                 focus:ring-stone-400 disabled:text-stone-400 selectable"
          placeholder="Why are you reverting?"
          data-testid="revert-note-input"
        ></textarea>
      </label>
    </div>

    <div class="flex gap-2 px-5 py-3 border-t border-stone-100">
      <button
        onclick={onCancel}
        disabled={reverting}
        class="flex-1 bg-white hover:bg-stone-50 text-stone-600 text-sm font-medium
               px-4 py-2 rounded-lg border border-stone-200 transition-colors cursor-default
               disabled:text-stone-400 disabled:cursor-not-allowed"
      >Cancel</button>
      <button
        onclick={submit}
        disabled={reverting || (noteRequired && !note.trim())}
        class="flex-1 bg-stone-800 hover:bg-stone-700 disabled:bg-stone-300
               text-white text-sm font-medium px-4 py-2 rounded-lg
               transition-colors cursor-default disabled:cursor-not-allowed"
        data-testid="revert-confirm-btn"
      >{reverting ? 'Reverting...' : 'Revert'}</button>
    </div>
  </div>
</div>
