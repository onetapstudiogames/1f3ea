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
} as const

test('dormant identity routes return one private caller-worded refusal without credentials', async () => {
  const app = new Hono()
  mountMarketIdentityRoutes(app, { environment: {} })

  for (const [path, method, retryPath] of [
    ['/join', 'GET', '/join'], ['/recovery', 'GET', '/recovery'], ['/rotate', 'GET', '/rotate'],
    ['/api/register', 'POST', '/join'], ['/api/rotate', 'POST', '/rotate'],
  ] as const) {
    const response = await app.request(path, { method })
    assert.equal(response.status, 503, path)
    assert.equal(response.headers.get('cache-control'), 'no-store', path)
    assert.equal(response.headers.get('access-control-allow-origin'), null, path)
    const text = await response.text()
    assert.match(text, /private merchant identity.*unavailable.*no merchant or key was (?:created|changed)/iu)
    assert.match(text, new RegExp(`retry ${retryPath}`, 'iu'), path)
    assert.doesNotMatch(text, /1f3ea_(?:sk|rc|at|rt|ac)_[0-9a-f]+/iu)
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
    merchant_key_transport: 'first-party no-store browser only; never API, MCP, chat, URL, or log output',
  })
})

test('enabled identity routes retire JSON credential delivery and publish the exact live paths', async () => {
  const app = new Hono()
  mountMarketIdentityRoutes(app, { environment: READY, hostedMarketSigninReady: true })

  for (const [path, movedTo] of [
    ['/api/register', '/join'], ['/api/rotate', '/rotate'],
  ] as const) {
    const response = await app.request(path, { method: 'POST' })
    assert.equal(response.status, 410, path)
    assert.equal(response.headers.get('cache-control'), 'no-store', path)
    assert.equal(response.headers.get('access-control-allow-origin'), null, path)
    const text = await response.text()
    assert.match(text, new RegExp(`https://market\\.test${movedTo}`))
    assert.match(text, /no (?:merchant or )?key was (?:created|changed)/iu)
    assert.doesNotMatch(text, /1f3ea_(?:sk|rc|at|rt|ac)_[0-9a-f]+/iu)
  }
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
    merchant_key_transport: 'first-party no-store browser only; never API, MCP, chat, URL, or log output',
  })
})
