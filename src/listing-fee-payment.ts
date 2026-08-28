import { USDC, type FinalityEvidence } from './chain.ts'
import { sql } from './db.ts'
import { LISTING_FEE_USDC, TREASURY, canonicalTxHash, verifyDirectPayment } from './pay.ts'
import { postgresErrorDetails } from './postgres-error.ts'

const DIRECT_FEE_LOOKBACK_MS = 60 * 60 * 1000
const FEE_ATTEMPT_CONSTRAINTS = new Set([
  'listing_fee_attempts_tx_hash_key',
  'listing_fee_attempt_request_unique',
  'payment_uses_pkey',
])

export type ListingFeeRequestKind = 'artifact_listing' | 'world_listing'

export interface ListingFeeAttempt {
  id: number
  merchant_id: number
  listing_id: number | null
  tx_hash: string
  fee_request_kind: ListingFeeRequestKind
  fee_request_hash: string
  payer_wallet: string
  payee_wallet: string
  asset: string
  minimum_block_time: string
  maximum_block_time: string
  payment_status: 'payment_pending' | 'completed' | 'needs_review'
  finalized_block_number: string | null
  finalized_block_hash: string | null
  finalized_block_time: string | null
  finalized_at: string | null
  payment_review_reason: string | null
  world_draft_id: number | null
  world_offer_id: number | null
  world_seller_handle: string | null
}

type FeeResponse = {
  state: 'response'
  status: 202 | 402 | 409 | 503
  body: Record<string, unknown>
}

export type ListingFeeResolution =
  | FeeResponse
  | { state: 'completed'; listingId: number }
  | {
      state: 'verified'
      attemptId: number
      txHash: string
      finality: FinalityEvidence
    }

const response = (
  status: FeeResponse['status'],
  body: FeeResponse['body'],
): FeeResponse => ({ state: 'response', status, body })

const doNotPay = (status: 202 | 409 | 503, body: Record<string, unknown>): FeeResponse =>
  response(status, { ...body, do_not_pay_again: true })

const reviewResponse = (): FeeResponse => doNotPay(409, {
  error: 'this listing fee needs review; no listing was created; do not pay again',
  retry: 'repeating the same request only rereads the preserved review state',
})

const uncertainReviewResponse = (): FeeResponse => doNotPay(503, {
  error: 'the market could not confirm this fee review; retry the same listing request and transaction; do not pay again',
  retry: 'retry the same listing request with the same fee transaction',
})

function feeInvalidReason(reason: string): string {
  return reason.startsWith('transaction did not transfer at least')
    ? 'the fee must be paid from the same wallet you list as seller_wallet and transfer at least 1.000000 USDC on Base to the market treasury'
    : reason
}

export async function readListingFeeAttempt(
  merchantId: number,
  requestKind: ListingFeeRequestKind,
  requestHash: string,
): Promise<ListingFeeAttempt | null> {
  const rows = await sql`/* listing-fee-attempt:read */
    SELECT id, merchant_id, listing_id, lower(tx_hash) AS tx_hash,
      fee_request_kind, fee_request_hash, payer_wallet, payee_wallet, asset,
      minimum_block_time, maximum_block_time, payment_status,
      finalized_block_number::text AS finalized_block_number,
      finalized_block_hash, finalized_block_time, finalized_at, payment_review_reason,
      world_draft_id, world_offer_id, world_seller_handle
    FROM listing_fee_attempts
    WHERE merchant_id = ${merchantId} AND fee_request_kind = ${requestKind}
      AND fee_request_hash = ${requestHash}` as ListingFeeAttempt[]
  return rows[0] ?? null
}

