// World-bridge route tests fake Neon, Base RPC, and the city's public GET records.
// They never use a live service, bearer secret, wallet, transaction, or database.
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.DATABASE_URL = 'postgresql://fake:fake@fake-host.example.neon.tech/fakedb'
process.env.TREASURY_ADDRESS = '0x3b9d230c9b995fb1a10add2d63ce37437916dcfd'
process.env.PUBLIC_ORIGIN = 'https://1f3ea.com'

const SECRET = '1f3ea_sk_' + 'ab'.repeat(24)
const SELLER = '0x1111111111111111111111111111111111111111'
const BUYER_WALLET = '0x2222222222222222222222222222222222222222'
const TREASURY = process.env.TREASURY_ADDRESS
const TX = '0x' + '31'.repeat(32)
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

interface DbCall { query: string; params: unknown[] }

const state = {
  merchantId: 7,
  authValid: true,
  seedCount: 10,
  pendingConflict: false,
  draftExists: true,
  draftState: 'pending',
  draftExpiresAt: '2099-08-12T01:00:00.000Z',
  draftListingId: null as number | null,
  listingExists: true,
  listingOwner: 7,
  listingWorldState: 'active',
  listingRemoved: false,
  listingRemovedAt: null as string | null,
  listingWithdrawnReason: null as string | null,
  listingWithdrawn: false,
  listingWithdrawnAt: null as string | null,
  activeCheckoutConflict: false,
  checkoutStatus: 'active',
  checkoutExpiresAt: '2099-08-12T00:10:00.000Z',
  checkoutMerchantId: 9,
  checkoutMarketBuyer: 'agent-9',
  checkoutCityHandle: 'new-neighbor',
  cityMarketBuyer: 'agent-9',
  priorReceipt: null as Record<string, unknown> | null,
  cityMode: 'ok' as 'ok' | 'outage' | 'bad-json' | 'huge-stream' | 'missing' | 'mismatch' | 'reserved' | 'reserved-expired' | 'payment-pending' | 'payment-invalid' | 'unknown-phase' | 'canceled' | 'claimed',
  cityStreamPulls: 0,
  cityStreamCanceled: false,
  cityReservedAt: '2026-08-12T00:04:00.000Z',
  cityReservedUntil: '2026-08-12T00:09:00.000Z',
  cityClaimedAt: '2026-08-12T00:08:00.000Z',
  cityBlockTime: '2026-08-12T00:07:00.000Z',
  residentExists: true,
  dbCalls: [] as DbCall[],
  cityCalls: [] as string[],
  rpcCalls: 0,
}

function merchantRow(id = state.merchantId) {
  return {
    id, handle: `agent-${id}`, model: 'test-model', storefront_line: '', karma: 0,
    joined_at: '2026-08-12T00:00:00.000Z', quota_day: '2026-08-12', comments_today: 0, votes_today: 0,
  }
}

function draftRow() {
  return {
    id: 12,
    merchant_id: 7,
    thing_id: 41,
    title: 'Pocket observatory',
    description: 'A small place to watch the sky.',
    preview: 'brass and patient glass',
    price_usdc: 2,
    seller_wallet: SELLER,
    tags: ['sky', 'tool'],
    state: state.draftState,
    listing_id: state.draftListingId,
    listing_state: state.draftListingId ? state.listingWorldState : null,
    listing_withdrawn: state.listingWithdrawn,
    listing_removed: state.listingRemoved,
    created_at: '2026-08-12T00:00:00.000Z',
    expires_at: state.draftExpiresAt,
    canceled_at: null,
  }
}

function listingRow() {
  return {
    id: 70,
    merchant_id: state.listingOwner,
    market_seller: `agent-${state.listingOwner}`,
    merchant: `agent-${state.listingOwner}`,
    title: 'Pocket observatory',
    description: 'A small place to watch the sky.',
    preview: 'brass and patient glass',
    price_usdc: 2,
    seller_wallet: SELLER,
    tags: ['sky', 'tool'],
    aisle: 'world',
    votes: 0,
    sales: state.listingWorldState === 'sold' ? 1 : 0,
    pinned: false,
    state: 'live',
    delivery_kind: 'city_ownership',
    world_origin: 'https://1f3d9.com',
    city_url: 'https://1f3d9.com',
    world_offer_id: 33,
    world_asset_id: 41,
    world_seller_handle: 'city-smith',
    world_draft_id: 12,
    world_state: state.listingWorldState,
    city_offer_url: 'https://1f3d9.com/api/world/offer/33',
    world_asset_url: 'https://1f3d9.com/api/world/offer/33',
    requires_city_resident: true,
    removed: state.listingRemoved,
    removed_at: state.listingRemovedAt,
    withdrawn: state.listingWithdrawn,
    withdrawn_at: state.listingWithdrawnAt,
    withdrawn_reason: state.listingWithdrawnReason,
    created_at: '2026-08-12T00:01:00.000Z',
    checked_at: '2026-08-12T00:02:00.000Z',
  }
}

function checkoutRow() {
  return {
    id: 60,
    status: state.checkoutStatus,
    listing_id: 70,
    world_offer_id: 33,
    market_draft_id: 12,
    merchant_id: state.checkoutMerchantId,
    market_buyer: state.checkoutMarketBuyer,
    city_handle: state.checkoutCityHandle,
    expires_at: state.checkoutExpiresAt,
    created_at: '2026-08-12T00:02:00.000Z',
  }
}

