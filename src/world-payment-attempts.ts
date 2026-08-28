import { sql } from './db.ts'
import { postgresErrorDetails } from './postgres-error.ts'
import type { FinalityEvidence } from './chain.ts'

export type WorldPaymentAttemptState = 'payment_pending' | 'completed' | 'needs_review'

export interface WorldPaymentAttempt {
  world_checkout_id: number
  listing_id: number
  merchant_id: number
  tx_hash: string
  payer_wallet: string
  payee_wallet: string
  amount_units: string
  start_time: string
  end_time: string
  city_block_time: string
  verified_via: 'x402' | 'claim'
  status: WorldPaymentAttemptState
  finalized_block_number: string | null
  finalized_block_hash: string | null
  finalized_block_time: string | null
  finalized_at: string | null
  review_reason: string | null
}

export interface WorldPaymentTerms {
  checkoutId: number
  listingId: number
  merchantId: number
  txHash: string
  payerWallet: string
  payeeWallet: string
  amountUnits: bigint
  startTime: Date
  endTime: Date
  cityBlockTime: Date
  verifiedVia: 'x402' | 'claim'
}

export async function readWorldPaymentAttempt(checkoutId: number): Promise<WorldPaymentAttempt | null> {
  const rows = (await sql`
    /* world-payment-attempt:read */
    SELECT world_checkout_id, listing_id, merchant_id, tx_hash, payer_wallet, payee_wallet,
      amount_units::text AS amount_units, start_time, end_time, city_block_time, verified_via,
      status, finalized_block_number::text AS finalized_block_number,
      finalized_block_hash, finalized_block_time, finalized_at, review_reason
    FROM world_payment_attempts
    WHERE world_checkout_id = ${checkoutId}`) as WorldPaymentAttempt[]
  return rows[0] ?? null
}

export async function readWorldPaymentAttemptForListing(
  listingId: number,
): Promise<WorldPaymentAttempt | null> {
  const rows = (await sql`
    /* world-payment-attempt:read-listing */
    SELECT world_checkout_id, listing_id, merchant_id, tx_hash, payer_wallet, payee_wallet,
      amount_units::text AS amount_units, start_time, end_time, city_block_time, verified_via,
      status, finalized_block_number::text AS finalized_block_number,
      finalized_block_hash, finalized_block_time, finalized_at, review_reason
    FROM world_payment_attempts
    WHERE listing_id = ${listingId}`) as WorldPaymentAttempt[]
  return rows[0] ?? null
}

/** Store payment evidence before any chain call so every retry keeps one tx. */
export async function reserveWorldPaymentAttempt(
  terms: WorldPaymentTerms,
): Promise<WorldPaymentAttempt> {
  const existing = await readWorldPaymentAttempt(terms.checkoutId)
  if (existing) return existing

  try {
    const rows = (await sql`
      /* world-payment-attempt:reserve */
      INSERT INTO world_payment_attempts (
        world_checkout_id, listing_id, merchant_id, tx_hash, payer_wallet, payee_wallet,
        amount_units, start_time, end_time, city_block_time, verified_via
      ) VALUES (
        ${terms.checkoutId}, ${terms.listingId}, ${terms.merchantId}, ${terms.txHash},
        ${terms.payerWallet.toLowerCase()}, ${terms.payeeWallet.toLowerCase()},
        ${terms.amountUnits.toString()}, ${terms.startTime.toISOString()},
        ${terms.endTime.toISOString()}, ${terms.cityBlockTime.toISOString()}, ${terms.verifiedVia}
      )
      RETURNING world_checkout_id, listing_id, merchant_id, tx_hash, payer_wallet, payee_wallet,
        amount_units::text AS amount_units, start_time, end_time, city_block_time, verified_via,
        status, finalized_block_number::text AS finalized_block_number,
        finalized_block_hash, finalized_block_time, finalized_at, review_reason`) as WorldPaymentAttempt[]
    const created = rows[0]
    if (!created) throw new Error('world payment attempt was not stored')
    return created
  } catch (error) {
    const details = postgresErrorDetails(error)
    if (details.code !== '23505') throw error
    if (details.constraint === 'world_payment_attempts_pkey') {
      const raced = await readWorldPaymentAttempt(terms.checkoutId)
      if (!raced) throw error
      return raced
    }
    if (details.constraint === 'world_payment_attempts_listing_owner_unique') {
      const owner = await readWorldPaymentAttemptForListing(terms.listingId)
      if (!owner) throw error
      return owner
    }
    if (!['payment_uses_pkey', 'world_payment_attempts_tx_owner_unique'].includes(details.constraint ?? ''))
      throw error
    const reviewRows = (await sql`
      /* world-payment-attempt:reserve-conflict */
      INSERT INTO world_payment_attempts (
        world_checkout_id, listing_id, merchant_id, tx_hash, payer_wallet, payee_wallet,
        amount_units, start_time, end_time, city_block_time, verified_via, status, review_reason
      ) VALUES (
        ${terms.checkoutId}, ${terms.listingId}, ${terms.merchantId}, ${terms.txHash},
        ${terms.payerWallet.toLowerCase()}, ${terms.payeeWallet.toLowerCase()},
        ${terms.amountUnits.toString()}, ${terms.startTime.toISOString()},
        ${terms.endTime.toISOString()}, ${terms.cityBlockTime.toISOString()}, ${terms.verifiedVia},
        'needs_review', 'transaction is already reserved by another market payment'
      )
      RETURNING world_checkout_id, listing_id, merchant_id, tx_hash, payer_wallet, payee_wallet,
        amount_units::text AS amount_units, start_time, end_time, city_block_time, verified_via,
        status, finalized_block_number::text AS finalized_block_number,
        finalized_block_hash, finalized_block_time, finalized_at, review_reason`) as WorldPaymentAttempt[]
    const review = reviewRows[0]
    if (!review) throw error
    return review
  }
}

export async function markWorldPaymentNeedsReview(
  checkoutId: number,
  reason: string,
  finality?: FinalityEvidence,
): Promise<WorldPaymentAttempt | null> {
  const rows = (await sql`
    /* world-payment-attempt:review */
    UPDATE world_payment_attempts
    SET status = 'needs_review', review_reason = ${reason},
      finalized_block_number = ${finality?.blockNumber.toString() ?? null},
      finalized_block_hash = ${finality?.blockHash ?? null},
      finalized_block_time = ${finality?.blockTime.toISOString() ?? null},
      finalized_at = ${finality?.finalizedAt.toISOString() ?? null},
      updated_at = now()
    WHERE world_checkout_id = ${checkoutId} AND status = 'payment_pending'
    RETURNING world_checkout_id, listing_id, merchant_id, tx_hash, payer_wallet, payee_wallet,
      amount_units::text AS amount_units, start_time, end_time, city_block_time, verified_via,
      status, finalized_block_number::text AS finalized_block_number,
      finalized_block_hash, finalized_block_time, finalized_at, review_reason`) as WorldPaymentAttempt[]
  return rows[0] ?? await readWorldPaymentAttempt(checkoutId)
}
