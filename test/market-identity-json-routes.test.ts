import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { Hono } from 'hono'

import { mountMarketIdentityJsonRoutes } from '../src/market-identity-json-routes.ts'
import { MERCHANT_KEY, memoryStore } from './support/market-identity-browser-harness.ts'

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')

const ENVIRONMENT = { PUBLIC_ORIGIN: 'https://market.test' } as const
const CREDENTIAL = /1f3ea_(?:sk_[0-9a-f]{48}|rc_[0-9a-f]{64})/gu

function harness(options: Parameters<typeof memoryStore>[0] = {}) {
  const app = new Hono()
  const memory = memoryStore(options)
  mountMarketIdentityJsonRoutes(app, { environment: ENVIRONMENT, store: memory.store })
  return { app, memory }
}

function postJson(app: Hono, path: string, body: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function jsonBody<T>(response: Response): Promise<T> {
  return (await response.json()) as T
}

// ---------------------------------------------------------------------------------------------
// /api/register
// ---------------------------------------------------------------------------------------------

test('register stage reveals the key and codes exactly once, then confirm creates the merchant', async () => {
  const { app } = harness()
  const staged = await postJson(app, '/api/register', {
    action: 'stage', handle: 'new-store', model: 'claude', client_class: 'coding_persistent', human_approved: true,
  })
  assert.equal(staged.status, 200)
  assert.equal(staged.headers.get('cache-control'), 'no-store')
  const stagedBody = await jsonBody<{
    status: string; handle: string; session: string; csrf: string
    merchant_key: string; recovery_codes: string[]
  }>(staged)
  assert.equal(stagedBody.status, 'staged')
  assert.equal(stagedBody.handle, 'new-store')
  assert.match(stagedBody.merchant_key, /^1f3ea_sk_[0-9a-f]{48}$/u)
  assert.equal(stagedBody.recovery_codes.length, 8)
  assert.match(stagedBody.session, /^[0-9a-f]{64}$/u)
  assert.match(stagedBody.csrf, /^[0-9a-f]{64}$/u)

  const confirmed = await postJson(app, '/api/register', {
    action: 'confirm', session: stagedBody.session, csrf: stagedBody.csrf, merchant_key: stagedBody.merchant_key,
  })
  assert.equal(confirmed.status, 200)
  const confirmedBody = await jsonBody<{ status: string; merchant_id: number; handle: string }>(confirmed)
  assert.deepEqual(confirmedBody, { status: 'confirmed', merchant_id: 27, handle: 'new-store' })
  assert.equal(CREDENTIAL.test(JSON.stringify(confirmedBody)), false)
})

test('register refuses a browser-only client_class before touching storage', async () => {
  const { app, memory } = harness()
  const response = await postJson(app, '/api/register', {
    action: 'stage', handle: 'valid-store', model: '', client_class: 'hosted_browser', human_approved: true,
  })
  assert.equal(response.status, 400)
  const body = await jsonBody<{ reason: string }>(response)
  assert.equal(body.reason, 'invalid_client_class')
  assert.equal(memory.calls.length, 0)
})

test('register requires human_approved:true after a valid client_class', async () => {
  const { app } = harness()
  const response = await postJson(app, '/api/register', {
    action: 'stage', handle: 'valid-store', model: '', client_class: 'coding_ephemeral', human_approved: false,
  })
  assert.equal(response.status, 403)
  const body = await jsonBody<{ reason: string }>(response)
  assert.equal(body.reason, 'human_approval_required')
})

test('register rejects an invalid handle shape', async () => {
  const { app } = harness()
  const response = await postJson(app, '/api/register', {
    action: 'stage', handle: 'AB', model: '', client_class: 'coding_persistent', human_approved: true,
  })
  assert.equal(response.status, 400)
  assert.equal((await jsonBody<{ reason: string }>(response)).reason, 'invalid_identity')
})

test('register stage refuses unexpected fields', async () => {
  const { app } = harness()
  const response = await postJson(app, '/api/register', {
    action: 'stage', handle: 'valid-store', model: '', client_class: 'coding_persistent', human_approved: true, extra: 1,
  })
  assert.equal(response.status, 400)
  assert.equal((await jsonBody<{ reason: string }>(response)).reason, 'unexpected_fields')
})

test('register stage is rate limited the same way as the browser join_stage bucket', async () => {
  const { app } = harness({ deniedAttemptKind: 'join_stage' })
  const response = await postJson(app, '/api/register', {
    action: 'stage', handle: 'valid-store', model: '', client_class: 'coding_persistent', human_approved: true,
  })
  assert.equal(response.status, 429)
  assert.equal((await jsonBody<{ reason: string }>(response)).reason, 'rate_limited')
})

test('register confirm rejects a wrong-shaped ceremony reference before touching the store', async () => {
  const { app, memory } = harness()
  const response = await postJson(app, '/api/register', {
    action: 'confirm', session: 'not-hex', csrf: 'also-not-hex', merchant_key: MERCHANT_KEY,
  })
  assert.equal(response.status, 403)
  assert.equal((await jsonBody<{ reason: string }>(response)).reason, 'invalid_ceremony')
  assert.equal(memory.calls.some(call => call.method === 'confirmRegistration'), false)
})

test('register confirm rejects the wrong key without creating a merchant', async () => {
  const { app } = harness()
  const staged = await jsonBody<{ session: string; csrf: string }>(
    await postJson(app, '/api/register', {
      action: 'stage', handle: 'valid-store', model: '', client_class: 'coding_persistent', human_approved: true,
    }),
  )
  const response = await postJson(app, '/api/register', {
    action: 'confirm', session: staged.session, csrf: staged.csrf,
    merchant_key: `1f3ea_sk_${'ff'.repeat(24)}`,
  })
  assert.equal(response.status, 403)
  assert.equal((await jsonBody<{ reason: string }>(response)).reason, 'credential_rejected')
})

test('register confirm reports handle_taken and scrubs the losing attempt', async () => {
  const { app, memory } = harness({ registrationConfirmHandleTaken: true })
  const staged = await jsonBody<{ session: string; csrf: string; merchant_key: string }>(
    await postJson(app, '/api/register', {
      action: 'stage', handle: 'valid-store', model: '', client_class: 'coding_persistent', human_approved: true,
    }),
  )
  const response = await postJson(app, '/api/register', {
    action: 'confirm', session: staged.session, csrf: staged.csrf, merchant_key: staged.merchant_key,
  })
  assert.equal(response.status, 409)
  assert.equal((await jsonBody<{ reason: string }>(response)).reason, 'handle_taken')
  assert.equal(memory.calls.some(call => call.method === 'cancelRegistration'), true)
})

test('register cancel works and is idempotent on a second call', async () => {
  const { app } = harness()
  const staged = await jsonBody<{ session: string; csrf: string }>(
    await postJson(app, '/api/register', {
      action: 'stage', handle: 'valid-store', model: '', client_class: 'coding_persistent', human_approved: true,
    }),
  )
  const first = await postJson(app, '/api/register', { action: 'cancel', session: staged.session, csrf: staged.csrf })
  assert.equal(first.status, 200)
  assert.deepEqual(await jsonBody(first), { status: 'canceled' })
  const second = await postJson(app, '/api/register', { action: 'cancel', session: staged.session, csrf: staged.csrf })
  assert.equal(second.status, 200)
  assert.deepEqual(await jsonBody(second), { status: 'canceled' })
})

test('register rejects a malformed body before any store call', async () => {
  const { app, memory } = harness()
  const response = await app.request('/api/register', {
    method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'not json',
  })
  assert.equal(response.status, 400)
  assert.equal((await jsonBody<{ reason: string }>(response)).reason, 'invalid_json')
  assert.equal(memory.calls.length, 0)
})

// ---------------------------------------------------------------------------------------------
// /api/rotate
// ---------------------------------------------------------------------------------------------

test('rotate begin then confirm activates the replacement and reveals it exactly once', async () => {
  const { app } = harness()
  const begun = await jsonBody<{ status: string; session: string; csrf: string; merchant_key: string }>(
    await postJson(app, '/api/rotate', { action: 'begin', client_class: 'coding_persistent', merchant_key: MERCHANT_KEY }),
  )
  assert.equal(begun.status, 'staged')
  assert.match(begun.merchant_key, /^1f3ea_sk_[0-9a-f]{48}$/u)
  const confirmed = await postJson(app, '/api/rotate', {
    action: 'confirm', session: begun.session, csrf: begun.csrf, merchant_key: begun.merchant_key,
  })
  assert.equal(confirmed.status, 200)
  assert.deepEqual(await jsonBody(confirmed), { status: 'rotated', merchant_id: 7, handle: 'existing-merchant' })
})

test('rotate begin rejects a wrong current key without staging anything', async () => {
  const { app, memory } = harness()
  const response = await postJson(app, '/api/rotate', {
    action: 'begin', client_class: 'coding_ephemeral', merchant_key: `1f3ea_sk_${'ff'.repeat(24)}`,
  })
  assert.equal(response.status, 403)
  assert.equal((await jsonBody<{ reason: string }>(response)).reason, 'credential_rejected')
  assert.equal(memory.stagedRotation(), null)
})

test('rotate confirm reports the daily success limit the same way as the browser', async () => {
  const { app } = harness({ rotationConfirmRateLimited: true })
  const begun = await jsonBody<{ session: string; csrf: string; merchant_key: string }>(
    await postJson(app, '/api/rotate', { action: 'begin', client_class: 'coding_persistent', merchant_key: MERCHANT_KEY }),
  )
  const response = await postJson(app, '/api/rotate', {
    action: 'confirm', session: begun.session, csrf: begun.csrf, merchant_key: begun.merchant_key,
  })
  assert.equal(response.status, 429)
  assert.equal((await jsonBody<{ reason: string }>(response)).reason, 'rate_limited')
})

test('rotate cancel keeps the current key active', async () => {
  const { app, memory } = harness()
  const begun = await jsonBody<{ session: string; csrf: string }>(
    await postJson(app, '/api/rotate', { action: 'begin', client_class: 'coding_persistent', merchant_key: MERCHANT_KEY }),
  )
  const response = await postJson(app, '/api/rotate', { action: 'cancel', session: begun.session, csrf: begun.csrf })
  assert.equal(response.status, 200)
  assert.equal(memory.currentSecretHash(), sha256(MERCHANT_KEY))
})

// ---------------------------------------------------------------------------------------------
// /api/recovery
// ---------------------------------------------------------------------------------------------

test('recovery generate replaces the code set without changing the key', async () => {
  const { app } = harness()
  const response = await postJson(app, '/api/recovery', {
    action: 'generate', client_class: 'coding_persistent', merchant_key: MERCHANT_KEY,
  })
  assert.equal(response.status, 200)
  const body = await jsonBody<{ status: string; recovery_codes: string[] }>(response)
  assert.equal(body.status, 'generated')
  assert.equal(body.recovery_codes.length, 8)
})

test('recovery begin then confirm consumes the code and activates the replacement', async () => {
  const { app, memory } = harness()
  const generated = await jsonBody<{ recovery_codes: string[] }>(
    await postJson(app, '/api/recovery', { action: 'generate', client_class: 'coding_persistent', merchant_key: MERCHANT_KEY }),
  )
  const begun = await jsonBody<{ status: string; session: string; csrf: string; merchant_key: string }>(
    await postJson(app, '/api/recovery', {
      action: 'begin', client_class: 'coding_ephemeral', recovery_code: generated.recovery_codes[0],
    }),
  )
  assert.equal(begun.status, 'staged')
  const confirmed = await postJson(app, '/api/recovery', {
    action: 'confirm', session: begun.session, csrf: begun.csrf, merchant_key: begun.merchant_key,
  })
  assert.equal(confirmed.status, 200)
  assert.deepEqual(await jsonBody(confirmed), { status: 'recovered', merchant_id: 7, handle: 'existing-merchant' })
  assert.equal(memory.recoveryCodeHashes().length, 0)
})

test('recovery begin rejects an already-used or unknown code', async () => {
  const { app } = harness()
  const response = await postJson(app, '/api/recovery', {
    action: 'begin', client_class: 'coding_persistent', recovery_code: `1f3ea_rc_${'aa'.repeat(32)}`,
  })
  assert.equal(response.status, 403)
  assert.equal((await jsonBody<{ reason: string }>(response)).reason, 'credential_rejected')
})

test('recovery every action requires a valid client_class except confirm and cancel', async () => {
  const { app } = harness()
  for (const body of [
    { action: 'generate', client_class: 'oauth_refused', merchant_key: MERCHANT_KEY },
    { action: 'begin', client_class: 'hosted_browser', recovery_code: `1f3ea_rc_${'aa'.repeat(32)}` },
  ]) {
    const response = await postJson(app, '/api/recovery', body)
    assert.equal(response.status, 400, JSON.stringify(body))
    assert.equal((await jsonBody<{ reason: string }>(response)).reason, 'invalid_client_class')
  }
})

// ---------------------------------------------------------------------------------------------
// A thrown store error must answer the documented 503 storage_unavailable, not the generic
// onError 500 in index.ts. readBody already turns its own read failure into 503; this proves
// the same net now catches a store call that throws deeper in each door — registerHandler,
// rotateHandler, and recoveryHandler each wrap their whole dispatch in withJsonStorageErrors.
// ---------------------------------------------------------------------------------------------

function throwingRateLimitHarness() {
  const app = new Hono()
  const memory = memoryStore()
  const store = {
    ...memory.store,
    consumeMarketIdentityRateLimit: async (): Promise<boolean> => {
      throw new Error('database unavailable')
    },
  }
  mountMarketIdentityJsonRoutes(app, { environment: ENVIRONMENT, store })
  return app
}

test('a store error during register, rotate, or recovery answers 503 storage_unavailable, not a generic 500', async () => {
  const app = throwingRateLimitHarness()
  for (const [path, body] of [
    ['/api/register', { action: 'stage', handle: 'new-store', model: 'claude', client_class: 'coding_persistent', human_approved: true }],
    ['/api/rotate', { action: 'begin', client_class: 'coding_persistent', merchant_key: MERCHANT_KEY }],
    ['/api/recovery', { action: 'generate', client_class: 'coding_persistent', merchant_key: MERCHANT_KEY }],
  ] as const) {
    const response = await postJson(app, path, body)
    assert.equal(response.status, 503, path)
    assert.equal(response.headers.get('cache-control'), 'no-store', path)
    const parsed = await jsonBody<{ reason: string; error: string }>(response)
    assert.equal(parsed.reason, 'storage_unavailable', path)
    assert.match(parsed.error, /no credential was created or changed/iu, path)
    assert.doesNotMatch(parsed.error, /1f3ea_(?:sk|rc)_[0-9a-f]+/iu, path)
  }
})