function cityOffer() {
  const base = {
    id: 33,
    channel: 'world',
    phase: state.cityMode === 'claimed' ? 'claimed'
      : state.cityMode === 'canceled' ? 'canceled'
        : ['reserved', 'reserved-expired'].includes(state.cityMode) ? 'reserved'
          : state.cityMode === 'payment-pending' ? 'payment_pending'
            : state.cityMode === 'payment-invalid' ? 'payment_invalid'
            : state.cityMode === 'unknown-phase' ? 'surprise' : 'listed',
    asset_type: 'thing',
    asset_id: state.cityMode === 'mismatch' ? 999 : 41,
    asset_name: 'Pocket observatory',
    locked: !['claimed', 'canceled'].includes(state.cityMode),
    seller: 'city-smith',
    buyer: ['claimed', 'reserved', 'reserved-expired', 'payment-pending', 'payment-invalid'].includes(state.cityMode)
      ? state.checkoutCityHandle : null,
    market_buyer: ['claimed', 'reserved', 'reserved-expired', 'payment-pending', 'payment-invalid'].includes(state.cityMode)
      ? state.cityMarketBuyer : null,
    price_usdc: 2,
    seller_wallet: SELLER,
    market_origin: 'https://1f3ea.com',
    market_draft_id: 12,
    market_listing_id: state.draftListingId,
    market_checkout_id: ['claimed', 'reserved', 'payment-pending', 'payment-invalid'].includes(state.cityMode) ? 60
      : state.cityMode === 'reserved-expired' ? 59 : null,
    reserved_at: ['claimed', 'reserved', 'payment-pending', 'payment-invalid'].includes(state.cityMode) ? state.cityReservedAt
      : state.cityMode === 'reserved-expired' ? '2020-01-01T00:00:00.000Z' : null,
    reserved_until: ['claimed', 'reserved', 'payment-pending', 'payment-invalid'].includes(state.cityMode) ? state.cityReservedUntil
      : state.cityMode === 'reserved-expired' ? '2020-01-01T00:05:00.000Z' : null,
    created_at: '2026-08-12T00:00:30.000Z',
    claimed_at: state.cityMode === 'claimed' ? state.cityClaimedAt : null,
    canceled_at: state.cityMode === 'canceled' ? '2026-08-12T00:05:00.000Z' : null,
    tx_hash: state.cityMode === 'claimed' ? TX : null,
    buyer_wallet: state.cityMode === 'claimed' ? BUYER_WALLET : null,
    verified_via: state.cityMode === 'claimed' ? 'x402' : null,
    block_time: state.cityMode === 'claimed' ? state.cityBlockTime : null,
    from: state.cityMode === 'claimed' ? BUYER_WALLET : null,
    to: state.cityMode === 'claimed' ? SELLER : null,
    pending_x402_tx_hash: ['payment-pending', 'payment-invalid'].includes(state.cityMode) ? TX : null,
    pending_x402_at: ['payment-pending', 'payment-invalid'].includes(state.cityMode)
      ? '2026-08-12T00:05:00.000Z' : null,
  }
  return base
}

