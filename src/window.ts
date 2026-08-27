import { readFileSync } from 'node:fs'
import type { Context } from 'hono'
import { sql } from './db.ts'
import {
  AISLES, EDITABLE_LISTING_FIELDS, parseAisleCounts, PUBLIC_EVENT_SCOPES,
} from './market.ts'
import { WINDOW_JS } from './window-client.ts'
import { renderWindowHtml } from './window-page.ts'
import { resolveWindowShare, type WindowPublicRead } from './window-sharing.ts'
import { WINDOW_CSS } from './window-style.ts'

const WINDOW_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
].join('; ')

function harden(c: Context) {
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('Referrer-Policy', 'no-referrer')
  c.header('X-Frame-Options', 'DENY')
  c.header('Cross-Origin-Opener-Policy', 'same-origin')
  c.header('Cross-Origin-Resource-Policy', 'same-origin')
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()')
  c.header('X-Robots-Tag', 'noindex, nofollow, noarchive')
}

const WINDOW_LISTING = `l.id, m.handle AS merchant, l.title, l.description, l.preview,
  l.price_usdc::float8 AS price_usdc, l.tags, l.aisle, l.votes, l.sales, l.pinned,
  l.delivery_kind, l.world_origin AS city_url, l.world_offer_id, l.world_asset_id,
  l.world_seller_handle, l.world_state,
  CASE WHEN l.delivery_kind = 'city_ownership'
    THEN l.world_origin || '/api/world/offer/' || l.world_offer_id END AS city_offer_url,
  CASE WHEN l.delivery_kind = 'city_ownership'
    THEN l.world_origin || '/api/world/offer/' || l.world_offer_id END AS world_asset_url,
  (l.delivery_kind = 'city_ownership') AS requires_city_resident,
  l.created_at, 'live'::text AS state`

const WINDOW_EVENT_PAGE_SIZE = 100
const WINDOW_LISTING_PAGE_SIZE = 50
const WINDOW_MERCHANT_PAGE_SIZE = 500

function publicWindowEvent(value: unknown) {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  const id = Number(row.id)
  if (!Number.isSafeInteger(id) || id <= 0) return null
  const detail = row.detail && typeof row.detail === 'object'
    ? row.detail as Record<string, unknown>
    : {}
  const listingId = Number(detail.listing_id)
  const safeDetail: Record<string, unknown> = {}
  if (Number.isSafeInteger(listingId) && listingId > 0) safeDetail.listing_id = listingId
  if (row.kind === 'sale' || row.kind === 'world_sale') {
    const amount = Number(detail.amount_usdc)
    if (Number.isFinite(amount) && amount >= 0) safeDetail.amount_usdc = amount
  }
  if (row.kind === 'moderation' && ['remove', 'pin', 'unpin'].includes(String(detail.action)))
    safeDetail.action = String(detail.action)
  const changedFieldsValue = detail.changed_fields
  if (row.kind === 'listing_edit' && Array.isArray(changedFieldsValue)) {
    const changedFields = EDITABLE_LISTING_FIELDS
      .filter(field => changedFieldsValue.includes(field))
    if (changedFields.length) safeDetail.changed_fields = changedFields
  }
  return {
    id,
    at: row.at,
    kind: row.kind,
    actor: row.actor,
    detail: safeDetail,
  }
}

