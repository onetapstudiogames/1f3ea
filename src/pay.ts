import type { Context } from 'hono'
import {
  NETWORK,
  USDC,
  toUnits,
  verifyUsdcTransfer,
  type VerificationFailure,
} from './chain.ts'

/**
 * x402 v1 "exact" scheme on Base, spoken directly — no SDK; the protocol is small
 * and this is how 1f916 does it too. Flow: unpaid request → 402 JSON with
 * PaymentRequirements; the client signs an EIP-3009 transferWithAuthorization and
 * retries with X-PAYMENT (base64 JSON); we POST the decoded payload to the
 * facilitator to verify, then settle. The facilitator broadcasts and pays gas;
 * the buyer's signature is what moves the funds; nobody here holds a key.
 *
 * Facilitator: PayAI — verify+settle on Base MAINNET with no account and no API
 * key (same reason 1f916 chose it: an agent-run market can't sign up for things).
 *
 * Ordinary purchases also work without x402 through a fresh signed purchase
 * intent. A public transaction hash by itself is never purchase authorization.
 */

export const TREASURY = (process.env.TREASURY_ADDRESS ?? '').toLowerCase()
export const LISTING_FEE_USDC = 1
const FACILITATOR = process.env.FACILITATOR_URL ?? 'https://facilitator.payai.network'
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/
const PAYMENT_CUSTODY_UNAVAILABLE =
  'payments are temporarily unavailable while durable payment custody is being upgraded; do not pay or retry yet'

export function paymentCustodyReady(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const hosted = environment.NODE_ENV === 'production'
    || environment.VERCEL === '1'
    || environment.VERCEL_ENV != null
  return !hosted || environment.PAYMENT_CUSTODY_READY === '1'
}

export function paymentReadinessResponse(c: Context): Response | null {
  if (paymentCustodyReady()) return null
  return c.json({ error: PAYMENT_CUSTODY_UNAVAILABLE }, 503)
}

export function canonicalTxHash(value: unknown): string | null {
  return typeof value === 'string' && TX_HASH_RE.test(value) ? value.toLowerCase() : null
}

export interface PaymentRequirements {
  scheme: 'exact'
  network: typeof NETWORK
  maxAmountRequired: string
  resource: string
  description: string
  mimeType: 'application/json'
  payTo: string
  maxTimeoutSeconds: number
  asset: string
  extra: { name: 'USD Coin'; version: '2' } // EIP-712 domain of USDC on Base mainnet
}

export function requirements(payTo: string, usdc: number, resource: string, description: string): PaymentRequirements {
  return {
    scheme: 'exact',
    network: NETWORK,
    maxAmountRequired: toUnits(usdc).toString(),
    resource,
    description,
    mimeType: 'application/json',
    payTo,
    maxTimeoutSeconds: 300,
    asset: USDC,
    extra: { name: 'USD Coin', version: '2' },
  }
}

export function challenge402(c: Context, reqs: PaymentRequirements, note: string) {
  return c.json({ x402Version: 1, error: note, accepts: [reqs] }, 402)
}

export interface Settled {
  status: 'verified'
  transaction: string
  payer: string
  raw: Record<string, unknown>
}

interface UnclassifiedFacilitatorFailure {
  status: 'unclassified'
  reason: string
}

export type X402Settlement = Settled | VerificationFailure | UnclassifiedFacilitatorFailure

type FacilitatorResponse =
  | { status: 'ok'; value: Record<string, unknown>; httpStatus: number }
  | VerificationFailure
  | UnclassifiedFacilitatorFailure

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function invalid(reason: string): VerificationFailure {
  return { status: 'invalid', reason }
}

const X402_CALLER_FAILURE_REASONS: Readonly<Record<string, string>> = Object.freeze({
  insufficient_funds: 'payer wallet does not have enough USDC for this payment',
  invalid_exact_evm_payload_authorization_valid_after: 'X-PAYMENT authorization is not valid yet',
  invalid_exact_evm_payload_authorization_valid_before: 'X-PAYMENT authorization expired',
  invalid_exact_evm_payload_authorization_value: 'X-PAYMENT amount is below the required payment',
  invalid_exact_evm_payload_signature: 'X-PAYMENT signature is invalid',
  invalid_exact_evm_payload_recipient_mismatch: 'X-PAYMENT recipient does not match this payment',
  invalid_network: 'X-PAYMENT uses the wrong or unsupported network',
  invalid_payload: 'X-PAYMENT payload is malformed or missing required fields',
  invalid_scheme: 'X-PAYMENT uses the wrong payment scheme',
  unsupported_scheme: 'X-PAYMENT uses a payment scheme the facilitator does not support',
  invalid_x402_version: 'X-PAYMENT uses an unsupported x402 version',
  invalid_transaction_state: 'X-PAYMENT transaction failed or was rejected',
})

const X402_UPSTREAM_FAILURE_REASONS = new Set([
  'duplicate_settlement',
  'invalid_payment_requirements',
  'settlement_pending',
  'transaction_failed',
  'unexpected_verify_error',
  'unexpected_settle_error',
])

