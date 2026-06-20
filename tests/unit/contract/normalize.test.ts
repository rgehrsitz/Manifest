import { describe, it, expect } from 'vitest'
import { normalize } from './normalize'

describe('contract normalize()', () => {
  it('maps uuids to stable placeholders in first-seen order, preserving references', () => {
    const a = '0190a000-0000-7000-8000-000000000001'
    const b = '0190a000-0000-7000-8000-000000000002'
    const out = normalize({ id: a, parentId: null, ref: b, backRef: a }) as Record<string, unknown>
    expect(out).toEqual({ id: '<id:1>', parentId: null, ref: '<id:2>', backRef: '<id:1>' })
  })

  it('scrubs ISO timestamps (UTC and offset forms), 40-hex hashes, and the report short-hash slot', () => {
    const out = normalize({
      modified: '2026-06-20T14:30:00.000Z',
      createdAt: '2026-06-20T16:47:25-04:00', // git creatordate offset form
      reportHeader: 'v1 (2026-06-20 16:51 · abc1234)', // human date + short hash in report
      commitHash: 'a'.repeat(40),
    }) as Record<string, unknown>
    expect(out).toEqual({
      modified: '<ts>',
      createdAt: '<ts>',
      reportHeader: 'v1 (<ts> · <hash>)',
      commitHash: '<hash>',
    })
  })

  it('does NOT over-scrub a 7-hex token in ordinary data (no global short-hash rule)', () => {
    // A property value / name that happens to be 7 hex chars must survive — only
    // the report-header `· <hash>)` slot is scrubbed.
    const out = normalize({ properties: { serial: 'abcdef0', note: 'deadbee' }, name: 'Rack abc1234' })
    expect(out).toEqual({ properties: { serial: 'abcdef0', note: 'deadbee' }, name: 'Rack abc1234' })
  })

  it('does NOT over-scrub a human date that is not in the report-header slot', () => {
    // The human-timestamp scrub is scoped to the report `(<date> · ...)` slot via
    // a ` ·` lookahead; a date-like substring in ordinary data must survive.
    const out = normalize({ note: 'maintenance window 2026-06-20 14:30 sharp' })
    expect(out).toEqual({ note: 'maintenance window 2026-06-20 14:30 sharp' })
  })

  it('preserves array order verbatim while mapping ids consistently', () => {
    const a = '0190a000-0000-7000-8000-00000000000a'
    const b = '0190a000-0000-7000-8000-00000000000b'
    const out = normalize([{ id: b, n: 2 }, { id: a, n: 1 }, { id: b, ref: a, n: 3 }])
    expect(out).toEqual([
      { id: '<id:1>', n: 2 },
      { id: '<id:2>', n: 1 },
      { id: '<id:1>', ref: '<id:2>', n: 3 },
    ])
  })

  it('scrubs the longest matching path first (prefix-overlapping scrub strings)', () => {
    const out = normalize({ path: '/tmp/a/b/manifest.json' }, ['/tmp/a', '/tmp/a/b']) as Record<string, unknown>
    expect(out).toEqual({ path: '<path>/manifest.json' })
  })

  it('leaves an already-normalized placeholder untouched', () => {
    const out = normalize({ id: '<id:1>', ts: '<ts>', hash: '<hash>' })
    expect(out).toEqual({ id: '<id:1>', ts: '<ts>', hash: '<hash>' })
  })

  it('scrubs JSON-escaped (Windows-style) paths too', () => {
    const winDir = 'C:\\Users\\rob\\proj'
    const out = normalize({ path: `${winDir}\\manifest.json` }, [winDir]) as Record<string, unknown>
    expect(out).toEqual({ path: '<path>\\manifest.json' })
  })

  it('scrubs literal paths passed in scrub list', () => {
    const dir = '/tmp/manifest-xyz-123'
    const out = normalize({ path: `${dir}/manifest.json` }, [dir]) as Record<string, unknown>
    expect(out).toEqual({ path: '<path>/manifest.json' })
  })

  it('preserves the contract: names, structure, statuses, counts, error codes', () => {
    const out = normalize({
      ok: false,
      error: { code: 'VALIDATION_FAILED', message: 'x' },
      data: { name: 'Rack A', order: 0, status: 'removed', count: 3, flag: true, empty: null },
    })
    expect(out).toEqual({
      ok: false,
      error: { code: 'VALIDATION_FAILED', message: 'x' },
      data: { name: 'Rack A', order: 0, status: 'removed', count: 3, flag: true, empty: null },
    })
  })
})
