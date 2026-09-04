import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { mock, type TestContext } from 'node:test'
import { Pool, type PoolClient } from 'pg'

const POSTGRES_IMAGE = 'postgres@sha256:7958605b474b3d264a969cb3a123d6aa00ad1e1fe9da8a69984dabb704d93317'
export const POSTGRES_DATABASE = 'market_integration'
const RPC_ORIGIN = 'https://market-postgres-rpc.test'
const CITY_ORIGIN = 'https://1f3d9.com'
export const TREASURY = '0x3b9d230c9b995fb1a10add2d63ce37437916dcfd'
export const BUYER_WALLET = `0x${'1'.repeat(40)}`
export const SELLER_WALLET = `0x${'3'.repeat(40)}`
export const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const AUTHORIZATION_USED_TOPIC = '0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5'
export const RECEIPT_BLOCK_HASH = `0x${'b'.repeat(64)}`
const RECEIPT_BLOCK_NUMBER = '0x100'
export const TX_HASH = `0x${'a'.repeat(64)}`
export const BUYER_SECRET = `1f3ea_sk_${'ab'.repeat(24)}`
export const PAYER_SIGNATURE = `0x${'01'.padStart(64, '0')}${'02'.padStart(64, '0')}1b`
const schemaDdl = await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8')
export const worldFinalityMigrationDdl = await readFile(
  new URL('../../db/migrations/20260827_world_payment_finality.sql', import.meta.url),
  'utf8',
)
export const x402PaymentAttemptsMigrationDdl = await readFile(
  new URL('../../db/migrations/20260828_x402_payment_attempts.sql', import.meta.url),
  'utf8',
)
const guardedPaymentMigrationsDdl = worldFinalityMigrationDdl + x402PaymentAttemptsMigrationDdl
assert.ok(schemaDdl.endsWith(guardedPaymentMigrationsDdl),
  'the fresh schema must end with the exact guarded payment migrations')
export const previousSchemaDdl = schemaDdl.slice(0, -guardedPaymentMigrationsDdl.length)

export function x402PaymentHeader(input: {
  payer: string
  payee: string
  amountUnits: string
  nonce: string
}): string {
  return Buffer.from(JSON.stringify({
    x402Version: 1,
    scheme: 'exact',
    network: 'base',
    payload: {
      signature: PAYER_SIGNATURE,
      authorization: {
        from: input.payer,
        to: input.payee,
        value: input.amountUnits,
        validAfter: '0',
        validBefore: String(Math.floor(Date.now() / 1_000) + 24 * 60 * 60),
        nonce: input.nonce,
      },
    },
  })).toString('base64')
}

let database: Pool | null = null
export const harnessState = {
  currentBlockNumber: 0x100n,
  chain: {
    transferBlockTime: new Date(),
    finalityArrivesAt: new Date(),
    amountUnits: 1_500_000n,
    fromWallet: BUYER_WALLET,
    toWallet: SELLER_WALLET,
  },
  rpcMethods: [] as string[],
  cityOffer: null as Record<string, unknown> | null,
  authorizationNonce: null as string | null,
}

export function connectedDatabase(): Pool {
  assert.ok(database, 'the PostgreSQL test client must be connected before the market app runs')
  return database
}

function queryText(strings: TemplateStringsArray, values: readonly unknown[]): string {
  return strings.reduce(
    (statement, part, index) => statement + part + (index < values.length ? `$${index + 1}` : ''),
    '',
  )
}

const sqlTag = async (
  strings: TemplateStringsArray,
  ...values: readonly unknown[]
): Promise<Record<string, unknown>[]> => {
  return (await connectedDatabase().query(queryText(strings, values), [...values])).rows as Record<string, unknown>[]
}

const sql = Object.assign(sqlTag, {
  query: async (
    text: string,
    values: readonly unknown[] = [],
  ): Promise<Record<string, unknown>[]> => (
    await connectedDatabase().query(text, [...values])
  ).rows as Record<string, unknown>[],
})

type MigrationQuery = (
  text: string,
  values?: readonly unknown[],
) => Promise<readonly Record<string, unknown>[]>

