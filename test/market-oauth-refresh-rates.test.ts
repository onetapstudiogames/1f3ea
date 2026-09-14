import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CLIENT_ID, Hono, MemoryOAuthStore, RESOURCE, approve, environment, exchange,
  mountMarketOAuthRoutes, sha256,
} from './support/market-oauth-flow-harness.ts'
import type { OAuthAttemptKind } from '../src/market-oauth-store.ts'

const IP = '203.0.113.17'
const headers = { 'content-type': 'application/x-www-form-urlencoded', 'x-vercel-forwarded-for': IP }

function fixture(options: { failAdmission?: () => boolean } = {}) {
  const memory = new MemoryOAuthStore()
  const app = new Hono()
  const counts = new Map<string, number>()
  const attempts: { bucketHash: string; attemptKind: OAuthAttemptKind; maximum: number }[] = []
  mountMarketOAuthRoutes(app, {
    environment: { ...environment, VERCEL: '1' },
    store: {
      ...memory.api,
      consumeOAuthRateLimit: async input => {
        if (options.failAdmission?.()) throw new Error('rate store unavailable')
        attempts.push(input)
        const key = `${input.attemptKind}:${input.bucketHash}`
        const used = counts.get(key) ?? 0
        if (used >= input.maximum) return false
        counts.set(key, used + 1)
        return true
      },
    },
  })
  return { app, attempts, memory }
}

async function newConnection(app: Hono): Promise<string> {
  const authorization = await approve(app)
  const result = await exchange(app, authorization.code)
  assert.equal(result.response.status, 200)
  return String(result.body.refresh_token)
}

async function refresh(
  app: Hono, refreshToken: string, clientId = CLIENT_ID, resource = RESOURCE,
  scope = 'market:merchant', ip = IP,
) {
  const response = await app.request('/oauth/token', {
    method: 'POST', headers: { ...headers, 'x-vercel-forwarded-for': ip },
    body: new URLSearchParams({
      grant_type: 'refresh_token', client_id: clientId, resource,
      refresh_token: refreshToken, scope,
    }),
  })
  return { response, body: await response.json() as Record<string, unknown> }
}

test('two connections with one client and IP each receive 120 refreshes; IP changes do not reset one', async () => {
  const { app, attempts } = fixture()
  let first = await newConnection(app)
  let second = await newConnection(app)
  for (let index = 0; index < 120; index += 1) {
    const result = await refresh(app, first)
    assert.equal(result.response.status, 200, `first connection refresh ${index + 1}`)
    first = String(result.body.refresh_token)
  }
  const denied = await refresh(app, first)
  assert.equal(denied.response.status, 429)
  assert.match(String(denied.body.error_description), /120.*connection.*UTC hour/u)
  assert.equal((await refresh(app, first, CLIENT_ID, RESOURCE, 'market:merchant', '203.0.113.18')).response.status, 429)
  for (let index = 0; index < 120; index += 1) {
    const result = await refresh(app, second)
    assert.equal(result.response.status, 200, `second connection refresh ${index + 1}`)
    second = String(result.body.refresh_token)
  }
  assert.equal((await refresh(app, second)).response.status, 429)
  assert.match(second, /^1f3ea_rt_[0-9a-f]{64}$/u)

  const refreshAttempts = attempts.filter(attempt => attempt.attemptKind === 'refresh')
  assert.equal(new Set(refreshAttempts.map(attempt => attempt.bucketHash)).size, 2)
  assert.ok(refreshAttempts.every(attempt => attempt.maximum === 120))
})

test('junk and wrong-client refreshes cannot spend an active connection allowance', async () => {
  const { app, attempts } = fixture()
  const active = await newConnection(app)
  const wrongClient = await refresh(app, active, 'wrong-client')
  assert.equal(wrongClient.response.status, 400)
  const wrongResource = await refresh(app, active, CLIENT_ID, `${RESOURCE}/wrong`)
  assert.equal(wrongResource.response.status, 400)
  const wrongScope = await refresh(app, active, CLIENT_ID, RESOURCE, 'wrong:scope')
  assert.equal(wrongScope.response.status, 400)
  for (let index = 3; index < 120; index += 1) {
    const result = await refresh(app, `1f3ea_rt_${index.toString(16).padStart(64, '0')}`)
    assert.equal(result.response.status, 400)
  }
  const junkDenied = await refresh(app, 'short')
  assert.equal(junkDenied.response.status, 429)
  assert.match(String(junkDenied.body.error_description), /junk.*120.*IP.*client.*UTC hour/u)
  const valid = await refresh(app, active)
  assert.equal(valid.response.status, 200)
  const refreshAttempts = attempts.filter(attempt => attempt.attemptKind === 'refresh')
  assert.equal(new Set(refreshAttempts.map(attempt => attempt.bucketHash)).size, 4)
})

test('first used-token replay revokes its family even when junk refresh allowance is exhausted', async () => {
  const { app, memory } = fixture()
  const original = await newConnection(app)
  const rotated = await refresh(app, original)
  assert.equal(rotated.response.status, 200)
  for (let index = 0; index < 120; index += 1) {
    assert.equal((await refresh(app, `1f3ea_rt_${index.toString(16).padStart(64, '0')}`)).response.status, 400)
  }
  assert.equal((await refresh(app, original)).response.status, 400)
  assert.deepEqual(await memory.api.resolveRefreshRateLimitSubject({
    presentedRefreshTokenHash: sha256(String(rotated.body.refresh_token)),
    clientId: CLIENT_ID, resource: RESOURCE,
  }), { status: 'junk' })
})

test('first used-token replay revokes its family when junk rate storage throws', async () => {
  let failAdmission = false
  const { app, memory } = fixture({ failAdmission: () => failAdmission })
  const original = await newConnection(app)
  const rotated = await refresh(app, original)
  assert.equal(rotated.response.status, 200)
  failAdmission = true
  assert.equal((await refresh(app, original)).response.status, 400)
  assert.deepEqual(await memory.api.resolveRefreshRateLimitSubject({
    presentedRefreshTokenHash: sha256(String(rotated.body.refresh_token)),
    clientId: CLIENT_ID, resource: RESOURCE,
  }), { status: 'junk' })
})

test('a revoked refresh uses junk capacity and does not charge its former connection', async () => {
  const { app, attempts, memory } = fixture()
  const token = await newConnection(app)
  await memory.api.revokeTokenFamilyByToken({ tokenHash: sha256(token), clientId: CLIENT_ID })
  const response = await refresh(app, token)
  assert.equal(response.response.status, 400)
  const refreshAttempts = attempts.filter(attempt => attempt.attemptKind === 'refresh')
  assert.equal(refreshAttempts.length, 2)
  assert.notEqual(refreshAttempts[0]!.bucketHash, refreshAttempts[1]!.bucketHash)
})
