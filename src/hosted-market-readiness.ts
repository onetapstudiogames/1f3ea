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
