import { randomBytes } from 'node:crypto'
import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import { sql, logEvent } from './db.ts'
import { FRONTDOOR, LLMS, ROBOTS, HUMANS } from './door.ts'
import {
  auth, dupHash, err, QUOTAS, spendQuota, WALLET_RE,
  type Merchant,
} from './core.ts'
import {
  AISLES, EDITABLE_LISTING_FIELDS, formatActivity, isAisle, parseStoreLine,
  PUBLIC_EVENT_SCOPES, suggestAisle,
  type ActivityEvent, type Aisle,
} from './market.ts'
import { NETWORK, USDC, verifyPersonalSignatureProof } from './chain.ts'
import {
  canonicalTxHash, challenge402, LISTING_FEE_USDC, paymentReadinessResponse,
  paymentResponseHeader, requirements, settleX402, TREASURY, verifyDirectPayment,
} from './pay.ts'
import { mcp } from './mcp.ts'
import {
  configureMarketOAuthMerchantResolver,
  mountMarketOAuthRoutes,
} from './market-oauth.ts'
import { PRIVACY, SUPPORT, TERMS } from './legal.ts'
import { windowCard, windowPage, windowScript, windowSnapshot, windowStyle } from './window.ts'
import { registerWorldRoutes, requireValidWorldReceipt } from './world-routes.ts'
import { CITY_ORIGIN, cityCancelUrl } from './world.ts'
import {
  DIRECT_PURCHASE_INTENT_TTL_MS, directPaymentWindowError, purchaseIntentChallenge,
  type DirectPurchaseIntent,
} from './direct-payments.ts'
import { postgresUniqueConstraint } from './postgres-error.ts'
import { countedPage, type CountedRow } from './public-pagination.ts'
import { registerCollectionRoutes } from './collection-routes.ts'
import { mountHumanPages } from './human-pages.ts'
import { hostedMarketSigninReadiness } from './hosted-market-readiness.ts'
import {
  marketIdentityPublicFacts,
  mountMarketIdentityRoutes,
} from './market-identity-routes.ts'

const DOMAIN = process.env.PUBLIC_ORIGIN ?? 'https://1f3ea.com'
const MAINTAINER_ID = Number(process.env.MAINTAINER_ID ?? 1)
const SEED_CAP = 10
const DUPE_WINDOW_DAYS = 7
const FEE_TX_CONSTRAINTS: readonly string[] = [
  'fees_tx_hash_key',
  'fees_tx_hash_lower_unique',
  'payment_uses_pkey',
]
const PURCHASE_TX_CONSTRAINTS: readonly string[] = [
  'purchases_tx_hash_key',
  'purchases_tx_hash_lower_unique',
  'payment_uses_pkey',
]
const OPEN_INTENT_CONSTRAINTS: readonly string[] = [
  'direct_purchase_intents_open_unique',
  'direct_purchase_intents_buyer_listing_unique',
]

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

interface ListingBody {
  title: string; description: string; preview: string; artifact: string
  price_usdc: number; seller_wallet: string; tags: string[]; aisle: Aisle; fee_tx_hash?: string
}

export function validListing(b: unknown): ListingBody | string {
  const o = b as Record<string, unknown> | null
  if (!o || typeof o !== 'object') return 'body must be JSON'
  const title = String(o.title ?? '').trim()
  const description = String(o.description ?? '').trim()
  const preview = String(o.preview ?? '').trim()
  const artifact = String(o.artifact ?? '')
  const price = Number(o.price_usdc ?? NaN)
  const wallet = String(o.seller_wallet ?? '')
  const tags = Array.isArray(o.tags) ? [...new Set(o.tags.map(String).map(t => t.toLowerCase().trim().slice(0, 40)).filter(Boolean))].slice(0, 8) : []
  const rawAisle = typeof o.aisle === 'string' ? o.aisle.toLowerCase().trim() : ''
  const feeTxHash = o.fee_tx_hash == null ? undefined : canonicalTxHash(o.fee_tx_hash)
  if (title.length < 3 || title.length > 120) return 'title: 3-120 chars'
  if (!description || description.length > 4000) return 'description: 1-4000 chars'
  if (preview.length > 4000) return 'preview: max 4000 chars'
  if (!artifact || Buffer.byteLength(artifact, 'utf8') > 262144) return 'artifact: 1 byte - 256 KB of text'
  if (!Number.isFinite(price) || price < 0 || price > 10000) return 'price_usdc: 0 to 10000'
  if (!WALLET_RE.test(wallet)) return 'seller_wallet: 0x + 40 hex chars (an address on Base)'
  if (rawAisle === 'world') return 'world listings start at POST /api/world/draft; artifact listings cannot use the world aisle'
  if (o.aisle != null && (typeof o.aisle !== 'string' || !isAisle(rawAisle)))
    return `aisle must be one of: ${AISLES.join(', ')}`
  if (o.fee_tx_hash != null && !feeTxHash) return 'fee_tx_hash: 0x + 64 hex chars'
  return {
    title, description, preview, artifact,
    price_usdc: Math.round(price * 1e6) / 1e6, seller_wallet: wallet, tags,
    aisle: rawAisle ? rawAisle as Aisle : suggestAisle(tags),
    fee_tx_hash: feeTxHash ?? undefined,
  }
}

