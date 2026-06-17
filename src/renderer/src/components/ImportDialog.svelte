<svelte:options runes />

<script lang="ts">
  // CSV import modal: choose a file (main inspects it), map columns → name /
  // path / typed properties, validate the WHOLE file, then import. Main is
  // authoritative — this dialog only drives it and shows results.
  import type {
    ManifestNode, NodeTemplate, ImportMapping, ImportInspect, ImportPlan, ImportResult, Project,
  } from '../../../shared/types'
  import { isUsableTemplate, templateLabel, templateFields, validatePropertyKey } from '../../../shared/validation'
  import { suggestKey } from '../../../shared/import'

  interface Props {
    baseParent: ManifestNode
    templates: Record<string, NodeTemplate>
    onClose: () => void
    onImported: (project: Project, summary: ImportResult) => void
  }

  let { baseParent, templates, onClose, onImported }: Props = $props()

  let filePath = $state<string | null>(null)
  let inspect = $state<ImportInspect | null>(null)
  let busy = $state(false)
  let error = $state<string | null>(null)

  // Mapping state.
  let placement = $state<'flat' | 'path'>('flat')
  let nameColumn = $state('')
  let pathColumn = $state('')
  let pathSeparator = $state(' / ')
  let autoCreateParents = $state(false)
  let templateId = $state<string | null>(null)
  let columnKey = $state<Record<string, string>>({})
  let columnInclude = $state<Record<string, boolean>>({})

  // Plan (full-file validation) — cleared whenever the mapping changes.
  let plan = $state<ImportPlan | null>(null)

  const headers = $derived(inspect?.headers ?? [])
  const usableTemplateIds = $derived(
    Object.keys(templates).filter(id => isUsableTemplate(templates[id])).sort()
  )
  const template = $derived(templateId ? templates[templateId] ?? null : null)
  const fields = $derived(templateFields(template))

  // Headers that become property columns (everything except name and, in path
  // mode, the path column).
  const propertyHeaders = $derived(
    headers.filter(h => h !== nameColumn && !(placement === 'path' && h === pathColumn))
  )

  // Client-side duplicate-key hint (main is authoritative).
  const duplicateKeys = $derived.by(() => {
    const seen = new Set<string>()
    const dup = new Set<string>()
    for (const h of propertyHeaders) {
      if (!columnInclude[h]) continue
      const k = (columnKey[h] ?? '').trim()
      if (!k) continue
      if (seen.has(k)) dup.add(k)
      seen.add(k)
    }
    return dup
  })

  // Included columns whose key is empty or not a valid property key. Flagged
  // inline and gating Validate, so the user fixes them before hitting an
  // otherwise-cryptic mapping error from main.
  const invalidKeyHeaders = $derived.by(() => {
    const bad = new Set<string>()
    for (const h of propertyHeaders) {
      if (!columnInclude[h]) continue
      if (!validatePropertyKey((columnKey[h] ?? '').trim()).valid) bad.add(h)
    }
    return bad
  })

  async function chooseFile() {
    error = null
    const path = await window.api.dialog.openFile('Choose a CSV to import')
    if (!path) return // canceled
    busy = true
    try {
      const res = await window.api.import.inspect(path)
      if (!res.ok) { error = res.error.message; return }
      filePath = path
      inspect = res.data
      initMapping(res.data.headers)
      plan = null
    } finally {
      busy = false
    }
  }

  function initMapping(hdrs: string[]) {
    nameColumn = hdrs.find(h => /^name$/i.test(h)) ?? hdrs[0] ?? ''
    // A breadcrumb column (e.g. parent_path) means the CSV is hierarchical —
    // default to path placement so it reconstructs structure instead of piling
    // every row under one parent (where repeated names would collide). Only a
    // strong match (parent_path / path) flips the default; a weaker match like
    // install_path is just pre-filled so it's ready if the user picks path.
    const strongPath = hdrs.find(h => /^(parent[_ ]?)?path$/i.test(h)) ?? ''
    pathColumn = strongPath || hdrs.find(h => /path/i.test(h)) || ''
    placement = strongPath ? 'path' : 'flat'
    autoCreateParents = false
    templateId = null
    const key: Record<string, string> = {}
    const inc: Record<string, boolean> = {}
    for (const h of hdrs) { key[h] = suggestKey(h); inc[h] = true }
    columnKey = key
    columnInclude = inc
  }

  // Any mapping edit invalidates a prior validation.
  function touched() { plan = null }

  function buildMapping(): ImportMapping {
    const columns = propertyHeaders.map(h => ({
      header: h,
      key: (columnKey[h] ?? '').trim(),
      include: columnInclude[h] ?? false,
    }))
    return {
      placement,
      baseParentId: baseParent.id,
      nameColumn,
      ...(placement === 'path' ? { pathColumn, pathSeparator, autoCreateParents } : {}),
      templateId,
      columns,
    }
  }

  async function validate() {
    if (!filePath) return
    error = null
    busy = true
    try {
      const res = await window.api.import.plan(filePath, buildMapping())
      if (!res.ok) { error = res.error.message; plan = null; return }
      plan = res.data
    } finally {
      busy = false
    }
  }

  async function doImport() {
    if (!filePath) return
    error = null
    busy = true
    try {
      const res = await window.api.import.apply(filePath, buildMapping())
      if (!res.ok) { error = res.error.message; return }
      onImported(res.data.project, res.data.summary)
      onClose()
    } finally {
      busy = false
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') onClose()
  }
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
    style="height: min(85vh, 720px)"
    role="dialog"
    aria-modal="true"
    aria-label="Import from CSV"
    data-testid="import-dialog"
  >
    <div class="px-5 py-4 border-b border-stone-100 flex items-center justify-between">
      <div>
        <h2 class="text-sm font-semibold text-stone-800">Import from CSV</h2>
        <p class="text-xs text-stone-400 mt-0.5">Map spreadsheet columns to nodes and typed properties.</p>
      </div>
      <button onclick={onClose} class="text-stone-400 hover:text-stone-600 text-sm cursor-default"
        aria-label="Close" data-testid="import-close">✕</button>
    </div>

    <div class="flex-1 overflow-y-auto px-5 py-4">
      {#if !inspect}
        <div class="flex flex-col items-center justify-center gap-3 py-10 text-center">
          <p class="text-sm text-stone-500">Choose a CSV exported from your spreadsheet.</p>
          <button onclick={chooseFile} disabled={busy}
            class="bg-stone-800 hover:bg-stone-700 disabled:bg-stone-300 text-white text-sm
                   font-medium px-4 py-2 rounded-lg cursor-default" data-testid="import-choose-file">
            Choose CSV…
          </button>
          {#if error}<p class="text-xs text-red-600" data-testid="import-error">{error}</p>{/if}
        </div>
      {:else}
        <div class="flex flex-col gap-4">
          <p class="text-xs text-stone-500">
            <span class="font-mono">{filePath}</span> · {inspect.rowCount} rows
          </p>

          <!-- Placement -->
          <div class="flex flex-col gap-1">
            <span class="text-xs font-semibold text-stone-500 uppercase tracking-wide">Placement</span>
            <div class="flex items-center gap-4 text-sm text-stone-700">
              <label class="flex items-center gap-1.5">
                <input type="radio" value="flat" checked={placement === 'flat'}
                  onchange={() => { placement = 'flat'; touched() }} data-testid="import-placement-flat" />
                Under “{baseParent.name}”
              </label>
              <label class="flex items-center gap-1.5">
                <input type="radio" value="path" checked={placement === 'path'}
                  onchange={() => { placement = 'path'; touched() }} data-testid="import-placement-path" />
                By path column
              </label>
            </div>
            {#if placement === 'path'}
              <div class="flex items-center gap-2 mt-1">
                <select bind:value={pathColumn} onchange={touched}
                  class="text-sm border border-stone-300 rounded px-2 py-1 bg-white" data-testid="import-path-column">
                  <option value="">— path column —</option>
                  {#each headers as h (h)}<option value={h}>{h}</option>{/each}
                </select>
                <input bind:value={pathSeparator} oninput={touched} placeholder="separator"
                  class="text-sm border border-stone-300 rounded px-2 py-1 w-24" data-testid="import-path-separator" />
                <span class="text-xs text-stone-400">paths resolve under “{baseParent.name}”</span>
              </div>
              <label class="flex items-center gap-2 mt-1 text-sm text-stone-600">
                <input type="checkbox" bind:checked={autoCreateParents} onchange={touched}
                  data-testid="import-auto-create" />
                Create missing parents in the path (added as plain nodes)
              </label>
            {/if}
          </div>

          <!-- Name + template -->
          <div class="flex gap-4">
            <label class="flex flex-col gap-1">
              <span class="text-xs font-semibold text-stone-500 uppercase tracking-wide">Name column</span>
              <select bind:value={nameColumn} onchange={touched}
                class="text-sm border border-stone-300 rounded px-2 py-1 bg-white" data-testid="import-name-column">
                {#each headers as h (h)}<option value={h}>{h}</option>{/each}
              </select>
            </label>
            <label class="flex flex-col gap-1">
              <span class="text-xs font-semibold text-stone-500 uppercase tracking-wide">Template (optional)</span>
              <select value={templateId ?? ''} onchange={(e) => { templateId = (e.currentTarget as HTMLSelectElement).value || null; touched() }}
                class="text-sm border border-stone-300 rounded px-2 py-1 bg-white" data-testid="import-template">
                <option value="">Freeform (no template)</option>
                {#each usableTemplateIds as id (id)}<option value={id}>{templateLabel(templates[id], id)}</option>{/each}
              </select>
            </label>
          </div>

          <!-- Property columns -->
          <div class="flex flex-col gap-1">
            <span class="text-xs font-semibold text-stone-500 uppercase tracking-wide">Property columns</span>
            <div class="flex flex-col gap-1" data-testid="import-columns">
              {#each propertyHeaders as h (h)}
                {@const key = (columnKey[h] ?? '').trim()}
                {@const typed = fields[key]}
                <div class="flex items-center gap-2">
                  <input type="checkbox" checked={columnInclude[h] ?? true}
                    onchange={(e) => { columnInclude = { ...columnInclude, [h]: (e.currentTarget as HTMLInputElement).checked }; touched() }}
                    data-testid={`import-col-include-${h}`} />
                  <span class="text-xs text-stone-500 w-40 shrink-0 truncate" title={h}>{h}</span>
                  <span class="text-stone-300 text-xs">→</span>
                  <input value={columnKey[h] ?? ''}
                    oninput={(e) => { columnKey = { ...columnKey, [h]: (e.currentTarget as HTMLInputElement).value }; touched() }}
                    disabled={!(columnInclude[h] ?? true)}
                    class="text-sm font-mono border rounded px-2 py-1 flex-1 disabled:bg-stone-50 disabled:text-stone-400
                           {duplicateKeys.has(key) || invalidKeyHeaders.has(h) ? 'border-red-300' : 'border-stone-300'}"
                    data-testid={`import-col-key-${h}`} />
                  {#if typed}
                    <span class="text-[10px] text-sky-600 shrink-0">typed: {typed.type}</span>
                  {/if}
                </div>
              {/each}
              {#if duplicateKeys.size > 0}
                <p class="text-xs text-red-600">Duplicate keys: {[...duplicateKeys].join(', ')} — each column needs a distinct key.</p>
              {/if}
              {#if invalidKeyHeaders.size > 0}
                <p class="text-xs text-red-600" data-testid="import-invalid-keys">Some included columns have an empty or invalid key (letters, numbers, underscore only).</p>
              {/if}
            </div>
          </div>

          <!-- Preview -->
          {#if inspect.sampleRows.length > 0}
            <div class="flex flex-col gap-1">
              <span class="text-xs font-semibold text-stone-500 uppercase tracking-wide">Preview (first {Math.min(5, inspect.sampleRows.length)} rows)</span>
              <div class="overflow-x-auto border border-stone-100 rounded">
                <table class="text-xs text-stone-600 w-full">
                  <thead><tr class="bg-stone-50">{#each headers as h (h)}<th class="px-2 py-1 text-left font-medium truncate max-w-[160px]">{h}</th>{/each}</tr></thead>
                  <tbody>
                    {#each inspect.sampleRows.slice(0, 5) as row, i (i)}
                      <tr class="border-t border-stone-100">{#each headers as _, c (c)}<td class="px-2 py-1 truncate max-w-[160px]">{row[c] ?? ''}</td>{/each}</tr>
                    {/each}
                  </tbody>
                </table>
              </div>
            </div>
          {/if}

          <!-- Validation summary -->
          {#if plan}
            <div class="rounded-lg border border-stone-200 bg-stone-50 px-3 py-2" data-testid="import-summary">
              <p class="text-xs text-stone-700">
                <span class="font-semibold text-emerald-700">{plan.acceptedCount} will import</span>
                · <span class="text-red-700">{plan.skippedCount} skipped</span>
                · <span class="text-amber-700">{plan.warningCount} warnings</span>
                {#if plan.createdParents > 0}· <span class="text-sky-700">{plan.createdParents} parents created</span>{/if}
              </p>
              {#if plan.skipped.length > 0}
                <ul class="mt-1 space-y-0.5">
                  {#each plan.skipped.slice(0, 5) as s (s.row + (s.column ?? ''))}
                    <li class="text-xs text-stone-500 truncate">row {s.row}{s.column ? ` · ${s.column}` : ''} — {s.reason}</li>
                  {/each}
                  {#if plan.skipped.length > 5}<li class="text-xs text-stone-400">…and {plan.skippedCount - 5} more</li>{/if}
                </ul>
              {/if}
              {#if plan.capped}
                <p class="text-xs text-stone-400 mt-1">Showing the first 100 issues; counts above are the full totals.</p>
              {/if}
            </div>
          {/if}

          {#if error}<p class="text-xs text-red-600" data-testid="import-error">{error}</p>{/if}
        </div>
      {/if}
    </div>

    {#if inspect}
      <div class="flex items-center gap-2 px-5 py-3 border-t border-stone-100">
        <button onclick={validate} disabled={busy || duplicateKeys.size > 0 || invalidKeyHeaders.size > 0}
          class="bg-white hover:bg-stone-50 text-stone-700 border border-stone-200 disabled:opacity-50
                 text-sm font-medium px-4 py-2 rounded-lg cursor-default" data-testid="import-validate">
          Validate
        </button>
        <button onclick={doImport} disabled={busy || !plan || plan.acceptedCount === 0}
          class="bg-stone-800 hover:bg-stone-700 disabled:bg-stone-300 text-white text-sm font-medium
                 px-4 py-2 rounded-lg cursor-default disabled:cursor-not-allowed" data-testid="import-apply">
          Import{plan ? ` ${plan.acceptedCount}` : ''}
        </button>
        <span class="text-xs text-stone-400 ml-auto">Validate to see what will import.</span>
      </div>
    {/if}
  </div>
</div>
