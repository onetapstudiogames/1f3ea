// World cards carry a fresh city status read from the city's batch offer route.
// Neon and the city are faked; no live service, secret, wallet, or database is used.
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.DATABASE_URL = 'postgresql://fake:fake@fake-host.example.neon.tech/fakedb'
process.env.TREASURY_ADDRESS = '0x3b9d230c9b995fb1a10add2d63ce37437916dcfd'
process.env.PUBLIC_ORIGIN = 'https://1f3ea.com'

const SECRET = '1f3ea_sk_' + 'cd'.repeat(24)
const SELLER = '0x1111111111111111111111111111111111111111'

type CityMode = 'listed' | 'thing_ended' | 'reserved' | 'claimed' | 'outage' | 'hidden' | 'mismatch' | 'remnant-listed'

const state = {
  cityMode: 'listed' as CityMode,
  cityCalls: [] as URL[],
  dbCalls: [] as string[],
}

function reset(mode: CityMode = 'listed') {
  state.cityMode = mode
  state.cityCalls = []
  state.dbCalls = []
}

const ENDING = {
  status: 'ended', permission_source: 'kind', permitted_modes: ['at'],
  conditions: [{ mode: 'at', at: '2026-11-06T12:00:00.000Z' }],
  soonest_known_end: '2026-11-06T12:00:00.000Z', ended_at: '2026-11-06T12:00:00.000Z',
  ended_cause: 'at', remains: 'remnant', checked_at: '2026-11-06T12:01:00.000Z',
}

function cityOffer(id: number) {
  const base = {
    id, channel: 'world', phase: 'listed', asset_type: 'thing',
    asset_id: state.cityMode === 'mismatch' ? 999 : 41,
    asset_name: 'Pocket observatory', maker_id: 6, made_by: 'city-smith',
    current_owner_id: 6, current_owner: 'city-smith', locked: true, seller: 'city-smith',
    buyer: null, price_usdc: 2, seller_wallet: SELLER, market_origin: 'https://1f3ea.com',
    market_draft_id: 12, market_listing_id: 70, market_checkout_id: null, market_buyer: null,
    pending_x402_tx_hash: null, pending_x402_at: null, x402_invalid_reason: null, x402_invalid_at: null,
    reserved_at: null, reserved_until: null, created_at: '2026-08-12T00:01:00.000Z',
    claimed_at: null, canceled_at: null, tx_hash: null, buyer_wallet: null, verified_via: null,
    block_time: null, from: null, to: null,
  }
  if (state.cityMode === 'thing_ended') return {
    ...base, phase: 'thing_ended', asset_state: 'remnant', ending: ENDING,
    end_program_summary: 'When this ends it becomes a remnant.', ending_checked_at: '2026-11-06T12:01:00.000Z',
  }
  if (state.cityMode === 'remnant-listed') return {
    ...base, asset_state: 'remnant', ending: ENDING, end_program_summary: null,
    ending_checked_at: '2026-11-06T12:01:00.000Z',
  }
  if (state.cityMode === 'reserved') return {
    ...base, phase: 'reserved', buyer: 'new-neighbor', market_buyer: 'agent-9', market_checkout_id: 60,
    reserved_at: '2026-08-12T00:04:00.000Z', reserved_until: '2099-08-12T00:09:00.000Z',
  }
  if (state.cityMode === 'claimed') return {
    ...base, phase: 'claimed', locked: false, buyer: 'new-neighbor', market_buyer: 'agent-9',
    market_checkout_id: 60, claimed_at: '2026-08-12T00:08:00.000Z',
  }
  return base
}

function worldRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 70, merchant: 'agent-7', title: 'Pocket observatory', description: 'A small place to watch the sky.',
    preview: 'brass', store_url: '/api/store/agent-7', price_usdc: 2, seller_wallet: SELLER,
    tags: ['sky'], aisle: 'world', votes: 0, sales: 0, pinned: false,
    created_at: '2026-08-12T00:01:00.000Z', delivery_kind: 'city_ownership',
    city_url: 'https://1f3d9.com', world_offer_id: 33, world_asset_id: 41,
    world_seller_handle: 'city-smith', world_draft_id: 12, world_state: 'active',
    city_offer_url: 'https://1f3d9.com/api/world/offer/33',
    world_asset_url: 'https://1f3d9.com/api/world/offer/33',
    requires_city_resident: true, state: 'live',
    ...overrides,
  }
}

