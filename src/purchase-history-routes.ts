import type { Hono } from 'hono'

import { PURCHASE_HISTORY_PAGE_LIMIT } from './collection-contract.ts'
import { auth, authRequired, err } from './core.ts'
import { sql } from './db.ts'
import {
  countedPage,
  invalidPageCursor,
  parseNumericPage,
  type CountedRow,
} from './public-pagination.ts'
import { safeWorldReceiptForHistory } from './world-payment-sync.ts'
import { attachCityStatus, hiddenWorldBindings } from './world.ts'

export function registerPurchaseHistoryRoutes(app: Hono): void {
  app.get('/api/purchases', async c => {
    const merchant = await auth(c)
    if (!merchant) return authRequired(c)
    const requestedPage = parseNumericPage(new URL(c.req.url).searchParams, {
      cursorName: 'before_id',
      defaultLimit: PURCHASE_HISTORY_PAGE_LIMIT,
      maxLimit: PURCHASE_HISTORY_PAGE_LIMIT,
    })
    if (!requestedPage.ok) return err(c, 400, requestedPage.error)
    const rawRows = (await sql`
      /* private:purchases */
      WITH eligible AS (
        SELECT p.id, p.listing_id, l.title, p.amount_usdc::float8 AS amount_usdc,
          p.verified_via, p.created_at, l.delivery_kind,
          CASE WHEN l.delivery_kind = 'artifact' THEN l.artifact END AS artifact,
          CASE WHEN l.delivery_kind = 'city_ownership' THEN p.world_receipt END AS world_receipt,
          CASE WHEN l.delivery_kind = 'city_ownership'
            THEN l.world_origin || '/api/world/offer/' || l.world_offer_id END AS city_receipt_url,
          CASE WHEN l.delivery_kind = 'city_ownership' THEN jsonb_build_object(
            'id', l.id, 'world_offer_id', l.world_offer_id, 'world_asset_id', l.world_asset_id,
            'world_draft_id', l.world_draft_id, 'world_seller_handle', l.world_seller_handle,
            'price_usdc', l.price_usdc::float8, 'seller_wallet', l.seller_wallet
          ) END AS __world_binding
        FROM purchases p JOIN listings l ON l.id = p.listing_id
        WHERE p.merchant_id = ${merchant.id}
      ), totals AS (
        SELECT count(*)::int AS __total,
          (${requestedPage.cursor}::int IS NULL OR EXISTS (
            SELECT 1 FROM eligible WHERE id = ${requestedPage.cursor}
          )) AS __cursor_valid
        FROM eligible
      ), page AS (
        SELECT candidate.* FROM eligible candidate
        WHERE (${requestedPage.cursor}::int IS NULL OR EXISTS (
          SELECT 1 FROM eligible anchor WHERE anchor.id = ${requestedPage.cursor} AND (
            candidate.created_at < anchor.created_at OR
            (candidate.created_at = anchor.created_at AND candidate.id < anchor.id)
          )
        ))
        ORDER BY candidate.created_at DESC, candidate.id DESC LIMIT ${requestedPage.fetchLimit}
      )
      SELECT page.*, totals.__total, totals.__cursor_valid FROM totals LEFT JOIN page ON TRUE
      ORDER BY page.created_at DESC, page.id DESC`) as CountedRow[]
    if (invalidPageCursor(rawRows))
      return err(c, 400, 'before_id is not one of your purchases')
    const page = countedPage(rawRows, requestedPage.limit)
    const cards = await attachCityStatus(page.items, hiddenWorldBindings(rawRows, page.items))
    const purchases = cards.items.map(row => {
      if (row.delivery_kind !== 'city_ownership') {
        const { world_receipt: _receipt, city_receipt_url: _cityUrl, ...artifactPurchase } = row
        return artifactPurchase
      }
      const { artifact: _artifact, ...worldPurchase } = row
      return { ...worldPurchase, ...safeWorldReceiptForHistory(row) }
    })
    return c.json({
      purchases,
      total: page.total,
      returned: purchases.length,
      page_size: requestedPage.limit,
      has_more: page.hasMore,
      next_before_id: page.nextCursor,
    })
  })
}
