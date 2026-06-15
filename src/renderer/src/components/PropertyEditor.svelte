<svelte:options runes />

<script lang="ts">
  // The Properties section of the DetailPane, extracted so DetailPane stays
  // lean. Renders, in order:
  //   1. a template selector (bind / change / unbind the node's template)
  //   2. typed template fields (TemplateFieldControl each), coerced on commit
  //   3. ad-hoc (non-template) properties as untyped string rows, each with a
  //      "promote to template field" action
  //   4. an add-property form (ad-hoc, untyped)
  import { tick } from 'svelte'
  import type { ManifestNode, NodeTemplate, PropertyType } from '../../../shared/types'
  import type { MergedTreeNode } from '../../../shared/merged-tree'
  import {
    validatePropertyKey,
    validatePropertyValue,
    coercePropertyValue,
  } from '../../../shared/validation'
  import TemplateFieldControl from './TemplateFieldControl.svelte'

  interface Props {
    node: ManifestNode | MergedTreeNode
    templates: Record<string, NodeTemplate>
    readOnly?: boolean
    onUpdate: (id: string, changes: {
      name?: string
      properties?: Record<string, string | number | boolean | null>
      templateId?: string | null
    }) => Promise<void>
    onPromoteField: (key: string, type: PropertyType) => Promise<void>
    onError: (msg: string) => void
  }

  let { node, templates, readOnly = false, onUpdate, onPromoteField, onError }: Props = $props()

  const PROMOTABLE_TYPES: PropertyType[] = ['string', 'number', 'boolean', 'date', 'version']

  // ─── Derived shape ──────────────────────────────────────────────────────────

  const templateId = $derived(node.templateId ?? null)
  const template = $derived(templateId ? templates[templateId] ?? null : null)
  const templateIds = $derived(Object.keys(templates).sort())
  const templateFieldEntries = $derived(template ? Object.entries(template.fields) : [])
  const templateFieldKeys = $derived(new Set(templateFieldEntries.map(([k]) => k)))
  const adHocEntries = $derived(
    Object.entries(node.properties ?? {}).filter(([k]) => !templateFieldKeys.has(k))
  )

  // ─── Template binding ───────────────────────────────────────────────────────

  function changeTemplate(value: string) {
    if (readOnly) return
    onUpdate(node.id, { templateId: value === '' ? null : value })
  }

  // ─── Typed-field commits ────────────────────────────────────────────────────

  let fieldErrors = $state<Record<string, string>>({})

  // Reset per-field errors when the selected node or its template changes, so a
  // stale error from node A never shows against the same-named field on node B.
  let _prevIdentity = ''
  $effect(() => {
    const identity = node.id + '|' + (templateId ?? '')
    if (identity !== _prevIdentity) {
      _prevIdentity = identity
      fieldErrors = {}
    }
  })

  function setFieldError(key: string, msg: string) {
    fieldErrors = { ...fieldErrors, [key]: msg }
  }

  function commitField(key: string, raw: string | number | boolean) {
    if (readOnly) return
    const field = template?.fields[key]
    if (!field) return

    // Empty text/select clears the field (unset) rather than failing validation.
    if (typeof raw === 'string' && raw.trim() === '') {
      setFieldError(key, '')
      const props = { ...(node.properties ?? {}) }
      delete props[key]
      onUpdate(node.id, { properties: props })
      return
    }

    const result = coercePropertyValue(raw, field)
    if (!result.valid) {
      setFieldError(key, result.message ?? 'Invalid value')
      return
    }
    setFieldError(key, '')
    onUpdate(node.id, { properties: { ...(node.properties ?? {}), [key]: result.value ?? null } })
  }

  // ─── Ad-hoc property editing (untyped strings) ──────────────────────────────

  let editingKey = $state<string | null>(null)
  let editingValue = $state('')
  let editingError = $state<string | null>(null)
  let editInputEl = $state<HTMLInputElement | null>(null)

  function startEdit(key: string) {
    if (readOnly) return
    editingKey = key
    editingValue = String(node.properties?.[key] ?? '')
    editingError = null
  }

  async function commitEdit(key: string) {
    if (readOnly) return
    const v = editingValue.trim()
    const check = validatePropertyValue(v)
    if (!check.valid) { editingError = check.message ?? 'Invalid value'; return }
    editingKey = null
    editingError = null
    await onUpdate(node.id, { properties: { ...(node.properties ?? {}), [key]: v } })
  }

  function handleEditKeyDown(e: KeyboardEvent, key: string) {
    if (e.key === 'Enter') commitEdit(key)
    if (e.key === 'Escape') { editingKey = null; editingError = null }
  }

  async function deleteProperty(key: string) {
    if (readOnly) return
    const props = { ...(node.properties ?? {}) }
    delete props[key]
    await onUpdate(node.id, { properties: props })
  }

  // ─── Promote ad-hoc → typed template field ──────────────────────────────────

  let promotingKey = $state<string | null>(null)
  let promoteType = $state<PropertyType>('string')

  function startPromote(key: string) {
    if (readOnly || !template) return
    promotingKey = key
    promoteType = 'string'
  }

  async function confirmPromote(key: string) {
    promotingKey = null
    await onPromoteField(key, promoteType)
  }

  // ─── Add ad-hoc property ────────────────────────────────────────────────────

  let newKey = $state('')
  let newValue = $state('')
  let newKeyError = $state<string | null>(null)
  let newValueError = $state<string | null>(null)

  async function addProperty() {
    if (readOnly) { onError('Cannot edit in read-only mode.'); return }
    const k = newKey.trim()
    const v = newValue.trim()
    if (!k) { newKeyError = 'Key is required'; return }
    const keyVal = validatePropertyKey(k)
    if (!keyVal.valid) { newKeyError = keyVal.message ?? 'Invalid key'; return }
    if (k in (node.properties ?? {})) { newKeyError = 'Key already exists'; return }
    const valVal = validatePropertyValue(v)
    if (!valVal.valid) { newValueError = valVal.message ?? 'Invalid value'; return }

    newKeyError = null
    newValueError = null
    newKey = ''
    newValue = ''
    await onUpdate(node.id, { properties: { ...(node.properties ?? {}), [k]: v } })
  }

  $effect(() => {
    if (editingKey !== null) {
      void tick().then(() => { editInputEl?.focus(); editInputEl?.select() })
    }
  })
