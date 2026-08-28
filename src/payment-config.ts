import type { Context } from 'hono'

const OFFICIAL_TREASURY = '0x3b9d230c9b995fb1a10add2d63ce37437916dcfd'

const configuredTreasury = process.env.TREASURY_ADDRESS
if (
  !configuredTreasury
  || !/^0x[0-9a-fA-F]{40}$/u.test(configuredTreasury)
  || configuredTreasury.toLowerCase() === '0x0000000000000000000000000000000000000000'
) {
  throw new Error('TREASURY_ADDRESS must be configured as a valid Base address')
}
if (configuredTreasury.toLowerCase() !== OFFICIAL_TREASURY) {
  throw new Error(`TREASURY_ADDRESS must equal the locked public treasury ${OFFICIAL_TREASURY}`)
}

export const TREASURY = OFFICIAL_TREASURY
export const LISTING_FEE_USDC = 1

const PAYMENT_CUSTODY_UNAVAILABLE =
  'payments are temporarily unavailable because the market cannot safely preserve paid retries; do not pay or retry yet'

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
