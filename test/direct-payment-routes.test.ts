// Focused route tests use fakes for Neon, Base JSON-RPC, and wallet recovery.
// They never touch a live database, wallet, payment, or deployment.
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.DATABASE_URL = 'postgresql://fake:fake@fake-host.example.neon.tech/fakedb'
process.env.TREASURY_ADDRESS = '0x3b9d230c9b995fb1a10add2d63ce37437916dcfd'

const BUYER = '0x1111111111111111111111111111111111111111'
const OTHER_PAYER = '0x2222222222222222222222222222222222222222'
const SELLER = '0x3333333333333333333333333333333333333333'
const OTHER_RECIPIENT = '0x4444444444444444444444444444444444444444'
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const OTHER_TOKEN = '0x5555555555555555555555555555555555555555'
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const SECRET = '1f3ea_sk_' + 'ab'.repeat(24)
const TX_LOWER = '0x' + 'ab'.repeat(32)
const TX_UPPER = '0x' + 'AB'.repeat(32)
const SIGNATURE = `0x${'01'.padStart(64, '0')}${'02'.padStart(64, '0')}1b`

interface IntentRow {
  id: number
  merchant_id: number
  listing_id: number
  payer_wallet: string
  seller_wallet: string
  network: 'base'
  asset: string
  minimum_amount_usdc: string
  challenge_nonce: string
  created_at: string
  expires_at: string
  superseded_at: string | null
  claimed_at: string | null
}

interface DbCall { query: string; params: unknown[] }

interface PostgresErrorFixture {
  code: string
  constraint?: string
  nested?: boolean
}

const state = {
  nextIntentId: 100,
  requestNow: new Date(),
  listings: new Map([
    [1, { owner: 8, title: 'First paid good', price: 0.5, wallet: SELLER, artifact: 'first artifact' }],
    [2, { owner: 9, title: 'Second paid good', price: 0.75, wallet: SELLER, artifact: 'second artifact' }],
  ]),
  intents: [] as IntentRow[],
  paymentHashes: new Set<string>(),
  transferFrom: BUYER,
  transferTo: SELLER,
  transferToken: USDC,
  transferAmount: 1_500_000n,
  transferBlockTime: new Date(),
  recoveredSigner: BUYER,
  intentInsertError: null as PostgresErrorFixture | null,
  purchaseInsertError: null as PostgresErrorFixture | null,
  calls: [] as DbCall[],
  rpcMethods: [] as string[],
}

const pad32 = (value: string) => '0x' + value.toLowerCase().replace(/^0x/, '').padStart(64, '0')
const listingIdFrom = (params: unknown[]) => {
  const value = params.find(candidate => Number.isInteger(Number(candidate)) && state.listings.has(Number(candidate)))
  return value === undefined ? undefined : Number(value)
}

function postgresError(fixture: PostgresErrorFixture, message: string): Error {
  const detail = Object.assign(new Error(message), {
    code: fixture.code,
    constraint: fixture.constraint,
  })
  return fixture.nested ? Object.assign(new Error(`wrapped ${message}`), { sourceError: detail }) : detail
}

function listingRow(id: number) {
  const listing = state.listings.get(id)!
  return {
    id,
    merchant_id: listing.owner,
    title: listing.title,
    price_usdc: listing.price,
    seller_wallet: listing.wallet,
    removed: false,
    removed_at: null,
    withdrawn: false,
    withdrawn_at: null,
    created_at: '2026-08-01T00:00:00.000Z',
    checked_at: state.requestNow.toISOString(),
    delivery_kind: 'artifact',
  }
}

