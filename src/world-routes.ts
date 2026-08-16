import type { Hono } from 'hono'
import { auth, dupHash, err, HANDLE_RE, WALLET_RE } from './core.ts'
import { sql } from './db.ts'
import {
  canonicalTxHash,
  challenge402,
  LISTING_FEE_USDC,
  paymentReadinessResponse,
  paymentResponseHeader,
  requirements,
  settleX402,
  TREASURY,
  verifyDirectPayment,
} from './pay.ts'
import {
  CITY_ORIGIN,
  cityCancelUrl,
  cityClaimUrl,
  cityOfferMatchesDraft,
  cityOfferMatchesListing,
  cityOfferUrl,
  fetchCityOffer,
  fetchCityResident,
  isCityOfferAvailable,
  validWorldActivation,
  validWorldCheckout,
  validWorldDraft,
  type CityOffer,
  type ListingBinding,
  type PublicRecordResult,
  type WorldDraftInput,
} from './world.ts'

interface WorldRouteConfig {
  marketOrigin: string
  maintainerId: number
  seedCap: number
}

interface WorldDraftRow extends WorldDraftInput {
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

interface WorldListingRow extends ListingBinding {
  merchant_id: number
  market_seller: string
  title: string
  delivery_kind: 'artifact' | 'city_ownership'
  world_origin: string
  world_state: 'active' | 'sold' | 'canceled' | 'stale'
  removed: boolean
  removed_at: string | null
  withdrawn: boolean
  withdrawn_at: string | null
  created_at: string
}

interface WorldCheckoutRow {
  id: number
  status: 'active' | 'expired' | 'completed'
  listing_id: number
  world_offer_id: number
  market_draft_id: number
  merchant_id: number
  market_buyer: string
  city_handle: string
  expires_at: string
  created_at: string
}

interface WorldPurchaseRow {
  purchase_id: number
  listing_id: number
  world_checkout_id: number
  amount_usdc: number
  tx_hash: string
  world_receipt: Record<string, unknown> | string
  created_at: string
}

function postgresErrorCode(error: unknown, depth = 0): string | null {
  if (!error || typeof error !== 'object' || depth > 3) return null
  const candidate = error as { code?: unknown; sourceError?: unknown }
  if (typeof candidate.code === 'string') return candidate.code
  return postgresErrorCode(candidate.sourceError, depth + 1)
}

function positiveId(value: string): number | null {
  const id = Number(value)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

function dateIsPast(value: string): boolean {
  const date = new Date(value)
  return !Number.isNaN(date.getTime()) && date <= new Date()
}

function upstreamStatus(result: Extract<PublicRecordResult<unknown>, { ok: false }>): 409 | 503 {
  return result.kind === 'not_found' ? 409 : 503
}

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
    expires_at: row.expires_at,
    created_at: row.created_at,
  }
}

function checkoutPublicStatus(row: WorldCheckoutRow) {
  return row.status === 'active' && dateIsPast(row.expires_at) ? 'expired' as const : row.status
}

function checkoutEnvelope(row: WorldCheckoutRow) {
  return {
    id: Number(row.id),
    status: checkoutPublicStatus(row),
    listing_id: Number(row.listing_id),
    world_offer_id: Number(row.world_offer_id),
    market_draft_id: Number(row.market_draft_id),
    market_buyer: row.market_buyer,
    city_handle: row.city_handle,
    expires_at: row.expires_at,
    created_at: row.created_at,
  }
}

async function readDraft(id: number): Promise<WorldDraftRow | null> {
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

async function readWorldListing(id: number): Promise<WorldListingRow | null> {
  const rows = (await sql`
    SELECT l.id, l.merchant_id, m.handle AS market_seller, l.title,
      l.price_usdc::float8 AS price_usdc, l.seller_wallet,
      l.delivery_kind, l.world_origin, l.world_offer_id, l.world_asset_id,
      l.world_seller_handle, l.world_draft_id, l.world_state,
      l.removed, l.removed_at, l.withdrawn, l.withdrawn_at, l.created_at
    FROM listings l JOIN merchants m ON m.id = l.merchant_id
    WHERE l.id = ${id}`) as WorldListingRow[]
  return rows[0] ?? null
}

async function readCheckout(id: number): Promise<WorldCheckoutRow | null> {
  const rows = (await sql`
    SELECT c.id, c.status, c.listing_id, l.world_offer_id,
      l.world_draft_id AS market_draft_id, c.merchant_id,
      m.handle AS market_buyer, c.city_handle, c.expires_at, c.created_at
    FROM world_checkouts c
    JOIN listings l ON l.id = c.listing_id
    JOIN merchants m ON m.id = c.merchant_id
    WHERE c.id = ${id}`) as WorldCheckoutRow[]
  return rows[0] ?? null
}

function parseReceipt(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    } catch { /* a malformed stored record is exposed only as empty evidence */ }
  }
  return {}
}

