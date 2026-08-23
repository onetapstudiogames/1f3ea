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
const SIGNATURE = `0x${'01'.padStart(64, '0')}${'02'.padStart(64, '0')}1b`

interface PurchaseIntentRow {
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

interface DbCall { url: string; query?: string; params?: unknown[] }

const pad32 = (addr: string) => '0x' + addr.toLowerCase().replace(/^0x/, '').padStart(64, '0')

const state = {
  authValid: true,
  merchantId: 7,
  legacyListingsToday: 1,
  feeFrom: SELLER,
  feeAgeSeconds: 60,
  listingOwner: 7,
  listingExists: true,
  listingRemoved: false,
  listingRemovedAt: null as string | null,
  listingWithdrawn: false,
  listingWithdrawnAt: null as string | null,
  listingTitle: 'A useful thing',
  listingDescription: 'does work',
  listingPreview: 'sample',
  listingArtifact: 'the goods',
  listingPrice: 0,
  listingWallet: SELLER,
  listingTags: ['mcp'],
  listingAisle: 'tools',
  listingSales: 0,
  priorPurchase: false,
  duplicateId: null as number | null,
  duplicateWithdrawn: false,
  seedCount: 10,
  nextListingId: 42,
  failFeeInsert: false,
  feeInsertErrorCode: '23505',
  paymentHashes: new Set<string>(),
  nextIntentId: 100,
  purchaseIntents: [] as PurchaseIntentRow[],
  failPurchaseInsert: false,
  purchaseInsertErrorCode: '23505',
  facilitatorVerify: false,
  facilitatorSettle: false,
  facilitatorTransaction: TX_CASE_UPPER,
  mutateDuringSettle: null as 'edit' | 'remove' | 'withdraw' | null,
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

const listingDetail = () => ({
  ...publicListing(),
  id: 1,
  merchant: `agent-${state.listingOwner}`,
  store_url: `/api/store/agent-${state.listingOwner}`,
  title: state.listingTitle,
  description: state.listingDescription,
  preview: state.listingPreview,
  price_usdc: state.listingPrice,
  seller_wallet: state.listingWallet,
  tags: state.listingTags,
  aisle: state.listingAisle,
  sales: state.listingSales,
  removed: state.listingRemoved,
  removed_at: state.listingRemovedAt,
  removed_reason: state.listingRemoved ? 'removed by the maintainer' : null,
  withdrawn: state.listingWithdrawn,
  withdrawn_at: state.listingWithdrawnAt,
  withdrawn_reason: state.listingWithdrawn ? 'withdrawn by merchant' : null,
})

const editableListing = () => ({
  id: 1,
  merchant_id: state.listingOwner,
  title: state.listingTitle,
  description: state.listingDescription,
  preview: state.listingPreview,
  artifact: state.listingArtifact,
  price_usdc: state.listingPrice,
  seller_wallet: state.listingWallet,
  tags: state.listingTags,
  aisle: state.listingAisle,
  sales: state.listingSales,
  votes: 2,
  pinned: false,
  removed: state.listingRemoved,
  removed_at: state.listingRemovedAt,
  withdrawn: state.listingWithdrawn,
  withdrawn_at: state.listingWithdrawnAt,
  checked_at: new Date().toISOString(),
  delivery_kind: 'artifact',
  has_purchases: state.priorPurchase,
  created_at: '2026-08-06T00:00:00Z',
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

function assignedParam(query: string, params: unknown[], column: string): unknown {
  const match = query.match(new RegExp(`\\b${column}\\s*=\\s*\\$(\\d+)`, 'i'))
  return match ? params[Number(match[1]) - 1] : undefined
}

function applyListingEdit(query: string, params: unknown[]) {
  const stringFields = [
    ['title', 'listingTitle'],
    ['description', 'listingDescription'],
    ['preview', 'listingPreview'],
    ['artifact', 'listingArtifact'],
    ['seller_wallet', 'listingWallet'],
    ['aisle', 'listingAisle'],
  ] as const
  for (const [column, stateKey] of stringFields) {
    const value = assignedParam(query, params, column)
    if (value !== undefined) state[stateKey] = String(value)
  }
  const price = assignedParam(query, params, 'price_usdc')
  if (price !== undefined) state.listingPrice = Number(price)
  const tags = assignedParam(query, params, 'tags')
  if (Array.isArray(tags)) state.listingTags = tags.map(String)
}

function dbRespond(query: string, params: unknown[]): Record<string, unknown>[] {
  if (query.includes('WHERE secret_hash')) return state.authValid ? [merchantRow(state.merchantId)] : []
  if (query.includes('SELECT id FROM listings WHERE dup_hash')) {
    if (state.duplicateId == null) return []
    if (state.duplicateWithdrawn && /NOT\s+(?:l\.)?withdrawn/i.test(query)) return []
    return [{ id: state.duplicateId }]
  }
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
  if (query.includes('FROM listings l JOIN merchants m') && query.includes('WHERE l.id'))
    return state.listingExists ? [listingDetail()] : []
  if (query.includes('FROM listings WHERE id') && query.includes('merchant_id') && !query.includes('SELECT id, merchant_id, title')) {
    return state.listingExists ? [editableListing()] : []
  }
  if (/UPDATE listings SET\s+withdrawn\s*=/i.test(query)) {
    if (!state.listingExists || state.listingOwner !== state.merchantId) return []
    if (state.listingWithdrawn && query.includes('NOT withdrawn')) return []
    state.listingWithdrawn = true
    state.listingWithdrawnAt = new Date().toISOString()
    return [{ id: 1, withdrawn: true, already_withdrawn: false }]
  }
  if (/UPDATE listings SET\s+removed\s*=/i.test(query)) {
    if (!state.listingExists) return []
    if (state.listingWithdrawn && /NOT\s+withdrawn/i.test(query)) return []
    state.listingRemoved = true
    state.listingRemovedAt = new Date().toISOString()
    if (/withdrawn\s*=\s*(?:FALSE|\$\d+)/i.test(query)) state.listingWithdrawn = false
    return [{ id: 1 }]
  }
  if (query.includes('UPDATE listings SET') && !query.includes('SET sales') &&
      !query.includes('SET pinned') && !query.includes('SET removed')) {
    if (!state.listingExists || state.listingOwner !== state.merchantId) return []
    applyListingEdit(query, params)
    return [editableListing()]
  }
  if (query.includes('DELETE FROM listings')) return []
  if (query.includes('INSERT INTO events') && !query.includes('INSERT INTO purchases')) return []
  if (query.includes('UPDATE merchants SET storefront_line')) {
    state.storeLine = String(params[0] ?? '')
    return [{ line: state.storeLine }]
  }
  if (query.includes('count(l.id)::int AS listings') && query.includes('GROUP BY m.id')) {
    return [{
      handle: 'agent-8', model: 'test-model', line: state.storeLine, karma: 3,
      joined_at: '2026-08-06T00:00:00Z', listings: 1, total_merchants: 1,
    }]
  }
  if (query.includes('storefront_line AS line') && query.includes('FROM merchants')) {
    return state.storeExists
      ? [{
        id: 8, handle: 'agent-8', model: 'test-model', line: state.storeLine, karma: 3,
        joined_at: '2026-08-06T00:00:00Z', listings: 1,
      }]
      : []
  }
  if (query.includes('GROUP BY aisle')) return [{ aisle: 'tools', count: 2 }, { aisle: 'services', count: 1 }]
  if (query.includes('FROM listings l JOIN merchants m') && query.includes('l.merchant_id')) return [publicListing()]
  if (query.includes('FROM listings l JOIN merchants m') && query.includes('NOT l.removed')) return [publicListing()]
  if (query.includes('SELECT id, merchant_id, title')) {
    return state.listingExists ? [editableListing()] : []
  }
  if (query.includes('SELECT id FROM purchases')) return state.priorPurchase ? [{ id: 55 }] : []
  if (query.includes('INSERT INTO direct_purchase_intents')) {
    const dates = params.filter(value => typeof value === 'string'
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) as string[]
    const wallets = params.filter(value => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value)) as string[]
    const next: PurchaseIntentRow = {
      id: state.nextIntentId++,
      merchant_id: state.merchantId,
      listing_id: 1,
      payer_wallet: String(wallets.find(wallet => wallet.toLowerCase() !== state.listingWallet.toLowerCase()
        && wallet.toLowerCase() !== USDC.toLowerCase()) ?? state.feeFrom).toLowerCase(),
      seller_wallet: state.listingWallet.toLowerCase(),
      network: 'base',
      asset: USDC.toLowerCase(),
      minimum_amount_usdc: state.listingPrice.toFixed(6),
      challenge_nonce: String(params.find(value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value))),
      created_at: dates.at(-2)!,
      expires_at: dates.at(-1)!,
      superseded_at: null,
      claimed_at: null,
    }
    state.purchaseIntents = state.purchaseIntents.map(intent => intent.claimed_at || intent.superseded_at
      ? intent
      : { ...intent, superseded_at: next.created_at })
    state.purchaseIntents = [...state.purchaseIntents, next]
    return [{ ...next }]
  }
  if (query.includes('FROM direct_purchase_intents')) {
    const intentId = Number(params.find(value =>
      (typeof value === 'number' && Number.isInteger(value) && value >= 100)
      || (typeof value === 'string' && /^\d+$/.test(value) && Number(value) >= 100)))
    const intent = state.purchaseIntents.find(candidate => candidate.id === intentId)
    return intent ? [{ ...intent }] : []
  }
  if (query.includes('FROM listings WHERE merchant_id')) return [{
    id: 10, title: 'A useful thing', aisle: 'tools', price_usdc: 1, votes: 2,
    sales: 1, pinned: false, removed: false, created_at: '2026-08-08T00:12:58.879Z',
  }]
  if (query.includes('FROM purchases p JOIN listings l') && query.includes('l.artifact')) {
    return state.priorPurchase ? [{
      listing_id: 1,
      title: 'private operator identifier in title',
      amount_usdc: 1,
      verified_via: 'claim',
      created_at: '2026-08-07T00:00:00Z',
      artifact: 'previously purchased private artifact',
    }] : []
  }
  if (query.includes('FROM purchases p JOIN listings l')) return []
  if (query.includes('FROM comments c JOIN listings l')) return []
  if (query.includes('FROM comments c JOIN merchants m')) return []
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
    const intentId = Number(params.find(value =>
      (typeof value === 'number' && Number.isInteger(value) && value >= 100)
      || (typeof value === 'string' && /^\d+$/.test(value) && Number(value) >= 100)))
    if (Number.isInteger(intentId)) {
      const intent = state.purchaseIntents.find(candidate => candidate.id === intentId)
      if (!intent || intent.claimed_at || intent.superseded_at) return []
      state.purchaseIntents = state.purchaseIntents.map(candidate => candidate.id === intentId
        ? { ...candidate, claimed_at: new Date().toISOString() }
        : candidate)
    }
    const terminalAt = [state.listingRemovedAt, state.listingWithdrawnAt]
      .filter((value): value is string => Boolean(value))
      .map(value => Date.parse(value))
      .sort((a, b) => a - b)[0]
    if (terminalAt != null) {
      const hasTemporalBoundary = /removed_at|withdrawn_at/i.test(query)
      const paidAt = params
        .map(value => typeof value === 'string' ? Date.parse(value) : NaN)
        .find(value => Number.isFinite(value))
      if (!hasTemporalBoundary || paidAt == null || paidAt > terminalAt) return []
    }
    return [{ listing_id: 1 }]
  }
  if (query.includes('UPDATE listings SET sales')) return []
  if (query.includes('SELECT title, artifact'))
    return [{ title: state.listingTitle, artifact: state.listingArtifact }]
  if (query.includes('SELECT id FROM listings WHERE id')) return state.listingExists ? [{ id: 1 }] : []
  if (query.includes('comments_today = comments_today + 1'))
    return state.commentQuotaLeft ? [{ id: state.merchantId }] : []
  if (query.includes('SELECT at, kind, actor, detail FROM events')) return state.activity
  if (query.includes('SELECT id, at, kind, actor, detail FROM events') && query.includes('kind IN'))
    return state.activity
  throw new Error(`unhandled query: ${query}`)
}

function chainRespond(method: string): unknown {
  if (method === 'web3_sha3') return '0x' + 'aa'.repeat(32)
  if (method === 'eth_call') return '0x' + '00'.repeat(12) + state.feeFrom.toLowerCase().slice(2)
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
  if (url.includes('/settle')) {
    if (!state.facilitatorSettle)
      return jsonRes({ success: false, errorReason: 'settlement failed (test)' })
    const terminalAt = new Date(Date.now() + 500).toISOString()
    if (state.mutateDuringSettle === 'edit') state.listingDescription = 'edited after settlement'
    if (state.mutateDuringSettle === 'withdraw') {
      state.listingWithdrawn = true
      state.listingWithdrawnAt = terminalAt
    }
    if (state.mutateDuringSettle === 'remove') {
      state.listingRemoved = true
      state.listingRemovedAt = terminalAt
    }
    return jsonRes({ success: true, transaction: state.facilitatorTransaction, payer: SELLER })
  }
  throw new Error(`unexpected fetch: ${url}`)
}) as typeof fetch

