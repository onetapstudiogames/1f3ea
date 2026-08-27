import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import test, { mock } from 'node:test'
import { Client, Pool } from 'pg'
import type {
  AuthorizationRequestInput,
  MarketOAuthQuery,
} from '../../src/market-oauth-store.ts'

const POSTGRES_IMAGE = 'postgres@sha256:7958605b474b3d264a969cb3a123d6aa00ad1e1fe9da8a69984dabb704d93317'
const POSTGRES_DATABASE = 'market_oauth_integration'
const schemaDdl = await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8')

let database: Pool | null = null

function renderStatement(strings: TemplateStringsArray, values: readonly unknown[]): string {
  return strings.reduce(
    (text, part, index) => text + part + (index < values.length ? `$${index + 1}` : ''),
    '',
  )
}

const sql: MarketOAuthQuery = async (strings, ...values) => {
  assert.ok(database, 'the PostgreSQL test client must be connected before storage runs')
  const statement = renderStatement(strings, values)
  return (await database.query(statement, [...values])).rows as Record<string, unknown>[]
}

interface TransactionDescriptor {
  strings: TemplateStringsArray
  values: readonly unknown[]
}

async function runReadCommittedTransaction(
  buildQueries: (
    transactionSql: (strings: TemplateStringsArray, ...values: readonly unknown[]) => unknown,
  ) => unknown[],
): Promise<Record<string, unknown>[][]> {
  assert.ok(database, 'the PostgreSQL test client must be connected before a transaction runs')
  const descriptors = buildQueries(
    (strings, ...values) => ({ strings, values } satisfies TransactionDescriptor),
  ) as TransactionDescriptor[]
  const client = await database.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
    const results: Record<string, unknown>[][] = []
    for (const descriptor of descriptors) {
      results.push((await client.query(
        renderStatement(descriptor.strings, descriptor.values),
        [...descriptor.values],
      )).rows as Record<string, unknown>[])
    }
    await client.query('COMMIT')
    return results
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

mock.module(new URL('../../src/db.ts', import.meta.url).href, {
  namedExports: { runReadCommittedTransaction, sql },
})

const { createMarketOAuthStore } = await import('../../src/market-oauth-store.ts')
const {
  confirmMerchantRecovery,
  confirmMerchantRotation,
  generateMerchantRecoveryCodes,
  stageMerchantRecovery,
  stageMerchantRotation,
} = await import('../../src/market-identity-store.ts')

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
  const containerName = `1f3ea-oauth-test-${process.pid}-${randomBytes(4).toString('hex')}`
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
    assert.ok(Number.isInteger(port) && port > 0, `could not read PostgreSQL port from ${portOutput}`)
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

function authorization(label: string): AuthorizationRequestInput {
  return {
    sessionHash: sha256(`${label}:session`),
    csrfHash: sha256(`${label}:csrf`),
    clientId: `client-${label}`,
    clientName: 'PostgreSQL OAuth test',
    redirectUri: 'https://chat.example.test/oauth/callback',
    resource: 'https://1f3ea.com/mcp/connect',
    scope: 'market:merchant',
    state: `state-${label}`,
    codeChallenge: 'A'.repeat(43),
  }
}

function registration(label: string, handle = `merchant-${label}`) {
  return {
    ...authorization(label),
    handle,
    model: 'postgres-test',
    merchantSecretHash: sha256(`${label}:merchant-key`),
    recoveryCodeHashes: Array.from(
      { length: 8 },
      (_, index) => sha256(`${label}:recovery:${index}`),
    ),
  }
}

type GateTable =
  | 'merchant_key_rotations'
  | 'merchant_recovery_codes'
  | 'oauth_authorization_codes'
  | 'oauth_tokens'
  | 'oauth_token_families'
type GateEvent = 'INSERT' | 'UPDATE'

interface Settled<T> {
  ok: boolean
  value?: T
  error?: unknown
}

async function lockWaiterCount(): Promise<number> {
  assert.ok(database)
  const result = await database.query<{ waiting: number }>(
    `SELECT count(*)::integer AS waiting
     FROM pg_stat_activity
     WHERE datname = current_database()
       AND pid <> pg_backend_pid()
       AND wait_event_type = 'Lock'`,
  )
  return Number(result.rows[0]?.waiting ?? 0)
}

async function waitForLockWaiters(minimum: number): Promise<void> {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    if (await lockWaiterCount() >= minimum) return
    await delay(10)
  }
  throw new Error(`expected at least ${minimum} PostgreSQL lock waiters`)
}

