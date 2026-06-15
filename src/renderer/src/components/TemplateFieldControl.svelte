<svelte:options runes />

<script lang="ts">
  // A single typed input for one template field. Presentational + controlled:
  // it reports committed values via onCommit and renders an error passed by the
  // parent. Text-like types (string/number/version) commit on blur/Enter;
  // enum/date/boolean commit immediately on change.
  //
  // The parent (PropertyEditor) keys each control by
  // `${nodeId}|${fieldKey}|${committedValue}`, so the component is recreated —
  // and the draft re-seeded from `value` — whenever the node, field, OR the
  // committed value changes (e.g. after the backend normalizes "05" → 5).
  // This avoids $effect-based prop→draft syncing and stale-draft pitfalls.
  import type { TemplateField } from '../../../shared/types'
  import { coercePropertyValue } from '../../../shared/validation'

  interface Props {
    fieldKey: string
    field: TemplateField
    value: string | number | boolean | null | undefined
    disabled?: boolean
    error?: string | null
    onCommit: (raw: string | number | boolean) => void
  }

  let { fieldKey, field, value, disabled = false, error = null, onCommit }: Props = $props()

  function asString(v: unknown): string {
    return v === null || v === undefined ? '' : String(v)
  }

  // Draft for text-like inputs (string/number/version). Intentionally seeded
  // ONCE from `value` at creation — the parent's keyed {#each} (which includes
  // the committed value) recreates and re-seeds this control whenever the node,
  // field, or committed value changes. No prop→draft $effect syncing by design.
  // svelte-ignore state_referenced_locally
  let draft = $state(asString(value))

  function commitText() {
    // Reflect the canonical stored form immediately. The parent re-coerces
    // authoritatively, but doing it here too means a no-op normalization (e.g.
    // typing "05" when the field already holds 5) still updates the visible
    // draft — the value-in-key alone can't catch that because the stored
    // primitive never changes. Empty/invalid drafts are left as typed so the
    // parent can clear the field or surface an error.
    const result = coercePropertyValue(draft, field)
    if (result.valid && result.value !== null && result.value !== undefined) {
      draft = String(result.value)
    }
    onCommit(draft)
  }

  function handleTextKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault()
      ;(e.target as HTMLInputElement).blur()
    }
  }

  const isSet = $derived(value !== undefined && value !== null && value !== '')
</script>

<div class="flex flex-col gap-1" data-testid={`tpl-field-${fieldKey}`}>
  <div class="flex items-center gap-2">
    <span class="text-xs font-mono text-stone-500 w-32 shrink-0 truncate" title={field.label ?? fieldKey}>
      {field.label ?? fieldKey}
      {#if field.required}<span class="text-red-400" title="Required">*</span>{/if}
    </span>

    {#if field.type === 'enum'}
      <select
        class="flex-1 text-sm text-stone-700 border border-stone-300 rounded px-2 py-1
               focus:outline-none focus:ring-1 focus:ring-stone-400 disabled:bg-stone-50
               disabled:text-stone-400 bg-white"
        value={asString(value)}
        {disabled}
        onchange={(e) => onCommit((e.currentTarget as HTMLSelectElement).value)}
        data-testid={`tpl-input-${fieldKey}`}
      >
        <option value="">— select —</option>
        {#each field.options ?? [] as opt (opt)}
          <option value={opt}>{opt}</option>
        {/each}
      </select>
    {:else if field.type === 'boolean'}
      <label class="flex flex-1 items-center gap-2 text-sm text-stone-700">
        <input
          type="checkbox"
          class="h-4 w-4 rounded border-stone-300 text-stone-700 focus:ring-stone-400
                 disabled:opacity-50"
          checked={value === true}
          {disabled}
          onchange={(e) => onCommit((e.currentTarget as HTMLInputElement).checked)}
          data-testid={`tpl-input-${fieldKey}`}
        />
        <span class="text-xs text-stone-400">{value === true ? 'true' : 'false'}</span>
      </label>
    {:else if field.type === 'date'}
      <input
        type="date"
        class="flex-1 text-sm text-stone-700 border border-stone-300 rounded px-2 py-1
               focus:outline-none focus:ring-1 focus:ring-stone-400 disabled:bg-stone-50
               disabled:text-stone-400 selectable"
        value={asString(value)}
        {disabled}
        onchange={(e) => onCommit((e.currentTarget as HTMLInputElement).value)}
        data-testid={`tpl-input-${fieldKey}`}
      />
    {:else}
      <!-- string, number, version -->
      <input
        type={field.type === 'number' ? 'number' : 'text'}
        step={field.type === 'number' ? 'any' : undefined}
        bind:value={draft}
        placeholder={field.type === 'version' ? 'e.g. v2.3.1' : isSet ? '' : 'unset'}
        class="flex-1 text-sm text-stone-700 border border-stone-300 rounded px-2 py-1
               focus:outline-none focus:ring-1 focus:ring-stone-400 disabled:bg-stone-50
               disabled:text-stone-400 selectable"
        {disabled}
        onblur={commitText}
        onkeydown={handleTextKeyDown}
        data-testid={`tpl-input-${fieldKey}`}
      />
    {/if}
  </div>

  {#if error}
    <p class="text-xs text-red-600 ml-[8.5rem]" data-testid={`tpl-error-${fieldKey}`}>{error}</p>
  {:else if field.required && !isSet}
    <p class="text-[10px] text-amber-600 ml-[8.5rem]" data-testid={`tpl-required-${fieldKey}`}>Required — not set</p>
  {/if}
</div>
