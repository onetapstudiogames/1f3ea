import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import test, { mock } from 'node:test'
import { Client, Pool, type PoolClient } from 'pg'

type IdentityStore = typeof import('../../src/market-identity-store.ts')

const POSTGRES_IMAGE = 'postgres@sha256:7958605b474b3d264a969cb3a123d6aa00ad1e1fe9da8a69984dabb704d93317'
const POSTGRES_DATABASE = 'market_identity_integration'
const schemaDdl = await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8')
const migrationDdl = await readFile(
  new URL('../../db/migrations/20260827_market_identity.sql', import.meta.url),
  'utf8',
)

let database: Pool | null = null

type DeferredQuery = {
  strings: TemplateStringsArray
  values: readonly unknown[]
}

function queryText(strings: TemplateStringsArray, values: readonly unknown[]): string {
  return strings.reduce(
    (text, part, index) => text + part + (index < values.length ? `$${index + 1}` : ''),
    '',
  )
}

const sql = async (
  strings: TemplateStringsArray,
  ...values: readonly unknown[]
): Promise<Record<string, unknown>[]> => {
  assert.ok(database, 'the PostgreSQL test client must be connected before the identity store runs')
  return (await database.query(queryText(strings, values), [...values])).rows as Record<string, unknown>[]
}

