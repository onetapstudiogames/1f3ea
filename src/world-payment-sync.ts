import type { Context } from 'hono'
import {
  classifyUsdcTransfer,
  type FinalityEvidence,
  type VerifiedTransfer,
} from './chain.ts'
import { HANDLE_RE, WALLET_RE } from './core.ts'
import { sql } from './db.ts'
import { canonicalTxHash } from './pay.ts'
import { postgresErrorDetails } from './postgres-error.ts'
import {
  markWorldPaymentNeedsReview,
  type WorldPaymentAttempt,
} from './world-payment-attempts.ts'
import { CITY_ORIGIN, cityOfferUrl } from './world.ts'

export interface WorldPaymentListing {
  id: number
  market_seller: string
  price_usdc: number
  seller_wallet: string
  world_offer_id: number
  world_asset_id: number
  world_draft_id: number
}

export interface WorldPaymentCheckout {
  id: number
  listing_id: number
  merchant_id: number
  market_buyer: string
  city_handle: string
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

function parseReceipt(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    } catch { /* validation below reports one safe internal failure */ }
  }
  return null
}

export function requireValidWorldReceipt(value: unknown): Record<string, unknown> {
  const receipt = parseReceipt(value)
  const offerId = receipt?.city_offer_id
  const assetId = receipt?.city_asset_id
  const cityHandle = receipt?.city_handle
  const marketBuyer = receipt?.market_buyer
  const buyerWallet = receipt?.buyer_wallet
  const verifiedVia = receipt?.city_verified_via
  const blockTime = receipt?.city_block_time
  const paymentFrom = receipt?.payment_from
  const paymentTo = receipt?.payment_to
  const receiptUrl = receipt?.city_receipt_url
  if (!receipt || receipt.city_origin !== CITY_ORIGIN ||
      !Number.isSafeInteger(offerId) || Number(offerId) <= 0 ||
      !Number.isSafeInteger(assetId) || Number(assetId) <= 0 ||
      typeof cityHandle !== 'string' || !HANDLE_RE.test(cityHandle) ||
      typeof marketBuyer !== 'string' || !HANDLE_RE.test(marketBuyer) ||
      typeof buyerWallet !== 'string' || !WALLET_RE.test(buyerWallet) ||
      !['x402', 'claim'].includes(String(verifiedVia)) ||
      typeof blockTime !== 'string' || Number.isNaN(new Date(blockTime).getTime()) ||
      typeof paymentFrom !== 'string' || !WALLET_RE.test(paymentFrom) ||
      paymentFrom.toLowerCase() !== buyerWallet.toLowerCase() ||
      typeof paymentTo !== 'string' || !WALLET_RE.test(paymentTo) ||
      receiptUrl !== cityOfferUrl(Number(offerId)))
    throw new Error('stored world purchase receipt is incomplete or invalid')
  return receipt
}

export function worldReceiptEnvelope(row: WorldPurchaseRow) {
  const city = requireValidWorldReceipt(row.world_receipt)
  const purchaseId = Number(row.purchase_id)
  const listingId = Number(row.listing_id)
  const checkoutId = Number(row.world_checkout_id)
  const amount = Number(row.amount_usdc)
  const txHash = canonicalTxHash(row.tx_hash)
  if (![purchaseId, listingId, checkoutId].every(id => Number.isSafeInteger(id) && id > 0) ||
      !Number.isFinite(amount) || amount < 0 || !txHash || Number.isNaN(new Date(row.created_at).getTime()))
    throw new Error('stored world purchase row is incomplete or invalid')
  return {
    purchase_id: purchaseId,
    listing_id: listingId,
    checkout_id: checkoutId,
    delivery_kind: 'city_ownership' as const,
    city_origin: CITY_ORIGIN,
    city_offer_id: Number(city.city_offer_id),
    city_asset_id: Number(city.city_asset_id),
    city_handle: String(city.city_handle ?? ''),
    amount_usdc: amount,
    tx_hash: txHash,
    verified_via: 'world' as const,
    city_verified_via: String(city.city_verified_via ?? ''),
    city_receipt_url: cityOfferUrl(Number(city.city_offer_id)),
    created_at: row.created_at,
  }
}

export async function priorWorldPurchase(listingId: number): Promise<WorldPurchaseRow | null> {
  const rows = (await sql`
    SELECT p.id AS purchase_id, p.listing_id, p.world_checkout_id,
      p.amount_usdc::float8 AS amount_usdc, p.tx_hash, p.world_receipt, p.created_at
    FROM purchases p WHERE p.listing_id = ${listingId} AND p.verified_via = 'world'
    LIMIT 1`) as WorldPurchaseRow[]
  return rows[0] ?? null
}

