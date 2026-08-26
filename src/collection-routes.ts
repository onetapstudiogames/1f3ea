import type { Hono } from 'hono'

import { NETWORK, usdcBalance } from './chain.ts'
import { auth, err, HANDLE_RE, QUOTAS } from './core.ts'
import { sql } from './db.ts'
import {
  AISLES, isAisle, parseAisleCounts, PUBLIC_EVENT_SCOPES,
  type Aisle, type PublicEventScope,
} from './market.ts'
import { TREASURY } from './pay.ts'
import {
  countedPage, decodeShelfCursor, encodeShelfCursor, invalidPageCursor, parseNumericPage,
  type CountedRow, type ShelfCursorScope,
} from './public-pagination.ts'
import { requireValidWorldReceipt } from './world-routes.ts'

const PUBLIC_LISTING = `l.id, m.handle AS merchant, l.title, l.description, l.preview,
  '/api/store/' || m.handle AS store_url, l.price_usdc::float8 AS price_usdc,
  l.seller_wallet, l.tags, l.aisle, l.votes, l.sales, l.pinned, l.created_at,
  l.delivery_kind, l.world_origin AS city_url, l.world_offer_id, l.world_asset_id,
  l.world_seller_handle, l.world_draft_id, l.world_state,
  CASE WHEN l.delivery_kind = 'city_ownership'
    THEN l.world_origin || '/api/world/offer/' || l.world_offer_id END AS city_offer_url,
  CASE WHEN l.delivery_kind = 'city_ownership'
    THEN l.world_origin || '/api/world/offer/' || l.world_offer_id END AS world_asset_url,
  (l.delivery_kind = 'city_ownership') AS requires_city_resident,
  'live'::text AS state`

const AISLE_COUNTS_CTE = `active_counts AS (
    SELECT aisle, count(*)::int AS count FROM active GROUP BY aisle
  ), aisle_counts AS (
    SELECT coalesce(
      jsonb_agg(jsonb_build_object('name', aisle, 'count', count) ORDER BY aisle),
      '[]'::jsonb
    )::text AS __aisles
    FROM active_counts
  )`

function eventScope(params: URLSearchParams):
  | { ok: true; kind: string | null; scope: PublicEventScope | null; kinds: readonly string[] | null }
  | { ok: false; error: string } {
  const kindValues = params.getAll('kind')
  const scopeValues = params.getAll('scope')
  if (kindValues.length > 1) return { ok: false, error: 'kind may appear only once' }
  if (scopeValues.length > 1) return { ok: false, error: 'scope may appear only once' }
  if (kindValues.length && scopeValues.length)
    return { ok: false, error: 'scope and kind cannot be combined' }
  const rawScope = scopeValues[0]
  if (rawScope !== undefined && rawScope !== 'door' && rawScope !== 'window')
    return { ok: false, error: 'scope must be door or window' }
  const scope = rawScope as PublicEventScope | undefined
  return {
    ok: true,
    kind: kindValues[0]?.slice(0, 40) ?? null,
    scope: scope ?? null,
    kinds: scope ? PUBLIC_EVENT_SCOPES[scope] : null,
  }
}

