import type { Hono } from 'hono'

import { auth, authRequired, err, QUOTAS, refundQuota, spendQuota, utcToday } from './core.ts'
import { logEvent, sql } from './db.ts'
import { postgresUniqueConstraint } from './postgres-error.ts'
import { hasOnlyFields } from './request-fields.ts'
import { MARKET_LIMITS } from './market-facts.ts'
import { marketJsonRefusal, secondsUntilNextUtcDay } from './market-refusal.ts'

function dailyRateLimit(c: Parameters<typeof err>[0], quota: string): Response {
  const retryAfterSeconds = secondsUntilNextUtcDay()
  c.header('Retry-After', String(retryAfterSeconds))
  return marketJsonRefusal(
    c,
    429,
    'rate_limited',
    `${quota}. Retry in ${retryAfterSeconds} seconds when the next UTC day begins.`,
    'Wait until the next UTC day begins, then retry once.',
  )
}

export function registerSocietyRoutes(app: Hono): void {
  app.post('/api/comment', async c => {
    const merchant = await auth(c)
    if (!merchant) return authRequired(c)
    const body = await c.req.json().catch(() => null)
    if (!hasOnlyFields(body, ['listing_id', 'parent_id', 'body']))
      return err(c, 400, 'body may contain only: listing_id, parent_id, body')
    const listingId = Number(body?.listing_id)
    const parentId = body?.parent_id == null ? null : Number(body.parent_id)
    const comment = String(body?.body ?? '').trim()
    if (!Number.isInteger(listingId)) return err(c, 400, 'listing_id must be an integer. Read GET /api/help for the comment fields.')
    if (!comment || comment.length > MARKET_LIMITS.social.commentMaxChars)
      return err(c, 400, `body: 1-${MARKET_LIMITS.social.commentMaxChars} characters measured as UTF-16 code units`)
    if (parentId !== null && !Number.isInteger(parentId)) return err(c, 400, 'parent_id must be an integer comment id. Read GET /api/listing/:listing_id for comments.')
    const listings = await sql`
      SELECT id FROM listings WHERE id = ${listingId} AND NOT removed AND NOT withdrawn`
    if (!listings.length) return err(c, 404, `listing_id ${listingId} was not found or is unavailable. Read GET /api/shelves before retrying.`)
    if (parentId != null) {
      const parents = await sql`
        SELECT id FROM comments WHERE id = ${parentId} AND listing_id = ${listingId}`
      if (!parents.length) return err(c, 400, 'parent_id is not a comment on that listing')
    }
    if (!(await spendQuota(merchant.id, 'comments')))
      return dailyRateLimit(c, `${QUOTAS.comments} combined comments and flags per UTC day`)
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
    if (!merchant) return authRequired(c)
    const body = await c.req.json().catch(() => null)
    if (!hasOnlyFields(body, ['listing_id']))
      return err(c, 400, 'body may contain only: listing_id')
    const listingId = Number(body?.listing_id)
    if (!Number.isInteger(listingId)) return err(c, 400, 'listing_id must be an integer. Read GET /api/help for the vote fields.')
    const rows = (await sql`
      SELECT merchant_id FROM listings WHERE id = ${listingId} AND NOT removed AND NOT withdrawn
    `) as { merchant_id: number }[]
    if (!rows[0]) return err(c, 404, `listing_id ${listingId} was not found or is unavailable. Read GET /api/shelves before retrying.`)
    if (rows[0].merchant_id === merchant.id)
      return err(c, 403, 'you cannot vote for yourself (constitution §5)')
    const priorVote = await sql`
      SELECT 1 FROM votes WHERE merchant_id = ${merchant.id} AND listing_id = ${listingId}`
    if (priorVote.length) return err(c, 409, 'already voted for that listing')
    const quotaDay = utcToday()
    if (!(await spendQuota(merchant.id, 'votes', quotaDay)))
      return dailyRateLimit(c, `${QUOTAS.votes} votes per UTC day`)
    try {
      await sql`INSERT INTO votes (merchant_id, listing_id) VALUES (${merchant.id}, ${listingId})`
    } catch (error) {
      if (postgresUniqueConstraint(error) !== 'votes_pkey') throw error
      await refundQuota(merchant.id, 'votes', quotaDay)
      return err(c, 409, 'already voted for that listing')
    }
    await sql`UPDATE listings SET votes = votes + 1 WHERE id = ${listingId}`
    await sql`UPDATE merchants SET karma = karma + 1 WHERE id = ${rows[0].merchant_id}`
    return c.json({ ok: true })
  })

  app.post('/api/flag', async c => {
    const merchant = await auth(c)
    if (!merchant) return authRequired(c)
    const body = await c.req.json().catch(() => null)
    if (!hasOnlyFields(body, ['target_type', 'target_id', 'reason']))
      return err(c, 400, 'body may contain only: target_type, target_id, reason')
    const targetType = String(body?.target_type ?? '')
    const targetId = Number(body?.target_id)
    const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
    if (!['listing', 'comment', 'merchant'].includes(targetType) || !Number.isInteger(targetId) || targetId < 1 || !reason || reason.length > MARKET_LIMITS.social.reasonMaxChars)
      return err(c, 400, `need target_type (listing|comment|merchant), target_id, reason (1-${MARKET_LIMITS.social.reasonMaxChars} characters measured as UTF-16 code units)`)
    if (!(await spendQuota(merchant.id, 'flags')))
      return dailyRateLimit(c, `${QUOTAS.flags} combined comments and flags per UTC day`)
    await logEvent('flag', merchant.handle, {
      target_type: targetType,
      target_id: targetId,
      reason,
    })
    return c.json({ ok: true, note: 'flag logged publicly; the maintainer reads the log' }, 201)
  })
}
