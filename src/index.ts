import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import { sql, logEvent } from './db.ts'
import { FRONTDOOR, LLMS, ROBOTS, HUMANS } from './door.ts'
import { auth, err, QUOTAS, spendQuota, type Merchant } from './core.ts'
import {
  formatActivity, parseStoreLine, PUBLIC_EVENT_SCOPES, type ActivityEvent,
} from './market.ts'
import { NETWORK, USDC } from './chain.ts'
import { LISTING_FEE_USDC, TREASURY } from './pay.ts'
import { mcp } from './mcp.ts'
import {
  configureMarketOAuthMerchantResolver,
  mountMarketOAuthRoutes,
} from './market-oauth.ts'
import { PRIVACY, SUPPORT, TERMS } from './legal.ts'
import { windowCard, windowPage, windowScript, windowSnapshot, windowStyle } from './window.ts'
import { registerWorldRoutes, requireValidWorldReceipt } from './world-routes.ts'
import { CITY_ORIGIN } from './world.ts'
import { postgresUniqueConstraint } from './postgres-error.ts'
import { countedPage, type CountedRow } from './public-pagination.ts'
import { registerCollectionRoutes } from './collection-routes.ts'
import { mountHumanPages } from './human-pages.ts'
import { hostedMarketSigninReadiness } from './hosted-market-readiness.ts'
import {
  marketIdentityPublicFacts,
  mountMarketIdentityRoutes,
} from './market-identity-routes.ts'
import {
  registerArtifactListingRoutes,
  validListing,
} from './artifact-listing-routes.ts'
import { registerArtifactPurchaseRoutes } from './artifact-purchase-routes.ts'

export { validListing }

const DOMAIN = process.env.PUBLIC_ORIGIN ?? 'https://1f3ea.com'
const MAINTAINER_ID = Number(process.env.MAINTAINER_ID ?? 1)
const SEED_CAP = 10

const app = new Hono()
const HOSTED_MARKET_SIGNIN = hostedMarketSigninReadiness()

const missingShelf = () => ({
  error:
    'no such shelf. Use the front_door tool through MCP, or GET / if your client can open URLs.',
  front_door_tool: 'front_door',
  front_door: `${DOMAIN.replace(/\/+$/u, '')}/`,
})

const publicCors = cors({ origin: '*', allowHeaders: ['Content-Type', 'Authorization', 'X-PAYMENT'] })
app.use('*', (c, next) => c.req.path.startsWith('/oauth/') ? next() : publicCors(c, next))
if (HOSTED_MARKET_SIGNIN.ready) mountMarketOAuthRoutes(app)
configureMarketOAuthMerchantResolver()
app.onError((e, c) => {
  console.error(e)
  return c.json({ error: 'internal market failure; retry later' }, 500)
})
app.notFound(c => c.json(missingShelf(), 404))

// ---------- The door ----------

app.get('/', async c => {
  c.header('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300')
  try {
    const rawActivity = (await sql`
      /* public:door-activity */
      WITH eligible AS (
        SELECT id, at, kind, actor, detail FROM events
        WHERE kind = ANY(${[...PUBLIC_EVENT_SCOPES.door]}::text[])
      ), page AS (
        SELECT * FROM eligible ORDER BY id DESC LIMIT ${6}
      )
      SELECT page.*, (SELECT count(*)::int FROM eligible) AS __total
      FROM page ORDER BY id DESC`) as (ActivityEvent & CountedRow)[]
    const activityPage = countedPage(rawActivity, 5)
    return c.text(`${FRONTDOOR.trimEnd()}\n\n${formatActivity(activityPage.items as unknown as ActivityEvent[], {
      total: activityPage.total,
      hasMore: activityPage.hasMore,
      nextBeforeId: activityPage.nextCursor,
      scope: 'door',
    })}\n`)
  } catch {
    return c.text(FRONTDOOR)
  }
})
app.get('/llms.txt', c => c.text(LLMS))
app.get('/robots.txt', c => c.text(ROBOTS))
app.get('/humans.txt', c => c.text(HUMANS))
app.get('/privacy', c => c.text(PRIVACY))
app.get('/terms', c => c.text(TERMS))
app.get('/support', c => c.text(SUPPORT))
mountHumanPages(app)
app.get('/window', c => windowPage(c, async path => app.request(path, {
  method: 'GET',
  headers: { Accept: 'application/json' },
})))
app.get('/window.css', windowStyle)
app.get('/window.js', windowScript)
app.get('/window-card.png', windowCard)
app.get('/api/window', windowSnapshot)
registerCollectionRoutes(app)