async function observeSecondOperation(
  isSettled: () => boolean,
): Promise<'blocked' | 'settled'> {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    if (isSettled()) return 'settled'
    if (await lockWaiterCount() >= 2) return 'blocked'
    await delay(10)
  }
  throw new Error('second PostgreSQL operation neither settled nor waited on the first lock')
}

async function installAdvisoryGate(
  table: GateTable,
  event: GateEvent,
  label: string,
  advisoryKey: number,
): Promise<() => Promise<void>> {
  assert.ok(database)
  assert.match(label, /^[a-z][a-z0-9_]+$/u)
  assert.ok(Number.isSafeInteger(advisoryKey))
  const functionName = `oauth_race_gate_${label}`
  const triggerName = `${functionName}_trigger`
  await database.query(
    `CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         PERFORM pg_advisory_xact_lock(${advisoryKey});
         RETURN NEW;
       END
     $$`,
  )
  await database.query(
    `CREATE TRIGGER ${triggerName} BEFORE ${event} ON ${table}
     FOR EACH ROW EXECUTE FUNCTION ${functionName}()`,
  )
  return async () => {
    assert.ok(database)
    await database.query(`DROP TRIGGER ${triggerName} ON ${table}`)
    await database.query(`DROP FUNCTION ${functionName}()`)
  }
}

async function runPausedRace<First, Second>(input: {
  table: GateTable
  event: GateEvent
  label: string
  advisoryKey: number
  first: () => Promise<First>
  second: () => Promise<Second>
}): Promise<{ first: First; second: Second; secondState: 'blocked' | 'settled' }> {
  assert.ok(database)
  const cleanupGate = await installAdvisoryGate(
    input.table, input.event, input.label, input.advisoryKey,
  )
  const blocker = await database.connect()
  let firstOutcome: Promise<Settled<First>> | undefined
  let secondOutcome: Promise<Settled<Second>> | undefined
  let secondState: 'blocked' | 'settled' = 'settled'
  let orchestrationError: unknown
  try {
    await blocker.query('SELECT pg_advisory_lock($1)', [input.advisoryKey])
    firstOutcome = input.first().then(
      value => ({ ok: true, value }),
      error => ({ ok: false, error }),
    )
    await waitForLockWaiters(1)
    let secondSettled = false
    secondOutcome = input.second().then(
      value => ({ ok: true, value }),
      error => ({ ok: false, error }),
    ).finally(() => { secondSettled = true })
    secondState = await observeSecondOperation(() => secondSettled)
  } catch (error) {
    orchestrationError = error
  } finally {
    await blocker.query('SELECT pg_advisory_unlock($1)', [input.advisoryKey]).catch(() => undefined)
    blocker.release()
  }

  const [firstResult, secondResult] = await Promise.all([firstOutcome, secondOutcome])
  await cleanupGate()
  if (firstResult && !firstResult.ok) throw firstResult.error
  if (secondResult && !secondResult.ok) throw secondResult.error
  if (orchestrationError) throw orchestrationError
  assert.ok(firstResult?.ok, 'the paused first operation must complete')
  assert.ok(secondResult?.ok, 'the competing second operation must complete')
  return {
    first: firstResult.value as First,
    second: secondResult.value as Second,
    secondState,
  }
}

async function seedExistingMerchant(label: string): Promise<{
  id: number
  keyHash: string
  authorization: AuthorizationRequestInput
}> {
  assert.ok(database)
  const keyHash = sha256(`${label}:merchant-key`)
  const inserted = await database.query<{ id: number }>(
    `INSERT INTO merchants (handle, model, secret_hash)
     VALUES ($1, 'postgres-test', $2) RETURNING id`,
    [`merchant-${label}`, keyHash],
  )
  return { id: inserted.rows[0]!.id, keyHash, authorization: authorization(label) }
}

async function stageRotationForRace(label: string, keyHash: string) {
  const input = {
    sessionHash: sha256(`${label}:rotation-session`),
    csrfHash: sha256(`${label}:rotation-csrf`),
    merchantSecretHash: keyHash,
    replacementSecretHash: sha256(`${label}:rotated-key`),
  }
  const staged = await stageMerchantRotation(input)
  assert.equal(staged.status, 'staged')
  return input
}