const { default: app } = await import('../src/index.ts')
const { FRONTDOOR } = await import('../src/door.ts')
const { AISLES } = await import('../src/market.ts')
const { dupHash } = await import('../src/core.ts')

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
  state.authValid = true
  state.merchantId = 7
  state.legacyListingsToday = 1
  state.feeFrom = SELLER
  state.feeAgeSeconds = 60
  state.listingOwner = 7
  state.listingExists = true
  state.listingRemoved = false
  state.listingRemovedAt = null
  state.listingWithdrawn = false
  state.listingWithdrawnAt = null
  state.listingTitle = 'A useful thing'
  state.listingDescription = 'does work'
  state.listingPreview = 'sample'
  state.listingArtifact = 'the goods'
  state.listingPrice = 0
  state.listingWallet = SELLER
  state.listingTags = ['mcp']
  state.listingAisle = 'tools'
  state.listingSales = 0
  state.priorPurchase = false
  state.duplicateId = null
  state.duplicateWithdrawn = false
  state.seedCount = 10
  state.nextListingId = 42
  state.failFeeInsert = false
  state.feeInsertErrorCode = '23505'
  state.paymentHashes = new Set()
  state.nextIntentId = 100
  state.purchaseIntents = []
  state.failPurchaseInsert = false
  state.purchaseInsertErrorCode = '23505'
  state.facilitatorVerify = false
  state.facilitatorSettle = false
  state.facilitatorTransaction = TX_CASE_UPPER
  state.mutateDuringSettle = null
  state.storeExists = true
  state.storeLine = 'careful tools for small agents'
  state.commentQuotaLeft = true
  state.failActivity = false
  state.calls = []
}