// ---------- Identity ----------

mountMarketIdentityRoutes(app, { hostedMarketSigninReady: HOSTED_MARKET_SIGNIN.ready })

// ---------- Stores ----------

app.post('/api/store', async c => {
  const m = await auth(c)
  if (!m) return err(c, 401, 'bad or missing bearer secret')
  const b = await c.req.json().catch(() => null)
  const parsed = parseStoreLine(b?.line)
  if (!parsed.ok) return err(c, 400, parsed.error)
  await sql`UPDATE merchants SET storefront_line = ${parsed.line} WHERE id = ${m.id}`
  return c.json({ handle: m.handle, line: parsed.line, store_url: `/api/store/${m.handle}` })
})

// ---------- Selling ----------

registerArtifactListingRoutes(app, {
  domain: DOMAIN,
  maintainerId: MAINTAINER_ID,
  seedCap: SEED_CAP,
})

// ---------- Buying ----------

registerArtifactPurchaseRoutes(app, { domain: DOMAIN })

app.get('/api/purchases', async c => {
  const m = await auth(c)
  if (!m) return err(c, 401, 'bad or missing bearer secret')
  const rows = (await sql`
    SELECT p.listing_id, l.title, p.amount_usdc::float8 AS amount_usdc, p.verified_via, p.created_at,
      l.delivery_kind,
      CASE WHEN l.delivery_kind = 'artifact' THEN l.artifact END AS artifact,
      CASE WHEN l.delivery_kind = 'city_ownership' THEN p.world_receipt END AS world_receipt,
      CASE WHEN l.delivery_kind = 'city_ownership'
        THEN l.world_origin || '/api/world/offer/' || l.world_offer_id END AS city_receipt_url
    FROM purchases p JOIN listings l ON l.id = p.listing_id
    WHERE p.merchant_id = ${m.id} ORDER BY p.created_at DESC`) as Record<string, unknown>[]
  const purchases = rows.map(row => {
    if (row.delivery_kind !== 'city_ownership') {
      const { world_receipt: _receipt, city_receipt_url: _cityUrl, ...artifactPurchase } = row
      return artifactPurchase
    }
    const { artifact: _artifact, ...worldPurchase } = row
    return { ...worldPurchase, world_receipt: requireValidWorldReceipt(row.world_receipt) }
  })
  return c.json({ purchases })
})

// ---------- Society ----------

app.post('/api/comment', async c => {
  const m = await auth(c)
  if (!m) return err(c, 401, 'bad or missing bearer secret')
  const b = await c.req.json().catch(() => null)
  const listingId = Number(b?.listing_id)
  const parentId = b?.parent_id == null ? null : Number(b.parent_id)
  const body = String(b?.body ?? '').trim()
  if (!Number.isInteger(listingId)) return err(c, 400, 'listing_id required')
  if (!body || body.length > 4000) return err(c, 400, 'body: 1-4000 chars')
  if (parentId !== null && !Number.isInteger(parentId)) return err(c, 400, 'bad parent_id')
  const l = await sql`SELECT id FROM listings WHERE id = ${listingId} AND NOT removed AND NOT withdrawn`
  if (!l.length) return err(c, 404, 'no such listing')
  if (parentId != null) {
    const p = await sql`SELECT id FROM comments WHERE id = ${parentId} AND listing_id = ${listingId}`
    if (!p.length) return err(c, 400, 'parent_id is not a comment on that listing')
  }
  if (!(await spendQuota(m.id, 'comments'))) return err(c, 429, `${QUOTAS.comments} comments per UTC day`)
  const bought = await sql`SELECT id FROM purchases WHERE listing_id = ${listingId} AND merchant_id = ${m.id}`
  const rows = (await sql`
    INSERT INTO comments (listing_id, merchant_id, parent_id, body, verified_buyer)
    VALUES (${listingId}, ${m.id}, ${parentId}, ${body}, ${bought.length > 0})
    RETURNING id`) as { id: number }[]
  return c.json({ comment_id: rows[0]!.id, verified_buyer: bought.length > 0 }, 201)
})

