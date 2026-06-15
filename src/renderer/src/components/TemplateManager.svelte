<svelte:options runes />

<script lang="ts">
  // Modal for managing node templates: list on the left, editor on the right.
  // Handlers return Promise<string | null> — null on success, an error message
  // on failure (e.g. templateUpdate rejected because it would invalidate a
  // bound node). Errors render inline; the templates prop refreshes after each
  // successful op via App.applyProject.
  import { onMount, tick } from 'svelte'
  import type { NodeTemplate, TemplateField, PropertyType } from '../../../shared/types'
  import {
    validateTemplateId,
    validatePropertyKey,
    validateTypedPropertyValue,
    templateFields,
    templateLabel,
  } from '../../../shared/validation'

  interface Props {
    templates: Record<string, NodeTemplate>
    onCreate: (id: string, template: NodeTemplate) => Promise<string | null>
    onUpdate: (id: string, template: NodeTemplate) => Promise<string | null>
    onDelete: (id: string) => Promise<string | null>
    onClose: () => void
  }

  let { templates, onCreate, onUpdate, onDelete, onClose }: Props = $props()

  const TYPES: PropertyType[] = ['string', 'number', 'boolean', 'date', 'version', 'enum']

  interface DraftField {
    key: string
    type: PropertyType
    optionsText: string
    required: boolean
    // Preserved across edits even though the form doesn't expose them, so
    // saving an existing template never drops field metadata it already had.
    label?: string
    default?: string | number | boolean | null
  }

  // editingId === null → creating a new template.
  let editingId = $state<string | null>(null)
  let draftId = $state('')
  let draftLabel = $state('')
  let draftDescription = $state('')
  let draftFields = $state<DraftField[]>([])
  let formError = $state<string | null>(null)
  let busy = $state(false)
  // While creating, the id auto-tracks the label (slugified) until the user
  // edits the id field by hand. Editing an existing template never auto-derives.
  let idEdited = $state(false)

  const templateIds = $derived(Object.keys(templates).sort())

  function slugify(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
  }

  // The id that will actually be used on create (auto-derived unless overridden).
  const effectiveId = $derived(editingId ?? (draftId.trim() || slugify(draftLabel)))

  // Inline validation. Null = ok.
  const idError = $derived.by<string | null>(() => {
    if (editingId) return null
    // Pristine form: don't nag before the user has typed anything.
    if (!draftLabel.trim() && !draftId.trim()) return null
    if (!effectiveId) return 'Add a label (or id) to generate a template id'
    const check = validateTemplateId(effectiveId)
    if (!check.valid) return check.message ?? 'Invalid id'
    if (templates[effectiveId]) return `A template with id "${effectiveId}" already exists`
    return null
  })

  // Per-row key errors (by index). Empty keys are ignored (dropped on save).
  const keyErrors = $derived.by<Record<number, string>>(() => {
    const errors: Record<number, string> = {}
    const seen = new Set<string>()
    draftFields.forEach((f, i) => {
      const key = f.key.trim()
      if (!key) return
      const check = validatePropertyKey(key)
      if (!check.valid) { errors[i] = check.message ?? 'Invalid key'; return }
      if (seen.has(key)) { errors[i] = `Duplicate key "${key}"`; return }
      seen.add(key)
    })
    return errors
  })

  const canSave = $derived(
    draftLabel.trim().length > 0 && !idError && Object.keys(keyErrors).length === 0
  )

  function onLabelInput(value: string) {
    draftLabel = value
    if (!editingId && !idEdited) draftId = slugify(value)
  }

  function onIdInput(value: string) {
    idEdited = true
    draftId = value
  }

  function fieldToDraft(key: string, f: TemplateField): DraftField {
    return {
      key,
      type: f.type,
      optionsText: (f.options ?? []).join(', '),
      required: f.required ?? false,
      label: f.label,
      default: f.default,
    }
  }

  function loadTemplate(id: string) {
    const tpl = templates[id]
    if (!tpl) return
    editingId = id
    draftId = id
    idEdited = true
    // Coerce to strings — a hand-edited template may have a non-string label or
    // description, which would otherwise break the form (e.g. later .trim()).
    draftLabel = typeof tpl.label === 'string' ? tpl.label : ''
    draftDescription = typeof tpl.description === 'string' ? tpl.description : ''
    // templateFields() is null-safe — a structurally-invalid template (loaded
    // non-fatally with a warning) yields {} rather than throwing here.
    draftFields = Object.entries(templateFields(tpl)).map(([k, f]) => fieldToDraft(k, f))
    formError = null
  }

  function startNew() {
    editingId = null
    draftId = ''
    idEdited = false
    draftLabel = ''
    draftDescription = ''
    draftFields = []
    formError = null
  }

  function addField() {
    draftFields = [...draftFields, { key: '', type: 'string', optionsText: '', required: false }]
  }

  function removeField(index: number) {
    draftFields = draftFields.filter((_, i) => i !== index)
  }

  function buildTemplate(): NodeTemplate {
    const fields: Record<string, TemplateField> = {}
    for (const f of draftFields) {
      const key = f.key.trim()
      if (!key) continue
      const field: TemplateField = { type: f.type }
      if (f.required) field.required = true
      if (f.type === 'enum') {
        field.options = f.optionsText.split(',').map(s => s.trim()).filter(Boolean)
      }
      // Preserve metadata the form doesn't edit (label is type-agnostic; a
      // default is carried over only while it remains valid for the field type,
      // so changing a field's type doesn't persist a now-invalid default).
      if (f.label !== undefined) field.label = f.label
      if (f.default !== undefined && f.default !== null && validateTypedPropertyValue(f.default, field).valid) {
        field.default = f.default
      }
      fields[key] = field
    }
    const template: NodeTemplate = { label: draftLabel.trim(), fields }
    if (draftDescription.trim()) template.description = draftDescription.trim()
    return template
  }

  async function save() {
    formError = null
    if (!draftLabel.trim()) { formError = 'Label is required'; return }
    if (idError) { formError = idError; return }
    const firstKeyError = Object.values(keyErrors)[0]
    if (firstKeyError) { formError = firstKeyError; return }
    busy = true
    try {
      const template = buildTemplate()
      if (editingId) {
        const err = await onUpdate(editingId, template)
        if (err) { formError = err; return }
      } else {
        const id = effectiveId
        const err = await onCreate(id, template)
        if (err) { formError = err; return }
        editingId = id
        draftId = id
        idEdited = true
      }
    } finally {
      busy = false
    }
  }

  async function remove(id: string) {
    formError = null
    busy = true
    try {
      const err = await onDelete(id)
      if (err) { formError = err; return }
      if (editingId === id) startNew()
    } finally {
      busy = false
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') onClose()
  }

  let labelInput: HTMLInputElement | null = $state(null)
  onMount(async () => {
    if (templateIds.length > 0) loadTemplate(templateIds[0])
    else startNew()
    await tick()
    labelInput?.focus()
  })
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
  onclick={(e) => { if (e.target === e.currentTarget) onClose() }}
  onkeydown={handleKeyDown}
>
  <div
    class="bg-white rounded-xl shadow-xl w-full max-w-3xl mx-4 flex flex-col overflow-hidden"
    style="height: min(80vh, 640px)"
    role="dialog"
    aria-modal="true"
    aria-label="Manage templates"
    data-testid="template-manager"
  >
    <div class="px-5 py-4 border-b border-stone-100 flex items-center justify-between">
      <div>
        <h2 class="text-sm font-semibold text-stone-800">Templates</h2>
        <p class="text-xs text-stone-400 mt-0.5">Define typed property schemas for your nodes.</p>
      </div>
      <button
        onclick={onClose}
        class="text-stone-400 hover:text-stone-600 text-sm cursor-default"
        aria-label="Close"
        data-testid="template-manager-close"
      >✕</button>
    </div>

    <div class="flex flex-1 overflow-hidden">
      <!-- List -->
      <div class="w-56 shrink-0 border-r border-stone-100 flex flex-col overflow-hidden">
        <div class="flex-1 overflow-y-auto py-2">
          {#each templateIds as id (id)}
            <button
              class="w-full text-left px-4 py-2 text-sm transition-colors
                     {editingId === id ? 'bg-stone-100 text-stone-900 font-medium' : 'text-stone-700 hover:bg-stone-50'}"
              onclick={() => loadTemplate(id)}
              data-testid="template-list-item"
            >
              <span class="block truncate">{templateLabel(templates[id], id)}</span>
              <span class="block truncate text-xs font-mono text-stone-400">{id}</span>
            </button>
          {/each}
          {#if templateIds.length === 0}
            <p class="px-4 py-2 text-xs text-stone-400">No templates yet.</p>
          {/if}
        </div>
        <div class="border-t border-stone-100 p-2">
          <button
            onclick={startNew}
            class="w-full text-sm bg-white hover:bg-stone-50 text-stone-700 border border-stone-200
                   rounded-lg px-3 py-1.5 cursor-default"
            data-testid="template-new"
          >+ New template</button>
        </div>
      </div>

      <!-- Editor -->
      <div class="flex-1 overflow-y-auto px-5 py-4">
        <div class="flex flex-col gap-3">
          <div class="flex gap-3">
            <label class="flex flex-col gap-1 flex-1">
              <span class="text-xs font-semibold text-stone-500 uppercase tracking-wide">Label</span>
              <input
                bind:this={labelInput}
                value={draftLabel}
                oninput={(e) => onLabelInput((e.currentTarget as HTMLInputElement).value)}
                type="text"
                placeholder="e.g. Software Item"
                class="text-sm border border-stone-300 rounded px-2 py-1.5 focus:outline-none
                       focus:ring-1 focus:ring-stone-400 selectable"
                data-testid="template-label"
              />
            </label>
            <label class="flex flex-col gap-1 w-48">
              <span class="text-xs font-semibold text-stone-500 uppercase tracking-wide">Id</span>
              {#if editingId}
                <span class="text-sm font-mono text-stone-400 px-2 py-1.5">{editingId}</span>
              {:else}
                <input
                  value={draftId}
                  oninput={(e) => onIdInput((e.currentTarget as HTMLInputElement).value)}
                  type="text"
                  placeholder="auto from label"
                  class="text-sm font-mono border rounded px-2 py-1.5 focus:outline-none
                         focus:ring-1 focus:ring-stone-400 selectable
                         {idError ? 'border-red-300' : 'border-stone-300'}"
                  data-testid="template-id"
                />
              {/if}
            </label>
          </div>
          {#if idError}
            <p class="text-xs text-red-600 -mt-1" data-testid="template-id-error">{idError}</p>
          {/if}

          <div class="flex items-center justify-between mt-1">
            <span class="text-xs font-semibold text-stone-500 uppercase tracking-wide">Fields</span>
            <button
              onclick={addField}
              class="text-xs text-stone-600 hover:text-stone-900 cursor-default"
              data-testid="template-add-field"
            >+ Add field</button>
          </div>

          <div class="flex flex-col gap-2" data-testid="template-fields-editor">
            {#each draftFields as field, i (i)}
              <div class="flex flex-col gap-1 rounded-lg border border-stone-100 p-2">
                <div class="flex items-center gap-2">
                  <input
                    bind:value={field.key}
                    type="text"
                    placeholder="key"
                    class="text-sm font-mono border rounded px-2 py-1 w-40
                           focus:outline-none focus:ring-1 focus:ring-stone-400 selectable
                           {keyErrors[i] ? 'border-red-300' : 'border-stone-300'}"
                    data-testid="field-key"
                  />
                  <select
                    bind:value={field.type}
                    class="text-sm border border-stone-300 rounded px-2 py-1 bg-white
                           focus:outline-none focus:ring-1 focus:ring-stone-400"
                    data-testid="field-type"
                  >
                    {#each TYPES as t (t)}<option value={t}>{t}</option>{/each}
                  </select>
                  <label class="flex items-center gap-1 text-xs text-stone-500">
                    <input type="checkbox" bind:checked={field.required} class="h-3.5 w-3.5" />
                    required
                  </label>
                  <button
                    onclick={() => removeField(i)}
                    class="ml-auto text-stone-300 hover:text-red-400 text-xs cursor-default"
                    aria-label="Remove field"
                    data-testid="field-remove"
                  >✕</button>
                </div>
                {#if field.type === 'enum'}
                  <input
                    bind:value={field.optionsText}
                    type="text"
                    placeholder="options, comma, separated"
                    class="text-sm border border-stone-200 rounded px-2 py-1
                           focus:outline-none focus:ring-1 focus:ring-stone-400 selectable"
                    data-testid="field-options"
                  />
                {/if}
                {#if keyErrors[i]}
                  <p class="text-xs text-red-600" data-testid="field-key-error">{keyErrors[i]}</p>
                {/if}
              </div>
            {/each}
            {#if draftFields.length === 0}
              <p class="text-xs text-stone-400">No fields. Add one to start typing properties.</p>
            {/if}
          </div>

          {#if formError}
            <p class="text-xs text-red-600" data-testid="template-form-error">{formError}</p>
          {/if}

          <div class="flex items-center gap-2 mt-2 border-t border-stone-100 pt-3">
            <button
              onclick={save}
              disabled={busy || !canSave}
              class="bg-stone-800 hover:bg-stone-700 disabled:bg-stone-300 disabled:cursor-not-allowed
                     text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors cursor-default"
              data-testid="template-save"
            >{editingId ? 'Save changes' : 'Create template'}</button>
            {#if editingId}
              <button
                onclick={() => remove(editingId!)}
                disabled={busy}
                class="text-sm text-red-600 hover:text-red-700 px-3 py-2 rounded-lg
                       hover:bg-red-50 cursor-default"
                data-testid="template-delete"
              >Delete</button>
            {/if}
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