function intentFromParams(params: unknown[]): IntentRow {
  const listingId = listingIdFrom(params) ?? 1
  const listing = state.listings.get(listingId)!
  const walletValues = params
    .filter(value => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value))
    .map(value => String(value).toLowerCase())
  const payer = walletValues.find(value => value !== listing.wallet.toLowerCase() && value !== USDC.toLowerCase()) ?? BUYER
  const dates = params.filter(value => typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) as string[]
  const nonce = params.find(value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)) as string | undefined
  return {
    id: state.nextIntentId++,
    merchant_id: 7,
    listing_id: listingId,
    payer_wallet: payer,
    seller_wallet: listing.wallet.toLowerCase(),
    network: 'base',
    asset: USDC.toLowerCase(),
    minimum_amount_usdc: listing.price.toFixed(6),
    challenge_nonce: nonce ?? 'cd'.repeat(32),
    created_at: dates.at(-2) ?? state.requestNow.toISOString(),
    expires_at: dates.at(-1) ?? new Date(state.requestNow.getTime() + 600_000).toISOString(),
    superseded_at: null,
    claimed_at: null,
  }
}

function dbRespond(query: string, params: unknown[]): Record<string, unknown>[] {
  state.calls.push({ query, params })
  if (query.includes('WHERE secret_hash')) return [{
    id: 7, handle: 'buyer-7', model: 'test', storefront_line: '', karma: 0,
    joined_at: '2026-08-01T00:00:00.000Z', quota_day: '2026-08-22', comments_today: 0, votes_today: 0,
  }]
  if (query.includes('clock_timestamp() AS checked_at') && query.includes('FROM listings')) {
    const id = listingIdFrom(params) ?? 1
    return state.listings.has(id) ? [listingRow(id)] : []
  }
  if (query.includes('SELECT id FROM purchases')) return []
  if (query.includes('INSERT INTO direct_purchase_intents')) {
    if (state.intentInsertError) throw postgresError(state.intentInsertError, 'intent insert failed')
    const next = intentFromParams(params)
    const existing = state.intents.find(intent =>
      intent.listing_id === next.listing_id && intent.merchant_id === next.merchant_id)
    if (existing) {
      const replaceable = existing.claimed_at === null
        && (existing.superseded_at !== null || Date.parse(existing.expires_at) <= Date.parse(next.created_at))
      if (!replaceable) return []
      const refreshed = { ...next, id: existing.id }
      state.intents = state.intents.map(intent => intent.id === existing.id ? refreshed : intent)
      return [{ ...refreshed }]
    }
    state.intents = [...state.intents, next]
    return [{ ...next }]
  }
  if (query.includes('FROM direct_purchase_intents')) {
    const rawIntentId = params.find(value =>
      (typeof value === 'number' && Number.isInteger(value) && value >= 100)
      || (typeof value === 'string' && /^\d+$/.test(value) && Number(value) >= 100))
    const intentId = rawIntentId === undefined ? undefined : Number(rawIntentId)
    const listingId = listingIdFrom(params)
    const payer = params.find(value => typeof value === 'string'
      && /^0x[0-9a-fA-F]{40}$/.test(value)
      && value.toLowerCase() !== USDC.toLowerCase())
    const found = state.intents.find(intent => (intentId === undefined || intent.id === intentId)
      && (listingId === undefined || intent.listing_id === listingId)
      && intent.merchant_id === 7
      && (payer === undefined || intent.payer_wallet === String(payer).toLowerCase())
      && intent.claimed_at === null && intent.superseded_at === null)
    return found ? [{ ...found }] : []
  }
  if (query.includes('INSERT INTO purchases')) {
    if (state.purchaseInsertError) throw postgresError(state.purchaseInsertError, 'purchase failed')
    const txHash = String(params.find(value => /^0x[0-9a-fA-F]{64}$/.test(String(value))) ?? '').toLowerCase()
    if (state.paymentHashes.has(txHash))
      throw Object.assign(new Error('payment already used'), { code: '23505', constraint: 'payment_uses_pkey' })
    const intentId = Number(params.find(value => Number(value) >= 100))
    const intent = state.intents.find(candidate => candidate.id === intentId)
    if (!intent || intent.claimed_at || intent.superseded_at) return []
    state.paymentHashes.add(txHash)
    state.intents = state.intents.map(candidate => candidate.id === intentId
      ? { ...candidate, claimed_at: state.requestNow.toISOString() }
      : candidate)
    return [{ listing_id: intent.listing_id }]
  }
  if (query.includes('SELECT title, artifact FROM listings')) {
    const id = listingIdFrom(params) ?? 1
    const listing = state.listings.get(id)!
    return [{ title: listing.title, artifact: listing.artifact }]
  }
  throw new Error(`unhandled query: ${query}`)
}

