import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  createMarketOAuthStore,
  type MarketOAuthQuery,
  type OAuthAttemptKind,
} from '../src/market-oauth-store.ts'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const HASH_C = 'c'.repeat(64)
const HASH_D = 'd'.repeat(64)

interface CapturedQuery {
  text: string
  values: readonly unknown[]
}

function fakeQuery(
  replies: readonly (readonly Record<string, unknown>[])[],
): { query: MarketOAuthQuery; captured: CapturedQuery[] } {
  const captured: CapturedQuery[] = []
  let index = 0
  const query: MarketOAuthQuery = async (strings, ...values) => {
    const text = strings.reduce(
      (result, part, partIndex) => result + part + (partIndex < values.length ? `$${partIndex + 1}` : ''),
      '',
    )
    captured.push({ text, values })
    const reply = replies[index] ?? []
    index += 1
    return [...reply]
  }
  return { query, captured }
}

test('authorization requests retain exact OAuth binding fields and only session/CSRF hashes', async () => {
  const fake = fakeQuery([[]])
  const store = createMarketOAuthStore(fake.query)

  await store.createAuthorizationRequest({
    sessionHash: HASH_A,
    csrfHash: HASH_B,
    clientId: 'https://chatgpt.com/oauth/client.json',
    clientName: 'ChatGPT',
    redirectUri: 'https://chatgpt.com/connector_platform_oauth_redirect',
    resource: 'https://1f3ea.com/mcp/connect',
    scope: 'market:merchant',
    state: 'opaque-state',
    codeChallenge: 'x'.repeat(43),
  })

  assert.equal(fake.captured.length, 1)
  assert.match(fake.captured[0]!.text, /session_hash, csrf_hash, client_id, client_display_name, redirect_uri/)
  assert.match(fake.captured[0]!.text, /resource, scope, state, code_challenge, code_challenge_method, expires_at/)
  assert.match(fake.captured[0]!.text, /interval '15 minutes'/)
  assert.deepEqual(fake.captured[0]!.values, [
    HASH_A,
    HASH_B,
    'https://chatgpt.com/oauth/client.json',
    'ChatGPT',
    'https://chatgpt.com/connector_platform_oauth_redirect',
    'https://1f3ea.com/mcp/connect',
    'market:merchant',
    'opaque-state',
    'x'.repeat(43),
  ])
})

