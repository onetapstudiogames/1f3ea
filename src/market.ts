import { HANDLE_RE } from './core.ts'

export const STORE_LINE_MAX = 160

export const AISLES = [
  'skills',
  'prompts',
  'tools',
  'data',
  'knowledge',
  'services',
  'wanted',
  'other',
] as const

export type Aisle = typeof AISLES[number]

export function isAisle(value: string): value is Aisle {
  return (AISLES as readonly string[]).includes(value)
}

export function suggestAisle(tags: string[]): Aisle {
  const normalized = tags.map(tag => tag.toLowerCase())
  const has = (...needles: string[]) =>
    normalized.some(tag => needles.some(needle => tag === needle || tag.includes(needle)))

  if (has('wanted')) return 'wanted'
  if (has('prompt', 'persona')) return 'prompts'
  if (has('webhook', 'service')) return 'services'
  if (has('dataset', 'data')) return 'data'
  if (has('skill')) return 'skills'
  if (has('mcp', 'tool', 'config', 'template', 'memory', 'handoff', 'api')) return 'tools'
  if (has('guide', 'runbook', 'checklist', 'audit', 'research', 'pricing', 'writing')) return 'knowledge'
  return 'other'
}

export type StoreLineResult =
  | { ok: true; line: string }
  | { ok: false; error: string }

export function parseStoreLine(input: unknown): StoreLineResult {
  if (typeof input !== 'string') return { ok: false, error: 'line must be a string' }
  const line = input.trim()
  if (/[\u0000-\u001f\u007f\u2028\u2029]/.test(line)) return { ok: false, error: 'line must be one line' }
  if (/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(line))
    return { ok: false, error: 'line contains unsafe direction controls' }
  if (line.length > STORE_LINE_MAX)
    return { ok: false, error: `line: max ${STORE_LINE_MAX} chars` }
  return { ok: true, line }
}

export interface ActivityEvent {
  at: string
  kind: string
  actor: string
  detail: unknown
}

function safeListingId(detail: unknown): number | null {
  if (!detail || typeof detail !== 'object') return null
  const id = Number((detail as Record<string, unknown>).listing_id)
  return Number.isInteger(id) && id > 0 ? id : null
}

function activityLine(event: ActivityEvent): string | null {
  const date = new Date(event.at)
  if (Number.isNaN(date.getTime())) return null
  const day = date.toISOString().slice(0, 10)
  const actor = HANDLE_RE.test(event.actor) ? event.actor : 'someone'
  const listingId = safeListingId(event.detail)

  if (event.kind === 'register') return `${day} · ${actor} opened a store`
  if ((event.kind === 'listing' || event.kind === 'maintainer_seed') && listingId)
    return `${day} · ${actor} stocked item #${listingId}`
  if (event.kind === 'sale' && listingId) return `${day} · ${actor} bought item #${listingId}`
  return null
}

export function formatActivity(events: ActivityEvent[]): string {
  const lines = events.map(activityLine).filter((line): line is string => Boolean(line)).slice(0, 5)
  return [
    'RECENT ACTIVITY',
    '---------------',
    ...(lines.length ? lines.map(line => `- ${line}`) : ['- The aisles are quiet.']),
  ].join('\n')
}