function pgArray(values: unknown[]) {
  return `{${values.map(value => `"${String(value).replace(/(["\\])/g, '\\$1')}"`).join(',')}}`
}

function neonEncode(rows: Record<string, unknown>[]) {
  const keys = Object.keys(rows[0] ?? {})
  const typeOf = (value: unknown) => {
    if (typeof value === 'boolean') return 16
    if (typeof value === 'number') return Number.isInteger(value) ? 23 : 701
    if (Array.isArray(value)) return 1009
    if (value != null && typeof value === 'object') return 3802
    return 25
  }
  const encode = (value: unknown) => {
    if (value === null) return null
    if (typeof value === 'boolean') return value ? 't' : 'f'
    if (Array.isArray(value)) return pgArray(value)
    if (typeof value === 'object') return JSON.stringify(value)
    return String(value)
  }
  return {
    command: 'SELECT', rowCount: rows.length,
    fields: keys.map(name => ({ name, dataTypeID: typeOf(rows[0]![name]) })),
    rows: rows.map(row => keys.map(key => encode(row[key]))),
  }
}

const json = (value: unknown) => new Response(JSON.stringify(value), {
  headers: { 'content-type': 'application/json' },
})

globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
  const url = String(input)
  const body = JSON.parse(init?.body ?? '{}') as { id?: number; method?: string; params?: unknown[]; query?: string }
  if (url.includes('/sql')) return json(neonEncode(dbRespond(body.query ?? '', body.params ?? [])))
  if (url.includes('mainnet.base.org')) {
    state.rpcMethods.push(body.method ?? '')
    if (body.method === 'web3_sha3') return json({ jsonrpc: '2.0', id: body.id, result: '0x' + 'aa'.repeat(32) })
    if (body.method === 'eth_call') return json({
      jsonrpc: '2.0', id: body.id, result: '0x' + '00'.repeat(12) + state.recoveredSigner.slice(2),
    })
    if (body.method === 'eth_getTransactionReceipt') return json({
      jsonrpc: '2.0', id: body.id, result: {
        status: '0x1', blockHash: '0x' + 'bb'.repeat(32),
        logs: [{
          address: state.transferToken,
          topics: [TRANSFER_TOPIC, pad32(state.transferFrom), pad32(state.transferTo)],
          data: pad32(`0x${state.transferAmount.toString(16)}`),
        }],
      },
    })
    if (body.method === 'eth_getBlockByHash') return json({
      jsonrpc: '2.0', id: body.id,
      result: { timestamp: `0x${Math.floor(state.transferBlockTime.getTime() / 1000).toString(16)}` },
    })
  }
  throw new Error(`unexpected fetch: ${url}`)
}) as typeof fetch

const { default: app } = await import('../src/index.ts')

