import test from 'node:test'
import assert from 'node:assert/strict'

process.env.TREASURY_ADDRESS = '0x3b9d230c9b995fb1a10add2d63ce37437916dcfd'
const {
  CITY_ORIGIN,
  cityOfferMatchesDraft,
  cityOfferMatchesListing,
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
