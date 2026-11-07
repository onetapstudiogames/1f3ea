import test from 'node:test'
import assert from 'node:assert/strict'

process.env.TREASURY_ADDRESS = '0x3b9d230c9b995fb1a10add2d63ce37437916dcfd'
const {
  CITY_ORIGIN,
  CITY_OFFER_BATCH_MAX,
  cityOfferMatchesDraft,
  cityOfferMatchesListing,
  fetchCityOffers,
  isCityOfferAvailable,
  validWorldActivation,
  validWorldCheckout,
  validWorldDraft,
} = await import('../src/world.ts')

const SELLER = '0x1111111111111111111111111111111111111111'

const draft = {
  id: 12,
  thing_id: 41,
  price_usdc: 2,
  seller_wallet: SELLER,
}

const offer = {
  id: 33,
  channel: 'world',
  phase: 'listed',
  asset_type: 'thing',
  asset_id: 41,
  asset_name: 'Pocket observatory',
  locked: true,
  seller: 'city-smith',
  buyer: null,
  market_buyer: null,
  price_usdc: 2,
  seller_wallet: SELLER,
  market_origin: 'https://1f3ea.com',
  market_draft_id: 12,
  market_listing_id: null,
  market_checkout_id: null,
  reserved_at: null,
  reserved_until: null,
  created_at: '2026-08-12T00:00:00.000Z',
  claimed_at: null,
  canceled_at: null,
  pending_x402_tx_hash: null,
  pending_x402_at: null,
}

test('the city origin is fixed and world drafts accept only exact listing terms', () => {
  assert.equal(CITY_ORIGIN, 'https://1f3d9.com')
  assert.deepEqual(validWorldDraft({
    title: 'Pocket observatory',
    description: 'A small place to watch the sky.',
    preview: 'brass and patient glass',
    price_usdc: 2,
    seller_wallet: SELLER,
    tags: ['Sky', 'sky', 'tool'],
    thing_id: 41,
  }), {
    title: 'Pocket observatory',
    description: 'A small place to watch the sky.',
    preview: 'brass and patient glass',
    price_usdc: 2,
    seller_wallet: SELLER,
    tags: ['sky', 'tool'],
    thing_id: 41,
  })

  assert.match(String(validWorldDraft({
    title: 'Pocket observatory', description: 'Useful', preview: '', price_usdc: 0,
    seller_wallet: SELLER, tags: [], thing_id: 41,
  })), /greater than 0/i)
  assert.match(String(validWorldDraft({
    title: 'Pocket observatory', description: 'Useful', preview: '', price_usdc: 2,
    seller_wallet: SELLER, tags: [], thing_id: 41, artifact: 'must never be accepted',
  })), /exactly/i)
  assert.match(String(validWorldDraft({
    title: 'Pocket observatory', description: 'Useful', preview: '', price_usdc: 2,
    seller_wallet: SELLER, tags: [], thing_id: 0,
  })), /thing_id/i)
})

test('world activation and checkout bodies reject hidden or ambiguous fields', () => {
  assert.deepEqual(validWorldActivation({ draft_id: 12, city_offer_id: 33 }), {
    draft_id: 12, city_offer_id: 33, fee_tx_hash: undefined,
  })
  assert.match(String(validWorldActivation({ draft_id: 12, city_offer_id: 33, city_origin: 'https://evil.example' })), /exactly/i)
  assert.match(String(validWorldActivation({ draft_id: -1, city_offer_id: 33 })), /draft_id/i)

  assert.deepEqual(validWorldCheckout({ city_handle: 'New-Neighbor' }), { city_handle: 'new-neighbor' })
  assert.match(String(validWorldCheckout({ city_handle: 'new-neighbor', wallet: SELLER })), /exactly/i)
})