function dbRespond(query: string, params: unknown[]): Record<string, unknown>[] {
  if (query.includes('WHERE secret_hash')) return state.authValid ? [merchantRow()] : []
  if (query.includes('INSERT INTO world_drafts')) {
    if (state.pendingConflict) throw Object.assign(new Error('pending draft exists'), { code: '23505' })
    return [{ id: 12, expires_at: state.draftExpiresAt }]
  }
  if (query.includes('FROM world_drafts d')) return state.draftExists ? [draftRow()] : []
  if (query.includes('FROM world_drafts') && query.includes('WHERE id') && !query.includes('INSERT INTO listings'))
    return state.draftExists ? [draftRow()] : []
  if (query.includes('SELECT count(*)::int AS n FROM listings WHERE merchant_id')) return [{ n: state.seedCount }]
  if (query.includes('INSERT INTO listings') && query.includes('world_draft')) {
    state.draftState = 'active'
    state.draftListingId = 70
    return [{ id: 70 }]
  }
  if (query.includes('FROM listings') && query.includes('world_offer_id'))
    return state.listingExists ? [listingRow()] : []
  if (query.includes('INSERT INTO world_checkouts')) {
    if (state.activeCheckoutConflict) throw Object.assign(new Error('active checkout exists'), { code: '23505' })
    return [{ id: 60, expires_at: state.checkoutExpiresAt }]
  }
  if (query.includes('FROM world_checkouts c')) return [checkoutRow()]
  if (query.includes('FROM world_checkouts') && query.includes('WHERE id')) return [checkoutRow()]
  if (query.includes('world_checkout_id') && query.includes('FROM purchases'))
    return state.priorReceipt ? [state.priorReceipt] : []
  if (query.includes("CASE WHEN l.delivery_kind = 'city_ownership' THEN p.world_receipt")) {
    return state.priorReceipt ? [{
      listing_id: 70,
      title: 'Pocket observatory',
      amount_usdc: 2,
      verified_via: 'world',
      created_at: '2026-08-12T00:06:00.000Z',
      delivery_kind: 'city_ownership',
      artifact: null,
      world_receipt: { city_offer_id: 33, city_handle: state.checkoutCityHandle },
      city_receipt_url: 'https://1f3d9.com/api/world/offer/33',
    }] : []
  }
  if (query.includes('INSERT INTO purchases') && query.includes("'world'")) {
    state.listingWorldState = 'sold'
    state.draftState = 'sold'
    state.checkoutStatus = 'completed'
    state.priorReceipt = {
      purchase_id: 81,
      listing_id: 70,
      world_checkout_id: 60,
      amount_usdc: 2,
      tx_hash: TX,
      world_receipt: params.find(value => typeof value === 'string' && String(value).includes('city_handle')) ?? {},
      created_at: '2026-08-12T00:06:00.000Z',
    }
    return [state.priorReceipt]
  }
  if (query.includes('WITH removed_listing AS') && query.includes('world_checkouts')) {
    state.listingRemoved = true
    state.listingRemovedAt = '2026-08-12T00:03:00.000Z'
    if (state.listingWorldState !== 'sold') state.listingWorldState = 'canceled'
    state.checkoutStatus = 'expired'
    if (state.draftState !== 'sold') state.draftState = 'canceled'
    return [{ id: 70 }]
  }
  if (query.includes('WITH canceled_listing AS')) {
    state.listingWorldState = 'canceled'
    state.listingWithdrawn = true
    state.listingWithdrawnReason = 'city offer canceled'
    state.draftState = 'canceled'
    return [{ id: 70 }]
  }
  if (query.includes('WITH invalid_payment_listing AS')) {
    const changed = state.listingWorldState === 'active'
    state.listingWorldState = 'stale'
    state.listingWithdrawn = true
    state.listingWithdrawnReason = 'city payment invalid'
    state.draftState = 'canceled'
    state.checkoutStatus = 'expired'
    return changed ? [{ id: 70 }] : []
  }
  if (query.includes('SELECT id, merchant_id') && query.includes('FROM listings WHERE id'))
    return state.listingExists ? [listingRow()] : []
  if (query.includes('UPDATE listings SET') && query.includes('withdrawn = TRUE')) {
    state.listingWithdrawn = true
    state.listingWorldState = 'canceled'
    state.draftState = 'withdrawn'
    return [{ id: 70 }]
  }
  if (query.includes('SELECT id FROM purchases')) return []
  if (query.includes('FROM comments c JOIN merchants m')) return []
  if (query.includes('FROM listings WHERE merchant_id')) return [{
    id: 70,
    title: 'Pocket observatory',
    aisle: 'world',
    delivery_kind: 'city_ownership',
    world_state: state.listingWorldState,
    price_usdc: 2,
    votes: 0,
    sales: state.listingWorldState === 'sold' ? 1 : 0,
    pinned: false,
    removed: state.listingRemoved,
    removed_at: state.listingRemovedAt,
    withdrawn: state.listingWithdrawn,
    withdrawn_at: state.listingWithdrawnAt,
    created_at: '2026-08-12T00:01:00.000Z',
    withdrawn_reason: state.listingWithdrawnReason,
    state: state.listingWorldState === 'sold' ? 'sold'
      : state.listingRemoved ? 'removed'
        : state.listingWithdrawn && state.listingWithdrawnReason === 'withdrawn by merchant' ? 'withdrawn'
          : ['canceled', 'stale'].includes(state.listingWorldState) ? state.listingWorldState
            : state.listingWithdrawn ? 'withdrawn' : 'live',
  }]
  if (query.includes('JOIN merchants b ON b.id = p.merchant_id')) return []
  if (query.includes('FROM purchases p JOIN listings l') && query.includes('WHERE p.merchant_id')) return []
  if (query.includes('FROM comments c JOIN listings l')) return []
  throw new Error(`unhandled world test query: ${query}`)
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

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const pad32 = (address: string) => '0x' + address.toLowerCase().replace(/^0x/, '').padStart(64, '0')

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input)
  if (url.includes('/sql')) {
    const body = JSON.parse(String(init?.body ?? '{}'))
    state.dbCalls.push({ query: body.query, params: body.params ?? [] })
    return json(neonEncode(dbRespond(body.query, body.params ?? [])))
  }
  if (url.startsWith('https://1f3d9.com/')) {
    state.cityCalls.push(url)
    if (state.cityMode === 'outage') throw new Error('city unavailable (test)')
    if (state.cityMode === 'bad-json') return new Response('{no', { status: 200 })
    if (state.cityMode === 'huge-stream') {
      const encoder = new TextEncoder()
      return new Response(new ReadableStream({
        pull(controller) {
          state.cityStreamPulls++
          if (state.cityStreamPulls > 100) return controller.close()
          controller.enqueue(encoder.encode('x'.repeat(16 * 1024)))
        },
        cancel() { state.cityStreamCanceled = true },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/resident/')) return state.residentExists
      ? json({ resident: { handle: state.checkoutCityHandle } })
      : json({ error: 'not found' }, 404)
    if (state.cityMode === 'missing') return json({ error: 'not found' }, 404)
    return json({ offer: cityOffer() })
  }
  if (url.includes('mainnet.base.org')) {
    state.rpcCalls++
    const body = JSON.parse(String(init?.body ?? '{}'))
    if (body.method === 'eth_getTransactionReceipt') return json({
      jsonrpc: '2.0', id: body.id, result: {
        status: '0x1', blockHash: '0x' + 'bb'.repeat(32),
        logs: [{ address: USDC, topics: [TRANSFER_TOPIC, pad32(SELLER), pad32(TREASURY)], data: '0x0f4240' }],
      },
    })
    if (body.method === 'eth_getBlockByHash') return json({
      jsonrpc: '2.0', id: body.id,
      result: { timestamp: '0x' + Math.floor(Date.now() / 1000).toString(16) },
    })
  }
  throw new Error(`unexpected world test fetch: ${url}`)
}) as typeof fetch

const { default: app } = await import('../src/index.ts')
const auth = { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' }

const draftBody = (extra: Record<string, unknown> = {}) => JSON.stringify({
  title: 'Pocket observatory', description: 'A small place to watch the sky.',
  preview: 'brass and patient glass', price_usdc: 2, seller_wallet: SELLER,
  tags: ['sky', 'tool'], thing_id: 41, ...extra,
})

function reset() {
  state.merchantId = 7
  state.authValid = true
  state.seedCount = 10
  state.pendingConflict = false
  state.draftExists = true
  state.draftState = 'pending'
  state.draftExpiresAt = '2099-08-12T01:00:00.000Z'
  state.draftListingId = null
  state.listingExists = true
  state.listingOwner = 7
  state.listingWorldState = 'active'
  state.listingRemoved = false
  state.listingRemovedAt = null
  state.listingWithdrawnReason = null
  state.listingWithdrawn = false
  state.listingWithdrawnAt = null
  state.activeCheckoutConflict = false
  state.checkoutStatus = 'active'
  state.checkoutExpiresAt = '2099-08-12T00:10:00.000Z'
  state.checkoutMerchantId = 9
  state.checkoutMarketBuyer = 'agent-9'
  state.checkoutCityHandle = 'new-neighbor'
  state.cityMarketBuyer = 'agent-9'
  state.priorReceipt = null
  state.cityMode = 'ok'
  state.cityStreamPulls = 0
  state.cityStreamCanceled = false
  state.cityReservedAt = '2026-08-12T00:04:00.000Z'
  state.cityReservedUntil = '2026-08-12T00:09:00.000Z'
  state.cityClaimedAt = '2026-08-12T00:08:00.000Z'
  state.cityBlockTime = '2026-08-12T00:07:00.000Z'
  state.residentExists = true
  state.dbCalls = []
  state.cityCalls = []
  state.rpcCalls = 0
}

const writes = () => state.dbCalls.filter(call => /INSERT|UPDATE\s+(?!merchants SET\s+comments_today)/i.test(call.query))

test('world draft creation is exact, free, expiring, and bounded to one pending draft', async () => {
  reset()
  const noAuth = await app.request('/api/world/draft', { method: 'POST', body: draftBody() })
  assert.equal(noAuth.status, 401)

  const extra = await app.request('/api/world/draft', {
    method: 'POST', headers: auth, body: draftBody({ artifact: 'secret goods' }),
  })
  assert.equal(extra.status, 400)

  const created = await app.request('/api/world/draft', { method: 'POST', headers: auth, body: draftBody() })
  assert.equal(created.status, 201)
  const result = await created.json() as Record<string, unknown>
  assert.equal(result.draft_id, 12)
  assert.equal(result.url, 'https://1f3ea.com/api/world/draft/12')
  assert.equal(state.rpcCalls, 0)

  state.pendingConflict = true
  const conflict = await app.request('/api/world/draft', { method: 'POST', headers: auth, body: draftBody() })
  assert.equal(conflict.status, 409)
  assert.match((await conflict.json() as { error: string }).error, /pending draft/i)
})

test('public draft records derive expiry and expose no bearer data', async () => {
  reset()
  const pending = await app.request('/api/world/draft/12')
  assert.equal(pending.status, 200)
  const first = await pending.json() as { draft: Record<string, unknown> }
  assert.deepEqual(first.draft.world_asset, { type: 'thing', id: 41 })
  assert.equal(first.draft.delivery_kind, 'city_ownership')
  assert.equal(first.draft.status, 'pending')
  assert.equal(JSON.stringify(first).includes('secret'), false)

  state.draftExpiresAt = '2020-01-01T00:00:00.000Z'
  const expired = await app.request('/api/world/draft/12')
  assert.equal((await expired.json() as { draft: { status: string } }).draft.status, 'expired')
})

test('activation fails closed on city outage, malformed JSON, and ownership mismatch before fees', async () => {
  for (const [mode, status] of [['outage', 503], ['bad-json', 503], ['mismatch', 409]] as const) {
    reset()
    state.cityMode = mode
    const response = await app.request('/api/world/listing', {
      method: 'POST', headers: auth, body: JSON.stringify({ draft_id: 12, city_offer_id: 33 }),
    })
    assert.equal(response.status, status)
    assert.equal(state.rpcCalls, 0)
    assert.equal(state.dbCalls.some(call => call.query.includes('INSERT INTO listings')), false)
  }
})

test('a proved city lock still needs the normal fee and activates atomically after direct proof', async () => {
  reset()
  const challenge = await app.request('/api/world/listing', {
    method: 'POST', headers: auth, body: JSON.stringify({ draft_id: 12, city_offer_id: 33 }),
  })
  assert.equal(challenge.status, 402)
  assert.equal(state.dbCalls.some(call => call.query.includes('INSERT INTO listings')), false)

  const activated = await app.request('/api/world/listing', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ draft_id: 12, city_offer_id: 33, fee_tx_hash: TX }),
  })
  assert.equal(activated.status, 201)
  const body = await activated.json() as Record<string, unknown>
  assert.equal(body.listing_id, 70)
  assert.equal(body.delivery_kind, 'city_ownership')
  const atomic = state.dbCalls.find(call => call.query.includes('INSERT INTO listings'))?.query ?? ''
  assert.match(atomic, /UPDATE world_drafts/)
  assert.match(atomic, /INSERT INTO fees/)
  assert.match(atomic, /world_state/)
})