interface EditableListingRow {
  id: number
  merchant_id: number
  title: string
  description: string
  preview: string
  artifact: string
  price_usdc: number
  seller_wallet: string
  tags: string[]
  aisle: Aisle
  delivery_kind: 'artifact' | 'city_ownership'
  votes: number
  sales: number
  pinned: boolean
  removed: boolean
  removed_at: string | null
  withdrawn: boolean
  withdrawn_at: string | null
  created_at: string
  has_purchases?: boolean
}

function listingSummary(id: number, handle: string, listing: ListingBody, row: EditableListingRow) {
  return {
    id,
    merchant: handle,
    title: listing.title,
    description: listing.description,
    preview: listing.preview,
    store_url: `/api/store/${handle}`,
    price_usdc: listing.price_usdc,
    seller_wallet: listing.seller_wallet,
    tags: listing.tags,
    aisle: listing.aisle,
    delivery_kind: 'artifact' as const,
    world_origin: null,
    world_offer_id: null,
    world_asset_id: null,
    world_seller_handle: null,
    world_draft_id: null,
    world_state: null,
    requires_city_resident: false,
    votes: Number(row.votes),
    sales: Number(row.sales),
    pinned: Boolean(row.pinned),
    created_at: row.created_at,
    state: 'live',
  }
}

app.post('/api/listing', async c => {
  const m = await auth(c)
  if (!m) return err(c, 401, 'bad or missing bearer secret')
  const v = validListing(await c.req.json().catch(() => null))
  if (typeof v === 'string') return err(c, 400, v)

  const hash = dupHash(v.title, v.artifact)
  const dup = (await sql`
    SELECT id FROM listings WHERE dup_hash = ${hash} AND NOT removed
      AND created_at > now() - make_interval(days => ${DUPE_WINDOW_DAYS})`) as { id: number }[]
  if (dup.length) return err(c, 409, `a near-identical listing exists: ${dup[0]!.id}. Make something new.`)

  // The maintainer may stock the opening shelves fee-free — capped, public (constitution §7).
  const isSeed = m.id === MAINTAINER_ID &&
    Number(((await sql`SELECT count(*)::int AS n FROM listings WHERE merchant_id = ${m.id}`) as { n: number }[])[0]!.n) < SEED_CAP

  let feeTx: string | null = null
  let responseHeader: string | null = null
  if (!isSeed) {
    const unavailable = paymentReadinessResponse(c)
    if (unavailable) return unavailable
    const reqs = requirements(TREASURY, LISTING_FEE_USDC, `${DOMAIN}/api/listing`, '1F3EA listing fee')
    const header = c.req.header('x-payment')
    if (!header && !v.fee_tx_hash)
      return challenge402(c, reqs, 'listing costs $1 USDC — pay via x402 (X-PAYMENT header) or include fee_tx_hash')

    if (header) {
      const settled = await settleX402(header, reqs)
      if (settled.status !== 'verified') {
        return settled.status === 'invalid'
          ? challenge402(c, reqs, settled.reason)
          : err(c, settled.status === 'unclassified' ? 502 : 503, settled.reason)
      }
      feeTx = settled.transaction
      responseHeader = paymentResponseHeader(settled)
    } else {
      // The treasury address is public and takes donations, so a fallback fee only counts
      // if it came from this merchant's own seller_wallet, recently.
      const direct = await verifyDirectPayment(v.fee_tx_hash!, TREASURY, LISTING_FEE_USDC, new Date(Date.now() - 3600e3))
      if (direct.status !== 'verified')
        return err(c, direct.status === 'invalid' ? 402 : 503, direct.reason)
      if (direct.from.toLowerCase() !== v.seller_wallet.toLowerCase())
        return err(c, 402, 'the fee must be paid from the same wallet you list as seller_wallet')
      feeTx = v.fee_tx_hash!
    }
  }

  let rows: { id: number }[]
  if (feeTx) {
    try {
      rows = (await sql`
        WITH new_listing AS (
          INSERT INTO listings (merchant_id, title, description, preview, artifact, price_usdc, seller_wallet, tags, aisle, dup_hash)
          VALUES (${m.id}, ${v.title}, ${v.description}, ${v.preview}, ${v.artifact}, ${v.price_usdc}, ${v.seller_wallet}, ${v.tags}, ${v.aisle}, ${hash})
          RETURNING id, title, price_usdc
        ), new_fee AS (
          INSERT INTO fees (merchant_id, listing_id, amount_usdc, tx_hash)
          SELECT ${m.id}, id, ${LISTING_FEE_USDC}, ${feeTx} FROM new_listing
        ), new_event AS (
          INSERT INTO events (kind, actor, detail)
          SELECT 'listing', ${m.handle}, jsonb_build_object(
            'listing_id', id, 'title', title, 'price_usdc', price_usdc
          ) FROM new_listing
        )
        SELECT id FROM new_listing`) as { id: number }[]
    } catch (error) {
      const constraint = postgresUniqueConstraint(error)
      if (!constraint || !FEE_TX_CONSTRAINTS.includes(constraint)) throw error
      return err(c, 409, 'that fee transaction was already used')
    }
  } else {
    rows = (await sql`
      WITH new_listing AS (
        INSERT INTO listings (merchant_id, title, description, preview, artifact, price_usdc, seller_wallet, tags, aisle, dup_hash)
        VALUES (${m.id}, ${v.title}, ${v.description}, ${v.preview}, ${v.artifact}, ${v.price_usdc}, ${v.seller_wallet}, ${v.tags}, ${v.aisle}, ${hash})
        RETURNING id, title, price_usdc
      ), new_event AS (
        INSERT INTO events (kind, actor, detail)
        SELECT 'maintainer_seed', ${m.handle}, jsonb_build_object(
          'listing_id', id, 'title', title, 'price_usdc', price_usdc
        ) FROM new_listing
      )
      SELECT id FROM new_listing`) as { id: number }[]
  }
  const id = rows[0]!.id
  if (responseHeader) c.header('X-PAYMENT-RESPONSE', responseHeader)
  return c.json({ listing_id: id, url: `${DOMAIN}/api/listing/${id}`, fee_tx: feeTx }, 201)
})

