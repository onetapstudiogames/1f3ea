import type { Hono } from 'hono'
import { toUnits } from './chain.ts'
import { auth, err, WALLET_RE } from './core.ts'
import { sql } from './db.ts'
import { canonicalTxHash, paymentReadinessResponse } from './pay.ts'
import { postgresErrorDetails } from './postgres-error.ts'
import {
  readWorldPaymentAttemptForListing,
  reserveWorldPaymentAttempt,
  type WorldPaymentAttempt,
  type WorldPaymentTerms,
} from './world-payment-attempts.ts'
import {
  priorWorldPurchase,
  reviewWorldPaymentAttempt,
  settleWorldPaymentAttempt,
  worldReceiptEnvelope,
} from './world-payment-sync.ts'
import { dateIsPast, positiveId, upstreamStatus } from './world-route-shared.ts'
import {
  cityCancelUrl,
  cityClaimUrl,
  cityOfferMatchesListing,
  cityOfferUrl,
  fetchCityOffer,
  fetchCityResident,
  isCityOfferAvailable,
  validWorldCheckout,
  type CityOffer,
  type CityOfferPhase,
  type ListingBinding,
} from './world.ts'

interface WorldCheckoutRouteConfig {
  marketOrigin: string
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

type CityNoSalePhase = Extract<
  CityOfferPhase,
  'payment_invalid' | 'payment_expired' | 'founder_review'
>

interface CityNoSaleOutcome {
  phase: CityNoSalePhase
  withdrawnReason: string
  error: string
}

function cityNoSaleOutcome(phase: CityOfferPhase): CityNoSaleOutcome | null {
  switch (phase) {
    case 'payment_invalid':
      return {
        phase,
        withdrawnReason: 'city payment invalid',
        error: 'the city rejected this checkout payment; no market sale was recorded; do not pay again',
      }
    case 'payment_expired':
      return {
        phase,
        withdrawnReason: 'city payment expired',
        error: "the city's automatic payment recovery window ended without an ownership transfer; no market sale was recorded; do not pay again",
      }
    case 'founder_review':
      return {
        phase,
        withdrawnReason: 'city founder review',
        error: "the city retained this checkout's payment evidence for founder review; ownership did not transfer and no market sale was recorded; do not pay again",
      }
    default:
      return null
  }
}

function checkoutEnvelope(row: WorldCheckoutRow) {
  const status = row.status === 'active' && dateIsPast(row.expires_at) ? 'expired' as const : row.status
  return {
    id: Number(row.id),
    status,
    listing_id: Number(row.listing_id),
    world_offer_id: Number(row.world_offer_id),
    market_draft_id: Number(row.market_draft_id),
    market_buyer: row.market_buyer,
    city_handle: row.city_handle,
    expires_at: row.expires_at,
    created_at: row.created_at,
  }
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

function sameInstant(stored: string, expected: Date): boolean {
  const parsed = new Date(stored)
  return !Number.isNaN(parsed.getTime()) && parsed.getTime() === expected.getTime()
}

function attemptMatchesTerms(attempt: WorldPaymentAttempt, terms: WorldPaymentTerms): boolean {
  let amountMatches = false
  try { amountMatches = BigInt(attempt.amount_units) === terms.amountUnits } catch { /* malformed row */ }
  return attempt.world_checkout_id === terms.checkoutId && attempt.listing_id === terms.listingId &&
    attempt.merchant_id === terms.merchantId &&
    attempt.tx_hash.toLowerCase() === terms.txHash.toLowerCase() &&
    attempt.payer_wallet.toLowerCase() === terms.payerWallet.toLowerCase() &&
    attempt.payee_wallet.toLowerCase() === terms.payeeWallet.toLowerCase() && amountMatches &&
    sameInstant(attempt.start_time, terms.startTime) && sameInstant(attempt.end_time, terms.endTime) &&
    sameInstant(attempt.city_block_time, terms.cityBlockTime) && attempt.verified_via === terms.verifiedVia
}

function preservedAttemptMatchesCheckout(
  attempt: WorldPaymentAttempt,
  listing: WorldListingRow,
  checkout: WorldCheckoutRow,
): boolean {
  let amountMatches = false
  try { amountMatches = BigInt(attempt.amount_units) === toUnits(listing.price_usdc) } catch { /* malformed row */ }
  const start = new Date(attempt.start_time)
  const end = new Date(attempt.end_time)
  const blockTime = new Date(attempt.city_block_time)
  const checkoutCreatedAt = new Date(checkout.created_at)
  const checkoutExpiry = new Date(checkout.expires_at)
  const timesAreValid = ![start, end, blockTime, checkoutCreatedAt, checkoutExpiry]
    .some(value => Number.isNaN(value.getTime()))
  return timesAreValid
    && attempt.world_checkout_id === checkout.id
    && attempt.listing_id === listing.id
    && attempt.merchant_id === checkout.merchant_id
    && checkout.listing_id === listing.id
    && checkout.market_draft_id === listing.world_draft_id
    && checkout.world_offer_id === listing.world_offer_id
    && WALLET_RE.test(attempt.payer_wallet)
    && WALLET_RE.test(attempt.payee_wallet)
    && attempt.payee_wallet.toLowerCase() === listing.seller_wallet.toLowerCase()
    && amountMatches
    && start < end
    && start.getTime() >= checkoutCreatedAt.getTime() - 60_000
    && start < checkoutExpiry
    && blockTime >= start
    && blockTime < end
    && ['x402', 'claim'].includes(attempt.verified_via)
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

export function registerWorldCheckoutRoutes(app: Hono, config: WorldCheckoutRouteConfig) {
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
      const details = postgresErrorDetails(error)
      if (details.code === '23505' && details.constraint === 'world_checkouts_one_active_per_buyer')
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

    const syncRefusal = (error: string, status: 409 | 503 = 409) => {
      if (status === 503) c.header('Retry-After', '1')
      return c.json({
        error,
        retry: 'retry this same sync request; do not make another payment',
        do_not_pay_again: true,
      }, status)
    }

    let prior
    try {
      prior = await priorWorldPurchase(listingId)
    } catch (error) {
      console.error('world purchase replay could not be checked', error)
      return syncRefusal(
        'the market could not confirm whether this paid checkout already completed; retry this same sync request; do not make another payment',
        503,
      )
    }
    if (prior) return c.json({ receipt: worldReceiptEnvelope(prior) })
    let listing: WorldListingRow | null
    try {
      listing = await readWorldListing(listingId)
    } catch (error) {
      console.error('world listing could not be read during payment sync', error)
      return syncRefusal(
        'the market could not confirm this paid checkout listing; retry this same sync request; do not make another payment',
        503,
      )
    }
    if (!listing) return err(c, 404, 'no such listing')
    if (listing.delivery_kind !== 'city_ownership') return err(c, 409, 'not a world listing')

    let preservedAttempt: WorldPaymentAttempt | null
    try {
      preservedAttempt = await readWorldPaymentAttemptForListing(listing.id)
    } catch (error) {
      console.error('world payment attempt could not be read during sync', error)
      return syncRefusal(
        'the market could not confirm this paid checkout state; retry this same sync request; do not make another payment',
        503,
      )
    }
    const unavailable = paymentReadinessResponse(c)
    if (unavailable) {
      return preservedAttempt
        ? syncRefusal(
            'the market cannot finish this recorded paid checkout right now',
            503,
          )
        : syncRefusal(
            'the market cannot check this world checkout payment right now',
            503,
          )
    }
    if (preservedAttempt) {
      let preservedCheckout: WorldCheckoutRow | null
      try {
        preservedCheckout = await readCheckout(preservedAttempt.world_checkout_id)
      } catch (error) {
        console.error('preserved world checkout could not be read during sync', error)
        return syncRefusal(
          'the market could not confirm this paid checkout binding; retry this same sync request; do not make another payment',
          503,
        )
      }
      if (!preservedCheckout || preservedCheckout.listing_id !== listing.id) {
        return reviewWorldPaymentAttempt(
          c, listing.id, preservedAttempt.world_checkout_id,
          'stored market checkout is unavailable for this payment',
          'the paid checkout record is unavailable; no market sale was recorded; do not pay again',
        )
      }
      if (
        preservedAttempt.status === 'payment_pending'
        && !preservedAttemptMatchesCheckout(preservedAttempt, listing, preservedCheckout)
      ) {
        return reviewWorldPaymentAttempt(
          c, listing.id, preservedAttempt.world_checkout_id,
          'stored payment terms no longer exactly match the market listing and checkout',
          'stored payment terms do not match this checkout; no market sale was recorded; do not pay again',
        )
      }
      return settleWorldPaymentAttempt(c, listing, preservedCheckout, preservedAttempt)
    }

    const cityRecord = await fetchCityOffer(listing.world_offer_id)
    if (!cityRecord.ok) return syncRefusal(cityRecord.message, upstreamStatus(cityRecord))
    const mismatch = cityOfferMatchesListing(cityRecord.value, listing, config.marketOrigin)
    if (mismatch) return syncRefusal(mismatch)

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
    const checkoutBoundPhases: CityOfferPhase[] = [
      'reserved',
      'payment_pending',
      'payment_invalid',
      'payment_expired',
      'founder_review',
      'claimed',
    ]
    let checkout: WorldCheckoutRow | null = null
    if (checkoutBoundPhases.includes(cityRecord.value.phase)) {
      if (cityRecord.value.market_listing_id !== listing.id)
        return syncRefusal('city offer is not bound to this market listing')
      const checkoutId = cityRecord.value.market_checkout_id
      if (!checkoutId) return syncRefusal('city offer has no market checkout binding')
      try {
        checkout = await readCheckout(checkoutId)
      } catch (error) {
        console.error('claimed world checkout binding could not be read', error)
        return syncRefusal(
          'the market could not confirm this paid checkout binding; retry this same sync request; do not make another payment',
          503,
        )
      }
      if (!checkout || checkout.listing_id !== listing.id ||
          checkout.market_draft_id !== listing.world_draft_id ||
          checkout.world_offer_id !== listing.world_offer_id)
        return syncRefusal('city offer points to a checkout for different terms')
      if (cityRecord.value.buyer !== checkout.city_handle)
        return syncRefusal('city buyer does not match the market checkout')
      if (cityRecord.value.market_buyer !== checkout.market_buyer)
        return syncRefusal('city market buyer does not match the market checkout')
    }

    const noSaleOutcome = cityNoSaleOutcome(cityRecord.value.phase)
    if (noSaleOutcome) {
      const rows = await sql`
        WITH terminal_payment_listing AS (
          UPDATE listings SET world_state = 'stale', withdrawn = TRUE,
            withdrawn_at = coalesce(withdrawn_at, now()), withdrawn_reason = ${noSaleOutcome.withdrawnReason}
          WHERE id = ${listing.id} AND delivery_kind = 'city_ownership'
            AND world_state = 'active' AND NOT removed
          RETURNING id, world_draft_id
        ), terminal_payment_draft AS (
          UPDATE world_drafts draft SET state = 'canceled',
            canceled_at = coalesce(draft.canceled_at, now()),
            canceled_reason = coalesce(draft.canceled_reason, ${noSaleOutcome.withdrawnReason})
          FROM terminal_payment_listing listing
          WHERE draft.id = listing.world_draft_id AND draft.state <> 'sold'
            AND (draft.state <> 'canceled' OR draft.canceled_at IS NULL OR draft.canceled_reason IS NULL)
        ), expired_checkouts AS (
          UPDATE world_checkouts checkout SET status = 'expired'
          WHERE checkout.listing_id IN (SELECT id FROM terminal_payment_listing)
            AND checkout.status = 'active'
        ), new_event AS (
          INSERT INTO events (kind, actor, detail)
          SELECT 'world_canceled', ${listing.market_seller}, jsonb_build_object(
            'listing_id', id, 'city_offer_id', ${listing.world_offer_id}::integer,
            'reason', ${noSaleOutcome.withdrawnReason}::text
          ) FROM terminal_payment_listing
        )
        SELECT id FROM terminal_payment_listing`
      const status = rows.length ? 'stale' : (await readWorldListing(listing.id))?.world_state ?? 'stale'
      return c.json({
        listing_id: listing.id,
        status,
        city_phase: noSaleOutcome.phase,
        city_unlock_required: true,
        city_cancel_url: cityCancelUrl(listing.world_offer_id),
        do_not_pay_again: true,
        error: noSaleOutcome.error,
        retry: 'city seller: authenticate to the city and POST {} to city_cancel_url to cancel the offer and unlock the thing; do not make another payment',
      })
    }
    if (cityRecord.value.phase !== 'claimed') return c.json({
      listing_id: listing.id,
      status: listing.world_state,
      city_phase: cityRecord.value.phase,
      ...(cityRecord.value.phase === 'payment_pending' ? {
        do_not_pay_again: true,
        retry: 'retry this same sync request; the market will reconcile the recorded city payment; do not make another payment',
      } : {}),
    })
    if (!checkout) return syncRefusal('claimed city offer has no valid market checkout')
    const reservedAt = new Date(cityRecord.value.reserved_at ?? '')
    const reservedUntil = new Date(cityRecord.value.reserved_until ?? '')
    const checkoutCreatedAt = new Date(checkout.created_at)
    const checkoutExpiry = new Date(checkout.expires_at)
    if (Number.isNaN(reservedAt.getTime()) || Number.isNaN(reservedUntil.getTime()) ||
        Number.isNaN(checkoutCreatedAt.getTime()) || Number.isNaN(checkoutExpiry.getTime()) ||
        reservedAt >= checkoutExpiry || reservedUntil <= reservedAt)
      return syncRefusal('city reservation did not begin within the market checkout window')
    if (reservedAt.getTime() < checkoutCreatedAt.getTime() - 60_000)
      return syncRefusal('city reservation began too far before the market checkout was created; no market sale was recorded; do not pay again')
    const claimedAt = new Date(cityRecord.value.claimed_at ?? '')
    if (Number.isNaN(claimedAt.getTime())) return syncRefusal('claimed city offer has no valid claimed_at')
    if (listing.removed) {
      const removedAt = new Date(listing.removed_at ?? '')
      if (Number.isNaN(removedAt.getTime()) || reservedAt > removedAt)
        return syncRefusal('market listing was removed before the city reservation began')
    }
    if (listing.withdrawn) {
      const withdrawnAt = new Date(listing.withdrawn_at ?? '')
      if (Number.isNaN(withdrawnAt.getTime()) || reservedAt > withdrawnAt)
        return syncRefusal('market listing was withdrawn before the city reservation began')
    }

    const evidence = receiptFields(cityRecord.value)
    if (!evidence.txHash || !WALLET_RE.test(evidence.buyerWallet) || !WALLET_RE.test(evidence.paymentFrom) ||
        !WALLET_RE.test(evidence.paymentTo) ||
        evidence.paymentFrom.toLowerCase() !== evidence.buyerWallet.toLowerCase() ||
        evidence.paymentTo.toLowerCase() !== listing.seller_wallet.toLowerCase() ||
        !['x402', 'claim'].includes(evidence.via) || Number.isNaN(new Date(evidence.blockTime).getTime()))
      return syncRefusal('claimed city offer has incomplete or mismatched public payment evidence')
    const paymentAt = new Date(evidence.blockTime)
    if (paymentAt < reservedAt || paymentAt >= reservedUntil)
      return syncRefusal('city payment evidence falls outside the city reservation window')

    const paymentTerms: WorldPaymentTerms = {
      checkoutId: checkout.id,
      listingId: listing.id,
      merchantId: checkout.merchant_id,
      txHash: evidence.txHash,
      payerWallet: evidence.paymentFrom,
      payeeWallet: evidence.paymentTo,
      amountUnits: toUnits(listing.price_usdc),
      startTime: reservedAt,
      endTime: reservedUntil,
      cityBlockTime: paymentAt,
      verifiedVia: evidence.via as 'x402' | 'claim',
    }
    let attempt: WorldPaymentAttempt
    try {
      attempt = await reserveWorldPaymentAttempt(paymentTerms)
    } catch (error) {
      console.error('world payment attempt could not be confirmed after its city payment', error)
      return syncRefusal(
        'the market could not preserve this paid checkout; retry this same sync request; do not make another payment',
        503,
      )
    }
    if (!attemptMatchesTerms(attempt, paymentTerms)) {
      return reviewWorldPaymentAttempt(
        c, listing.id, attempt.world_checkout_id,
        'city public payment evidence changed after the first listing payment was stored',
        'city payment evidence conflicts with the first payment stored for this listing; no market sale was recorded; do not pay again',
      )
    }
    return settleWorldPaymentAttempt(c, listing, checkout, attempt)
  })
}