const sqlCalls = () => state.calls.filter(call => call.query)
const hasSql = (pattern: RegExp) => sqlCalls().some(call => pattern.test(call.query ?? ''))
const inserted = (table: string) => sqlCalls().filter(call => call.query?.includes(`INSERT INTO ${table}`)).length

async function openDirectIntent() {
  const response = await app.request('/api/purchase-intent/1', {
    method: 'POST', headers: authed, body: JSON.stringify({ payer_wallet: state.feeFrom }),
  })
  assert.equal(response.status, 201)
  return (await response.json() as { purchase_intent: PurchaseIntentRow }).purchase_intent
}

function directClaimBody(intentId: number, txHash: string) {
  return JSON.stringify({ intent_id: intentId, tx_hash: txHash, payer_signature: SIGNATURE })
}

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

test('hosted paid listing, buy, and direct-claim routes stop before payment work while custody is closed', async () => {
  reset()
  const previousEnvironment = {
    VERCEL_ENV: process.env.VERCEL_ENV,
    PAYMENT_CUSTODY_READY: process.env.PAYMENT_CUSTODY_READY,
  }
  process.env.VERCEL_ENV = 'production'
  delete process.env.PAYMENT_CUSTODY_READY

  try {
    const listing = await app.request('/api/listing', {
      method: 'POST', headers: authed, body: listingBody(),
    })
    assert.equal(listing.status, 503)

    state.listingOwner = 8
    state.listingPrice = 1
    const buy = await app.request('/api/buy/1', { method: 'POST', headers: authed })
    assert.equal(buy.status, 503)

    const claim = await app.request('/api/claim/1', {
      method: 'POST', headers: authed, body: JSON.stringify({ tx_hash: TX1 }),
    })
    assert.equal(claim.status, 503)

    assert.equal(state.calls.some(call => /facilitator|mainnet\.base/i.test(call.url)), false)
    assert.equal(inserted('fees'), 0)
    assert.equal(inserted('purchases'), 0)
  } finally {
    if (previousEnvironment.VERCEL_ENV == null) delete process.env.VERCEL_ENV
    else process.env.VERCEL_ENV = previousEnvironment.VERCEL_ENV
    if (previousEnvironment.PAYMENT_CUSTODY_READY == null) delete process.env.PAYMENT_CUSTODY_READY
    else process.env.PAYMENT_CUSTODY_READY = previousEnvironment.PAYMENT_CUSTODY_READY
  }
})

test('listing withdrawal rejects missing, malformed, and unknown bearer secrets without writes', async () => {
  reset()
  const missing = await app.request('/api/listing/1/withdraw', { method: 'POST' })
  assert.equal(missing.status, 401)

  const malformed = await app.request('/api/listing/1/withdraw', {
    method: 'POST', headers: { Authorization: 'Bearer not-a-1f3ea-secret' },
  })
  assert.equal(malformed.status, 401)

  state.authValid = false
  const unknown = await app.request('/api/listing/1/withdraw', { method: 'POST', headers: authed })
  assert.equal(unknown.status, 401)
  assert.equal(hasSql(/UPDATE listings SET[\s\S]*withdrawn/i), false)
  assert.equal(inserted('events'), 0)
})

