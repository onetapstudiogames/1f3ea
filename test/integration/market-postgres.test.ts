import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import test, { mock } from 'node:test'
import { Pool } from 'pg'

const POSTGRES_IMAGE = 'postgres@sha256:7958605b474b3d264a969cb3a123d6aa00ad1e1fe9da8a69984dabb704d93317'
const POSTGRES_DATABASE = 'market_integration'
const RPC_ORIGIN = 'https://market-postgres-rpc.test'
const TREASURY = '0x3b9d230c9b995fb1a10add2d63ce37437916dcfd'
const BUYER_WALLET = `0x${'1'.repeat(40)}`
const SELLER_WALLET = `0x${'3'.repeat(40)}`
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const RECEIPT_BLOCK_HASH = `0x${'b'.repeat(64)}`
const RECEIPT_BLOCK_NUMBER = '0x100'
const TX_HASH = `0x${'a'.repeat(64)}`
const BUYER_SECRET = `1f3ea_sk_${'ab'.repeat(24)}`
const PAYER_SIGNATURE = `0x${'01'.padStart(64, '0')}${'02'.padStart(64, '0')}1b`
const schemaDdl = await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8')

let database: Pool | null = null
let chain = {
  transferBlockTime: new Date(),
  finalityArrivesAt: new Date(),
}
let rpcMethods: string[] = []

function connectedDatabase(): Pool {
  assert.ok(database, 'the PostgreSQL test client must be connected before the market app runs')
  return database
}

const sqlTag = async (
  strings: TemplateStringsArray,
  ...values: readonly unknown[]
): Promise<Record<string, unknown>[]> => {
  const text = strings.reduce(
    (statement, part, index) => statement + part + (index < values.length ? `$${index + 1}` : ''),
    '',
  )
  return (await connectedDatabase().query(text, [...values])).rows as Record<string, unknown>[]
}

const sql = Object.assign(sqlTag, {
  query: async (
    text: string,
    values: readonly unknown[] = [],
  ): Promise<Record<string, unknown>[]> => (
    await connectedDatabase().query(text, [...values])
  ).rows as Record<string, unknown>[],
})

async function logEvent(
  kind: string,
  actor: string,
  detail: Record<string, unknown> = {},
): Promise<void> {
  await sql`INSERT INTO events (kind, actor, detail)
    VALUES (${kind}, ${actor}, ${JSON.stringify(detail)}::jsonb)`
}

