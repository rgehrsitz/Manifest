import Database from 'better-sqlite3'
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import type { ManifestNode, Project } from '../shared/types'

const SEARCH_RESULT_LIMIT = 50

interface SearchRow {
  nodeId: string
  nodeName: string
  propertiesText: string
  rank: number
}

export interface SearchIndexHit {
  nodeId: string
  nodeName: string
  matchField: 'name' | 'property'
  snippet: string
}

export class SearchIndexService {
  private db: Database.Database | null = null
  private dbPath: string | null = null
  private projectPath: string | null = null

  rebuild(project: Project): void {
    if (!project.path) {
      throw new Error('Project has no path — cannot rebuild search index')
    }

    this.withFreshDatabase(project.path, (db) => {
      const clear = db.prepare('DELETE FROM node_search')
      const insert = db.prepare<[string, string, string]>(
        'INSERT INTO node_search (node_id, node_name, properties_text) VALUES (?, ?, ?)'
      )

      const rebuildAll = db.transaction((nodes: ManifestNode[]) => {
        clear.run()
        for (const node of nodes) {
          insert.run(node.id, node.name, serializeProperties(node))
        }
      })

      rebuildAll(project.nodes)
    })
  }

  close(): void {
    if (this.db?.open) {
      this.db.close()
    }
    this.db = null
    this.dbPath = null
    this.projectPath = null
  }

  upsertNode(projectPath: string, node: ManifestNode): void {
    const db = this.requireDatabase(projectPath)
    const upsert = db.transaction((searchNode: ManifestNode) => {
      db.prepare<[string]>('DELETE FROM node_search WHERE node_id = ?').run(searchNode.id)
      db.prepare<[string, string, string]>(
        'INSERT INTO node_search (node_id, node_name, properties_text) VALUES (?, ?, ?)'
      ).run(searchNode.id, searchNode.name, serializeProperties(searchNode))
    })

    upsert(node)
  }

  deleteNodes(projectPath: string, nodeIds: string[]): void {
    if (nodeIds.length === 0) return

    const db = this.requireDatabase(projectPath)
    const remove = db.prepare<[string]>('DELETE FROM node_search WHERE node_id = ?')
    const deleteAll = db.transaction((ids: string[]) => {
      for (const nodeId of ids) {
        remove.run(nodeId)
      }
    })

    deleteAll(nodeIds)
  }

  query(projectPath: string, query: string, limit = SEARCH_RESULT_LIMIT): SearchIndexHit[] {
    const db = this.requireDatabase(projectPath)
    const trimmed = query.trim()
    if (!trimmed) return []

    const hits = new Map<string, SearchRow>()
    const queryTokens = tokenize(trimmed)
    const ftsQuery = buildFtsQuery(queryTokens)

    if (ftsQuery) {
      const ranked = db.prepare<[string, number], SearchRow>(`
        SELECT
          node_id AS nodeId,
          node_name AS nodeName,
          properties_text AS propertiesText,
          bm25(node_search) AS rank
        FROM node_search
        WHERE node_search MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(ftsQuery, limit)

      for (const row of ranked) {
        hits.set(row.nodeId, row)
      }
    }

    if (hits.size < limit) {
      const pattern = `%${escapeLike(trimmed.toLowerCase())}%`
      const fallback = db.prepare<[string, string, number], Omit<SearchRow, 'rank'>>(`
        SELECT
          node_id AS nodeId,
          node_name AS nodeName,
          properties_text AS propertiesText
        FROM node_search
        WHERE (
          lower(node_name) LIKE ? ESCAPE '\\'
          OR lower(properties_text) LIKE ? ESCAPE '\\'
        )
        LIMIT ?
      `).all(pattern, pattern, limit)

      for (const row of fallback) {
        if (!hits.has(row.nodeId)) {
          hits.set(row.nodeId, { ...row, rank: 1000 + hits.size })
        }
      }
    }

    return Array.from(hits.values())
      .sort((a, b) => a.rank - b.rank || a.nodeName.localeCompare(b.nodeName))
      .slice(0, limit)
      .map((row) => {
        const matchField = detectMatchField(row.nodeName, row.propertiesText, trimmed, queryTokens)
        return {
          nodeId: row.nodeId,
          nodeName: row.nodeName,
          matchField,
          snippet: matchField === 'name'
            ? row.nodeName
            : extractSnippet(row.propertiesText, trimmed),
        }
      })
  }

  private withFreshDatabase(projectPath: string, seed: (db: Database.Database) => void): void {
    const { db, dbPath } = this.openDatabase(projectPath)

    try {
      seed(db)
    } catch (error) {
      if (db.open) {
        db.close()
      }
      rmSync(dbPath, { force: true })
      throw error
    }

    this.close()
    this.db = db
    this.dbPath = dbPath
    this.projectPath = projectPath
  }

  private requireDatabase(projectPath: string): Database.Database {
    if (!this.db || !this.projectPath || this.projectPath !== projectPath) {
      throw new Error('Search index is not open for the current project')
    }

    return this.db
  }

  private openDatabase(projectPath: string): { db: Database.Database; dbPath: string } {
    const dbPath = join(projectPath, '.manifest', 'index', 'search.db')
    mkdirSync(join(projectPath, '.manifest', 'index'), { recursive: true })

    const db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = NORMAL')
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS node_search USING fts5(
        node_id UNINDEXED,
        node_name,
        properties_text,
        tokenize = 'unicode61'
      );
    `)

    return { db, dbPath }
  }
}

function serializeProperties(node: ManifestNode): string {
  return Object.entries(node.properties)
    .map(([key, value]) => `${key}: ${value === null ? 'null' : String(value)}`)
    .join('\n')
}

function tokenize(value: string): string[] {
  return value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
}

function buildFtsQuery(tokens: string[]): string | null {
  if (tokens.length === 0) return null
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"*`).join(' AND ')
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&')
}

function detectMatchField(
  nodeName: string,
  propertiesText: string,
  query: string,
  tokens: string[]
): 'name' | 'property' {
  const normalizedQuery = query.toLowerCase()
  const lowerName = nodeName.toLowerCase()
  const lowerProperties = propertiesText.toLowerCase()

  if (lowerName.includes(normalizedQuery)) return 'name'
  if (lowerProperties.includes(normalizedQuery)) return 'property'
  if (matchesTokenPrefixes(lowerName, tokens)) return 'name'
  return 'property'
}

function matchesTokenPrefixes(text: string, tokens: string[]): boolean {
  if (tokens.length === 0) return false
  const textTokens = tokenize(text)
  return tokens.every((token) => textTokens.some((textToken) => textToken.startsWith(token)))
}

function extractSnippet(propertiesText: string, query: string): string {
  if (!propertiesText) return ''

  const normalizedText = propertiesText.toLowerCase()
  const normalizedQuery = query.toLowerCase()
  const matchIndex = normalizedText.indexOf(normalizedQuery)

  if (matchIndex === -1) {
    return propertiesText.split('\n')[0]?.slice(0, 80) ?? ''
  }

  const start = Math.max(0, matchIndex - 20)
  const end = Math.min(propertiesText.length, matchIndex + query.length + 40)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < propertiesText.length ? '…' : ''
  return `${prefix}${propertiesText.slice(start, end)}${suffix}`.trim()
}
