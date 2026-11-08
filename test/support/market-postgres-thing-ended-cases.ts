import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import type { TestContext } from 'node:test'

import {
  BUYER_SECRET,
  POSTGRES_DATABASE,
  SELLER_WALLET,
  connectedDatabase,
  harnessState,
  resetAndSeed,
  transactionalMigrationDatabase,
  type MarketPostgresApp,
} from './market-postgres-harness.ts'

const OLD_WORLD_STATE_CHECK =
  "CHECK (world_state IS NULL OR world_state IN ('active','sold','canceled','stale'))"

// The city's cancel_world end check, copied from onetapstudiogames/1f3d9 src/world-market.ts
// (lines 1188-1191, 1196-1215 and 1220-1231 at cf6a6f2). A thing_ended offer carries no
// pending payment, so the city uses its plain ended set; C1 adds thing_ended to that set.
const CITY_ENDED_STATES_TODAY = new Set(['withdrawn', 'removed', 'expired', 'canceled', 'sold'])
const CITY_ENDED_STATES_AFTER_C1 = new Set([...CITY_ENDED_STATES_TODAY, 'thing_ended'])

function cityListingEnded(listing: Record<string, unknown>, ended: ReadonlySet<string>): boolean {
  return ended.has(String(listing.state)) && ended.has(String(listing.world_state))
}

function cityDraftEnded(draft: Record<string, unknown>, ended: ReadonlySet<string>): boolean {
  return draft.listing_id != null && typeof draft.listing_state === 'string' && ended.has(draft.listing_state)
}

/** The fields the city reads from the two market answers, with times left out. */
function cityReadFields(listing: Record<string, unknown>, draft: Record<string, unknown>) {
  const pick = (record: Record<string, unknown>, keys: readonly string[]) =>
    Object.fromEntries(keys.map(key => [key, record[key]]))
  return {
    listing: pick(listing, [
      'id', 'delivery_kind', 'world_offer_id', 'world_asset_id', 'world_draft_id',
      'world_seller_handle', 'state', 'world_state', 'withdrawn', 'withdrawn_reason', 'city_status',
    ]),
    draft: pick(draft, [
      'id', 'status', 'delivery_kind', 'world_asset', 'price_usdc', 'seller_wallet',
      'listing_id', 'listing_state',
    ]),
  }
}

function thingEndedOffer(reservedAt: Date | null) {
  return {
    id: 501,
    channel: 'world',
    phase: 'thing_ended',
    asset_type: 'thing',
    asset_id: 77,
    asset_name: 'City compass',
    locked: true,
    seller: 'city-seller',
    buyer: reservedAt ? 'city-buyer' : null,
    market_buyer: reservedAt ? 'buyer-two' : null,
    price_usdc: 2,
    seller_wallet: SELLER_WALLET,
    market_origin: 'https://1f3ea.com',
    market_draft_id: 1,
    market_listing_id: 2,
    market_checkout_id: reservedAt ? 1 : null,
    pending_x402_tx_hash: null,
    pending_x402_at: null,
    reserved_at: reservedAt?.toISOString() ?? null,
    reserved_until: reservedAt ? new Date(reservedAt.getTime() + 5 * 60 * 1000).toISOString() : null,
    created_at: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
    claimed_at: null,
    canceled_at: null,
  }
}

async function laneState() {
  const rows = await connectedDatabase().query(`
    SELECT listing.world_state, listing.withdrawn, listing.withdrawn_reason,
      draft.state AS draft_state, draft.canceled_at, draft.canceled_reason,
      (SELECT array_agg(status ORDER BY id) FROM world_checkouts WHERE listing_id = listing.id)
        AS checkout_statuses,
      (SELECT count(*)::int FROM purchases WHERE listing_id = listing.id) AS purchases,
      (SELECT count(*)::int FROM world_payment_attempts WHERE listing_id = listing.id) AS payment_attempts,
      (SELECT array_agg(jsonb_build_object('actor', actor, 'detail', detail) ORDER BY id) FROM events
        WHERE kind = 'world_canceled') AS cancellation_events
    FROM listings listing JOIN world_drafts draft ON draft.id = listing.world_draft_id
    WHERE listing.id = 2
  `)
  return rows.rows[0] as {
    world_state: string
    withdrawn: boolean
    withdrawn_reason: string | null
    draft_state: string
    canceled_at: Date | null
    canceled_reason: string | null
    checkout_statuses: string[]
    purchases: number
    payment_attempts: number
    cancellation_events: Array<{ actor: string; detail: Record<string, unknown> }> | null
  }
}