test('a city offer must prove the exact pending draft before a shelf listing exists', () => {
  assert.equal(cityOfferMatchesDraft(offer, draft, 33, 'https://1f3ea.com'), null)
  assert.match(cityOfferMatchesDraft({ ...offer, market_buyer: undefined }, draft, 33, 'https://1f3ea.com') ?? '', /malformed/i)
  assert.match(cityOfferMatchesDraft({ ...offer, locked: false }, draft, 33, 'https://1f3ea.com') ?? '', /locked/i)
  assert.match(cityOfferMatchesDraft({ ...offer, asset_id: 42 }, draft, 33, 'https://1f3ea.com') ?? '', /thing/i)
  assert.match(cityOfferMatchesDraft({ ...offer, seller_wallet: '0x2222222222222222222222222222222222222222' }, draft, 33, 'https://1f3ea.com') ?? '', /wallet/i)
  assert.match(cityOfferMatchesDraft({ ...offer, market_origin: 'https://evil.example' }, draft, 33, 'https://1f3ea.com') ?? '', /market origin/i)
  assert.match(cityOfferMatchesDraft({ ...offer, market_listing_id: 99 }, draft, 33, 'https://1f3ea.com') ?? '', /unbound/i)
})

test('checkout accepts only an explicitly listed city offer; the market never reopens reservations', () => {
  const listing = {
    id: 70,
    world_offer_id: 33,
    world_asset_id: 41,
    world_draft_id: 12,
    world_seller_handle: 'city-smith',
    price_usdc: 2,
    seller_wallet: SELLER,
  }
  assert.equal(cityOfferMatchesListing({ ...offer, market_listing_id: 70 }, listing, 'https://1f3ea.com'), null)
  assert.equal(isCityOfferAvailable({ ...offer, market_listing_id: 70 }, new Date('2026-08-12T00:05:00Z')), true)
  assert.equal(isCityOfferAvailable({
    ...offer,
    phase: 'reserved',
    market_listing_id: 70,
    reserved_until: '2026-08-12T00:04:59Z',
  }, new Date('2026-08-12T00:05:00Z')), false)
  assert.equal(isCityOfferAvailable({
    ...offer,
    phase: 'reserved',
    market_listing_id: 70,
    reserved_until: '2026-08-12T00:05:01Z',
  }, new Date('2026-08-12T00:05:00Z')), false)
  assert.equal(isCityOfferAvailable({
    ...offer,
    market_listing_id: 70,
    market_checkout_id: 59,
  }, new Date('2026-08-12T00:05:00Z')), false)
  assert.equal(isCityOfferAvailable({
    ...offer,
    phase: 'payment_pending',
    market_listing_id: 70,
    market_checkout_id: 60,
    buyer: 'new-neighbor',
    reserved_at: '2026-08-12T00:04:00Z',
    reserved_until: '2026-08-12T00:09:00Z',
  }, new Date('2026-08-12T00:05:00Z')), false)
  assert.match(cityOfferMatchesListing({ ...offer, market_listing_id: 71 }, listing, 'https://1f3ea.com') ?? '', /listing/i)
})

test('terminal city payment outcomes require their locked checkout evidence', () => {
  const listing = {
    id: 70,
    world_offer_id: 33,
    world_asset_id: 41,
    world_draft_id: 12,
    world_seller_handle: 'city-smith',
    price_usdc: 2,
    seller_wallet: SELLER,
  }
  const boundOffer = {
    ...offer,
    buyer: 'new-neighbor',
    market_buyer: 'market-buyer',
    market_listing_id: 70,
    market_checkout_id: 60,
    reserved_at: '2026-08-12T00:04:00Z',
    reserved_until: '2026-08-12T00:09:00Z',
    pending_x402_tx_hash: `0x${'a'.repeat(64)}`,
    pending_x402_at: '2026-08-12T00:05:00Z',
  }

  for (const phase of ['payment_expired', 'founder_review'] as const) {
    const terminalOffer = { ...boundOffer, phase }
    assert.equal(cityOfferMatchesListing(terminalOffer, listing, 'https://1f3ea.com'), null)
    assert.equal(isCityOfferAvailable(terminalOffer), false)
    assert.match(cityOfferMatchesListing({
      ...terminalOffer, pending_x402_tx_hash: null,
    }, listing, 'https://1f3ea.com') ?? '', /malformed/i)
    assert.match(cityOfferMatchesListing({
      ...terminalOffer, pending_x402_at: null,
    }, listing, 'https://1f3ea.com') ?? '', /malformed/i)
    assert.match(cityOfferMatchesListing({
      ...terminalOffer, locked: false,
    }, listing, 'https://1f3ea.com') ?? '', /malformed/i)
  }
})