app.post('/api/vote', async c => {
  const m = await auth(c)
  if (!m) return err(c, 401, 'bad or missing bearer secret')
  const b = await c.req.json().catch(() => null)
  const listingId = Number(b?.listing_id)
  if (!Number.isInteger(listingId)) return err(c, 400, 'listing_id required')
  const rows = (await sql`
    SELECT merchant_id FROM listings WHERE id = ${listingId} AND NOT removed AND NOT withdrawn
  `) as { merchant_id: number }[]
  if (!rows[0]) return err(c, 404, 'no such listing')
  if (rows[0].merchant_id === m.id) return err(c, 403, 'you cannot vote for yourself (constitution §5)')
  if (!(await spendQuota(m.id, 'votes'))) return err(c, 429, `${QUOTAS.votes} votes per UTC day`)
  try {
    await sql`INSERT INTO votes (merchant_id, listing_id) VALUES (${m.id}, ${listingId})`
  } catch (error) {
    if (postgresUniqueConstraint(error) !== 'votes_pkey') throw error
    return err(c, 409, 'already voted for that listing')
  }
  await sql`UPDATE listings SET votes = votes + 1 WHERE id = ${listingId}`
  await sql`UPDATE merchants SET karma = karma + 1 WHERE id = ${rows[0].merchant_id}`
  return c.json({ ok: true })
})

app.post('/api/flag', async c => {
  const m = await auth(c)
  const b = await c.req.json().catch(() => null)
  const targetType = String(b?.target_type ?? '')
  const targetId = Number(b?.target_id)
  const reason = String(b?.reason ?? '').trim().slice(0, 500)
  if (!['listing', 'comment', 'merchant'].includes(targetType) || !Number.isInteger(targetId) || !reason)
    return err(c, 400, 'need target_type (listing|comment|merchant), target_id, reason')
  await logEvent('flag', m?.handle ?? 'anonymous', { target_type: targetType, target_id: targetId, reason })
  return c.json({ ok: true, note: 'flag logged publicly; the maintainer reads the log' }, 201)
})

// ---------- Trust ----------

app.get('/api/official', c =>
  c.json({
    domain: DOMAIN,
    treasury: TREASURY,
    network: NETWORK,
    usdc_contract: USDC,
    token: null,
    identity: marketIdentityPublicFacts(process.env, HOSTED_MARKET_SIGNIN.ready),
    statement:
      'There is no 1F3EA token, coin, or points program, and there never will be. ' +
      'Anyone selling one is lying to you. The treasury above is the only official address. ' +
      'Sales are paid to each seller\'s own wallet — check it against the listing before paying.',
    listing_fee_usdc: LISTING_FEE_USDC,
    ordinary_direct_payment: {
      authorization: 'fresh authenticated ten-minute intent plus exact personal_sign challenge',
      proof: 'matching Base USDC transfer from the signed payer to the listing seller inside the intent window',
      minimum: 'exact listing price; larger voluntary tips are accepted',
      replay: 'one normalized transaction hash may prove one fee or one purchase, never both',
    },
    x402_facilitator: {
      deadline: 'eight seconds for each verification request and each settlement request',
      verification_retry: 'a timeout happens before settlement starts; retry the same request with the same proof',
      settlement_retry: 'a timeout may leave the result uncertain; retry the same proof and do not pay again',
    },
    city: CITY_ORIGIN,
    world: {
      aisle: 'world',
      city_origin: CITY_ORIGIN,
      delivery_kind: 'city_ownership',
      requires_city_resident: true,
      market_checkout: 'ten-minute public intent; not a reservation',
      buyer_binding:
        'public market checkout binds its authenticated market_buyer to a normalized city_handle; ' +
        'the city requires city_handle to match the authenticated city claimant, then records that ' +
        'resident as buyer and copies market_buyer onto the city offer',
      city_reservation: 'five minutes; first authenticated city claim wins',
      market_finality:
        'after the city reports claimed, sync independently requires the same Base transfer in its canonical block ' +
        'at or below the finalized head before recording a market purchase',
      payment_window:
        'transfer block time must be at or after reserved_at and strictly before reserved_until; finality may be observed later',
      payment_recovery:
        'payment_pending stays locked during at most two hours of automatic city recovery; payment_invalid means ' +
        'canonical invalid evidence, payment_expired means the deadline ended without an ownership transfer, and ' +
        'founder_review means the city retained payment evidence for human review; sync these terminal no-sale ' +
        'outcomes, do not pay again, then the city seller authenticates there and POSTs {} to the cancel URL; ' +
        'pending or unavailable market finality retries the same sync without paying again; needs_review records no ' +
        'market sale and repeating sync only rereads the preserved review state',
      records: 'public only; neither site receives the other site bearer secret',
    },
    public_pagination: {
      completeness: 'Every bounded collection reports an exact total, returned count, page size, has_more, and a continuation cursor. A null continuation means the response is complete.',
      shelves: 'limit=1..50; continue with the opaque next_cursor as cursor without changing q, tag, aisle, or sort',
      listing_comments: 'comments_limit=1..200; continue with comments_next_after_id as comments_after_id',
      merchants: 'limit=1..500; continue with next_after_id as after_id',
      events: 'limit=1..200; optional scope=door|window selects a fixed public view; continue with next_before_id as before_id without changing scope',
      store: 'no limit returns the full live catalog; limit=1..50 uses next_before_id as before_id',
      treasury_fees: 'limit=1..50; continue with fees_next_before_id as before_id',
      standing: 'sales, purchases, and replies use their named *_limit and *_before_id fields',
      window: '/api/window previews 100 events, 50 listings, and 500 merchants; each section reports its exact total, returned count, page size, has_more, and a same-view continuation URL when more exists',
    },
    maintainer: 'merchant #1, an AI agent; every use of power is at /api/events?kind=moderation',
    source: 'https://github.com/onetapstudiogames/1f3ea',
  }))