export function transactionalMigrationDatabase(client: Pool) {
  return {
    async identify() { return { databaseName: POSTGRES_DATABASE } },
    async inspect(text: string, values: readonly unknown[] = []) {
      return (await client.query(text, [...values])).rows as Record<string, unknown>[]
    },
    async transaction<T>(operation: (query: MigrationQuery) => Promise<T>): Promise<T> {
      const session = await client.connect()
      try {
        await session.query('BEGIN')
        const result = await operation(async (text, values = []) =>
          (await session.query(text, [...values])).rows as Record<string, unknown>[])
        await session.query('COMMIT')
        return result
      } catch (error) {
        await session.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        session.release()
      }
    },
  }
}

async function logEvent(
  kind: string,
  actor: string,
  detail: Record<string, unknown> = {},
): Promise<void> {
  await sql`INSERT INTO events (kind, actor, detail)
    VALUES (${kind}, ${actor}, ${JSON.stringify(detail)}::jsonb)`
}

type DeferredQuery = { strings: TemplateStringsArray; values: readonly unknown[] }

async function runReadCommittedTransaction(
  buildQueries: (
    transactionSql: (strings: TemplateStringsArray, ...values: readonly unknown[]) => DeferredQuery
  ) => DeferredQuery[],
): Promise<Record<string, unknown>[][]> {
  const client: PoolClient = await connectedDatabase().connect()
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
  namedExports: { logEvent, runReadCommittedTransaction, sql },
})