app.patch('/api/listing/:id', async c => {
  const m = await auth(c)
  if (!m) return err(c, 401, 'bad or missing bearer secret')
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return err(c, 400, 'bad id')

  const body = await c.req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return err(c, 400, 'body must be a JSON object with at least one editable field')
  const keys = Object.keys(body)
  const unknown = keys.filter(key => !(EDITABLE_LISTING_FIELDS as readonly string[]).includes(key))
  if (!keys.length || unknown.length)
    return err(c, 400, `editable fields: ${EDITABLE_LISTING_FIELDS.join(', ')}`)

  const rows = (await sql`
    SELECT id, merchant_id, title, description, preview, artifact,
      price_usdc::float8 AS price_usdc, seller_wallet, tags, aisle, delivery_kind, votes, sales,
      pinned, removed, removed_at, withdrawn, withdrawn_at, created_at,
      EXISTS (SELECT 1 FROM purchases p WHERE p.listing_id = listings.id) AS has_purchases
    FROM listings WHERE id = ${id}`) as EditableListingRow[]
  const current = rows[0]
  if (!current) return err(c, 404, 'no such listing')
  if (current.merchant_id !== m.id) return err(c, 403, 'only the merchant that listed this item may edit it')
  if (current.delivery_kind === 'city_ownership')
    return err(c, 409, 'world listing terms are locked in the city and cannot be edited')
  if (current.removed || current.withdrawn || Number(current.sales) > 0 || current.has_purchases)
    return err(c, 409, 'only a live listing with no completed purchases may be edited')
  const priced = Number(current.price_usdc) > 0
  if (priced && (keys.includes('title') || keys.includes('artifact')))
    return err(c, 409, 'title and artifact are immutable on a priced listing')

  const merged = { ...current, ...(body as Record<string, unknown>) }
  const validated = validListing(merged)
  if (typeof validated === 'string') return err(c, 400, validated)

  const changedFields = EDITABLE_LISTING_FIELDS.filter(field =>
    JSON.stringify(current[field]) !== JSON.stringify(validated[field]),
  )
  if (!changedFields.length)
    return c.json({ listing: listingSummary(id, m.handle, validated, current) })

  const hash = dupHash(validated.title, validated.artifact)
  if (!priced && (changedFields.includes('title') || changedFields.includes('artifact'))) {
    const duplicate = (await sql`
      SELECT id FROM listings WHERE dup_hash = ${hash} AND id <> ${id} AND NOT removed
        AND created_at > now() - make_interval(days => ${DUPE_WINDOW_DAYS})`) as { id: number }[]
    if (duplicate.length)
      return err(c, 409, `a near-identical listing exists: ${duplicate[0]!.id}. Make something new.`)
  }

  const updated = priced
    ? await sql`
      WITH updated_listing AS (
        UPDATE listings SET
          description = ${validated.description}, preview = ${validated.preview},
          tags = ${validated.tags}, aisle = ${validated.aisle}
        WHERE id = ${id} AND merchant_id = ${m.id} AND NOT removed AND NOT withdrawn AND sales = 0
          AND NOT EXISTS (SELECT 1 FROM purchases p WHERE p.listing_id = listings.id)
        RETURNING id
      ), new_event AS (
        INSERT INTO events (kind, actor, detail)
        SELECT 'listing_edit', ${m.handle}, jsonb_build_object(
          'listing_id', id, 'changed_fields', ${JSON.stringify(changedFields)}::jsonb
        ) FROM updated_listing
      )
      SELECT id FROM updated_listing`
    : await sql`
      WITH updated_listing AS (
        UPDATE listings SET
          title = ${validated.title}, description = ${validated.description}, preview = ${validated.preview},
          artifact = ${validated.artifact}, tags = ${validated.tags}, aisle = ${validated.aisle},
          dup_hash = ${hash}
        WHERE id = ${id} AND merchant_id = ${m.id} AND NOT removed AND NOT withdrawn AND sales = 0
          AND NOT EXISTS (SELECT 1 FROM purchases p WHERE p.listing_id = listings.id)
        RETURNING id
      ), new_event AS (
        INSERT INTO events (kind, actor, detail)
        SELECT 'listing_edit', ${m.handle}, jsonb_build_object(
          'listing_id', id, 'changed_fields', ${JSON.stringify(changedFields)}::jsonb
        ) FROM updated_listing
      )
      SELECT id FROM updated_listing`
  if (!updated.length)
    return err(c, 409, 'the listing changed, sold, or was withdrawn before this edit could be saved')

  // Only field names are public. Private artifacts and old/new values never enter the event log.
  return c.json({ listing: listingSummary(id, m.handle, validated, current) })
})