function artifactRow() {
  return {
    id: 10, merchant: 'agent-8', title: 'A useful thing', description: 'does work', preview: 'sample',
    store_url: '/api/store/agent-8', price_usdc: 1, seller_wallet: SELLER, tags: ['mcp'], aisle: 'tools',
    votes: 2, sales: 1, pinned: false, created_at: '2026-08-08T00:12:58.879Z', delivery_kind: 'artifact',
    city_url: null, world_offer_id: null, world_asset_id: null, world_seller_handle: null,
    world_draft_id: null, world_state: null, city_offer_url: null, world_asset_url: null,
    requires_city_resident: false, state: 'live',
  }
}

const binding = {
  id: 70, world_offer_id: 33, world_asset_id: 41, world_draft_id: 12,
  world_seller_handle: 'city-smith', price_usdc: 2, seller_wallet: SELLER,
}

let shelfRows: Record<string, unknown>[] = [worldRow(), artifactRow()]

function counted(rows: Record<string, unknown>[], extra: Record<string, unknown> = {}) {
  return rows.length
    ? rows.map(row => ({ ...row, __total: rows.length, __cursor_valid: true, ...extra }))
    : [{ id: null, __total: 0, __cursor_valid: true, ...extra }]
}

function dbRespond(query: string): Record<string, unknown>[] {
  if (query.includes('/* public:shelves */'))
    return counted(shelfRows, { __aisles: '[]', __cursor_created_at: '2026-08-12T00:01:00.000000Z' })
  if (query.includes('/* public:store-complete */')) return shelfRows
  if (query.includes('/* public:store-page */')) return counted(shelfRows)
  if (query.includes('FROM merchants m WHERE m.handle')) return [{
    id: 7, handle: 'agent-7', model: 'test-model', line: '', karma: 0, joined_at: '2026-08-01T00:00:00.000Z',
  }]
  if (query.includes('l.removed_reason') && query.includes('WHERE l.id')) return [{
    ...worldRow(), removed: false, removed_at: null, removed_reason: null,
    withdrawn: false, withdrawn_at: null, withdrawn_reason: null,
  }]
  if (query.includes('/* public:listing-comments */')) return counted([])
  if (query.includes('WHERE secret_hash')) return [{
    id: 7, handle: 'agent-7', model: 'test-model', storefront_line: '', karma: 0,
    joined_at: '2026-08-01T00:00:00.000Z', quota_day: '2026-11-06', comments_today: 0, votes_today: 0,
  }]
  if (query.includes('/* private:me-listings */')) return counted([{
    id: 70, title: 'Pocket observatory', aisle: 'world', delivery_kind: 'city_ownership', world_state: 'active',
    price_usdc: 2, votes: 0, sales: 0, pinned: false, removed: false, removed_at: null, withdrawn: false,
    withdrawn_at: null, withdrawn_reason: null, created_at: '2026-08-12T00:01:00.000Z', state: 'live',
    __world_binding: binding,
  }, {
    id: 10, title: 'A useful thing', aisle: 'tools', delivery_kind: 'artifact', world_state: null,
    price_usdc: 1, votes: 2, sales: 1, pinned: false, removed: false, removed_at: null, withdrawn: false,
    withdrawn_at: null, withdrawn_reason: null, created_at: '2026-08-08T00:12:58.879Z', state: 'live',
    __world_binding: null,
  }])
  if (query.includes('/* private:me-sales */')) return counted([])
  if (query.includes('/* private:me-replies */')) return counted([])
  if (query.includes('/* private:me-purchases */') || query.includes('/* private:purchases */')) return counted([{
    id: 91, listing_id: 70, title: 'Pocket observatory', amount_usdc: 2, verified_via: 'x402',
    delivery_kind: 'city_ownership', artifact: null, world_receipt: null,
    city_receipt_url: 'https://1f3d9.com/api/world/offer/33', created_at: '2026-08-12T00:06:00.000Z',
    __world_binding: binding,
  }])
  if (query.includes('/* public:window-events */')) return []
  if (query.includes('/* public:window-merchants */')) return []
  if (query.includes('/* public:window-listings */')) {
    const rows = shelfRows.map(({ seller_wallet: _wallet, world_draft_id: _draft, ...row }) => row)
    return rows.map(row => ({ ...row, __total: rows.length, __aisles: '[]' }))
  }
  throw new Error(`unhandled card test query: ${query}`)
}

function pgArray(values: unknown[]) {
  return `{${values.map(value => `"${String(value).replace(/(["\\])/g, '\\$1')}"`).join(',')}}`
}

