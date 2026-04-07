// Structured JSON logger. No external dependencies.
// Writes newline-delimited JSON to a log file.
// Also echoes to console in development.

import { appendFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'

type Level = 'error' | 'warn' | 'info' | 'debug'

interface LogEntry {
  ts: string
  level: Level
  ns: string
  msg: string
  [key: string]: unknown
}

function writeEntry(logPath: string, entry: LogEntry): void {
  try {
    mkdirSync(dirname(logPath), { recursive: true })
    appendFileSync(logPath, JSON.stringify(entry) + '\n', 'utf8')
  } catch {
    // Logger must never throw — swallow write errors silently
  }
}

function toConsole(entry: LogEntry): void {
  const prefix = `[${entry.ts}] [${entry.level.toUpperCase()}] [${entry.ns}]`
  const { ts: _ts, level, ns: _ns, msg, ...rest } = entry
  const extras = Object.keys(rest).length ? rest : undefined
  switch (level) {
    case 'error': console.error(prefix, msg, extras ?? ''); break
    case 'warn':  console.warn(prefix, msg, extras ?? '');  break
    default:      console.log(prefix, msg, extras ?? '');   break
  }
}

export interface Logger {
  error(msg: string, ctx?: Record<string, unknown>): void
  warn(msg: string,  ctx?: Record<string, unknown>): void
  info(msg: string,  ctx?: Record<string, unknown>): void
  debug(msg: string, ctx?: Record<string, unknown>): void
}

export function createLogger(namespace: string, logPath: string): Logger {
  const isDev = process.env.NODE_ENV === 'development'

  function log(level: Level, msg: string, ctx?: Record<string, unknown>): void {
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      ns: namespace,
      msg,
      ...ctx,
    }
    writeEntry(logPath, entry)
    if (isDev || level === 'error') {
      toConsole(entry)
    }
  }

  return {
    error: (msg, ctx) => log('error', msg, ctx),
    warn:  (msg, ctx) => log('warn',  msg, ctx),
    info:  (msg, ctx) => log('info',  msg, ctx),
    debug: (msg, ctx) => log('debug', msg, ctx),
  }
}