async function withdrawListing(c: Context) {
  const m = await auth(c)
  if (!m) return err(c, 401, 'bad or missing bearer secret')
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return err(c, 400, 'bad id')

  const rawBody = (await c.req.text()).trim()
  if (rawBody) {
    const body = (() => { try { return JSON.parse(rawBody) as unknown } catch { return null } })()
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length)
      return err(c, 400, 'withdrawal accepts only an empty JSON object or no body')
  }
  const reason = 'withdrawn by merchant'

  const existing = (await sql`
    SELECT id, merchant_id, removed, removed_at, withdrawn, withdrawn_at,
      delivery_kind, world_offer_id, world_draft_id, world_state
    FROM listings WHERE id = ${id}`) as {
      id: number; merchant_id: number; removed: boolean; removed_at: string | null
      withdrawn: boolean; withdrawn_at: string | null
      delivery_kind: 'artifact' | 'city_ownership'; world_offer_id: number | null
      world_draft_id: number | null; world_state: string | null
    }[]
  const listing = existing[0]
  if (!listing) return err(c, 404, 'no such listing')
  if (listing.merchant_id !== m.id)
    return err(c, 403, 'only the merchant that listed this item may withdraw it')
  if (listing.delivery_kind === 'city_ownership' && listing.world_state === 'sold')
    return err(c, 409, 'city ownership was already sold; its market receipt is permanent')
  if (listing.withdrawn)
    return c.json({
      ok: true, listing_id: id, status: 'withdrawn' as const,
      ...(listing.delivery_kind === 'city_ownership' && listing.world_offer_id
        ? { city_unlock_required: true, city_cancel_url: cityCancelUrl(listing.world_offer_id) }
        : {}),
    })
  if (listing.removed)
    return err(c, 409, 'this listing was already removed by the maintainer')

  const withdrawn = await sql`
    WITH withdrawn_listing AS (
      UPDATE listings SET withdrawn = TRUE, withdrawn_at = now(), withdrawn_reason = ${reason},
        world_state = CASE WHEN delivery_kind = 'city_ownership' THEN 'canceled' ELSE world_state END
      WHERE id = ${id} AND merchant_id = ${m.id} AND NOT removed AND NOT withdrawn
        AND (delivery_kind <> 'city_ownership' OR world_state <> 'sold')
      RETURNING id, delivery_kind, world_offer_id, world_draft_id
    ), withdrawn_world_draft AS (
      UPDATE world_drafts d SET state = 'withdrawn', canceled_at = now(),
        canceled_reason = 'withdrawn by merchant'
      FROM withdrawn_listing l
      WHERE l.delivery_kind = 'city_ownership' AND d.id = l.world_draft_id
    ), expired_world_checkouts AS (
      UPDATE world_checkouts SET status = 'expired'
      WHERE listing_id IN (SELECT id FROM withdrawn_listing) AND status = 'active'
    ), new_event AS (
      INSERT INTO events (kind, actor, detail)
      SELECT 'withdrawal', ${m.handle}, jsonb_build_object('listing_id', id, 'reason', ${reason}::text)
      FROM withdrawn_listing
    )
    SELECT id FROM withdrawn_listing`
  if (!withdrawn.length) {
    const raced = (await sql`
      SELECT id, merchant_id, removed, removed_at, withdrawn, withdrawn_at,
        delivery_kind, world_offer_id, world_draft_id, world_state
      FROM listings WHERE id = ${id}`) as {
        id: number; merchant_id: number; removed: boolean; removed_at: string | null
        withdrawn: boolean; withdrawn_at: string | null
        delivery_kind: 'artifact' | 'city_ownership'; world_offer_id: number | null
        world_draft_id: number | null; world_state: string | null
      }[]
    if (raced[0]?.merchant_id === m.id && raced[0].withdrawn)
      return c.json({
        ok: true, listing_id: id, status: 'withdrawn' as const,
        ...(raced[0].delivery_kind === 'city_ownership' && raced[0].world_offer_id
          ? { city_unlock_required: true, city_cancel_url: cityCancelUrl(raced[0].world_offer_id) }
          : {}),
      })
    return err(c, 409, 'the listing changed before withdrawal could be saved')
  }
  return c.json({
    ok: true, listing_id: id, status: 'withdrawn' as const,
    ...(listing.delivery_kind === 'city_ownership' && listing.world_offer_id
      ? { city_unlock_required: true, city_cancel_url: cityCancelUrl(listing.world_offer_id) }
      : {}),
  })
}

app.post('/api/listing/:id/withdraw', withdrawListing)
app.delete('/api/listing/:id', withdrawListing)

// ---------- Buying ----------

interface BuyableListing {
  id: number; merchant_id: number; title: string; price_usdc: number
  seller_wallet: string
  removed: boolean; removed_at: string | null
  withdrawn: boolean; withdrawn_at: string | null
  created_at: string; checked_at?: string
  delivery_kind: 'artifact' | 'city_ownership'
}

interface DirectPurchaseIntentRow extends Omit<DirectPurchaseIntent, 'buyer'> {
  merchant_id: number
  superseded_at: string | null
  claimed_at: string | null
}

function directIntentForBuyer(row: DirectPurchaseIntentRow, buyer: string): DirectPurchaseIntent {
  return {
    id: row.id,
    listing_id: row.listing_id,
    buyer,
    payer_wallet: row.payer_wallet,
    seller_wallet: row.seller_wallet,
    network: row.network,
    asset: row.asset,
    minimum_amount_usdc: row.minimum_amount_usdc,
    challenge_nonce: row.challenge_nonce,
    created_at: row.created_at,
    expires_at: row.expires_at,
  }
}

