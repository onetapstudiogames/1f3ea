export const DIRECT_PURCHASE_INTENT_TTL_MS = 10 * 60 * 1000

export interface DirectPurchaseIntent {
  readonly id: number
  readonly listing_id: number
  readonly buyer: string
  readonly payer_wallet: string
  readonly seller_wallet: string
  readonly network: 'base'
  readonly asset: string
  readonly minimum_amount_usdc: string
  readonly challenge_nonce: string
  readonly created_at: string
  readonly expires_at: string
}

/** Canonical personal-sign message binding a payer wallet to one purchase intent. */
export function purchaseIntentChallenge(intent: DirectPurchaseIntent): string {
  return [
    '1F3EA direct purchase intent v1',
    `intent: ${intent.id}`,
    `buyer: ${intent.buyer}`,
    `listing: ${intent.listing_id}`,
    `payer: ${intent.payer_wallet}`,
    `seller: ${intent.seller_wallet}`,
    `network: ${intent.network}`,
    `asset: ${intent.asset}`,
    `minimum_usdc: ${intent.minimum_amount_usdc}`,
    `created_at: ${intent.created_at}`,
    `expires_at: ${intent.expires_at}`,
    `nonce: ${intent.challenge_nonce}`,
    'This signature proves control of the payer wallet only. It does not move money.',
  ].join('\n')
}

/**
 * Checks a payment against an intent's inclusive interval and the one timestamp
 * captured when the claim request began.
 */
export function directPaymentWindowError(
  intent: Pick<DirectPurchaseIntent, 'created_at' | 'expires_at'>,
  paymentBlockTime: Date,
  requestStartedAt: Date,
  allowExpiredRetry = false,
): string | null {
  const createdAt = Date.parse(intent.created_at)
  const expiresAt = Date.parse(intent.expires_at)
  const paymentAt = paymentBlockTime.getTime()
  const requestedAt = requestStartedAt.getTime()

  if (
    !Number.isFinite(createdAt)
    || !Number.isFinite(expiresAt)
    || !Number.isFinite(paymentAt)
    || !Number.isFinite(requestedAt)
    || expiresAt <= createdAt
    || expiresAt - createdAt > DIRECT_PURCHASE_INTENT_TTL_MS
    || requestedAt < createdAt
  ) return 'purchase intent has invalid timing'

  if (paymentAt < createdAt) return 'payment predates this purchase intent'
  if (paymentAt > expiresAt) return 'payment is outside this purchase intent'
  if (!allowExpiredRetry && requestedAt > expiresAt)
    return 'purchase intent expired before this request started'
  return null
}