mock.module(new URL('../../src/db.ts', import.meta.url).href, {
  namedExports: { logEvent, sql },
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

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

async function resetAndSeed(): Promise<void> {
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
    INSERT INTO fees (id, merchant_id, listing_id, amount_usdc, tx_hash)
    VALUES (1, 1, 1, 1, $1)
  `, [`0x${'f'.repeat(64)}`])
}

function word(value: string): string {
  return `0x${value.toLowerCase().replace(/^0x/u, '').padStart(64, '0')}`
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
}

const rpcFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input)
  if (url !== RPC_ORIGIN) throw new Error(`unexpected fetch: ${url}`)
  const body = JSON.parse(String(init?.body ?? '{}')) as {
    id?: number
    method?: string
    params?: unknown[]
  }
  const method = String(body.method ?? '')
  rpcMethods = [...rpcMethods, method]

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
      status: '0x1', blockHash: RECEIPT_BLOCK_HASH, blockNumber: RECEIPT_BLOCK_NUMBER,
      logs: [{
        address: USDC,
        topics: [TRANSFER_TOPIC, word(BUYER_WALLET), word(SELLER_WALLET)],
        data: word('0x16e360'),
      }],
    },
  })
  if (method === 'eth_getBlockByHash') return json({
    jsonrpc: '2.0', id: body.id,
    result: { timestamp: `0x${Math.floor(chain.transferBlockTime.getTime() / 1000).toString(16)}` },
  })
  if (method === 'eth_getBlockByNumber') {
    const requested = body.params?.[0]
    const result = requested === 'finalized'
      ? { number: Date.now() >= chain.finalityArrivesAt.getTime() ? RECEIPT_BLOCK_NUMBER : '0xff' }
      : { hash: RECEIPT_BLOCK_HASH, number: RECEIPT_BLOCK_NUMBER }
    return json({ jsonrpc: '2.0', id: body.id, result })
  }
  throw new Error(`unexpected RPC method: ${method}`)
}) as typeof fetch

test('real PostgreSQL prepares every public read and the direct purchase timing sentinel', async t => {
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

  await t.test('every database-backed public GET executes against PostgreSQL', async () => {
    await resetAndSeed()

    const door = await app.request('/')
    assert.equal(door.status, 200)
    assert.match(await door.text(), /seller-one/u, 'the door must not hide a failed query behind its fallback')

    const windowResponse = await app.request('/api/window')
    assert.equal(windowResponse.status, 200)
    const windowBody = await windowResponse.json() as { merchant_total: number; listings_total: number }
    assert.equal(windowBody.merchant_total, 2)
    assert.equal(windowBody.listings_total, 2)

    const completeStore = await app.request('/api/store/seller-one')
    assert.equal(completeStore.status, 200)
    assert.equal(((await completeStore.json()) as { total: number }).total, 2)

    const boundedStore = await app.request('/api/store/seller-one?limit=1')
    assert.equal(boundedStore.status, 200)
    const boundedStoreBody = await boundedStore.json() as { returned: number; has_more: boolean }
    assert.equal(boundedStoreBody.returned, 1)
    assert.equal(boundedStoreBody.has_more, true)

    for (const path of ['/api/shelves?sort=new', '/api/shelves?sort=karma']) {
      const response = await app.request(path)
      assert.equal(response.status, 200, path)
      assert.equal(((await response.json()) as { total: number }).total, 2, path)
    }

    const listing = await app.request('/api/listing/1')
    assert.equal(listing.status, 200)
    assert.equal(((await listing.json()) as { comments_total: number }).comments_total, 1)

    const merchants = await app.request('/api/merchants')
    assert.equal(merchants.status, 200)
    assert.equal(((await merchants.json()) as { total: number }).total, 2)

    const events = await app.request('/api/events')
    assert.equal(events.status, 200)
    assert.equal(((await events.json()) as { total: number }).total, 2)

    const treasury = await app.request('/treasury')
    assert.equal(treasury.status, 200)
    assert.equal(((await treasury.json()) as { fees_count: number }).fees_count, 1)

    const draft = await app.request('/api/world/draft/1')
    assert.equal(draft.status, 200)
    assert.equal(((await draft.json()) as { draft: { status: string } }).draft.status, 'active')

    const checkout = await app.request('/api/world/checkout/1')
    assert.equal(checkout.status, 200)
    assert.equal(((await checkout.json()) as { checkout: { status: string } }).checkout.status, 'active')
  })

  await t.test(
    'documents current behavior: included payment commits before expiry when finality arrives after the TTL',
    async () => {
      // Characterization only: PR #13 proved that requiring canonical finality here
      // without a durable recovery state would make every ten-minute intent expire.
      await resetAndSeed()
      rpcMethods = []
      const headers = {
        Authorization: `Bearer ${BUYER_SECRET}`,
        'Content-Type': 'application/json',
      }
      const opened = await app.request('/api/purchase-intent/1', {
        method: 'POST', headers, body: JSON.stringify({ payer_wallet: BUYER_WALLET }),
      })
      assert.equal(opened.status, 201)
      const intent = (await opened.json() as {
        purchase_intent: { id: number; created_at: string; expires_at: string }
      }).purchase_intent
      const createdAt = Date.parse(intent.created_at)
      const expiresAt = Date.parse(intent.expires_at)
      assert.equal(expiresAt - createdAt, 10 * 60 * 1000)
      chain = {
        transferBlockTime: new Date(Math.ceil(createdAt / 1000) * 1000),
        finalityArrivesAt: new Date(expiresAt + 3 * 60 * 1000),
      }
      assert.ok(chain.transferBlockTime.getTime() >= createdAt)
      assert.ok(chain.transferBlockTime.getTime() <= expiresAt)
      assert.ok(chain.finalityArrivesAt.getTime() > expiresAt)
      assert.ok(Date.now() < chain.finalityArrivesAt.getTime())

      const claimed = await app.request('/api/claim/1', {
        method: 'POST', headers,
        body: JSON.stringify({
          intent_id: intent.id,
          tx_hash: TX_HASH,
          payer_signature: PAYER_SIGNATURE,
        }),
      })
      const claimedBody = await claimed.json() as { artifact?: string; error?: string }
      assert.equal(claimed.status, 200, claimedBody.error)
      assert.equal(claimedBody.artifact, 'the delivered artifact')
      assert.equal(rpcMethods.includes('eth_getBlockByNumber'), false)

      const purchase = await connectedDatabase().query<{
        verified_via: string
        direct_purchase_intent_id: number
        claimed_at: Date | null
      }>(`
        SELECT p.verified_via, p.direct_purchase_intent_id, i.claimed_at
        FROM purchases p
        JOIN direct_purchase_intents i ON i.id = p.direct_purchase_intent_id
        WHERE lower(p.tx_hash) = lower($1)
      `, [TX_HASH])
      assert.equal(purchase.rowCount, 1)
      assert.equal(purchase.rows[0]?.verified_via, 'claim')
      assert.equal(purchase.rows[0]?.direct_purchase_intent_id, intent.id)
      assert.ok(purchase.rows[0]?.claimed_at instanceof Date)
    },
  )
})
