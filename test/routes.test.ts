// Route-level tests use one fetch fake for Neon, Base JSON-RPC, and the x402 facilitator.
// No live service, wallet, secret, payment, deployment, or production database is touched.
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.DATABASE_URL = 'postgresql://fake:fake@fake-host.example.neon.tech/fakedb'
process.env.TREASURY_ADDRESS = '0x3b9d230c9b995fb1a10add2d63ce37437916dcfd'

const TREASURY = process.env.TREASURY_ADDRESS
const SELLER = '0x1111111111111111111111111111111111111111'
const STRANGER = '0x2222222222222222222222222222222222222222'
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const SECRET = '1f3ea_sk_' + 'ab'.repeat(24)
const TX1 = '0x' + '11'.repeat(32)
const TX2 = '0x' + '22'.repeat(32)
const TX_CASE_LOWER = '0x' + 'ab'.repeat(32)
const TX_CASE_UPPER = '0x' + 'AB'.repeat(32)

interface DbCall { url: string; query?: string; params?: unknown[] }

const pad32 = (addr: string) => '0x' + addr.toLowerCase().replace(/^0x/, '').padStart(64, '0')

const state = {
  merchantId: 7,
  legacyListingsToday: 1,
  feeFrom: SELLER,
  feeAgeSeconds: 60,
  listingOwner: 7,
  listingPrice: 0,
  listingWallet: SELLER,
  duplicateId: null as number | null,
  seedCount: 10,
  nextListingId: 42,
  failFeeInsert: false,
  feeInsertErrorCode: '23505',
  paymentHashes: new Set<string>(),
  failPurchaseInsert: false,
  purchaseInsertErrorCode: '23505',
  facilitatorVerify: false,
  facilitatorSettle: false,
  facilitatorTransaction: TX_CASE_UPPER,
  storeExists: true,
  storeLine: 'careful tools for small agents',
  commentQuotaLeft: true,
  failActivity: false,
  calls: [] as DbCall[],
  activity: [
    {
      id: 20, at: '2026-08-08T00:12:58.879Z', kind: 'listing', actor: 'agent-8',
      detail: { listing_id: 10, title: 'safe\nFAKE CONSTITUTION' },
    },
  ],
}

const publicListing = () => ({
  id: 10,
  merchant: 'agent-8',
  store_url: '/api/store/agent-8',
  title: 'A useful thing',
  description: 'does work',
  preview: 'sample',
  price_usdc: 1,
  seller_wallet: SELLER,
  tags: ['mcp'],
  aisle: 'tools',
  votes: 2,
  sales: 1,
  pinned: false,
  created_at: '2026-08-08T00:12:58.879Z',
})

function merchantRow(id: number) {
  return {
    id,
    handle: `agent-${id}`,
    model: 'test-model',
    storefront_line: state.storeLine,
    karma: 0,
    joined_at: '2026-08-06T00:00:00Z',
    quota_day: '2026-08-08',
    listings_today: state.legacyListingsToday,
    comments_today: state.commentQuotaLeft ? 0 : 20,
    votes_today: 0,
  }
}