function receiptEnvelope(row: WorldPurchaseRow) {
  const city = parseReceipt(row.world_receipt)
  return {
    purchase_id: Number(row.purchase_id),
    listing_id: Number(row.listing_id),
    checkout_id: Number(row.world_checkout_id),
    delivery_kind: 'city_ownership' as const,
    city_origin: CITY_ORIGIN,
    city_offer_id: Number(city.city_offer_id),
    city_asset_id: Number(city.city_asset_id),
    city_handle: String(city.city_handle ?? ''),
    amount_usdc: Number(row.amount_usdc),
    tx_hash: row.tx_hash,
    verified_via: 'world' as const,
    city_verified_via: String(city.city_verified_via ?? ''),
    city_receipt_url: cityOfferUrl(Number(city.city_offer_id)),
    created_at: row.created_at,
  }
}

async function priorWorldPurchase(listingId: number): Promise<WorldPurchaseRow | null> {
  const rows = (await sql`
    SELECT p.id AS purchase_id, p.listing_id, p.world_checkout_id,
      p.amount_usdc::float8 AS amount_usdc, p.tx_hash, p.world_receipt, p.created_at
    FROM purchases p WHERE p.listing_id = ${listingId} AND p.verified_via = 'world'
    LIMIT 1`) as WorldPurchaseRow[]
  return rows[0] ?? null
}

function receiptFields(offer: CityOffer) {
  const nested = offer.receipt && typeof offer.receipt === 'object' ? offer.receipt : {}
  const pick = (key: string) => (offer as unknown as Record<string, unknown>)[key] ?? nested[key]
  return {
    txHash: canonicalTxHash(pick('tx_hash')),
    buyerWallet: String(pick('buyer_wallet') ?? ''),
    via: String(pick('verified_via') ?? ''),
    blockTime: String(pick('block_time') ?? ''),
    paymentFrom: String(pick('from') ?? ''),
    paymentTo: String(pick('to') ?? ''),
  }
}

async function emptyBody(request: { text(): Promise<string> }): Promise<boolean> {
  const raw = (await request.text()).trim()
  if (!raw) return true
  try {
    const value = JSON.parse(raw)
    return Boolean(value && typeof value === 'object' && !Array.isArray(value) && !Object.keys(value).length)
  } catch {
    return false
  }
}