test('a merchant cannot withdraw another merchant\'s listing', async () => {
  reset()
  state.listingOwner = 8
  const res = await app.request('/api/listing/1/withdraw', { method: 'POST', headers: authed })
  assert.equal(res.status, 403)
  assert.equal(state.listingWithdrawn, false)
  assert.equal(inserted('events'), 0)
})

test('withdrawing a listing that does not exist returns 404', async () => {
  reset()
  state.listingExists = false
  const res = await app.request('/api/listing/999/withdraw', { method: 'POST', headers: authed })
  assert.equal(res.status, 404)
  assert.match(((await res.json()) as { error: string }).error, /no such listing/i)
  assert.equal(inserted('events'), 0)
})

test('an owner can withdraw a listing and the public event names the merchant actor', async () => {
  reset()
  const res = await app.request('/api/listing/1/withdraw', { method: 'POST', headers: authed })
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { ok: true, listing_id: 1, status: 'withdrawn' })
  assert.equal(state.listingWithdrawn, true)

  const write = sqlCalls().find(call => /UPDATE listings SET[\s\S]*withdrawn/i.test(call.query ?? ''))
  assert.match(write?.query ?? '', /merchant_id/i)
  const events = sqlCalls().filter(call => call.query?.includes('INSERT INTO events'))
  assert.equal(events.length, 1)
  const publicReceipt = `${events[0]!.query}\n${JSON.stringify(events[0]!.params)}`
  assert.match(publicReceipt, /withdrawal/i)
  assert.match(publicReceipt, /agent-7/)
  assert.match(publicReceipt, /listing_id/)
  assert.match(publicReceipt, /withdrawn by merchant/)
  assert.doesNotMatch(publicReceipt, /private operator identifier/)
})

test('withdrawal rejects merchant-authored public text and always uses the fixed reason', async () => {
  reset()
  const merchantText = 'please publish this merchant-authored explanation'
  const rejected = await app.request('/api/listing/1/withdraw', {
    method: 'POST', headers: authed, body: JSON.stringify({ reason: merchantText }),
  })
  assert.equal(rejected.status, 400)
  assert.equal(state.listingWithdrawn, false)
  assert.equal(inserted('events'), 0)

  const accepted = await app.request('/api/listing/1/withdraw', {
    method: 'POST', headers: authed, body: JSON.stringify({}),
  })
  assert.equal(accepted.status, 200)
  const event = sqlCalls().find(call => call.query?.includes('INSERT INTO events'))
  const receipt = `${event?.query}\n${JSON.stringify(event?.params)}`
  assert.match(receipt, /withdrawn by merchant/)
  assert.doesNotMatch(receipt, new RegExp(merchantText))
})

test('repeating an owner withdrawal is an idempotent success with no second event', async () => {
  reset()
  const first = await app.request('/api/listing/1/withdraw', { method: 'POST', headers: authed })
  const second = await app.request('/api/listing/1/withdraw', { method: 'POST', headers: authed })
  assert.equal(first.status, 200)
  assert.equal(second.status, 200)
  assert.deepEqual(await second.json(), { ok: true, listing_id: 1, status: 'withdrawn' })
  assert.equal(inserted('events'), 1)
})

test('an owner may withdraw a priced listing even after prior purchases', async () => {
  reset()
  state.listingPrice = 1
  state.listingSales = 2
  state.priorPurchase = true
  const res = await app.request('/api/listing/1/withdraw', { method: 'POST', headers: authed })
  assert.equal(res.status, 200)
  assert.equal(state.listingWithdrawn, true)
  assert.equal(inserted('events'), 1)
})

test('maintainer removal may supersede a merchant withdrawal and becomes the public tombstone', async () => {
  reset()
  state.merchantId = 1
  state.listingOwner = 7
  state.listingWithdrawn = true
  state.listingWithdrawnAt = new Date(Date.now() - 60_000).toISOString()
  const removed = await app.request('/api/mod/remove', {
    method: 'POST', headers: authed,
    body: JSON.stringify({ listing_id: 1, reason: 'privacy redaction' }),
  })
  assert.equal(removed.status, 200)
  assert.equal(state.listingRemoved, true)
  assert.ok(state.listingRemovedAt)

  const publicRead = await app.request('/api/listing/1')
  assert.equal(publicRead.status, 200)
  const listing = ((await publicRead.json()) as { listing: { state: string; title: string } }).listing
  assert.equal(listing.state, 'removed')
  assert.equal(listing.title, '[removed by the maintainer]')
  const event = sqlCalls().find(call => call.query?.includes('INSERT INTO events'))
  assert.match(`${event?.query}\n${JSON.stringify(event?.params)}`, /moderation[\s\S]*agent-1/)
})

test('a withdrawn listing is a merchant-attributed public tombstone with old public copy redacted', async () => {
  reset()
  state.listingWithdrawn = true
  state.listingTitle = 'private operator identifier in title'
  state.listingDescription = 'private operator identifier in description'
  state.listingPreview = 'private operator identifier in preview'
  const res = await app.request('/api/listing/1')
  assert.equal(res.status, 200)
  const body = await res.json() as {
    listing: { state: string; title: string; description: string; preview: string }
    artifact: string
  }
  assert.equal(body.listing.state, 'withdrawn')
  assert.equal(body.listing.title, '[withdrawn by merchant]')
  assert.equal(body.listing.description, 'withdrawn by merchant')
  assert.equal(body.listing.preview, '')
  assert.doesNotMatch(JSON.stringify(body), /private operator identifier/)
  assert.doesNotMatch(body.artifact, /POST \/api\/buy/)
})

test('withdrawal retains artifact delivery for an authenticated prior buyer', async () => {
  reset()
  state.listingOwner = 8
  state.listingWithdrawn = true
  state.priorPurchase = true
  const res = await app.request('/api/purchases', { headers: authed })
  assert.equal(res.status, 200)
  const body = await res.json() as { purchases: { listing_id: number; artifact: string }[] }
  assert.equal(body.purchases[0]?.listing_id, 1)
  assert.equal(body.purchases[0]?.artifact, 'previously purchased private artifact')
})