test('a nonresident buyer stops before checkout and is told to choose their own city name', async () => {
  reset()
  state.merchantId = 9
  state.draftListingId = 70
  state.residentExists = false
  const response = await app.request('/api/world/checkout/70', {
    method: 'POST', headers: auth, body: JSON.stringify({ city_handle: 'new-neighbor' }),
  })
  assert.equal(response.status, 409)
  assert.match((await response.json() as { error: string }).error, /register in the city.*choose your own name.*before checkout.*payment/i)
  assert.equal(state.dbCalls.some(call => call.query.includes('INSERT INTO world_checkouts')), false)
  assert.equal(state.rpcCalls, 0)
})

test('checkout binds one market buyer to one city resident and closes the race', async () => {
  reset()
  state.merchantId = 9
  state.draftListingId = 70
  const created = await app.request('/api/world/checkout/70', {
    method: 'POST', headers: auth, body: JSON.stringify({ city_handle: 'new-neighbor' }),
  })
  assert.equal(created.status, 201)
  const body = await created.json() as Record<string, unknown>
  assert.equal(body.checkout_id, 60)
  assert.equal(body.city_claim_url, 'https://1f3d9.com/api/world/offer/33/claim')

  state.activeCheckoutConflict = true
  const raced = await app.request('/api/world/checkout/70', {
    method: 'POST', headers: auth, body: JSON.stringify({ city_handle: 'new-neighbor' }),
  })
  assert.equal(raced.status, 409)
})

test('normal buy and direct claim reject world delivery before any payment work', async () => {
  reset()
  state.merchantId = 9
  for (const path of ['/api/buy/70', '/api/claim/70']) {
    const response = await app.request(path, {
      method: 'POST', headers: auth, body: path.includes('claim') ? JSON.stringify({ tx_hash: TX }) : '{}',
    })
    assert.equal(response.status, 409)
    assert.match((await response.json() as { error: string }).error, /world checkout.*\/api\/world\/checkout\/70/i)
  }
  assert.equal(state.rpcCalls, 0)
  assert.equal(state.dbCalls.some(call => call.query.includes('INSERT INTO purchases')), false)
})

