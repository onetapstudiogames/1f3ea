import {
  NETWORK,
  USDC,
  classifyUsdcTransfer,
  currentBaseBlockNumber,
  toUnits,
  type VerificationFailure,
} from './chain.ts'
import {
  X402PaymentAttemptConflictError,
  beginX402Settlement,
  markX402SettlementNeedsReview,
  readX402PaymentAttempt,
  recordX402Finality,
  recordX402Settlement,
  x402PaymentAttemptMatches,
  x402PaymentRetryInstruction,
  type X402PaymentAttempt,
  type X402PaymentOperationKind,
} from './x402-payment-attempts.ts'
import { canonicalTxHash, type PaymentRequirements } from './x402-contract.ts'
import { requireWallet, validateX402ProofForOperation } from './x402-proof.ts'
import {
  prepareX402Payment,
  settlePreparedX402,
  verifyPreparedX402,
  type Settled,
  type UnclassifiedFacilitatorFailure,
  type X402SettlementOutcome,
  type X402SettlementReceipt,
} from './x402-facilitator.ts'

export {
  canonicalTxHash,
  challenge402,
  requirements,
  type PaymentRequirements,
} from './x402-contract.ts'

export {
  LISTING_FEE_USDC,
  TREASURY,
  paymentCustodyReady,
  paymentReadinessResponse,
} from './payment-config.ts'

export type { Settled } from './x402-facilitator.ts'
export type X402Settlement = X402SettlementOutcome

export interface X402PaymentOperation {
  operationKey: string
  operationKind: X402PaymentOperationKind
  operationStartedAt: Date
}

export interface FinalizedX402Payment {
  status: 'verified'
  transaction: string
  payer: string
  blockTime: Date
  blockNumber: bigint
  blockHash: string
  finalizedAt: Date
  /** Present only when this request received the facilitator response itself. */
  raw?: X402SettlementReceipt
}

export interface X402NoPayResult {
  status: 'unavailable' | 'needs_review' | 'conflict'
  reason: string
  retry: string
  do_not_pay_again: true
}

export type X402CustodySettlement =
  | FinalizedX402Payment
  | { status: 'invalid'; reason: string }
  | UnclassifiedFacilitatorFailure
  | X402NoPayResult

function retryWithoutPaying(
  status: X402NoPayResult['status'],
  reason: string,
  attempt?: X402PaymentAttempt,
): X402NoPayResult {
  const instruction = attempt
    ? x402PaymentRetryInstruction(attempt)
    : {
        retry: 'retry this same request with the same X-PAYMENT proof',
        do_not_pay_again: true as const,
      }
  return { status, reason, ...instruction }
}