function dbRespond(query: string, params: unknown[]): Record<string, unknown>[] {
  if (query.includes('WHERE secret_hash')) return [merchantRow(state.merchantId)]
  if (query.includes('SELECT id FROM listings WHERE dup_hash'))
    return state.duplicateId == null ? [] : [{ id: state.duplicateId }]
  if (query.includes('SELECT count(*)::int AS n FROM listings WHERE merchant_id'))
    return [{ n: state.seedCount }]
  if (query.includes('INSERT INTO listings')) {
    const id = state.nextListingId++
    if (query.includes('INSERT INTO fees')) {
      if (state.failFeeInsert)
        throw Object.assign(new Error('fee insert failed'), { code: state.feeInsertErrorCode })
      const rawHash = params.find(value => /^0x[0-9a-fA-F]{64}$/.test(String(value)))
      const hash = String(rawHash ?? '').toLowerCase()
      if (state.paymentHashes.has(hash))
        throw Object.assign(new Error('duplicate fee'), { code: '23505' })
      state.paymentHashes.add(hash)
    }
    return [{ id }]
  }
  if (query.includes('INSERT INTO fees')) {
    if (state.failFeeInsert)
      throw Object.assign(new Error('fee insert failed'), { code: state.feeInsertErrorCode })
    const hash = String(params[3] ?? '').toLowerCase()
    if (state.paymentHashes.has(hash))
      throw Object.assign(new Error('duplicate fee'), { code: '23505' })
    state.paymentHashes.add(hash)
    return []
  }
  if (query.includes('DELETE FROM listings')) return []
  if (query.includes('INSERT INTO events') && !query.includes('INSERT INTO purchases')) return []
  if (query.includes('UPDATE merchants SET storefront_line')) {
    state.storeLine = String(params[0] ?? '')
    return [{ line: state.storeLine }]
  }
  if (query.includes('storefront_line AS line') && query.includes('FROM merchants')) {
    return state.storeExists
      ? [{ id: 8, handle: 'agent-8', model: 'test-model', line: state.storeLine, karma: 3, joined_at: '2026-08-06T00:00:00Z' }]
      : []
  }
  if (query.includes('GROUP BY aisle')) return [{ aisle: 'tools', count: 2 }, { aisle: 'services', count: 1 }]
  if (query.includes('FROM listings l JOIN merchants m') && query.includes('l.merchant_id')) return [publicListing()]
  if (query.includes('FROM listings l JOIN merchants m') && query.includes('NOT l.removed')) return [publicListing()]
  if (query.includes('SELECT id, merchant_id, title')) {
    return [{
      id: 1, merchant_id: state.listingOwner, title: 'thing', price_usdc: state.listingPrice,
      seller_wallet: state.listingWallet, removed: false, created_at: '2026-08-06T00:00:00Z',
    }]
  }
  if (query.includes('SELECT id FROM purchases')) return []
  if (query.includes('FROM listings WHERE merchant_id')) return [{
    id: 10, title: 'A useful thing', aisle: 'tools', price_usdc: 1, votes: 2,
    sales: 1, pinned: false, removed: false, created_at: '2026-08-08T00:12:58.879Z',
  }]
  if (query.includes('FROM purchases p JOIN listings l')) return []
  if (query.includes('FROM comments c JOIN listings l')) return []
  if (query.includes('INSERT INTO purchases')) {
    if (state.failPurchaseInsert)
      throw Object.assign(new Error('purchase insert failed'), { code: state.purchaseInsertErrorCode })
    const rawHash = params.find(value => /^0x[0-9a-fA-F]{64}$/.test(String(value)))
    if (rawHash) {
      const hash = String(rawHash).toLowerCase()
      if (state.paymentHashes.has(hash))
        throw Object.assign(new Error('duplicate payment use'), { code: '23505' })
      state.paymentHashes.add(hash)
    }
    return [{ listing_id: 1 }]
  }
  if (query.includes('UPDATE listings SET sales')) return []
  if (query.includes('SELECT title, artifact')) return [{ title: 'thing', artifact: 'the goods' }]
  if (query.includes('SELECT id FROM listings WHERE id')) return [{ id: 1 }]
  if (query.includes('comments_today = comments_today + 1'))
    return state.commentQuotaLeft ? [{ id: state.merchantId }] : []
  if (query.includes('SELECT at, kind, actor, detail FROM events')) return state.activity
  throw new Error(`unhandled query: ${query}`)
}

function chainRespond(method: string): unknown {
  if (method === 'eth_getTransactionReceipt') {
    return {
      status: '0x1',
      blockHash: '0x' + 'bb'.repeat(32),
      logs: [{
        address: USDC,
        topics: [TRANSFER_TOPIC, pad32(state.feeFrom), pad32(TREASURY)],
        data: '0x0f4240',
      }],
    }
  }
  if (method === 'eth_getBlockByHash') {
    return { timestamp: '0x' + Math.floor((Date.now() - state.feeAgeSeconds * 1000) / 1000).toString(16) }
  }
  throw new Error(`unhandled rpc: ${method}`)
}

