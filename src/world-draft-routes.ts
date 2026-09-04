import type { Hono } from 'hono'
import { auth, err } from './core.ts'
import { sql } from './db.ts'
import { postgresErrorDetails } from './postgres-error.ts'
import { dateIsPast, positiveId } from './world-route-shared.ts'
import { validWorldDraft, type WorldDraftInput } from './world.ts'

interface WorldDraftRouteConfig {
  marketOrigin: string
}

export interface WorldDraftRow extends WorldDraftInput {
  id: number
  merchant_id: number
  state: 'pending' | 'active' | 'withdrawn' | 'sold' | 'expired' | 'canceled'
  listing_id: number | null
  listing_state: string | null
  listing_withdrawn?: boolean
  listing_removed?: boolean
  created_at: string
  expires_at: string
  canceled_at: string | null
}

export const ACTIVE_WORLD_DRAFT_EXPIRY = '9999-12-31T23:59:59.999Z'

function publicDraftStatus(row: WorldDraftRow) {
  if (row.state === 'pending' && dateIsPast(row.expires_at)) return 'expired' as const
  if (row.listing_state === 'sold') return 'sold' as const
  if (row.listing_removed || row.state === 'canceled') return 'canceled' as const
  if (row.state === 'withdrawn') return 'withdrawn' as const
  if (row.listing_state === 'canceled' || row.listing_state === 'stale') return 'canceled' as const
  if (row.listing_withdrawn) return 'withdrawn' as const
  return row.state
}

function draftEnvelope(row: WorldDraftRow) {
  const listingState = row.listing_state === 'stale' ? 'canceled' : row.listing_state ?? null
  // This read override covers drafts activated before sentinel writes shipped; no backfill was run.
  const expiresAt = row.state === 'active' && listingState === 'active'
    ? ACTIVE_WORLD_DRAFT_EXPIRY
    : row.expires_at
  return {
    id: Number(row.id),
    status: publicDraftStatus(row),
    delivery_kind: 'city_ownership' as const,
    world_asset: { type: 'thing' as const, id: Number(row.thing_id) },
    title: row.title,
    description: row.description,
    preview: row.preview,
    price_usdc: Number(row.price_usdc),
    seller_wallet: row.seller_wallet,
    listing_id: row.listing_id == null ? null : Number(row.listing_id),
    listing_state: listingState,
    expires_at: expiresAt,
    created_at: row.created_at,
  }
}

export async function readWorldDraft(id: number): Promise<WorldDraftRow | null> {
  const rows = (await sql`
    SELECT d.id, d.merchant_id, d.thing_id, d.title, d.description, d.preview,
      d.price_usdc::float8 AS price_usdc, d.seller_wallet, d.tags, d.state,
      d.listing_id, d.created_at, d.expires_at, d.canceled_at,
      l.world_state AS listing_state, l.withdrawn AS listing_withdrawn,
      l.removed AS listing_removed
    FROM world_drafts d LEFT JOIN listings l ON l.id = d.listing_id
    WHERE d.id = ${id}`) as WorldDraftRow[]
  return rows[0] ?? null
}

export function registerWorldDraftRoutes(app: Hono, config: WorldDraftRouteConfig) {
  app.post('/api/world/draft', async c => {
    const merchant = await auth(c)
    if (!merchant) return err(c, 401, 'bad or missing bearer secret')
    const parsed = validWorldDraft(await c.req.json().catch(() => null))
    if (typeof parsed === 'string') return err(c, 400, parsed)
    try {
      const rows = (await sql`
        WITH expired_drafts AS (
          UPDATE world_drafts SET state = 'expired'
          WHERE merchant_id = ${merchant.id} AND state = 'pending' AND expires_at <= now()
        ), new_draft AS (
          INSERT INTO world_drafts (
            merchant_id, thing_id, title, description, preview, price_usdc, seller_wallet, tags
          ) VALUES (
            ${merchant.id}, ${parsed.thing_id}, ${parsed.title}, ${parsed.description}, ${parsed.preview},
            ${parsed.price_usdc}, ${parsed.seller_wallet}, ${parsed.tags}
          )
          RETURNING id, expires_at
        )
        SELECT id, expires_at FROM new_draft`) as { id: number; expires_at: string }[]
      const draft = rows[0]!
      return c.json({
        draft_id: Number(draft.id),
        url: `${config.marketOrigin}/api/world/draft/${draft.id}`,
        expires_at: draft.expires_at,
        next: 'Authenticate separately to the city and POST its world listing route with this public draft id.',
      }, 201)
    } catch (error) {
      const details = postgresErrorDetails(error)
      if (details.code === '23505' && details.constraint === 'world_drafts_one_pending_per_merchant')
        return err(c, 409, 'you already have a live pending draft; activate it, POST /api/world/draft/:id/cancel, or wait for expiry')
      throw error
    }
  })

  app.post('/api/world/draft/:id/cancel', async c => {
    const merchant = await auth(c)
    if (!merchant) return err(c, 401, 'bad or missing bearer secret')
    const id = positiveId(c.req.param('id'))
    if (!id) return err(c, 400, 'draft id must be a positive integer')
    const rows = (await sql`
      WITH owned_draft AS (
        SELECT draft.id, draft.state, draft.listing_id, draft.expires_at,
          EXISTS (
            SELECT 1 FROM listing_fee_attempts attempt
            WHERE attempt.world_draft_id = draft.id
              AND attempt.fee_request_kind = 'world_listing'
              AND attempt.payment_status = 'payment_pending'
          ) AS listing_fee_pending
        FROM world_drafts draft
        WHERE draft.id = ${id} AND draft.merchant_id = ${merchant.id}
        FOR UPDATE OF draft
      ), canceled_draft AS (
        UPDATE world_drafts draft SET state = 'canceled', canceled_at = now(),
          canceled_reason = 'canceled by merchant'
        FROM owned_draft owned
        WHERE draft.id = owned.id AND owned.state = 'pending'
          AND owned.expires_at > now() AND NOT owned.listing_fee_pending
        RETURNING draft.id
      )
      SELECT owned.state, owned.listing_id, owned.listing_fee_pending,
        canceled.id AS canceled_id
      FROM owned_draft owned LEFT JOIN canceled_draft canceled ON TRUE`) as {
        state: WorldDraftRow['state']; listing_id: number | null
        listing_fee_pending: boolean; canceled_id: number | null
      }[]
    const result = rows[0]
    if (!result) return err(c, 404, 'no such world draft')
    if (result.canceled_id) return c.json({ draft_id: id, status: 'canceled' as const })
    if (result.listing_id != null) return err(c, 409, 'world draft is already activated')
    if (result.listing_fee_pending) return err(c, 409,
      'this draft has a recorded listing fee still reaching finality; retry the listing request instead of canceling')
    return err(c, 409, 'world draft is not pending')
  })

  app.get('/api/world/draft/:id', async c => {
    const id = positiveId(c.req.param('id'))
    if (!id) return err(c, 400, 'draft id must be a positive integer')
    const draft = await readWorldDraft(id)
    if (!draft) return err(c, 404, 'no such world draft')
    c.header('Cache-Control', 'public, max-age=5, s-maxage=10')
    return c.json({ draft: draftEnvelope(draft) })
  })
}
