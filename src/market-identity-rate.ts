import type { Context } from 'hono'
import { sha256 } from './core.ts'
import type { MarketIdentityAttemptKind, MarketIdentityStore } from './market-identity-store.ts'
import type { MarketOAuthEnvironment } from './market-oauth-config.ts'

/** The caller's IP on Vercel, or 'unknown' off-platform — shared bucket key for every identity door. */
export function identityClientAddress(c: Context, environment: MarketOAuthEnvironment): string {
  if (environment.VERCEL !== '1') return 'unknown'
  return c.req.header('x-vercel-forwarded-for')?.split(',')
    .map(part => part.trim()).filter(Boolean).at(-1) ?? 'unknown'
}

/**
 * Admits one hashed attempt in every named bucket for this UTC-hour window. Shared by the
 * browser ceremonies, the JSON doors, and pairing so a caller cannot dodge one path's limit
 * by switching to the other.
 */
export async function admittedMarketIdentity(
  store: MarketIdentityStore,
  attemptKind: MarketIdentityAttemptKind,
  buckets: readonly string[],
  maximum: number,
): Promise<boolean> {
  for (const bucket of buckets) {
    if (!(await store.consumeMarketIdentityRateLimit({
      bucketHash: sha256(`market-identity:${attemptKind}:${bucket}`),
      attemptKind,
      maximum,
    }))) return false
  }
  return true
}