// The city's thing-endings release adds the thing_ended phase and four offer
// fields (city-ops things-ending tasks, section 0). Today's city sends none of
// them, so both shapes must parse.
const endingFields = {
  asset_state: 'remnant',
  ending: {
    status: 'ended', permission_source: 'kind', permitted_modes: ['at'],
    conditions: [{ mode: 'at', at: '2026-11-06T12:00:00.000Z' }],
    soonest_known_end: '2026-11-06T12:00:00.000Z', ended_at: '2026-11-06T12:00:00.000Z',
    ended_cause: 'at', remains: 'remnant', checked_at: '2026-11-06T12:01:00.000Z',
  },
  end_program_summary: 'When this ends it becomes a remnant.',
  ending_checked_at: '2026-11-06T12:01:00.000Z',
}
const contractListing = {
  id: 70,
  world_offer_id: 33,
  world_asset_id: 41,
  world_draft_id: 12,
  world_seller_handle: 'city-smith',
  price_usdc: 2,
  seller_wallet: SELLER,
}

test('a thing_ended offer and the four ending fields parse, and nothing about them reopens checkout', () => {
  const ended = { ...offer, phase: 'thing_ended', market_listing_id: 70, ...endingFields }
  assert.equal(cityOfferMatchesListing(ended, contractListing, 'https://1f3ea.com'), null)
  assert.equal(isCityOfferAvailable(ended), false)
  assert.equal(cityOfferMatchesListing({
    ...offer, ...endingFields, asset_state: 'active', ending: null,
    end_program_summary: null, ending_checked_at: null,
  }, contractListing, 'https://1f3ea.com'), null)
  assert.equal(isCityOfferAvailable({ ...offer, ...endingFields, asset_state: 'active' }), true)
  assert.equal(isCityOfferAvailable({ ...offer, ...endingFields }), false)
  assert.equal(isCityOfferAvailable({ ...offer, ...endingFields, asset_state: 'withdrawn' }), false)
  assert.equal(cityOfferMatchesListing(offer, contractListing, 'https://1f3ea.com'), null)
})

test('the ending fields are type checked when present and thing_ended carries no payment evidence', () => {
  const malformed = (value: Record<string, unknown>) =>
    assert.match(cityOfferMatchesListing(value, contractListing, 'https://1f3ea.com') ?? '', /malformed/i)
  malformed({ ...offer, asset_state: 'gone' })
  malformed({ ...offer, asset_state: null })
  malformed({ ...offer, ending: 'ended' })
  malformed({ ...offer, ending: ['ended'] })
  malformed({ ...offer, end_program_summary: 7 })
  malformed({ ...offer, ending_checked_at: 'not a date' })
  malformed({
    ...offer, phase: 'thing_ended', pending_x402_tx_hash: `0x${'a'.repeat(64)}`,
    pending_x402_at: '2026-08-12T00:05:00Z', locked: true,
  })
  malformed({ ...offer, phase: 'ended' })
})

async function withCityFetch<T>(
  answer: (url: URL) => Response,
  run: (calls: URL[]) => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch
  const calls: URL[] = []
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input))
    calls.push(url)
    return answer(url)
  }) as typeof fetch
  try {
    return await run(calls)
  } finally {
    globalThis.fetch = original
  }
}

