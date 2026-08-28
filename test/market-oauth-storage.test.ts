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
    {
      status: 'approved',
      redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect',
      state: 'opaque-state',
    },
  ]])
  const store = createMarketOAuthStore(fake.query)

  const redirect = await store.approveExistingMerchantAndIssueAuthorizationCode({
    sessionHash: HASH_A,
    csrfHash: HASH_B,
    merchantSecretHash: HASH_C,
    authorizationCodeHash: HASH_D,
  })

  assert.deepEqual(redirect, {
    status: 'approved',
    redirectUri: 'https://chatgpt.com/connector_platform_oauth_redirect',
    state: 'opaque-state',
  })
  assert.equal(fake.captured.length, 1)
  const approvalSql = fake.captured[0]!.text
  assert.match(approvalSql, /locked_merchant AS MATERIALIZED[\s\S]*FOR UPDATE/)
  assert.ok(
    approvalSql.indexOf('locked_merchant AS MATERIALIZED') <
      approvalSql.indexOf('active_request AS MATERIALIZED'),
    'the merchant row must lock before the authorization request row',
  )
  assert.match(approvalSql, /CROSS JOIN merchant_gate/)
  assert.match(approvalSql, /FROM merchants/)
  assert.match(approvalSql, /WHERE secret_hash = \$1/)
  assert.match(approvalSql, /UPDATE oauth_authorization_requests/)
  assert.match(approvalSql, /INSERT INTO oauth_authorization_codes/)
  assert.match(approvalSql, /interval '5 minutes'/)
  assert.doesNotMatch(
    approvalSql,
    /merchant_secret\s+TEXT|permanent_key\s+TEXT|bearer_secret\s+TEXT|access_token\s+TEXT|refresh_token\s+TEXT/,
  )
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
    intent: null,
    merchant_id: null,
    new_handle: null,
    new_model: null,
    merchant_key_confirmed_at: null,
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
  assert.doesNotMatch(fake.captured[0]!.text, /merchant_id IS NULL/)
})

test('new-merchant staging locks one initial request and stores exactly eight recovery hashes', async () => {
  const recoveryCodeHashes = Array.from({ length: 8 }, (_, index) =>
    index.toString(16).repeat(64))
  const fake = fakeQuery([
    [{ eligible: true, handle: 'new-shop' }],
    [{ eligible: true, handle: null }],
    [{ eligible: false, handle: null }],
  ])
  const store = createMarketOAuthStore(fake.query)
  const input = {
    sessionHash: HASH_A,
    csrfHash: HASH_B,
    handle: 'new-shop',
    model: 'openai-codex',
    merchantSecretHash: HASH_C,
    recoveryCodeHashes,
  }

  assert.deepEqual(await store.stageNewMerchantRegistration(input), {
    status: 'staged', handle: 'new-shop',
  })
  assert.deepEqual(await store.stageNewMerchantRegistration(input), { status: 'handle_taken' })
  assert.deepEqual(await store.stageNewMerchantRegistration(input), { status: 'request_unavailable' })

  const stagingSql = fake.captured[0]!.text
  assert.match(stagingSql, /FOR UPDATE/)
  assert.match(stagingSql, /SET intent = 'new'/)
  assert.match(stagingSql, /new_secret_hash = \$5/)
  assert.match(stagingSql, /INSERT INTO oauth_authorization_request_recovery_codes/)
  assert.match(stagingSql, /WITH ORDINALITY/)
  assert.deepEqual(fake.captured[0]!.values.at(-1), recoveryCodeHashes)
})