async function reserveAttempt(input: {
  merchantId: number
  requestKind: ListingFeeRequestKind
  requestHash: string
  txHash: string
  payerWallet: string
  minimumBlockTime: Date
  maximumBlockTime: Date
  world?: { draftId: number; offerId: number; sellerHandle: string }
}): Promise<ListingFeeAttempt | null> {
  try {
    const rows = await sql`/* listing-fee-attempt:reserve */
      INSERT INTO listing_fee_attempts (
        merchant_id, fee_request_kind, fee_request_hash, tx_hash,
        payer_wallet, payee_wallet, asset, amount_usdc,
        minimum_block_time, maximum_block_time,
        world_draft_id, world_offer_id, world_seller_handle
      ) VALUES (
        ${input.merchantId}, ${input.requestKind}, ${input.requestHash}, lower(${input.txHash}),
        lower(${input.payerWallet}), lower(${TREASURY}), lower(${USDC}), ${LISTING_FEE_USDC},
        ${input.minimumBlockTime.toISOString()}::timestamptz,
        ${input.maximumBlockTime.toISOString()}::timestamptz,
        ${input.world?.draftId ?? null}, ${input.world?.offerId ?? null},
        ${input.world?.sellerHandle ?? null}
      )
      ON CONFLICT DO NOTHING
      RETURNING id, merchant_id, listing_id, lower(tx_hash) AS tx_hash,
        fee_request_kind, fee_request_hash, payer_wallet, payee_wallet, asset,
        minimum_block_time, maximum_block_time, payment_status,
        finalized_block_number::text AS finalized_block_number,
        finalized_block_hash, finalized_block_time, finalized_at, payment_review_reason,
        world_draft_id, world_offer_id, world_seller_handle` as ListingFeeAttempt[]
    return rows[0] ?? await readListingFeeAttempt(input.merchantId, input.requestKind, input.requestHash)
  } catch (error) {
    const details = postgresErrorDetails(error)
    if (details.code !== '23505' || !details.constraint || !FEE_ATTEMPT_CONSTRAINTS.has(details.constraint))
      throw error
    return readListingFeeAttempt(input.merchantId, input.requestKind, input.requestHash)
  }
}

async function reviewAttempt(
  id: number,
  reason: string,
  finality?: FinalityEvidence,
): Promise<ListingFeeAttempt | null> {
  const rows = await sql`/* listing-fee-attempt:review */
    UPDATE listing_fee_attempts SET
      payment_status = 'needs_review', payment_review_reason = ${reason},
      finalized_block_number = ${finality?.blockNumber.toString() ?? null},
      finalized_block_hash = ${finality?.blockHash ?? null},
      finalized_block_time = ${finality?.blockTime.toISOString() ?? null},
      finalized_at = ${finality?.finalizedAt.toISOString() ?? null}
    WHERE id = ${id} AND payment_status = 'payment_pending'
    RETURNING id, merchant_id, listing_id, lower(tx_hash) AS tx_hash,
      fee_request_kind, fee_request_hash, payer_wallet, payee_wallet, asset,
      minimum_block_time, maximum_block_time, payment_status,
      finalized_block_number::text AS finalized_block_number,
      finalized_block_hash, finalized_block_time, finalized_at, payment_review_reason,
      world_draft_id, world_offer_id, world_seller_handle` as ListingFeeAttempt[]
  if (rows[0]) return rows[0]
  const existing = await sql`/* listing-fee-attempt:read-by-id */
    SELECT id, merchant_id, listing_id, lower(tx_hash) AS tx_hash,
      fee_request_kind, fee_request_hash, payer_wallet, payee_wallet, asset,
      minimum_block_time, maximum_block_time, payment_status,
      finalized_block_number::text AS finalized_block_number,
      finalized_block_hash, finalized_block_time, finalized_at, payment_review_reason,
      world_draft_id, world_offer_id, world_seller_handle
    FROM listing_fee_attempts WHERE id = ${id}` as ListingFeeAttempt[]
  return existing[0] ?? null
}

export async function reviewListingFeePayment(
  attemptId: number,
  reason: string,
  finality?: FinalityEvidence,
): Promise<FeeResponse | { state: 'completed'; listingId: number }> {
  try {
    const attempt = await reviewAttempt(attemptId, reason, finality)
    if (attempt?.payment_status === 'completed' && attempt.listing_id != null)
      return { state: 'completed', listingId: attempt.listing_id }
    if (attempt?.payment_status === 'needs_review') return reviewResponse()
    console.error('listing fee review returned no confirmed terminal state')
    return uncertainReviewResponse()
  } catch (error) {
    console.error('listing fee review state could not be confirmed', error)
    return uncertainReviewResponse()
  }
}

function attemptMatches(
  attempt: ListingFeeAttempt,
  input: {
    txHash: string
    payerWallet: string
    requestKind: ListingFeeRequestKind
    world?: { draftId: number; offerId: number; sellerHandle: string }
  },
): boolean {
  const worldMatches = input.requestKind === 'artifact_listing'
    ? attempt.world_draft_id == null && attempt.world_offer_id == null && attempt.world_seller_handle == null
    : attempt.world_draft_id === input.world?.draftId
      && attempt.world_offer_id === input.world?.offerId
      && attempt.world_seller_handle === input.world?.sellerHandle
  return worldMatches && attempt.tx_hash === input.txHash
    && attempt.payer_wallet === input.payerWallet.toLowerCase()
    && attempt.payee_wallet === TREASURY.toLowerCase()
    && attempt.asset === USDC.toLowerCase()
}

