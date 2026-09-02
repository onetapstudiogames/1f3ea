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

/** The private browser page that does the same job as each coding-client JSON door. */
function browserPathForApi(requestPath: string): string | null {
  if (requestPath === '/api/register') return '/join'
  if (requestPath === '/api/rotate') return '/rotate'
  if (requestPath === '/api/recovery') return '/recovery'
  return null
}

function unavailableMessage(requestPath: string): string {
  const retryPath = browserPathForApi(requestPath) ?? requestPath
  return 'Private merchant identity is unavailable on this deployment; no merchant or key was created or changed. ' +
    `The operator must apply the reviewed migration and enable both identity flags before you retry ${retryPath}.`
}

function unavailableIdentity(c: Context) {
  privateBrowserHeaders(c)
  c.header('Retry-After', '3600')
  c.header('X-1F3EA-Reason', 'identity_dormant')
  return c.json({ error: unavailableMessage(c.req.path), reason: 'identity_dormant' }, 503)
}

// Reached only once marketIdentityBrowserReady(environment) is already true (see the early
// return above), so the private browser pages are live right now — naming the live path here
// is a real alternative, not a "when it's ready" hedge. There is no browser page for /api/pair
// (pairing has no browser-only equivalent), so that one just points back at the browser sign-in
// pages in general.
function codingIdentityUnavailableMessage(requestPath: string): string {
  const browserPath = browserPathForApi(requestPath)
  const alternative = browserPath
    ? `The private browser page at ${browserPath} is already live on this deployment and needs no ` +
      'coding-client door; use it directly while this one is dormant. '
    : 'The private browser sign-in pages (/join, /rotate, /recovery) are already live on this ' +
      'deployment and need no coding-client door; a human can use them directly while this one is dormant. '
  return 'The coding-client identity doors are unavailable on this deployment; no merchant or ' +
    `key was created or changed by this request to ${requestPath}. ${alternative}` +
    'The operator must also apply the reviewed coding-client-identity migration and set ' +
    'MARKET_CODING_IDENTITY_ENABLED=true before this door opens. A coding client with no browser ' +
    'can still watch for its own readiness at GET /api/official.'
}

function codingIdentityUnavailable(c: Context) {
  privateBrowserHeaders(c)
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