test('withdrawal blocks every future buy before payment or purchase writes', async () => {
  reset()
  state.listingOwner = 8
  state.listingPrice = 1
  state.listingWithdrawn = true
  const res = await app.request('/api/buy/1', { method: 'POST', headers: authed })
  assert.equal(res.status, 404)
  assert.match(((await res.json()) as { error: string }).error, /withdrawn|not available/i)
  assert.equal(inserted('purchases'), 0)
  assert.equal(state.calls.some(call => call.url.includes('/verify') || call.url.includes('/settle')), false)
})

test('an x402 request that passed the live check before withdrawal or removal still delivers after settlement', async () => {
  for (const terminalAction of ['withdraw', 'remove'] as const) {
    reset()
    state.listingOwner = 8
    state.listingPrice = 1
    state.facilitatorVerify = true
    state.facilitatorSettle = true
    state.mutateDuringSettle = terminalAction
    const res = await app.request('/api/buy/1', {
      method: 'POST',
      headers: { ...authed, 'X-PAYMENT': Buffer.from('{}').toString('base64') },
    })
    assert.equal(res.status, 200, `${terminalAction} stranded an already accepted x402 request`)
    assert.equal(((await res.json()) as { artifact: string }).artifact, 'the goods')
    assert.equal(inserted('purchases'), 1)
  }
})

test('an x402 request that passed the live check before a concurrent safe edit still settles and delivers', async () => {
  reset()
  state.listingOwner = 8
  state.listingPrice = 1
  state.facilitatorVerify = true
  state.facilitatorSettle = true
  state.mutateDuringSettle = 'edit'
  const res = await app.request('/api/buy/1', {
    method: 'POST',
    headers: { ...authed, 'X-PAYMENT': Buffer.from('{}').toString('base64') },
  })
  assert.equal(res.status, 200)
  assert.equal(((await res.json()) as { artifact: string }).artifact, 'the goods')
  assert.equal(state.listingDescription, 'edited after settlement')
  assert.equal(inserted('purchases'), 1)
})

test('a direct payment before terminal time remains claimable, while one after terminal time does not', async () => {
  for (const terminalState of ['withdrawn', 'removed'] as const) {
    reset()
    state.listingOwner = 8
    state.listingPrice = 0.5
    state.listingWallet = TREASURY
    const beforeIntent = await openDirectIntent()
    const terminalAt = new Date(Date.now() + 3_000).toISOString()
    if (terminalState === 'withdrawn') {
      state.listingWithdrawn = true
      state.listingWithdrawnAt = terminalAt
    } else {
      state.listingRemoved = true
      state.listingRemovedAt = terminalAt
    }
    state.feeAgeSeconds = -1
    const before = await app.request('/api/claim/1', {
      method: 'POST', headers: authed, body: directClaimBody(beforeIntent.id, TX1),
    })
    assert.equal(before.status, 200, `payment before ${terminalState}_at was not delivered`)
    assert.equal(((await before.json()) as { artifact: string }).artifact, 'the goods')
    assert.equal(inserted('purchases'), 1)

    reset()
    state.listingOwner = 8
    state.listingPrice = 0.5
    state.listingWallet = TREASURY
    const afterIntent = await openDirectIntent()
    const nextTerminalAt = new Date(Date.now() + 1_000).toISOString()
    if (terminalState === 'withdrawn') {
      state.listingWithdrawn = true
      state.listingWithdrawnAt = nextTerminalAt
    } else {
      state.listingRemoved = true
      state.listingRemovedAt = nextTerminalAt
    }
    state.feeAgeSeconds = -3
    const after = await app.request('/api/claim/1', {
      method: 'POST', headers: authed, body: directClaimBody(afterIntent.id, TX2),
    })
    assert.notEqual(after.status, 200, `payment after ${terminalState}_at was incorrectly delivered`)
    assert.equal(inserted('purchases'), 0)
  }
})

test('listing edits require a valid bearer secret', async () => {
  reset()
  const missing = await app.request('/api/listing/1', {
    method: 'PATCH', body: JSON.stringify({ title: 'Edited title' }),
  })
  assert.equal(missing.status, 401)

  state.authValid = false
  const unknown = await app.request('/api/listing/1', {
    method: 'PATCH', headers: authed, body: JSON.stringify({ title: 'Edited title' }),
  })
  assert.equal(unknown.status, 401)
  assert.equal(hasSql(/UPDATE listings SET[\s\S]*title/i), false)
  assert.equal(inserted('events'), 0)
})

test('listing edits distinguish a non-owner from a missing listing', async () => {
  reset()
  state.listingOwner = 8
  const nonOwner = await app.request('/api/listing/1', {
    method: 'PATCH', headers: authed, body: JSON.stringify({ title: 'Edited title' }),
  })
  assert.equal(nonOwner.status, 403)
  assert.equal(inserted('events'), 0)

  reset()
  state.listingExists = false
  const missing = await app.request('/api/listing/999', {
    method: 'PATCH', headers: authed, body: JSON.stringify({ title: 'Edited title' }),
  })
  assert.equal(missing.status, 404)
  assert.match(((await missing.json()) as { error: string }).error, /no such listing/i)
  assert.equal(inserted('events'), 0)
})

test('listing edits reject empty patches and every field outside the edit allowlist', async () => {
  const rejectedBodies = [
    {},
    { merchant_id: 8 },
    { fee_tx_hash: TX1 },
    { price_usdc: 2 },
    { seller_wallet: STRANGER },
    { title: 'Allowed title', surprise: 'not allowed' },
  ]
  for (const body of rejectedBodies) {
    reset()
    const res = await app.request('/api/listing/1', {
      method: 'PATCH', headers: authed, body: JSON.stringify(body),
    })
    assert.equal(res.status, 400, `expected rejection for ${Object.keys(body).join(',') || 'empty patch'}`)
    assert.equal(inserted('events'), 0)
  }
})

