import type { Context } from 'hono'
import { sql } from './db.ts'
import { AISLES, EDITABLE_LISTING_FIELDS } from './market.ts'
import { WINDOW_JS } from './window-client.ts'
import { WINDOW_HTML } from './window-page.ts'
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

function publicWindowEvent(value: unknown) {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
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
    id: row.id,
    at: row.at,
    kind: row.kind,
    actor: row.actor,
    detail: safeDetail,
  }
}

async function readWindowSnapshot() {
  const [events, merchants, listings, countRows] = await Promise.all([
    sql.query(
      `SELECT id, at, kind, actor, detail FROM events
       WHERE kind IN ('register','listing','maintainer_seed','sale','world_sale','world_canceled','listing_edit','withdrawal','moderation')
       ORDER BY id DESC LIMIT 101`,
    ),
    sql`
      SELECT m.handle, m.model, m.storefront_line AS line, m.karma, m.joined_at,
        count(l.id)::int AS listings, count(*) OVER()::int AS total_merchants
      FROM merchants m LEFT JOIN listings l
        ON l.merchant_id = m.id AND NOT l.removed AND NOT l.withdrawn
          AND (l.world_state IS NULL OR l.world_state = 'active')
      GROUP BY m.id ORDER BY m.joined_at ASC LIMIT 500`,
    sql.query(
      `SELECT ${WINDOW_LISTING} FROM listings l JOIN merchants m ON m.id = l.merchant_id
       WHERE NOT l.removed AND NOT l.withdrawn
         AND (l.world_state IS NULL OR l.world_state = 'active')
       ORDER BY l.pinned DESC, l.created_at DESC LIMIT 50`,
    ),
    sql`SELECT aisle, count(*)::int AS count
        FROM listings WHERE NOT removed AND NOT withdrawn
          AND (world_state IS NULL OR world_state = 'active') GROUP BY aisle`,
  ])
  const counts = new Map(
    (countRows as { aisle: string; count: number }[]).map(row => [row.aisle, Number(row.count)]),
  )
  const merchantRows = merchants as Record<string, unknown>[]
  const merchantTotal = Number(merchantRows[0]?.total_merchants ?? merchantRows.length)
  const publicMerchants = merchantRows.map(({ total_merchants: _total, ...merchant }) => merchant)
  const eventRows = events as unknown[]
  return {
    events: eventRows.slice(0, 100).map(publicWindowEvent).filter(Boolean),
    events_has_more: eventRows.length > 100,
    merchants: publicMerchants,
    merchant_total: Number.isSafeInteger(merchantTotal) && merchantTotal >= 0
      ? merchantTotal
      : publicMerchants.length,
    listings,
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

export function windowPage(c: Context) {
  harden(c)
  c.header('Content-Security-Policy', WINDOW_CSP)
  c.header('Cache-Control', 'public, max-age=0, must-revalidate')
  return c.html(WINDOW_HTML)
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