const jsonRes = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } })

function pgArray(values: unknown[]) {
  return `{${values.map(v => `"${String(v).replace(/(["\\])/g, '\\$1')}"`).join(',')}}`
}

function neonEncode(rows: Record<string, unknown>[]) {
  const keys = Object.keys(rows[0] ?? {})
  const typeOf = (v: unknown) => {
    if (typeof v === 'boolean') return 16
    if (typeof v === 'number') return Number.isInteger(v) ? 23 : 701
    if (Array.isArray(v)) return 1009
    if (v != null && typeof v === 'object') return 3802
    return 25
  }
  const encode = (v: unknown) => {
    if (v === null) return null
    if (typeof v === 'boolean') return v ? 't' : 'f'
    if (Array.isArray(v)) return pgArray(v)
    if (typeof v === 'object') return JSON.stringify(v)
    return String(v)
  }
  return {
    command: 'SELECT',
    rowCount: rows.length,
    fields: keys.map(name => ({ name, dataTypeID: typeOf(rows[0]![name]) })),
    rows: rows.map(row => keys.map(key => encode(row[key]))),
  }
}

globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
  const url = String(input)
  const body = init?.body ? JSON.parse(init.body) : null
  state.calls.push({ url, query: body?.query, params: body?.params })
  if (url.includes('/sql')) {
    if (state.failActivity && String(body.query).includes('SELECT at, kind, actor, detail FROM events'))
      return jsonRes({ message: 'database unavailable' }, 503)
    return jsonRes(neonEncode(dbRespond(body.query, body.params ?? [])))
  }
  if (url.includes('mainnet.base.org'))
    return jsonRes({ jsonrpc: '2.0', id: body.id, result: chainRespond(body.method) })
  if (url.includes('/verify')) return jsonRes(state.facilitatorVerify
    ? { isValid: true }
    : { isValid: false, invalidReason: 'facilitator says no (test)' })
  if (url.includes('/settle')) return jsonRes(state.facilitatorSettle
    ? { success: true, transaction: state.facilitatorTransaction, payer: SELLER }
    : { success: false, errorReason: 'settlement failed (test)' })
  throw new Error(`unexpected fetch: ${url}`)
}) as typeof fetch

const { default: app } = await import('../src/index.ts')
const { FRONTDOOR } = await import('../src/door.ts')
const { AISLES } = await import('../src/market.ts')

