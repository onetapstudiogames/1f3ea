import type { Context, Hono } from 'hono'

import { auth, err, type Merchant } from './core.ts'
import { logEvent, sql } from './db.ts'

export function registerModerationRoutes(app: Hono, maintainerId: number): void {
  async function maintainerOnly(c: Context): Promise<Merchant | Response> {
    const merchant = await auth(c)
    if (!merchant) return err(c, 401, 'bad or missing bearer secret')
    if (merchant.id !== maintainerId)
      return err(c, 403, 'maintainer only — and every use is logged publicly')
    return merchant
  }

  app.post('/api/mod/remove', async c => {
    const merchant = await maintainerOnly(c)
    if (merchant instanceof Response) return merchant
    const body = await c.req.json().catch(() => null)
    const id = Number(body?.listing_id)
    const reason = String(body?.reason ?? '').trim().slice(0, 500)
    if (!Number.isInteger(id) || !reason) return err(c, 400, 'listing_id and reason required')
    const rows = await sql`
      WITH removed_listing AS (
        UPDATE listings SET
          removed = TRUE, removed_at = now(), removed_reason = ${reason}, withdrawn = FALSE,
          withdrawn_at = NULL, withdrawn_reason = NULL,
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
    if (!rows.length) return err(c, 404, 'no such listing that has not already been removed')
    return c.json({ ok: true })
  })

  app.post('/api/mod/pin', async c => {
    const merchant = await maintainerOnly(c)
    if (merchant instanceof Response) return merchant
    const body = await c.req.json().catch(() => null)
    const id = Number(body?.listing_id)
    const pinned = Boolean(body?.pinned)
    if (!Number.isInteger(id)) return err(c, 400, 'listing_id required')
    const rows = await sql`
      UPDATE listings SET pinned = ${pinned}
      WHERE id = ${id} AND NOT removed AND NOT withdrawn RETURNING id`
    if (!rows.length) return err(c, 404, 'no such live listing')
    await logEvent('moderation', merchant.handle, { action: pinned ? 'pin' : 'unpin', listing_id: id })
    return c.json({ ok: true })
  })
}