const headers = { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' }
const reset = () => {
  state.nextIntentId = 100
  state.requestNow = new Date()
  state.intents = []
  state.paymentHashes = new Set()
  state.transferFrom = BUYER
  state.transferTo = SELLER
  state.transferToken = USDC
  state.transferAmount = 1_500_000n
  state.transferBlockTime = new Date(state.requestNow.getTime() + 1_000)
  state.recoveredSigner = BUYER
  state.intentInsertError = null
  state.purchaseInsertError = null
  state.calls = []
  state.rpcMethods = []
}

async function openIntent(listingId = 1, payerWallet = BUYER) {
  return app.request(`/api/purchase-intent/${listingId}`, {
    method: 'POST', headers, body: JSON.stringify({ payer_wallet: payerWallet }),
  })
}

async function claim(listingId: number, intentId: number, txHash = TX_LOWER, signature = SIGNATURE) {
  return app.request(`/api/claim/${listingId}`, {
    method: 'POST', headers,
    body: JSON.stringify({ intent_id: intentId, tx_hash: txHash, payer_signature: signature }),
  })
}

test('old public tx-hash proof is rejected unless a signed fresh intent exists', async () => {
  reset()
  const response = await app.request('/api/claim/1', {
    method: 'POST', headers, body: JSON.stringify({ tx_hash: TX_LOWER }),
  })
  assert.equal(response.status, 400)
  assert.equal(state.paymentHashes.size, 0)
})

test('a signed ten-minute intent accepts a fresh voluntary tip once', async () => {
  reset()
  const opened = await openIntent()
  assert.equal(opened.status, 201)
  const body = await opened.json() as { purchase_intent: IntentRow & { challenge: string; signature_method: string } }
  assert.equal(body.purchase_intent.listing_id, 1)
  assert.equal(body.purchase_intent.payer_wallet, BUYER)
  assert.equal(body.purchase_intent.seller_wallet, SELLER)
  assert.equal(body.purchase_intent.network, 'base')
  assert.equal(body.purchase_intent.asset, USDC.toLowerCase())
  assert.equal(body.purchase_intent.minimum_amount_usdc, '0.500000')
  assert.equal(body.purchase_intent.signature_method, 'personal_sign')
  assert.match(body.purchase_intent.challenge, /intent: 100[\s\S]*buyer: buyer-7[\s\S]*listing: 1/)

  state.transferBlockTime = new Date(Math.ceil(Date.parse(body.purchase_intent.created_at) / 1000) * 1000)
  state.transferAmount = 1_500_000n
  const response = await claim(1, body.purchase_intent.id)
  const responseBody = await response.json() as { artifact?: string; error?: string }
  assert.equal(response.status, 200, responseBody.error)
  assert.equal(responseBody.artifact, 'first artifact')
  assert.equal(state.paymentHashes.size, 1)

  const replay = await claim(1, body.purchase_intent.id, TX_UPPER)
  assert.equal(replay.status, 409)
  assert.equal(state.paymentHashes.size, 1)
})

test('concurrent intent retries return one stable challenge and cannot switch its payer', async () => {
  reset()
  const responses = await Promise.all([openIntent(), openIntent()])
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 201])
  const intents = await Promise.all(responses.map(async response =>
    (await response.json() as { purchase_intent: IntentRow & { challenge: string } }).purchase_intent))
  assert.equal(intents[0]!.id, intents[1]!.id)
  assert.equal(intents[0]!.challenge, intents[1]!.challenge)
  assert.equal(state.intents.length, 1)

  const switchedPayer = await openIntent(1, OTHER_PAYER)
  assert.equal(switchedPayer.status, 409)
  assert.equal(state.intents.length, 1)
})

test('intent retries recover only from the two committed open-intent constraints', async () => {
  for (const constraint of [
    'direct_purchase_intents_open_unique',
    'direct_purchase_intents_buyer_listing_unique',
  ]) {
    reset()
    const first = (await (await openIntent()).json() as { purchase_intent: IntentRow }).purchase_intent
    state.intentInsertError = { code: '23505', constraint, nested: true }
    const replay = await openIntent()
    assert.equal(replay.status, 200)
    assert.equal(((await replay.json()) as { purchase_intent: IntentRow }).purchase_intent.id, first.id)
  }

  reset()
  await openIntent()
  state.intentInsertError = { code: '23505', constraint: 'direct_purchase_intents_pkey' }
  const originalConsoleError = console.error
  console.error = () => undefined
  try {
    const unrelated = await openIntent()
    assert.equal(unrelated.status, 500)
    assert.deepEqual(await unrelated.json(), { error: 'internal market failure; retry later' })
  } finally {
    console.error = originalConsoleError
  }
})