test('world sync rejects mismatches and outages without terminal local writes', async () => {
  reset()
  state.merchantId = 9
  state.draftListingId = 70
  state.cityMode = 'mismatch'
  const mismatch = await app.request('/api/world/sync/70', { method: 'POST', headers: auth, body: '{}' })
  assert.equal(mismatch.status, 409)

  reset()
  state.merchantId = 9
  state.draftListingId = 70
  state.cityMode = 'outage'
  const outage = await app.request('/api/world/sync/70', { method: 'POST', headers: auth, body: '{}' })
  assert.equal(outage.status, 503)
  assert.equal(state.listingWorldState, 'active')
  assert.equal(state.dbCalls.some(call => call.query.includes('INSERT INTO purchases')), false)
})

test('claimed city ownership becomes one idempotent market receipt and verified purchase', async () => {
  reset()
  state.merchantId = 10
  state.draftListingId = 70
  state.cityMode = 'claimed'
  const first = await app.request('/api/world/sync/70', { method: 'POST', headers: auth, body: '{}' })
  assert.equal(first.status, 200)
  const firstBody = await first.json() as { receipt: Record<string, unknown> }
  assert.equal(firstBody.receipt.delivery_kind, 'city_ownership')
  assert.equal(firstBody.receipt.city_handle, 'new-neighbor')
  assert.equal(state.listingWorldState, 'sold')
  assert.equal(state.checkoutStatus, 'completed')
  assert.equal(state.dbCalls.filter(call => call.query.includes('INSERT INTO purchases')).length, 1)

  const second = await app.request('/api/world/sync/70', { method: 'POST', headers: auth, body: '{}' })
  assert.equal(second.status, 200)
  assert.equal(state.dbCalls.filter(call => call.query.includes('INSERT INTO purchases')).length, 1)
})

test('world withdrawal is market-first and truthfully requires a separate city unlock', async () => {
  reset()
  state.draftListingId = 70
  const response = await app.request('/api/listing/70/withdraw', { method: 'POST', headers: auth, body: '{}' })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    ok: true,
    listing_id: 70,
    status: 'withdrawn',
    city_unlock_required: true,
    city_cancel_url: 'https://1f3d9.com/api/world/offer/33/cancel',
  })
  assert.equal(state.cityCalls.length, 0)
})

test('checkout expiry governs reservation start, while a reserved city payment may finish later', async () => {
  reset()
  state.merchantId = 10
  state.draftListingId = 70
  state.cityMode = 'claimed'
  state.checkoutExpiresAt = '2026-08-12T00:05:00.000Z'
  state.cityReservedAt = '2026-08-12T00:04:00.000Z'
  state.cityReservedUntil = '2026-08-12T00:09:00.000Z'
  state.cityClaimedAt = '2026-08-12T00:08:30.000Z'
  state.cityBlockTime = '2026-08-12T00:08:00.000Z'
  const valid = await app.request('/api/world/sync/70', { method: 'POST', headers: auth, body: '{}' })
  assert.equal(valid.status, 200)

  reset()
  state.merchantId = 10
  state.draftListingId = 70
  state.cityMode = 'claimed'
  state.checkoutExpiresAt = '2026-08-12T00:05:00.000Z'
  state.cityReservedAt = '2026-08-12T00:05:01.000Z'
  state.cityReservedUntil = '2026-08-12T00:10:01.000Z'
  state.cityBlockTime = '2026-08-12T00:07:00.000Z'
  const lateReservation = await app.request('/api/world/sync/70', { method: 'POST', headers: auth, body: '{}' })
  assert.equal(lateReservation.status, 409)
  assert.equal(state.dbCalls.some(call => call.query.includes('INSERT INTO purchases')), false)

  reset()
  state.merchantId = 10
  state.draftListingId = 70
  state.cityMode = 'claimed'
  state.cityBlockTime = '2026-08-12T00:09:01.000Z'
  const latePayment = await app.request('/api/world/sync/70', { method: 'POST', headers: auth, body: '{}' })
  assert.equal(latePayment.status, 409)
  assert.match((await latePayment.json() as { error: string }).error, /payment evidence.*outside.*reservation/i)
})

test('a valid city claim wins a concurrent market withdrawal and draft truth becomes sold', async () => {
  reset()
  state.merchantId = 10
  state.draftListingId = 70
  state.draftState = 'withdrawn'
  state.listingWorldState = 'canceled'
  state.listingWithdrawn = true
  state.listingWithdrawnAt = '2026-08-12T00:06:00.000Z'
  state.checkoutStatus = 'expired'
  state.cityMode = 'claimed'
  state.cityReservedAt = '2026-08-12T00:04:00.000Z'
  state.cityReservedUntil = '2026-08-12T00:09:00.000Z'
  state.cityBlockTime = '2026-08-12T00:05:00.000Z'
  state.cityClaimedAt = '2026-08-12T00:08:00.000Z'
  const response = await app.request('/api/world/sync/70', { method: 'POST', headers: auth, body: '{}' })
  assert.equal(response.status, 200)
  assert.equal(state.listingWorldState, 'sold')
  assert.equal(state.draftState, 'sold')

  const publicDraft = await app.request('/api/world/draft/12')
  assert.equal((await publicDraft.json() as { draft: { status: string } }).draft.status, 'sold')
})

test('a city reservation opened after merchant withdrawal cannot reopen the sale', async () => {
  reset()
  state.merchantId = 10
  state.draftListingId = 70
  state.draftState = 'withdrawn'
  state.listingWorldState = 'canceled'
  state.listingWithdrawn = true
  state.listingWithdrawnReason = 'withdrawn by merchant'
  state.listingWithdrawnAt = '2026-08-12T00:06:00.000Z'
  state.checkoutStatus = 'expired'
  state.cityMode = 'claimed'
  state.cityReservedAt = '2026-08-12T00:07:00.000Z'
  state.cityReservedUntil = '2026-08-12T00:12:00.000Z'
  state.cityBlockTime = '2026-08-12T00:08:00.000Z'
  state.cityClaimedAt = '2026-08-12T00:08:00.000Z'

  const response = await app.request('/api/world/sync/70', { method: 'POST', headers: auth, body: '{}' })
  assert.equal(response.status, 409)
  assert.match((await response.json() as { error: string }).error, /withdrawn before the city reservation/i)
  assert.equal(state.dbCalls.some(call => call.query.includes('INSERT INTO purchases')), false)
})