const batchJson = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const requestedIds = (url: URL) => (url.searchParams.get('ids') ?? '').split(',').map(Number)

test('the batch read asks the city once per page of at most 50 distinct ids and keys each answer by id', async () => {
  assert.equal(CITY_OFFER_BATCH_MAX, 50)
  const ids = [...Array.from({ length: 120 }, (_, index) => index + 1), 3, 7]
  await withCityFetch(url => {
    assert.equal(url.origin + url.pathname, 'https://1f3d9.com/api/world/offers')
    return batchJson({
      offers: requestedIds(url).map(id => id === 2 ? { id, status: 'maintainer_hidden' }
        : id === 4 ? { id, status: 'not_found' }
          : { ...offer, id, phase: id === 5 ? 'thing_ended' : 'listed', ...(id === 5 ? endingFields : {}) }),
    })
  }, async calls => {
    const results = await fetchCityOffers(ids)
    assert.deepEqual(calls.map(call => requestedIds(call).length), [50, 50, 20])
    assert.equal(results.size, 120)
    const first = results.get(1)
    assert.ok(first?.ok)
    assert.equal(first.value.phase, 'listed')
    const ended = results.get(5)
    assert.ok(ended?.ok)
    assert.equal(ended.value.phase, 'thing_ended')
    assert.equal(ended.value.asset_state, 'remnant')
    assert.deepEqual(ended.value.ending, endingFields.ending)
    assert.deepEqual(results.get(2), { ok: false, kind: 'not_found', message: 'city offer is not public' })
    assert.deepEqual(results.get(4), { ok: false, kind: 'not_found', message: 'city record not found' })
  })
  await withCityFetch(() => { throw new Error('no call expected') }, async calls => {
    assert.equal((await fetchCityOffers([])).size, 0)
    assert.equal(calls.length, 0)
  })
})

test('a failed, malformed, or mismatched batch answer leaves every id on that page without a status', async () => {
  const answers: Array<[string, (url: URL) => Response]> = [
    ['outage', () => batchJson({ error: 'down' }, 503)],
    ['wrong order', url => batchJson({ offers: requestedIds(url).reverse().map(id => ({ ...offer, id })) })],
    ['missing entry', url => batchJson({ offers: requestedIds(url).slice(1).map(id => ({ ...offer, id })) })],
    ['not a list', () => batchJson({ offers: { 1: offer } })],
    ['bad status', url => batchJson({ offers: requestedIds(url).map(id => ({ id, status: 'gone' })) })],
  ]
  for (const [name, answer] of answers) {
    await withCityFetch(answer, async () => {
      const results = await fetchCityOffers([1, 2])
      assert.equal(results.size, 2, name)
      for (const result of results.values()) assert.equal(result.ok, false, name)
    })
  }
  await withCityFetch(url => batchJson({
    offers: requestedIds(url).map(id => id === 2 ? { ...offer, id, phase: 'ended' } : { ...offer, id }),
  }), async () => {
    const results = await fetchCityOffers([1, 2])
    assert.equal(results.get(1)?.ok, true)
    assert.deepEqual(results.get(2), { ok: false, kind: 'invalid', message: 'city returned a malformed offer record' })
  })
})

test('a page too large for one city read is split in halves until each part fits', async () => {
  const sizes: number[] = []
  await withCityFetch(url => {
    const ids = requestedIds(url)
    sizes.push(ids.length)
    const padding = ids.length > 13 ? 'x'.repeat(6_000) : ''
    return batchJson({ offers: ids.map(id => ({ ...offer, id, asset_name: `thing${padding}` })) })
  }, async () => {
    const results = await fetchCityOffers(Array.from({ length: 50 }, (_, index) => index + 1))
    assert.equal(results.size, 50)
    assert.equal([...results.values()].every(result => result.ok), true)
  })
  assert.deepEqual(sizes, [50, 25, 12, 13, 25, 12, 13])
})