function parseDirectIntentBody(input: unknown): { payer_wallet: string } | string {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    return 'body must contain exactly: payer_wallet'
  const keys = Object.keys(input)
  if (keys.length !== 1 || keys[0] !== 'payer_wallet')
    return 'body must contain exactly: payer_wallet'
  const payerWallet = (input as { payer_wallet?: unknown }).payer_wallet
  if (typeof payerWallet !== 'string' || !WALLET_RE.test(payerWallet))
    return 'payer_wallet must be a 0x wallet address'
  return { payer_wallet: payerWallet.toLowerCase() }
}

interface DirectClaimBody {
  intent_id: number
  tx_hash: string
  payer_signature: string
}

function parseDirectClaimBody(input: unknown): DirectClaimBody | string {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    return 'body must contain exactly: intent_id, tx_hash, payer_signature'
  const keys = Object.keys(input).sort()
  if (keys.join(',') !== 'intent_id,payer_signature,tx_hash')
    return 'body must contain exactly: intent_id, tx_hash, payer_signature'
  const body = input as Record<string, unknown>
  if (typeof body.intent_id !== 'number' || !Number.isInteger(body.intent_id) || body.intent_id < 1)
    return 'intent_id must be a positive integer'
  const txHash = canonicalTxHash(body.tx_hash)
  if (!txHash) return 'tx_hash must be 0x followed by 64 hex characters'
  if (typeof body.payer_signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(body.payer_signature))
    return 'payer_signature must be a 65-byte personal_sign signature'
  return { intent_id: body.intent_id, tx_hash: txHash, payer_signature: body.payer_signature }
}

async function getPurchaseListing(
  c: Context, m: Merchant, id: number, allowTerminal: boolean,
): Promise<BuyableListing | Response> {
  if (!Number.isInteger(id)) return err(c, 400, 'bad id')
  const rows = (await sql`
    SELECT id, merchant_id, title, price_usdc::float8 AS price_usdc, seller_wallet, delivery_kind,
      removed, removed_at, withdrawn, withdrawn_at, created_at, clock_timestamp() AS checked_at
    FROM listings WHERE id = ${id}`) as BuyableListing[]
  if (!rows[0]) return err(c, 404, 'no such listing')
  if (rows[0].merchant_id === m.id) return err(c, 403, 'you cannot buy your own goods (constitution §5)')
  if (rows[0].delivery_kind === 'city_ownership')
    return err(c, 409, `world checkout is required for city ownership — POST /api/world/checkout/${id}`)
  if (!allowTerminal && rows[0].removed) return err(c, 404, 'listing was removed')
  if (!allowTerminal && rows[0].withdrawn) return err(c, 404, 'listing was withdrawn and is not available')
  return rows[0]
}

const getBuyable = (c: Context, m: Merchant, id: number) => getPurchaseListing(c, m, id, false)
const getClaimable = (c: Context, m: Merchant, id: number) => getPurchaseListing(c, m, id, true)

async function deliver(c: Context, listingId: number) {
  const rows = (await sql`SELECT title, artifact FROM listings WHERE id = ${listingId}`) as { title: string; artifact: string }[]
  return c.json({ listing_id: listingId, title: rows[0]!.title, artifact: rows[0]!.artifact })
}

async function createDirectPurchaseIntent(
  c: Context,
  merchant: Merchant,
  listing: BuyableListing,
  payerWallet: string,
  startedAt: Date,
) {
  const createdAt = startedAt.toISOString()
  const expiresAt = new Date(startedAt.getTime() + DIRECT_PURCHASE_INTENT_TTL_MS).toISOString()
  const nonce = randomBytes(32).toString('hex')
  try {
    const rows = (await sql`
      WITH current_terms AS (
        SELECT l.id, l.price_usdc, lower(l.seller_wallet) AS seller_wallet
        FROM listings l
        WHERE l.id = ${listing.id} AND l.merchant_id <> ${merchant.id}
          AND l.delivery_kind = 'artifact' AND NOT l.removed AND NOT l.withdrawn
          AND l.price_usdc = ${listing.price_usdc}
          AND lower(l.seller_wallet) = lower(${listing.seller_wallet})
          AND NOT EXISTS (
            SELECT 1 FROM purchases p WHERE p.listing_id = l.id AND p.merchant_id = ${merchant.id}
          )
      ), fresh_intent AS (
        INSERT INTO direct_purchase_intents (
          merchant_id, listing_id, payer_wallet, seller_wallet, network, asset,
          minimum_amount_usdc, challenge_nonce, created_at, expires_at
        )
        SELECT ${merchant.id}, id, ${payerWallet}, seller_wallet, ${NETWORK}, lower(${USDC}),
          price_usdc, ${nonce}, ${createdAt}::timestamptz, ${expiresAt}::timestamptz
        FROM current_terms
        ON CONFLICT (merchant_id, listing_id) DO UPDATE SET
          payer_wallet = EXCLUDED.payer_wallet,
          seller_wallet = EXCLUDED.seller_wallet,
          network = EXCLUDED.network,
          asset = EXCLUDED.asset,
          minimum_amount_usdc = EXCLUDED.minimum_amount_usdc,
          challenge_nonce = EXCLUDED.challenge_nonce,
          created_at = EXCLUDED.created_at,
          expires_at = EXCLUDED.expires_at,
          superseded_at = NULL
        WHERE direct_purchase_intents.claimed_at IS NULL
          AND (
            direct_purchase_intents.superseded_at IS NOT NULL
            OR direct_purchase_intents.expires_at <= EXCLUDED.created_at
          )
        RETURNING id, merchant_id, listing_id, payer_wallet, seller_wallet, network, asset,
          minimum_amount_usdc::text, challenge_nonce, created_at, expires_at,
          superseded_at, claimed_at
      )
      SELECT * FROM fresh_intent`) as DirectPurchaseIntentRow[]
    const row = rows[0]
    if (row) return directPurchaseIntentResponse(c, row, merchant.handle, 201)
  } catch (error) {
    const constraint = postgresUniqueConstraint(error)
    if (!constraint || !OPEN_INTENT_CONSTRAINTS.includes(constraint)) throw error
  }
  const existing = (await sql`
    SELECT i.id, i.merchant_id, i.listing_id, i.payer_wallet, i.seller_wallet,
      i.network, i.asset, i.minimum_amount_usdc::text, i.challenge_nonce,
      i.created_at, i.expires_at, i.superseded_at, i.claimed_at
    FROM direct_purchase_intents i
    JOIN listings l ON l.id = i.listing_id
    WHERE i.listing_id = ${listing.id} AND i.merchant_id = ${merchant.id}
      AND i.payer_wallet = ${payerWallet} AND i.claimed_at IS NULL AND i.superseded_at IS NULL
      AND i.expires_at > ${createdAt}::timestamptz
      AND l.merchant_id <> ${merchant.id} AND l.delivery_kind = 'artifact'
      AND NOT l.removed AND NOT l.withdrawn
      AND i.seller_wallet = lower(l.seller_wallet) AND i.minimum_amount_usdc = l.price_usdc
      AND i.network = ${NETWORK} AND i.asset = lower(${USDC})
      AND NOT EXISTS (
        SELECT 1 FROM purchases p WHERE p.listing_id = l.id AND p.merchant_id = ${merchant.id}
      )`) as DirectPurchaseIntentRow[]
  if (existing[0]) return directPurchaseIntentResponse(c, existing[0], merchant.handle, 200)
  return err(c, 409, 'listing changed, was purchased, or another payer has a fresh intent; re-read it before paying')
}

