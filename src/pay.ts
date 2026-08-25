import type { Context } from 'hono'
import { NETWORK, USDC, toUnits, verifyUsdcTransfer } from './chain.ts'

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

export const TREASURY = (
  process.env.TREASURY_ADDRESS ?? '0x3b9d230c9b995fb1a10add2d63ce37437916dcfd'
).toLowerCase()
export const LISTING_FEE_USDC = 1
const FACILITATOR = process.env.FACILITATOR_URL ?? 'https://facilitator.payai.network'
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/
const MAX_PAYMENT_HEADER_BYTES = 32_768
const MAX_FACILITATOR_RESPONSE_BYTES = 65_536
const FACILITATOR_TIMEOUT_MS = 8_000
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

function formatUsdcAmount(amountUnits: string): string {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(amountUnits)) {
    throw new TypeError('payment requirement amount must use integer USDC units')
  }
  const units = BigInt(amountUnits)
  const whole = units / 1_000_000n
  const fraction = (units % 1_000_000n).toString().padStart(6, '0')
  return `${whole}.${fraction}`
}

export function challenge402(c: Context, reqs: PaymentRequirements, note: string) {
  const amountUsdc = formatUsdcAmount(reqs.maxAmountRequired)
  const warning =
    'Never copy a recipient from wallet history; zero-value lookalike transfers can poison wallet history.'
  return c.json({
    x402Version: 1,
    error:
      `${note} Pay exactly ${amountUsdc} USDC on Base using contract ${reqs.asset} ` +
      `to ${reqs.payTo}. Verify with this current 402 response or /api/official. ${warning}`,
    payment_safety: {
      network: 'Base',
      usdc_contract: reqs.asset,
      recipient: reqs.payTo,
      amount_usdc: amountUsdc,
      amount_units: reqs.maxAmountRequired,
      verify_with: 'this current 402 response or /api/official',
      warning,
    },
    accepts: [reqs],
  }, 402)
}

export interface Settled {
  transaction: string
  payer: string
  raw: Record<string, unknown>
}

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

async function boundedJson(
  response: Response,
  label: string,
): Promise<{ value: Record<string, unknown> | null; error?: string }> {
  if (!response.body) return { value: null }
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
        return { value: null, error: `${label} response was too large` }
      }
      chunks.push(next.value)
    }
  } catch {
    return { value: null, error: `${label} response could not be read` }
  }

  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return { value: record(JSON.parse(new TextDecoder().decode(bytes))) }
  } catch {
    return { value: null }
  }
}

function facilitatorRequest(body: string): RequestInit {
  return {
    method: 'POST',
    redirect: 'error',
    headers: { 'content-type': 'application/json' },
    body,
    signal: AbortSignal.timeout(FACILITATOR_TIMEOUT_MS),
  }
}

/**
 * Verify then settle an X-PAYMENT header against the facilitator. Settle happens
 * BEFORE anything is delivered — verify alone is raceable (the buyer could move
 * the balance away). Returns { error } on failure with the facilitator's reason.
 */
export async function settleX402(paymentHeader: string, reqs: PaymentRequirements): Promise<Settled | { error: string }> {
  if (paymentHeader.length === 0 || paymentHeader.length > MAX_PAYMENT_HEADER_BYTES) {
    return { error: 'X-PAYMENT header is too large' }
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(paymentHeader) || paymentHeader.length % 4 !== 0) {
    return { error: 'X-PAYMENT header is not base64 JSON' }
  }
  let paymentPayload: unknown
  try {
    paymentPayload = JSON.parse(Buffer.from(paymentHeader, 'base64').toString('utf8'))
  } catch {
    return { error: 'X-PAYMENT header is not base64 JSON' }
  }
  const body = JSON.stringify({ x402Version: 1, paymentPayload, paymentRequirements: reqs })

  try {
    const vr = await fetch(`${FACILITATOR}/verify`, facilitatorRequest(body))
    const verification = await boundedJson(vr, 'facilitator verification')
    if (verification.error) return { error: verification.error }
    const invalidReason = typeof verification.value?.invalidReason === 'string'
      ? verification.value.invalidReason
      : 'facilitator rejected the payment'
    if (!vr.ok || verification.value?.isValid !== true) return { error: invalidReason }

    const sr = await fetch(`${FACILITATOR}/settle`, facilitatorRequest(body))
    const decoded = await boundedJson(sr, 'facilitator settlement')
    if (decoded.error) return { error: decoded.error }
    const settlement = decoded.value
    const errorReason = typeof settlement?.errorReason === 'string'
      ? settlement.errorReason
      : 'settlement failed'
    if (!sr.ok || settlement?.success !== true || typeof settlement.transaction !== 'string') {
      return { error: errorReason }
    }
    const transaction = canonicalTxHash(settlement.transaction)
    if (!transaction) return { error: 'settlement returned an invalid transaction hash' }

    const payer = typeof settlement.payer === 'string'
      ? settlement.payer
      : String((paymentPayload as { payload?: { authorization?: { from?: string } } })?.payload?.authorization?.from ?? '')
    return { transaction, payer, raw: settlement }
  } catch {
    return { error: 'facilitator unreachable — start a fresh signed direct-payment intent before paying' }
  }
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
): Promise<{ from: string; amount: string; blockTime: Date } | null> {
  const canonical = canonicalTxHash(txHash)
  if (!canonical) return null
  const v = await verifyUsdcTransfer(canonical, to, toUnits(usdc))
  if (!v) return null
  if (v.blockTime < notBefore) return null
  return { from: v.from, amount: (Number(v.amount) / 1e6).toFixed(6), blockTime: v.blockTime }
}