test('listing edits reuse the complete listing validation after merging the patch', async () => {
  const invalidPatches: Record<string, unknown>[] = [
    { title: 'xx' },
    { description: '' },
    { preview: 'x'.repeat(4001) },
    { artifact: '' },
    { artifact: 'x'.repeat(262145) },
    { aisle: 'parking-lot' },
  ]
  for (const patchBody of invalidPatches) {
    reset()
    const res = await app.request('/api/listing/1', {
      method: 'PATCH', headers: authed, body: JSON.stringify(patchBody),
    })
    assert.equal(res.status, 400, `expected validation failure for ${Object.keys(patchBody)[0]}`)
    assert.equal(inserted('events'), 0)
  }
})

test('an owner can partially edit a listing and receives its updated public summary', async () => {
  reset()
  const newTitle = 'Edited useful thing'
  const newPreview = 'edited public sample'
  const res = await app.request('/api/listing/1', {
    method: 'PATCH', headers: authed,
    body: JSON.stringify({ title: newTitle, preview: newPreview }),
  })
  assert.equal(res.status, 200)
  const body = await res.json() as { listing: Record<string, unknown> }
  assert.equal(body.listing.id, 1)
  assert.equal(body.listing.title, newTitle)
  assert.equal(body.listing.preview, newPreview)
  assert.equal(body.listing.description, 'does work')
  assert.equal('artifact' in body.listing, false)

  const duplicateCheck = sqlCalls().find(call => call.query?.includes('dup_hash'))
  assert.match(duplicateCheck?.query ?? '', /id\s*(?:<>|!=)\s*\$\d+/i)
  assert.ok(duplicateCheck?.params?.includes(dupHash(newTitle, 'the goods')))

  const update = sqlCalls().find(call => /UPDATE listings SET[\s\S]*title/i.test(call.query ?? ''))
  assert.match(update?.query ?? '', /merchant_id/i)
  const event = sqlCalls().find(call => call.query?.includes('INSERT INTO events'))
  const receipt = `${event?.query}\n${JSON.stringify(event?.params?.slice(-2))}`
  assert.match(receipt, /listing_edit/)
  assert.match(receipt, /agent-7/)
  assert.match(receipt, /changed_fields/)
  assert.match(receipt, /title/)
  assert.match(receipt, /preview/)
  assert.doesNotMatch(receipt, /Edited useful thing|edited public sample|the goods/)
})

test('a free listing may edit its six non-payment fields before its first purchase', async () => {
  reset()
  const patchBody = {
    title: 'Entirely revised item',
    description: 'revised description',
    preview: 'revised preview',
    artifact: 'revised private artifact',
    tags: ['data', 'revised'],
    aisle: 'data',
  }
  const res = await app.request('/api/listing/1', {
    method: 'PATCH', headers: authed, body: JSON.stringify(patchBody),
  })
  assert.equal(res.status, 200)
  const summary = ((await res.json()) as { listing: Record<string, unknown> }).listing
  assert.equal(summary.title, patchBody.title)
  assert.equal(summary.description, patchBody.description)
  assert.equal(summary.preview, patchBody.preview)
  assert.equal(summary.price_usdc, 0)
  assert.equal(summary.seller_wallet, SELLER)
  assert.deepEqual(summary.tags, patchBody.tags)
  assert.equal(summary.aisle, patchBody.aisle)
  assert.equal('artifact' in summary, false)
  assert.equal(state.listingArtifact, patchBody.artifact)
})

test('a priced listing may edit only description, preview, tags, and aisle before its first purchase', async () => {
  reset()
  state.listingPrice = 1
  const patchBody = {
    description: 'clearer description',
    preview: 'clearer preview',
    tags: ['knowledge', 'revised'],
    aisle: 'knowledge',
  }
  const res = await app.request('/api/listing/1', {
    method: 'PATCH', headers: authed, body: JSON.stringify(patchBody),
  })
  assert.equal(res.status, 200)
  const summary = ((await res.json()) as { listing: Record<string, unknown> }).listing
  assert.equal(summary.description, patchBody.description)
  assert.equal(summary.preview, patchBody.preview)
  assert.deepEqual(summary.tags, patchBody.tags)
  assert.equal(summary.aisle, patchBody.aisle)
  assert.equal(summary.title, 'A useful thing')
  assert.equal(state.listingArtifact, 'the goods')
})

test('a priced listing keeps its title and delivered artifact immutable', async () => {
  for (const patchBody of [{ title: 'Repriced identity' }, { artifact: 'swapped paid goods' }]) {
    reset()
    state.listingPrice = 1
    const res = await app.request('/api/listing/1', {
      method: 'PATCH', headers: authed, body: JSON.stringify(patchBody),
    })
    assert.ok([400, 409].includes(res.status), `priced edit unexpectedly returned ${res.status}`)
    assert.match(((await res.json()) as { error: string }).error, /immutable|priced/i)
    assert.equal(inserted('events'), 0)
  }
})

test('a listing cannot be edited after any purchase, merchant withdrawal, or maintainer removal', async () => {
  const blockedStates = [
    () => { state.listingSales = 1 },
    () => { state.priorPurchase = true },
    () => { state.listingWithdrawn = true },
    () => { state.listingRemoved = true },
  ]
  for (const arrange of blockedStates) {
    reset()
    arrange()
    const res = await app.request('/api/listing/1', {
      method: 'PATCH', headers: authed, body: JSON.stringify({ description: 'Too late to edit' }),
    })
    assert.equal(res.status, 409)
    assert.equal(inserted('events'), 0)
  }
})

test('an edit that would duplicate another recent listing is rejected before mutation', async () => {
  reset()
  state.duplicateId = 9
  const res = await app.request('/api/listing/1', {
    method: 'PATCH', headers: authed,
    body: JSON.stringify({ title: 'Copycat title', artifact: 'copycat artifact' }),
  })
  assert.equal(res.status, 409)
  assert.match(((await res.json()) as { error: string }).error, /listing exists: 9|listing.*9/i)
  const duplicateCheck = sqlCalls().find(call => call.query?.includes('dup_hash'))
  assert.match(duplicateCheck?.query ?? '', /id\s*(?:<>|!=)\s*\$\d+/i)
  assert.ok(duplicateCheck?.params?.includes(dupHash('Copycat title', 'copycat artifact')))
  assert.equal(hasSql(/UPDATE listings SET[\s\S]*title/i), false)
  assert.equal(inserted('events'), 0)
})

