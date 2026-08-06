// Route-level tests for the three pre-launch fixes, no live services:
// Neon speaks HTTP, the chain is JSON-RPC, the facilitator is REST — one fetch
// fake stands in for all three.
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
const TX = '0x' + '11'.repeat(32)

const pad32 = (addr: string) => '0x' + addr.toLowerCase().replace(/^0x/, '').padStart(64, '0')
const utcToday = () => new Date().toISOString().slice(0, 10)

// Mutable per-test state
const state = {
  quotaLeft: true,
  listingsToday: 0,
  feeFrom: SELLER,
  feeAgeSeconds: 60,
  listingOwner: 7, // merchant_id of listing 1
  calls: [] as { url: string; query?: string }[],
}

function merchantRow(id: number) {
  return {
    id, handle: `agent-${id}`, model: 'test-model', karma: 0,
    joined_at: '2026-08-06T00:00:00Z', quota_day: utcToday(),
    listings_today: state.listingsToday, comments_today: 0, votes_today: 0,
  }
}

function dbRespond(query: string): Record<string, unknown>[] {
  if (query.includes('secret_hash')) return [merchantRow(7)]
  if (query.includes('INSERT INTO listings')) return [{ id: 42 }]
  if (query.includes('dup_hash')) return []
  if (query.includes('listings_today = listings_today + 1')) return state.quotaLeft ? [{ id: 7 }] : []
  if (query.includes('greatest(listings_today - 1')) return []
  if (query.includes('SELECT id, merchant_id, title')) {
    return [{ id: 1, merchant_id: state.listingOwner, title: 'thing', price_usdc: 0, seller_wallet: SELLER, removed: false, created_at: '2026-08-06T00:00:00Z' }]
  }
  if (query.includes('SELECT id FROM purchases')) return []
  if (query.includes('INSERT INTO purchases')) return []
  if (query.includes('UPDATE listings SET sales')) return []
  if (query.includes('INSERT INTO events')) return []
  if (query.includes('SELECT title, artifact')) return [{ title: 'thing', artifact: 'the goods' }]
  if (query.includes('INSERT INTO fees')) return []
  throw new Error('unhandled query: ' + query)
}

function chainRespond(method: string): unknown {
  if (method === 'eth_getTransactionReceipt') {
    return {
      status: '0x1', blockHash: '0x' + 'bb'.repeat(32),
      logs: [{ address: USDC, topics: [TRANSFER_TOPIC, pad32(state.feeFrom), pad32(TREASURY)], data: '0x0f4240' }],
    }
  }
  if (method === 'eth_getBlockByHash') {
    return { timestamp: '0x' + Math.floor((Date.now() - state.feeAgeSeconds * 1000) / 1000).toString(16) }
  }
  throw new Error('unhandled rpc: ' + method)
}

const jsonRes = (obj: unknown) =>
  new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } })

// The neon driver asks for Neon-Array-Mode + Neon-Raw-Text-Output: rows are arrays
// of Postgres text values, decoded client-side via each field's dataTypeID.
function neonEncode(rows: Record<string, unknown>[]) {
  const keys = Object.keys(rows[0] ?? {})
  const typeOf = (v: unknown) =>
    typeof v === 'boolean' ? 16 : typeof v === 'number' ? (Number.isInteger(v) ? 23 : 701) : 25
  return {
    command: 'SELECT', rowCount: rows.length,
    fields: keys.map(name => ({ name, dataTypeID: typeOf(rows[0]![name]) })),
    rows: rows.map(r => keys.map(k => r[k] === null ? null : typeof r[k] === 'boolean' ? (r[k] ? 't' : 'f') : String(r[k]))),
  }
}

globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
  const url = String(input)
  const body = init?.body ? JSON.parse(init.body) : null
  state.calls.push({ url, query: body?.query })
  if (url.includes('/sql')) return jsonRes(neonEncode(dbRespond(body.query)))
  if (url.includes('mainnet.base.org')) return jsonRes({ jsonrpc: '2.0', id: body.id, result: chainRespond(body.method) })
  if (url.includes('/verify')) return jsonRes({ isValid: false, invalidReason: 'facilitator says no (test)' })
  throw new Error('unexpected fetch: ' + url)
}) as typeof fetch

const { default: app } = await import('../src/index.ts')

