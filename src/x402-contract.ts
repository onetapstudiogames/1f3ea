import type { Context } from 'hono'
import { NETWORK, USDC, toUnits } from './chain.ts'
import { X402_PAYMENT_HEADER_MAX_BYTES } from './x402-proof.ts'

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/

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
  extra: { name: 'USD Coin'; version: '2' }
}

const PAYMENT_VERIFICATION_SOURCE =
  'official_facts through the connector or this current 402 response; ' +
  '/api/official if your client can open URLs'
const WALLET_HISTORY_WARNING =
  'Never copy a recipient from wallet history; zero-value lookalike transfers can poison wallet history.'

export function requirements(
  payTo: string,
  usdc: number,
  resource: string,
  description: string,
): PaymentRequirements {
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
  const units = BigInt(reqs.maxAmountRequired)
  const safety = {
    network: 'Base',
    usdc_contract: reqs.asset,
    recipient: reqs.payTo,
    amount_usdc: `${units / 1_000_000n}.${(units % 1_000_000n).toString().padStart(6, '0')}`,
    amount_units: reqs.maxAmountRequired,
    x_payment_max_bytes: X402_PAYMENT_HEADER_MAX_BYTES,
    verify_with: PAYMENT_VERIFICATION_SOURCE,
    warning: WALLET_HISTORY_WARNING,
  } as const
  return c.json({
    x402Version: 1,
    error:
      `${note} Pay exactly ${safety.amount_usdc} USDC on Base using contract ${safety.usdc_contract} ` +
      `to ${safety.recipient}. Keep X-PAYMENT at or under ${safety.x_payment_max_bytes} bytes. ` +
      `Verify with ${safety.verify_with}. ${safety.warning}`,
    payment_safety: safety,
    accepts: [reqs],
  }, 402)
}