function directPurchaseIntentResponse(
  c: Context,
  row: DirectPurchaseIntentRow,
  buyer: string,
  status: 200 | 201,
) {
  const intent = directIntentForBuyer(row, buyer)
  return c.json({
    purchase_intent: {
      ...intent,
      signature_method: 'personal_sign',
      challenge: purchaseIntentChallenge(intent),
      tip_allowed: true,
      next: `Sign the exact challenge with payer_wallet, pay after created_at, then POST /api/claim/${intent.listing_id} before expires_at.`,
    },
  }, status)
}

async function recordPurchase(
  c: Context, m: Merchant, l: BuyableListing, via: 'x402' | 'claim' | 'free', txHash: string | null, amount: number,
  acceptedOrPaidAt: Date | null,
) {
  const boundary = acceptedOrPaidAt?.toISOString() ?? null
  try {
    const purchaseQuery = boundary
      ? sql`
        WITH payment_boundary AS (
          SELECT ${boundary}::timestamptz AS accepted_or_paid_at
        ), locked_listing AS (
          SELECT l.id FROM listings l CROSS JOIN payment_boundary b
          WHERE l.id = ${l.id} AND l.merchant_id <> ${m.id}
            AND l.price_usdc = ${l.price_usdc}
            AND lower(l.seller_wallet) = lower(${l.seller_wallet})
            AND (
              (NOT l.removed AND NOT l.withdrawn)
              OR b.accepted_or_paid_at <= coalesce(
                least(l.removed_at, l.withdrawn_at), l.removed_at, l.withdrawn_at
              )
            )
          FOR UPDATE OF l
        ), new_purchase AS (
          INSERT INTO purchases (listing_id, merchant_id, amount_usdc, tx_hash, verified_via)
          SELECT id, ${m.id}, ${amount}, ${txHash}, ${via} FROM locked_listing
          RETURNING listing_id
        ), new_sale_count AS (
          UPDATE listings SET sales = sales + 1
          WHERE id IN (SELECT listing_id FROM new_purchase)
        ), new_event AS (
          INSERT INTO events (kind, actor, detail)
          SELECT 'sale', ${m.handle}, jsonb_build_object(
            'listing_id', listing_id, 'amount_usdc', ${amount}::numeric, 'via', ${via}::text
          ) FROM new_purchase
        )
        SELECT listing_id FROM new_purchase`
      : sql`
        WITH locked_listing AS (
          SELECT id FROM listings
          WHERE id = ${l.id} AND merchant_id <> ${m.id} AND NOT removed AND NOT withdrawn
            AND price_usdc = ${l.price_usdc} AND lower(seller_wallet) = lower(${l.seller_wallet})
          FOR UPDATE
        ), new_purchase AS (
          INSERT INTO purchases (listing_id, merchant_id, amount_usdc, tx_hash, verified_via)
          SELECT id, ${m.id}, ${amount}, ${txHash}, ${via} FROM locked_listing
          RETURNING listing_id
        ), new_sale_count AS (
          UPDATE listings SET sales = sales + 1
          WHERE id IN (SELECT listing_id FROM new_purchase)
        ), new_event AS (
          INSERT INTO events (kind, actor, detail)
          SELECT 'sale', ${m.handle}, jsonb_build_object(
            'listing_id', listing_id, 'amount_usdc', ${amount}::numeric, 'via', ${via}::text
          ) FROM new_purchase
        )
        SELECT listing_id FROM new_purchase`
    const rows = await purchaseQuery
    if (!rows.length)
      return err(c, 409, 'listing changed or became unavailable; re-read it before paying')
  } catch (error) {
    const constraint = postgresUniqueConstraint(error)
    if (constraint === 'purchases_listing_id_merchant_id_key')
      return err(c, 409, 'already purchased; re-download via GET /api/purchases')
    if (constraint && PURCHASE_TX_CONSTRAINTS.includes(constraint))
      return err(c, 409, 'that transaction hash was already used for another market payment')
    throw error
  }
  return deliver(c, l.id)
}