test('an expired unused intent refreshes in place instead of accumulating proof rows', async () => {
  reset()
  const first = (await (await openIntent()).json() as { purchase_intent: IntentRow }).purchase_intent
  state.intents = state.intents.map(intent => intent.id === first.id ? {
    ...intent,
    created_at: new Date(Date.now() - 601_000).toISOString(),
    expires_at: new Date(Date.now() - 1_000).toISOString(),
  } : intent)
  const refreshedResponse = await openIntent(1, OTHER_PAYER)
  assert.equal(refreshedResponse.status, 201)
  const refreshed = (await refreshedResponse.json() as { purchase_intent: IntentRow }).purchase_intent
  assert.equal(refreshed.id, first.id)
  assert.equal(refreshed.payer_wallet, OTHER_PAYER)
  assert.notEqual(refreshed.challenge_nonce, first.challenge_nonce)
  assert.equal(state.intents.length, 1)
})

test('hosted fresh intents obey the existing production payment gate before any write', async () => {
  reset()
  const previous = { VERCEL_ENV: process.env.VERCEL_ENV, ready: process.env.PAYMENT_CUSTODY_READY }
  process.env.VERCEL_ENV = 'production'
  delete process.env.PAYMENT_CUSTODY_READY
  try {
    const closed = await openIntent()
    assert.equal(closed.status, 503)
    assert.equal(state.intents.length, 0)

    process.env.PAYMENT_CUSTODY_READY = '1'
    const open = await openIntent()
    assert.equal(open.status, 201)
  } finally {
    if (previous.VERCEL_ENV == null) delete process.env.VERCEL_ENV
    else process.env.VERCEL_ENV = previous.VERCEL_ENV
    if (previous.ready == null) delete process.env.PAYMENT_CUSTODY_READY
    else process.env.PAYMENT_CUSTODY_READY = previous.ready
  }
})

test('direct proof rejects payments before the intent, after it, or requested after expiry', async () => {
  reset()
  let opened = await openIntent()
  let intent = (await opened.json() as { purchase_intent: IntentRow }).purchase_intent
  state.transferBlockTime = new Date(Date.parse(intent.created_at) - 1_000)
  let response = await claim(1, intent.id)
  assert.equal(response.status, 402)

  reset()
  opened = await openIntent()
  intent = (await opened.json() as { purchase_intent: IntentRow }).purchase_intent
  state.transferBlockTime = new Date(Date.parse(intent.expires_at) + 1_000)
  response = await claim(1, intent.id)
  assert.equal(response.status, 402)

  reset()
  opened = await openIntent()
  intent = (await opened.json() as { purchase_intent: IntentRow }).purchase_intent
  const expiredAt = new Date(Date.now() - 1_000).toISOString()
  state.intents = state.intents.map(row => row.id === intent.id
    ? { ...row, created_at: new Date(Date.now() - 601_000).toISOString(), expires_at: expiredAt }
    : row)
  const chainCallsBefore = state.rpcMethods.length
  response = await claim(1, intent.id)
  assert.equal(response.status, 409)
  assert.equal(state.rpcMethods.slice(chainCallsBefore).includes('eth_getTransactionReceipt'), false)
})

test('direct proof rejects wrong signer, payer, recipient, token, amount, and listing', async () => {
  const cases = [
    () => { state.recoveredSigner = OTHER_PAYER },
    () => { state.transferFrom = OTHER_PAYER },
    () => { state.transferTo = OTHER_RECIPIENT },
    () => { state.transferToken = OTHER_TOKEN },
    () => { state.transferAmount = 499_999n },
  ]
  for (const arrange of cases) {
    reset()
    const opened = await openIntent()
    const intent = (await opened.json() as { purchase_intent: IntentRow }).purchase_intent
    arrange()
    const response = await claim(1, intent.id)
    assert.equal(response.status, 402)
    assert.equal(state.paymentHashes.size, 0)
  }

  reset()
  const opened = await openIntent(1)
  const intent = (await opened.json() as { purchase_intent: IntentRow }).purchase_intent
  const wrongListing = await claim(2, intent.id)
  assert.equal(wrongListing.status, 409)
  assert.equal(state.paymentHashes.size, 0)
})