function assertEndedLane(lane: Awaited<ReturnType<typeof laneState>>) {
  assert.equal(lane.world_state, 'thing_ended')
  assert.equal(lane.withdrawn, true)
  assert.equal(lane.withdrawn_reason, 'city thing ended')
  assert.equal(lane.draft_state, 'canceled')
  assert.ok(lane.canceled_at instanceof Date)
  assert.equal(lane.canceled_reason, 'city thing ended')
  assert.deepEqual(lane.checkout_statuses, ['expired'])
  assert.equal(lane.purchases, 0)
  assert.equal(lane.payment_attempts, 0)
  assert.deepEqual(lane.cancellation_events, [{
    actor: 'seller-one',
    detail: { listing_id: 2, city_offer_id: 501, reason: 'city thing ended' },
  }])
}

export async function runMarketPostgresThingEndedCases(
  t: TestContext,
  app: MarketPostgresApp,
): Promise<void> {
  const headers = { Authorization: `Bearer ${BUYER_SECRET}`, 'Content-Type': 'application/json' }

  await t.test('the world-thing-ended runner widens the old listing state check and reruns cleanly', async () => {
    await resetAndSeed()
    const client = connectedDatabase()
    const freshDefinition = (await client.query(`
      SELECT pg_get_constraintdef(oid, true) AS definition FROM pg_constraint
      WHERE conrelid = 'listings'::regclass AND conname = 'listings_world_state_allowed'
    `)).rows[0]?.definition as string
    assert.match(freshDefinition, /'thing_ended'::text/)
    await client.query('ALTER TABLE listings DROP CONSTRAINT listings_world_state_allowed')
    await client.query(`ALTER TABLE listings ADD CONSTRAINT listings_world_state_allowed ${OLD_WORLD_STATE_CHECK}`)
    const listingCount = async () =>
      Number((await client.query('SELECT count(*)::int AS n FROM listings')).rows[0]?.n)
    const before = await listingCount()

    await assert.rejects(
      client.query("UPDATE listings SET world_state = 'thing_ended' WHERE id = 2"),
      (error: { code?: string; constraint?: string }) =>
        error.code === '23514' && error.constraint === 'listings_world_state_allowed',
    )

    const {
      executeReleaseMigration,
      missingMigrationPostconditions,
      resolveReleaseMigration,
      PREVIEW_MIGRATION_ACKNOWLEDGEMENT,
    } = await import('../../scripts/release-migrate.ts')
    const previewHost = 'ep-market-preview.us-east-2.aws.neon.tech'
    const productionHost = 'ep-market-production.us-east-2.aws.neon.tech'
    const run = resolveReleaseMigration([
      '--target', 'preview', '--migration', 'world-thing-ended',
      '--database', POSTGRES_DATABASE, '--endpoint', previewHost,
      '--production-endpoint', productionHost,
    ], {
      PREVIEW_DATABASE_URL_UNPOOLED:
        `postgresql://market:private@${previewHost}/${POSTGRES_DATABASE}?sslmode=require`,
      CONFIRM_MARKET_PREVIEW_MIGRATION: PREVIEW_MIGRATION_ACKNOWLEDGEMENT,
    })
    const missing = (query: (text: string, values: readonly unknown[]) => Promise<unknown>) =>
      missingMigrationPostconditions(run.postconditions, query as never)
    const onClient = async (text: string, values: readonly unknown[]) =>
      (await client.query(text, [...values])).rows

    // The name already exists, so only the definition tells the old check from the new one.
    assert.deepEqual(await missing(onClient), ['constraint:listings.listings_world_state_allowed'])
    const session = await client.connect()
    try {
      await session.query('BEGIN')
      await session.query('ALTER TABLE listings DROP CONSTRAINT listings_world_state_allowed')
      await session.query(`ALTER TABLE listings ADD CONSTRAINT listings_world_state_allowed
        CHECK (world_state IS NULL OR world_state IN ('active','sold','canceled','stale','thing_ended')) NOT VALID`)
      assert.deepEqual(
        await missing(async (text, values) => (await session.query(text, [...values])).rows),
        ['constraint:listings.listings_world_state_allowed'],
        'a check that was never validated must not pass',
      )
    } finally {
      await session.query('ROLLBACK').catch(() => undefined)
      session.release()
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      assert.deepEqual(
        await executeReleaseMigration(run, transactionalMigrationDatabase(client)),
        { statementCount: 2, postconditionCount: 1 },
      )
      assert.deepEqual(await missing(onClient), [])
    }

    const migrated = (await client.query(`
      SELECT convalidated, pg_get_constraintdef(oid, true) AS definition FROM pg_constraint
      WHERE conrelid = 'listings'::regclass AND conname = 'listings_world_state_allowed'
    `)).rows[0] as { convalidated: boolean; definition: string }
    assert.equal(migrated.convalidated, true)
    assert.equal(migrated.definition, freshDefinition, 'the migration and db/schema.sql must agree')
    const worldStateChecks = (await client.query(`
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'listings'::regclass AND contype = 'c'
        AND pg_get_constraintdef(oid) LIKE '%world_state%'
      ORDER BY conname
    `)).rows.map(row => row.conname)
    assert.deepEqual(worldStateChecks, ['listings_delivery_channel', 'listings_world_state_allowed'])

    assert.equal(await listingCount(), before)
    assert.equal(
      Number((await client.query(
        "SELECT count(*)::int AS n FROM listings WHERE world_state = 'thing_ended'",
      )).rows[0]?.n),
      0,
    )
    await client.query("UPDATE listings SET world_state = 'thing_ended' WHERE id = 2")
    await assert.rejects(
      client.query("UPDATE listings SET world_state = 'bogus' WHERE id = 2"),
      (error: { code?: string }) => error.code === '23514',
    )
  })

  await t.test('sync writes thing_ended once, and the city reads the market lane as ended', async () => {
    await resetAndSeed()
    harnessState.rpcMethods = []
    // Reserved earlier, then ended: the offer still names a buyer and the old checkout.
    harnessState.cityOffer = thingEndedOffer(new Date(Date.now() - 3 * 60 * 60 * 1000))

    const expected = {
      listing_id: 2,
      status: 'thing_ended',
      city_phase: 'thing_ended',
      city_unlock_required: true,
      city_cancel_url: 'https://1f3d9.com/api/world/offer/501/cancel',
    }
    const sync = async () => {
      const response = await app.request('/api/world/sync/2', { method: 'POST', headers, body: '{}' })
      assert.equal(response.status, 200, await response.clone().text())
      assert.deepEqual(await response.json(), expected)
    }
    await sync()
    const first = await laneState()
    assertEndedLane(first)
    await sync()
    const second = await laneState()
    assertEndedLane(second)
    assert.equal(second.canceled_at?.getTime(), first.canceled_at?.getTime())
    assert.deepEqual(harnessState.rpcMethods, [])

    const listingResponse = await app.request('/api/listing/2')
    assert.equal(listingResponse.status, 200)
    const listing = (await listingResponse.json() as { listing: Record<string, unknown> }).listing
    const draftResponse = await app.request('/api/world/draft/1')
    assert.equal(draftResponse.status, 200)
    const draft = (await draftResponse.json() as { draft: Record<string, unknown> }).draft

    assert.equal(cityDraftEnded(draft, CITY_ENDED_STATES_TODAY), true)
    assert.equal(cityDraftEnded(draft, CITY_ENDED_STATES_AFTER_C1), true)
    assert.equal(cityListingEnded(listing, CITY_ENDED_STATES_AFTER_C1), true)
    assert.equal(cityListingEnded(listing, CITY_ENDED_STATES_TODAY), false,
      'today the city does not yet count thing_ended; C1 adds it')

    const fixture = JSON.parse(await readFile(
      new URL('../fixtures/world-thing-ended-listing.json', import.meta.url), 'utf8',
    )) as unknown
    assert.deepEqual(cityReadFields(listing, draft), fixture)
  })

  await t.test('a checkout attempt on a thing_ended offer writes thing_ended and opens no checkout', async () => {
    await resetAndSeed()
    harnessState.rpcMethods = []
    harnessState.cityOffer = thingEndedOffer(null)
    const response = await app.request('/api/world/checkout/2', {
      method: 'POST', headers, body: JSON.stringify({ city_handle: 'city-buyer' }),
    })
    assert.equal(response.status, 409, await response.clone().text())
    const body = await response.json() as Record<string, unknown>
    assert.equal(body.reason, 'thing_ended')
    assert.match(String(body.error), /^This city thing's end has come, so no new purchase can start\. Read its city record at https:\/\/1f3d9\.com\/api\/world\/offer\/[1-9][0-9]*\.$/u)
    assert.equal('city_claim_url' in body, false)
    assertEndedLane(await laneState())
    assert.deepEqual(harnessState.rpcMethods, [])
  })
}
