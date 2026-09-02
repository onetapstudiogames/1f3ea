import type { Context, Hono } from 'hono'

import { marketIdentityBrowserReady } from './hosted-market-readiness.ts'
import { mountMarketIdentityBrowserRoutes } from './market-identity-browser.ts'
import { mountMarketIdentityJsonRoutes } from './market-identity-json-routes.ts'
import {
  marketPublicOrigin,
  type MarketOAuthEnvironment,
} from './market-oauth-config.ts'
import { mountMarketPairingRoutes } from './market-pairing-routes.ts'
import { privateBrowserHeaders } from './private-browser.ts'
import { HOSTED_PROOF_CONTRACT, HOSTED_PROVEN_HOSTS } from './public-contracts.ts'

export type MarketIdentityRouteOptions = Readonly<{
  environment?: MarketOAuthEnvironment
  hostedMarketSigninReady?: boolean
}>

function unavailableMessage(requestPath: string): string {
  const retryPath = requestPath === '/api/register' ? '/join'
    : requestPath === '/api/rotate' ? '/rotate'
      : requestPath === '/api/recovery' ? '/recovery'
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
    for (const path of ['/api/register', '/api/rotate', '/api/recovery', '/api/pair']) {
      app.post(path, unavailableIdentity)
    }
    return
  }

  mountMarketIdentityBrowserRoutes(app, {
    environment,
    hostedMarketSigninReady: options.hostedMarketSigninReady === true,
  })
  mountMarketIdentityJsonRoutes(app, { environment })
  mountMarketPairingRoutes(app, {
    environment,
    hostedMarketSigninReady: options.hostedMarketSigninReady === true,
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
    merchant_key_transport:
      'first-party no-store browser ceremony, or the authenticated coding_client_doors JSON contract below; ' +
      'never chat, MCP arguments or results, URLs, or logs',
    coding_client_doors: origin ? {
      register: `${origin}/api/register`,
      rotate: `${origin}/api/rotate`,
      recovery: `${origin}/api/recovery`,
      pair: `${origin}/api/pair`,
      client_classes: ['coding_persistent', 'coding_ephemeral'],
      registration_requires_human_approved: true,
      key_and_codes_shown_exactly_once: true,
    } : null,
  } as const
}