function transferMatchesStoredWindow(transfer: VerifiedTransfer, attempt: WorldPaymentAttempt): boolean {
  const start = new Date(attempt.start_time)
  const end = new Date(attempt.end_time)
  const cityBlockTime = new Date(attempt.city_block_time)
  return ![start, end, cityBlockTime].some(value => Number.isNaN(value.getTime())) &&
    transfer.blockTime >= start && transfer.blockTime < end &&
    transfer.blockTime.getTime() === cityBlockTime.getTime()
}

function stableReview(c: Context, listingId: number, error: string) {
  return c.json({
    listing_id: listingId,
    status: 'needs_review',
    do_not_pay_again: true,
    error,
    retry: 'repeating this same sync only rereads the preserved review state; do not make another payment',
  }, 409)
}

function uncertainCompletion(c: Context) {
  c.header('Retry-After', '1')
  return c.json({
    error: 'the market could not confirm whether this paid checkout was recorded; retry this same sync request; do not make another payment',
    retry: 'retry this same sync request',
    do_not_pay_again: true,
  }, 503)
}

function uncertainReview(c: Context) {
  c.header('Retry-After', '1')
  return c.json({
    error: 'the market could not confirm this paid checkout review; retry this same sync request; do not make another payment',
    retry: 'retry this same sync request',
    do_not_pay_again: true,
  }, 503)
}

async function missingCompletedReceipt(c: Context, listingId: number) {
  const raced = await priorWorldPurchase(listingId)
  if (raced) return c.json({ receipt: worldReceiptEnvelope(raced) })
  return c.json({
    listing_id: listingId,
    status: 'completed',
    do_not_pay_again: true,
    error: 'payment completion is recorded but its market receipt is unavailable; retry this same sync request',
  }, 503)
}

export async function reviewWorldPaymentAttempt(
  c: Context,
  listingId: number,
  attemptId: number,
  reason: string,
  error: string,
  finality?: FinalityEvidence,
) {
  try {
    const reviewed = await markWorldPaymentNeedsReview(attemptId, reason, finality)
    if (reviewed?.status === 'completed') return missingCompletedReceipt(c, listingId)
    if (reviewed?.status === 'needs_review') return stableReview(c, listingId, error)
    console.error('world payment review returned no confirmed terminal state')
    return uncertainReview(c)
  } catch (reviewError) {
    console.error('world payment review state could not be confirmed', reviewError)
    return uncertainReview(c)
  }
}

