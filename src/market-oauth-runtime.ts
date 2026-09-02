// Shared per-request OAuth runtime shape and small helpers used by both market-oauth.ts (the
// authorize/token/revoke doors) and market-oauth-pairing.ts (the "pair" authorize action).
// Kept in its own module so those two never import each other.
import { randomBytes } from 'node:crypto'
import type { Context } from 'hono'

import { sha256 } from './core.ts'
import { clearBrowserSessionCookie } from './browser-session.ts'
import { MARKET_OAUTH_SESSION_COOKIE as SESSION_COOKIE } from './market-oauth-browser.ts'
import {
  parseMarketCimdOrigins,
  parseMarketOAuthClients,
  type MarketOAuthEnvironment,
} from './market-oauth-config.ts'
import type { MarketOAuthStore, OAuthAttemptKind } from './market-oauth-store.ts'
import { privateBrowserHeaders as privateHeaders } from './private-browser.ts'

export interface Runtime {
  environment: MarketOAuthEnvironment
  store: MarketOAuthStore
  fetcher: typeof fetch
  origin: string
  resource: string
  staticClients: ReturnType<typeof parseMarketOAuthClients>
  cimdOrigins: ReturnType<typeof parseMarketCimdOrigins>
}

export function opaque(prefix = ''): string {
  return prefix + randomBytes(32).toString('hex')
}

export function clientAddress(c: Context, environment: MarketOAuthEnvironment): string {
  if (environment.VERCEL !== '1') return 'unknown'
  return (c.req.header('x-vercel-forwarded-for') ?? '').split(',').at(-1)?.trim() || 'unknown'
}

export async function admitted(
  oauth: Runtime,
  buckets: readonly string[],
  attemptKind: OAuthAttemptKind,
  maximum: number,
): Promise<boolean> {
  for (const bucket of buckets) {
    const accepted = await oauth.store.consumeOAuthRateLimit({
      bucketHash: sha256(`market-oauth:${bucket}`), attemptKind, maximum,
    })
    if (!accepted) return false
  }
  return true
}

export function redirect(c: Context, destination: string): Response {
  privateHeaders(c)
  clearBrowserSessionCookie(c, SESSION_COOKIE)
  return c.redirect(destination, 302)
}

export function callbackUrl(
  redirectUri: string,
  state: string,
  issuer: string,
  values: Readonly<Record<string, string>>,
): string {
  const url = new URL(redirectUri)
  for (const [key, value] of Object.entries({ ...values, state, iss: issuer })) {
    url.searchParams.set(key, value)
  }
  return url.href
}