test('recently withdrawn content still blocks an identical new listing', async () => {
  reset()
  state.duplicateId = 9
  state.duplicateWithdrawn = true
  const res = await app.request('/api/listing', {
    method: 'POST', headers: authed,
    body: listingBody(undefined, { title: 'Withdrawn duplicate', artifact: 'same withdrawn goods' }),
  })
  assert.equal(res.status, 409)
  assert.match(((await res.json()) as { error: string }).error, /listing exists: 9|listing.*9/i)
  const duplicateCheck = sqlCalls().find(call => call.query?.includes('dup_hash'))
  assert.doesNotMatch(duplicateCheck?.query ?? '', /NOT\s+(?:l\.)?withdrawn/i)
  assert.equal(inserted('listings'), 0)
})

test('recently withdrawn content still blocks an identical free-listing edit', async () => {
  reset()
  state.duplicateId = 9
  state.duplicateWithdrawn = true
  const res = await app.request('/api/listing/1', {
    method: 'PATCH', headers: authed,
    body: JSON.stringify({ title: 'Withdrawn duplicate', artifact: 'same withdrawn goods' }),
  })
  assert.equal(res.status, 409)
  assert.match(((await res.json()) as { error: string }).error, /listing exists: 9|listing.*9/i)
  const duplicateCheck = sqlCalls().find(call => call.query?.includes('dup_hash'))
  assert.doesNotMatch(duplicateCheck?.query ?? '', /NOT\s+(?:l\.)?withdrawn/i)
  assert.equal(inserted('events'), 0)
})

test('an identical normalized listing patch is a 200 no-op without another public event', async () => {
  reset()
  const res = await app.request('/api/listing/1', {
    method: 'PATCH', headers: authed,
    body: JSON.stringify({ title: '  A useful thing  ', tags: ['MCP'] }),
  })
  assert.equal(res.status, 200)
  const summary = ((await res.json()) as { listing: Record<string, unknown> }).listing
  assert.equal(summary.title, 'A useful thing')
  assert.deepEqual(summary.tags, ['mcp'])
  assert.equal(inserted('events'), 0)
})

test('DELETE /api/listing/:id is an idempotent alias for owner withdrawal', async () => {
  reset()
  const first = await app.request('/api/listing/1', { method: 'DELETE', headers: authed })
  const second = await app.request('/api/listing/1', { method: 'DELETE', headers: authed })
  assert.equal(first.status, 200)
  assert.equal(second.status, 200)
  assert.deepEqual(await second.json(), { ok: true, listing_id: 1, status: 'withdrawn' })
  assert.equal(state.listingWithdrawn, true)
  assert.equal(inserted('events'), 1)
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
  const intent = await openDirectIntent()
  state.feeAgeSeconds = -2
  const claimed = await app.request('/api/claim/1', {
    method: 'POST', headers: authed, body: directClaimBody(intent.id, TX_CASE_LOWER),
  })
  assert.equal(claimed.status, 409)
  assert.match(((await claimed.json()) as { error: string }).error, /already purchased|tx already used/)
})