</script>

<!-- Template selector -->
<div class="mb-4 flex items-center gap-2" data-testid="template-selector-row">
  <span class="text-xs font-semibold text-stone-400 uppercase tracking-wide w-32 shrink-0">Template</span>
  <select
    class="flex-1 text-sm text-stone-700 border border-stone-300 rounded px-2 py-1 bg-white
           focus:outline-none focus:ring-1 focus:ring-stone-400 disabled:bg-stone-50
           disabled:text-stone-400"
    value={templateId ?? ''}
    disabled={readOnly}
    onchange={(e) => changeTemplate((e.currentTarget as HTMLSelectElement).value)}
    data-testid="template-selector"
  >
    <option value="">Freeform (no template)</option>
    {#each templateIds as id (id)}
      <option value={id}>{templates[id].label}</option>
    {/each}
  </select>
</div>

<!-- Typed template fields -->
{#if templateFieldEntries.length > 0}
  <div class="space-y-2 mb-4" data-testid="template-fields">
    {#each templateFieldEntries as [key, field] (node.id + '|' + key + '|' + String(node.properties?.[key] ?? ''))}
      <TemplateFieldControl
        fieldKey={key}
        {field}
        value={node.properties?.[key]}
        disabled={readOnly}
        error={fieldErrors[key] || null}
        onCommit={(raw) => commitField(key, raw)}
      />
    {/each}
  </div>
{/if}

<!-- Ad-hoc (untyped) properties -->
{#if adHocEntries.length > 0}
  <div class="space-y-1 mb-4">
    {#if template}
      <p class="text-[10px] font-semibold text-stone-400 uppercase tracking-wide mb-1">Other properties</p>
    {/if}
    {#each adHocEntries as [key, value] (key)}
      <div class="flex items-center gap-2 group">
        <span class="text-xs font-mono text-stone-500 w-32 shrink-0 truncate">{key}</span>

        {#if editingKey === key}
          <input
            type="text"
            bind:this={editInputEl}
            bind:value={editingValue}
            onkeydown={(e) => handleEditKeyDown(e, key)}
            onblur={() => commitEdit(key)}
            class="flex-1 text-sm text-stone-700 border border-stone-300 rounded px-2 py-0.5
                   focus:outline-none focus:ring-1 focus:ring-stone-400 selectable"
            data-testid="prop-value-input"
          />
        {:else}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <span
            class="flex-1 text-sm text-stone-700 truncate cursor-text hover:text-stone-900"
            onclick={() => startEdit(key)}
            data-testid="prop-value"
          >{String(value)}</span>
        {/if}

        {#if template && !readOnly}
          <button
            class="text-[10px] text-stone-300 hover:text-sky-500 opacity-0 group-hover:opacity-100
                   transition-opacity shrink-0"
            onclick={() => startPromote(key)}
            title="Promote to a typed template field"
            data-testid="promote-prop"
          >→ typed</button>
        {/if}

        <button
          class="text-stone-300 hover:text-red-400 opacity-0 group-hover:opacity-100
                 transition-opacity text-xs shrink-0 disabled:opacity-0"
          onclick={() => deleteProperty(key)}
          disabled={readOnly}
          aria-label="Delete property {key}"
          data-testid="delete-prop"
        >✕</button>
      </div>

      {#if editingKey === key && editingError}
        <p class="text-xs text-red-600 ml-[8.5rem]">{editingError}</p>
      {/if}

      {#if promotingKey === key}
        <div class="flex items-center gap-2 ml-[8.5rem] mb-1" data-testid="promote-row">
          <select
            bind:value={promoteType}
            class="text-xs border border-stone-300 rounded px-1.5 py-1 bg-white
                   focus:outline-none focus:ring-1 focus:ring-stone-400"
            data-testid="promote-type"
          >
            {#each PROMOTABLE_TYPES as t (t)}
              <option value={t}>{t}</option>
            {/each}
          </select>
          <button
            class="text-xs bg-stone-800 text-white px-2 py-1 rounded cursor-default"
            onclick={() => confirmPromote(key)}
            data-testid="promote-confirm"
          >Make typed</button>
          <button
            class="text-xs text-stone-500 px-2 py-1 rounded hover:bg-stone-100 cursor-default"
            onclick={() => { promotingKey = null }}
          >Cancel</button>
        </div>
      {/if}
    {/each}
  </div>
{:else if templateFieldEntries.length === 0}
  <p class="text-xs text-stone-400 mb-4">No properties yet</p>
{/if}

<!-- Add ad-hoc property form -->
{#if !readOnly}
  <div class="border-t border-stone-100 pt-3">
    <p class="text-xs font-semibold text-stone-400 uppercase tracking-wide mb-2">Add Property</p>
    <div class="flex gap-2">
      <div class="flex flex-col gap-1 flex-1">
        <input
          type="text"
          bind:value={newKey}
          placeholder="key"
          class="text-sm border border-stone-200 rounded px-2 py-1.5 focus:outline-none
                 focus:ring-1 focus:ring-stone-400 selectable"
          data-testid="new-prop-key"
          onkeydown={(e) => { if (e.key === 'Enter') addProperty() }}
        />
        {#if newKeyError}<p class="text-xs text-red-600">{newKeyError}</p>{/if}
      </div>
      <div class="flex flex-col gap-1 flex-1">
        <input
          type="text"
          bind:value={newValue}
          placeholder="value"
          class="text-sm border border-stone-200 rounded px-2 py-1.5 focus:outline-none
                 focus:ring-1 focus:ring-stone-400 selectable"
          data-testid="new-prop-value"
          onkeydown={(e) => { if (e.key === 'Enter') addProperty() }}
        />
        {#if newValueError}<p class="text-xs text-red-600">{newValueError}</p>{/if}
      </div>
      <button
        onclick={addProperty}
        disabled={!newKey.trim()}
        class="shrink-0 bg-stone-800 hover:bg-stone-700 disabled:bg-stone-300
               text-white text-sm px-3 py-1.5 rounded transition-colors
               cursor-default disabled:cursor-not-allowed self-start"
        data-testid="add-prop-btn"
      >Add</button>
    </div>
  </div>
{/if}
