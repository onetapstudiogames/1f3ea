// Regression test for the 2026-09-03 production incident: with MARKET_CODING_IDENTITY_ENABLED
// true, POST /api/register, /api/rotate, and /api/recovery with a `{}` or `{"action":"stage"}`
// body never answered on Vercel's deployed Node runtime — curl gave up at 45 seconds on every
// attempt — while every other door kept answering normally. Every existing route test in this
// suite drives its Hono app through app.request(), which builds the Request object entirely
// in-process and never touches the Node-adapter body stream (@hono/node-server's
// getRequestListener) that only exists once a request actually arrives over a socket. That gap
// is exactly why CI never caught this: the doors must be driven over a REAL http.createServer
// with a REAL TCP client (Node's global fetch, not app.request()) for a test to have any chance
// of exercising the code path that hung.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { Hono } from 'hono'
import { getRequestListener } from '@hono/node-server'

import type { Merchant } from '../src/core.ts'
import { mountMarketIdentityJsonRoutes } from '../src/market-identity-json-routes.ts'
import { mountMarketPairingRoutes } from '../src/market-pairing-routes.ts'
import { memoryStore } from './support/market-identity-browser-harness.ts'

const ENVIRONMENT = { PUBLIC_ORIGIN: 'https://market.test' } as const
const RESPONSE_DEADLINE_MS = 2_000

const MERCHANT: Merchant = {
  id: 7, handle: 'existing-merchant', model: 'claude', karma: 0,
  joined_at: '2026-01-01T00:00:00.000Z', storefront_line: '', quota_day: '2026-01-01',
  comments_today: 0, votes_today: 0,
}

function buildApp(): Hono {
  const app = new Hono()
  mountMarketIdentityJsonRoutes(app, { environment: ENVIRONMENT, store: memoryStore().store })
  mountMarketPairingRoutes(app, {
    environment: ENVIRONMENT,
    identityStore: memoryStore().store,
    hostedMarketSigninReady: true,
    authenticate: async () => MERCHANT,
    createPairingCode: async () => ({ expiresAt: '2026-09-03T00:10:00.000Z' }),
  })
  return app
}

async function withRealServer<T>(run: (origin: string) => Promise<T>): Promise<T> {
  const server = createServer(getRequestListener(buildApp().fetch))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address() as AddressInfo
  try {
    return await run(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}

async function postOverRealSocket(
  origin: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: unknown; elapsedMs: number }> {
  const startedAt = Date.now()
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  const json = await response.json()
  return { status: response.status, json, elapsedMs: Date.now() - startedAt }
}

const CASES = [
  { path: '/api/register', body: {}, expectedStatus: 400, expectedReason: 'invalid_action' },
  { path: '/api/register', body: { action: 'stage' }, expectedStatus: 400, expectedReason: 'invalid_client_class' },
  { path: '/api/rotate', body: {}, expectedStatus: 400, expectedReason: 'invalid_action' },
  { path: '/api/rotate', body: { action: 'begin' }, expectedStatus: 400, expectedReason: 'invalid_client_class' },
  { path: '/api/recovery', body: {}, expectedStatus: 400, expectedReason: 'invalid_action' },
  { path: '/api/recovery', body: { action: 'generate' }, expectedStatus: 400, expectedReason: 'invalid_client_class' },
] as const

for (const { path, body, expectedStatus, expectedReason } of CASES) {
  test(
    `POST ${path} ${JSON.stringify(body)} answers within ${RESPONSE_DEADLINE_MS}ms over a real socket`,
    async () => {
      await withRealServer(async origin => {
        const { status, json, elapsedMs } = await postOverRealSocket(origin, path, body)
        assert.ok(elapsedMs < RESPONSE_DEADLINE_MS, `took ${elapsedMs}ms, expected under ${RESPONSE_DEADLINE_MS}ms`)
        assert.equal(status, expectedStatus)
        assert.equal((json as { reason: string }).reason, expectedReason)
      })
    },
  )
}

// /api/pair authenticates before it ever reads the body, so an unauthenticated `{}` never
// exercises readBoundedJson at all — this was the original, misleading signal in the incident
// report ("the pairing door reads its body differently and works"). Authenticate it here so its
// own call into the shared reader is actually driven over the real socket too.
test(`POST /api/pair {} with a valid credential answers within ${RESPONSE_DEADLINE_MS}ms over a real socket`, async () => {
  await withRealServer(async origin => {
    const { status, json, elapsedMs } = await postOverRealSocket(origin, '/api/pair', {}, {
      authorization: `Bearer ${'x'.repeat(10)}`,
    })
    assert.ok(elapsedMs < RESPONSE_DEADLINE_MS, `took ${elapsedMs}ms, expected under ${RESPONSE_DEADLINE_MS}ms`)
    assert.equal(status, 200)
    assert.equal((json as { status: string }).status, 'created')
  })
})