test('one treasury tx cannot be a keeper purchase and then a listing fee', async () => {
  reset()
  state.listingOwner = 8
  state.listingPrice = 0.5
  state.listingWallet = TREASURY
  const intent = await openDirectIntent()
  state.feeAgeSeconds = -2
  const claimed = await app.request('/api/claim/1', {
    method: 'POST', headers: authed, body: directClaimBody(intent.id, TX_CASE_UPPER),
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
  assert.equal(body.store.listings, 1)
  assert.equal(body.listings.length, 1)
  assert.equal(body.listings[0]!.store_url, '/api/store/agent-8')
  assert.equal('artifact' in body.listings[0]!, false)
  assert.equal('secret_hash' in body.store, false)
  assert.ok(sqlCalls().some(call => call.query?.includes('NOT l.removed')))
})

test('the human window requests a bounded storefront view', async () => {
  reset()
  const res = await app.request('/api/store/agent-8?limit=50')
  assert.equal(res.status, 200)
  assert.match(res.headers.get('cache-control') ?? '', /s-maxage=60/)
  const listingRead = sqlCalls().find(call =>
    call.query?.includes('FROM listings l JOIN merchants m') && call.query.includes('l.merchant_id'))
  assert.match(listingRead?.query ?? '', /LIMIT \$2/)
  assert.deepEqual(listingRead?.params?.map(Number), [8, 50])
})

test('invalid storefront limits fail before database reads', async () => {
  reset()
  const res = await app.request('/api/store/agent-8?limit=51')
  assert.equal(res.status, 400)
  assert.equal(sqlCalls().length, 0)
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

test('the cached human window snapshot is bounded and excludes flag events before the limit', async () => {
  reset()
  const res = await app.request('/api/window')
  assert.equal(res.status, 200)
  assert.match(res.headers.get('cache-control') ?? '', /s-maxage=60/)
  const body = await res.json() as {
    events: Record<string, unknown>[]
    merchants: Record<string, unknown>[]
    listings: Record<string, unknown>[]
    aisles: Record<string, unknown>[]
    refreshed_at: string
    merchant_total: number
  }
  assert.equal(body.events.length, 1)
  assert.equal(body.merchants.length, 1)
  assert.equal(body.listings.length, 1)
  assert.equal(body.aisles.length, AISLES.length)
  assert.equal(body.merchant_total, 1)
  assert.ok(Number.isFinite(Date.parse(body.refreshed_at)))

  const eventRead = sqlCalls().find(call => call.query?.includes('FROM events') && call.query.includes('kind IN'))
  assert.match(eventRead?.query ?? '', /WHERE kind IN[\s\S]*ORDER BY id DESC LIMIT 100/)
  assert.match(eventRead?.query ?? '', /'world_sale'/)
  assert.match(eventRead?.query ?? '', /'world_canceled'/)
  assert.doesNotMatch(eventRead?.query ?? '', /'flag'/)
  const listingRead = sqlCalls().find(call =>
    call.query?.includes('FROM listings l JOIN merchants m') && call.query.includes('LIMIT 50'))
  assert.doesNotMatch(listingRead?.query ?? '', /seller_wallet|artifact/)

  const readsAfterFirstRequest = sqlCalls().length
  const cached = await app.request('/api/window')
  assert.equal(cached.status, 200)
  assert.equal(sqlCalls().length, readsAfterFirstRequest)
})

test('the human snapshot rejects cache-busting inputs before database reads', async () => {
  reset()
  const query = await app.request('/api/window?nonce=one-off')
  assert.equal(query.status, 400)
  assert.equal(sqlCalls().length, 0)

  const authorized = await app.request('/api/window', {
    headers: { Authorization: 'Bearer deliberately-not-a-real-secret' },
  })
  assert.equal(authorized.status, 400)
  assert.equal(sqlCalls().length, 0)
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
  const query = sqlCalls().find(call => call.query?.includes('SELECT at, kind, actor, detail FROM events'))?.query ?? ''
  assert.match(query, /'world_sale'/)
  assert.match(query, /'world_canceled'/)
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

test('MCP direct buying requires a fresh payer-signed intent and rejects tx-hash-only claims', async () => {
  reset()
  state.listingOwner = 8
  state.listingPrice = 0.5
  state.listingWallet = TREASURY

  const listed = await app.request('/mcp', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 40, method: 'tools/list' }),
  })
  const buy = ((await listed.json() as {
    result: { tools: Array<{ name: string; description: string; inputSchema: { properties: Record<string, unknown> } }> }
  }).result.tools).find(tool => tool.name === 'buy')!
  assert.match(buy.description, /fresh ten-minute.*payer wallet.*intent_id.*payer_signature/i)
  assert.deepEqual(Object.keys(buy.inputSchema.properties).sort(), [
    'id', 'intent_id', 'payer_signature', 'payer_wallet', 'tx_hash',
  ])

  const opened = await app.request('/mcp', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 41, method: 'tools/call',
      params: { name: 'buy', arguments: { id: 1, payer_wallet: SELLER } },
    }),
  })
  const openedBody = await opened.json() as { result: { isError: boolean; content: Array<{ text: string }> } }
  assert.equal(openedBody.result.isError, false)
  const intent = (JSON.parse(openedBody.result.content[0]!.text) as { purchase_intent: PurchaseIntentRow }).purchase_intent
  state.feeAgeSeconds = -2

  const claimed = await app.request('/mcp', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 42, method: 'tools/call',
      params: {
        name: 'buy',
        arguments: { id: 1, intent_id: intent.id, tx_hash: TX1, payer_signature: SIGNATURE },
      },
    }),
  })
  const claimedBody = await claimed.json() as { result: { isError: boolean; content: Array<{ text: string }> } }
  assert.equal(claimedBody.result.isError, false)
  assert.equal((JSON.parse(claimedBody.result.content[0]!.text) as { artifact: string }).artifact, 'the goods')

  reset()
  state.listingOwner = 8
  state.listingPrice = 0.5
  state.listingWallet = TREASURY
  const oldProof = await app.request('/mcp', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 43, method: 'tools/call',
      params: { name: 'buy', arguments: { id: 1, tx_hash: TX2 } },
    }),
  })
  const oldProofBody = await oldProof.json() as { result: { isError: boolean; content: Array<{ text: string }> } }
  assert.equal(oldProofBody.result.isError, true)
  assert.match(oldProofBody.result.content[0]!.text, /exactly: intent_id, tx_hash, payer_signature/i)
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

test('MCP advertises and dispatches idempotent owner withdrawal through bearer-header auth', async () => {
  reset()
  const listed = await app.request('/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 20, method: 'tools/list' }),
  })
  const listBody = await listed.json() as {
    result: { tools: {
      name: string
      inputSchema: { properties?: Record<string, unknown>; required?: string[] }
      annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean }
    }[] }
  }
  const withdraw = listBody.result.tools.find(tool => tool.name === 'withdraw_item')
  assert.ok(withdraw)
  assert.deepEqual(withdraw.inputSchema.required, ['id'])
  assert.deepEqual(Object.keys(withdraw.inputSchema.properties ?? {}), ['id'])
  assert.deepEqual(withdraw.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  })

  const called = await app.request('/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 21, method: 'tools/call',
      params: { name: 'withdraw_item', arguments: { id: 1 } },
    }),
  })
  assert.equal(called.status, 200)
  const callBody = await called.json() as { result: { isError: boolean; content: { text: string }[] } }
  assert.equal(callBody.result.isError, false)
  assert.deepEqual(JSON.parse(callBody.result.content[0]!.text), {
    ok: true, listing_id: 1, status: 'withdrawn',
  })
  assert.equal(state.listingWithdrawn, true)
})

test('MCP advertises and dispatches canonical listing edits through bearer-header auth', async () => {
  reset()
  const listed = await app.request('/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 30, method: 'tools/list' }),
  })
  const listBody = await listed.json() as {
    result: { tools: {
      name: string
      inputSchema: { properties?: Record<string, unknown>; required?: string[] }
      annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean }
    }[] }
  }
  const edit = listBody.result.tools.find(tool => tool.name === 'edit_item')
  assert.ok(edit)
  assert.deepEqual(edit.inputSchema.required, ['id'])
  assert.deepEqual(Object.keys(edit.inputSchema.properties ?? {}).sort(), [
    'aisle', 'artifact', 'description', 'id', 'preview', 'tags', 'title',
  ])
  assert.deepEqual(edit.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  })

  const called = await app.request('/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 31, method: 'tools/call',
      params: { name: 'edit_item', arguments: { id: 1, title: 'MCP-edited title' } },
    }),
  })
  assert.equal(called.status, 200)
  const callBody = await called.json() as { result: { isError: boolean; content: { text: string }[] } }
  assert.equal(callBody.result.isError, false)
  const summary = (JSON.parse(callBody.result.content[0]!.text) as { listing: Record<string, unknown> }).listing
  assert.equal(summary.title, 'MCP-edited title')
  assert.equal('artifact' in summary, false)
})
