import {
  hostedMarketSigninEnabled,
  marketPublicOrigin,
  parseMarketCimdOrigins,
  parseMarketOAuthClients,
  type MarketOAuthEnvironment,
} from './market-oauth-config.ts'

export type HostedMarketSigninReadiness =
  | Readonly<{ ready: false }>
  | Readonly<{ ready: true; origin: string }>

export function marketIdentityBrowserReady(
  environment: MarketOAuthEnvironment = process.env,
): boolean {
  if (
    environment.MARKET_IDENTITY_RECOVERY_ENABLED !== 'true' ||
    environment.MARKET_IDENTITY_ROTATION_ENABLED !== 'true'
  ) return false
  try {
    marketPublicOrigin(environment)
    return true
  } catch {
    return false
  }
}

/**
 * The coding-client JSON identity doors (POST /api/register, /api/rotate, /api/recovery) and
 * pairing (POST /api/pair) need the additive coding-client-identity migration — the
 * merchant_pairing_codes table and the widened merchant_identity_rate_limits attempt-kind
 * constraint — in addition to everything marketIdentityBrowserReady already requires for the
 * private browser pages. Production can (and, as of 2026-09-01, does) already have both
 * identity flags on before that migration has run, so this is deliberately a separate flag an
 * operator sets only after the migration runner reports every postcondition present: it never
 * turns on merely because the browser pages are ready.
 */
export function marketCodingIdentityReady(
  environment: MarketOAuthEnvironment = process.env,
): boolean {
  return marketIdentityBrowserReady(environment) &&
    environment.MARKET_CODING_IDENTITY_ENABLED === 'true'
}

export function hostedMarketSigninReadiness(
  environment: MarketOAuthEnvironment = process.env,
): HostedMarketSigninReadiness {
  if (!hostedMarketSigninEnabled(environment) || !marketIdentityBrowserReady(environment)) {
    return { ready: false }
  }

  try {
    if (!environment.PUBLIC_ORIGIN) return { ready: false }
    const origin = marketPublicOrigin(environment)
    const staticClients = parseMarketOAuthClients(environment.HOSTED_MARKET_OAUTH_CLIENTS)
    const cimdOrigins = parseMarketCimdOrigins(environment.HOSTED_MARKET_CIMD_ORIGINS)
    if (staticClients.length === 0 && cimdOrigins.length === 0) return { ready: false }
    return { ready: true, origin }
  } catch {
    return { ready: false }
  }
}