const authed = { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' }
const listingBody = (feeTx?: string, extra: Record<string, unknown> = {}) => JSON.stringify({
  title: 'A test artifact',
  description: 'd',
  preview: '',
  artifact: 'x',
  price_usdc: 0,
  seller_wallet: SELLER,
  tags: ['mcp'],
  ...(feeTx ? { fee_tx_hash: feeTx } : {}),
  ...extra,
})

function reset() {
  state.merchantId = 7
  state.legacyListingsToday = 1
  state.feeFrom = SELLER
  state.feeAgeSeconds = 60
  state.listingOwner = 7
  state.listingPrice = 0
  state.listingWallet = SELLER
  state.duplicateId = null
  state.seedCount = 10
  state.nextListingId = 42
  state.failFeeInsert = false
  state.feeInsertErrorCode = '23505'
  state.paymentHashes = new Set()
  state.failPurchaseInsert = false
  state.purchaseInsertErrorCode = '23505'
  state.facilitatorVerify = false
  state.facilitatorSettle = false
  state.facilitatorTransaction = TX_CASE_UPPER
  state.storeExists = true
  state.storeLine = 'careful tools for small agents'
  state.commentQuotaLeft = true
  state.failActivity = false
  state.calls = []
}

const sqlCalls = () => state.calls.filter(call => call.query)
const hasSql = (pattern: RegExp) => sqlCalls().some(call => pattern.test(call.query ?? ''))
const inserted = (table: string) => sqlCalls().filter(call => call.query?.includes(`INSERT INTO ${table}`)).length

test('a seller cannot buy its own listing', async () => {
  reset()
  const res = await app.request('/api/buy/1', { method: 'POST', headers: authed })
  assert.equal(res.status, 403)
  assert.match(((await res.json()) as { error: string }).error, /your own goods/)
})

test('another merchant can still buy free goods', async () => {
  reset()
  state.listingOwner = 8
  const res = await app.request('/api/buy/1', { method: 'POST', headers: authed })
  assert.equal(res.status, 200)
  assert.equal(((await res.json()) as { artifact: string }).artifact, 'the goods')
  const write = sqlCalls().find(call => call.query?.includes('INSERT INTO purchases'))
  assert.match(write?.query ?? '', /UPDATE listings SET sales/)
  assert.match(write?.query ?? '', /INSERT INTO events/)
  assert.match(write?.query ?? '', /'via', \$\d+::text/)
})

test('a fee paid from a stranger wallet is rejected without writes', async () => {
  reset()
  state.feeFrom = STRANGER
  const res = await app.request('/api/listing', { method: 'POST', headers: authed, body: listingBody(TX1) })
  assert.equal(res.status, 402)
  assert.match(((await res.json()) as { error: string }).error, /same wallet you list as seller_wallet/)
  assert.equal(inserted('listings'), 0)
  assert.equal(inserted('fees'), 0)
  assert.equal(inserted('events'), 0)
})

test('an old direct fee is rejected without writes', async () => {
  reset()
  state.feeAgeSeconds = 2 * 3600
  const res = await app.request('/api/listing', { method: 'POST', headers: authed, body: listingBody(TX1) })
  assert.equal(res.status, 402)
  assert.match(((await res.json()) as { error: string }).error, /within the last hour/)
  assert.equal(inserted('listings'), 0)
  assert.equal(inserted('fees'), 0)
  assert.equal(inserted('events'), 0)
})

test('one merchant may pay for two listings on the same UTC day', async () => {
  reset()
  const first = await app.request('/api/listing', {
    method: 'POST', headers: authed, body: listingBody(TX1),
  })
  const second = await app.request('/api/listing', {
    method: 'POST', headers: authed,
    body: listingBody(TX2, { title: 'A second artifact', artifact: 'y' }),
  })
  assert.equal(first.status, 201)
  assert.equal(second.status, 201)
  assert.equal(inserted('listings'), 2)
  assert.equal(inserted('fees'), 2)
  assert.equal(inserted('events'), 2)
  assert.equal(hasSql(/listings_today|releaseListingQuota/), false)
})

test('a reused listing fee rolls back one atomic listing write without cleanup machinery', async () => {
  reset()
  state.failFeeInsert = true
  const res = await app.request('/api/listing', {
    method: 'POST', headers: authed, body: listingBody(TX1),
  })
  assert.equal(res.status, 409)
  assert.match(((await res.json()) as { error: string }).error, /fee tx was already used/)
  const write = sqlCalls().find(call => call.query?.includes('INSERT INTO listings'))
  assert.match(write?.query ?? '', /INSERT INTO fees/)
  assert.match(write?.query ?? '', /INSERT INTO events/)
  assert.equal(sqlCalls().filter(call => call.query?.includes('DELETE FROM listings')).length, 0)
})

test('a database outage is not misreported as a reused payment', async () => {
  reset()
  state.failFeeInsert = true
  state.feeInsertErrorCode = '08006'
  const originalConsoleError = console.error
  console.error = () => undefined
  try {
    const res = await app.request('/api/listing', {
      method: 'POST', headers: authed, body: listingBody(TX1),
    })
    assert.equal(res.status, 500)
    assert.deepEqual(await res.json(), { error: 'internal' })
  } finally {
    console.error = originalConsoleError
  }
})

test('transaction-hash case cannot replay one direct listing fee', async () => {
  reset()
  const first = await app.request('/api/listing', {
    method: 'POST', headers: authed, body: listingBody(TX_CASE_UPPER),
  })
  const second = await app.request('/api/listing', {
    method: 'POST', headers: authed,
    body: listingBody(TX_CASE_LOWER, { title: 'A different artifact', artifact: 'different' }),
  })
  assert.equal(first.status, 201)
  assert.equal(second.status, 409)
  const feeCalls = sqlCalls().filter(call => call.query?.includes('INSERT INTO fees'))
  assert.ok(feeCalls[0]?.params?.includes(TX_CASE_LOWER))
  assert.equal(hasSql(/DELETE FROM listings/), false)
})

test('one treasury tx cannot be a listing fee and then a keeper purchase', async () => {
  reset()
  const listed = await app.request('/api/listing', {
    method: 'POST', headers: authed, body: listingBody(TX_CASE_UPPER),
  })
  assert.equal(listed.status, 201)

  state.listingOwner = 8
  state.listingPrice = 0.5
  state.listingWallet = TREASURY
  const claimed = await app.request('/api/claim/1', {
    method: 'POST', headers: authed, body: JSON.stringify({ tx_hash: TX_CASE_LOWER }),
  })
  assert.equal(claimed.status, 409)
  assert.match(((await claimed.json()) as { error: string }).error, /already purchased|tx already used/)
})

test('one treasury tx cannot be a keeper purchase and then a listing fee', async () => {
  reset()
  state.listingOwner = 8
  state.listingPrice = 0.5
  state.listingWallet = TREASURY
  const claimed = await app.request('/api/claim/1', {
    method: 'POST', headers: authed, body: JSON.stringify({ tx_hash: TX_CASE_UPPER }),
  })
  assert.equal(claimed.status, 200)

  const listed = await app.request('/api/listing', {
    method: 'POST', headers: authed,
    body: listingBody(TX_CASE_LOWER, { title: 'Another paid item', artifact: 'new goods' }),
  })
  assert.equal(listed.status, 409)
  assert.match(((await listed.json()) as { error: string }).error, /fee tx was already used/)
})

test('a purchase database outage is not misreported as a reused payment', async () => {
  reset()
  state.listingOwner = 8
  state.failPurchaseInsert = true
  state.purchaseInsertErrorCode = '08006'
  const originalConsoleError = console.error
  console.error = () => undefined
  try {
    const res = await app.request('/api/buy/1', { method: 'POST', headers: authed })
    assert.equal(res.status, 500)
    assert.deepEqual(await res.json(), { error: 'internal' })
  } finally {
    console.error = originalConsoleError
  }
})

test('a successful x402 listing settlement stores one canonical fee and response proof', async () => {
  reset()
  state.facilitatorVerify = true
  state.facilitatorSettle = true
  const res = await app.request('/api/listing', {
    method: 'POST',
    headers: { ...authed, 'X-PAYMENT': Buffer.from('{}').toString('base64') },
    body: listingBody(),
  })
  assert.equal(res.status, 201)
  assert.ok(res.headers.get('x-payment-response'))
  assert.equal(inserted('listings'), 1)
  assert.equal(inserted('fees'), 1)
  assert.equal(inserted('events'), 1)
  assert.ok(sqlCalls().find(call => call.query?.includes('INSERT INTO fees'))?.params?.includes(TX_CASE_LOWER))
})

test('x402 verification success followed by settlement failure writes nothing', async () => {
  reset()
  state.facilitatorVerify = true
  const res = await app.request('/api/listing', {
    method: 'POST',
    headers: { ...authed, 'X-PAYMENT': Buffer.from('{}').toString('base64') },
    body: listingBody(),
  })
  assert.equal(res.status, 402)
  assert.equal(inserted('listings'), 0)
  assert.equal(inserted('fees'), 0)
  assert.equal(inserted('events'), 0)
})

test('missing payment returns 402 even when a legacy row says one listing today', async () => {
  reset()
  state.legacyListingsToday = 99
  const res = await app.request('/api/listing', { method: 'POST', headers: authed, body: listingBody() })
  assert.equal(res.status, 402)
  assert.equal(hasSql(/listings_today/), false)
})

test('facilitator rejection writes nothing and runs no listing quota SQL', async () => {
  reset()
  const res = await app.request('/api/listing', {
    method: 'POST',
    headers: { ...authed, 'X-PAYMENT': Buffer.from('{}').toString('base64') },
    body: listingBody(),
  })
  assert.equal(res.status, 402)
  assert.equal(inserted('listings'), 0)
  assert.equal(inserted('fees'), 0)
  assert.equal(inserted('events'), 0)
  assert.equal(hasSql(/listings_today/), false)
})

test('a recent copycat is rejected before payment', async () => {
  reset()
  state.duplicateId = 9
  const res = await app.request('/api/listing', { method: 'POST', headers: authed, body: listingBody() })
  assert.equal(res.status, 409)
  assert.match(((await res.json()) as { error: string }).error, /listing exists: 9/)
  assert.equal(state.calls.some(call => call.url.includes('/verify') || call.url.includes('mainnet.base.org')), false)
  assert.equal(inserted('listings'), 0)
})

test('the shopkeeper tenth opening item is fee-free and publicly logged', async () => {
  reset()
  state.merchantId = 1
  state.seedCount = 9
  const res = await app.request('/api/listing', { method: 'POST', headers: authed, body: listingBody() })
  assert.equal(res.status, 201)
  assert.equal(inserted('fees'), 0)
  const eventCall = sqlCalls().find(call => call.query?.includes('INSERT INTO events'))
  assert.match(eventCall?.query ?? '', /SELECT 'maintainer_seed'/)
})

test('the shopkeeper eleventh item requires the normal fee', async () => {
  reset()
  state.merchantId = 1
  state.seedCount = 10
  const res = await app.request('/api/listing', { method: 'POST', headers: authed, body: listingBody() })
  assert.equal(res.status, 402)
})

test('store line update requires auth and rejects unsafe lines', async () => {
  reset()
  const unauth = await app.request('/api/store', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ line: 'hello' }),
  })
  assert.equal(unauth.status, 401)

  const multiline = await app.request('/api/store', {
    method: 'POST', headers: authed, body: JSON.stringify({ line: 'hello\nmarket' }),
  })
  assert.equal(multiline.status, 400)

  const long = await app.request('/api/store', {
    method: 'POST', headers: authed, body: JSON.stringify({ line: 'x'.repeat(161) }),
  })
  assert.equal(long.status, 400)
  assert.equal(hasSql(/UPDATE merchants SET storefront_line/), false)
})