test('sold world ownership cannot be overwritten by a later merchant withdrawal', async () => {
  reset()
  state.draftListingId = 70
  state.draftState = 'sold'
  state.listingWorldState = 'sold'
  state.merchantId = 7

  const response = await app.request('/api/listing/70/withdraw', { method: 'POST', headers: auth, body: '{}' })
  assert.equal(response.status, 409)
  assert.match((await response.json() as { error: string }).error, /already sold/i)
  assert.equal(state.listingWorldState, 'sold')
  assert.equal(state.listingWithdrawn, false)
})

test('maintainer removal projects a canceled draft so the city can unlock', async () => {
  reset()
  state.draftListingId = 70
  state.listingRemoved = true
  const response = await app.request('/api/world/draft/12')
  assert.equal(response.status, 200)
  assert.equal((await response.json() as { draft: { status: string } }).draft.status, 'canceled')
})

test('sync events name the actual market seller, never the arbitrary sync caller', async () => {
  reset()
  state.merchantId = 10
  state.draftListingId = 70
  state.cityMode = 'claimed'
  const response = await app.request('/api/world/sync/70', { method: 'POST', headers: auth, body: '{}' })
  assert.equal(response.status, 200)
  const atomic = state.dbCalls.find(call => call.query.includes('INSERT INTO purchases'))
  assert.ok(atomic)
  assert.ok(atomic.params.includes('agent-7'))
  assert.equal(atomic.params.includes('agent-10'), false)
})

test('ordinary listing creation cannot smuggle an artifact into the world aisle', async () => {
  reset()
  const response = await app.request('/api/listing', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      title: 'Not city ownership', description: 'ordinary artifact', preview: '', artifact: 'bytes',
      price_usdc: 1, seller_wallet: SELLER, tags: ['world'], aisle: 'world',
    }),
  })
  assert.equal(response.status, 400)
  assert.match((await response.json() as { error: string }).error, /world listings start/i)
  assert.equal(state.rpcCalls, 0)
  assert.equal(state.dbCalls.some(call => call.query.includes('INSERT INTO listings')), false)
})

test('world listing public reads describe city ownership and never advertise a download', async () => {
  reset()
  state.draftListingId = 70
  const response = await app.request('/api/listing/70')
  assert.equal(response.status, 200)
  const payload = await response.json() as { listing: Record<string, unknown>; artifact: string }
  assert.equal(payload.listing.delivery_kind, 'city_ownership')
  assert.equal(payload.listing.requires_city_resident, true)
  assert.equal(payload.listing.city_offer_url, 'https://1f3d9.com/api/world/offer/33')
  assert.equal(payload.listing.world_asset_url, 'https://1f3d9.com/api/world/offer/33')
  assert.match(payload.artifact, /ownership is delivered in the city/i)
  assert.doesNotMatch(payload.artifact, /api\/buy|download/i)
})

test('world receipts replace downloadable artifacts in purchase history', async () => {
  reset()
  state.merchantId = 9
  state.priorReceipt = {
    purchase_id: 81, listing_id: 70, world_checkout_id: 60, amount_usdc: 2,
    tx_hash: TX, world_receipt: {}, created_at: '2026-08-12T00:06:00.000Z',
  }
  const response = await app.request('/api/purchases', { headers: auth })
  assert.equal(response.status, 200)
  const payload = await response.json() as { purchases: Record<string, unknown>[] }
  assert.equal(payload.purchases.length, 1)
  assert.equal(payload.purchases[0]!.delivery_kind, 'city_ownership')
  assert.equal(Object.prototype.hasOwnProperty.call(payload.purchases[0], 'artifact'), false)
  assert.deepEqual(payload.purchases[0]!.world_receipt, { city_offer_id: 33, city_handle: 'new-neighbor' })
})

test('public checkout status expires by time without mutating the public record', async () => {
  reset()
  const active = await app.request('/api/world/checkout/60')
  assert.equal(active.status, 200)
  assert.equal((await active.json() as { checkout: { status: string } }).checkout.status, 'active')

  state.checkoutExpiresAt = '2020-01-01T00:00:00.000Z'
  const expired = await app.request('/api/world/checkout/60')
  const record = (await expired.json() as { checkout: Record<string, unknown> }).checkout
  assert.equal(record.status, 'expired')
  assert.equal(record.city_handle, 'new-neighbor')
  assert.equal(JSON.stringify(record).includes('secret'), false)
})

test('world edits are rejected because the city locked the terms', async () => {
  reset()
  state.draftListingId = 70
  const response = await app.request('/api/listing/70', {
    method: 'PATCH', headers: auth, body: JSON.stringify({ description: 'changed terms' }),
  })
  assert.equal(response.status, 409)
  assert.match((await response.json() as { error: string }).error, /terms are locked in the city/i)
  assert.equal(state.dbCalls.some(call => /UPDATE listings SET\s+description/i.test(call.query)), false)
})

test('city cancellation makes the world listing terminal without a purchase', async () => {
  reset()
  state.merchantId = 10
  state.draftListingId = 70
  state.cityMode = 'canceled'
  const response = await app.request('/api/world/sync/70', { method: 'POST', headers: auth, body: '{}' })
  assert.equal(response.status, 200)
  assert.equal((await response.json() as { status: string }).status, 'canceled')
  assert.equal(state.listingWorldState, 'canceled')
  assert.equal(state.dbCalls.some(call => call.query.includes('INSERT INTO purchases')), false)
  const terminal = state.dbCalls.find(call => call.query.includes('world_canceled'))
  assert.ok(terminal?.params.includes('agent-7'))
  assert.equal(terminal?.params.includes('agent-10'), false)
})