test('new-merchant confirmation atomically creates identity, recovery set, event, and code', async () => {
  const fake = fakeQuery([[
    {
      status: 'approved',
      redirect_uri: 'https://chat.example/callback',
      state: 'opaque-state',
    },
  ]])
  const store = createMarketOAuthStore(fake.query)

  assert.deepEqual(await store.confirmNewMerchantAndIssueAuthorizationCode({
    sessionHash: HASH_A,
    csrfHash: HASH_B,
    merchantSecretHash: HASH_C,
    authorizationCodeHash: HASH_D,
  }), {
    status: 'approved',
    redirectUri: 'https://chat.example/callback',
    state: 'opaque-state',
  })

  const confirmationSql = fake.captured[0]!.text
  assert.match(confirmationSql, /FOR UPDATE/)
  assert.match(confirmationSql, /INSERT INTO merchants \(handle, model, secret_hash, recovery_generation\)/)
  assert.match(confirmationSql, /INSERT INTO merchant_recovery_codes/)
  assert.match(confirmationSql, /recovery_generation\)\s*SELECT[\s\S]*1/)
  assert.match(confirmationSql, /merchant_key_confirmed_at = now\(\)/)
  assert.match(confirmationSql, /DELETE FROM oauth_authorization_request_recovery_codes/)
  assert.match(confirmationSql, /INSERT INTO events \(kind, actor, detail\)/)
  assert.match(confirmationSql, /INSERT INTO oauth_authorization_codes/)
  assert.match(confirmationSql, /count\(\*\) FROM inserted_recovery_codes\) = 8/)
  assert.match(confirmationSql, /count\(\*\) FROM scrubbed_pending_codes\) = 8/)
})

test('new-merchant confirmation retries one PostgreSQL deadlock and no other failure', async t => {
  const input = {
    sessionHash: HASH_A,
    csrfHash: HASH_B,
    merchantSecretHash: HASH_C,
    authorizationCodeHash: HASH_D,
  }
  const approved = [{
    status: 'approved',
    redirect_uri: 'https://chat.example/callback',
    state: 'opaque-state',
  }]

  await t.test('one deadlock is retried once', async () => {
    let attempts = 0
    const query: MarketOAuthQuery = async () => {
      attempts += 1
      if (attempts === 1) {
        throw Object.assign(new Error('deadlock'), { sourceError: { code: '40P01' } })
      }
      return approved
    }
    assert.deepEqual(
      await createMarketOAuthStore(query).confirmNewMerchantAndIssueAuthorizationCode(input),
      {
        status: 'approved',
        redirectUri: 'https://chat.example/callback',
        state: 'opaque-state',
      },
    )
    assert.equal(attempts, 2)
  })

  await t.test('a second deadlock reaches the caller', async () => {
    let attempts = 0
    const query: MarketOAuthQuery = async () => {
      attempts += 1
      throw Object.assign(new Error('deadlock'), { code: '40P01' })
    }
    await assert.rejects(
      createMarketOAuthStore(query).confirmNewMerchantAndIssueAuthorizationCode(input),
      (error: unknown) => (error as { code?: unknown }).code === '40P01',
    )
    assert.equal(attempts, 2)
  })

  await t.test('another database failure is not retried', async () => {
    let attempts = 0
    const query: MarketOAuthQuery = async () => {
      attempts += 1
      throw Object.assign(new Error('constraint'), { code: '23514' })
    }
    await assert.rejects(
      createMarketOAuthStore(query).confirmNewMerchantAndIssueAuthorizationCode(input),
      (error: unknown) => (error as { code?: unknown }).code === '23514',
    )
    assert.equal(attempts, 1)
  })
})

test('terminal authorization progress distinguishes a confirmed merchant from cancellation and expiry', async () => {
  const record = {
    id: 3,
    client_id: 'client',
    client_display_name: 'Chat',
    redirect_uri: 'https://chat.example/callback',
    resource: 'https://1f3ea.com/mcp/connect',
    scope: 'market:merchant',
    state: 'state',
    code_challenge: 'x'.repeat(43),
    intent: 'new',
    merchant_id: 9,
    new_handle: 'new-shop',
    new_model: 'openai-codex',
    merchant_key_confirmed_at: '2026-08-27T00:00:00.000Z',
    progress_status: 'confirmed',
    merchant_handle: 'new-shop',
  }
  const fake = fakeQuery([[record]])
  const store = createMarketOAuthStore(fake.query)

  assert.deepEqual(await store.getAuthorizationRequestProgress({
    sessionHash: HASH_A,
    csrfHash: HASH_B,
  }), {
    status: 'confirmed',
    request: {
      id: record.id,
      client_id: record.client_id,
      client_display_name: record.client_display_name,
      redirect_uri: record.redirect_uri,
      resource: record.resource,
      scope: record.scope,
      state: record.state,
      code_challenge: record.code_challenge,
      intent: record.intent,
      merchant_id: record.merchant_id,
      new_handle: record.new_handle,
      new_model: record.new_model,
      merchant_key_confirmed_at: record.merchant_key_confirmed_at,
    },
    merchantId: 9,
    handle: 'new-shop',
  })
  assert.match(fake.captured[0]!.text, /LEFT JOIN merchants merchant/)
  assert.match(fake.captured[0]!.text, /THEN 'confirmed'/)
  assert.match(fake.captured[0]!.text, /THEN 'canceled'/)
  assert.match(fake.captured[0]!.text, /THEN 'expired'/)
})