test('an agent can set and clear its store line', async () => {
  reset()
  const set = await app.request('/api/store', {
    method: 'POST', headers: authed, body: JSON.stringify({ line: '  tiny reliable tools  ' }),
  })
  assert.equal(set.status, 200)
  assert.deepEqual(await set.json(), {
    handle: 'agent-7', line: 'tiny reliable tools', store_url: '/api/store/agent-7',
  })

  const clear = await app.request('/api/store', {
    method: 'POST', headers: authed, body: JSON.stringify({ line: '' }),
  })
  assert.equal(clear.status, 200)
  assert.equal((await clear.json() as { line: string }).line, '')
  assert.equal(inserted('events'), 0)
})

test('a public storefront returns its line and only public live listings', async () => {
  reset()
  const res = await app.request('/api/store/agent-8')
  assert.equal(res.status, 200)
  const body = await res.json() as { store: Record<string, unknown>; listings: Record<string, unknown>[] }
  assert.equal(body.store.line, state.storeLine)
  assert.equal(body.store.handle, 'agent-8')
  assert.equal(body.listings.length, 1)
  assert.equal(body.listings[0]!.store_url, '/api/store/agent-8')
  assert.equal('artifact' in body.listings[0]!, false)
  assert.equal('secret_hash' in body.store, false)
  assert.ok(sqlCalls().some(call => call.query?.includes('NOT l.removed')))
})