function facilitatorUnavailable(stage: 'verification' | 'settlement'): VerificationFailure {
  return {
    status: 'unavailable',
    reason: `payment facilitator ${stage} is unavailable; retry this request with the same X-PAYMENT proof later` +
      (stage === 'settlement' ? '; do not pay again' : ''),
  }
}

function facilitatorUnreadable(stage: 'verification' | 'settlement'): VerificationFailure {
  return {
    status: 'unavailable',
    reason: `payment facilitator returned an unreadable ${stage} response; retry this request with the same X-PAYMENT proof later` +
      (stage === 'settlement' ? '; do not pay again' : ''),
  }
}

function terminalFacilitatorRejection(
  stage: 'verification' | 'settlement',
  detail = '',
): UnclassifiedFacilitatorFailure {
  const cause = detail
    ? `: ${detail}`
    : ' but did not publish a recognized caller-correctable cause'
  return {
    status: 'unclassified',
    reason: `payment facilitator rejected this X-PAYMENT as terminal${cause}; ` +
      'do not retry or replay this proof blindly' + (stage === 'settlement' ? '; do not pay again' : ''),
  }
}

function settlementInFlight(detail: 'pending' | 'already in flight'): VerificationFailure {
  return {
    status: 'unavailable',
    reason: `payment facilitator reports this X-PAYMENT settlement is ${detail}; ` +
      'retry the same X-PAYMENT proof later; do not pay again',
  }
}

function settlementTransactionFailed(): UnclassifiedFacilitatorFailure {
  return {
    status: 'unclassified',
    reason: 'payment facilitator reports the X-PAYMENT settlement transaction failed; this proof did not ' +
      'settle payment; do not retry or replay this proof blindly; do not pay again',
  }
}

function facilitatorHttpUnavailable(
  stage: 'verification' | 'settlement',
  status: 408 | 425 | 429,
): VerificationFailure {
  const cause = status === 408
    ? `${stage} timed out`
    : status === 429
      ? `rate-limited the ${stage} request`
      : `temporarily rejected the ${stage} request`
  return {
    status: 'unavailable',
    reason: `payment facilitator ${cause}; retry this request with the same X-PAYMENT proof later` +
      (stage === 'settlement' ? '; do not pay again' : ''),
  }
}

function facilitatorReasonCode(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const code = value.trim().toLowerCase()
  return code.length <= 100 && /^[a-z][a-z0-9_]*$/.test(code) ? code : null
}

function isCallerFailureCode(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(X402_CALLER_FAILURE_REASONS, code)
}

function callerFailureReason(value: unknown): string | null {
  const code = facilitatorReasonCode(value)
  return code && isCallerFailureCode(code) ? X402_CALLER_FAILURE_REASONS[code] ?? null : null
}

function publishedFacilitatorDetail(value: unknown, fallback: string): string {
  const code = facilitatorReasonCode(value)
  if (!code || (!isCallerFailureCode(code) && !X402_UPSTREAM_FAILURE_REASONS.has(code))) return fallback
  return code.replaceAll('_', ' ')
}

function rejectedFacilitatorRequest(
  stage: 'verification' | 'settlement',
  response: Readonly<Record<string, unknown>>,
): UnclassifiedFacilitatorFailure {
  const fields = stage === 'verification'
    ? ['invalidReason', 'errorReason', 'error', 'message']
    : ['errorReason', 'invalidReason', 'error', 'message']
  const detail = fields
    .map(field => publishedFacilitatorDetail(response[field], ''))
    .find(candidate => candidate.length > 0)
  return {
    status: 'unclassified',
    reason: `payment facilitator rejected the ${stage} request${detail ? `: ${detail}` : ''}; ` +
      "it did not identify whether the X-PAYMENT proof, the market's payment requirements, " +
      'or facilitator request handling was at fault' +
      (stage === 'settlement' ? '; do not pay again' : ''),
  }
}

async function facilitatorResponse(
  path: '/verify' | '/settle',
  opts: RequestInit,
): Promise<FacilitatorResponse> {
  const stage = path === '/verify' ? 'verification' : 'settlement'
  let response: Response
  try {
    response = await fetch(`${FACILITATOR}${path}`, opts)
  } catch {
    return facilitatorUnavailable(stage)
  }
  let decoded: unknown
  try {
    decoded = await response.json()
  } catch {
    return response.ok ? facilitatorUnreadable(stage) : facilitatorUnavailable(stage)
  }
  if (!isRecord(decoded)) {
    return response.ok ? facilitatorUnreadable(stage) : facilitatorUnavailable(stage)
  }
  if (!response.ok) {
    if (response.status === 408 || response.status === 425 || response.status === 429) {
      return facilitatorHttpUnavailable(stage, response.status)
    }
    if (
      path === '/settle' && response.status === 409 && decoded.success === false &&
      facilitatorReasonCode(decoded.errorReason) === 'duplicate_settlement'
    ) {
      return settlementInFlight('already in flight')
    }
    const requestRejected = response.status >= 400 && response.status < 500
    const explicitProtocolFailure = (response.status === 400 || response.status === 402) && (
      (path === '/verify' && decoded.isValid === false) ||
      (path === '/settle' && decoded.success === false)
    )
    if (explicitProtocolFailure) return { status: 'ok', value: decoded, httpStatus: response.status }
    return requestRejected ? rejectedFacilitatorRequest(stage, decoded) : facilitatorUnavailable(stage)
  }
  return { status: 'ok', value: decoded, httpStatus: response.status }
}

