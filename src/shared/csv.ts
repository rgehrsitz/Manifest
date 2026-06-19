// Minimal RFC-4180 CSV parser. Pure, dependency-free, shared between the main
// process (import) and tests. Handles quoted fields, escaped quotes (""),
// commas and newlines inside quotes, and CR / LF / CRLF line endings. Strips a
// leading UTF-8 BOM, drops trailing blank lines, and throws on a malformed
// (unterminated) quoted field rather than silently mangling the data.

export class CsvParseError extends Error {
  constructor(message: string, public readonly line: number) {
    super(message)
    this.name = 'CsvParseError'
  }
}

export function parseCsv(text: string): string[][] {
  // Strip a UTF-8 BOM if present.
  let input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text

  const rows: string[][] = []
  let field = ''
  let row: string[] = []
  let inQuotes = false
  let line = 1 // 1-based, for error messages
  let sawAnyChar = false

  const endField = () => { row.push(field); field = '' }
  const endRow = () => { endField(); rows.push(row); row = [] }

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]

    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') { field += '"'; i++ } // escaped quote
        else inQuotes = false
      } else {
        if (ch === '\n') line++
        field += ch
      }
      continue
    }

    if (ch === '"') {
      // A quote may only open a field at its start (no chars accumulated yet).
      if (field.length > 0) {
        throw new CsvParseError(`Unexpected quote in unquoted field on line ${line}`, line)
      }
      inQuotes = true
      sawAnyChar = true
      continue
    }
    if (ch === ',') { endField(); sawAnyChar = true; continue }
    if (ch === '\r') {
      // CRLF or lone CR ends the row.
      if (input[i + 1] === '\n') i++
      endRow(); line++; sawAnyChar = false
      continue
    }
    if (ch === '\n') { endRow(); line++; sawAnyChar = false; continue }

    field += ch
    sawAnyChar = true
  }

  if (inQuotes) {
    throw new CsvParseError('Unterminated quoted field at end of input', line)
  }

  // Flush the final field/row if the input didn't end with a newline, or if the
  // last line had content.
  if (sawAnyChar || field.length > 0 || row.length > 0) {
    endRow()
  }

  // Drop trailing fully-empty rows (e.g. a trailing newline produced a [''] row).
  while (rows.length > 0) {
    const last = rows[rows.length - 1]
    if (last.length === 1 && last[0] === '') rows.pop()
    else break
  }

  return rows
}

// Serialize rows back to RFC-4180 CSV text (symmetric with parseCsv). A field is
// quoted when it contains a comma, quote, or CR/LF; embedded quotes are doubled.
// Rows are joined with CRLF and the output ends with a trailing CRLF.
//
// Formula-injection guard: spreadsheets (Excel/Sheets) execute a cell whose first
// character is = + - @ (or a leading tab/CR), so any such cell is prefixed with a
// single quote before quoting. These exports are built to be opened in a
// spreadsheet and the import side accepts arbitrary external CSVs, so an injected
// value must never round-trip into an executable formula.
const FORMULA_LEADERS = new Set(['=', '+', '-', '@', '\t', '\r'])

function escapeCsvField(value: string): string {
  let v = value
  if (v.length > 0 && FORMULA_LEADERS.has(v[0])) v = `'${v}`
  if (/[",\r\n]/.test(v)) {
    return `"${v.replace(/"/g, '""')}"`
  }
  return v
}

export function serializeCsv(rows: string[][]): string {
  return rows.map(row => row.map(escapeCsvField).join(',')).join('\r\n') + '\r\n'
}