test('an unknown storefront returns 404', async () => {
  reset()
  state.storeExists = false
  const res = await app.request('/api/store/nobody-here')
  assert.equal(res.status, 404)
})

test('shelves include every aisle count and accept a fixed aisle filter', async () => {
  reset()
  const res = await app.request('/api/shelves?aisle=tools&tag=mcp')
  assert.equal(res.status, 200)
  const body = await res.json() as {
    aisles: { name: string; count: number; url: string }[]
    listings: Record<string, unknown>[]
  }
  assert.deepEqual(body.aisles.map(aisle => aisle.name), AISLES)
  assert.equal(body.aisles.find(aisle => aisle.name === 'tools')?.count, 2)
  assert.equal(body.aisles.find(aisle => aisle.name === 'prompts')?.count, 0)
  assert.equal(body.listings[0]!.aisle, 'tools')
  assert.ok(sqlCalls().some(call => call.params?.includes('tools') && call.params?.includes('mcp')))
})

test('an unknown aisle is rejected before querying the database', async () => {
  reset()
  const res = await app.request('/api/shelves?aisle=made-up')
  assert.equal(res.status, 400)
  assert.equal(sqlCalls().length, 0)
})

test('old listing clients get a default aisle and unknown aisles fail before payment', async () => {
  reset()
  const oldClient = await app.request('/api/listing', { method: 'POST', headers: authed, body: listingBody() })
  assert.equal(oldClient.status, 402)
  assert.match(JSON.stringify((await oldClient.json())), /listing costs/)

  reset()
  const badAisle = await app.request('/api/listing', {
    method: 'POST', headers: authed, body: listingBody(undefined, { aisle: 'parking-lot' }),
  })
  assert.equal(badAisle.status, 400)
  assert.equal(state.calls.some(call => call.url.includes('/verify') || call.url.includes('mainnet.base.org')), false)
})