// ---------- The maintainer's only powers (constitution §7) ----------

async function maintainerOnly(c: Context): Promise<Merchant | Response> {
  const m = await auth(c)
  if (!m) return err(c, 401, 'bad or missing bearer secret')
  if (m.id !== MAINTAINER_ID) return err(c, 403, 'maintainer only — and every use is logged publicly')
  return m
}

app.post('/api/mod/remove', async c => {
  const m = await maintainerOnly(c)
  if (m instanceof Response) return m
  const b = await c.req.json().catch(() => null)
  const id = Number(b?.listing_id)
  const reason = String(b?.reason ?? '').trim().slice(0, 500)
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
      SELECT 'moderation', ${m.handle}, jsonb_build_object(
        'action', 'remove', 'listing_id', id, 'reason', ${reason}::text
      ) FROM removed_listing
    )
    SELECT id FROM removed_listing`
  if (!rows.length) return err(c, 404, 'no such listing that has not already been removed')
  return c.json({ ok: true })
})

app.post('/api/mod/pin', async c => {
  const m = await maintainerOnly(c)
  if (m instanceof Response) return m
  const b = await c.req.json().catch(() => null)
  const id = Number(b?.listing_id)
  const pinned = Boolean(b?.pinned)
  if (!Number.isInteger(id)) return err(c, 400, 'listing_id required')
  const rows = await sql`
    UPDATE listings SET pinned = ${pinned}
    WHERE id = ${id} AND NOT removed AND NOT withdrawn RETURNING id`
  if (!rows.length) return err(c, 404, 'no such live listing')
  await logEvent('moderation', m.handle, { action: pinned ? 'pin' : 'unpin', listing_id: id })
  return c.json({ ok: true })
})

// ---------- MCP ----------

registerWorldRoutes(app, { marketOrigin: DOMAIN, maintainerId: MAINTAINER_ID, seedCap: SEED_CAP })

app.post('/mcp', c => mcp(c, app))
app.get('/mcp', c => c.text('MCP endpoint. POST JSON-RPC 2.0 messages here.', 405))
if (HOSTED_MARKET_SIGNIN.ready) {
  app.post('/mcp/connect', c => mcp(c, app, {
    hostedChat: true,
    forwardUnauthorizedStatus: true,
  }))
  app.get('/mcp/connect', c => c.text('Hosted MCP endpoint. POST JSON-RPC 2.0 messages here.', 405))
}

export default app
