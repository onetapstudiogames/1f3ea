import test from 'node:test'
import assert from 'node:assert/strict'

import { runMarketPostgresFinalityCases } from '../support/market-postgres-finality-cases.ts'
import {
  BUYER_SECRET,
  BUYER_WALLET,
  SELLER_WALLET,
  connectedDatabase,
  harnessState,
  preparePendingWorldListingDraft,
  resetAndSeed,
  startMarketPostgresHarness,
} from '../support/market-postgres-harness.ts'
import { runMarketPostgresMigrationCases } from '../support/market-postgres-migration-cases.ts'
import { runMarketPostgresX402ResultCases } from '../support/market-postgres-x402-result-cases.ts'

test('real PostgreSQL prepares every public read and the direct purchase timing sentinel', async t => {
  const app = await startMarketPostgresHarness(t)
  await runMarketPostgresMigrationCases(t, app)
  await runMarketPostgresFinalityCases(t, app)
  await runMarketPostgresX402ResultCases(t, app)

  const availableOffer = {
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
    seller_wallet: SELLER_WALLET,
    market_origin: 'https://1f3ea.com',
    market_draft_id: 1,
    market_listing_id: 2,
    market_checkout_id: null,
    pending_x402_tx_hash: null,
    pending_x402_at: null,
    reserved_at: null,
    reserved_until: null,
    created_at: new Date().toISOString(),
    claimed_at: null,
    canceled_at: null,
  }
  const headers = {
    Authorization: `Bearer ${BUYER_SECRET}`,
    'Content-Type': 'application/json',
  }
  const draftBody = JSON.stringify({
    title: 'Fresh city compass',
    description: 'A new public promise for a city-owned thing.',
    preview: 'A careful compass.',
    price_usdc: 2,
    seller_wallet: BUYER_WALLET,
    tags: ['world'],
    thing_id: 78,
  })

  await t.test('an expired world draft does not block a new draft for the same seller', async () => {
    await resetAndSeed()
    const expiresAt = new Date(Date.now() - 60_000)
    await preparePendingWorldListingDraft(
      new Date(expiresAt.getTime() - 3_600_000),
      expiresAt,
    )

    const created = await app.request('/api/world/draft', {
      method: 'POST', headers, body: draftBody,
    })
    assert.equal(created.status, 201, await created.clone().text())
    const body = await created.json() as { draft_id: number }
    assert.notEqual(body.draft_id, 1)

    const oldDraft = await connectedDatabase().query<{ state: string }>(
      'SELECT state FROM world_drafts WHERE id = 1',
    )
    assert.equal(oldDraft.rows[0]?.state, 'expired')
  })

  await t.test('an unexpired world draft still blocks a new draft for the same seller', async () => {
    await resetAndSeed()
    const createdAt = new Date()
    await preparePendingWorldListingDraft(
      createdAt,
      new Date(createdAt.getTime() + 3_600_000),
    )

    const conflict = await app.request('/api/world/draft', {
      method: 'POST', headers, body: draftBody,
    })
    assert.equal(conflict.status, 409, await conflict.clone().text())
    assert.deepEqual(await conflict.json(), {
      error: 'you already have a live pending draft; activate it, cancel it, or wait for expiry',
    })
  })

  await t.test('an expired world checkout does not block a new checkout for the same buyer', async () => {
    await resetAndSeed()
    harnessState.cityOffer = availableOffer
    await connectedDatabase().query(`
      UPDATE world_checkouts
      SET created_at = now() - interval '11 minutes', expires_at = now() - interval '1 minute'
      WHERE id = 1
    `)

    const created = await app.request('/api/world/checkout/2', {
      method: 'POST', headers, body: JSON.stringify({ city_handle: 'city-buyer' }),
    })
    assert.equal(created.status, 201, await created.clone().text())
    const body = await created.json() as { checkout_id: number }
    assert.notEqual(body.checkout_id, 1)

    const oldCheckout = await connectedDatabase().query<{ status: string }>(
      'SELECT status FROM world_checkouts WHERE id = 1',
    )
    assert.equal(oldCheckout.rows[0]?.status, 'expired')
    const publicCheckout = await app.request('/api/world/checkout/1')
    assert.equal(publicCheckout.status, 200)
    assert.equal(
      ((await publicCheckout.json()) as { checkout: { status: string } }).checkout.status,
      'expired',
    )
  })

  await t.test('an unexpired world checkout still blocks a new checkout for the same buyer', async () => {
    await resetAndSeed()
    harnessState.cityOffer = availableOffer

    const conflict = await app.request('/api/world/checkout/2', {
      method: 'POST', headers, body: JSON.stringify({ city_handle: 'city-buyer' }),
    })
    assert.equal(conflict.status, 409, await conflict.clone().text())
    assert.deepEqual(await conflict.json(), {
      error: 'you already have an active checkout for this listing; wait for its ten-minute expiry',
    })
  })
})