export function registerCollectionRoutes(app: Hono) {
  app.get('/api/store/:handle', async c => {
    const handle = c.req.param('handle').toLowerCase()
    if (!HANDLE_RE.test(handle)) return err(c, 404, 'no such store')
    const params = new URL(c.req.url).searchParams
    const bounded = params.has('limit') || params.has('before_id')
    const requestedPage = bounded
      ? parseNumericPage(params, { cursorName: 'before_id', defaultLimit: 50, maxLimit: 50 })
      : null
    if (requestedPage && !requestedPage.ok) return err(c, 400, requestedPage.error)
    const stores = (await sql`
      SELECT m.id, m.handle, m.model, m.storefront_line AS line, m.karma, m.joined_at
      FROM merchants m WHERE m.handle = ${handle}`) as {
        id: number; handle: string; model: string; line: string; karma: number; joined_at: string
      }[]
    const store = stores[0]
    if (!store) return err(c, 404, 'no such store')
    let listings: Record<string, unknown>[]
    let total: number
    let pageSize: number
    let hasMore = false
    let nextBeforeId: number | null = null
    if (!requestedPage) {
      listings = await sql.query(
        `/* public:store-complete */
         SELECT ${PUBLIC_LISTING} FROM listings l JOIN merchants m ON m.id = l.merchant_id
         WHERE l.merchant_id = $1 AND NOT l.removed AND NOT l.withdrawn
           AND (l.delivery_kind = 'artifact' OR l.world_state = 'active')
         ORDER BY l.pinned DESC, l.created_at DESC, l.id DESC`, [store.id],
      )
      total = listings.length
      pageSize = listings.length
    } else {
      const rawListings = (await sql.query(
        `/* public:store-page */
         WITH eligible AS (
           SELECT ${PUBLIC_LISTING} FROM listings l JOIN merchants m ON m.id = l.merchant_id
           WHERE l.merchant_id = $1 AND NOT l.removed AND NOT l.withdrawn
             AND (l.delivery_kind = 'artifact' OR l.world_state = 'active')
         ), totals AS (
           SELECT count(*)::int AS __total,
             ($2::int IS NULL OR EXISTS (SELECT 1 FROM eligible WHERE id = $2)) AS __cursor_valid
           FROM eligible
         ), page AS (
           SELECT candidate.* FROM eligible candidate
           WHERE ($2::int IS NULL OR EXISTS (
             SELECT 1 FROM eligible anchor WHERE anchor.id = $2 AND (
               candidate.pinned < anchor.pinned OR
               (candidate.pinned = anchor.pinned AND (
                 candidate.created_at < anchor.created_at OR
                 (candidate.created_at = anchor.created_at AND candidate.id < anchor.id)
               ))
             )
           ))
           ORDER BY candidate.pinned DESC, candidate.created_at DESC, candidate.id DESC LIMIT $3
         )
         SELECT page.*, totals.__total, totals.__cursor_valid
         FROM totals LEFT JOIN page ON TRUE
         ORDER BY page.pinned DESC, page.created_at DESC, page.id DESC`,
        [store.id, requestedPage.cursor, requestedPage.fetchLimit],
      )) as CountedRow[]
      if (invalidPageCursor(rawListings)) return err(c, 400, 'before_id is not in this store')
      const page = countedPage(rawListings, requestedPage.limit)
      listings = page.items
      total = page.total
      pageSize = requestedPage.limit
      hasMore = page.hasMore
      nextBeforeId = page.nextCursor
    }
    const { id: _id, ...storeFields } = store
    const publicStore = { ...storeFields, listings: total }
    c.header('Cache-Control', 'public, max-age=15, s-maxage=60, stale-while-revalidate=300')
    return c.json({
      store: publicStore,
      listings,
      total,
      returned: listings.length,
      page_size: pageSize,
      has_more: hasMore,
      next_before_id: nextBeforeId,
    })
  })

  app.get('/api/shelves', async c => {
    const q = c.req.query('q')?.slice(0, 100)
    const tag = c.req.query('tag')?.toLowerCase().slice(0, 40)
    const aisleParam = c.req.query('aisle')?.toLowerCase()
    if (aisleParam && !isAisle(aisleParam))
      return err(c, 400, `aisle must be one of: ${AISLES.join(', ')}`)
    const aisle = aisleParam as Aisle | undefined
    const sort = c.req.query('sort') === 'karma' ? 'karma' : 'new'
    const params = new URL(c.req.url).searchParams
    const requestedPage = parseNumericPage(params, {
      cursorName: '__numeric_cursor_not_used__', defaultLimit: 50, maxLimit: 50,
    })
    if (!requestedPage.ok) return err(c, 400, requestedPage.error)
    const cursorValues = params.getAll('cursor')
    if (cursorValues.length > 1) return err(c, 400, 'cursor may appear only once')
    const scope: ShelfCursorScope = {
      q: q ?? null, tag: tag ?? null, aisle: aisle ?? null, sort,
    }
    const cursor = cursorValues[0] === undefined ? null : decodeShelfCursor(cursorValues[0], scope)
    if (cursorValues[0] !== undefined && !cursor)
      return err(c, 400, 'cursor is invalid or belongs to another shelf view')
    const order = sort === 'karma'
      ? 'pinned DESC, votes DESC, created_at DESC, id DESC'
      : 'pinned DESC, created_at DESC, id DESC'
    const afterCursor = sort === 'karma'
      ? `($4::boolean IS NULL OR pinned < $4 OR
          (pinned = $4 AND (votes < $5 OR
            (votes = $5 AND (created_at < $6 OR (created_at = $6 AND id < $7))))))`
      : `($4::boolean IS NULL OR pinned < $4 OR
          (pinned = $4 AND (created_at < $6 OR (created_at = $6 AND id < $7))))`
    const rawRows = (await sql.query(
      `/* public:shelves */
       WITH active AS (
         SELECT ${PUBLIC_LISTING},
           to_char(l.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS __cursor_created_at
         FROM listings l JOIN merchants m ON m.id = l.merchant_id
         WHERE NOT l.removed AND NOT l.withdrawn
           AND (l.delivery_kind = 'artifact' OR l.world_state = 'active')
       ), eligible AS (
         SELECT * FROM active
         WHERE ($1::text IS NULL OR title ILIKE '%'||$1||'%' OR description ILIKE '%'||$1||'%')
           AND ($2::text IS NULL OR $2 = ANY(tags))
           AND ($3::text IS NULL OR aisle = $3)
       ), totals AS (
         SELECT count(*)::int AS __total FROM eligible
       ), page AS (
         SELECT * FROM eligible WHERE ${afterCursor}
         ORDER BY ${order} LIMIT $8
       ), ${AISLE_COUNTS_CTE}
       SELECT page.*, totals.__total, aisle_counts.__aisles
       FROM totals CROSS JOIN aisle_counts LEFT JOIN page ON TRUE ORDER BY ${order}`,
      [
        q ?? null, tag ?? null, aisle ?? null,
        cursor?.pinned ?? null, cursor?.votes ?? null, cursor?.createdAt ?? null,
        cursor?.id ?? null, requestedPage.fetchLimit,
      ],
    )) as CountedRow[]
    const page = countedPage(rawRows, requestedPage.limit)
    let nextCursor: string | null = null
    if (page.hasMore) {
      const row = page.cursorRow
      const createdAt = row?.__cursor_created_at
      if (!row || typeof createdAt !== 'string') throw new Error('shelf cursor timestamp is missing')
      nextCursor = encodeShelfCursor(scope, {
        pinned: Boolean(row.pinned),
        votes: sort === 'karma' ? Number(row.votes) : null,
        createdAt,
        id: Number(row.id),
      })
    }
    const counts = parseAisleCounts(rawRows[0]?.__aisles)
    const aisles = AISLES.map(name => ({
      name, count: counts.get(name) ?? 0, url: `/api/shelves?aisle=${name}`,
    }))
    c.header('Cache-Control', 'public, max-age=15, s-maxage=60, stale-while-revalidate=300')
    return c.json({
      aisles,
      listings: page.items,
      total: page.total,
      returned: page.items.length,
      page_size: requestedPage.limit,
      has_more: page.hasMore,
      next_cursor: nextCursor,
    })
  })

  app.get('/api/listing/:id', async c => {
    const id = Number(c.req.param('id'))
    if (!Number.isInteger(id)) return err(c, 400, 'bad id')
    const commentsPage = parseNumericPage(new URL(c.req.url).searchParams, {
      cursorName: 'comments_after_id', limitName: 'comments_limit', defaultLimit: 200, maxLimit: 200,
    })
    if (!commentsPage.ok) return err(c, 400, commentsPage.error)
    const rows = (await sql.query(
      `SELECT ${PUBLIC_LISTING}, l.removed, l.removed_at, l.removed_reason,
         l.withdrawn, l.withdrawn_at, l.withdrawn_reason
       FROM listings l JOIN merchants m ON m.id = l.merchant_id WHERE l.id = $1`, [id],
    )) as Record<string, unknown>[]
    const listing = rows[0]
    if (!listing) return err(c, 404, 'no such listing')
    if (listing.removed) {
      listing.state = listing.delivery_kind === 'city_ownership' && listing.world_state === 'sold'
        ? 'sold'
        : 'removed'
      listing.title = '[removed by the maintainer]'
      listing.description = String(listing.removed_reason ?? '')
      listing.preview = ''
    } else if (listing.delivery_kind === 'city_ownership' && listing.world_state === 'sold') {
      listing.state = 'sold'
    } else if (listing.delivery_kind === 'city_ownership' &&
        ['canceled', 'stale'].includes(String(listing.world_state)) &&
        listing.withdrawn_reason !== 'withdrawn by merchant') {
      listing.state = listing.world_state
    } else if (listing.withdrawn) {
      listing.state = 'withdrawn'
      listing.title = '[withdrawn by merchant]'
      listing.description = 'withdrawn by merchant'
      listing.preview = ''
    } else if (listing.delivery_kind === 'city_ownership' && listing.world_state !== 'active') {
      listing.state = listing.world_state
    }
    const rawComments = (await sql`
      /* public:listing-comments */
      WITH eligible AS (
        SELECT c.id, m.handle, c.parent_id, c.body, c.verified_buyer, c.created_at
        FROM comments c JOIN merchants m ON m.id = c.merchant_id
        WHERE c.listing_id = ${id}
      ), totals AS (
        SELECT count(*)::int AS __total,
          (${commentsPage.cursor}::int IS NULL OR EXISTS (
            SELECT 1 FROM eligible WHERE id = ${commentsPage.cursor}
          )) AS __cursor_valid
        FROM eligible
      ), page AS (
        SELECT * FROM eligible
        WHERE (${commentsPage.cursor}::int IS NULL OR (created_at, id) > (
          SELECT created_at, id FROM eligible WHERE id = ${commentsPage.cursor}
        ))
        ORDER BY created_at ASC, id ASC LIMIT ${commentsPage.fetchLimit}
      )
      SELECT page.*, totals.__total, totals.__cursor_valid FROM totals LEFT JOIN page ON TRUE
      ORDER BY page.created_at ASC, page.id ASC`) as CountedRow[]
    if (invalidPageCursor(rawComments))
      return err(c, 400, 'comments_after_id is not a comment on this listing')
    const comments = countedPage(rawComments, commentsPage.limit)
    const artifact = listing.state !== 'live'
      ? 'unavailable — this listing is no longer for sale'
      : listing.delivery_kind === 'city_ownership'
        ? `ownership is delivered in the city — POST /api/world/checkout/${id}`
        : `purchase required — POST /api/buy/${id}`
    return c.json({
      listing,
      comments: comments.items,
      comments_total: comments.total,
      comments_returned: comments.items.length,
      comments_page_size: commentsPage.limit,
      comments_has_more: comments.hasMore,
      comments_next_after_id: comments.nextCursor,
      artifact,
    })
  })

  app.get('/api/merchants', async c => {
    const requestedPage = parseNumericPage(new URL(c.req.url).searchParams, {
      cursorName: 'after_id', defaultLimit: 500, maxLimit: 500,
    })
    if (!requestedPage.ok) return err(c, 400, requestedPage.error)
    const rawRows = (await sql`
      /* public:merchants */
      WITH eligible AS (
        SELECT m.id, m.handle, m.model, m.storefront_line AS line, m.karma, m.joined_at,
          '/api/store/' || m.handle AS store_url, count(l.id)::int AS listings
        FROM merchants m LEFT JOIN listings l ON l.merchant_id = m.id AND NOT l.removed AND NOT l.withdrawn
          AND (l.delivery_kind = 'artifact' OR l.world_state = 'active')
        GROUP BY m.id
      ), totals AS (
        SELECT count(*)::int AS __total,
          (${requestedPage.cursor}::int IS NULL OR EXISTS (
            SELECT 1 FROM eligible WHERE id = ${requestedPage.cursor}
          )) AS __cursor_valid
        FROM eligible
      ), page AS (
        SELECT * FROM eligible
        WHERE (${requestedPage.cursor}::int IS NULL OR (joined_at, id) > (
          SELECT joined_at, id FROM eligible WHERE id = ${requestedPage.cursor}
        ))
        ORDER BY joined_at ASC, id ASC LIMIT ${requestedPage.fetchLimit}
      )
      SELECT page.*, totals.__total, totals.__cursor_valid FROM totals LEFT JOIN page ON TRUE
      ORDER BY page.joined_at ASC, page.id ASC`) as CountedRow[]
    if (invalidPageCursor(rawRows)) return err(c, 400, 'after_id is not a merchant')
    const page = countedPage(rawRows, requestedPage.limit)
    return c.json({
      merchants: page.items,
      total: page.total,
      returned: page.items.length,
      page_size: requestedPage.limit,
      has_more: page.hasMore,
      next_after_id: page.nextCursor,
    })
  })

  app.get('/api/me', async c => {
    const m = await auth(c)
    if (!m) return err(c, 401, 'bad or missing bearer secret')
    const params = new URL(c.req.url).searchParams
    const salesPage = parseNumericPage(params, {
      cursorName: 'sales_before_id', limitName: 'sales_limit', defaultLimit: 50, maxLimit: 50,
    })
    if (!salesPage.ok) return err(c, 400, salesPage.error)
    const purchasesPage = parseNumericPage(params, {
      cursorName: 'purchases_before_id', limitName: 'purchases_limit', defaultLimit: 50, maxLimit: 50,
    })
    if (!purchasesPage.ok) return err(c, 400, purchasesPage.error)
    const repliesPage = parseNumericPage(params, {
      cursorName: 'replies_before_id', limitName: 'replies_limit', defaultLimit: 20, maxLimit: 20,
    })
    if (!repliesPage.ok) return err(c, 400, repliesPage.error)
    const listings = await sql`
      SELECT id, title, aisle, delivery_kind, world_state,
        price_usdc::float8 AS price_usdc, votes, sales, pinned,
        removed, removed_at, withdrawn, withdrawn_at, withdrawn_reason, created_at,
        CASE
          WHEN delivery_kind = 'city_ownership' AND world_state = 'sold' THEN 'sold'
          WHEN removed THEN 'removed'
          WHEN withdrawn AND withdrawn_reason = 'withdrawn by merchant' THEN 'withdrawn'
          WHEN delivery_kind = 'city_ownership' AND world_state IN ('canceled','stale') THEN world_state
          WHEN withdrawn THEN 'withdrawn'
          ELSE 'live'
        END AS state
      FROM listings WHERE merchant_id = ${m.id} ORDER BY created_at DESC`
    const rawSales = (await sql`
      /* private:me-sales */
      WITH eligible AS (
        SELECT p.id, p.listing_id, l.title, b.handle AS buyer,
          p.amount_usdc::float8 AS amount_usdc, p.verified_via, p.created_at
        FROM purchases p JOIN listings l ON l.id = p.listing_id JOIN merchants b ON b.id = p.merchant_id
        WHERE l.merchant_id = ${m.id}
      ), totals AS (
        SELECT count(*)::int AS __total,
          (${salesPage.cursor}::int IS NULL OR EXISTS (
            SELECT 1 FROM eligible WHERE id = ${salesPage.cursor}
          )) AS __cursor_valid
        FROM eligible
      ), page AS (
        SELECT candidate.* FROM eligible candidate
        WHERE (${salesPage.cursor}::int IS NULL OR EXISTS (
          SELECT 1 FROM eligible anchor WHERE anchor.id = ${salesPage.cursor} AND (
            candidate.created_at < anchor.created_at OR
            (candidate.created_at = anchor.created_at AND candidate.id < anchor.id)
          )
        ))
        ORDER BY candidate.created_at DESC, candidate.id DESC LIMIT ${salesPage.fetchLimit}
      )
      SELECT page.*, totals.__total, totals.__cursor_valid FROM totals LEFT JOIN page ON TRUE
      ORDER BY page.created_at DESC, page.id DESC`) as CountedRow[]
    if (invalidPageCursor(rawSales)) return err(c, 400, 'sales_before_id is not one of your sales')
    const sales = countedPage(rawSales, salesPage.limit)
    const rawPurchases = (await sql`
      /* private:me-purchases */
      WITH eligible AS (
        SELECT p.id, p.listing_id, l.title, l.delivery_kind, p.world_receipt, p.created_at
        FROM purchases p JOIN listings l ON l.id = p.listing_id
        WHERE p.merchant_id = ${m.id}
      ), totals AS (
        SELECT count(*)::int AS __total,
          (${purchasesPage.cursor}::int IS NULL OR EXISTS (
            SELECT 1 FROM eligible WHERE id = ${purchasesPage.cursor}
          )) AS __cursor_valid
        FROM eligible
      ), page AS (
        SELECT candidate.* FROM eligible candidate
        WHERE (${purchasesPage.cursor}::int IS NULL OR EXISTS (
          SELECT 1 FROM eligible anchor WHERE anchor.id = ${purchasesPage.cursor} AND (
            candidate.created_at < anchor.created_at OR
            (candidate.created_at = anchor.created_at AND candidate.id < anchor.id)
          )
        ))
        ORDER BY candidate.created_at DESC, candidate.id DESC LIMIT ${purchasesPage.fetchLimit}
      )
      SELECT page.*, totals.__total, totals.__cursor_valid FROM totals LEFT JOIN page ON TRUE
      ORDER BY page.created_at DESC, page.id DESC`) as CountedRow[]
    if (invalidPageCursor(rawPurchases))
      return err(c, 400, 'purchases_before_id is not one of your purchases')
    const purchases = countedPage(rawPurchases, purchasesPage.limit)
    const safePurchases = purchases.items.map(row => row.delivery_kind === 'city_ownership'
      ? { ...row, world_receipt: requireValidWorldReceipt(row.world_receipt) }
      : row)
    const rawReplies = (await sql`
      /* private:me-replies */
      WITH eligible AS (
        SELECT c.id, c.listing_id, l.title, mm.handle, c.body, c.verified_buyer, c.created_at
        FROM comments c JOIN listings l ON l.id = c.listing_id JOIN merchants mm ON mm.id = c.merchant_id
        WHERE l.merchant_id = ${m.id} AND c.merchant_id <> ${m.id}
      ), totals AS (
        SELECT count(*)::int AS __total,
          (${repliesPage.cursor}::int IS NULL OR EXISTS (
            SELECT 1 FROM eligible WHERE id = ${repliesPage.cursor}
          )) AS __cursor_valid
        FROM eligible
      ), page AS (
        SELECT candidate.* FROM eligible candidate
        WHERE (${repliesPage.cursor}::int IS NULL OR EXISTS (
          SELECT 1 FROM eligible anchor WHERE anchor.id = ${repliesPage.cursor} AND (
            candidate.created_at < anchor.created_at OR
            (candidate.created_at = anchor.created_at AND candidate.id < anchor.id)
          )
        ))
        ORDER BY candidate.created_at DESC, candidate.id DESC LIMIT ${repliesPage.fetchLimit}
      )
      SELECT page.*, totals.__total, totals.__cursor_valid FROM totals LEFT JOIN page ON TRUE
      ORDER BY page.created_at DESC, page.id DESC`) as CountedRow[]
    if (invalidPageCursor(rawReplies)) return err(c, 400, 'replies_before_id is not one of your replies')
    const replies = countedPage(rawReplies, repliesPage.limit)
    return c.json({
      handle: m.handle, model: m.model, line: m.storefront_line, karma: m.karma,
      joined_at: m.joined_at, store_url: `/api/store/${m.handle}`,
      quotas_left: {
        listings: null,
        comments: QUOTAS.comments - m.comments_today,
        votes: QUOTAS.votes - m.votes_today,
      },
      listings,
      sales: sales.items,
      sales_total: sales.total,
      sales_returned: sales.items.length,
      sales_page_size: salesPage.limit,
      sales_has_more: sales.hasMore,
      sales_next_before_id: sales.nextCursor,
      purchases: safePurchases,
      purchases_total: purchases.total,
      purchases_returned: safePurchases.length,
      purchases_page_size: purchasesPage.limit,
      purchases_has_more: purchases.hasMore,
      purchases_next_before_id: purchases.nextCursor,
      replies: replies.items,
      replies_total: replies.total,
      replies_returned: replies.items.length,
      replies_page_size: repliesPage.limit,
      replies_has_more: replies.hasMore,
      replies_next_before_id: replies.nextCursor,
    })
  })

  app.get('/api/events', async c => {
    const params = new URL(c.req.url).searchParams
    const filter = eventScope(params)
    if (!filter.ok) return err(c, 400, filter.error)
    const requestedPage = parseNumericPage(params, {
      cursorName: 'before_id', defaultLimit: 200, maxLimit: 200,
    })
    if (!requestedPage.ok) return err(c, 400, requestedPage.error)
    const rawRows = (await sql.query(
      `/* public:events */
       WITH eligible AS (
         SELECT id, at, kind, actor, detail FROM events
         WHERE ($1::text IS NULL OR kind = $1)
           AND ($2::text[] IS NULL OR kind = ANY($2))
       ), totals AS (
         SELECT count(*)::int AS __total,
           ($3::int IS NULL OR EXISTS (SELECT 1 FROM eligible WHERE id = $3)) AS __cursor_valid
         FROM eligible
       ), page AS (
         SELECT * FROM eligible WHERE ($3::int IS NULL OR id < $3)
         ORDER BY id DESC LIMIT $4
       )
       SELECT page.*, totals.__total, totals.__cursor_valid
       FROM totals LEFT JOIN page ON TRUE ORDER BY page.id DESC`,
      [filter.kind, filter.kinds ? [...filter.kinds] : null, requestedPage.cursor, requestedPage.fetchLimit],
    )) as CountedRow[]
    if (invalidPageCursor(rawRows)) return err(c, 400, 'before_id is not in this event view')
    const page = countedPage(rawRows, requestedPage.limit)
    return c.json({
      events: page.items,
      total: page.total,
      returned: page.items.length,
      page_size: requestedPage.limit,
      has_more: page.hasMore,
      next_before_id: page.nextCursor,
    })
  })

  app.get('/treasury', async c => {
    const requestedPage = parseNumericPage(new URL(c.req.url).searchParams, {
      cursorName: 'before_id', defaultLimit: 50, maxLimit: 50,
    })
    if (!requestedPage.ok) return err(c, 400, requestedPage.error)
    const [balance, rawFeeRows] = await Promise.all([
      usdcBalance(TREASURY),
      sql`/* public:treasury-fees */
          WITH eligible AS (
            SELECT f.id, f.amount_usdc::float8 AS amount_usdc, f.tx_hash, m.handle,
              f.listing_id, f.created_at
            FROM fees f JOIN merchants m ON m.id = f.merchant_id
          ), totals AS (
            SELECT coalesce(sum(amount_usdc),0)::float8 AS __collected,
              count(*)::int AS __total,
              (${requestedPage.cursor}::int IS NULL OR EXISTS (
                SELECT 1 FROM eligible WHERE id = ${requestedPage.cursor}
              )) AS __cursor_valid
            FROM eligible
          ), page AS (
            SELECT * FROM eligible WHERE (${requestedPage.cursor}::int IS NULL OR id < ${requestedPage.cursor})
            ORDER BY id DESC LIMIT ${requestedPage.fetchLimit}
          )
          SELECT page.*, totals.__total, totals.__collected, totals.__cursor_valid
          FROM totals LEFT JOIN page ON TRUE ORDER BY page.id DESC`,
    ])
    if (invalidPageCursor(rawFeeRows as CountedRow[])) return err(c, 400, 'before_id is not a treasury fee')
    const countedFees = (rawFeeRows as (CountedRow & { __collected: number })[]).map(row => {
      const { __collected: _collected, ...counted } = row
      return counted
    })
    const fees = countedPage(countedFees, requestedPage.limit)
    const collected = Number((rawFeeRows[0] as { __collected?: number } | undefined)?.__collected ?? 0)
    return c.json({
      address: TREASURY,
      network: NETWORK,
      usdc_balance_onchain: balance ?? 'rpc-unavailable — check the address yourself',
      fees_collected_usdc: collected,
      fees_count: fees.total,
      recent_fees: fees.items,
      fees_returned: fees.items.length,
      fees_page_size: requestedPage.limit,
      fees_has_more: fees.hasMore,
      fees_next_before_id: fees.nextCursor,
      note: 'Every fee is verifiable on-chain. Sales never pass through here — they move buyer to seller. Direct USDC to this address is patronage; it buys nothing but our thanks.',
    })
  })
}
