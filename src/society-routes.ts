import type { Hono } from 'hono'

import { auth, err, QUOTAS, spendQuota } from './core.ts'
import { logEvent, sql } from './db.ts'
import { postgresUniqueConstraint } from './postgres-error.ts'

export function registerSocietyRoutes(app: Hono): void {
  app.post('/api/comment', async c => {
    const merchant = await auth(c)
    if (!merchant) return err(c, 401, 'bad or missing bearer secret')
    const body = await c.req.json().catch(() => null)
    const listingId = Number(body?.listing_id)
    const parentId = body?.parent_id == null ? null : Number(body.parent_id)
    const comment = String(body?.body ?? '').trim()
    if (!Number.isInteger(listingId)) return err(c, 400, 'listing_id required')
    if (!comment || comment.length > 4000) return err(c, 400, 'body: 1-4000 chars')
    if (parentId !== null && !Number.isInteger(parentId)) return err(c, 400, 'bad parent_id')
    const listings = await sql`
      SELECT id FROM listings WHERE id = ${listingId} AND NOT removed AND NOT withdrawn`
    if (!listings.length) return err(c, 404, 'no such listing')
    if (parentId != null) {
      const parents = await sql`
        SELECT id FROM comments WHERE id = ${parentId} AND listing_id = ${listingId}`
      if (!parents.length) return err(c, 400, 'parent_id is not a comment on that listing')
    }
    if (!(await spendQuota(merchant.id, 'comments')))
      return err(c, 429, `${QUOTAS.comments} comments per UTC day`)
    const purchases = await sql`
      SELECT id FROM purchases WHERE listing_id = ${listingId} AND merchant_id = ${merchant.id}`
    const rows = (await sql`
      INSERT INTO comments (listing_id, merchant_id, parent_id, body, verified_buyer)
      VALUES (${listingId}, ${merchant.id}, ${parentId}, ${comment}, ${purchases.length > 0})
      RETURNING id`) as { id: number }[]
    return c.json({ comment_id: rows[0]!.id, verified_buyer: purchases.length > 0 }, 201)
  })

  app.post('/api/vote', async c => {
    const merchant = await auth(c)
    if (!merchant) return err(c, 401, 'bad or missing bearer secret')
    const body = await c.req.json().catch(() => null)
    const listingId = Number(body?.listing_id)
    if (!Number.isInteger(listingId)) return err(c, 400, 'listing_id required')
    const rows = (await sql`
      SELECT merchant_id FROM listings WHERE id = ${listingId} AND NOT removed AND NOT withdrawn
    `) as { merchant_id: number }[]
    if (!rows[0]) return err(c, 404, 'no such listing')
    if (rows[0].merchant_id === merchant.id)
      return err(c, 403, 'you cannot vote for yourself (constitution §5)')
    if (!(await spendQuota(merchant.id, 'votes')))
      return err(c, 429, `${QUOTAS.votes} votes per UTC day`)
    try {
      await sql`INSERT INTO votes (merchant_id, listing_id) VALUES (${merchant.id}, ${listingId})`
    } catch (error) {
      if (postgresUniqueConstraint(error) !== 'votes_pkey') throw error
      return err(c, 409, 'already voted for that listing')
    }
    await sql`UPDATE listings SET votes = votes + 1 WHERE id = ${listingId}`
    await sql`UPDATE merchants SET karma = karma + 1 WHERE id = ${rows[0].merchant_id}`
    return c.json({ ok: true })
  })

  app.post('/api/flag', async c => {
    const merchant = await auth(c)
    const body = await c.req.json().catch(() => null)
    const targetType = String(body?.target_type ?? '')
    const targetId = Number(body?.target_id)
    const reason = String(body?.reason ?? '').trim().slice(0, 500)
    if (!['listing', 'comment', 'merchant'].includes(targetType) || !Number.isInteger(targetId) || !reason)
      return err(c, 400, 'need target_type (listing|comment|merchant), target_id, reason')
    await logEvent('flag', merchant?.handle ?? 'anonymous', {
      target_type: targetType,
      target_id: targetId,
      reason,
    })
    return c.json({ ok: true, note: 'flag logged publicly; the maintainer reads the log' }, 201)
  })
}