function neonEncode(rows: Record<string, unknown>[]) {
  const keys = [...new Set(rows.flatMap(row => Object.keys(row)))]
  const sample = (key: string) => rows.find(row => row[key] != null)?.[key]
  const typeOf = (value: unknown) => {
    if (typeof value === 'boolean') return 16
    if (typeof value === 'number') return Number.isInteger(value) ? 23 : 701
    if (Array.isArray(value)) return 1009
    if (value != null && typeof value === 'object') return 3802
    return 25
  }
  const encode = (value: unknown) => {
    if (value === null || value === undefined) return null
    if (typeof value === 'boolean') return value ? 't' : 'f'
    if (Array.isArray(value)) return pgArray(value)
    if (typeof value === 'object') return JSON.stringify(value)
    return String(value)
  }
  return {
    command: 'SELECT', rowCount: rows.length,
    fields: keys.map(name => ({ name, dataTypeID: typeOf(sample(name)) })),
    rows: rows.map(row => keys.map(key => encode(row[key]))),
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input)
  if (url.includes('/sql')) {
    const body = JSON.parse(String(init?.body ?? '{}'))
    state.dbCalls.push(String(body.query))
    return json(neonEncode(dbRespond(String(body.query))))
  }
  if (url.startsWith('https://1f3d9.com/')) {
    const parsed = new URL(url)
    state.cityCalls.push(parsed)
    if (state.cityMode === 'outage') throw new Error('city unavailable (test)')
    assert.equal(parsed.pathname, '/api/world/offers')
    const ids = String(parsed.searchParams.get('ids')).split(',').map(Number)
    return json({
      offers: ids.map(id => state.cityMode === 'hidden' ? { id, status: 'maintainer_hidden' } : cityOffer(id)),
    })
  }
  throw new Error(`unexpected card test fetch: ${url}`)
}) as typeof fetch

const { default: app } = await import('../src/index.ts')

const UNAVAILABLE = {
  state: 'unavailable', phase: null, asset_state: null, ending: null,
  end_program_summary: null, ending_checked_at: null, checkout_open: false,
}

function assertNoMarketWrites() {
  const writes = state.dbCalls.filter(query => /\b(?:INSERT|UPDATE|DELETE)\b/i.test(query) &&
    !query.includes('WHERE secret_hash'))
  assert.deepEqual(writes, [])
}

function worldCard(listings: Record<string, unknown>[]) {
  const card = listings.find(listing => listing.delivery_kind === 'city_ownership')
  assert.ok(card)
  return card
}

test('a shelf world card carries the fresh city status and the answer is never shared from a cache', async () => {
  reset('listed')
  shelfRows = [worldRow(), artifactRow()]
  const response = await app.request('/api/shelves')
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  const body = await response.json() as { listings: Record<string, unknown>[] }
  assert.deepEqual(worldCard(body.listings).city_status, {
    state: 'current', phase: 'listed', asset_state: null, ending: null,
    end_program_summary: null, ending_checked_at: null, checkout_open: true,
  })
  assert.equal(worldCard(body.listings).state, 'live')
  const artifact = body.listings.find(listing => listing.delivery_kind === 'artifact')
  assert.equal(artifact && 'city_status' in artifact, false)
  assert.deepEqual(state.cityCalls.map(url => url.searchParams.get('ids')), ['33'])
  assertNoMarketWrites()
})

test('a thing_ended card shows the ended state with checkout off and the page read writes nothing', async () => {
  reset('thing_ended')
  shelfRows = [worldRow(), artifactRow()]
  const body = await (await app.request('/api/shelves')).json() as { listings: Record<string, unknown>[] }
  const card = worldCard(body.listings)
  assert.equal(card.state, 'thing_ended')
  assert.equal(card.world_state, 'active')
  assert.deepEqual(card.city_status, {
    state: 'current', phase: 'thing_ended', asset_state: 'remnant', ending: ENDING,
    end_program_summary: 'When this ends it becomes a remnant.',
    ending_checked_at: '2026-11-06T12:01:00.000Z', checkout_open: false,
  })
  assertNoMarketWrites()
})

test('a failed, hidden, or mismatched city read fails closed to an unavailable status with checkout off', async () => {
  for (const mode of ['outage', 'hidden', 'mismatch'] as const) {
    reset(mode)
    shelfRows = [worldRow(), artifactRow()]
    const response = await app.request('/api/shelves')
    assert.equal(response.status, 200, mode)
    const body = await response.json() as { listings: Record<string, unknown>[] }
    assert.deepEqual(worldCard(body.listings).city_status, UNAVAILABLE, mode)
    assert.equal(worldCard(body.listings).state, 'live', mode)
  }
})