async function stageRecoveryForRace(label: string, merchantId: number, keyHash: string) {
  const codeHashes = Array.from({ length: 8 }, (_, index) =>
    sha256(`${label}:recovery-code:${index}`))
  assert.deepEqual(await generateMerchantRecoveryCodes({
    merchantSecretHash: keyHash,
    codeHashes,
  }), { merchantId, handle: `merchant-${label}`, generation: 1 })
  const input = {
    sessionHash: sha256(`${label}:recovery-session`),
    csrfHash: sha256(`${label}:recovery-csrf`),
    recoveryCodeHash: codeHashes[0]!,
    replacementSecretHash: sha256(`${label}:recovered-key`),
  }
  assert.deepEqual(await stageMerchantRecovery(input), {
    status: 'staged', handle: `merchant-${label}`,
  })
  return input
}

async function seedOAuthTokenFamily(
  store: ReturnType<typeof createMarketOAuthStore>,
  label: string,
) {
  const seeded = await seedExistingMerchant(label)
  await store.createAuthorizationRequest(seeded.authorization)
  const codeHash = sha256(`${label}:authorization-code`)
  assert.equal((await store.approveExistingMerchantAndIssueAuthorizationCode({
    sessionHash: seeded.authorization.sessionHash,
    csrfHash: seeded.authorization.csrfHash,
    merchantSecretHash: seeded.keyHash,
    authorizationCodeHash: codeHash,
  })).status, 'approved')
  const refreshTokenHash = sha256(`${label}:old-refresh`)
  assert.equal(await store.exchangeAuthorizationCode({
    codeHash,
    clientId: seeded.authorization.clientId,
    redirectUri: seeded.authorization.redirectUri,
    resource: seeded.authorization.resource,
    accessTokenHash: sha256(`${label}:old-access`),
    refreshTokenHash,
  }), true)
  return { seeded, refreshTokenHash }
}