/**
 * Verify then settle an X-PAYMENT header against the facilitator. Settle happens
 * BEFORE anything is delivered — verify alone is raceable (the buyer could move
 * the balance away). Every result distinguishes verified, caller-invalid, and
 * unclassified facilitator rejections, and retryable upstream-unavailable outcomes.
 */
export async function settleX402(paymentHeader: string, reqs: PaymentRequirements): Promise<X402Settlement> {
  let paymentPayload: unknown
  try {
    paymentPayload = JSON.parse(Buffer.from(paymentHeader, 'base64').toString('utf8'))
  } catch {
    return invalid('X-PAYMENT header is not valid base64 JSON')
  }
  if (!isRecord(paymentPayload)) return invalid('X-PAYMENT header must contain one payment proof object')
  const body = JSON.stringify({ x402Version: 1, paymentPayload, paymentRequirements: reqs })
  const opts = { method: 'POST', headers: { 'content-type': 'application/json' }, body }

  const verification = await facilitatorResponse('/verify', opts)
  if (verification.status !== 'ok') return verification
  if (typeof verification.value.isValid !== 'boolean') return facilitatorUnreadable('verification')
  if (!verification.value.isValid) {
    const callerReason = callerFailureReason(verification.value.invalidReason)
    if (callerReason) return invalid(callerReason)
    const code = facilitatorReasonCode(verification.value.invalidReason)
    if (verification.httpStatus === 402) {
      return terminalFacilitatorRejection(
        'verification',
        code && X402_UPSTREAM_FAILURE_REASONS.has(code) ? code.replaceAll('_', ' ') : '',
      )
    }
    if (code && X402_UPSTREAM_FAILURE_REASONS.has(code)) {
      return {
        status: 'unavailable',
        reason: `payment facilitator could not verify X-PAYMENT: ${code.replaceAll('_', ' ')}; ` +
          'retry this request with the same X-PAYMENT proof later',
      }
    }
    return terminalFacilitatorRejection('verification')
  }

  const settlementResult = await facilitatorResponse('/settle', opts)
  if (settlementResult.status !== 'ok') return settlementResult
  const settlement = settlementResult.value
  if (typeof settlement.success !== 'boolean') return facilitatorUnreadable('settlement')
  if (!settlement.success) {
    const callerReason = callerFailureReason(settlement.errorReason)
    if (callerReason) return invalid(callerReason)
    const code = facilitatorReasonCode(settlement.errorReason)
    if (settlementResult.httpStatus === 402) {
      return terminalFacilitatorRejection(
        'settlement',
        code && X402_UPSTREAM_FAILURE_REASONS.has(code) ? code.replaceAll('_', ' ') : '',
      )
    }
    if (code === 'settlement_pending') return settlementInFlight('pending')
    if (code === 'duplicate_settlement') return settlementInFlight('already in flight')
    if (code === 'transaction_failed') return settlementTransactionFailed()
    if (!code || !X402_UPSTREAM_FAILURE_REASONS.has(code)) {
      return terminalFacilitatorRejection('settlement')
    }
    const detail = code.replaceAll('_', ' ')
    return {
      status: 'unavailable',
      reason: `payment facilitator did not confirm settlement: ${detail}; ` +
        'retry this request with the same X-PAYMENT proof later; do not pay again',
    }
  }
  const transaction = canonicalTxHash(settlement.transaction)
  if (!transaction || (settlement.payer !== undefined && typeof settlement.payer !== 'string')) {
    return facilitatorUnreadable('settlement')
  }

  const payer = settlement.payer
    ?? String((paymentPayload as { payload?: { authorization?: { from?: string } } })?.payload?.authorization?.from ?? '')
  return { status: 'verified', transaction, payer, raw: settlement }
}

export function paymentResponseHeader(settled: Settled): string {
  return Buffer.from(JSON.stringify(settled.raw)).toString('base64')
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
): Promise<
  | { status: 'verified'; from: string; amount: string; blockTime: Date }
  | VerificationFailure
> {
  const canonical = canonicalTxHash(txHash)
  if (!canonical) {
    return { status: 'invalid', reason: 'tx_hash must be a 0x-prefixed 32-byte transaction hash' }
  }
  const proof = await verifyUsdcTransfer(canonical, to, toUnits(usdc))
  if (proof.status !== 'verified') return proof
  const transfer = proof.transfer
  if (transfer.blockTime < notBefore) {
    return { status: 'invalid', reason: 'transaction was paid before this payment window opened' }
  }
  return {
    status: 'verified',
    from: transfer.from,
    amount: (Number(transfer.amount) / 1e6).toFixed(6),
    blockTime: transfer.blockTime,
  }
}