async function readWindowSnapshot() {
  const [events, merchants, listings] = await Promise.all([
    sql.query(
      `/* public:window-events */
       SELECT id, at, kind, actor, detail, count(*) OVER()::int AS total_events FROM events
       WHERE kind = ANY($1::text[])
       ORDER BY id DESC LIMIT ${WINDOW_EVENT_PAGE_SIZE + 1}`,
      [[...PUBLIC_EVENT_SCOPES.window]],
    ),
    sql`
      /* public:window-merchants */
      SELECT m.id, m.handle, m.model, m.storefront_line AS line, m.karma, m.joined_at,
        count(l.id)::int AS listings, count(*) OVER()::int AS total_merchants
      FROM merchants m LEFT JOIN listings l
        ON l.merchant_id = m.id AND NOT l.removed AND NOT l.withdrawn
          AND (l.delivery_kind = 'artifact' OR l.world_state = 'active')
      GROUP BY m.id ORDER BY m.joined_at ASC, m.id ASC LIMIT ${WINDOW_MERCHANT_PAGE_SIZE}`,
    sql.query(
      `/* public:window-listings */
       WITH active AS (
         SELECT ${WINDOW_LISTING} FROM listings l JOIN merchants m ON m.id = l.merchant_id
         WHERE NOT l.removed AND NOT l.withdrawn
           AND (l.delivery_kind = 'artifact' OR l.world_state = 'active')
       ), active_counts AS (
         SELECT aisle, count(*)::int AS count FROM active GROUP BY aisle
       ), aisle_counts AS (
         SELECT coalesce(
           jsonb_agg(jsonb_build_object('name', aisle, 'count', count) ORDER BY aisle),
           '[]'::jsonb
         )::text AS __aisles FROM active_counts
       ), totals AS (
         SELECT count(*)::int AS __total FROM active
       ), page AS (
         SELECT * FROM active
         ORDER BY pinned DESC, created_at DESC, id DESC LIMIT ${WINDOW_LISTING_PAGE_SIZE}
       )
       SELECT page.*, totals.__total, aisle_counts.__aisles
       FROM totals CROSS JOIN aisle_counts LEFT JOIN page ON TRUE
       ORDER BY page.pinned DESC, page.created_at DESC, page.id DESC`,
    ),
  ])
  const merchantRows = merchants as Record<string, unknown>[]
  const merchantTotal = merchantRows.length ? Number(merchantRows[0]?.total_merchants) : 0
  if (!Number.isSafeInteger(merchantTotal) || merchantTotal < merchantRows.length)
    throw new Error('window merchant count is inconsistent')
  const publicMerchants = merchantRows.map(({ total_merchants: _total, ...merchant }) => merchant)
  const eventRows = events as Record<string, unknown>[]
  const eventTotal = eventRows.length ? Number(eventRows[0]?.total_events) : 0
  if (!Number.isSafeInteger(eventTotal) || eventTotal < eventRows.length)
    throw new Error('window event count is inconsistent')
  const eventPage = eventRows.slice(0, WINDOW_EVENT_PAGE_SIZE).map(publicWindowEvent)
  if (eventPage.some(event => event === null)) throw new Error('window event row is inconsistent')
  const publicEvents = eventPage.filter(event => event !== null)
  const rawListingRows = listings as Record<string, unknown>[]
  const listingsTotal = Number(rawListingRows[0]?.__total ?? 0)
  const counts = parseAisleCounts(rawListingRows[0]?.__aisles)
  const listingRows = rawListingRows.flatMap(row => {
    const { __aisles: _aisles, __total: _total, ...listing } = row
    const id = Number(listing.id)
    return Number.isSafeInteger(id) && id > 0 ? [listing] : []
  })
  if (!Number.isSafeInteger(listingsTotal) || listingsTotal < 0)
    throw new Error('window listing count is inconsistent')
  if (listingsTotal < listingRows.length) throw new Error('window listing count is inconsistent')
  const eventsHaveMore = eventTotal > publicEvents.length
  const listingsHaveMore = listingsTotal > listingRows.length
  const merchantsHaveMore = merchantTotal > publicMerchants.length
  const lastEventId = publicEvents.at(-1)?.id
  const lastMerchantId = Number(publicMerchants.at(-1)?.id)
  if (eventsHaveMore && !lastEventId) throw new Error('window event continuation is missing')
  if (merchantsHaveMore && (!Number.isSafeInteger(lastMerchantId) || lastMerchantId <= 0))
    throw new Error('window merchant continuation is missing')
  return {
    events: publicEvents,
    events_total: eventTotal,
    events_returned: publicEvents.length,
    events_page_size: WINDOW_EVENT_PAGE_SIZE,
    events_has_more: eventsHaveMore,
    events_more_url: eventsHaveMore
      ? `/api/events?scope=window&before_id=${String(lastEventId)}`
      : null,
    merchants: publicMerchants,
    merchant_total: merchantTotal,
    merchants_returned: publicMerchants.length,
    merchants_page_size: WINDOW_MERCHANT_PAGE_SIZE,
    merchants_has_more: merchantsHaveMore,
    merchants_more_url: merchantsHaveMore
      ? `/api/merchants?after_id=${String(lastMerchantId)}`
      : null,
    listings: listingRows,
    listings_total: listingsTotal,
    listings_returned: listingRows.length,
    listings_page_size: WINDOW_LISTING_PAGE_SIZE,
    listings_has_more: listingsHaveMore,
    listings_more_url: listingsHaveMore ? '/api/shelves' : null,
    aisles: AISLES.map(name => ({ name, count: counts.get(name) ?? 0 })),
    refreshed_at: new Date().toISOString(),
  }
}

type WindowSnapshot = Awaited<ReturnType<typeof readWindowSnapshot>>
let snapshotCache: { expiresAt: number; pending: Promise<WindowSnapshot> } | null = null

async function cachedWindowSnapshot() {
  const now = Date.now()
  if (snapshotCache && snapshotCache.expiresAt > now) return snapshotCache.pending
  const pending = readWindowSnapshot()
  snapshotCache = { expiresAt: now + 30_000, pending }
  try {
    return await pending
  } catch (error) {
    if (snapshotCache?.pending === pending) snapshotCache = null
    throw error
  }
}

export async function windowSnapshot(c: Context) {
  const url = new URL(c.req.url)
  const hasCredentials = ['authorization', 'cookie', 'x-payment']
    .some(name => Boolean(c.req.header(name)))
  if (url.search || hasCredentials)
    return c.json({ error: 'the public shop window accepts no query or credential data' }, 400)
  const snapshot = await cachedWindowSnapshot()
  c.header('Cache-Control', 'public, max-age=15, s-maxage=60, stale-while-revalidate=300')
  return c.json(snapshot)
}

export async function windowPage(c: Context, publicRead: WindowPublicRead) {
  harden(c)
  c.header('Content-Security-Policy', WINDOW_CSP)
  c.header('Cache-Control', 'public, max-age=0, must-revalidate')
  const share = await resolveWindowShare(c.req.url, publicRead)
  return c.html(renderWindowHtml(share))
}

const WINDOW_CARD = Uint8Array.from(readFileSync(new URL('./assets/1f3ea-512.png', import.meta.url)))

export function windowCard(c: Context) {
  c.header('Cache-Control', 'public, max-age=86400, s-maxage=604800, stale-while-revalidate=2592000')
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('Cross-Origin-Resource-Policy', 'cross-origin')
  return c.body(WINDOW_CARD, 200, { 'Content-Type': 'image/png' })
}

export function windowStyle(c: Context) {
  harden(c)
  c.header('Cache-Control', 'public, max-age=0, must-revalidate')
  return c.body(WINDOW_CSS, 200, { 'Content-Type': 'text/css; charset=utf-8' })
}

export function windowScript(c: Context) {
  harden(c)
  c.header('Cache-Control', 'public, max-age=0, must-revalidate')
  return c.body(WINDOW_JS, 200, { 'Content-Type': 'text/javascript; charset=utf-8' })
}