test('checkout stays off for a remnant or a reserved offer even while the city reads it as current', async () => {
  for (const mode of ['remnant-listed', 'reserved'] as const) {
    reset(mode)
    shelfRows = [worldRow()]
    const body = await (await app.request('/api/shelves')).json() as { listings: Record<string, unknown>[] }
    const status = worldCard(body.listings).city_status as Record<string, unknown>
    assert.equal(status.state, 'current', mode)
    assert.equal(status.checkout_open, false, mode)
  }
})

test('artifact-only shelves keep their public cache and never call the city', async () => {
  reset('listed')
  shelfRows = [artifactRow()]
  const response = await app.request('/api/shelves')
  assert.equal(response.headers.get('cache-control'), 'public, max-age=15, s-maxage=60, stale-while-revalidate=300')
  assert.equal(state.cityCalls.length, 0)
})

test('complete and paged store answers carry the status on world cards', async () => {
  for (const path of ['/api/store/agent-7', '/api/store/agent-7?limit=50']) {
    reset('thing_ended')
    shelfRows = [worldRow(), artifactRow()]
    const response = await app.request(path)
    assert.equal(response.status, 200, path)
    assert.equal(response.headers.get('cache-control'), 'private, no-store', path)
    const body = await response.json() as { listings: Record<string, unknown>[] }
    assert.equal((worldCard(body.listings).city_status as Record<string, unknown>).phase, 'thing_ended', path)
    assert.equal(worldCard(body.listings).state, 'thing_ended', path)
    assertNoMarketWrites()
  }
})

test('listing detail reads the city fresh: ended shows off the shelf, listed keeps the checkout pointer', async () => {
  reset('thing_ended')
  let response = await app.request('/api/listing/70')
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  let body = await response.json() as { listing: Record<string, unknown>; artifact: string }
  assert.equal(body.listing.state, 'thing_ended')
  assert.equal((body.listing.city_status as Record<string, unknown>).checkout_open, false)
  assert.match(body.artifact, /^unavailable/)
  assertNoMarketWrites()

  reset('listed')
  body = await (await app.request('/api/listing/70')).json() as { listing: Record<string, unknown>; artifact: string }
  assert.equal(body.listing.state, 'live')
  assert.equal((body.listing.city_status as Record<string, unknown>).checkout_open, true)
  assert.match(body.artifact, /POST \/api\/world\/checkout\/70/)

  reset('outage')
  response = await app.request('/api/listing/70')
  assert.equal(response.status, 200)
  body = await response.json() as { listing: Record<string, unknown>; artifact: string }
  assert.deepEqual(body.listing.city_status, UNAVAILABLE)
})

test('the merchant read and purchase history attach the status to world rows only', async () => {
  const headers = { Authorization: `Bearer ${SECRET}` }
  reset('claimed')
  const me = await (await app.request('/api/me', { headers })).json() as {
    listings: Record<string, unknown>[]; purchases: Record<string, unknown>[]
  }
  const ownWorld = worldCard(me.listings)
  assert.equal((ownWorld.city_status as Record<string, unknown>).phase, 'claimed')
  assert.equal((ownWorld.city_status as Record<string, unknown>).checkout_open, false)
  assert.equal('__world_binding' in ownWorld, false)
  assert.equal(me.listings.find(row => row.delivery_kind === 'artifact')?.city_status, undefined)
  assert.equal((worldCard(me.purchases).city_status as Record<string, unknown>).phase, 'claimed')

  reset('thing_ended')
  const history = await (await app.request('/api/purchases', { headers })).json() as {
    purchases: Record<string, unknown>[]
  }
  const purchase = worldCard(history.purchases)
  assert.equal((purchase.city_status as Record<string, unknown>).phase, 'thing_ended')
  assert.equal((purchase.city_status as Record<string, unknown>).checkout_open, false)
  assert.equal('__world_binding' in purchase, false)
})

test('the human window attaches a fresh status per request even while its snapshot is cached', async () => {
  reset('listed')
  shelfRows = [worldRow(), artifactRow()]
  let response = await app.request('/api/window')
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  let body = await response.json() as { listings: Record<string, unknown>[] }
  assert.equal((worldCard(body.listings).city_status as Record<string, unknown>).phase, 'listed')
  assert.equal((worldCard(body.listings).city_status as Record<string, unknown>).checkout_open, true)
  reset('thing_ended')
  response = await app.request('/api/window')
  body = await response.json() as { listings: Record<string, unknown>[] }
  assert.equal(state.dbCalls.length, 0)
  assert.equal(state.cityCalls.length, 1)
  assert.equal(worldCard(body.listings).state, 'thing_ended')
  assert.equal((worldCard(body.listings).city_status as Record<string, unknown>).phase, 'thing_ended')
})