async function runReadCommittedTransaction(
  buildQueries: (
    transactionSql: (strings: TemplateStringsArray, ...values: readonly unknown[]) => DeferredQuery
  ) => DeferredQuery[],
): Promise<Record<string, unknown>[][]> {
  assert.ok(database, 'the PostgreSQL test client must be connected before a transaction runs')
  const client: PoolClient = await database.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
    const queries = buildQueries((strings, ...values) => ({ strings, values }))
    const results: Record<string, unknown>[][] = []
    for (const query of queries) {
      results.push((await client.query(queryText(query.strings, query.values), [...query.values])).rows)
    }
    await client.query('COMMIT')
    return results
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

mock.module(new URL('../../src/db.ts', import.meta.url).href, {
  namedExports: { runReadCommittedTransaction, sql },
})

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

function runDocker(args: readonly string[]): string {
  const result = spawnSync('docker', [...args], { encoding: 'utf8' })
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status ?? 'unknown'}`
    throw new Error(`docker ${args[0] ?? ''} failed: ${detail}`)
  }
  return result.stdout.trim()
}

async function startPostgres(): Promise<{ client: Pool; containerName: string }> {
  const containerName = `1f3ea-identity-test-${process.pid}-${randomBytes(4).toString('hex')}`
  const password = randomBytes(24).toString('hex')
  runDocker([
    'run', '--detach', '--rm', '--name', containerName,
    '--publish', '127.0.0.1::5432',
    '--env', `POSTGRES_PASSWORD=${password}`,
    '--env', `POSTGRES_DB=${POSTGRES_DATABASE}`,
    POSTGRES_IMAGE,
  ])
  try {
    const portOutput = runDocker(['port', containerName, '5432/tcp'])
    const port = Number(portOutput.match(/:(\d+)\s*$/u)?.[1])
    assert.ok(Number.isInteger(port) && port > 0)
    const connection = {
      host: '127.0.0.1', port, user: 'postgres', password,
      database: POSTGRES_DATABASE, ssl: false,
    } as const
    const deadline = Date.now() + 30_000
    let lastError: unknown
    while (Date.now() < deadline) {
      const probe = new Client(connection)
      try {
        await probe.connect()
        await probe.end()
        return { client: new Pool({ ...connection, max: 8 }), containerName }
      } catch (error) {
        lastError = error
        await probe.end().catch(() => undefined)
        await delay(200)
      }
    }
    throw lastError instanceof Error ? lastError : new Error('PostgreSQL did not become ready')
  } catch (error) {
    spawnSync('docker', ['stop', '--time', '0', containerName], { encoding: 'utf8' })
    throw error
  }
}

async function resetDatabase(): Promise<void> {
  assert.ok(database)
  await database.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await database.query(schemaDdl)
}

function registration(label: string, handle = `merchant-${label}`) {
  return {
    sessionHash: sha256(`${label}:session`),
    csrfHash: sha256(`${label}:csrf`),
    ipHash: sha256(`${label}:ip`),
    handle,
    model: 'postgres-test',
    clientClass: 'coding_ephemeral' as const,
    merchantSecretHash: sha256(`${label}:merchant-key`),
    recoveryCodeHashes: Array.from(
      { length: 8 },
      (_, index) => sha256(`${label}:recovery:${index}`),
    ),
  }
}

function rotation(label: string, currentKey: string, replacementKey = `${label}:replacement`) {
  return {
    sessionHash: sha256(`${label}:session`),
    csrfHash: sha256(`${label}:csrf`),
    merchantSecretHash: sha256(currentKey),
    replacementSecretHash: sha256(replacementKey),
  }
}

async function seedMerchant(handle = 'existing-merchant', key = 'existing-key'): Promise<number> {
  assert.ok(database)
  const result = await database.query<{ id: number }>(
    `INSERT INTO merchants (handle, model, secret_hash)
     VALUES ($1, 'postgres-test', $2) RETURNING id`,
    [handle, sha256(key)],
  )
  return result.rows[0]!.id
}

async function generateCodes(
  store: IdentityStore,
  merchantId: number,
  label: string,
  key = 'existing-key',
): Promise<string[]> {
  const raw = Array.from({ length: 8 }, (_, index) => `1f3ea_rc_${sha256(`${label}:${index}`)}`)
  const result = await store.generateMerchantRecoveryCodes({
    merchantSecretHash: sha256(key),
    codeHashes: raw.map(sha256),
  })
  assert.deepEqual(result, { merchantId, handle: 'existing-merchant', generation: 1 })
  return raw
}

async function seedOAuthState(merchantId: number, label: string): Promise<void> {
  assert.ok(database)
  const request = await database.query<{ id: string }>(
    `INSERT INTO oauth_authorization_requests (
       session_hash, csrf_hash, client_id, client_display_name, redirect_uri, resource,
       scope, state, code_challenge, intent, merchant_id,
       verified_at, approved_at, expires_at, used_at
     ) VALUES (
       $1, $2, $3, 'PostgreSQL test', 'https://chatgpt.com/connector_platform_oauth_redirect',
       'https://1f3ea.com/mcp/connect', 'market:merchant', 'state', $4, 'existing', $5,
       now(), now(), now() + interval '15 minutes', now()
     ) RETURNING id`,
    [sha256(`${label}:oauth-session`), sha256(`${label}:oauth-csrf`), `client-${label}`, 'A'.repeat(43), merchantId],
  )
  await database.query(
    `INSERT INTO oauth_authorization_codes (
       request_id, code_hash, merchant_id, client_id, redirect_uri, resource, scope,
       code_challenge, expires_at
     ) VALUES (
       $1, $2, $3, $4, 'https://chatgpt.com/connector_platform_oauth_redirect',
       'https://1f3ea.com/mcp/connect', 'market:merchant', $5, now() + interval '5 minutes'
     )`,
    [request.rows[0]!.id, sha256(`${label}:authorization-code`), merchantId, `client-${label}`, 'A'.repeat(43)],
  )
  const family = await database.query<{ id: string }>(
    `INSERT INTO oauth_token_families (merchant_id, client_id, resource, scope, expires_at)
     VALUES ($1, $2, 'https://1f3ea.com/mcp/connect', 'market:merchant', now() + interval '30 days')
     RETURNING id`,
    [merchantId, `client-${label}`],
  )
  await database.query(
    `INSERT INTO oauth_tokens (token_hash, token_type, family_id, expires_at) VALUES
       ($1, 'access', $3, now() + interval '10 minutes'),
       ($2, 'refresh', $3, now() + interval '30 days')`,
    [sha256(`${label}:access`), sha256(`${label}:refresh`), family.rows[0]!.id],
  )
}

async function assertOAuthRevoked(merchantId: number): Promise<void> {
  assert.ok(database)
  const state = await database.query(
    `SELECT
       (SELECT count(*) FROM oauth_token_families
        WHERE merchant_id = $1 AND revoked_at IS NOT NULL) AS families,
       (SELECT count(*) FROM oauth_tokens token JOIN oauth_token_families family
        ON family.id = token.family_id
        WHERE family.merchant_id = $1 AND token.revoked_at IS NOT NULL) AS tokens,
       (SELECT count(*) FROM oauth_authorization_codes
        WHERE merchant_id = $1 AND used_at IS NOT NULL) AS codes`,
    [merchantId],
  )
  assert.deepEqual(state.rows, [{ families: '1', tokens: '2', codes: '1' }])
}

test('market identity storage is atomic against real PostgreSQL', async t => {
  const postgres = await startPostgres()
  database = postgres.client
  try {
    const store = await import('../../src/market-identity-store.ts')

    await t.test('the additive migration is idempotent and preserves a merchant', async () => {
      await resetDatabase()
      const merchantId = await seedMerchant()
      await database!.query(migrationDdl)
      await database!.query(migrationDdl)
      const state = await database!.query(
        `SELECT id, handle, recovery_generation,
          (SELECT count(*) FROM pending_merchant_registrations) AS pending,
          (SELECT count(*) FROM merchant_recovery_codes) AS recovery_codes
         FROM merchants WHERE id = $1`,
        [merchantId],
      )
      assert.deepEqual(state.rows, [{
        id: merchantId, handle: 'existing-merchant', recovery_generation: '0',
        pending: '0', recovery_codes: '0',
      }])
    })

    await t.test('OAuth identity states preserve scrubbed cancellation and reject partial creation', async () => {
      await resetDatabase()
      await database!.query(migrationDdl)
      const insertRequest = `INSERT INTO oauth_authorization_requests (
        session_hash, csrf_hash, client_id, redirect_uri, resource, scope, state,
        code_challenge, intent, new_handle, new_model, new_secret_hash,
        verified_at, approved_at, used_at, expires_at
      ) VALUES (
        $1, $2, $3, 'https://chatgpt.com/connector_platform_oauth_redirect',
        'https://1f3ea.com/mcp/connect', 'market:merchant', 'state', $4,
        $5, $6, $7, $8, $9, $10, $11, now() + interval '15 minutes'
      ) RETURNING id`
      const challenge = 'A'.repeat(43)

      const canceled = await database!.query<{ id: string }>(insertRequest, [
        sha256('canceled-session'), sha256('canceled-csrf'), 'canceled-client', challenge,
        null, null, null, null, null, null, null,
      ])
      await database!.query(
        'UPDATE oauth_authorization_requests SET used_at = now() WHERE id = $1',
        [canceled.rows[0]!.id],
      )
      const partial = await database!.query<{ id: string }>(insertRequest, [
        sha256('partial-session'), sha256('partial-csrf'), 'partial-client', challenge,
        'new', 'partial-merchant', 'postgres-test', sha256('partial-key'),
        null, null, null,
      ])
      await assert.rejects(database!.query(
        'UPDATE oauth_authorization_requests SET verified_at = now() WHERE id = $1',
        [partial.rows[0]!.id],
      ), (error: unknown) => {
        assert.equal(
          (error as { constraint?: string }).constraint,
          'oauth_authorization_requests_identity_state',
        )
        return true
      })

      const staged = await database!.query<{ id: string }>(insertRequest, [
        sha256('staged-session'), sha256('staged-csrf'), 'staged-client', challenge,
        'new', 'oauth-new', 'postgres-test', sha256('oauth-new-key'), null, null, null,
      ])
      const stagedHashes = Array.from({ length: 8 }, (_, index) => sha256(`oauth-code:${index}`))
      await database!.query(
        `INSERT INTO oauth_authorization_request_recovery_codes (request_id, ordinal, code_hash)
         SELECT $1, code.ordinality, code.code_hash
         FROM unnest($2::text[]) WITH ORDINALITY AS code(code_hash, ordinality)`,
        [staged.rows[0]!.id, stagedHashes],
      )
      const merchantId = await seedMerchant('oauth-new', 'oauth-new-key')
      await database!.query(
        `UPDATE oauth_authorization_requests
         SET merchant_id = $2, new_secret_hash = NULL, merchant_key_confirmed_at = now(),
             verified_at = now(), approved_at = now(), used_at = now()
         WHERE id = $1`,
        [staged.rows[0]!.id, merchantId],
      )
      assert.deepEqual((await database!.query(
        `SELECT intent, merchant_id, new_secret_hash, merchant_key_confirmed_at IS NOT NULL AS confirmed,
          (SELECT count(*) FROM oauth_authorization_request_recovery_codes
           WHERE request_id = oauth_authorization_requests.id) AS recovery_codes
         FROM oauth_authorization_requests WHERE id = $1`,
        [staged.rows[0]!.id],
      )).rows, [{
        intent: 'new', merchant_id: merchantId, new_secret_hash: null,
        confirmed: true, recovery_codes: '8',
      }])
    })

    await t.test('identity attempt ceilings remain atomic under concurrent calls and clean old windows', async () => {
      await resetDatabase()
      const bucketHash = sha256('concurrent-identity-limit')
      const admitted = await Promise.all(Array.from({ length: 20 }, () =>
        store.consumeMarketIdentityRateLimit({
          bucketHash, attemptKind: 'recovery_begin', maximum: 5,
        })))
      assert.equal(admitted.filter(Boolean).length, 5)
      assert.equal(admitted.filter(result => !result).length, 15)
      assert.deepEqual((await database!.query(
        `SELECT used FROM merchant_identity_rate_limits
         WHERE bucket_hash = $1 AND attempt_kind = 'recovery_begin'`,
        [bucketHash],
      )).rows, [{ used: 5 }])

      await database!.query(
        `UPDATE merchant_identity_rate_limits
         SET window_start = date_trunc('hour', now(), 'UTC') - interval '25 hours'`,
      )
      assert.equal(await store.consumeMarketIdentityRateLimit({
        bucketHash: sha256('fresh-limit'), attemptKind: 'join_confirm', maximum: 1,
      }), true)
      assert.equal((await database!.query(
        `SELECT count(*) FROM merchant_identity_rate_limits
         WHERE window_start < date_trunc('hour', now(), 'UTC') - interval '24 hours'`,
      )).rows[0]!.count, '0')
    })

    await t.test('registration creates nothing before exact key confirmation and replay tells the truth', async () => {
      await resetDatabase()
      const input = registration('registration')
      assert.deepEqual(await store.stageMerchantRegistration(input), {
        status: 'staged', handle: input.handle,
      })
      assert.deepEqual(await store.getMerchantRegistrationProgress({
        sessionHash: input.sessionHash, csrfHash: input.csrfHash,
      }), {
        status: 'staged', handle: input.handle, clientClass: input.clientClass,
      })
      assert.equal((await database!.query('SELECT count(*) FROM merchants')).rows[0]!.count, '0')

      assert.deepEqual(await store.confirmMerchantRegistration({
        sessionHash: input.sessionHash,
        csrfHash: input.csrfHash,
        merchantSecretHash: sha256('wrong-key'),
      }), { status: 'credential_rejected' })
      assert.equal((await database!.query('SELECT count(*) FROM merchants')).rows[0]!.count, '0')

      const confirmed = await store.confirmMerchantRegistration({
        sessionHash: input.sessionHash,
        csrfHash: input.csrfHash,
        merchantSecretHash: input.merchantSecretHash,
      })
      assert.equal(confirmed.status, 'confirmed')
      assert.equal(confirmed.handle, input.handle)
      assert.deepEqual(await store.confirmMerchantRegistration({
        sessionHash: input.sessionHash,
        csrfHash: input.csrfHash,
        merchantSecretHash: input.merchantSecretHash,
      }), confirmed)
      assert.deepEqual(await store.confirmMerchantRegistration({
        sessionHash: input.sessionHash,
        csrfHash: input.csrfHash,
        merchantSecretHash: sha256('wrong-after-confirmation'),
      }), { status: 'credential_rejected' })

      const state = await database!.query(
        `SELECT merchant.secret_hash, merchant.recovery_generation,
          (SELECT count(*) FROM merchant_recovery_codes code
           WHERE code.merchant_id = merchant.id AND code.generation = 1) AS codes,
          (SELECT count(*) FROM pending_merchant_registration_recovery_codes) AS pending_codes,
          event.detail
         FROM merchants merchant
         JOIN events event ON event.kind = 'register' AND event.actor = merchant.handle
         WHERE merchant.handle = $1`,
        [input.handle],
      )
      assert.deepEqual(state.rows, [{
        secret_hash: input.merchantSecretHash,
        recovery_generation: '1',
        codes: '8',
        pending_codes: '0',
        detail: { id: (confirmed as { merchantId: number }).merchantId, model: input.model },
      }])
    })

    await t.test('registration counts a model label in Unicode characters, matching PostgreSQL', async () => {
      await resetDatabase()
      const input = { ...registration('unicode-model'), model: '🛒'.repeat(120) }
      assert.deepEqual(await store.stageMerchantRegistration(input), {
        status: 'staged', handle: input.handle,
      })
    })

    await t.test('two staged sessions may race for a handle but exactly one becomes the merchant', async () => {
      await resetDatabase()
      const first = registration('race-first', 'one-handle')
      const second = registration('race-second', 'one-handle')
      assert.equal((await store.stageMerchantRegistration(first)).status, 'staged')
      assert.equal((await store.stageMerchantRegistration(second)).status, 'staged')

      const outcomes = await Promise.all([first, second].map(input =>
        store.confirmMerchantRegistration({
          sessionHash: input.sessionHash,
          csrfHash: input.csrfHash,
          merchantSecretHash: input.merchantSecretHash,
        })))
      assert.deepEqual(outcomes.map(outcome => outcome.status).sort(), ['confirmed', 'handle_taken'])
      const state = await database!.query(
        `SELECT
           (SELECT count(*) FROM merchants WHERE handle = 'one-handle') AS merchants,
           (SELECT count(*) FROM merchant_recovery_codes code JOIN merchants merchant
            ON merchant.id = code.merchant_id WHERE merchant.handle = 'one-handle') AS codes,
           (SELECT count(*) FROM pending_merchant_registration_recovery_codes) AS pending_codes`,
      )
      assert.deepEqual(state.rows, [{ merchants: '1', codes: '8', pending_codes: '0' }])
    })

    await t.test('recovery generation replaces the set and rejects an old code', async () => {
      await resetDatabase()
      const merchantId = await seedMerchant()
      const firstCodes = await generateCodes(store, merchantId, 'first-set')
      const secondHashes = Array.from({ length: 8 }, (_, index) => sha256(`second-set:${index}`))
      assert.deepEqual(await store.generateMerchantRecoveryCodes({
        merchantSecretHash: sha256('existing-key'), codeHashes: secondHashes,
      }), { merchantId, handle: 'existing-merchant', generation: 2 })
      assert.deepEqual(await store.stageMerchantRecovery({
        sessionHash: sha256('old-code-session'), csrfHash: sha256('old-code-csrf'),
        recoveryCodeHash: sha256(firstCodes[0]!), replacementSecretHash: sha256('replacement'),
      }), { status: 'credential_rejected' })
      const state = await database!.query(
        `SELECT generation, count(*) AS count,
          count(*) FILTER (WHERE invalidated_at IS NOT NULL) AS invalidated
         FROM merchant_recovery_codes GROUP BY generation ORDER BY generation`,
      )
      assert.deepEqual(state.rows, [
        { generation: '1', count: '8', invalidated: '8' },
        { generation: '2', count: '8', invalidated: '0' },
      ])
    })

    await t.test('recovery confirmation changes the key and revokes every sibling and OAuth credential', async () => {
      await resetDatabase()
      const merchantId = await seedMerchant()
      const codes = await generateCodes(store, merchantId, 'recovery')
      await seedOAuthState(merchantId, 'recovery')
      const pendingRotation = rotation('recovery-invalidates-rotation', 'existing-key')
      assert.equal((await store.stageMerchantRotation(pendingRotation)).status, 'staged')

      const recovery = {
        sessionHash: sha256('recovery-session'),
        csrfHash: sha256('recovery-csrf'),
        recoveryCodeHash: sha256(codes[0]!),
        replacementSecretHash: sha256('recovered-key'),
      }
      assert.deepEqual(await store.stageMerchantRecovery(recovery), {
        status: 'staged', handle: 'existing-merchant',
      })
      assert.deepEqual(await store.getMerchantRecoveryProgress(recovery), {
        status: 'staged', merchantId, handle: 'existing-merchant',
      })
      assert.deepEqual(await store.confirmMerchantRecovery({
        sessionHash: recovery.sessionHash, csrfHash: recovery.csrfHash,
        replacementSecretHash: sha256('wrong-replacement'),
      }), { status: 'credential_rejected' })
      assert.deepEqual(await store.confirmMerchantRecovery({
        sessionHash: recovery.sessionHash, csrfHash: recovery.csrfHash,
        replacementSecretHash: recovery.replacementSecretHash,
      }), { status: 'recovered', merchantId, handle: 'existing-merchant' })
      assert.deepEqual(await store.getMerchantRecoveryProgress(recovery), {
        status: 'recovered', merchantId, handle: 'existing-merchant',
      })
      assert.deepEqual(await store.getMerchantRotationProgress(pendingRotation), {
        status: 'invalidated',
      })

      const state = await database!.query(
        `SELECT merchant.secret_hash, merchant.recovery_generation,
          count(*) FILTER (WHERE code.used_at IS NOT NULL) AS used,
          count(*) FILTER (WHERE code.invalidated_at IS NOT NULL) AS invalidated,
          (SELECT count(*) FROM merchant_key_rotations
           WHERE merchant_id = merchant.id AND invalidated_at IS NOT NULL) AS rotations,
          (SELECT count(*) FROM events WHERE kind = 'rotate' AND actor = merchant.handle) AS events
         FROM merchants merchant JOIN merchant_recovery_codes code ON code.merchant_id = merchant.id
         WHERE merchant.id = $1 GROUP BY merchant.id`,
        [merchantId],
      )
      assert.deepEqual(state.rows, [{
        secret_hash: recovery.replacementSecretHash, recovery_generation: '2',
        used: '1', invalidated: '7', rotations: '1', events: '1',
      }])
      await assertOAuthRevoked(merchantId)
      assert.deepEqual((await database!.query(
        `SELECT recovery_session_hash, recovery_csrf_hash, replacement_secret_hash,
          recovery_expires_at, staged_at FROM merchant_recovery_codes WHERE used_at IS NOT NULL`,
      )).rows, [{
        recovery_session_hash: null, recovery_csrf_hash: null,
        replacement_secret_hash: null, recovery_expires_at: null, staged_at: null,
      }])
      assert.deepEqual((await database!.query(
        `SELECT session_hash, csrf_hash, outcome
         FROM merchant_recovery_ceremony_results WHERE merchant_id = $1 AND outcome = 'recovered'`,
        [merchantId],
      )).rows, [{
        session_hash: recovery.sessionHash, csrf_hash: recovery.csrfHash, outcome: 'recovered',
      }])
      assert.deepEqual(await store.confirmMerchantRecovery({
        sessionHash: recovery.sessionHash, csrfHash: recovery.csrfHash,
        replacementSecretHash: recovery.replacementSecretHash,
      }), { status: 'request_unavailable' })
    })

    await t.test('rotation is staged, caller-distinct, atomic, and revokes recovery and OAuth state', async () => {
      await resetDatabase()
      const merchantId = await seedMerchant()
      const codes = await generateCodes(store, merchantId, 'rotation')
      await seedOAuthState(merchantId, 'rotation')
      const pendingRecovery = {
        sessionHash: sha256('rotation-invalidates-recovery-session'),
        csrfHash: sha256('rotation-invalidates-recovery-csrf'),
        recoveryCodeHash: sha256(codes[0]!), replacementSecretHash: sha256('unused-recovery-key'),
      }
      assert.equal((await store.stageMerchantRecovery(pendingRecovery)).status, 'staged')

      assert.deepEqual(await store.stageMerchantRotation(rotation('bad-current', 'wrong-key')), {
        status: 'credential_rejected',
      })
      assert.deepEqual(await store.stageMerchantRotation(rotation('same-key', 'existing-key', 'existing-key')), {
        status: 'request_unavailable',
      })
      const input = rotation('rotation-success', 'existing-key', 'rotated-key')
      assert.deepEqual(await store.stageMerchantRotation(input), {
        status: 'staged', merchantId, handle: 'existing-merchant',
      })
      assert.deepEqual(await store.getMerchantRotationProgress(input), {
        status: 'staged', merchantId, handle: 'existing-merchant',
      })
      assert.deepEqual(await store.confirmMerchantRotation({
        sessionHash: input.sessionHash, csrfHash: input.csrfHash,
        replacementSecretHash: sha256('wrong-replacement'),
      }), { status: 'credential_rejected' })
      assert.deepEqual(await store.confirmMerchantRotation({
        sessionHash: input.sessionHash, csrfHash: input.csrfHash,
        replacementSecretHash: input.replacementSecretHash,
      }), { status: 'rotated', merchantId, handle: 'existing-merchant' })
      assert.deepEqual(await store.getMerchantRotationProgress(input), {
        status: 'rotated', merchantId, handle: 'existing-merchant',
      })
      assert.deepEqual(await store.getMerchantRecoveryProgress(pendingRecovery), {
        status: 'invalidated',
      })

      const state = await database!.query(
        `SELECT merchant.secret_hash, merchant.recovery_generation,
          (SELECT count(*) FROM merchant_recovery_codes
           WHERE merchant_id = merchant.id AND invalidated_at IS NOT NULL) AS invalidated_codes,
          (SELECT count(*) FROM events WHERE kind = 'rotate' AND actor = merchant.handle) AS events
         FROM merchants merchant WHERE merchant.id = $1`,
        [merchantId],
      )
      assert.deepEqual(state.rows, [{
        secret_hash: input.replacementSecretHash,
        recovery_generation: '2', invalidated_codes: '8', events: '1',
      }])
      await assertOAuthRevoked(merchantId)
      assert.deepEqual((await database!.query(
        `SELECT session_hash, csrf_hash, merchant_secret_hash, replacement_secret_hash
         FROM merchant_key_rotations WHERE confirmed_at IS NOT NULL`,
      )).rows, [{
        session_hash: input.sessionHash, csrf_hash: input.csrfHash,
        merchant_secret_hash: null, replacement_secret_hash: null,
      }])
      assert.deepEqual(await store.confirmMerchantRotation({
        sessionHash: input.sessionHash, csrfHash: input.csrfHash,
        replacementSecretHash: input.replacementSecretHash,
      }), { status: 'request_unavailable' })
    })

    await t.test('recovery confirmation and cancellation expose exactly one terminal winner', async () => {
      await resetDatabase()
      const merchantId = await seedMerchant()
      const codes = await generateCodes(store, merchantId, 'recovery-race')
      const canceledInput = {
        sessionHash: sha256('recovery-cancel-session'), csrfHash: sha256('recovery-cancel-csrf'),
        recoveryCodeHash: sha256(codes[1]!), replacementSecretHash: sha256('discarded-recovery-key'),
      }
      assert.equal((await store.stageMerchantRecovery(canceledInput)).status, 'staged')
      assert.equal(await store.cancelMerchantRecovery(canceledInput), true)
      assert.deepEqual(await store.getMerchantRecoveryProgress(canceledInput), { status: 'canceled' })
      const input = {
        sessionHash: sha256('recovery-race-session'), csrfHash: sha256('recovery-race-csrf'),
        recoveryCodeHash: sha256(codes[0]!), replacementSecretHash: sha256('recovery-race-key'),
      }
      assert.equal((await store.stageMerchantRecovery(input)).status, 'staged')
      const [confirmed, canceled] = await Promise.all([
        store.confirmMerchantRecovery(input), store.cancelMerchantRecovery(input),
      ])
      const progress = await store.getMerchantRecoveryProgress(input)
      assert.equal((confirmed.status === 'recovered') !== canceled, true)
      assert.equal(progress.status, confirmed.status === 'recovered' ? 'recovered' : 'canceled')
      assert.deepEqual((await database!.query(
        `SELECT secret_hash FROM merchants WHERE id = $1`, [merchantId],
      )).rows, [{ secret_hash: confirmed.status === 'recovered'
        ? input.replacementSecretHash : sha256('existing-key') }])
    })

    await t.test('reused recovery codes cannot erase canceled or expired ceremony truth', async () => {
      await resetDatabase()
      const merchantId = await seedMerchant()
      const codes = await generateCodes(store, merchantId, 'durable-recovery-progress')
      const canceled = {
        sessionHash: sha256('durable-canceled-session'),
        csrfHash: sha256('durable-canceled-csrf'),
        recoveryCodeHash: sha256(codes[0]!),
        replacementSecretHash: sha256('durable-canceled-key'),
      }
      assert.equal((await store.stageMerchantRecovery(canceled)).status, 'staged')
      assert.equal(await store.cancelMerchantRecovery(canceled), true)
      assert.deepEqual(await store.stageMerchantRecovery({
        ...canceled, replacementSecretHash: sha256('same-canceled-session-key'),
      }), { status: 'credential_rejected' })
      const reusedCanceled = {
        ...canceled,
        sessionHash: sha256('reused-canceled-session'),
        csrfHash: sha256('reused-canceled-csrf'),
        replacementSecretHash: sha256('reused-canceled-key'),
      }
      assert.equal((await store.stageMerchantRecovery(reusedCanceled)).status, 'staged')
      assert.deepEqual(await store.getMerchantRecoveryProgress(canceled), { status: 'canceled' })
      assert.deepEqual(await store.getMerchantRecoveryProgress(reusedCanceled), {
        status: 'staged', merchantId, handle: 'existing-merchant',
      })

      const expired = {
        sessionHash: sha256('durable-expired-session'),
        csrfHash: sha256('durable-expired-csrf'),
        recoveryCodeHash: sha256(codes[1]!),
        replacementSecretHash: sha256('durable-expired-key'),
      }
      assert.equal((await store.stageMerchantRecovery(expired)).status, 'staged')
      await database!.query(
        `UPDATE merchant_recovery_codes SET staged_at = now() - interval '16 minutes',
           recovery_expires_at = now() - interval '1 minute' WHERE recovery_session_hash = $1`,
        [expired.sessionHash],
      )
      assert.deepEqual(await store.stageMerchantRecovery({
        ...expired, replacementSecretHash: sha256('same-expired-session-key'),
      }), { status: 'credential_rejected' })
      const reusedExpired = {
        ...expired,
        sessionHash: sha256('reused-expired-session'),
        csrfHash: sha256('reused-expired-csrf'),
        replacementSecretHash: sha256('reused-expired-key'),
      }
      assert.equal((await store.stageMerchantRecovery(reusedExpired)).status, 'staged')
      assert.deepEqual(await store.getMerchantRecoveryProgress(expired), { status: 'expired' })
      assert.deepEqual(await store.getMerchantRecoveryProgress(reusedExpired), {
        status: 'staged', merchantId, handle: 'existing-merchant',
      })
      await database!.query(
        `UPDATE merchant_recovery_ceremony_results
         SET terminal_at = now() - interval '25 hours', expires_at = now() - interval '1 hour'
         WHERE session_hash = $1`,
        [canceled.sessionHash],
      )
      assert.deepEqual(await store.getMerchantRecoveryProgress(canceled), { status: 'new' })
      assert.equal((await database!.query(
        `SELECT count(*) FROM merchant_recovery_ceremony_results WHERE expires_at <= now()`,
      )).rows[0]!.count, '0')
    })

    await t.test('rotation confirmation and cancellation expose exactly one terminal winner', async () => {
      await resetDatabase()
      const merchantId = await seedMerchant()
      const canceledInput = rotation('rotation-cancel', 'existing-key', 'discarded-rotation-key')
      assert.equal((await store.stageMerchantRotation(canceledInput)).status, 'staged')
      assert.equal(await store.cancelMerchantRotation(canceledInput), true)
      assert.deepEqual(await store.getMerchantRotationProgress(canceledInput), { status: 'canceled' })
      const input = rotation('rotation-race', 'existing-key', 'rotation-race-key')
      assert.equal((await store.stageMerchantRotation(input)).status, 'staged')
      const [confirmed, canceled] = await Promise.all([
        store.confirmMerchantRotation(input), store.cancelMerchantRotation(input),
      ])
      const progress = await store.getMerchantRotationProgress(input)
      assert.equal((confirmed.status === 'rotated') !== canceled, true)
      assert.equal(progress.status, confirmed.status === 'rotated' ? 'rotated' : 'canceled')
      assert.deepEqual((await database!.query(
        `SELECT secret_hash FROM merchants WHERE id = $1`, [merchantId],
      )).rows, [{ secret_hash: confirmed.status === 'rotated'
        ? input.replacementSecretHash : sha256('existing-key') }])
    })

    await t.test('expired ceremonies retain resumable truth while scrubbing every credential hash', async () => {
      await resetDatabase()
      const merchantId = await seedMerchant()
      const codes = await generateCodes(store, merchantId, 'expiry')
      const recovery = {
        sessionHash: sha256('expired-recovery-session'), csrfHash: sha256('expired-recovery-csrf'),
        recoveryCodeHash: sha256(codes[0]!), replacementSecretHash: sha256('expired-recovery-key'),
      }
      const rotate = rotation('expired-rotation', 'existing-key', 'expired-rotation-key')
      assert.equal((await store.stageMerchantRecovery(recovery)).status, 'staged')
      assert.equal((await store.stageMerchantRotation(rotate)).status, 'staged')
      await database!.query(
        `UPDATE merchant_recovery_codes SET staged_at = now() - interval '16 minutes',
           recovery_expires_at = now() - interval '1 minute' WHERE recovery_session_hash = $1`,
        [recovery.sessionHash],
      )
      await database!.query(
        `UPDATE merchant_key_rotations SET created_at = now() - interval '16 minutes',
           expires_at = now() - interval '1 minute' WHERE session_hash = $1`,
        [rotate.sessionHash],
      )
      assert.equal((await store.getMerchantRecoveryProgress(recovery)).status, 'expired')
      assert.equal((await store.getMerchantRotationProgress(rotate)).status, 'expired')
      assert.deepEqual((await database!.query(
        `SELECT
          (SELECT replacement_secret_hash FROM merchant_recovery_codes
           WHERE recovery_session_hash = $1) AS recovery_secret,
          (SELECT merchant_secret_hash FROM merchant_key_rotations
           WHERE session_hash = $2) AS current_secret,
          (SELECT replacement_secret_hash FROM merchant_key_rotations
           WHERE session_hash = $2) AS rotation_secret`,
        [recovery.sessionHash, rotate.sessionHash],
      )).rows, [{ recovery_secret: null, current_secret: null, rotation_secret: null }])
    })

    await t.test('the sixth successful key rotation in one UTC day is refused without changing the key', async () => {
      await resetDatabase()
      const merchantId = await seedMerchant()
      let currentKey = 'existing-key'
      for (let index = 1; index <= 5; index += 1) {
        const replacementKey = `daily-key-${index}`
        const input = rotation(`daily-${index}`, currentKey, replacementKey)
        assert.equal((await store.stageMerchantRotation(input)).status, 'staged')
        assert.equal((await store.confirmMerchantRotation({
          sessionHash: input.sessionHash,
          csrfHash: input.csrfHash,
          replacementSecretHash: input.replacementSecretHash,
        })).status, 'rotated')
        currentKey = replacementKey
      }

      const sixth = rotation('daily-sixth', currentKey, 'daily-key-6')
      assert.equal((await store.stageMerchantRotation(sixth)).status, 'staged')
      assert.deepEqual(await store.confirmMerchantRotation({
        sessionHash: sixth.sessionHash,
        csrfHash: sixth.csrfHash,
        replacementSecretHash: sixth.replacementSecretHash,
      }), { status: 'rate_limited' })
      assert.deepEqual((await database!.query(
        `SELECT secret_hash, recovery_generation,
          (SELECT count(*) FROM merchant_key_rotations
           WHERE merchant_id = merchants.id AND confirmed_at IS NOT NULL) AS confirmed,
          (SELECT count(*) FROM merchant_key_rotations
           WHERE merchant_id = merchants.id AND canceled_at IS NOT NULL) AS canceled
         FROM merchants WHERE id = $1`,
        [merchantId],
      )).rows, [{
        secret_hash: sha256(currentKey), recovery_generation: '5',
        confirmed: '5', canceled: '1',
      }])
    })
  } finally {
    await database?.end().catch(() => undefined)
    database = null
    spawnSync('docker', ['stop', '--time', '0', postgres.containerName], { encoding: 'utf8' })
  }
})