test('two simultaneous purchases cannot reuse one normalized transaction hash', async () => {
  reset()
  const first = (await (await openIntent(1)).json() as { purchase_intent: IntentRow }).purchase_intent
  const second = (await (await openIntent(2)).json() as { purchase_intent: IntentRow }).purchase_intent
  const responses = await Promise.all([
    claim(1, first.id, TX_UPPER),
    claim(2, second.id, TX_LOWER),
  ])
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409])
  assert.deepEqual([...state.paymentHashes], [TX_LOWER])
})

test('a transaction already used for a listing fee cannot satisfy a direct purchase in another case', async () => {
  reset()
  state.paymentHashes.add(TX_LOWER)
  const intent = (await (await openIntent()).json() as { purchase_intent: IntentRow }).purchase_intent
  const response = await claim(1, intent.id, TX_UPPER)
  assert.equal(response.status, 409)
  assert.deepEqual([...state.paymentHashes], [TX_LOWER])
})

test('intent claim and purchase are atomic across a database failure and safe retry', async () => {
  reset()
  const intent = (await (await openIntent()).json() as { purchase_intent: IntentRow }).purchase_intent
  state.purchaseInsertError = { code: '08006' }
  const originalConsoleError = console.error
  console.error = () => undefined
  try {
    const failed = await claim(1, intent.id)
    assert.equal(failed.status, 500)
  } finally {
    console.error = originalConsoleError
  }
  assert.equal(state.intents.find(row => row.id === intent.id)?.claimed_at, null)
  assert.equal(state.paymentHashes.size, 0)

  state.purchaseInsertError = null
  const retried = await claim(1, intent.id)
  assert.equal(retried.status, 200)
  assert.ok(state.intents.find(row => row.id === intent.id)?.claimed_at)
})

test('direct claim names only committed purchase, intent replay, and used payment constraints', async () => {
  const cases = [
    { constraint: 'purchases_listing_id_merchant_id_key', reason: /already purchased/i, status: 409 },
    { constraint: 'purchases_direct_intent_unique', reason: /purchase intent was already used/i, status: 409 },
    { constraint: 'purchases_tx_hash_key', reason: /transaction hash was already used/i, status: 409 },
    { constraint: 'purchases_tx_hash_lower_unique', reason: /transaction hash was already used/i, status: 409 },
    { constraint: 'payment_uses_pkey', reason: /transaction hash was already used/i, status: 409 },
    { constraint: 'purchases_pkey', reason: /^internal market failure; retry later$/i, status: 500 },
  ]
  const originalConsoleError = console.error
  console.error = () => undefined
  try {
    for (const expected of cases) {
      reset()
      const intent = (await (await openIntent()).json() as { purchase_intent: IntentRow }).purchase_intent
      state.purchaseInsertError = { code: '23505', constraint: expected.constraint }
      const response = await claim(1, intent.id)
      assert.equal(response.status, expected.status)
      assert.match(((await response.json()) as { error: string }).error, expected.reason)
    }
  } finally {
    console.error = originalConsoleError
  }
})

test('direct intent and claim bodies reject every unsupported or missing field before payment work', async () => {
  reset()
  for (const body of [{}, { payer_wallet: BUYER, extra: true }, { payer_wallet: 'not-a-wallet' }]) {
    const response = await app.request('/api/purchase-intent/1', {
      method: 'POST', headers, body: JSON.stringify(body),
    })
    assert.equal(response.status, 400)
  }
  const opened = await openIntent()
  const intent = (await opened.json() as { purchase_intent: IntentRow }).purchase_intent
  for (const body of [
    { intent_id: intent.id, tx_hash: TX_LOWER },
    { intent_id: String(intent.id), tx_hash: TX_LOWER, payer_signature: SIGNATURE },
    { intent_id: intent.id, tx_hash: TX_LOWER, payer_signature: SIGNATURE, extra: true },
  ]) {
    const response = await app.request('/api/claim/1', {
      method: 'POST', headers, body: JSON.stringify(body),
    })
    assert.equal(response.status, 400)
  }
  assert.equal(state.paymentHashes.size, 0)
})
