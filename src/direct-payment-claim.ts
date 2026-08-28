import { verifyPersonalSignatureProof, type FinalityEvidence } from './chain.ts'
import {
  directPaymentWindowError,
  purchaseIntentChallenge,
  type DirectPurchaseIntent,
} from './direct-payments.ts'
import {
  markDirectPaymentNeedsReview,
  reserveDirectPaymentAttempt,
  type DirectPaymentAttempt,
} from './direct-payment-attempts.ts'
import { canonicalTxHash, verifyDirectPayment } from './pay.ts'
import { postgresErrorDetails } from './postgres-error.ts'

export type DirectClaimIntent = DirectPurchaseIntent & DirectPaymentAttempt & {
  merchant_id: number
  superseded_at: string | null
  claimed_at: string | null
}

type ClaimResponse = {
  state: 'response'
  status: 202 | 402 | 409 | 503
  body: Record<string, unknown>
}

export type DirectClaimResolution =
  | ClaimResponse
  | { state: 'completed' }
  | {
      state: 'verified'
      txHash: string
      payerWallet: string
      paidAt: Date
      finality: FinalityEvidence
    }

const response = (
  status: ClaimResponse['status'],
  body: ClaimResponse['body'],
): ClaimResponse => ({ state: 'response', status, body })

function doNotPay(status: 202 | 409 | 503, body: Record<string, unknown>): ClaimResponse {
  return response(status, { ...body, do_not_pay_again: true })
}

function terminalReview() {
  return doNotPay(409, {
    error: 'this purchase payment needs review; no delivery was recorded; do not pay again',
    retry: 'repeating this same claim only rereads the preserved review state',
  })
}

export async function reviewDirectPaymentClaim(
  intentId: number,
  reason: string,
  finality?: FinalityEvidence,
): Promise<ClaimResponse | { state: 'completed' }> {
  try {
    const reviewed = await markDirectPaymentNeedsReview(intentId, reason, finality)
    if (reviewed?.payment_status === 'completed') return { state: 'completed' }
    if (reviewed?.payment_status === 'needs_review') return terminalReview()
    console.error('direct purchase review returned no confirmed terminal state')
    return doNotPay(503, {
      error: 'the market could not confirm this purchase review; retry this same claim; do not pay again',
      retry: 'retry this same claim with the same intent, transaction, and signature',
    })
  } catch (error) {
    console.error('direct purchase review state could not be confirmed', error)
    return doNotPay(503, {
      error: 'the market could not confirm this purchase review; retry this same claim; do not pay again',
      retry: 'retry this same claim with the same intent, transaction, and signature',
    })
  }
}

export async function resolveDirectPaymentClaim(input: {
  intent: DirectClaimIntent
  txHash: string
  payerSignature: string
  requestStartedAt: Date
}): Promise<DirectClaimResolution> {
  const canonical = canonicalTxHash(input.txHash)
  if (!canonical) return response(402, { error: 'tx_hash must be a 0x-prefixed 32-byte transaction hash' })
  const { intent } = input
  if (intent.payment_status === 'completed') return { state: 'completed' }
  if (intent.payment_status === 'needs_review') return terminalReview()
  if (intent.payment_status === 'legacy_completed') return { state: 'completed' }
  if (intent.payment_status === 'payment_pending' && intent.payment_tx_hash !== canonical) {
    return doNotPay(409, {
      error: 'this purchase intent already stored a different transaction; retry with that original transaction; do not pay again',
    })
  }

  const retrying = intent.payment_status === 'payment_pending'
  const preflightError = directPaymentWindowError(
    intent, new Date(intent.created_at), input.requestStartedAt, retrying,
  )
  if (preflightError) return response(409, { error: preflightError })

  const signatureProof = await verifyPersonalSignatureProof(
    purchaseIntentChallenge(intent), input.payerSignature, intent.payer_wallet,
  )
  if (signatureProof.status !== 'verified') {
    return response(signatureProof.status === 'invalid' ? 402 : 503, {
      error: signatureProof.reason,
      ...(retrying ? { do_not_pay_again: true } : {}),
    })
  }

  const direct = await verifyDirectPayment(
    canonical,
    intent.seller_wallet,
    Number(intent.minimum_amount_usdc),
    new Date(intent.created_at),
    intent.payer_wallet,
  )
  if (direct.status === 'invalid') {
    if (!retrying) return response(402, { error: direct.reason })
    return reviewDirectPaymentClaim(intent.id, direct.reason, direct.finality)
  }
  if (direct.status === 'unavailable') {
    const body = {
      error: direct.reason,
      retry: retrying
        ? 'retry this same claim with the same intent, transaction, and signature'
        : 'retry this same claim before the purchase intent expires',
      ...(retrying ? {} : { payment_preserved: false }),
    }
    return retrying ? doNotPay(503, body) : response(503, body)
  }
  if (direct.status === 'verified' && !retrying) {
    const firstWindowError = directPaymentWindowError(
      intent, direct.blockTime, input.requestStartedAt,
    )
    if (firstWindowError) {
      return response(firstWindowError.startsWith('payment') ? 402 : 409, { error: firstWindowError })
    }
  }

  let attempt: DirectPaymentAttempt | null = intent
  if (!retrying) {
    try {
      attempt = await reserveDirectPaymentAttempt(intent.id, canonical, input.requestStartedAt)
    } catch (error) {
      const details = postgresErrorDetails(error)
      if (details.code !== '23505' || ![
        'payment_uses_pkey',
        'direct_purchase_intents_payment_tx_unique',
      ].includes(details.constraint ?? '')) throw error
      return doNotPay(409, {
        error: 'this transaction hash was already used or reserved by another market payment; do not pay again',
      })
    }
  }
  if (!attempt || attempt.payment_tx_hash !== canonical) {
    return doNotPay(409, {
      error: 'this purchase intent changed before its payment could be stored; do not pay again',
    })
  }
  if (attempt.payment_status === 'needs_review') return terminalReview()
  if (attempt.payment_status === 'completed') return { state: 'completed' }
  if (attempt.payment_status !== 'payment_pending') {
    return doNotPay(409, {
      error: 'this purchase intent could not preserve the payment; do not pay again',
    })
  }
  if (direct.status === 'payment_pending') {
    return doNotPay(202, {
      status: 'payment_pending',
      intent_id: intent.id,
      retry: 'retry this same claim after Base finality with the same transaction and signature',
    })
  }
  if (direct.status !== 'verified') {
    return doNotPay(503, { error: direct.reason })
  }

  const windowError = directPaymentWindowError(intent, direct.blockTime, input.requestStartedAt, true)
  if (windowError) {
    return reviewDirectPaymentClaim(intent.id, windowError, {
      blockNumber: direct.blockNumber,
      blockHash: direct.blockHash,
      blockTime: direct.blockTime,
      finalizedAt: direct.finalizedAt,
    })
  }
  return {
    state: 'verified',
    txHash: canonical,
    payerWallet: intent.payer_wallet,
    paidAt: direct.blockTime,
    finality: {
      blockNumber: direct.blockNumber,
      blockHash: direct.blockHash,
      blockTime: direct.blockTime,
      finalizedAt: direct.finalizedAt,
    },
  }
}
