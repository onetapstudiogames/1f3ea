import type { VerificationFailure } from './chain.ts'
import { canonicalTxHash, type PaymentRequirements } from './x402-contract.ts'

const FACILITATOR = process.env.FACILITATOR_URL ?? 'https://facilitator.payai.network'
const FACILITATOR_TIMEOUT_MS = 8_000
const MAX_FACILITATOR_RESPONSE_BYTES = 65_536

export interface Settled {
  status: 'verified'
  transaction: string
  payer: string
  raw: X402SettlementReceipt
}

export interface X402SettlementReceipt {
  success: true
  transaction: string
  network: 'base'
  payer: string
}

export interface UnclassifiedFacilitatorFailure {
  status: 'unclassified'
  reason: string
}

type X402VerificationOutcome =
  | { status: 'approved' }
  | VerificationFailure
  | UnclassifiedFacilitatorFailure

export type X402SettlementOutcome =
  | Settled
  | VerificationFailure
  | UnclassifiedFacilitatorFailure

type FacilitatorResponse =
  | { status: 'ok'; value: Record<string, unknown>; httpStatus: number }
  | VerificationFailure
  | UnclassifiedFacilitatorFailure

type BoundedJson =
  | { status: 'ok'; value: Record<string, unknown> }
  | { status: 'too_large' }
  | { status: 'unreadable' }

interface PreparedX402Payment {
  payerWallet: string
  opts: RequestInit
}

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

function facilitatorTooLarge(stage: 'verification' | 'settlement'): VerificationFailure {
  return {
    status: 'unavailable',
    reason: `payment facilitator ${stage} response was too large; retry this request with the same X-PAYMENT proof later` +
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

async function boundedJson(response: Response): Promise<BoundedJson> {
  if (!response.body) return { status: 'unreadable' }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > MAX_FACILITATOR_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined)
        return { status: 'too_large' }
      }
      chunks.push(next.value)
    }
  } catch {
    await reader.cancel().catch(() => undefined)
    return { status: 'unreadable' }
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes))
    return isRecord(value) ? { status: 'ok', value } : { status: 'unreadable' }
  } catch {
    return { status: 'unreadable' }
  }
}

async function facilitatorResponse(
  path: '/verify' | '/settle',
  opts: RequestInit,
): Promise<FacilitatorResponse> {
  const stage = path === '/verify' ? 'verification' : 'settlement'
  let response: Response
  try {
    response = await fetch(`${FACILITATOR}${path}`, {
      ...opts,
      redirect: 'error',
      signal: AbortSignal.timeout(FACILITATOR_TIMEOUT_MS),
    })
  } catch {
    return facilitatorUnavailable(stage)
  }
  const decoded = await boundedJson(response)
  if (decoded.status === 'too_large') return facilitatorTooLarge(stage)
  if (decoded.status === 'unreadable') {
    return response.ok ? facilitatorUnreadable(stage) : facilitatorUnavailable(stage)
  }
  if (!response.ok) {
    if (response.status === 408 || response.status === 425 || response.status === 429) {
      return facilitatorHttpUnavailable(stage, response.status)
    }
    if (
      path === '/settle' && response.status === 409 && decoded.value.success === false &&
      facilitatorReasonCode(decoded.value.errorReason) === 'duplicate_settlement'
    ) {
      return settlementInFlight('already in flight')
    }
    const requestRejected = response.status >= 400 && response.status < 500
    const explicitProtocolFailure = (response.status === 400 || response.status === 402) && (
      (path === '/verify' && decoded.value.isValid === false) ||
      (path === '/settle' && decoded.value.success === false)
    )
    if (explicitProtocolFailure) {
      return { status: 'ok', value: decoded.value, httpStatus: response.status }
    }
    return requestRejected
      ? rejectedFacilitatorRequest(stage, decoded.value)
      : facilitatorUnavailable(stage)
  }
  return { status: 'ok', value: decoded.value, httpStatus: response.status }
}

export function prepareX402Payment(
  paymentPayload: Record<string, unknown>,
  reqs: PaymentRequirements,
  payerWallet: string,
): PreparedX402Payment {
  const body = JSON.stringify({ x402Version: 1, paymentPayload, paymentRequirements: reqs })
  return {
    payerWallet,
    opts: { method: 'POST', headers: { 'content-type': 'application/json' }, body },
  }
}

export async function verifyPreparedX402(
  prepared: PreparedX402Payment,
): Promise<X402VerificationOutcome> {
  const verification = await facilitatorResponse('/verify', prepared.opts)
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
  return { status: 'approved' }
}

export async function settlePreparedX402(
  prepared: PreparedX402Payment,
): Promise<X402SettlementOutcome> {
  const settlementResult = await facilitatorResponse('/settle', prepared.opts)
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
  if (
    !transaction
    || (settlement.payer !== undefined && (
      typeof settlement.payer !== 'string'
      || settlement.payer.toLowerCase() !== prepared.payerWallet
    ))
  ) {
    return facilitatorUnreadable('settlement')
  }
  const payer = prepared.payerWallet
  return {
    status: 'verified',
    transaction,
    payer,
    raw: { success: true, transaction, network: 'base', payer },
  }
}