async function classifyStoredX402Payment(
  attempt: X402PaymentAttempt,
  raw?: X402SettlementReceipt,
): Promise<X402CustodySettlement> {
  if (!attempt.tx_hash) {
    return retryWithoutPaying(
      'needs_review',
      'the payment settlement outcome has no confirmed transaction and needs manual review',
      attempt,
    )
  }

  const terminalEvidence = () => {
    const blockHash = canonicalTxHash(attempt.finalized_block_hash)
    if (
      attempt.finalized_block_number == null
      || !/^(?:0|[1-9][0-9]*)$/u.test(attempt.finalized_block_number)
      || blockHash == null
      || attempt.finalized_block_time == null
      || attempt.finalized_at == null
    ) return null
    const blockTime = new Date(attempt.finalized_block_time)
    const finalizedAt = new Date(attempt.finalized_at)
    if (
      !Number.isFinite(blockTime.getTime())
      || !Number.isFinite(finalizedAt.getTime())
      || finalizedAt < blockTime
    ) return null
    return {
      blockTime,
      blockNumber: BigInt(attempt.finalized_block_number),
      blockHash,
      finalizedAt,
    }
  }

  if (attempt.status === 'verified') {
    const evidence = terminalEvidence()
    if (!evidence) {
      return retryWithoutPaying(
        'unavailable',
        'the market could not read its finalized payment record; the transaction is preserved',
        attempt,
      )
    }
    return {
      status: 'verified',
      transaction: attempt.tx_hash,
      payer: attempt.payer_wallet,
      ...evidence,
      ...(raw ? { raw } : {}),
    }
  }
  if (attempt.status === 'needs_review') {
    return retryWithoutPaying(
      'needs_review',
      attempt.review_reason
        ?? 'the recorded transaction needs manual review; no delivery was recorded; do not pay again',
      attempt,
    )
  }

  let check: Awaited<ReturnType<typeof classifyUsdcTransfer>>
  try {
    check = await classifyUsdcTransfer(
      attempt.tx_hash,
      attempt.payee_wallet,
      BigInt(attempt.amount_units),
      {
        expectedFrom: attempt.payer_wallet,
        exactAmount: true,
        expectedAuthorizationNonce: attempt.authorization_nonce,
      },
    )
  } catch {
    return retryWithoutPaying(
      'unavailable',
      'the market could not check the recorded payment on Base; its transaction is preserved',
      attempt,
    )
  }

  if (check.state === 'matched') {
    let finalized: X402PaymentAttempt
    try {
      finalized = await recordX402Finality({
        operationKey: attempt.operation_key,
        proofDigest: attempt.proof_digest,
        transaction: attempt.tx_hash,
        outcome: 'verified',
        blockNumber: check.blockNumber,
        blockHash: check.blockHash,
        blockTime: check.blockTime,
        finalizedAt: check.finalizedAt,
      })
    } catch {
      return retryWithoutPaying(
        'unavailable',
        'the market could not durably record the finalized payment; the transaction is preserved',
        attempt,
      )
    }
    if (finalized.status !== 'verified' || finalized.finalized_block_number == null) {
      if (finalized.status === 'needs_review') return classifyStoredX402Payment(finalized, raw)
      return retryWithoutPaying(
        'unavailable',
        'the market could not confirm its finalized payment record; the transaction is preserved',
        attempt,
      )
    }
    return classifyStoredX402Payment(finalized, raw)
  }
  if (check.state === 'invalid_final') {
    const reason = check.reason === 'failed_transaction'
      ? 'the recorded payment transaction finalized as failed and needs manual review'
      : 'the recorded transaction finalized without both the signed X-PAYMENT authorization and ' +
        'the exact USDC transfer to this payment recipient and needs manual review'
    let finalized: X402PaymentAttempt
    try {
      finalized = await recordX402Finality({
        operationKey: attempt.operation_key,
        proofDigest: attempt.proof_digest,
        transaction: attempt.tx_hash,
        outcome: 'needs_review',
        reason,
        blockNumber: check.blockNumber,
        blockHash: check.blockHash,
        blockTime: check.blockTime,
        finalizedAt: check.finalizedAt,
      })
    } catch {
      return retryWithoutPaying(
        'unavailable',
        'the market could not durably record the finalized payment review; the transaction is preserved',
        attempt,
      )
    }
    if (finalized.status !== 'needs_review' || finalized.finalized_block_number == null) {
      return retryWithoutPaying(
        'unavailable',
        'the market could not confirm its finalized payment review record; the transaction is preserved',
        attempt,
      )
    }
    return retryWithoutPaying(
      'needs_review',
      reason,
      finalized,
    )
  }
  return retryWithoutPaying(
    'unavailable',
    check.state === 'unavailable'
      ? 'the market could not confirm the recorded payment on Base; its transaction is preserved'
      : 'the recorded payment is not finalized on Base yet; its transaction is preserved',
    attempt,
  )
}

async function holdX402ForReview(
  attempt: X402PaymentAttempt,
  storedReason: string,
  callerReason: string,
): Promise<X402CustodySettlement> {
  let reviewed: X402PaymentAttempt
  try {
    reviewed = await markX402SettlementNeedsReview({
      operationKey: attempt.operation_key,
      proofDigest: attempt.proof_digest,
      reason: storedReason,
    })
  } catch {
    return retryWithoutPaying(
      'unavailable',
      'the market could not confirm its payment review record; the settlement outcome remains uncertain',
      attempt,
    )
  }
  if (reviewed.tx_hash) return classifyStoredX402Payment(reviewed)
  if (reviewed.status !== 'needs_review') {
    return retryWithoutPaying(
      'unavailable',
      'the market could not confirm its payment review record; the settlement outcome remains uncertain',
      reviewed,
    )
  }
  return retryWithoutPaying('needs_review', callerReason, reviewed)
}