async function recordDirectPurchase(
  c: Context,
  merchant: Merchant,
  listing: BuyableListing,
  intent: DirectPurchaseIntentRow,
  txHash: string,
  payerWallet: string,
  paidAt: Date,
  requestStartedAt: Date,
) {
  try {
    const rows = await sql`
      WITH locked_claim AS (
        SELECT l.id AS listing_id, i.id AS direct_purchase_intent_id
        FROM listings l
        JOIN direct_purchase_intents i ON i.id = ${intent.id} AND i.listing_id = l.id
        WHERE l.id = ${listing.id} AND l.merchant_id <> ${merchant.id}
          AND l.delivery_kind = 'artifact' AND l.price_usdc = ${listing.price_usdc}
          AND lower(l.seller_wallet) = lower(${listing.seller_wallet})
          AND i.merchant_id = ${merchant.id}
          AND i.payer_wallet = lower(${payerWallet})
          AND i.seller_wallet = lower(l.seller_wallet)
          AND i.network = ${NETWORK} AND i.asset = lower(${USDC})
          AND i.minimum_amount_usdc = l.price_usdc
          AND i.claimed_at IS NULL AND i.superseded_at IS NULL
          AND i.created_at <= ${paidAt.toISOString()}::timestamptz
          AND i.expires_at >= ${paidAt.toISOString()}::timestamptz
          AND i.created_at <= ${requestStartedAt.toISOString()}::timestamptz
          AND i.expires_at >= ${requestStartedAt.toISOString()}::timestamptz
          AND (
            (NOT l.removed AND NOT l.withdrawn)
            OR ${paidAt.toISOString()}::timestamptz <= coalesce(
              least(l.removed_at, l.withdrawn_at), l.removed_at, l.withdrawn_at
            )
          )
        FOR UPDATE OF l, i
      ), new_purchase AS (
        INSERT INTO purchases (
          listing_id, merchant_id, amount_usdc, tx_hash, verified_via, direct_purchase_intent_id
        )
        SELECT listing_id, ${merchant.id}, ${listing.price_usdc}, ${txHash}, 'claim',
          direct_purchase_intent_id FROM locked_claim
        RETURNING listing_id, direct_purchase_intent_id
      ), claimed_intent AS (
        UPDATE direct_purchase_intents SET claimed_at = clock_timestamp()
        WHERE id IN (SELECT direct_purchase_intent_id FROM new_purchase)
      ), new_sale_count AS (
        UPDATE listings SET sales = sales + 1
        WHERE id IN (SELECT listing_id FROM new_purchase)
      ), new_event AS (
        INSERT INTO events (kind, actor, detail)
        SELECT 'sale', ${merchant.handle}, jsonb_build_object(
          'listing_id', listing_id, 'amount_usdc', ${listing.price_usdc}::numeric, 'via', 'claim'
        ) FROM new_purchase
      )
      SELECT listing_id FROM new_purchase`
    if (!rows.length) return err(c, 409, 'listing or purchase intent changed; start again before paying')
  } catch (error) {
    const constraint = postgresUniqueConstraint(error)
    if (constraint === 'purchases_listing_id_merchant_id_key')
      return err(c, 409, 'already purchased; re-download via GET /api/purchases')
    if (constraint === 'purchases_direct_intent_unique')
      return err(c, 409, 'that purchase intent was already used')
    if (constraint && PURCHASE_TX_CONSTRAINTS.includes(constraint))
      return err(c, 409, 'that transaction hash was already used for another market payment')
    throw error
  }
  return deliver(c, listing.id)
}

app.post('/api/purchase-intent/:id', async c => {
  const requestStartedAt = new Date()
  const merchant = await auth(c)
  if (!merchant) return err(c, 401, 'open /join first to create a merchant, then send its saved key as a bearer credential')
  const listing = await getBuyable(c, merchant, Number(c.req.param('id')))
  if (listing instanceof Response) return listing
  if (listing.price_usdc === 0) return err(c, 409, 'this listing is free; use POST /api/buy/:id')

  const unavailable = paymentReadinessResponse(c)
  if (unavailable) return unavailable
  const parsed = parseDirectIntentBody(await c.req.json().catch(() => null))
  if (typeof parsed === 'string') return err(c, 400, parsed)

  const prior = await sql`SELECT id FROM purchases WHERE listing_id = ${listing.id} AND merchant_id = ${merchant.id}`
  if (prior.length) return err(c, 409, 'already purchased; re-download via GET /api/purchases')
  return createDirectPurchaseIntent(c, merchant, listing, parsed.payer_wallet, requestStartedAt)
})

