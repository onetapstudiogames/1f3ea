import type { Context, Hono } from 'hono'

import { marketIdentityBrowserReady } from './hosted-market-readiness.ts'
import { mountMarketIdentityBrowserRoutes } from './market-identity-browser.ts'
import {
  marketPublicOrigin,
  type MarketOAuthEnvironment,
} from './market-oauth-config.ts'
import { privateBrowserHeaders } from './private-browser.ts'
import { HOSTED_PROOF_CONTRACT, HOSTED_PROVEN_HOSTS } from './public-contracts.ts'

export type MarketIdentityRouteOptions = Readonly<{
  environment?: MarketOAuthEnvironment
  hostedMarketSigninReady?: boolean
}>

function unavailableMessage(requestPath: string): string {
  const retryPath = requestPath === '/api/register' ? '/join'
    : requestPath === '/api/rotate' ? '/rotate'
      : requestPath
  return 'Private merchant identity is unavailable on this deployment; no merchant or key was created or changed. ' +
    `The operator must apply the reviewed migration and enable both identity flags before you retry ${retryPath}.`
}

function unavailableIdentity(c: Context) {
  privateBrowserHeaders(c)
  c.header('Retry-After', '3600')
  return c.json({ error: unavailableMessage(c.req.path) }, 503)
}

export function mountMarketIdentityRoutes(
  app: Hono,
  options: MarketIdentityRouteOptions = {},
): void {
  const environment = options.environment ?? process.env
  if (!marketIdentityBrowserReady(environment)) {
    for (const path of ['/join', '/recovery', '/rotate']) app.all(path, unavailableIdentity)
    app.post('/api/register', unavailableIdentity)
    app.post('/api/rotate', unavailableIdentity)
    return
  }

  const origin = marketPublicOrigin(environment)
  mountMarketIdentityBrowserRoutes(app, {
    environment,
    hostedMarketSigninReady: options.hostedMarketSigninReady === true,
  })
  app.post('/api/register', c => {
    privateBrowserHeaders(c)
    return c.json({
      error: `Merchant registration moved to the private no-store browser flow at ${origin}/join; no merchant or key was created.`,
    }, 410)
  })
  app.post('/api/rotate', c => {
    privateBrowserHeaders(c)
    return c.json({
      error: `Merchant-key rotation moved to the private no-store browser flow at ${origin}/rotate; no key was changed.`,
    }, 410)
  })
}

export function marketIdentityPublicFacts(
  environment: MarketOAuthEnvironment = process.env,
  hostedMarketSigninReady = false,
) {
  const ready = marketIdentityBrowserReady(environment)
  const origin = ready ? marketPublicOrigin(environment) : null
  const hostedReady = ready && hostedMarketSigninReady
  return {
    join: origin ? `${origin}/join` : null,
    recovery: origin ? `${origin}/recovery` : null,
    recovery_enabled: ready,
    rotate: origin ? `${origin}/rotate` : null,
    rotation_enabled: ready,
    hosted_connector: hostedReady ? `${origin}/mcp/connect` : null,
    hosted_status: hostedReady ? HOSTED_PROOF_CONTRACT : 'dormant',
    hosted_proven_hosts: HOSTED_PROVEN_HOSTS,
    legacy_registration: 'retired',
    merchant_key_transport: 'first-party no-store browser only; never API, MCP, chat, URL, or log output',
  } as const
}
