<svelte:options runes />

<script lang="ts">
  import type { RecoveryPoint } from '../../../shared/types'

  interface Props {
    recoveryPoint: RecoveryPoint
    applying: boolean
    error: string | null
    onConfirm: () => Promise<void>
    onCancel: () => void
  }

  let { recoveryPoint, applying, error, onConfirm, onCancel }: Props = $props()

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape' && !applying) onCancel()
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onConfirm()
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
  onclick={(e) => { if (e.target === e.currentTarget && !applying) onCancel() }}
  onkeydown={handleKeyDown}
>
  <div
    class="bg-white rounded-xl shadow-xl w-full max-w-md mx-4 flex flex-col overflow-hidden"
    role="dialog"
    aria-modal="true"
    aria-label="Recover current project"
    data-testid="recovery-dialog"
  >
    <div class="px-5 py-4 border-b border-stone-100">
      <h2 class="text-sm font-semibold text-stone-800">Recover Current Project</h2>
      <p class="text-xs text-stone-400 mt-0.5">
        The current project will be replaced with this saved recovery point.
      </p>
    </div>

    <div class="px-5 py-4 space-y-3">
      {#if error}
        <div class="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
             data-testid="recovery-dialog-error">
          {error}
        </div>
      {/if}

      <div class="rounded-lg border border-stone-200 bg-stone-50 px-3 py-2">
        <p class="text-[10px] font-semibold uppercase tracking-wide text-stone-500">Recovery Point</p>
        <p class="mt-0.5 text-xs text-stone-700">{new Date(recoveryPoint.createdAt).toLocaleString()}</p>
        <p class="mt-1 break-all text-[10px] text-stone-500">{recoveryPoint.manifestPath}</p>
      </div>
    </div>

    <div class="flex gap-2 px-5 py-3 border-t border-stone-100">
      <button
        onclick={onCancel}
        disabled={applying}
        class="flex-1 bg-white hover:bg-stone-50 text-stone-600 text-sm font-medium
               px-4 py-2 rounded-lg border border-stone-200 transition-colors cursor-default
               disabled:text-stone-400 disabled:cursor-not-allowed"
      >Cancel</button>
      <button
        onclick={onConfirm}
        disabled={applying}
        class="flex-1 bg-stone-800 hover:bg-stone-700 disabled:bg-stone-300
               text-white text-sm font-medium px-4 py-2 rounded-lg
               transition-colors cursor-default disabled:cursor-not-allowed"
        data-testid="recovery-confirm-btn"
      >{applying ? 'Recovering...' : 'Recover'}</button>
    </div>
  </div>
</div>