export async function settleWorldPaymentAttempt(
  c: Context,
  listing: WorldPaymentListing,
  checkout: WorldPaymentCheckout,
  attempt: WorldPaymentAttempt,
) {
  if (attempt.status === 'needs_review')
    return stableReview(c, listing.id, 'this payment needs review; no market sale was recorded; do not pay again')
  if (attempt.status === 'completed') return missingCompletedReceipt(c, listing.id)

  const checked = await classifyUsdcTransfer(
    attempt.tx_hash,
    attempt.payee_wallet,
    BigInt(attempt.amount_units),
    { expectedFrom: attempt.payer_wallet, exactAmount: true },
  )
  if (checked.state === 'unavailable') {
    c.header('Retry-After', '1')
    return c.json({
      listing_id: listing.id,
      status: 'payment_pending',
      do_not_pay_again: true,
      error: 'Base finality check is temporarily unavailable; retry this same sync request; do not make another payment',
    }, 503)
  }
  if (checked.state === 'pending' || checked.state === 'matched_pending') {
    return c.json({
      listing_id: listing.id,
      status: 'payment_pending',
      do_not_pay_again: true,
      retry: 'retry this same sync request after Base finality; do not make another payment',
    }, 202)
  }
  if (checked.state === 'invalid_final' || !transferMatchesStoredWindow(checked, attempt)) {
    const reason = checked.state === 'invalid_final'
      ? `finalized Base transaction ${checked.reason.replaceAll('_', ' ')}`
      : 'finalized Base block time conflicts with the stored city payment window'
    return reviewWorldPaymentAttempt(
      c, listing.id, attempt.world_checkout_id, reason,
      'finalized Base payment evidence conflicts with this checkout; no market sale was recorded; do not pay again',
      checked,
    )
  }

  const receipt = {
    city_origin: CITY_ORIGIN,
    city_offer_id: listing.world_offer_id,
    city_asset_id: listing.world_asset_id,
    city_handle: checkout.city_handle,
    market_buyer: checkout.market_buyer,
    buyer_wallet: attempt.payer_wallet,
    city_verified_via: attempt.verified_via,
    city_block_time: attempt.city_block_time,
    payment_from: attempt.payer_wallet,
    payment_to: attempt.payee_wallet,
    city_receipt_url: cityOfferUrl(listing.world_offer_id),
  }
  try {
    const rows = (await sql`
      WITH locked_sale AS (
        SELECT l.id, l.world_draft_id, c.id AS checkout_id, c.merchant_id
        FROM listings l JOIN world_checkouts c ON c.id = ${checkout.id} AND c.listing_id = l.id
        WHERE l.id = ${listing.id} AND l.delivery_kind = 'city_ownership'
          AND (NOT l.removed OR ${attempt.start_time}::timestamptz <= l.removed_at)
          AND (NOT l.withdrawn OR ${attempt.start_time}::timestamptz <= l.withdrawn_at)
          AND c.city_handle = ${checkout.city_handle} AND c.status IN ('active','expired')
        FOR UPDATE OF l, c
      ), completed_attempt AS (
        UPDATE world_payment_attempts a SET
          status = 'completed',
          finalized_block_number = ${checked.blockNumber.toString()},
          finalized_block_hash = ${checked.blockHash},
          finalized_block_time = ${checked.blockTime.toISOString()},
          finalized_at = ${checked.finalizedAt.toISOString()},
          completed_at = now(), updated_at = now()
        FROM locked_sale s
        WHERE a.world_checkout_id = s.checkout_id AND a.status = 'payment_pending'
          AND a.tx_hash = ${attempt.tx_hash}
          AND a.payer_wallet = ${attempt.payer_wallet}
          AND a.payee_wallet = ${attempt.payee_wallet}
          AND a.amount_units = ${attempt.amount_units}
          AND ${checked.blockTime.toISOString()}::timestamptz >= a.start_time
          AND ${checked.blockTime.toISOString()}::timestamptz < a.end_time
        RETURNING a.world_checkout_id
      ), new_purchase AS (
        INSERT INTO purchases (
          listing_id, merchant_id, amount_usdc, tx_hash, verified_via,
          world_checkout_id, world_payment_attempt_id, world_receipt
        )
        SELECT id, merchant_id, ${listing.price_usdc}, ${attempt.tx_hash}, 'world',
          checkout_id, checkout_id, ${JSON.stringify(receipt)}::jsonb
        FROM locked_sale JOIN completed_attempt a ON a.world_checkout_id = checkout_id
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
          'via', 'world', 'city_offer_id', ${listing.world_offer_id}::int,
          'world_checkout_id', p.world_checkout_id
        ) FROM new_purchase p
      )
      SELECT id AS purchase_id, listing_id, world_checkout_id,
        amount_usdc::float8 AS amount_usdc, tx_hash, world_receipt, created_at
      FROM new_purchase`) as WorldPurchaseRow[]
    if (rows[0]) return c.json({ receipt: worldReceiptEnvelope(rows[0]) })
    const raced = await priorWorldPurchase(listing.id)
    if (raced) return c.json({ receipt: worldReceiptEnvelope(raced) })
    return reviewWorldPaymentAttempt(
      c, listing.id, attempt.world_checkout_id,
      'market listing or checkout changed after finality',
      'the paid checkout changed before its receipt could be recorded; no market sale was recorded; do not pay again',
      checked,
    )
  } catch (error) {
    const details = postgresErrorDetails(error)
    const expected = [
      'purchases_listing_id_merchant_id_key',
      'purchases_world_checkout_unique',
      'purchases_tx_hash_key',
      'purchases_tx_hash_lower_unique',
      'payment_uses_pkey',
    ]
    let raced: WorldPurchaseRow | null = null
    try {
      raced = await priorWorldPurchase(listing.id)
    } catch (readError) {
      console.error('world payment completion recovery read failed', readError)
    }
    if (raced) return c.json({ receipt: worldReceiptEnvelope(raced) })
    if (details.code === '23505' && expected.includes(details.constraint ?? '')) {
      try {
        return await reviewWorldPaymentAttempt(
          c, listing.id, attempt.world_checkout_id,
          `market completion conflict ${details.constraint}`,
          'the market already has conflicting payment history; no market sale was recorded; do not pay again',
          checked,
        )
      } catch (reviewError) {
        console.error('world payment completion conflict could not be preserved for review', reviewError)
        return uncertainCompletion(c)
      }
    }
    console.error('world payment completion failed after its payment was preserved', error)
    return uncertainCompletion(c)
  }
}