test('staging rejects incomplete, duplicate, or malformed recovery hashes before SQL', async () => {
  const fake = fakeQuery([])
  const store = createMarketOAuthStore(fake.query)
  const input = {
    sessionHash: HASH_A,
    csrfHash: HASH_B,
    handle: 'new-shop',
    model: '',
    merchantSecretHash: HASH_C,
  }
  const valid = Array.from({ length: 8 }, (_, index) => index.toString(16).repeat(64))

  await assert.rejects(
    store.stageNewMerchantRegistration({ ...input, recoveryCodeHashes: valid.slice(0, 7) }),
    /exactly eight unique/,
  )
  await assert.rejects(
    store.stageNewMerchantRegistration({ ...input, recoveryCodeHashes: Array(8).fill(HASH_D) }),
    /exactly eight unique/,
  )
  await assert.rejects(
    store.stageNewMerchantRegistration({ ...input, recoveryCodeHashes: [...valid.slice(0, 7), 'raw-code'] }),
    /exactly eight unique/,
  )
  assert.equal(fake.captured.length, 0)
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
  assert.match(sql, /eligible_code AS MATERIALIZED/)
  assert.match(sql, /locked_merchant AS MATERIALIZED[\s\S]*FOR UPDATE OF merchant/)
  assert.ok(
    sql.indexOf('locked_merchant AS MATERIALIZED') < sql.indexOf('consumed_code AS'),
    'the merchant row must lock before authorization-code consumption',
  )
  assert.match(sql, /UPDATE oauth_authorization_codes code[\s\S]*FROM eligible_code eligible[\s\S]*locked_merchant merchant/)
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
  assert.match(
    rotatedFake.captured[0]!.text,
    /family\.expires_at >= now\(\) \+ interval '10 minutes'/,
    'a successful refresh must always receive the promised 10-minute access-token lifetime',
  )

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

test('schema and migrations isolate OAuth hashes with bounded lifetimes', async () => {
  const [schema, migration, identityMigration] = await Promise.all([
    readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'),
    readFile(new URL('../db/migrations/20260822_hosted_market_signin.sql', import.meta.url), 'utf8'),
    readFile(new URL('../db/migrations/20260827_market_identity.sql', import.meta.url), 'utf8'),
  ])

  for (const sql of [schema, migration]) {
    assert.match(sql, /CREATE TABLE IF NOT EXISTS oauth_authorization_requests/)
    assert.match(sql, /session_hash\s+TEXT NOT NULL UNIQUE[\s\S]*'\^\[0-9a-f\]\{64\}\$'/)
    assert.match(sql, /csrf_hash\s+TEXT NOT NULL UNIQUE[\s\S]*'\^\[0-9a-f\]\{64\}\$'/)
    assert.match(sql, /scope\s+TEXT NOT NULL CHECK \(scope = 'market:merchant'\)/)
    assert.match(sql, /code_challenge_method\s+TEXT NOT NULL DEFAULT 'S256'/)
    assert.match(sql, /expires_at > created_at AND expires_at <= created_at \+ INTERVAL '5 minutes'/)
    assert.match(sql, /expires_at <= created_at \+ INTERVAL '30 days'/)
    assert.match(sql, /WHEN 'access' THEN INTERVAL '10 minutes'/)
    assert.match(sql, /attempt_kind IN \('authorize', 'merchant_key', 'token', 'refresh', 'revoke'\)/)
    assert.match(sql, /oauth_authorization_codes_retention/)
    assert.match(sql, /oauth_token_families_retention/)
    assert.doesNotMatch(
      sql,
      /merchant_secret(?!_hash)|permanent_key|bearer_secret|access_token\s+TEXT|refresh_token\s+TEXT/,
    )
  }
  for (const sql of [schema, identityMigration]) {
    assert.match(sql, /oauth_authorization_requests_identity_state/)
    assert.match(sql, /intent[\s\S]*new_handle[\s\S]*new_model[\s\S]*new_secret_hash/)
    assert.match(sql, /merchant_key_confirmed_at/)
    assert.match(sql, /oauth_authorization_request_recovery_codes/)
  }
})
