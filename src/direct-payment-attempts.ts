import { sql } from './db.ts'
import type { FinalityEvidence } from './chain.ts'

export type DirectPaymentAttemptState =
  | 'unsubmitted'
  | 'payment_pending'
  | 'completed'
  | 'needs_review'
  | 'legacy_completed'

export interface DirectPaymentAttempt {
  id: number
  payment_tx_hash: string | null
  payment_status: DirectPaymentAttemptState
  finalized_block_number: string | null
  finalized_block_hash: string | null
  finalized_block_time: string | null
  finalized_at: string | null
  payment_review_reason: string | null
}

export async function readDirectPaymentAttempt(intentId: number): Promise<DirectPaymentAttempt | null> {
  const rows = (await sql`
    /* direct-payment-attempt:read */
    SELECT id, payment_tx_hash, payment_status,
      finalized_block_number::text AS finalized_block_number,
      finalized_block_hash, finalized_block_time, finalized_at, payment_review_reason
    FROM direct_purchase_intents
    WHERE id = ${intentId}`) as DirectPaymentAttempt[]
  return rows[0] ?? null
}

export async function reserveDirectPaymentAttempt(
  intentId: number,
  txHash: string,
  requestStartedAt: Date,
): Promise<DirectPaymentAttempt | null> {
  const rows = (await sql`
    /* direct-payment-attempt:reserve */
    UPDATE direct_purchase_intents SET
      payment_tx_hash = lower(${txHash}), payment_status = 'payment_pending'
    WHERE id = ${intentId} AND payment_status = 'unsubmitted'
      AND claimed_at IS NULL AND superseded_at IS NULL
      AND created_at <= ${requestStartedAt.toISOString()}::timestamptz
      AND expires_at >= ${requestStartedAt.toISOString()}::timestamptz
    RETURNING id, payment_tx_hash, payment_status,
      finalized_block_number::text AS finalized_block_number,
      finalized_block_hash, finalized_block_time, finalized_at,
      payment_review_reason`) as DirectPaymentAttempt[]
  return rows[0] ?? await readDirectPaymentAttempt(intentId)
}

export async function markDirectPaymentNeedsReview(
  intentId: number,
  reason: string,
  finality?: FinalityEvidence,
): Promise<DirectPaymentAttempt | null> {
  const rows = (await sql`
    /* direct-payment-attempt:review */
    UPDATE direct_purchase_intents SET
      payment_status = 'needs_review', payment_review_reason = ${reason},
      finalized_block_number = ${finality?.blockNumber.toString() ?? null},
      finalized_block_hash = ${finality?.blockHash ?? null},
      finalized_block_time = ${finality?.blockTime.toISOString() ?? null},
      finalized_at = ${finality?.finalizedAt.toISOString() ?? null}
    WHERE id = ${intentId} AND payment_status = 'payment_pending'
    RETURNING id, payment_tx_hash, payment_status,
      finalized_block_number::text AS finalized_block_number,
      finalized_block_hash, finalized_block_time, finalized_at,
      payment_review_reason`) as DirectPaymentAttempt[]
  return rows[0] ?? await readDirectPaymentAttempt(intentId)
}
