import { describe, it, expect } from 'vitest'
import { parseCsv, serializeCsv, CsvParseError } from '../../../src/shared/csv'

describe('parseCsv', () => {
  it('parses a simple table', () => {
    expect(parseCsv('a,b,c\n1,2,3')).toEqual([['a', 'b', 'c'], ['1', '2', '3']])
  })

  it('handles quoted fields with commas and newlines', () => {
    const csv = 'name,note\n"Rack A, bay 2","line1\nline2"'
    expect(parseCsv(csv)).toEqual([
      ['name', 'note'],
      ['Rack A, bay 2', 'line1\nline2'],
    ])
  })

  it('handles escaped quotes ("")', () => {
    expect(parseCsv('a\n"say ""hi"""')).toEqual([['a'], ['say "hi"']])
  })

  it('handles CRLF and lone CR line endings', () => {
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([['a', 'b'], ['1', '2']])
    expect(parseCsv('a,b\r1,2')).toEqual([['a', 'b'], ['1', '2']])
  })

  it('strips a leading UTF-8 BOM', () => {
    expect(parseCsv('﻿a,b\n1,2')).toEqual([['a', 'b'], ['1', '2']])
  })

  it('drops trailing blank rows but keeps interior empty fields', () => {
    expect(parseCsv('a,b\n1,\n\n')).toEqual([['a', 'b'], ['1', '']])
  })

  it('preserves empty fields and a final no-newline row', () => {
    expect(parseCsv('a,,c')).toEqual([['a', '', 'c']])
  })

  it('throws on an unterminated quoted field', () => {
    expect(() => parseCsv('a\n"oops')).toThrow(CsvParseError)
  })

  it('throws on a stray quote inside an unquoted field', () => {
    expect(() => parseCsv('a\nab"c')).toThrow(CsvParseError)
  })

  it('returns [] for empty input', () => {
    expect(parseCsv('')).toEqual([])
    expect(parseCsv('\n')).toEqual([])
  })
})

describe('serializeCsv', () => {
  it('serializes a simple table with a trailing CRLF', () => {
    expect(serializeCsv([['a', 'b'], ['1', '2']])).toBe('a,b\r\n1,2\r\n')
  })

  it('quotes fields containing comma, quote, or newline (doubling quotes)', () => {
    expect(serializeCsv([['Rack A, bay 2', 'say "hi"', 'line1\nline2']])).toBe(
      '"Rack A, bay 2","say ""hi""","line1\nline2"\r\n',
    )
  })

  it('escapes formula-injection leaders by prefixing a single quote', () => {
    // =, +, -, @ and a leading tab/CR must not execute in a spreadsheet.
    expect(serializeCsv([['=cmd()', '+1', '-2', '@x']])).toBe("'=cmd(),'+1,'-2,'@x\r\n")
  })

  it('quotes AND escapes a value that is both a formula and contains a comma', () => {
    expect(serializeCsv([['=A1,B1']])).toBe('"\'=A1,B1"\r\n')
  })

  it('round-trips through parseCsv on a non-degenerate fixture', () => {
    // No trailing all-empty row (parseCsv drops those by design); no leading
    // formula chars (escaping intentionally rewrites those).
    const rows = [
      ['path', 'node', 'change', 'old', 'new'],
      ['Lab/Rack A-01', 'Board 1', 'renamed', 'Board One', 'Board 1'],
      ['Lab/Rack A-01', 'Board 2', 'property-changed', 'note: a, b', 'note: c'],
    ]
    expect(parseCsv(serializeCsv(rows))).toEqual(rows)
  })
})
