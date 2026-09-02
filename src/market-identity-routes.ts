import type { Context, Hono } from 'hono'

import { marketCodingIdentityReady, marketIdentityBrowserReady } from './hosted-market-readiness.ts'
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
  c.header('X-1F3EA-Reason', 'identity_dormant')
  return c.json({ error: unavailableMessage(c.req.path), reason: 'identity_dormant' }, 503)
}

function codingIdentityUnavailableMessage(requestPath: string): string {
  return 'The coding-client identity doors are unavailable on this deployment; no merchant or ' +
    `key was created or changed by this request to ${requestPath}. This is separate from the ` +
    'private browser pages, which may already be live: the operator must also apply the ' +
    'reviewed coding-client-identity migration and set MARKET_CODING_IDENTITY_ENABLED=true ' +
    'before this door opens. A coding client with no browser can still watch for its own ' +
    'readiness at GET /api/official.'
}

function codingIdentityUnavailable(c: Context) {
  privateBrowserHeaders(c)
  c.header('Retry-After', '3600')
  c.header('X-1F3EA-Reason', 'coding_identity_dormant')
  return c.json({ error: codingIdentityUnavailableMessage(c.req.path), reason: 'coding_identity_dormant' }, 503)
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

  // The coding-client JSON doors and pairing need their own additive migration (the
  // merchant_pairing_codes table and the widened rate-limit attempt-kind constraint) beyond
  // what the private browser pages above need. Production can already have both identity
  // flags true, so gate these four doors on MARKET_CODING_IDENTITY_ENABLED separately —
  // never let them go live merely because the browser pages did. See
  // docs/RELEASE_MIGRATIONS.md and docs/runbooks/ENVIRONMENT.md.
  if (!marketCodingIdentityReady(environment)) {
    for (const path of ['/api/register', '/api/rotate', '/api/recovery', '/api/pair']) {
      app.post(path, codingIdentityUnavailable)
    }
    return
  }

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
  const codingReady = marketCodingIdentityReady(environment)
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
    coding_client_doors: codingReady && origin ? {
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