test('MCP exposes and dispatches all four world tools without secret arguments', async () => {
  reset()
  const listed = await app.request('/mcp', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })
  const tools = (await listed.json() as {
    result: { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> }
  }).result.tools
  for (const name of ['draft_world', 'list_world', 'checkout_world', 'sync_world'])
    assert.ok(tools.some(tool => tool.name === name), `${name} is advertised`)
  const worldSchemas = tools.filter(tool => tool.name.includes('world')).map(tool => tool.inputSchema)
  assert.doesNotMatch(JSON.stringify(worldSchemas), /secret|city_origin/i)

  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await app.request('/mcp', {
      method: 'POST', headers: auth,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }),
    })
    return response.json() as Promise<{ result: { content: Array<{ text: string }>; isError: boolean } }>
  }
  const drafted = await call('draft_world', JSON.parse(draftBody()))
  assert.equal(drafted.result.isError, false)
  assert.match(drafted.result.content[0]!.text, /"draft_id":12/)

  reset()
  const listing = await call('list_world', { draft_id: 12, city_offer_id: 33 })
  assert.equal(listing.result.isError, true)
  assert.match(listing.result.content[0]!.text, /world listing costs \$1/i)

  reset()
  state.merchantId = 9
  state.draftListingId = 70
  const checkout = await call('checkout_world', { listing_id: 70, city_handle: 'new-neighbor' })
  assert.equal(checkout.result.isError, false)
  assert.match(checkout.result.content[0]!.text, /"checkout_id":60/)

  reset()
  state.merchantId = 10
  state.draftListingId = 70
  const synced = await call('sync_world', { listing_id: 70 })
  assert.equal(synced.result.isError, false)
  assert.match(synced.result.content[0]!.text, /"status":"active"/)
})

test('the market never reuses even an apparently expired city reservation', async () => {
  reset()
  state.merchantId = 9
  state.draftListingId = 70
  state.cityMode = 'reserved-expired'
  const response = await app.request('/api/world/checkout/70', {
    method: 'POST', headers: auth, body: JSON.stringify({ city_handle: 'new-neighbor' }),
  })
  assert.equal(response.status, 409)
  assert.match((await response.json() as { error: string }).error, /not available/i)
  assert.equal(state.dbCalls.some(call => call.query.includes('INSERT INTO world_checkouts')), false)
})

test('payment_pending remains locked to its city buyer until the city reports claimed', async () => {
  reset()
  state.merchantId = 10
  state.draftListingId = 70
  state.cityMode = 'payment-pending'

  const synced = await app.request('/api/world/sync/70', { method: 'POST', headers: auth, body: '{}' })
  assert.equal(synced.status, 200)
  assert.deepEqual(await synced.json(), { listing_id: 70, status: 'active', city_phase: 'payment_pending' })
  assert.equal(state.checkoutStatus, 'active')
  assert.equal(state.listingWorldState, 'active')
  assert.equal(state.dbCalls.some(call => call.query.includes('INSERT INTO purchases')), false)

  state.merchantId = 11
  state.checkoutCityHandle = 'other-neighbor'
  const another = await app.request('/api/world/checkout/70', {
    method: 'POST', headers: auth, body: JSON.stringify({ city_handle: 'other-neighbor' }),
  })
  assert.equal(another.status, 409)
  assert.match((await another.json() as { error: string }).error, /not available/i)
  assert.equal(state.dbCalls.some(call => call.query.includes('INSERT INTO world_checkouts')), false)
})

test('city market_buyer must match the bound market checkout throughout its bound phases', async () => {
  for (const mode of ['reserved', 'payment-pending', 'payment-invalid', 'claimed'] as const) {
    reset()
    state.merchantId = 10
    state.draftListingId = 70
    state.cityMode = mode
    state.cityMarketBuyer = 'wrong-market-buyer'

    const response = await app.request('/api/world/sync/70', { method: 'POST', headers: auth, body: '{}' })
    assert.equal(response.status, 409)
    assert.match((await response.json() as { error: string }).error, /market buyer.*checkout/i)
    assert.equal(state.listingWorldState, 'active')
    assert.equal(state.dbCalls.some(call => call.query.includes('INSERT INTO purchases')), false)
  }
})

test('payment_invalid closes the market lane without inventing a sale', async () => {
  reset()
  state.merchantId = 10
  state.draftListingId = 70
  state.cityMode = 'payment-invalid'

  const response = await app.request('/api/world/sync/70', { method: 'POST', headers: auth, body: '{}' })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    listing_id: 70,
    status: 'stale',
    city_phase: 'payment_invalid',
    city_unlock_required: true,
    city_cancel_url: 'https://1f3d9.com/api/world/offer/33/cancel',
  })
  assert.equal(state.listingWorldState, 'stale')
  assert.equal(state.checkoutStatus, 'expired')
  assert.equal(state.draftState, 'canceled')
  assert.equal(state.dbCalls.some(call => call.query.includes('INSERT INTO purchases')), false)

  const draft = await app.request('/api/world/draft/12')
  const publicDraft = (await draft.json() as {
    draft: { status: string; listing_id: number; listing_state: string }
  }).draft
  assert.equal(publicDraft.status, 'canceled')
  assert.equal(publicDraft.listing_id, 70)
  assert.equal(publicDraft.listing_state, 'canceled')
  const checkout = await app.request('/api/world/checkout/60')
  assert.equal((await checkout.json() as { checkout: { status: string } }).checkout.status, 'expired')

  const repeated = await app.request('/api/world/sync/70', { method: 'POST', headers: auth, body: '{}' })
  assert.equal(repeated.status, 200)
  assert.equal((await repeated.json() as { status: string }).status, 'stale')
  assert.equal(state.dbCalls.some(call => call.query.includes('INSERT INTO purchases')), false)
})

test('unknown city offer phases fail closed', async () => {
  reset()
  state.merchantId = 10
  state.draftListingId = 70
  state.cityMode = 'unknown-phase'
  const response = await app.request('/api/world/sync/70', { method: 'POST', headers: auth, body: '{}' })
  assert.equal(response.status, 503)
  assert.match((await response.json() as { error: string }).error, /malformed/i)
  assert.equal(state.listingWorldState, 'active')
})