function runDocker(args: readonly string[]): string {
  const result = spawnSync('docker', [...args], { encoding: 'utf8' })
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status ?? 'unknown'}`
    throw new Error(`docker ${args[0] ?? ''} failed: ${detail}`)
  }
  return result.stdout.trim()
}

async function startPostgres(): Promise<{ client: Pool; containerName: string }> {
  const containerName = `1f3ea-market-test-${process.pid}-${randomBytes(4).toString('hex')}`
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
    const client = new Pool({
      host: '127.0.0.1', port, user: 'postgres', password,
      database: POSTGRES_DATABASE, ssl: false, max: 8,
    })
    const deadline = Date.now() + 30_000
    let lastError: unknown
    while (Date.now() < deadline) {
      try {
        await client.query('SELECT 1')
        return { client, containerName }
      } catch (error) {
        lastError = error
        await delay(200)
      }
    }
    await client.end().catch(() => undefined)
    throw lastError instanceof Error ? lastError : new Error('PostgreSQL did not become ready')
  } catch (error) {
    spawnSync('docker', ['stop', '--time', '0', containerName], { encoding: 'utf8' })
    throw error
  }
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export async function resetAndSeed(): Promise<void> {
  harnessState.authorizationNonce = null
  harnessState.currentBlockNumber = 0x100n
  const client = connectedDatabase()
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await client.query(schemaDdl)
  await client.query(`
    INSERT INTO merchants (id, handle, model, storefront_line, secret_hash) VALUES
      (1, 'seller-one', 'integration', 'careful database goods', repeat('1', 64)),
      (2, 'buyer-two', 'integration', 'careful database buyer', $1)
  `, [sha256(BUYER_SECRET)])
  await client.query(`
    INSERT INTO listings (
      id, merchant_id, title, description, preview, artifact, price_usdc,
      seller_wallet, tags, aisle, dup_hash, created_at
    ) VALUES (
      1, 1, 'Real database guide', 'Exercises public read SQL.', 'A real preview.',
      'the delivered artifact', 0.5, $1, ARRAY['mcp','tool'], 'tools', repeat('a', 64),
      clock_timestamp() - interval '2 minutes'
    )
  `, [SELLER_WALLET])
  await client.query(`
    INSERT INTO world_drafts (
      id, merchant_id, thing_id, title, description, preview, price_usdc,
      seller_wallet, tags, state
    ) VALUES (
      1, 1, 77, 'City compass', 'A city-owned thing.', 'A world preview.', 2,
      $1, ARRAY['world'], 'pending'
    )
  `, [SELLER_WALLET])
  await client.query(`
    INSERT INTO listings (
      id, merchant_id, title, description, preview, artifact, price_usdc,
      seller_wallet, tags, aisle, dup_hash, delivery_kind, world_origin,
      world_offer_id, world_asset_id, world_seller_handle, world_draft_id,
      world_state, created_at
    ) VALUES (
      2, 1, 'City compass', 'A city-owned thing.', 'A world preview.', '', 2,
      $1, ARRAY['world'], 'world', repeat('b', 64), 'city_ownership',
      'https://1f3d9.com', 501, 77, 'city-seller', 1, 'active',
      clock_timestamp() - interval '1 minute'
    )
  `, [SELLER_WALLET])
  await client.query(`
    UPDATE world_drafts SET state = 'active', listing_id = 2 WHERE id = 1;
    INSERT INTO world_checkouts (id, listing_id, merchant_id, city_handle)
    VALUES (1, 2, 2, 'city-buyer');
    INSERT INTO comments (id, listing_id, merchant_id, body, verified_buyer)
    VALUES (1, 1, 2, 'This query reached PostgreSQL.', FALSE);
    INSERT INTO events (kind, actor, detail) VALUES
      ('listing', 'seller-one', '{"listing_id":1}'::jsonb),
      ('sale', 'buyer-two', '{"listing_id":1,"amount_usdc":0.5}'::jsonb);
  `)
  await client.query(`
    INSERT INTO x402_payment_attempts (
      operation_key, operation_kind, proof_digest, requirements_digest,
      network, asset, payer_wallet, payee_wallet, amount_units, resource,
      authorization_nonce, authorization_valid_after, authorization_valid_before,
      start_block, status, tx_hash, operation_started_at, settlement_started_at,
      settled_at, finalized_block_number, finalized_block_hash,
      finalized_block_time, finalized_at
    ) VALUES (
      'listing-fee:artifact:1:${'0'.repeat(64)}', 'listing_fee', repeat('0', 64), repeat('9', 64),
      'base', lower($1), $2, $3, 1000000, 'https://1f3ea.com/api/listing',
      '0x${'4'.repeat(64)}', 0, 4102444800, 256, 'verified', $4,
      clock_timestamp() - interval '1 second', clock_timestamp(), clock_timestamp(),
      256, '0x${'8'.repeat(64)}', clock_timestamp(), clock_timestamp()
    )
  `, [USDC, SELLER_WALLET, TREASURY, `0x${'f'.repeat(64)}`])
  await client.query(`
    INSERT INTO fees (
      id, merchant_id, listing_id, amount_usdc, tx_hash,
      x402_payment_operation_key, verification_method
    ) VALUES (1, 1, 1, 1, $1, 'listing-fee:artifact:1:${'0'.repeat(64)}', 'x402')
  `, [`0x${'f'.repeat(64)}`])
  await client.query(`
    SELECT setval(pg_get_serial_sequence('merchants', 'id'), (SELECT max(id) FROM merchants), true);
    SELECT setval(pg_get_serial_sequence('listings', 'id'), (SELECT max(id) FROM listings), true);
    SELECT setval(pg_get_serial_sequence('world_drafts', 'id'), (SELECT max(id) FROM world_drafts), true);
    SELECT setval(pg_get_serial_sequence('world_checkouts', 'id'), (SELECT max(id) FROM world_checkouts), true);
    SELECT setval(pg_get_serial_sequence('comments', 'id'), (SELECT max(id) FROM comments), true);
    SELECT setval(pg_get_serial_sequence('events', 'id'), (SELECT max(id) FROM events), true);
    SELECT setval(pg_get_serial_sequence('fees', 'id'), (SELECT max(id) FROM fees), true)
  `)
}

export async function preparePendingWorldListingDraft(createdAt: Date, expiresAt: Date): Promise<void> {
  const client = connectedDatabase()
  await client.query('DELETE FROM world_checkouts')
  await client.query(`
    UPDATE world_drafts SET merchant_id = 2, seller_wallet = $1, state = 'pending',
      listing_id = NULL, created_at = $2, expires_at = $3
    WHERE id = 1
  `, [BUYER_WALLET, createdAt, expiresAt])
  await client.query('DELETE FROM listings WHERE id = 2')
  harnessState.cityOffer = {
    id: 501,
    channel: 'world',
    phase: 'listed',
    asset_type: 'thing',
    asset_id: 77,
    asset_name: 'City compass',
    locked: true,
    seller: 'city-seller',
    buyer: null,
    market_buyer: null,
    price_usdc: 2,
    seller_wallet: BUYER_WALLET,
    market_origin: 'https://1f3ea.com',
    market_draft_id: 1,
    market_listing_id: null,
    market_checkout_id: null,
    pending_x402_tx_hash: null,
    pending_x402_at: null,
    reserved_at: null,
    reserved_until: null,
    created_at: createdAt.toISOString(),
    claimed_at: null,
    canceled_at: null,
  }
}

function word(value: string): string {
  return `0x${value.toLowerCase().replace(/^0x/u, '').padStart(64, '0')}`
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
}

const rpcFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input)
  if (url === `${CITY_ORIGIN}/api/world/resident/city-buyer`) {
    return json({ resident: { handle: 'city-buyer' } })
  }
  if (url === `${CITY_ORIGIN}/api/world/offer/501`) {
    assert.ok(harnessState.cityOffer, 'the city offer fixture must be set before world sync')
    return json({ offer: harnessState.cityOffer })
  }
  if (url !== RPC_ORIGIN) throw new Error(`unexpected fetch: ${url}`)
  const body = JSON.parse(String(init?.body ?? '{}')) as {
    id?: number
    method?: string
    params?: unknown[]
  }
  const method = String(body.method ?? '')
  harnessState.rpcMethods = [...harnessState.rpcMethods, method]

  if (method === 'eth_chainId')
    return json({ jsonrpc: '2.0', id: body.id, result: '0x2105' })
  if (method === 'eth_blockNumber')
    return json({
      jsonrpc: '2.0', id: body.id, result: `0x${harnessState.currentBlockNumber.toString(16)}`,
    })
  if (method === 'web3_sha3')
    return json({ jsonrpc: '2.0', id: body.id, result: `0x${'9'.repeat(64)}` })
  if (method === 'eth_call') {
    const call = body.params?.[0] as { to?: unknown } | undefined
    const target = String(call?.to ?? '').toLowerCase()
    const result = target === '0x0000000000000000000000000000000000000001'
      ? word(BUYER_WALLET)
      : '0x0'
    return json({ jsonrpc: '2.0', id: body.id, result })
  }
  if (method === 'eth_getTransactionReceipt') return json({
    jsonrpc: '2.0', id: body.id,
    result: {
      status: '0x1', transactionHash: String(body.params?.[0]).toLowerCase(),
      blockHash: RECEIPT_BLOCK_HASH, blockNumber: RECEIPT_BLOCK_NUMBER,
      logs: [
        ...(harnessState.authorizationNonce ? [{
          address: USDC,
          topics: [AUTHORIZATION_USED_TOPIC, word(harnessState.chain.fromWallet), harnessState.authorizationNonce],
          data: '0x',
        }] : []),
        {
          address: USDC,
          topics: [TRANSFER_TOPIC, word(harnessState.chain.fromWallet), word(harnessState.chain.toWallet)],
          data: word(`0x${harnessState.chain.amountUnits.toString(16)}`),
        },
      ],
    },
  })
  if (method === 'eth_getBlockByHash') return json({
    jsonrpc: '2.0', id: body.id,
    result: {
      hash: RECEIPT_BLOCK_HASH,
      number: RECEIPT_BLOCK_NUMBER,
      timestamp: `0x${Math.floor(harnessState.chain.transferBlockTime.getTime() / 1000).toString(16)}`,
    },
  })
  if (method === 'eth_getBlockByNumber') {
    const requested = body.params?.[0]
    const result = requested === 'finalized'
      ? { number: Date.now() >= harnessState.chain.finalityArrivesAt.getTime() ? RECEIPT_BLOCK_NUMBER : '0xff' }
      : { hash: RECEIPT_BLOCK_HASH, number: RECEIPT_BLOCK_NUMBER }
    return json({ jsonrpc: '2.0', id: body.id, result })
  }
  throw new Error(`unexpected RPC method: ${method}`)
}) as typeof fetch


export async function startMarketPostgresHarness(t: TestContext) {
  const postgres = await startPostgres()
  database = postgres.client
  const originalFetch = globalThis.fetch
  globalThis.fetch = rpcFetch
  process.env.BASE_RPC_URL = RPC_ORIGIN
  process.env.TREASURY_ADDRESS = TREASURY
  t.after(async () => {
    globalThis.fetch = originalFetch
    database = null
    await postgres.client.end().catch(() => undefined)
    spawnSync('docker', ['stop', '--time', '0', postgres.containerName], { encoding: 'utf8' })
  })

  const { default: app } = await import('../../src/index.ts')
  return app
}

export type MarketPostgresApp = Awaited<ReturnType<typeof startMarketPostgresHarness>>
