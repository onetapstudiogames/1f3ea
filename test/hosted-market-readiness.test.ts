import test from 'node:test'
import assert from 'node:assert/strict'

import {
  hostedMarketSigninReadiness,
  marketCodingIdentityReady,
  marketIdentityBrowserReady,
} from '../src/hosted-market-readiness.ts'

const READY = {
  PUBLIC_ORIGIN: 'https://1f3ea.com',
  HOSTED_MARKET_SIGNIN_ENABLED: 'true',
  MARKET_IDENTITY_RECOVERY_ENABLED: 'true',
  MARKET_IDENTITY_ROTATION_ENABLED: 'true',
} as const

test('identity and hosted merchant ceremonies stay dormant until every explicit release flag is true', () => {
  assert.equal(marketIdentityBrowserReady({}), false)
  assert.equal(marketIdentityBrowserReady({ MARKET_IDENTITY_RECOVERY_ENABLED: 'true' }), false)
  assert.equal(marketIdentityBrowserReady({
    MARKET_IDENTITY_RECOVERY_ENABLED: 'true',
    MARKET_IDENTITY_ROTATION_ENABLED: 'true',
  }), true)
  assert.equal(marketIdentityBrowserReady({
    MARKET_IDENTITY_RECOVERY_ENABLED: 'true',
    MARKET_IDENTITY_ROTATION_ENABLED: 'true',
    PUBLIC_ORIGIN: 'http://1f3ea.com',
  }), false)

  for (const missing of Object.keys(READY)) {
    const environment = { ...READY } as Record<string, string | undefined>
    delete environment[missing]
    assert.deepEqual(hostedMarketSigninReadiness(environment), { ready: false }, missing)
  }
  assert.deepEqual(hostedMarketSigninReadiness(READY), {
    ready: true,
    origin: 'https://1f3ea.com',
  })
})

test('coding-client identity doors stay dormant on the browser-ready flags alone', () => {
  assert.equal(marketCodingIdentityReady({}), false)
  assert.equal(marketCodingIdentityReady({
    MARKET_IDENTITY_RECOVERY_ENABLED: 'true',
    MARKET_IDENTITY_ROTATION_ENABLED: 'true',
  }), false, 'production already has both identity flags true without the coding-identity migration')
  assert.equal(marketCodingIdentityReady({
    MARKET_CODING_IDENTITY_ENABLED: 'true',
  }), false, 'the coding-identity flag alone cannot skip the browser-identity gate')
  assert.equal(marketCodingIdentityReady({
    MARKET_IDENTITY_RECOVERY_ENABLED: 'true',
    MARKET_IDENTITY_ROTATION_ENABLED: 'true',
    MARKET_CODING_IDENTITY_ENABLED: 'true',
  }), true)
})

test('bad enabled startup configuration fails dormant instead of taking public market routes down', () => {
  for (const environment of [
    { ...READY, PUBLIC_ORIGIN: 'http://1f3ea.com' },
    { ...READY, HOSTED_MARKET_OAUTH_CLIENTS: '{bad json' },
    { ...READY, HOSTED_MARKET_CIMD_ORIGINS: '["https://evil.example/path"]' },
  ]) {
    assert.deepEqual(hostedMarketSigninReadiness(environment), { ready: false })
  }
})