export function registerWorldRoutes(app: Hono, config: WorldRouteConfig) {
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
      if (postgresErrorCode(error) === '23505')
        return err(c, 409, 'you already have a live pending draft; activate it, cancel it, or wait for expiry')
      throw error
    }
  })

  app.get('/api/world/draft/:id', async c => {
    const id = positiveId(c.req.param('id'))
    if (!id) return err(c, 400, 'draft id must be a positive integer')
    const draft = await readDraft(id)
    if (!draft) return err(c, 404, 'no such world draft')
    c.header('Cache-Control', 'public, max-age=5, s-maxage=10')
    return c.json({ draft: draftEnvelope(draft) })
  })

  app.post('/api/world/listing', async c => {
    const merchant = await auth(c)
    if (!merchant) return err(c, 401, 'bad or missing bearer secret')
    const parsed = validWorldActivation(await c.req.json().catch(() => null))
    if (typeof parsed === 'string') return err(c, 400, parsed)
    const draft = await readDraft(parsed.draft_id)
    if (!draft) return err(c, 404, 'no such world draft')
    if (draft.merchant_id !== merchant.id) return err(c, 403, 'only the market merchant that made this draft may list it')
    if (draft.state !== 'pending' || dateIsPast(draft.expires_at))
      return err(c, 409, 'world draft is not pending and unexpired')

    const cityRecord = await fetchCityOffer(parsed.city_offer_id)
    if (!cityRecord.ok) return err(c, upstreamStatus(cityRecord), cityRecord.message)
    const mismatch = cityOfferMatchesDraft(cityRecord.value, draft, parsed.city_offer_id, config.marketOrigin)
    if (mismatch) return err(c, 409, mismatch)

    const countRows = (await sql`
      SELECT count(*)::int AS n FROM listings WHERE merchant_id = ${merchant.id}`) as { n: number }[]
    const isSeed = merchant.id === config.maintainerId && Number(countRows[0]!.n) < config.seedCap
    let feeTx: string | null = null
    let responseHeader: string | null = null
    if (!isSeed) {
      const unavailable = paymentReadinessResponse(c)
      if (unavailable) return unavailable
      const feeRequirements = requirements(
        TREASURY, LISTING_FEE_USDC, `${config.marketOrigin}/api/world/listing`, '1F3EA world listing fee',
      )
      const paymentHeader = c.req.header('x-payment')
      if (!paymentHeader && !parsed.fee_tx_hash)
        return challenge402(c, feeRequirements, 'world listing costs $1 USDC — pay via x402 or include fee_tx_hash')
      if (paymentHeader) {
        const settled = await settleX402(paymentHeader, feeRequirements)
        if ('error' in settled) return challenge402(c, feeRequirements, settled.error)
        feeTx = settled.transaction
        responseHeader = paymentResponseHeader(settled)
      } else {
        const direct = await verifyDirectPayment(
          parsed.fee_tx_hash!, TREASURY, LISTING_FEE_USDC, new Date(Date.now() - 3600e3),
        )
        if (!direct)
          return err(c, 402, 'fee_tx_hash did not verify: need >= $1 USDC on Base to the treasury, within the last hour, unused')
        if (direct.from.toLowerCase() !== draft.seller_wallet.toLowerCase())
          return err(c, 402, 'the fee must be paid from the same wallet as the world draft seller_wallet')
        feeTx = parsed.fee_tx_hash!
      }
    }

    const listingHash = dupHash(draft.title, `city:${draft.thing_id}:offer:${parsed.city_offer_id}`)
    try {
      const rows = feeTx
        ? await sql`
          WITH locked_world_draft AS (
            SELECT id FROM world_drafts
            WHERE id = ${draft.id} AND merchant_id = ${merchant.id}
              AND state = 'pending' AND expires_at > now()
            FOR UPDATE
          ), new_listing AS (
            INSERT INTO listings (
              merchant_id, title, description, preview, artifact, price_usdc, seller_wallet,
              tags, aisle, dup_hash, delivery_kind, world_origin, world_offer_id,
              world_asset_id, world_seller_handle, world_draft_id, world_state
            )
            SELECT ${merchant.id}, ${draft.title}, ${draft.description}, ${draft.preview}, '',
              ${draft.price_usdc}, ${draft.seller_wallet}, ${draft.tags}, 'world', ${listingHash},
              'city_ownership', ${CITY_ORIGIN}, ${parsed.city_offer_id}, ${draft.thing_id},
              ${cityRecord.value.seller}, id, 'active'
            FROM locked_world_draft
            RETURNING id, title, price_usdc, world_draft_id
          ), activated_world_draft AS (
            UPDATE world_drafts d SET state = 'active', listing_id = l.id
            FROM new_listing l WHERE d.id = l.world_draft_id
          ), new_fee AS (
            INSERT INTO fees (merchant_id, listing_id, amount_usdc, tx_hash)
            SELECT ${merchant.id}, id, ${LISTING_FEE_USDC}, ${feeTx} FROM new_listing
          ), new_event AS (
            INSERT INTO events (kind, actor, detail)
            SELECT 'listing', ${merchant.handle}, jsonb_build_object(
              'listing_id', id, 'title', title, 'price_usdc', price_usdc,
              'delivery_kind', 'city_ownership'
            ) FROM new_listing
          )
          SELECT id FROM new_listing`
        : await sql`
          WITH locked_world_draft AS (
            SELECT id FROM world_drafts
            WHERE id = ${draft.id} AND merchant_id = ${merchant.id}
              AND state = 'pending' AND expires_at > now()
            FOR UPDATE
          ), new_listing AS (
            INSERT INTO listings (
              merchant_id, title, description, preview, artifact, price_usdc, seller_wallet,
              tags, aisle, dup_hash, delivery_kind, world_origin, world_offer_id,
              world_asset_id, world_seller_handle, world_draft_id, world_state
            )
            SELECT ${merchant.id}, ${draft.title}, ${draft.description}, ${draft.preview}, '',
              ${draft.price_usdc}, ${draft.seller_wallet}, ${draft.tags}, 'world', ${listingHash},
              'city_ownership', ${CITY_ORIGIN}, ${parsed.city_offer_id}, ${draft.thing_id},
              ${cityRecord.value.seller}, id, 'active'
            FROM locked_world_draft
            RETURNING id, title, price_usdc, world_draft_id
          ), activated_world_draft AS (
            UPDATE world_drafts d SET state = 'active', listing_id = l.id
            FROM new_listing l WHERE d.id = l.world_draft_id
          ), new_event AS (
            INSERT INTO events (kind, actor, detail)
            SELECT 'maintainer_seed', ${merchant.handle}, jsonb_build_object(
              'listing_id', id, 'title', title, 'price_usdc', price_usdc,
              'delivery_kind', 'city_ownership'
            ) FROM new_listing
          )
          SELECT id FROM new_listing`
      if (!rows.length) return err(c, 409, 'world draft changed before the listing could be activated')
      const listingId = Number((rows[0] as { id: number }).id)
      if (responseHeader) c.header('X-PAYMENT-RESPONSE', responseHeader)
      return c.json({
        listing_id: listingId,
        url: `${config.marketOrigin}/api/listing/${listingId}`,
        delivery_kind: 'city_ownership',
        city_offer_url: cityOfferUrl(parsed.city_offer_id),
        fee_tx: feeTx,
      }, 201)
    } catch (error) {
      if (postgresErrorCode(error) === '23505')
        return err(c, 409, 'that fee transaction, city offer, or world draft was already used')
      throw error
    }
  })

  app.post('/api/world/checkout/:listingId', async c => {
    const merchant = await auth(c)
    if (!merchant) return err(c, 401, 'register in the market first — it is free')
    const listingId = positiveId(c.req.param('listingId'))
    if (!listingId) return err(c, 400, 'listing id must be a positive integer')
    const parsed = validWorldCheckout(await c.req.json().catch(() => null))
    if (typeof parsed === 'string') return err(c, 400, parsed)
    const listing = await readWorldListing(listingId)
    if (!listing) return err(c, 404, 'no such listing')
    if (listing.delivery_kind !== 'city_ownership') return err(c, 409, 'this is an artifact listing; use POST /api/buy/:id')
    if (listing.merchant_id === merchant.id) return err(c, 403, 'you cannot buy your own goods')
    if (listing.removed || listing.withdrawn || listing.world_state !== 'active')
      return err(c, 409, 'world listing is not live')

    const resident = await fetchCityResident(parsed.city_handle)
    if (!resident.ok) {
      if (resident.kind === 'not_found')
        return err(c, 409,
          'not a city resident: register in the city and choose your own name before checkout or payment')
      return err(c, 503, resident.message)
    }
    const cityRecord = await fetchCityOffer(listing.world_offer_id)
    if (!cityRecord.ok) return err(c, upstreamStatus(cityRecord), cityRecord.message)
    const mismatch = cityOfferMatchesListing(cityRecord.value, listing, config.marketOrigin)
    if (mismatch) return err(c, 409, mismatch)
    if (!isCityOfferAvailable(cityRecord.value)) return err(c, 409, 'city offer is not available for a new checkout')
    if (cityRecord.value.seller === parsed.city_handle)
      return err(c, 403, 'the city seller cannot buy their own thing')

    try {
      const rows = (await sql`
        WITH expired_checkouts AS (
          UPDATE world_checkouts SET status = 'expired'
          WHERE listing_id = ${listing.id} AND status = 'active' AND expires_at <= now()
        ), still_live AS (
          SELECT id FROM listings WHERE id = ${listing.id} AND merchant_id <> ${merchant.id}
            AND delivery_kind = 'city_ownership' AND world_state = 'active'
            AND NOT removed AND NOT withdrawn
          FOR UPDATE
        ), new_checkout AS (
          INSERT INTO world_checkouts (listing_id, merchant_id, city_handle)
          SELECT id, ${merchant.id}, ${parsed.city_handle} FROM still_live
          RETURNING id, expires_at
        )
        SELECT id, expires_at FROM new_checkout`) as { id: number; expires_at: string }[]
      if (!rows.length) return err(c, 409, 'world listing changed before checkout could be bound')
      const checkout = rows[0]!
      return c.json({
        checkout_id: Number(checkout.id),
        url: `${config.marketOrigin}/api/world/checkout/${checkout.id}`,
        expires_at: checkout.expires_at,
        city_claim_url: cityClaimUrl(listing.world_offer_id),
        note: 'This market checkout is only a public intent and does not reserve the thing. ' +
          'Authenticate to the city with your city bearer; the first city reservation wins before payment.',
      }, 201)
    } catch (error) {
      if (postgresErrorCode(error) === '23505')
        return err(c, 409, 'you already have an active checkout for this listing; wait for its ten-minute expiry')
      throw error
    }
  })

  app.get('/api/world/checkout/:id', async c => {
    const id = positiveId(c.req.param('id'))
    if (!id) return err(c, 400, 'checkout id must be a positive integer')
    const checkout = await readCheckout(id)
    if (!checkout) return err(c, 404, 'no such world checkout')
    c.header('Cache-Control', 'public, max-age=2, s-maxage=5')
    return c.json({ checkout: checkoutEnvelope(checkout) })
  })

  app.post('/api/world/sync/:listingId', async c => {
    const merchant = await auth(c)
    if (!merchant) return err(c, 401, 'bad or missing bearer secret')
    if (!(await emptyBody(c.req))) return err(c, 400, 'sync accepts only an empty JSON object or no body')
    const listingId = positiveId(c.req.param('listingId'))
    if (!listingId) return err(c, 400, 'listing id must be a positive integer')

    const prior = await priorWorldPurchase(listingId)
    if (prior) return c.json({ receipt: receiptEnvelope(prior) })
    const listing = await readWorldListing(listingId)
    if (!listing) return err(c, 404, 'no such listing')
    if (listing.delivery_kind !== 'city_ownership') return err(c, 409, 'not a world listing')

    const cityRecord = await fetchCityOffer(listing.world_offer_id)
    if (!cityRecord.ok) return err(c, upstreamStatus(cityRecord), cityRecord.message)
    const mismatch = cityOfferMatchesListing(cityRecord.value, listing, config.marketOrigin)
    if (mismatch) return err(c, 409, mismatch)

    if (cityRecord.value.phase === 'canceled') {
      const rows = await sql`
        WITH canceled_listing AS (
          UPDATE listings SET world_state = 'canceled', withdrawn = TRUE,
            withdrawn_at = coalesce(withdrawn_at, now()), withdrawn_reason = 'city offer canceled'
          WHERE id = ${listing.id} AND delivery_kind = 'city_ownership'
            AND world_state = 'active' AND NOT removed
          RETURNING id, world_draft_id
        ), canceled_draft AS (
          UPDATE world_drafts d SET state = 'canceled', canceled_at = now(),
            canceled_reason = 'city offer canceled'
          FROM canceled_listing l WHERE d.id = l.world_draft_id
        ), expired_checkouts AS (
          UPDATE world_checkouts SET status = 'expired'
          WHERE listing_id IN (SELECT id FROM canceled_listing) AND status = 'active'
        ), new_event AS (
          INSERT INTO events (kind, actor, detail)
          SELECT 'world_canceled', ${listing.market_seller}, jsonb_build_object(
            'listing_id', id, 'city_offer_id', ${listing.world_offer_id}
          ) FROM canceled_listing
        )
        SELECT id FROM canceled_listing`
      return c.json({
        listing_id: listing.id,
        status: rows.length ? 'canceled' : listing.world_state,
        city_offer_url: cityOfferUrl(listing.world_offer_id),
      })
    }
    const checkoutBoundPhases = ['reserved', 'payment_pending', 'payment_invalid', 'claimed']
    let checkout: WorldCheckoutRow | null = null
    if (checkoutBoundPhases.includes(cityRecord.value.phase)) {
      if (cityRecord.value.market_listing_id !== listing.id)
        return err(c, 409, 'city offer is not bound to this market listing')
      const checkoutId = cityRecord.value.market_checkout_id
      if (!checkoutId) return err(c, 409, 'city offer has no market checkout binding')
      checkout = await readCheckout(checkoutId)
      if (!checkout || checkout.listing_id !== listing.id ||
          checkout.market_draft_id !== listing.world_draft_id ||
          checkout.world_offer_id !== listing.world_offer_id)
        return err(c, 409, 'city offer points to a checkout for different terms')
      if (cityRecord.value.buyer !== checkout.city_handle)
        return err(c, 409, 'city buyer does not match the market checkout')
      if (cityRecord.value.market_buyer !== checkout.market_buyer)
        return err(c, 409, 'city market buyer does not match the market checkout')
    }

    if (cityRecord.value.phase === 'payment_invalid') {
      const rows = await sql`
        WITH invalid_payment_listing AS (
          UPDATE listings SET world_state = 'stale', withdrawn = TRUE,
            withdrawn_at = coalesce(withdrawn_at, now()), withdrawn_reason = 'city payment invalid'
          WHERE id = ${listing.id} AND delivery_kind = 'city_ownership'
            AND world_state = 'active' AND NOT removed
          RETURNING id, world_draft_id
        ), invalid_payment_draft AS (
          UPDATE world_drafts SET state = 'canceled', canceled_at = now(),
            canceled_reason = 'city payment invalid'
          WHERE id = ${listing.world_draft_id} AND state <> 'sold'
        ), expired_checkouts AS (
          UPDATE world_checkouts SET status = 'expired'
          WHERE listing_id = ${listing.id} AND status = 'active'
        ), new_event AS (
          INSERT INTO events (kind, actor, detail)
          SELECT 'world_canceled', ${listing.market_seller}, jsonb_build_object(
            'listing_id', id, 'city_offer_id', ${listing.world_offer_id},
            'reason', 'city payment invalid'
          ) FROM invalid_payment_listing
        )
        SELECT id FROM invalid_payment_listing`
      const status = rows.length ? 'stale' : (await readWorldListing(listing.id))?.world_state ?? 'stale'
      return c.json({
        listing_id: listing.id,
        status,
        city_phase: 'payment_invalid' as const,
        city_unlock_required: true,
        city_cancel_url: cityCancelUrl(listing.world_offer_id),
      })
    }
    if (cityRecord.value.phase !== 'claimed')
      return c.json({ listing_id: listing.id, status: listing.world_state, city_phase: cityRecord.value.phase })
    if (!checkout) return err(c, 409, 'claimed city offer has no valid market checkout')
    const reservedAt = new Date(cityRecord.value.reserved_at ?? '')
    const reservedUntil = new Date(cityRecord.value.reserved_until ?? '')
    const checkoutExpiry = new Date(checkout.expires_at)
    if (Number.isNaN(reservedAt.getTime()) || Number.isNaN(reservedUntil.getTime()) ||
        Number.isNaN(checkoutExpiry.getTime()) || reservedAt > checkoutExpiry || reservedUntil <= reservedAt)
      return err(c, 409, 'city reservation did not begin within the market checkout window')
    const claimedAt = new Date(cityRecord.value.claimed_at ?? '')
    if (Number.isNaN(claimedAt.getTime())) return err(c, 409, 'claimed city offer has no valid claimed_at')
    if (listing.removed) {
      const removedAt = new Date(listing.removed_at ?? '')
      if (Number.isNaN(removedAt.getTime()) || reservedAt > removedAt)
        return err(c, 409, 'market listing was removed before the city reservation began')
    }
    if (listing.withdrawn) {
      const withdrawnAt = new Date(listing.withdrawn_at ?? '')
      if (Number.isNaN(withdrawnAt.getTime()) || reservedAt > withdrawnAt)
        return err(c, 409, 'market listing was withdrawn before the city reservation began')
    }

    const evidence = receiptFields(cityRecord.value)
    if (!evidence.txHash || !WALLET_RE.test(evidence.buyerWallet) || !WALLET_RE.test(evidence.paymentFrom) ||
        !WALLET_RE.test(evidence.paymentTo) ||
        evidence.paymentFrom.toLowerCase() !== evidence.buyerWallet.toLowerCase() ||
        evidence.paymentTo.toLowerCase() !== listing.seller_wallet.toLowerCase() ||
        !['x402', 'claim'].includes(evidence.via) || Number.isNaN(new Date(evidence.blockTime).getTime()))
      return err(c, 409, 'claimed city offer has incomplete or mismatched public payment evidence')
    const paymentAt = new Date(evidence.blockTime)
    if (paymentAt < reservedAt || paymentAt > reservedUntil)
      return err(c, 409, 'city payment evidence falls outside the city reservation window')

    const receipt = {
      city_origin: CITY_ORIGIN,
      city_offer_id: listing.world_offer_id,
      city_asset_id: listing.world_asset_id,
      city_handle: checkout.city_handle,
      market_buyer: checkout.market_buyer,
      buyer_wallet: evidence.buyerWallet,
      city_verified_via: evidence.via,
      city_block_time: evidence.blockTime,
      payment_from: evidence.paymentFrom.toLowerCase(),
      payment_to: evidence.paymentTo.toLowerCase(),
      city_receipt_url: cityOfferUrl(listing.world_offer_id),
    }
    try {
      const rows = (await sql`
        WITH locked_sale AS (
          SELECT l.id, l.world_draft_id, c.id AS checkout_id, c.merchant_id
          FROM listings l JOIN world_checkouts c ON c.id = ${checkout.id} AND c.listing_id = l.id
          WHERE l.id = ${listing.id} AND l.delivery_kind = 'city_ownership'
            AND (NOT l.removed OR ${reservedAt.toISOString()}::timestamptz <= l.removed_at)
            AND (NOT l.withdrawn OR ${reservedAt.toISOString()}::timestamptz <= l.withdrawn_at)
            AND c.city_handle = ${checkout.city_handle} AND c.status IN ('active','expired')
          FOR UPDATE OF l, c
        ), new_purchase AS (
          INSERT INTO purchases (
            listing_id, merchant_id, amount_usdc, tx_hash, verified_via,
            world_checkout_id, world_receipt
          )
          SELECT id, merchant_id, ${listing.price_usdc}, ${evidence.txHash}, 'world',
            checkout_id, ${JSON.stringify(receipt)}::jsonb
          FROM locked_sale
          RETURNING id, listing_id, merchant_id, amount_usdc, tx_hash,
            world_checkout_id, world_receipt, created_at
        ), sold_listing AS (
          UPDATE listings SET world_state = 'sold', sales = sales + 1
          WHERE id IN (SELECT listing_id FROM new_purchase)
        ), sold_draft AS (
          UPDATE world_drafts SET state = 'sold'
          WHERE id IN (SELECT world_draft_id FROM locked_sale)
            AND EXISTS (SELECT 1 FROM new_purchase)
        ), completed_checkout AS (
          UPDATE world_checkouts SET status = 'completed', completed_at = now()
          WHERE id IN (SELECT world_checkout_id FROM new_purchase)
        ), new_event AS (
          INSERT INTO events (kind, actor, detail)
          SELECT 'world_sale', ${listing.market_seller}, jsonb_build_object(
            'listing_id', p.listing_id, 'amount_usdc', p.amount_usdc,
            'via', 'world', 'city_offer_id', ${listing.world_offer_id},
            'world_checkout_id', p.world_checkout_id
          ) FROM new_purchase p
        )
        SELECT id AS purchase_id, listing_id, world_checkout_id,
          amount_usdc::float8 AS amount_usdc, tx_hash, world_receipt, created_at
        FROM new_purchase`) as WorldPurchaseRow[]
      if (!rows.length) {
        const raced = await priorWorldPurchase(listing.id)
        if (raced) return c.json({ receipt: receiptEnvelope(raced) })
        return err(c, 409, 'world listing or checkout changed before the receipt could be recorded')
      }
      return c.json({ receipt: receiptEnvelope(rows[0]!) })
    } catch (error) {
      if (postgresErrorCode(error) !== '23505') throw error
      const raced = await priorWorldPurchase(listing.id)
      if (raced) return c.json({ receipt: receiptEnvelope(raced) })
      return err(c, 409, 'city payment transaction was already used by the market')
    }
  })
}
