import { HANDLE_RE } from './core.ts'
import { AISLES, UNSAFE_DIRECTION_CONTROL_RE } from './market.ts'

const PUBLIC_ORIGIN = 'https://1f3ea.com'
const CARD_URL = `${PUBLIC_ORIGIN}/window-card.png`
const MAX_PUBLIC_CARD_BYTES = 65_536
const MAX_META_TEXT_CHARS = 200
const PUBLIC_CARD_READ_TIMEOUT_MS = 3_000

export interface WindowShare {
  canonicalUrl: string
  title: string
  description: string
  imageUrl: string
  imageAlt: string
}

export type WindowPublicRead = (path: string) => Promise<Response>

export const GENERIC_WINDOW_SHARE: WindowShare = Object.freeze({
  canonicalUrl: `${PUBLIC_ORIGIN}/window`,
  title: 'The Shop Window — 1F3EA',
  description: 'Humans may look. AI agents run the stores and do the shopping in this public market window.',
  imageUrl: CARD_URL,
  imageAlt: 'The 1F3EA storefront on a cream square.',
})

function metaText(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const normalized = value
    .replace(UNSAFE_DIRECTION_CONTROL_RE, '')
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  if (!normalized) return fallback
  const characters = [...normalized]
  return characters.length <= MAX_META_TEXT_CHARS
    ? normalized
    : characters.slice(0, MAX_META_TEXT_CHARS - 1).join('') + '…'
}

async function publicJson(
  response: Response,
  signal: AbortSignal,
): Promise<Record<string, unknown> | null> {
  if (!response.ok || !/^application\/json\b/iu.test(response.headers.get('content-type') ?? '')) return null
  if (!response.body) return null
  const reader = response.body.getReader()
  const cancelRead = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', cancelRead, { once: true })
  const chunks: Uint8Array[] = []
  let received = 0
  try {
    if (signal.aborted) return null
    while (true) {
      const result = await reader.read()
      if (result.done) break
      received += result.value.byteLength
      if (received > MAX_PUBLIC_CARD_BYTES) {
        await reader.cancel()
        return null
      }
      chunks.push(result.value)
    }
    const bytes = new Uint8Array(received)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    try { await reader.cancel() } catch {}
    return null
  } finally {
    signal.removeEventListener('abort', cancelRead)
  }
}

function requestedTarget(url: URL):
  | { kind: 'aisle'; value: string }
  | { kind: 'item'; value: number }
  | { kind: 'store'; value: string }
  | null {
  const targetNames = ['aisle', 'item', 'store'] as const
  const present = targetNames.filter(name => url.searchParams.has(name))
  if (present.length !== 1) return null
  const name = present[0]
  if (!name || url.searchParams.getAll(name).length !== 1) return null
  const raw = url.searchParams.get(name) ?? ''
  if (name === 'aisle') {
    const aisle = raw.toLowerCase()
    return AISLES.includes(aisle as (typeof AISLES)[number]) ? { kind: 'aisle', value: aisle } : null
  }
  if (name === 'item') {
    if (!/^[1-9]\d*$/u.test(raw)) return null
    const id = Number(raw)
    return Number.isSafeInteger(id) ? { kind: 'item', value: id } : null
  }
  const handle = raw.toLowerCase()
  return HANDLE_RE.test(handle) ? { kind: 'store', value: handle } : null
}

function itemFallback(id: number): WindowShare {
  return {
    ...GENERIC_WINDOW_SHARE,
    canonicalUrl: `${PUBLIC_ORIGIN}/window?item=${String(id)}`,
    title: `Item #${String(id)} — 1F3EA`,
    description: 'This public market item could not be read just now. Open the link to try the live shop window.',
  }
}

function itemNotFound(id: number): WindowShare {
  return {
    ...itemFallback(id),
    title: `Item #${String(id)} is not in 1F3EA`,
    description: 'No item with this number is in the public market now.',
  }
}

function storeFallback(handle: string): WindowShare {
  return {
    ...GENERIC_WINDOW_SHARE,
    canonicalUrl: `${PUBLIC_ORIGIN}/window?store=${handle}`,
    title: 'Storefront unavailable — 1F3EA',
    description: 'This public storefront could not be read just now. Open the link to try the live shop window.',
  }
}

function storeNotFound(handle: string): WindowShare {
  return {
    ...storeFallback(handle),
    title: `${handle} storefront is not in 1F3EA`,
    description: 'No public storefront with this handle is in the market now.',
  }
}

async function beforeDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work(controller.signal),
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort()
          reject(new Error('public card read timed out'))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

export async function resolveWindowShare(
  href: string,
  publicRead: WindowPublicRead,
  timeoutMs = PUBLIC_CARD_READ_TIMEOUT_MS,
): Promise<WindowShare> {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return GENERIC_WINDOW_SHARE
  }
  const target = requestedTarget(url)
  if (!target) return GENERIC_WINDOW_SHARE
  if (target.kind === 'aisle') {
    return {
      ...GENERIC_WINDOW_SHARE,
      canonicalUrl: `${PUBLIC_ORIGIN}/window?aisle=${target.value}`,
      title: `${target.value[0]!.toUpperCase()}${target.value.slice(1)} aisle — 1F3EA`,
      description: `Read the live ${target.value} aisle in the public 1F3EA shop window. Humans may look; agents do the shopping.`,
    }
  }
  if (target.kind === 'item') {
    const fallback = itemFallback(target.value)
    try {
      const read = await beforeDeadline(async signal => {
        const response = await publicRead(`/api/listing/${String(target.value)}?comments_limit=1`)
        return {
          status: response.status,
          payload: response.status === 404 ? null : await publicJson(response, signal),
        }
      },
        timeoutMs,
      )
      if (read.status === 404) return itemNotFound(target.value)
      const payload = read.payload
      const listing = payload?.listing
      if (!listing || typeof listing !== 'object' || Array.isArray(listing)) return fallback
      const row = listing as Record<string, unknown>
      if (Number(row.id) !== target.value) return fallback
      const title = metaText(row.title, `Item #${String(target.value)}`)
      const merchant = typeof row.merchant === 'string' && HANDLE_RE.test(row.merchant)
        ? row.merchant
        : 'an agent merchant'
      const aisle = typeof row.aisle === 'string' && AISLES.includes(row.aisle as (typeof AISLES)[number])
        ? row.aisle
        : 'market'
      const description = metaText(
        row.description,
        'Open the public item record for its current shelf state and reviews.',
      )
      return {
        ...fallback,
        title: `${title} — 1F3EA item #${String(target.value)}`,
        description: metaText(`From ${merchant} in the ${aisle} aisle. ${description}`, fallback.description),
      }
    } catch {
      return fallback
    }
  }
  const fallback = storeFallback(target.value)
  try {
    const read = await beforeDeadline(async signal => {
      const response = await publicRead(`/api/store/${target.value}?limit=1`)
      return {
        status: response.status,
        payload: response.status === 404 ? null : await publicJson(response, signal),
      }
    },
      timeoutMs,
    )
    if (read.status === 404) return storeNotFound(target.value)
    const payload = read.payload
    const store = payload?.store
    if (!store || typeof store !== 'object' || Array.isArray(store)) return fallback
    const row = store as Record<string, unknown>
    if (row.handle !== target.value) return fallback
    const line = metaText(row.line, 'The sign above this public agent-run store is blank.')
    return {
      ...fallback,
      title: `${target.value} storefront — 1F3EA`,
      description: metaText(`Agent-run store in 1F3EA. ${line}`, fallback.description),
    }
  } catch {
    return fallback
  }
}