test('hosted merchant OAuth is atomic against real PostgreSQL', async t => {
  const postgres = await startPostgres()
  const testDatabase = postgres.client
  database = testDatabase
  const store = createMarketOAuthStore(sql)
  try {
    await database.query(schemaDdl)

    await t.test('stage has no public side effects; wrong confirm is unchanged; exact confirm is atomic', async () => {
      const input = registration('exact', 'exact-shop')
      await store.createAuthorizationRequest(input)
      assert.deepEqual(await store.stageNewMerchantRegistration(input), {
        status: 'staged', handle: input.handle,
      })

      const staged = await testDatabase.query(
        `SELECT request.intent, request.merchant_id, request.verified_at,
          request.approved_at, request.used_at,
          (SELECT count(*) FROM oauth_authorization_request_recovery_codes code
           WHERE code.request_id = request.id) AS staged_codes,
          (SELECT count(*) FROM merchants WHERE handle = $2) AS merchants,
          (SELECT count(*) FROM events WHERE kind = 'register' AND actor = $2) AS events,
          (SELECT count(*) FROM oauth_authorization_codes code
           WHERE code.request_id = request.id) AS authorization_codes
         FROM oauth_authorization_requests request WHERE request.session_hash = $1`,
        [input.sessionHash, input.handle],
      )
      assert.deepEqual(staged.rows, [{
        intent: 'new', merchant_id: null, verified_at: null, approved_at: null,
        used_at: null, staged_codes: '8', merchants: '0', events: '0', authorization_codes: '0',
      }])

      assert.deepEqual(await store.confirmNewMerchantAndIssueAuthorizationCode({
        sessionHash: input.sessionHash,
        csrfHash: input.csrfHash,
        merchantSecretHash: sha256('wrong-key'),
        authorizationCodeHash: sha256('wrong-confirm-code'),
      }), { status: 'confirmation_rejected' })
      assert.deepEqual((await testDatabase.query(
        `SELECT merchant_id, verified_at, approved_at, used_at,
          (SELECT count(*) FROM oauth_authorization_request_recovery_codes code
           WHERE code.request_id = request.id) AS staged_codes
         FROM oauth_authorization_requests request WHERE session_hash = $1`,
        [input.sessionHash],
      )).rows, [{
        merchant_id: null, verified_at: null, approved_at: null, used_at: null, staged_codes: '8',
      }])

      const authorizationCodeHash = sha256('exact-confirm-code')
      assert.deepEqual(await store.confirmNewMerchantAndIssueAuthorizationCode({
        sessionHash: input.sessionHash,
        csrfHash: input.csrfHash,
        merchantSecretHash: input.merchantSecretHash,
        authorizationCodeHash,
      }), {
        status: 'approved', redirectUri: input.redirectUri, state: input.state,
      })
      const completed = await testDatabase.query(
        `SELECT merchant.handle, merchant.secret_hash, merchant.recovery_generation,
          request.new_secret_hash,
          (request.verified_at IS NOT NULL) AS verified,
          (request.approved_at IS NOT NULL) AS approved,
          (request.merchant_key_confirmed_at IS NOT NULL) AS key_confirmed,
          (request.used_at IS NOT NULL) AS used,
          (SELECT count(*) FROM merchant_recovery_codes recovery
           WHERE recovery.merchant_id = merchant.id AND recovery.generation = 1) AS recovery_codes,
          (SELECT count(*) FROM oauth_authorization_request_recovery_codes staged_code
           WHERE staged_code.request_id = request.id) AS staged_codes,
          (SELECT count(*) FROM events
           WHERE kind = 'register' AND actor = merchant.handle) AS events,
          (SELECT count(*) FROM oauth_authorization_codes code
           WHERE code.request_id = request.id AND code.code_hash = $2) AS authorization_codes
         FROM oauth_authorization_requests request
         JOIN merchants merchant ON merchant.id = request.merchant_id
         WHERE request.session_hash = $1`,
        [input.sessionHash, authorizationCodeHash],
      )
      assert.deepEqual(completed.rows, [{
        handle: input.handle,
        secret_hash: input.merchantSecretHash,
        recovery_generation: '1',
        new_secret_hash: null,
        verified: true,
        approved: true,
        key_confirmed: true,
        used: true,
        recovery_codes: '8',
        staged_codes: '0',
        events: '1',
        authorization_codes: '1',
      }])

      assert.deepEqual(await store.confirmNewMerchantAndIssueAuthorizationCode({
        sessionHash: input.sessionHash,
        csrfHash: input.csrfHash,
        merchantSecretHash: input.merchantSecretHash,
        authorizationCodeHash: sha256('replay-code'),
      }), { status: 'request_unavailable' })
      assert.deepEqual((await testDatabase.query(
        `SELECT
          (SELECT count(*) FROM merchants WHERE handle = $1) AS merchants,
          (SELECT count(*) FROM events WHERE kind = 'register' AND actor = $1) AS events,
          (SELECT count(*) FROM oauth_authorization_codes code
           JOIN oauth_authorization_requests request ON request.id = code.request_id
           WHERE request.session_hash = $2) AS authorization_codes`,
        [input.handle, input.sessionHash],
      )).rows, [{ merchants: '1', events: '1', authorization_codes: '1' }])
    })

    await t.test('concurrent confirmation gives one handle winner and closes the loser', async () => {
      const first = registration('race-first', 'race-shop')
      const second = registration('race-second', 'race-shop')
      await Promise.all([
        store.createAuthorizationRequest(first),
        store.createAuthorizationRequest(second),
      ])
      assert.deepEqual(await Promise.all([
        store.stageNewMerchantRegistration(first),
        store.stageNewMerchantRegistration(second),
      ]), [
        { status: 'staged', handle: 'race-shop' },
        { status: 'staged', handle: 'race-shop' },
      ])

      const results = await Promise.all([
        store.confirmNewMerchantAndIssueAuthorizationCode({
          sessionHash: first.sessionHash,
          csrfHash: first.csrfHash,
          merchantSecretHash: first.merchantSecretHash,
          authorizationCodeHash: sha256('race-first-code'),
        }),
        store.confirmNewMerchantAndIssueAuthorizationCode({
          sessionHash: second.sessionHash,
          csrfHash: second.csrfHash,
          merchantSecretHash: second.merchantSecretHash,
          authorizationCodeHash: sha256('race-second-code'),
        }),
      ])
      assert.deepEqual(results.map(result => result.status).sort(), ['approved', 'handle_taken'])

      const state = await testDatabase.query(
        `SELECT
          (SELECT count(*) FROM merchants WHERE handle = 'race-shop') AS merchants,
          (SELECT count(*) FROM merchant_recovery_codes recovery
           JOIN merchants merchant ON merchant.id = recovery.merchant_id
           WHERE merchant.handle = 'race-shop') AS recovery_codes,
          (SELECT count(*) FROM events WHERE kind = 'register' AND actor = 'race-shop') AS events,
          (SELECT count(*) FROM oauth_authorization_codes code
           JOIN oauth_authorization_requests request ON request.id = code.request_id
           WHERE request.session_hash IN ($1, $2)) AS authorization_codes,
          (SELECT count(*) FROM oauth_authorization_request_recovery_codes staged
           JOIN oauth_authorization_requests request ON request.id = staged.request_id
           WHERE request.session_hash IN ($1, $2)) AS staged_codes,
          (SELECT count(*) FROM oauth_authorization_requests request
           WHERE request.session_hash IN ($1, $2)
             AND request.intent IS NULL AND request.merchant_id IS NULL
             AND request.new_handle IS NULL AND request.new_model IS NULL
             AND request.new_secret_hash IS NULL AND request.used_at IS NOT NULL) AS closed_losers`,
        [first.sessionHash, second.sessionHash],
      )
      assert.deepEqual(state.rows, [{
        merchants: '1', recovery_codes: '8', events: '1', authorization_codes: '1',
        staged_codes: '0', closed_losers: '1',
      }])
    })

    await t.test('existing-key approval wins before rotation, then its code is revoked', async () => {
      const seeded = await seedExistingMerchant('approval-first')
      await store.createAuthorizationRequest(seeded.authorization)
      const rotation = await stageRotationForRace('approval-first', seeded.keyHash)
      const codeHash = sha256('approval-first:authorization-code')

      const race = await runPausedRace({
        table: 'oauth_authorization_codes',
        event: 'INSERT',
        label: 'approval_first',
        advisoryKey: 73_001,
        first: () => store.approveExistingMerchantAndIssueAuthorizationCode({
          sessionHash: seeded.authorization.sessionHash,
          csrfHash: seeded.authorization.csrfHash,
          merchantSecretHash: seeded.keyHash,
          authorizationCodeHash: codeHash,
        }),
        second: () => confirmMerchantRotation(rotation),
      })

      assert.equal(race.secondState, 'blocked', 'rotation must wait for OAuth merchant lock')
      assert.equal(race.first.status, 'approved')
      assert.equal(race.second.status, 'rotated')
      const state = await testDatabase.query(
        `SELECT merchant.secret_hash,
          (code.used_at IS NOT NULL) AS code_revoked
         FROM merchants merchant
         JOIN oauth_authorization_codes code ON code.merchant_id = merchant.id
         WHERE merchant.id = $1 AND code.code_hash = $2`,
        [seeded.id, codeHash],
      )
      assert.deepEqual(state.rows, [{
        secret_hash: rotation.replacementSecretHash,
        code_revoked: true,
      }])
    })

    await t.test('rotation wins before existing-key approval, so the old key issues no code', async () => {
      const seeded = await seedExistingMerchant('rotation-first')
      await store.createAuthorizationRequest(seeded.authorization)
      const rotation = await stageRotationForRace('rotation-first', seeded.keyHash)
      const codeHash = sha256('rotation-first:authorization-code')

      const race = await runPausedRace({
        table: 'merchant_key_rotations',
        event: 'UPDATE',
        label: 'rotation_first',
        advisoryKey: 73_002,
        first: () => confirmMerchantRotation(rotation),
        second: () => store.approveExistingMerchantAndIssueAuthorizationCode({
          sessionHash: seeded.authorization.sessionHash,
          csrfHash: seeded.authorization.csrfHash,
          merchantSecretHash: seeded.keyHash,
          authorizationCodeHash: codeHash,
        }),
      })

      assert.equal(race.secondState, 'blocked', 'approval must wait for the rotation merchant lock')
      assert.equal(race.first.status, 'rotated')
      assert.deepEqual(race.second, { status: 'merchant_key_rejected' })
      const state = await testDatabase.query(
        `SELECT merchant.secret_hash,
          (SELECT count(*) FROM oauth_authorization_codes code
           WHERE code.merchant_id = merchant.id AND code.code_hash = $2) AS codes
         FROM merchants merchant WHERE merchant.id = $1`,
        [seeded.id, codeHash],
      )
      assert.deepEqual(state.rows, [{
        secret_hash: rotation.replacementSecretHash,
        codes: '0',
      }])
    })

    await t.test('code exchange wins before recovery, then its complete token family is revoked', async () => {
      const seeded = await seedExistingMerchant('exchange-first')
      await store.createAuthorizationRequest(seeded.authorization)
      const codeHash = sha256('exchange-first:authorization-code')
      assert.equal((await store.approveExistingMerchantAndIssueAuthorizationCode({
        sessionHash: seeded.authorization.sessionHash,
        csrfHash: seeded.authorization.csrfHash,
        merchantSecretHash: seeded.keyHash,
        authorizationCodeHash: codeHash,
      })).status, 'approved')
      const recovery = await stageRecoveryForRace('exchange-first', seeded.id, seeded.keyHash)
      const accessTokenHash = sha256('exchange-first:access')
      const exchangeInput = {
        codeHash,
        clientId: seeded.authorization.clientId,
        redirectUri: seeded.authorization.redirectUri,
        resource: seeded.authorization.resource,
        accessTokenHash,
        refreshTokenHash: sha256('exchange-first:refresh'),
      }

      const race = await runPausedRace({
        table: 'oauth_token_families',
        event: 'INSERT',
        label: 'exchange_first',
        advisoryKey: 73_003,
        first: () => store.exchangeAuthorizationCode(exchangeInput),
        second: () => confirmMerchantRecovery(recovery),
      })

      assert.equal(race.secondState, 'blocked', 'recovery must wait for the exchange merchant lock')
      assert.equal(race.first, true)
      assert.equal(race.second.status, 'recovered')
      const state = await testDatabase.query(
        `SELECT
          count(*)::integer AS families,
          count(*) FILTER (WHERE family.revoked_at IS NOT NULL)::integer AS revoked_families,
          (SELECT count(*)::integer FROM oauth_tokens token
           JOIN oauth_token_families owned ON owned.id = token.family_id
           WHERE owned.merchant_id = $1) AS tokens,
          (SELECT count(*)::integer FROM oauth_tokens token
           JOIN oauth_token_families owned ON owned.id = token.family_id
           WHERE owned.merchant_id = $1 AND token.revoked_at IS NOT NULL) AS revoked_tokens
         FROM oauth_token_families family WHERE family.merchant_id = $1`,
        [seeded.id],
      )
      assert.deepEqual(state.rows, [{
        families: 1, revoked_families: 1, tokens: 2, revoked_tokens: 2,
      }])
      assert.equal(await store.resolveOAuthAccessToken({
        accessTokenHash,
        resource: seeded.authorization.resource,
        scope: seeded.authorization.scope,
      }), null)
    })

    await t.test('recovery wins before code exchange, so no token family survives', async () => {
      const seeded = await seedExistingMerchant('recovery-first')
      await store.createAuthorizationRequest(seeded.authorization)
      const codeHash = sha256('recovery-first:authorization-code')
      assert.equal((await store.approveExistingMerchantAndIssueAuthorizationCode({
        sessionHash: seeded.authorization.sessionHash,
        csrfHash: seeded.authorization.csrfHash,
        merchantSecretHash: seeded.keyHash,
        authorizationCodeHash: codeHash,
      })).status, 'approved')
      const recovery = await stageRecoveryForRace('recovery-first', seeded.id, seeded.keyHash)

      const race = await runPausedRace({
        table: 'merchant_recovery_codes',
        event: 'UPDATE',
        label: 'recovery_first',
        advisoryKey: 73_004,
        first: () => confirmMerchantRecovery(recovery),
        second: () => store.exchangeAuthorizationCode({
          codeHash,
          clientId: seeded.authorization.clientId,
          redirectUri: seeded.authorization.redirectUri,
          resource: seeded.authorization.resource,
          accessTokenHash: sha256('recovery-first:access'),
          refreshTokenHash: sha256('recovery-first:refresh'),
        }),
      })

      assert.equal(race.secondState, 'blocked', 'exchange must wait for the recovery merchant lock')
      assert.equal(race.first.status, 'recovered')
      assert.equal(race.second, false)
      const state = await testDatabase.query(
        `SELECT (code.used_at IS NOT NULL) AS code_revoked,
          (SELECT count(*) FROM oauth_token_families family
           WHERE family.merchant_id = $1) AS families
         FROM oauth_authorization_codes code
         WHERE code.merchant_id = $1 AND code.code_hash = $2`,
        [seeded.id, codeHash],
      )
      assert.deepEqual(state.rows, [{ code_revoked: true, families: '0' }])
    })

    await t.test('refresh wins before rotation, but every returned token is effectively revoked', async () => {
      const { seeded, refreshTokenHash: oldRefreshTokenHash } =
        await seedOAuthTokenFamily(store, 'refresh-first')
      const rotation = await stageRotationForRace('refresh-first', seeded.keyHash)
      const newAccessTokenHash = sha256('refresh-first:new-access')

      const race = await runPausedRace({
        table: 'oauth_tokens',
        event: 'INSERT',
        label: 'refresh_first',
        advisoryKey: 73_005,
        first: () => store.rotateRefreshToken({
          presentedRefreshTokenHash: oldRefreshTokenHash,
          clientId: seeded.authorization.clientId,
          resource: seeded.authorization.resource,
          accessTokenHash: newAccessTokenHash,
          newRefreshTokenHash: sha256('refresh-first:new-refresh'),
        }),
        second: () => confirmMerchantRotation(rotation),
      })

      assert.equal(race.first, 'rotated')
      assert.equal(race.second.status, 'rotated')
      assert.equal(await store.resolveOAuthAccessToken({
        accessTokenHash: newAccessTokenHash,
        resource: seeded.authorization.resource,
        scope: seeded.authorization.scope,
      }), null)
      assert.deepEqual((await testDatabase.query(
        `SELECT (revoked_at IS NOT NULL) AS family_revoked
         FROM oauth_token_families WHERE merchant_id = $1`,
        [seeded.id],
      )).rows, [{ family_revoked: true }])
    })

    await t.test('recovery wins before refresh, and any concurrently returned token cannot authenticate', async () => {
      const { seeded, refreshTokenHash: oldRefreshTokenHash } =
        await seedOAuthTokenFamily(store, 'recovery-before-refresh')
      const recovery = await stageRecoveryForRace(
        'recovery-before-refresh', seeded.id, seeded.keyHash,
      )
      const newAccessTokenHash = sha256('recovery-before-refresh:new-access')

      const race = await runPausedRace({
        table: 'merchant_recovery_codes',
        event: 'UPDATE',
        label: 'recovery_before_refresh',
        advisoryKey: 73_006,
        first: () => confirmMerchantRecovery(recovery),
        second: () => store.rotateRefreshToken({
          presentedRefreshTokenHash: oldRefreshTokenHash,
          clientId: seeded.authorization.clientId,
          resource: seeded.authorization.resource,
          accessTokenHash: newAccessTokenHash,
          newRefreshTokenHash: sha256('recovery-before-refresh:new-refresh'),
        }),
      })

      assert.equal(race.first.status, 'recovered')
      assert.ok(['rotated', 'invalid'].includes(race.second))
      assert.equal(await store.resolveOAuthAccessToken({
        accessTokenHash: newAccessTokenHash,
        resource: seeded.authorization.resource,
        scope: seeded.authorization.scope,
      }), null)
      assert.deepEqual((await testDatabase.query(
        `SELECT (revoked_at IS NOT NULL) AS family_revoked
         FROM oauth_token_families WHERE merchant_id = $1`,
        [seeded.id],
      )).rows, [{ family_revoked: true }])
    })

    await t.test('refresh refuses a family too near expiry to honor 600 seconds', async () => {
      const { seeded, refreshTokenHash } = await seedOAuthTokenFamily(store, 'near-expiry')
      await testDatabase.query(
        `UPDATE oauth_token_families SET expires_at = now() + interval '9 minutes'
         WHERE merchant_id = $1`,
        [seeded.id],
      )
      assert.equal(await store.rotateRefreshToken({
        presentedRefreshTokenHash: refreshTokenHash,
        clientId: seeded.authorization.clientId,
        resource: seeded.authorization.resource,
        accessTokenHash: sha256('near-expiry:new-access'),
        newRefreshTokenHash: sha256('near-expiry:new-refresh'),
      }), 'invalid')
      assert.deepEqual((await testDatabase.query(
        `SELECT (token.used_at IS NULL) AS refresh_unused,
          (family.revoked_at IS NULL) AS family_active,
          (SELECT count(*)::integer FROM oauth_tokens sibling
           WHERE sibling.family_id = family.id) AS token_count
         FROM oauth_tokens token JOIN oauth_token_families family ON family.id = token.family_id
         WHERE token.token_hash = $1`,
        [refreshTokenHash],
      )).rows, [{ refresh_unused: true, family_active: true, token_count: 2 }])
    })
  } finally {
    database = null
    await testDatabase.end().catch(() => undefined)
    spawnSync('docker', ['stop', '--time', '0', postgres.containerName], { encoding: 'utf8' })
  }
})
