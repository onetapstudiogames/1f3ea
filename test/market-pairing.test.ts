import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'

import type { Merchant } from '../src/core.ts'
import { mountMarketPairingRoutes, type MarketPairingRouteOptions } from '../src/market-pairing-routes.ts'
import { PAIRING_CODE_RE, PAIRING_CODE_SECONDS } from '../src/market-pairing-store.ts'
import { memoryStore } from './support/market-identity-browser-harness.ts'

const MERCHANT: Merchant = {
  id: 7, handle: 'existing-merchant', model: 'claude', karma: 0,
  joined_at: '2026-01-01T00:00:00.000Z', storefront_line: '', quota_day: '2026-01-01',
  comments_today: 0, votes_today: 0,
}

function harness(options: Partial<MarketPairingRouteOptions> = {}) {
  const app = new Hono()
  mountMarketPairingRoutes(app, {
    environment: { PUBLIC_ORIGIN: 'https://market.test' },
    identityStore: options.identityStore ?? memoryStore().store,
    hostedMarketSigninReady: options.hostedMarketSigninReady,
    createPairingCode: options.createPairingCode,
    authenticate: options.authenticate ?? (async () => MERCHANT),
  })
  return app
}

test('pairing requires authentication before anything else', async () => {
  const app = harness({ authenticate: async () => null })
  const response = await app.request('/api/pair', { method: 'POST' })
  assert.equal(response.status, 401)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const body = await response.json() as { reason: string }
  assert.equal(body.reason, 'auth_required')
})

test('pairing mints a single-use code shown exactly once and never queries by secret', async () => {
  let calledWith: unknown = null
  const app = harness({
    hostedMarketSigninReady: true,
    createPairingCode: async input => {
      calledWith = input
      return { expiresAt: '2026-09-02T00:10:00.000Z' }
    },
  })
  const response = await app.request('/api/pair', {
    method: 'POST', headers: { authorization: `Bearer ${'x'.repeat(10)}` },
  })
  assert.equal(response.status, 200)
  const body = await response.json() as {
    status: string; pairing_code: string; expires_in_seconds: number
    expires_at: string; one_use: boolean; instructions: string
  }
  assert.equal(body.status, 'created')
  assert.match(body.pairing_code, PAIRING_CODE_RE)
  assert.equal(body.expires_in_seconds, PAIRING_CODE_SECONDS)
  assert.equal(body.one_use, true)
  assert.match(body.instructions, /hosted connector sign-in page/iu)
  assert.deepEqual(calledWith, { merchantId: MERCHANT.id, codeHash: (calledWith as { codeHash: string }).codeHash })
  assert.match((calledWith as { codeHash: string }).codeHash, /^[0-9a-f]{64}$/u)
})

test('pairing says plainly when the hosted connector door is not enabled to redeem it', async () => {
  const app = harness({
    hostedMarketSigninReady: false,
    createPairingCode: async () => ({ expiresAt: '2026-09-02T00:10:00.000Z' }),
  })
  const response = await app.request('/api/pair', {
    method: 'POST', headers: { authorization: `Bearer ${'x'.repeat(10)}` },
  })
  assert.equal(response.status, 200)
  const body = await response.json() as { instructions: string }
  assert.match(body.instructions, /not enabled on this deployment/iu)
})

test('pairing is rate limited per IP and per merchant like the other identity doors', async () => {
  const memory = memoryStore({ deniedAttemptKind: 'pair_create' })
  const app = harness({ identityStore: memory.store })
  const response = await app.request('/api/pair', {
    method: 'POST', headers: { authorization: `Bearer ${'x'.repeat(10)}` },
  })
  assert.equal(response.status, 429)
  assert.equal((await response.json() as { reason: string }).reason, 'rate_limited')
})

test('pairing reports a storage failure without leaking a partial code', async () => {
  const app = harness({
    createPairingCode: async () => { throw new Error('db down') },
  })
  const response = await app.request('/api/pair', {
    method: 'POST', headers: { authorization: `Bearer ${'x'.repeat(10)}` },
  })
  assert.equal(response.status, 503)
  assert.equal((await response.json() as { reason: string }).reason, 'storage_unavailable')
})
