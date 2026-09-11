import { MARKET_LIMITS } from './market-facts.ts'

const POSTGRES_INTEGER_MAX = 2_147_483_647
const SHELF_CURSOR_VERSION = 1
const MAX_CURSOR_LENGTH = MARKET_LIMITS.collection.cursorMaxChars

export interface NumericPageOptions {
  cursorName: string
  limitName?: string
  defaultLimit: number
  maxLimit: number
}

export type NumericPage =
  | { ok: true; cursor: number | null; limit: number; fetchLimit: number }
  | { ok: false; error: string }

function oneValue(params: URLSearchParams, name: string): string | null | undefined {
  const values = params.getAll(name)
  if (values.length > 1) return undefined
  return values[0] ?? null
}

function positiveInteger(value: string | null, maximum: number): number | null {
  if (value === null || !/^[1-9]\d*$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed <= maximum ? parsed : null
}

export function parseNumericPage(params: URLSearchParams, options: NumericPageOptions): NumericPage {
  const cursorValue = oneValue(params, options.cursorName)
  if (cursorValue === undefined)
    return { ok: false, error: `${options.cursorName} may appear only once` }
  const cursor = cursorValue === null ? null : positiveInteger(cursorValue, POSTGRES_INTEGER_MAX)
  if (cursorValue !== null && cursor === null)
    return { ok: false, error: `${options.cursorName} must be a positive integer` }

  const limitName = options.limitName ?? 'limit'
  const limitValue = oneValue(params, limitName)
  if (limitValue === undefined) return { ok: false, error: `${limitName} may appear only once` }
  const limit = limitValue === null ? options.defaultLimit : positiveInteger(limitValue, options.maxLimit)
  if (limit === null)
    return { ok: false, error: `${limitName} must be an integer from 1 to ${options.maxLimit}` }
  return { ok: true, cursor, limit, fetchLimit: limit + 1 }
}

export function finalizePage<T extends { id: number }>(rows: readonly T[], limit: number): {
  items: T[]
  hasMore: boolean
  nextCursor: number | null
} {
  const hasMore = rows.length > limit
  const items = rows.slice(0, limit)
  return {
    items,
    hasMore,
    nextCursor: hasMore ? items.at(-1)?.id ?? null : null,
  }
}

export interface CountedRow extends Record<string, unknown> {
  id: number | null
  __total: number
  __cursor_valid?: boolean
}

export function countedPage(rows: readonly CountedRow[], limit: number) {
  const total = Number(rows[0]?.__total ?? 0)
  const rawItems = rows.flatMap(row => Number.isInteger(row.id) && Number(row.id) > 0 ? [row] : [])
  const visibleItems = rawItems.map(row => Object.fromEntries(
    Object.entries(row).filter(([name]) => !name.startsWith('__')),
  ) as Record<string, unknown> & { id: number })
  const page = finalizePage(visibleItems, limit)
  return {
    total,
    ...page,
    cursorRow: page.hasMore ? rawItems[limit - 1] ?? null : null,
  }
}

export function invalidPageCursor(rows: readonly CountedRow[]): boolean {
  return rows[0]?.__cursor_valid === false
}

export interface ShelfCursorScope {
  q: string | null
  tag: string | null
  aisle: string | null
  sort: 'new' | 'karma'
}

export interface ShelfCursorPosition {
  pinned: boolean
  votes: number | null
  createdAt: string
  id: number
}

type ShelfCursorPayload = [
  version: number,
  q: string | null,
  tag: string | null,
  aisle: string | null,
  sort: string,
  pinned: boolean,
  votes: number | null,
  createdAt: string,
  id: number,
]

export function encodeShelfCursor(scope: ShelfCursorScope, position: ShelfCursorPosition): string {
  const payload: ShelfCursorPayload = [
    SHELF_CURSOR_VERSION,
    scope.q,
    scope.tag,
    scope.aisle,
    scope.sort,
    position.pinned,
    scope.sort === 'karma' ? position.votes : null,
    position.createdAt,
    position.id,
  ]
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

export type ShelfCursorInspection =
  | { kind: 'valid'; position: ShelfCursorPosition }
  | { kind: 'invalid' }
  | { kind: 'wrong_scope' }

export function inspectShelfCursor(cursor: string, scope: ShelfCursorScope): ShelfCursorInspection {
  if (!cursor || cursor.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(cursor)) return { kind: 'invalid' }
  let payload: unknown
  try {
    const decoded = Buffer.from(cursor, 'base64url')
    if (decoded.toString('base64url') !== cursor) return { kind: 'invalid' }
    payload = JSON.parse(decoded.toString('utf8'))
  } catch {
    return { kind: 'invalid' }
  }
  if (!Array.isArray(payload) || payload.length !== 9) return { kind: 'invalid' }
  const [version, q, tag, aisle, sort, pinned, votes, createdAt, id] = payload
  if (version !== SHELF_CURSOR_VERSION) return { kind: 'invalid' }
  if ((q !== null && typeof q !== 'string') || (tag !== null && typeof tag !== 'string') ||
      (aisle !== null && typeof aisle !== 'string') || (sort !== 'new' && sort !== 'karma'))
    return { kind: 'invalid' }
  if (typeof pinned !== 'boolean' || typeof createdAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(createdAt) ||
      !Number.isFinite(Date.parse(createdAt)) || !Number.isInteger(id) || id < 1 || id > POSTGRES_INTEGER_MAX)
    return { kind: 'invalid' }
  if (sort === 'karma') {
    if (!Number.isInteger(votes) || Number(votes) < -POSTGRES_INTEGER_MAX - 1 || Number(votes) > POSTGRES_INTEGER_MAX)
      return { kind: 'invalid' }
  } else if (votes !== null) return { kind: 'invalid' }
  if (q !== scope.q || tag !== scope.tag || aisle !== scope.aisle || sort !== scope.sort)
    return { kind: 'wrong_scope' }
  return { kind: 'valid', position: { pinned, votes: sort === 'karma' ? Number(votes) : null, createdAt, id } }
}

export function decodeShelfCursor(cursor: string, scope: ShelfCursorScope): ShelfCursorPosition | null {
  const inspected = inspectShelfCursor(cursor, scope)
  return inspected.kind === 'valid' ? inspected.position : null
}
