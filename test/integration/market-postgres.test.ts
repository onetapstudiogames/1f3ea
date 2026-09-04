import test from 'node:test'
import assert from 'node:assert/strict'

import { runMarketPostgresFinalityCases } from '../support/market-postgres-finality-cases.ts'
import {
  BUYER_SECRET,
  BUYER_WALLET,
  SELLER_WALLET,
  connectedDatabase,
  harnessState,
  resetAndSeed,
  preparePendingWorldListingDraft,
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

  await t.test('an active listing keeps its older-than-an-hour public draft usable by the city', async () => {
    await resetAndSeed()
    await connectedDatabase().query(`
      UPDATE world_drafts
      SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
      WHERE id = 1
    `)

    const response = await app.request('/api/world/draft/1')
    assert.equal(response.status, 200)
    const { draft } = await response.json() as {
      draft: { status: string; listing_state: string; expires_at?: string }
    }
    assert.equal(draft.status, 'active')
    assert.equal(draft.listing_state, 'active')
    assert.ok(draft.expires_at)
    assert.equal(!draft.expires_at || new Date(draft.expires_at).getTime() > Date.now(), true)
  })

  await t.test('canceling a pending draft permits a second draft', async () => {
    await resetAndSeed()
    const now = Date.now()
    await preparePendingWorldListingDraft(new Date(now), new Date(now + 3_600_000))

    const canceled = await app.request('/api/world/draft/1/cancel', { method: 'POST', headers })
    assert.equal(canceled.status, 200, await canceled.clone().text())
    assert.deepEqual(await canceled.json(), { draft_id: 1, status: 'canceled' })

    const repeated = await app.request('/api/world/draft/1/cancel', { method: 'POST', headers })
    assert.equal(repeated.status, 409, await repeated.clone().text())
    assert.deepEqual(await repeated.json(), { error: 'world draft is not pending' })

    const created = await app.request('/api/world/draft', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        title: 'Second city thing', description: 'A replacement pending draft.', preview: '',
        price_usdc: 3, seller_wallet: BUYER_WALLET, tags: ['world'], thing_id: 78,
      }),
    })
    assert.equal(created.status, 201, await created.clone().text())
  })

  await t.test('canceling an activated draft is refused', async () => {
    await resetAndSeed()
    await connectedDatabase().query('UPDATE world_drafts SET merchant_id = 2 WHERE id = 1')

    const response = await app.request('/api/world/draft/1/cancel', { method: 'POST', headers })
    assert.equal(response.status, 409, await response.clone().text())
    assert.deepEqual(await response.json(), { error: 'world draft is already activated' })
  })

  await t.test('PostgreSQL refuses cancellation after the public draft hour lapses', async () => {
    await resetAndSeed()
    const now = Date.now()
    await preparePendingWorldListingDraft(new Date(now - 3_600_001), new Date(now - 1))

    const before = await app.request('/api/world/draft/1')
    assert.equal((await before.json() as { draft: { status: string } }).draft.status, 'expired')

    const response = await app.request('/api/world/draft/1/cancel', { method: 'POST', headers })
    assert.equal(response.status, 409, await response.clone().text())
    assert.deepEqual(await response.json(), { error: 'world draft is not pending' })
    const durable = await connectedDatabase().query<{ state: string }>(
      'SELECT state FROM world_drafts WHERE id = 1',
    )
    assert.equal(durable.rows[0]?.state, 'pending')
    const after = await app.request('/api/world/draft/1')
    assert.equal((await after.json() as { draft: { status: string } }).draft.status, 'expired')
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