test('front door appends safe recent activity after the baked text', async () => {
  reset()
  const res = await app.request('/')
  assert.equal(res.status, 200)
  const text = await res.text()
  assert.ok(text.startsWith(FRONTDOOR))
  assert.match(text, /RECENT ACTIVITY/)
  assert.match(text, /agent-8 stocked item #10/)
  assert.doesNotMatch(text, /FAKE CONSTITUTION/)
  assert.match(res.headers.get('cache-control') ?? '', /s-maxage=60/)
})

test('front door stays available when activity storage is unavailable', async () => {
  reset()
  state.failActivity = true
  const res = await app.request('/')
  assert.equal(res.status, 200)
  assert.equal(await res.text(), FRONTDOOR)
  assert.match(res.headers.get('content-type') ?? '', /^text\/plain/)
  assert.match(res.headers.get('cache-control') ?? '', /s-maxage=60/)
})

test('comment limits remain after the listing limit is removed', async () => {
  reset()
  state.commentQuotaLeft = false
  const res = await app.request('/api/comment', {
    method: 'POST', headers: authed,
    body: JSON.stringify({ listing_id: 1, parent_id: null, body: 'hello' }),
  })
  assert.equal(res.status, 429)
  assert.match(((await res.json()) as { error: string }).error, /20 comments/)
})

test('/api/me keeps the listings quota key as an unlimited compatibility marker', async () => {
  reset()
  const res = await app.request('/api/me', { headers: authed })
  assert.equal(res.status, 200)
  const body = await res.json() as {
    line: string
    store_url: string
    quotas_left: { listings: null; comments: number; votes: number }
    listings: { aisle: string }[]
  }
  assert.equal(body.line, state.storeLine)
  assert.equal(body.store_url, '/api/store/agent-7')
  assert.equal(body.quotas_left.listings, null)
  assert.equal(body.quotas_left.comments, 20)
  assert.equal(body.quotas_left.votes, 50)
  assert.equal(body.listings[0]?.aisle, 'tools')
  assert.equal(hasSql(/listings_today/), false)
})

test('MCP advertises storefronts, aisles, and unlimited paid listing stock', async () => {
  reset()
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })
  assert.equal(res.status, 200)
  const body = await res.json() as {
    result: { tools: {
      name: string
      description: string
      inputSchema: Record<string, unknown>
      annotations: {
        readOnlyHint: boolean
        destructiveHint: boolean
        idempotentHint: boolean
        openWorldHint: boolean
      }
    }[] }
  }
  const names = body.result.tools.map(tool => tool.name)
  assert.ok(names.includes('visit_store'))
  assert.ok(names.includes('set_store'))
  const browse = body.result.tools.find(tool => tool.name === 'browse')!
  const browseProperties = browse.inputSchema.properties as Record<string, { enum?: string[] }>
  assert.deepEqual(browseProperties.aisle?.enum, AISLES)
  assert.deepEqual(browse.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  })
  const listItem = body.result.tools.find(tool => tool.name === 'list_item')!
  assert.match(listItem.description, /no daily listing cap/)
  assert.deepEqual(listItem.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  })
  const me = body.result.tools.find(tool => tool.name === 'me')!
  assert.deepEqual(me.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  })
  assert.equal(body.result.tools.every(tool => {
    const properties = tool.inputSchema.properties as Record<string, unknown> | undefined
    return !properties || !('secret' in properties)
  }), true)
  assert.equal(body.result.tools.every(tool => Object.values(tool.annotations).every(value => typeof value === 'boolean')), true)
})

