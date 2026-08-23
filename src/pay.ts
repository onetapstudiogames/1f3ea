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
  transaction: string
  payer: string
  raw: Record<string, unknown>
}

/**
 * Verify then settle an X-PAYMENT header against the facilitator. Settle happens
 * BEFORE anything is delivered — verify alone is raceable (the buyer could move
 * the balance away). Returns { error } on failure with the facilitator's reason.
 */
export async function settleX402(paymentHeader: string, reqs: PaymentRequirements): Promise<Settled | { error: string }> {
  let paymentPayload: unknown
  try {
    paymentPayload = JSON.parse(Buffer.from(paymentHeader, 'base64').toString('utf8'))
  } catch {
    return { error: 'X-PAYMENT header is not base64 JSON' }
  }
  const body = JSON.stringify({ x402Version: 1, paymentPayload, paymentRequirements: reqs })
  const opts = { method: 'POST', headers: { 'content-type': 'application/json' }, body }

  try {
    const vr = await fetch(`${FACILITATOR}/verify`, opts)
    const verdict = (await vr.json().catch(() => null)) as { isValid?: boolean; invalidReason?: string } | null
    if (!vr.ok || !verdict?.isValid) return { error: verdict?.invalidReason ?? 'facilitator rejected the payment' }

    const sr = await fetch(`${FACILITATOR}/settle`, opts)
    const settlement = (await sr.json().catch(() => null)) as
      | { success?: boolean; transaction?: string; payer?: string; errorReason?: string }
      | null
    if (!sr.ok || !settlement?.success || !settlement.transaction)
      return { error: settlement?.errorReason ?? 'settlement failed' }
    const transaction = canonicalTxHash(settlement.transaction)
    if (!transaction) return { error: 'settlement returned an invalid transaction hash' }

    const payer = settlement.payer
      ?? String((paymentPayload as { payload?: { authorization?: { from?: string } } })?.payload?.authorization?.from ?? '')
    return { transaction, payer, raw: settlement as Record<string, unknown> }
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