async function resumeStoredX402Payment(
  attempt: X402PaymentAttempt,
): Promise<X402CustodySettlement> {
  if (attempt.tx_hash) return classifyStoredX402Payment(attempt)
  if (attempt.status === 'settling') {
    return holdX402ForReview(
      attempt,
      'settlement outcome has no confirmed transaction',
      'the payment settlement outcome has no confirmed transaction and needs manual review',
    )
  }
  return retryWithoutPaying(
    'needs_review',
    'the payment settlement outcome has no confirmed transaction and needs manual review',
    attempt,
  )
}

async function settleX402WithCustody(
  paymentHeader: string,
  reqs: PaymentRequirements,
  operation: X402PaymentOperation,
): Promise<X402CustodySettlement> {
  let localProof: ReturnType<typeof validateX402ProofForOperation>
  try {
    localProof = validateX402ProofForOperation(paymentHeader, reqs, operation.operationStartedAt)
  } catch (error) {
    return { status: 'invalid', reason: error instanceof Error ? error.message : 'X-PAYMENT proof is invalid' }
  }
  const prepared = prepareX402Payment(localProof.paymentPayload, reqs, localProof.proof.payerWallet)

  let existing: X402PaymentAttempt | null
  try { existing = await readX402PaymentAttempt(operation.operationKey) } catch {
    return retryWithoutPaying('unavailable', 'the market could not read this saved payment; do not start another payment')
  }
  if (existing) {
    const sameProof = existing.proof_digest === localProof.proof.digest
      && existing.operation_started_at === localProof.operationStartedAt.toISOString()
    if (!sameProof || !x402PaymentAttemptMatches(existing, {
      operationKey: operation.operationKey, operationKind: operation.operationKind, requirements: reqs,
    })) return retryWithoutPaying('conflict', 'this saved payment is already bound to its original request and X-PAYMENT proof')
    return resumeStoredX402Payment(existing)
  }

  let startBlock: bigint | null
  try { startBlock = await currentBaseBlockNumber() } catch { startBlock = null }
  if (startBlock == null) {
    return retryWithoutPaying('unavailable', 'the market could not anchor this payment to the current Base block; payment did not start')
  }

  const verification = await verifyPreparedX402(prepared)
  if (verification.status !== 'approved') {
    if (verification.status === 'unavailable') {
      return retryWithoutPaying('unavailable', verification.reason)
    }
    if (verification.status === 'invalid') {
      return { status: 'invalid', reason: verification.reason }
    }
    return { status: 'unclassified', reason: verification.reason }
  }

  let reserved: Awaited<ReturnType<typeof beginX402Settlement>>
  try {
    reserved = await beginX402Settlement({
      ...operation,
      startBlock,
      paymentHeader,
      requirements: reqs,
    })
  } catch (error) {
    if (error instanceof X402PaymentAttemptConflictError) {
      return retryWithoutPaying(
        'conflict',
        'this saved payment is already bound to its original request and X-PAYMENT proof',
      )
    }
    return retryWithoutPaying(
      'unavailable',
      'the market could not durably bind this X-PAYMENT proof to this request; settlement did not start',
    )
  }

  if (reserved.disposition === 'existing') return resumeStoredX402Payment(reserved.attempt)

  const settled = await settlePreparedX402(prepared)
  if (settled.status !== 'verified') {
    return holdX402ForReview(
      reserved.attempt,
      'facilitator settlement was not conclusively confirmed',
      'the payment facilitator did not conclusively confirm settlement; this payment needs manual review',
    )
  }

  let recorded: X402PaymentAttempt
  try {
    recorded = await recordX402Settlement({
      operationKey: reserved.attempt.operation_key,
      proofDigest: reserved.attempt.proof_digest,
      transaction: settled.transaction,
      payerWallet: reserved.attempt.payer_wallet,
    })
  } catch {
    return retryWithoutPaying(
      'unavailable',
      'the market could not confirm that it recorded the facilitator transaction; the settlement outcome is preserved for retry',
      reserved.attempt,
    )
  }
  return classifyStoredX402Payment(recorded, settled.raw)
}