test('existing-merchant approval is one atomic transaction and never persists the permanent key', async () => {
  const fake = fakeQuery([[
    { redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect', state: 'opaque-state' },
  ]])
  const store = createMarketOAuthStore(fake.query)

  const redirect = await store.approveExistingMerchantAndIssueAuthorizationCode({
    sessionHash: HASH_A,
    csrfHash: HASH_B,
    merchantSecretHash: HASH_C,
    authorizationCodeHash: HASH_D,
  })

  assert.deepEqual(redirect, {
    redirectUri: 'https://chatgpt.com/connector_platform_oauth_redirect',
    state: 'opaque-state',
  })
  assert.equal(fake.captured.length, 1)
  const approvalSql = fake.captured[0]!.text
  assert.match(approvalSql, /FROM merchants/)
  assert.match(approvalSql, /WHERE secret_hash = \$1/)
  assert.match(approvalSql, /UPDATE oauth_authorization_requests/)
  assert.match(approvalSql, /INSERT INTO oauth_authorization_codes/)
  assert.match(approvalSql, /interval '5 minutes'/)
  assert.doesNotMatch(approvalSql, /merchant_secret|permanent_key|bearer_secret/)
  assert.deepEqual(fake.captured[0]!.values, [HASH_C, HASH_A, HASH_B, HASH_D])
})

test('pending request lookup and cancellation are hash-bound and one-use', async () => {
  const record = {
    id: 3,
    client_id: 'client',
    client_display_name: 'Chat',
    redirect_uri: 'https://chat.example/callback',
    resource: 'https://1f3ea.com/mcp/connect',
    scope: 'market:merchant',
    state: 'state',
    code_challenge: 'x'.repeat(43),
    merchant_id: null,
    verified_at: null,
    approved_at: null,
  }
  const fake = fakeQuery([
    [record],
    [{ redirect_uri: record.redirect_uri, state: record.state }],
    [],
  ])
  const store = createMarketOAuthStore(fake.query)

  assert.deepEqual(await store.getAuthorizationRequest(HASH_A), record)
  assert.deepEqual(await store.cancelAuthorizationRequest({
    sessionHash: HASH_A,
    csrfHash: HASH_B,
  }), { redirectUri: record.redirect_uri, state: record.state })
  assert.equal(await store.cancelAuthorizationRequest({
    sessionHash: HASH_A,
    csrfHash: HASH_B,
  }), null)
  assert.match(fake.captured[1]!.text, /merchant_id IS NULL/)
  assert.match(fake.captured[1]!.text, /used_at IS NULL/)
  assert.match(fake.captured[0]!.text, /merchant_id IS NULL/)
})

test('authorization-code lookup returns every PKCE and audience binding', async () => {
  const fake = fakeQuery([[
    {
      merchant_id: 7,
      client_id: 'client',
      redirect_uri: 'https://chat.example/callback',
      resource: 'https://1f3ea.com/mcp/connect',
      scope: 'market:merchant',
      code_challenge: 'x'.repeat(43),
    },
  ], []])
  const store = createMarketOAuthStore(fake.query)

  assert.deepEqual(await store.getAuthorizationCode(HASH_A), {
    merchantId: 7,
    clientId: 'client',
    redirectUri: 'https://chat.example/callback',
    resource: 'https://1f3ea.com/mcp/connect',
    scope: 'market:merchant',
    codeChallenge: 'x'.repeat(43),
  })
  assert.equal(await store.getAuthorizationCode(HASH_B), null)
})

test('authorization-code exchange atomically consumes the code and stores 10m/30d token hashes', async () => {
  const fake = fakeQuery([[{ id: 41 }], []])
  const store = createMarketOAuthStore(fake.query)
  const exchange = {
    codeHash: HASH_A,
    clientId: 'https://chatgpt.com/oauth/client.json',
    redirectUri: 'https://chatgpt.com/connector_platform_oauth_redirect',
    resource: 'https://1f3ea.com/mcp/connect',
    accessTokenHash: HASH_B,
    refreshTokenHash: HASH_C,
  }

  assert.equal(await store.exchangeAuthorizationCode(exchange), true)
  assert.equal(await store.exchangeAuthorizationCode(exchange), false)
  const sql = fake.captured[0]!.text
  assert.match(sql, /UPDATE oauth_authorization_codes[\s\S]*used_at = now\(\)/)
  assert.match(sql, /used_at IS NULL/)
  assert.match(sql, /INSERT INTO oauth_token_families/)
  assert.match(sql, /interval '30 days'/)
  assert.match(sql, /INSERT INTO oauth_tokens/)
  assert.match(sql, /interval '10 minutes'/)
  assert.doesNotMatch(sql, /access_token\s*,|refresh_token\s*,/)
})

test('refresh rotation is one-use and reuse revokes the complete token family', async () => {
  const input = {
    presentedRefreshTokenHash: HASH_A,
    clientId: 'https://chatgpt.com/oauth/client.json',
    resource: 'https://1f3ea.com/mcp/connect',
    accessTokenHash: HASH_B,
    newRefreshTokenHash: HASH_C,
  }

  const rotatedFake = fakeQuery([[{ id: 9 }]])
  const rotated = createMarketOAuthStore(rotatedFake.query)
  assert.equal(await rotated.rotateRefreshToken(input), 'rotated')
  assert.match(rotatedFake.captured[0]!.text, /token\.used_at IS NULL/)
  assert.match(rotatedFake.captured[0]!.text, /SET used_at = now\(\)/)
  assert.match(rotatedFake.captured[0]!.text, /rotated_from_token_id/)

  const reusedFake = fakeQuery([[], [{ id: 9 }]])
  const reused = createMarketOAuthStore(reusedFake.query)
  assert.equal(await reused.rotateRefreshToken(input), 'reused')
  assert.match(reusedFake.captured[1]!.text, /refresh token reuse/)
  assert.match(reusedFake.captured[1]!.text, /UPDATE oauth_token_families/)
  assert.match(reusedFake.captured[1]!.text, /UPDATE oauth_tokens/)

  const invalidFake = fakeQuery([[], []])
  assert.equal(await createMarketOAuthStore(invalidFake.query).rotateRefreshToken(input), 'invalid')
})

test('access-token resolution is passive and returns the linked merchant', async () => {
  const merchant = {
    id: 7,
    handle: 'tiny-lantern',
    model: 'openai-codex',
    storefront_line: '',
    karma: 2,
    joined_at: '2026-08-22T00:00:00.000Z',
    quota_day: '2026-08-22',
    comments_today: 1,
    votes_today: 3,
  }
  const fake = fakeQuery([[merchant]])
  const store = createMarketOAuthStore(fake.query)

  assert.deepEqual(await store.resolveOAuthAccessToken({
    accessTokenHash: HASH_A,
    resource: 'https://1f3ea.com/mcp/connect',
    scope: 'market:merchant',
  }), merchant)
  assert.match(fake.captured[0]!.text, /JOIN merchants merchant/)
  assert.doesNotMatch(fake.captured[0]!.text, /UPDATE merchants/)
  assert.match(fake.captured[0]!.text, /token\.used_at IS NULL/)
  assert.match(fake.captured[0]!.text, /family\.revoked_at IS NULL/)
})

test('revocation and rate limits use hashed identifiers', async () => {
  const attempt: OAuthAttemptKind = 'merchant_key'
  const fake = fakeQuery([[], [{ used: 1 }], []])
  const store = createMarketOAuthStore(fake.query)

  await store.revokeTokenFamilyByToken({ tokenHash: HASH_A, clientId: 'client' })
  assert.equal(await store.consumeOAuthRateLimit({
    bucketHash: HASH_B,
    attemptKind: attempt,
    maximum: 5,
  }), true)
  assert.equal(await store.consumeOAuthRateLimit({
    bucketHash: HASH_B,
    attemptKind: attempt,
    maximum: 5,
  }), false)

  assert.match(fake.captured[0]!.text, /UPDATE oauth_token_families/)
  assert.match(fake.captured[0]!.text, /client revocation/)
  assert.match(fake.captured[1]!.text, /ON CONFLICT \(bucket_hash, attempt_kind, window_start\) DO UPDATE/)
  assert.match(fake.captured[1]!.text, /oauth_rate_limits\.used < \$3/)
  assert.match(fake.captured[1]!.text, /DELETE FROM oauth_authorization_codes/)
  assert.match(fake.captured[1]!.text, /DELETE FROM oauth_authorization_requests/)
  assert.match(fake.captured[1]!.text, /DELETE FROM oauth_tokens/)
  assert.match(fake.captured[1]!.text, /DELETE FROM oauth_token_families/)
  assert.match(fake.captured[1]!.text, /interval '30 days'/)
  assert.match(fake.captured[1]!.text, /LIMIT 50/)
})

test('storage boundary rejects malformed hashes and unsafe rate-limit maxima before SQL', async () => {
  const fake = fakeQuery([])
  const store = createMarketOAuthStore(fake.query)

  await assert.rejects(
    store.getAuthorizationRequest('raw-browser-session'),
    /lowercase sha256 hash/,
  )
  await assert.rejects(
    store.revokeTokenFamilyByToken({ tokenHash: 'raw-token', clientId: 'client' }),
    /lowercase sha256 hash/,
  )
  await assert.rejects(
    store.consumeOAuthRateLimit({ bucketHash: HASH_A, attemptKind: 'token', maximum: 0 }),
    /integer between 1 and 10000/,
  )
  assert.equal(fake.captured.length, 0)
})

test('schema and migration isolate OAuth hashes with bounded lifetimes', async () => {
  const [schema, migration] = await Promise.all([
    readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'),
    readFile(new URL('../db/migrations/20260822_hosted_market_signin.sql', import.meta.url), 'utf8'),
  ])

  for (const sql of [schema, migration]) {
    assert.match(sql, /CREATE TABLE IF NOT EXISTS oauth_authorization_requests/)
    assert.match(sql, /session_hash\s+TEXT NOT NULL UNIQUE[\s\S]*'\^\[0-9a-f\]\{64\}\$'/)
    assert.match(sql, /csrf_hash\s+TEXT NOT NULL UNIQUE[\s\S]*'\^\[0-9a-f\]\{64\}\$'/)
    assert.match(sql, /scope\s+TEXT NOT NULL CHECK \(scope = 'market:merchant'\)/)
    assert.match(sql, /code_challenge_method\s+TEXT NOT NULL DEFAULT 'S256'/)
    assert.match(sql, /merchant_id IS NOT NULL AND verified_at IS NOT NULL AND approved_at IS NOT NULL[\s\S]*used_at IS NOT NULL/)
    assert.match(sql, /expires_at > created_at AND expires_at <= created_at \+ INTERVAL '5 minutes'/)
    assert.match(sql, /expires_at <= created_at \+ INTERVAL '30 days'/)
    assert.match(sql, /WHEN 'access' THEN INTERVAL '10 minutes'/)
    assert.match(sql, /attempt_kind IN \('authorize', 'merchant_key', 'token', 'refresh', 'revoke'\)/)
    assert.match(sql, /oauth_authorization_codes_retention/)
    assert.match(sql, /oauth_token_families_retention/)
    assert.doesNotMatch(sql, /merchant_secret|permanent_key|bearer_secret|access_token\s+TEXT|refresh_token\s+TEXT/)
  }
})
