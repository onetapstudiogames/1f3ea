import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'

import {
  marketIdentityPublicFacts,
  mountMarketIdentityRoutes,
} from '../src/market-identity-routes.ts'

const READY = {
  PUBLIC_ORIGIN: 'https://market.test',
  MARKET_IDENTITY_RECOVERY_ENABLED: 'true',
  MARKET_IDENTITY_ROTATION_ENABLED: 'true',
  MARKET_CODING_IDENTITY_ENABLED: 'true',
} as const

test('dormant identity routes return one private caller-worded refusal without credentials', async () => {
  const app = new Hono()
  mountMarketIdentityRoutes(app, { environment: {} })

  for (const [path, method, retryPath] of [
    ['/join', 'GET', '/join'], ['/recovery', 'GET', '/recovery'], ['/rotate', 'GET', '/rotate'],
    ['/api/register', 'POST', '/join'], ['/api/rotate', 'POST', '/rotate'],
    ['/api/recovery', 'POST', '/recovery'], ['/api/pair', 'POST', '/api/pair'],
  ] as const) {
    const response = await app.request(path, { method })
    assert.equal(response.status, 503, path)
    assert.equal(response.headers.get('cache-control'), 'no-store', path)
    assert.equal(response.headers.get('access-control-allow-origin'), null, path)
    assert.equal(response.headers.get('x-1f3ea-reason'), 'identity_dormant', path)
    const parsed = await response.clone().json() as { error: string; reason: string }
    assert.equal(parsed.reason, 'identity_dormant', path)
    const text = await response.text()
    assert.match(text, /private merchant identity.*unavailable.*no merchant or key was (?:created|changed)/iu)
    assert.match(text, new RegExp(`retry ${retryPath.replace('/', '\\/')}`, 'iu'), path)
    assert.doesNotMatch(text, /1f3ea_(?:sk|rc|at|rt|ac|pc)_[0-9a-f]+/iu)
  }
  assert.deepEqual(marketIdentityPublicFacts({}, false), {
    join: null,
    recovery: null,
    recovery_enabled: false,
    rotate: null,
    rotation_enabled: false,
    hosted_connector: null,
    hosted_status: 'dormant',
    hosted_proven_hosts: [],
    legacy_registration: 'retired',
    merchant_key_transport:
      'first-party no-store browser ceremony, or the authenticated coding_client_doors JSON contract below; ' +
      'never chat, MCP arguments or results, URLs, or logs',
    coding_client_doors: null,
  })
})

test('enabled identity routes serve the coding-client JSON doors and pairing, and publish the exact live paths', async () => {
  const app = new Hono()
  mountMarketIdentityRoutes(app, { environment: READY, hostedMarketSigninReady: true })

  // /api/register and /api/rotate no longer return the retired 410 stub: they answer with the
  // new JSON-door contract (a caller-input refusal here, since this request sends no body).
  for (const path of ['/api/register', '/api/rotate', '/api/recovery'] as const) {
    const response = await app.request(path, { method: 'POST' })
    assert.notEqual(response.status, 410, path)
    assert.equal(response.headers.get('cache-control'), 'no-store', path)
    assert.equal(response.headers.get('access-control-allow-origin'), null, path)
    const body = await response.json() as { error: string; reason: string }
    assert.equal(response.status, 400, path)
    assert.equal(body.reason, 'invalid_json', path)
  }

  // /api/pair requires authentication before anything else.
  const pairResponse = await app.request('/api/pair', { method: 'POST' })
  assert.equal(pairResponse.status, 401)
  assert.equal(pairResponse.headers.get('cache-control'), 'no-store')

  assert.deepEqual(marketIdentityPublicFacts(READY, true), {
    join: 'https://market.test/join',
    recovery: 'https://market.test/recovery',
    recovery_enabled: true,
    rotate: 'https://market.test/rotate',
    rotation_enabled: true,
    hosted_connector: 'https://market.test/mcp/connect',
    hosted_status: 'When official facts publishes hosted_connector, hosted discovery works without sign-in. Protected merchant use for a host is proven only after that host completes and records a real protected me read. Recorded proven hosts: none.',
    hosted_proven_hosts: [],
    legacy_registration: 'retired',
    merchant_key_transport:
      'first-party no-store browser ceremony, or the authenticated coding_client_doors JSON contract below; ' +
      'never chat, MCP arguments or results, URLs, or logs',
    coding_client_doors: {
      register: 'https://market.test/api/register',
      rotate: 'https://market.test/api/rotate',
      recovery: 'https://market.test/api/recovery',
      pair: 'https://market.test/api/pair',
      client_classes: ['coding_persistent', 'coding_ephemeral'],
      registration_requires_human_approved: true,
      key_and_codes_shown_exactly_once: true,
    },
  })
})

test('the browser pages go live without the coding-client doors when only the identity flags are set', async () => {
  // This is production's actual 2026-09-01 state: MARKET_IDENTITY_RECOVERY_ENABLED and
  // MARKET_IDENTITY_ROTATION_ENABLED are true, but the additive coding-client-identity
  // migration has not run and MARKET_CODING_IDENTITY_ENABLED is unset. The private browser
  // ceremony must keep working; the four coding-client doors must stay refused.
  const BROWSER_ONLY = {
    PUBLIC_ORIGIN: 'https://market.test',
    MARKET_IDENTITY_RECOVERY_ENABLED: 'true',
    MARKET_IDENTITY_ROTATION_ENABLED: 'true',
  } as const
  const app = new Hono()
  mountMarketIdentityRoutes(app, { environment: BROWSER_ONLY, hostedMarketSigninReady: true })

  for (const path of ['/join', '/recovery', '/rotate'] as const) {
    const response = await app.request(path)
    assert.notEqual(response.status, 503, path)
  }

  for (const path of ['/api/register', '/api/rotate', '/api/recovery', '/api/pair'] as const) {
    const response = await app.request(path, { method: 'POST' })
    assert.equal(response.status, 503, path)
    assert.equal(response.headers.get('cache-control'), 'no-store', path)
    assert.equal(response.headers.get('access-control-allow-origin'), null, path)
    assert.equal(response.headers.get('x-1f3ea-reason'), 'coding_identity_dormant', path)
    const parsed = await response.clone().json() as { error: string; reason: string }
    assert.equal(parsed.reason, 'coding_identity_dormant', path)
    const text = await response.text()
    assert.match(text, /coding-client identity doors are unavailable/iu, path)
    assert.match(text, /no merchant or key was created or changed/iu, path)
    assert.match(text, /MARKET_CODING_IDENTITY_ENABLED=true/u, path)
    assert.doesNotMatch(text, /1f3ea_(?:sk|rc|at|rt|ac|pc)_[0-9a-f]+/iu, path)
  }

  assert.deepEqual(marketIdentityPublicFacts(BROWSER_ONLY, true), {
    join: 'https://market.test/join',
    recovery: 'https://market.test/recovery',
    recovery_enabled: true,
    rotate: 'https://market.test/rotate',
    rotation_enabled: true,
    hosted_connector: 'https://market.test/mcp/connect',
    hosted_status: 'When official facts publishes hosted_connector, hosted discovery works without sign-in. Protected merchant use for a host is proven only after that host completes and records a real protected me read. Recorded proven hosts: none.',
    hosted_proven_hosts: [],
    legacy_registration: 'retired',
    merchant_key_transport:
      'first-party no-store browser ceremony, or the authenticated coding_client_doors JSON contract below; ' +
      'never chat, MCP arguments or results, URLs, or logs',
    coding_client_doors: null,
  })
})