export async function resumeX402Payment(
  operationKey: string,
): Promise<X402CustodySettlement | null> {
  let attempt: X402PaymentAttempt | null
  try {
    attempt = await readX402PaymentAttempt(operationKey)
  } catch {
    return retryWithoutPaying(
      'unavailable',
      'the market could not read this saved payment; do not start another payment',
    )
  }
  return attempt ? resumeStoredX402Payment(attempt) : null
}

export async function resumeX402PaymentForTerms(
  operationKey: string,
  operationKind: X402PaymentOperationKind,
  reqs: PaymentRequirements,
): Promise<X402CustodySettlement | null> {
  let attempt: X402PaymentAttempt | null
  try {
    attempt = await readX402PaymentAttempt(operationKey)
  } catch {
    return retryWithoutPaying(
      'unavailable',
      'the market could not read this saved payment; do not start another payment',
    )
  }
  if (!attempt) return null
  if (!x402PaymentAttemptMatches(attempt, { operationKey, operationKind, requirements: reqs })) {
    return retryWithoutPaying(
      'conflict',
      'the saved payment does not match this request\'s recipient, amount, or route; do not pay again',
      attempt,
    )
  }
  return resumeStoredX402Payment(attempt)
}

export async function settleX402(
  paymentHeader: string,
  reqs: PaymentRequirements,
  operation: X402PaymentOperation,
): Promise<X402CustodySettlement> {
  if (!operation || typeof operation !== 'object') {
    throw new TypeError('x402 payment operation context is required')
  }
  return settleX402WithCustody(paymentHeader, reqs, operation)
}

export function paymentResponseHeader(settled: Settled): string {
  const transaction = canonicalTxHash(settled.transaction)
  if (!transaction) throw new TypeError('settled transaction must be a 0x-prefixed 32-byte hash')
  const payer = requireWallet(settled.payer, 'settled payer')
  const receipt: X402SettlementReceipt = {
    success: true,
    transaction,
    network: NETWORK,
    payer,
  }
  const encoded = Buffer.from(JSON.stringify(receipt)).toString('base64')
  if (Buffer.byteLength(encoded, 'ascii') > 512) {
    throw new TypeError('X-PAYMENT-RESPONSE exceeds its 512-byte limit')
  }
  return encoded
}

/**
 * Read-only chain half of a direct-payment claim. The purchase route must also
 * enforce its authenticated, signed, short-lived intent and atomically consume
 * both that intent and the normalized transaction hash before delivery.
 */
export async function verifyDirectPayment(
  txHash: string,
  to: string,
  usdc: number,
  notBefore: Date,
  expectedFrom?: string,
): Promise<
  | {
      status: 'verified'
      from: string
      amount: string
      blockTime: Date
      blockNumber: bigint
      blockHash: string
      finalizedAt: Date
    }
  | { status: 'payment_pending'; from: string; amount: string }
  | VerificationFailure
> {
  const canonical = canonicalTxHash(txHash)
  if (!canonical) {
    return { status: 'invalid', reason: 'tx_hash must be a 0x-prefixed 32-byte transaction hash' }
  }
  const minimum = toUnits(usdc)
  const check = await classifyUsdcTransfer(canonical, to, minimum, { expectedFrom })
  if (check.state === 'pending' || check.state === 'unavailable') {
    return {
      status: 'unavailable',
      reason: 'the market could not check this payment on Base; retry the same proof later',
    }
  }
  if (check.state === 'invalid_final') {
    return check.reason === 'failed_transaction'
      ? { status: 'invalid', reason: 'transaction failed on Base', finality: check }
      : {
          status: 'invalid',
          reason: `transaction did not transfer at least ${usdc.toFixed(6)} USDC on Base to ${to}`,
          finality: check,
        }
  }
  if (check.state === 'matched_pending') {
    return {
      status: 'payment_pending',
      from: check.from,
      amount: (Number(check.amount) / 1e6).toFixed(6),
    }
  }
  if (check.blockTime < notBefore) {
    return {
      status: 'invalid',
      reason: 'transaction was paid before this payment window opened',
      finality: check,
    }
  }
  return {
    status: 'verified',
    from: check.from,
    amount: (Number(check.amount) / 1e6).toFixed(6),
    blockTime: check.blockTime,
    blockNumber: check.blockNumber,
    blockHash: check.blockHash,
    finalizedAt: check.finalizedAt,
  }
}
