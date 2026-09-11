import type { Context, Hono } from 'hono'

import { auth, authRequired, err, type Merchant } from './core.ts'
import { logEvent, sql } from './db.ts'
import { MARKET_LIMITS } from './market-facts.ts'

function exactFields(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Object.keys(value)
  return keys.length === fields.length && keys.every(key => fields.includes(key))
}

export function registerModerationRoutes(app: Hono, maintainerId: number): void {
  async function maintainerOnly(c: Context): Promise<Merchant | Response> {
    const merchant = await auth(c)
    if (!merchant) return authRequired(c)
    if (merchant.id !== maintainerId)
      return err(c, 403, 'maintainer only — and every use is logged publicly')
    return merchant
  }

  app.post('/api/mod/remove', async c => {
    const merchant = await maintainerOnly(c)
    if (merchant instanceof Response) return merchant
    const body = await c.req.json().catch(() => null)
    if (!exactFields(body, ['listing_id', 'reason']))
      return err(c, 400, 'body must contain exactly: listing_id, reason')
    const id = Number(body?.listing_id)
    const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
    if (!Number.isInteger(id) || id < 1 || !reason || reason.length > MARKET_LIMITS.social.reasonMaxChars)
      return err(c, 400, `listing_id and reason (1-${MARKET_LIMITS.social.reasonMaxChars} characters measured as UTF-16 code units) required`)
    const rows = await sql`
      WITH removed_listing AS (
        UPDATE listings SET
          removed = TRUE, removed_at = now(), removed_reason = ${reason},
          withdrawn = FALSE,
          world_state = CASE
            WHEN delivery_kind = 'city_ownership' AND world_state <> 'sold' THEN 'canceled'
            ELSE world_state
          END
        WHERE id = ${id} AND NOT removed
        RETURNING id, delivery_kind, world_draft_id
      ), canceled_world_draft AS (
        UPDATE world_drafts d SET state = 'canceled', canceled_at = now(),
          canceled_reason = 'removed by maintainer'
        FROM removed_listing l
        WHERE l.delivery_kind = 'city_ownership' AND d.id = l.world_draft_id AND d.state <> 'sold'
      ), expired_world_checkouts AS (
        UPDATE world_checkouts SET status = 'expired'
        WHERE listing_id IN (SELECT id FROM removed_listing) AND status = 'active'
      ), new_event AS (
        INSERT INTO events (kind, actor, detail)
        SELECT 'moderation', ${merchant.handle}, jsonb_build_object(
          'action', 'remove', 'listing_id', id, 'reason', ${reason}::text
        ) FROM removed_listing
      )
      SELECT id FROM removed_listing`
    if (!rows.length) return err(c, 404, `listing_id ${id} was not found or was already removed. Read GET /api/listing/${id} before retrying.`)
    return c.json({ ok: true })
  })

  app.post('/api/mod/pin', async c => {
    const merchant = await maintainerOnly(c)
    if (merchant instanceof Response) return merchant
    const body = await c.req.json().catch(() => null)
    if (!exactFields(body, ['listing_id', 'pinned']))
      return err(c, 400, 'body must contain exactly: listing_id, pinned')
    const id = Number(body?.listing_id)
    const pinned = body.pinned
    if (!Number.isInteger(id) || id < 1 || typeof pinned !== 'boolean') return err(c, 400, 'listing_id and boolean pinned required')
    const rows = await sql`
      UPDATE listings SET pinned = ${pinned}
      WHERE id = ${id} AND NOT removed AND NOT withdrawn RETURNING id`
    if (!rows.length) return err(c, 404, `listing_id ${id} was not found or is not live. Read GET /api/listing/${id} before retrying.`)
    await logEvent('moderation', merchant.handle, { action: pinned ? 'pin' : 'unpin', listing_id: id })
    return c.json({ ok: true })
  })
}