app.post('/api/buy/:id', async c => {
  const m = await auth(c)
  if (!m) return err(c, 401, 'open /join first to create a merchant, then send its saved key as a bearer credential')
  const l = await getBuyable(c, m, Number(c.req.param('id')))
  if (l instanceof Response) return l
  const checkedAt = new Date(l.checked_at ?? '')
  const acceptedAt = Number.isNaN(checkedAt.getTime()) ? new Date() : checkedAt

  const prior = await sql`SELECT id FROM purchases WHERE listing_id = ${l.id} AND merchant_id = ${m.id}`
  if (prior.length) return deliver(c, l.id)

  if (l.price_usdc === 0) return recordPurchase(c, m, l, 'free', null, 0, null)

  const unavailable = paymentReadinessResponse(c)
  if (unavailable) return unavailable

  // The money goes to the SELLER. The market is not a party to this transaction.
  const reqs = requirements(l.seller_wallet, l.price_usdc, `${DOMAIN}/api/buy/${l.id}`, `1F3EA: ${l.title}`)
  const header = c.req.header('x-payment')
  if (!header)
    return challenge402(
      c,
      reqs,
      `costs $${l.price_usdc} USDC, paid directly to the seller — retry with X-PAYMENT, ` +
      `or start a signed ten-minute direct-payment intent at POST /api/purchase-intent/${l.id} before paying`,
    )
  const settled = await settleX402(header, reqs)
  if (settled.status !== 'verified') {
    return settled.status === 'invalid'
      ? challenge402(c, reqs, settled.reason)
      : err(c, settled.status === 'unclassified' ? 502 : 503, settled.reason)
  }
  c.header('X-PAYMENT-RESPONSE', paymentResponseHeader(settled))
  return recordPurchase(c, m, l, 'x402', settled.transaction, l.price_usdc, acceptedAt)
})

app.post('/api/claim/:id', async c => {
  const requestStartedAt = new Date()
  const m = await auth(c)
  if (!m) return err(c, 401, 'open /join first to create a merchant, then send its saved key as a bearer credential')
  const l = await getClaimable(c, m, Number(c.req.param('id')))
  if (l instanceof Response) return l
  if (l.price_usdc === 0) {
    if (l.removed || l.withdrawn) return err(c, 404, 'listing is no longer available')
    return recordPurchase(c, m, l, 'free', null, 0, null)
  }

  const unavailable = paymentReadinessResponse(c)
  if (unavailable) return unavailable

  const parsed = parseDirectClaimBody(await c.req.json().catch(() => null))
  if (typeof parsed === 'string') return err(c, 400, parsed)
  const rows = (await sql`
    SELECT i.id, i.merchant_id, i.listing_id, i.payer_wallet, i.seller_wallet,
      i.network, i.asset, i.minimum_amount_usdc::text, i.challenge_nonce,
      i.created_at, i.expires_at, i.superseded_at, i.claimed_at
    FROM direct_purchase_intents i
    JOIN listings current_listing ON current_listing.id = i.listing_id
    WHERE i.id = ${parsed.intent_id} AND i.listing_id = ${l.id} AND i.merchant_id = ${m.id}
      AND i.seller_wallet = lower(current_listing.seller_wallet)
      AND i.minimum_amount_usdc = current_listing.price_usdc
      AND i.network = ${NETWORK} AND i.asset = lower(${USDC})`) as DirectPurchaseIntentRow[]
  const intentRow = rows[0]
  if (!intentRow || intentRow.claimed_at || intentRow.superseded_at)
    return err(c, 409, `no open signed purchase intent; POST /api/purchase-intent/${l.id} before paying`)

  const intent = directIntentForBuyer(intentRow, m.handle)
  const preflightError = directPaymentWindowError(intent, new Date(intent.created_at), requestStartedAt)
  if (preflightError) return err(c, 409, preflightError)
  const signatureProof = await verifyPersonalSignatureProof(
    purchaseIntentChallenge(intent), parsed.payer_signature, intent.payer_wallet,
  )
  if (signatureProof.status !== 'verified')
    return err(c, signatureProof.status === 'invalid' ? 402 : 503, signatureProof.reason)

  const direct = await verifyDirectPayment(
    parsed.tx_hash, intent.seller_wallet, Number(intent.minimum_amount_usdc), new Date(intent.created_at),
  )
  if (direct.status !== 'verified')
    return err(c, direct.status === 'invalid' ? 402 : 503, direct.reason)
  if (direct.from.toLowerCase() !== intent.payer_wallet)
    return err(c, 402, 'transaction payer does not match the signed purchase intent')
  const windowError = directPaymentWindowError(intent, direct.blockTime, requestStartedAt)
  if (windowError) return err(c, windowError.startsWith('payment') ? 402 : 409, windowError)
  if (l.removed || l.withdrawn) {
    const terminalTimes = [l.removed_at, l.withdrawn_at]
      .filter((value): value is string => Boolean(value))
      .map(value => new Date(value))
      .filter(value => !Number.isNaN(value.getTime()))
      .sort((a, b) => a.getTime() - b.getTime())
    const terminalAt = terminalTimes[0]
    if (!terminalAt || direct.blockTime > terminalAt)
      return err(c, 409, 'payment happened after this listing left the market')
  }
  return recordDirectPurchase(
    c, m, l, intentRow, parsed.tx_hash, intent.payer_wallet, direct.blockTime, requestStartedAt,
  )
})

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
      payment_recovery: 'payment_pending stays locked and retries without paying again; only canonical finalized invalid evidence can close unsold',
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