export async function resolveListingFeePayment(input: {
  merchantId: number
  requestKind: ListingFeeRequestKind
  requestHash: string
  txHash: string
  payerWallet: string
  requestStartedAt: Date
  world?: { draftId: number; offerId: number; sellerHandle: string }
}): Promise<ListingFeeResolution> {
  const canonical = canonicalTxHash(input.txHash)
  if (!canonical) return response(402, { error: 'fee_tx_hash must be a 0x-prefixed 32-byte transaction hash' })

  let attempt = await readListingFeeAttempt(input.merchantId, input.requestKind, input.requestHash)
  if (attempt?.payment_status === 'completed') {
    if (!attemptMatches(attempt, { ...input, txHash: canonical }) || attempt.listing_id == null)
      return reviewResponse()
    return { state: 'completed', listingId: attempt.listing_id }
  }
  if (attempt?.payment_status === 'needs_review') return reviewResponse()
  if (attempt && !attemptMatches(attempt, { ...input, txHash: canonical })) {
    return doNotPay(409, {
      error: 'this listing request already stored a different fee payment; retry with the original request and transaction; do not pay again',
    })
  }

  const minimumBlockTime = attempt
    ? new Date(attempt.minimum_block_time)
    : new Date(input.requestStartedAt.getTime() - DIRECT_FEE_LOOKBACK_MS)
  const maximumBlockTime = attempt
    ? new Date(attempt.maximum_block_time)
    : input.requestStartedAt
  if (Number.isNaN(minimumBlockTime.getTime()) || Number.isNaN(maximumBlockTime.getTime()) ||
      maximumBlockTime.getTime() - minimumBlockTime.getTime() !== DIRECT_FEE_LOOKBACK_MS) {
    return attempt
      ? reviewListingFeePayment(attempt.id, 'the stored listing fee window is invalid')
      : response(409, { error: 'the listing fee window could not be created; start a new listing request' })
  }

  if (!attempt) {
    try {
      attempt = await reserveAttempt({
        merchantId: input.merchantId,
        requestKind: input.requestKind,
        requestHash: input.requestHash,
        txHash: canonical,
        payerWallet: input.payerWallet.toLowerCase(),
        minimumBlockTime,
        maximumBlockTime,
        world: input.world,
      })
    } catch (error) {
      console.error('listing fee payment could not be preserved before its chain check', error)
      return doNotPay(503, {
        error: 'the market could not preserve this fee payment; retry the same listing request and transaction; do not pay again',
        retry: 'retry the same listing request with the same fee transaction',
      })
    }
  }
  if (!attempt || !attemptMatches(attempt, { ...input, txHash: canonical })) {
    return doNotPay(409, {
      error: 'this fee transaction was already used or reserved by another market action; do not pay again',
    })
  }
  if (attempt.payment_status === 'completed' && attempt.listing_id != null)
    return { state: 'completed', listingId: attempt.listing_id }
  if (attempt.payment_status === 'needs_review') return reviewResponse()

  const checked = await verifyDirectPayment(
    canonical,
    TREASURY,
    LISTING_FEE_USDC,
    minimumBlockTime,
    input.payerWallet,
  )
  if (checked.status === 'invalid') {
    const reason = feeInvalidReason(checked.reason)
    return reviewListingFeePayment(attempt.id, reason, checked.finality)
  }
  if (checked.status === 'unavailable') {
    return doNotPay(503, {
      error: checked.reason,
      retry: 'retry the same listing request with the same fee transaction',
    })
  }

  if (checked.status === 'payment_pending') {
    return doNotPay(202, {
      status: 'payment_pending',
      retry: 'retry the same listing request after Base finality with the same fee transaction',
    })
  }
  if (checked.status !== 'verified') {
    return doNotPay(503, { error: checked.reason })
  }
  if (checked.blockTime > maximumBlockTime) {
    const reason = 'the fee transaction was paid after this listing request started'
    return reviewListingFeePayment(attempt.id, reason, {
      blockNumber: checked.blockNumber,
      blockHash: checked.blockHash,
      blockTime: checked.blockTime,
      finalizedAt: checked.finalizedAt,
    })
  }
  return {
    state: 'verified',
    attemptId: attempt.id,
    txHash: canonical,
    finality: {
      blockNumber: checked.blockNumber,
      blockHash: checked.blockHash,
      blockTime: checked.blockTime,
      finalizedAt: checked.finalizedAt,
    },
  }
}