test('city public reads stop streaming once their byte cap is crossed', async () => {
  reset()
  state.cityMode = 'huge-stream'
  const response = await app.request('/api/world/listing', {
    method: 'POST', headers: auth, body: JSON.stringify({ draft_id: 12, city_offer_id: 33 }),
  })
  assert.equal(response.status, 503)
  assert.match((await response.json() as { error: string }).error, /too large/i)
  assert.equal(state.cityStreamCanceled, true)
  // A WHATWG stream may prefetch one queued chunk; the reader must still stop immediately.
  assert.ok(state.cityStreamPulls <= 6, `read ${state.cityStreamPulls} oversized chunks`)
})

test('city cancellation remains canceled on the follow-up listing and draft records', async () => {
  reset()
  state.merchantId = 10
  state.draftListingId = 70
  state.cityMode = 'canceled'
  const synced = await app.request('/api/world/sync/70', { method: 'POST', headers: auth, body: '{}' })
  assert.equal(synced.status, 200)
  state.listingWithdrawnReason = 'city offer canceled'

  const listing = await app.request('/api/listing/70')
  assert.equal((await listing.json() as { listing: { state: string } }).listing.state, 'canceled')
  const draft = await app.request('/api/world/draft/12')
  assert.equal((await draft.json() as { draft: { status: string } }).draft.status, 'canceled')
})

test('maintainer removal atomically cancels the world lane and rejects a later city claim', async () => {
  reset()
  state.merchantId = 1
  state.draftListingId = 70
  const removed = await app.request('/api/mod/remove', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ listing_id: 70, reason: 'unsafe item' }),
  })
  assert.equal(removed.status, 200)
  assert.equal(state.listingRemoved, true)
  assert.equal(state.listingWorldState, 'canceled')
  assert.equal(state.checkoutStatus, 'expired')
  assert.equal(state.draftState, 'canceled')

  const checkout = await app.request('/api/world/checkout/60')
  assert.equal((await checkout.json() as { checkout: { status: string } }).checkout.status, 'expired')

  state.merchantId = 10
  state.cityMode = 'claimed'
  state.cityReservedAt = '2026-08-12T00:04:00.000Z'
  state.cityReservedUntil = '2026-08-12T00:09:00.000Z'
  state.cityBlockTime = '2026-08-12T00:07:00.000Z'
  const sync = await app.request('/api/world/sync/70', { method: 'POST', headers: auth, body: '{}' })
  assert.equal(sync.status, 409)
  assert.match((await sync.json() as { error: string }).error, /removed before the city reservation/i)
  assert.equal(state.dbCalls.some(call => call.query.includes('INSERT INTO purchases')), false)
})

test('a city reservation opened before maintainer removal still settles truthfully', async () => {
  reset()
  state.merchantId = 1
  state.draftListingId = 70
  const removed = await app.request('/api/mod/remove', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ listing_id: 70, reason: 'unsafe item' }),
  })
  assert.equal(removed.status, 200)

  state.merchantId = 10
  state.cityMode = 'claimed'
  state.cityReservedAt = '2026-08-12T00:02:00.000Z'
  state.cityReservedUntil = '2026-08-12T00:07:00.000Z'
  state.cityBlockTime = '2026-08-12T00:06:00.000Z'
  state.cityClaimedAt = '2026-08-12T00:08:00.000Z'
  const sync = await app.request('/api/world/sync/70', { method: 'POST', headers: auth, body: '{}' })
  assert.equal(sync.status, 200)
  assert.equal(state.listingWorldState, 'sold')

  const listing = await app.request('/api/listing/70')
  const listingBody = await listing.json() as { listing: { state: string; title: string } }
  assert.equal(listingBody.listing.state, 'sold')
  assert.equal(listingBody.listing.title, '[removed by the maintainer]')

  const me = await app.request('/api/me', { headers: auth })
  assert.equal((await me.json() as { listings: Array<{ state: string }> }).listings[0]!.state, 'sold')
})

test('maintainer removal after a completed sale preserves sold state', async () => {
  reset()
  state.merchantId = 1
  state.draftListingId = 70
  state.draftState = 'sold'
  state.listingWorldState = 'sold'
  state.checkoutStatus = 'completed'
  const response = await app.request('/api/mod/remove', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ listing_id: 70, reason: 'unsafe item' }),
  })
  assert.equal(response.status, 200)
  assert.equal(state.listingRemoved, true)
  assert.equal(state.listingWorldState, 'sold')
  assert.equal(state.draftState, 'sold')
})

test('/api/me reports truthful world terminal states, including merchant withdrawal', async () => {
  for (const expected of ['sold', 'canceled', 'withdrawn'] as const) {
    reset()
    state.listingWorldState = expected === 'sold' ? 'sold' : 'canceled'
    state.listingWithdrawn = expected !== 'sold'
    state.listingWithdrawnReason = expected === 'withdrawn' ? 'withdrawn by merchant' : 'city offer canceled'
    const response = await app.request('/api/me', { headers: auth })
    assert.equal(response.status, 200)
    const body = await response.json() as { listings: Array<{ state: string }> }
    assert.equal(body.listings[0]!.state, expected)
    const query = state.dbCalls.find(call => call.query.includes('FROM listings WHERE merchant_id'))?.query ?? ''
    assert.match(query, /world_state = 'sold'/)
    assert.match(query, /world_state IN \('canceled','stale'\)/)
    assert.match(query, /withdrawn_reason = 'withdrawn by merchant'/)
  }
})

test('world checkout is explicitly an intent; only the first city reservation wins', async () => {
  reset()
  state.merchantId = 9
  state.draftListingId = 70
  const response = await app.request('/api/world/checkout/70', {
    method: 'POST', headers: auth, body: JSON.stringify({ city_handle: 'new-neighbor' }),
  })
  assert.equal(response.status, 201)
  const body = await response.json() as { note: string }
  assert.match(body.note, /does not reserve the thing/i)
  assert.match(body.note, /first city reservation wins/i)
})
