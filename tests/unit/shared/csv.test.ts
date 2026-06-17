import { describe, it, expect } from 'vitest'
import { parseCsv, CsvParseError } from '../../../src/shared/csv'

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