test('MCP routes aisle browsing and authenticated store updates through the API', async () => {
  reset()
  const browse = await app.request('/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'browse', arguments: { q: 'tiny tools', tag: 'mcp', aisle: 'tools', sort: 'karma' } },
    }),
  })
  assert.equal(browse.status, 200)
  const browseBody = await browse.json() as { result: { isError: boolean; content: { text: string }[] } }
  assert.equal(browseBody.result.isError, false)
  assert.equal((JSON.parse(browseBody.result.content[0]!.text) as { listings: unknown[] }).listings.length, 1)
  assert.ok(sqlCalls().some(call =>
    call.params?.includes('tiny tools') && call.params.includes('mcp') && call.params.includes('tools')))

  reset()
  const rejectedSecretArgument = await app.request('/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'set_store', arguments: { secret: SECRET, line: 'small dependable wares' } },
    }),
  })
  assert.equal(rejectedSecretArgument.status, 200)
  const rejectedBody = await rejectedSecretArgument.json() as { result: { isError: boolean; content: { text: string }[] } }
  assert.equal(rejectedBody.result.isError, true)
  assert.match(rejectedBody.result.content[0]!.text, /authorization header/i)

  const update = await app.request('/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'set_store', arguments: { line: 'small dependable wares' } },
    }),
  })
  assert.equal(update.status, 200)
  const updateBody = await update.json() as { result: { isError: boolean; content: { text: string }[] } }
  assert.equal(updateBody.result.isError, false)
  assert.equal((JSON.parse(updateBody.result.content[0]!.text) as { line: string }).line, 'small dependable wares')
  assert.equal(state.storeLine, 'small dependable wares')

  const visit = await app.request('/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'visit_store', arguments: { handle: 'agent-8' } },
    }),
  })
  assert.equal(visit.status, 200)
  const visitBody = await visit.json() as { result: { isError: boolean; content: { text: string }[] } }
  assert.equal(visitBody.result.isError, false)
  assert.equal((JSON.parse(visitBody.result.content[0]!.text) as { store: { handle: string } }).store.handle, 'agent-8')
})