const authed = { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' }
const listingBody = (fee: boolean) => JSON.stringify({
  title: 'A test artifact', description: 'd', preview: '', artifact: 'x',
  price_usdc: 0, seller_wallet: SELLER, tags: [], ...(fee ? { fee_tx_hash: TX } : {}),
})
const reset = () => {
  state.quotaLeft = true; state.listingsToday = 0; state.feeFrom = SELLER
  state.feeAgeSeconds = 60; state.listingOwner = 7; state.calls = []
}
const releaseCalls = () => state.calls.filter(c => c.query?.includes('greatest(listings_today - 1')).length

test('fix 1.2: a seller cannot buy their own listing', async () => {
  reset()
  const res = await app.request('/api/buy/1', { method: 'POST', headers: authed })
  assert.equal(res.status, 403)
  assert.match(((await res.json()) as { error: string }).error, /your own goods/)
})

test('fix 1.2: other merchants can still buy', async () => {
  reset()
  state.listingOwner = 8
  const res = await app.request('/api/buy/1', { method: 'POST', headers: authed })
  assert.equal(res.status, 200)
  assert.equal(((await res.json()) as { artifact: string }).artifact, 'the goods')
})

test('fix 1.1: a fee paid from a stranger\'s wallet is rejected and the quota slot returned', async () => {
  reset()
  state.feeFrom = STRANGER
  const res = await app.request('/api/listing', { method: 'POST', headers: authed, body: listingBody(true) })
  assert.equal(res.status, 402)
  assert.match(((await res.json()) as { error: string }).error, /same wallet you list as seller_wallet/)
  assert.equal(releaseCalls(), 1)
})

test('fix 1.1: a fee older than an hour is rejected', async () => {
  reset()
  state.feeAgeSeconds = 2 * 3600
  const res = await app.request('/api/listing', { method: 'POST', headers: authed, body: listingBody(true) })
  assert.equal(res.status, 402)
  assert.match(((await res.json()) as { error: string }).error, /within the last hour/)
  assert.equal(releaseCalls(), 1)
})

test('fix 1.1: a valid fee from the seller wallet lists successfully', async () => {
  reset()
  const res = await app.request('/api/listing', { method: 'POST', headers: authed, body: listingBody(true) })
  assert.equal(res.status, 201)
  assert.equal(((await res.json()) as { listing_id: number }).listing_id, 42)
  assert.equal(releaseCalls(), 0)
})

test('fix 1.3: quota is reserved before settlement and released when the facilitator refuses', async () => {
  reset()
  const res = await app.request('/api/listing', {
    method: 'POST',
    headers: { ...authed, 'X-PAYMENT': Buffer.from('{}').toString('base64') },
    body: listingBody(false),
  })
  assert.equal(res.status, 402)
  const reserveIdx = state.calls.findIndex(c => c.query?.includes('listings_today = listings_today + 1'))
  const verifyIdx = state.calls.findIndex(c => c.url.includes('/verify'))
  const releaseIdx = state.calls.findIndex(c => c.query?.includes('greatest(listings_today - 1'))
  assert.ok(reserveIdx !== -1 && verifyIdx !== -1 && releaseIdx !== -1)
  assert.ok(reserveIdx < verifyIdx, 'quota must be reserved before money moves')
  assert.ok(verifyIdx < releaseIdx, 'quota must be released after settlement fails')
})

test('review: an exhausted merchant is never invited to pay — bare POST gets 429, not 402', async () => {
  reset()
  state.listingsToday = 1
  const res = await app.request('/api/listing', { method: 'POST', headers: authed, body: listingBody(false) })
  assert.equal(res.status, 429)
})

test('review: exhausted quota refuses a fallback fee before the chain is even consulted', async () => {
  reset()
  state.listingsToday = 1
  const res = await app.request('/api/listing', { method: 'POST', headers: authed, body: listingBody(true) })
  assert.equal(res.status, 429)
  assert.equal(state.calls.filter(c => c.url.includes('mainnet.base.org')).length, 0)
})

test('fix 1.3: exhausted quota is refused before any money moves', async () => {
  reset()
  state.quotaLeft = false
  const res = await app.request('/api/listing', {
    method: 'POST',
    headers: { ...authed, 'X-PAYMENT': Buffer.from('{}').toString('base64') },
    body: listingBody(false),
  })
  assert.equal(res.status, 429)
  assert.equal(state.calls.filter(c => c.url.includes('/verify')).length, 0, 'no facilitator call on the 429 path')
})
