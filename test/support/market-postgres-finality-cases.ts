import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import type { TestContext } from 'node:test'

import {
  BUYER_SECRET,
  BUYER_WALLET,
  PAYER_SIGNATURE,
  RECEIPT_BLOCK_HASH,
  SELLER_WALLET,
  TREASURY,
  TX_HASH,
  USDC,
  connectedDatabase,
  harnessState,
  preparePendingWorldListingDraft,
  resetAndSeed,
  sha256,
  x402PaymentHeader,
  type MarketPostgresApp,
} from './market-postgres-harness.ts'

export async function runMarketPostgresFinalityCases(
  t: TestContext,
  app: MarketPostgresApp,
): Promise<void> {
  await t.test(
    'ordinary trades remain finalized wallet-to-wallet USDC from buyer to seller',
    async () => {
      await resetAndSeed()
      harnessState.rpcMethods = []
      const headers = {
        Authorization: `Bearer ${BUYER_SECRET}`,
        'Content-Type': 'application/json',
      }
      const opened = await app.request('/api/purchase-intent/1', {
        method: 'POST', headers, body: JSON.stringify({ payer_wallet: BUYER_WALLET }),
      })
      assert.equal(opened.status, 201)
      const intent = (await opened.json() as {
        purchase_intent: { id: number; created_at: string; expires_at: string }
      }).purchase_intent
      const originalCreatedAt = Date.parse(intent.created_at)
      const originalExpiresAt = Date.parse(intent.expires_at)
      assert.equal(originalExpiresAt - originalCreatedAt, 10 * 60 * 1000)
      const createdAt = Math.floor(Date.now() / 1000) * 1000
      const expiresAt = createdAt + 3_000
      await connectedDatabase().query(`
        UPDATE direct_purchase_intents
        SET created_at = $1, expires_at = $2
        WHERE id = $3
      `, [new Date(createdAt), new Date(expiresAt), intent.id])
      harnessState.chain = {
        transferBlockTime: new Date(Math.ceil(createdAt / 1000) * 1000),
        finalityArrivesAt: new Date(expiresAt + 100),
        amountUnits: 1_500_000n,
        fromWallet: BUYER_WALLET,
        toWallet: SELLER_WALLET,
      }
      assert.ok(harnessState.chain.transferBlockTime.getTime() >= createdAt)
      assert.ok(harnessState.chain.transferBlockTime.getTime() <= expiresAt)

      const claimRequest = {
        method: 'POST', headers,
        body: JSON.stringify({
          intent_id: intent.id,
          tx_hash: TX_HASH,
          payer_signature: PAYER_SIGNATURE,
        }),
      }
      const waiting = await app.request('/api/claim/1', claimRequest)
      assert.equal(waiting.status, 202, await waiting.clone().text())
      assert.equal((await waiting.json() as { do_not_pay_again: boolean }).do_not_pay_again, true)

      while (true) {
        const clock = await connectedDatabase().query<{ now: Date }>('SELECT clock_timestamp() AS now')
        if ((clock.rows[0]?.now.getTime() ?? 0) > expiresAt) break
        await delay(50)
      }
      harnessState.chain = { ...harnessState.chain, finalityArrivesAt: new Date(Date.now() - 1) }
      const claimed = await app.request('/api/claim/1', claimRequest)
      const claimedBody = await claimed.json() as { artifact?: string; error?: string }
      assert.equal(claimed.status, 200, claimedBody.error)
      assert.equal(claimedBody.artifact, 'the delivered artifact')
      assert.equal(harnessState.rpcMethods.includes('eth_getBlockByNumber'), true)

      const purchase = await connectedDatabase().query<{
        verified_via: string
        direct_purchase_intent_id: number
        claimed_at: Date | null
      }>(`
        SELECT p.verified_via, p.direct_purchase_intent_id, i.claimed_at
        FROM purchases p
        JOIN direct_purchase_intents i ON i.id = p.direct_purchase_intent_id
        WHERE lower(p.tx_hash) = lower($1)
      `, [TX_HASH])
      assert.equal(purchase.rowCount, 1)
      assert.equal(purchase.rows[0]?.verified_via, 'claim')
      assert.equal(purchase.rows[0]?.direct_purchase_intent_id, intent.id)
      assert.ok(purchase.rows[0]?.claimed_at instanceof Date)
    },
  )

  await t.test(
    'world payment finality may arrive after its real PostgreSQL reservation window',
    async () => {
      await resetAndSeed()
      harnessState.rpcMethods = []
      const startTime = new Date(Math.floor(Date.now() / 1000) * 1000)
      const endTime = new Date(startTime.getTime() + 3_000)
      const blockTime = startTime
      await connectedDatabase().query(`
        UPDATE world_checkouts
        SET created_at = $1, expires_at = $2, status = 'active', completed_at = NULL
        WHERE id = 1
      `, [startTime, endTime])
      harnessState.cityOffer = {
        id: 501,
        channel: 'world',
        phase: 'claimed',
        asset_type: 'thing',
        asset_id: 77,
        asset_name: 'City compass',
        locked: false,
        seller: 'city-seller',
        buyer: 'city-buyer',
        market_buyer: 'buyer-two',
        price_usdc: 2,
        seller_wallet: SELLER_WALLET,
        market_origin: 'https://1f3ea.com',
        market_draft_id: 1,
        market_listing_id: 2,
        market_checkout_id: 1,
        pending_x402_tx_hash: null,
        pending_x402_at: null,
        reserved_at: startTime.toISOString(),
        reserved_until: endTime.toISOString(),
        created_at: new Date(startTime.getTime() - 1_000).toISOString(),
        claimed_at: new Date(startTime.getTime() + 1_000).toISOString(),
        canceled_at: null,
        tx_hash: TX_HASH,
        buyer_wallet: BUYER_WALLET,
        verified_via: 'x402',
        block_time: blockTime.toISOString(),
        from: BUYER_WALLET,
        to: SELLER_WALLET,
      }
      harnessState.chain = {
        transferBlockTime: blockTime,
        finalityArrivesAt: new Date(endTime.getTime() + 100),
        amountUnits: 2_000_000n,
        fromWallet: BUYER_WALLET,
        toWallet: SELLER_WALLET,
      }
      const headers = { Authorization: `Bearer ${BUYER_SECRET}`, 'Content-Type': 'application/json' }

      const waiting = await app.request('/api/world/sync/2', {
        method: 'POST', headers, body: '{}',
      })
      assert.equal(waiting.status, 202, await waiting.clone().text())
      assert.equal((await waiting.json() as { do_not_pay_again: boolean }).do_not_pay_again, true)
      const pending = await connectedDatabase().query<{
        status: string
        payment_use_attempt_id: number | null
        purchases: number
      }>(`
        SELECT a.status, u.world_payment_attempt_id AS payment_use_attempt_id,
          (SELECT count(*)::int FROM purchases WHERE world_checkout_id = 1) AS purchases
        FROM world_payment_attempts a
        JOIN payment_uses u ON u.tx_hash = a.tx_hash
        WHERE a.world_checkout_id = 1
      `)
      assert.equal(pending.rows[0]?.status, 'payment_pending')
      assert.equal(pending.rows[0]?.payment_use_attempt_id, 1)
      assert.equal(pending.rows[0]?.purchases, 0)

      while (true) {
        const clock = await connectedDatabase().query<{ now: Date }>('SELECT clock_timestamp() AS now')
        if ((clock.rows[0]?.now.getTime() ?? 0) > endTime.getTime()
            && Date.now() > endTime.getTime()) break
        await delay(50)
      }
      harnessState.chain = { ...harnessState.chain, finalityArrivesAt: new Date(Date.now() - 1) }
      const completed = await app.request('/api/world/sync/2', {
        method: 'POST', headers, body: '{}',
      })
      assert.equal(completed.status, 200, await completed.clone().text())

      const durable = await connectedDatabase().query<{
        status: string
        finalized_block_number: string
        finalized_block_hash: string
        finalized_block_time: Date
        finalized_at: Date
        world_payment_attempt_id: number
        payment_to: string
      }>(`
        SELECT a.status, a.finalized_block_number::text, a.finalized_block_hash,
          a.finalized_block_time, a.finalized_at, p.world_payment_attempt_id,
          p.world_receipt->>'payment_to' AS payment_to
        FROM world_payment_attempts a
        JOIN purchases p ON p.world_payment_attempt_id = a.world_checkout_id
        WHERE a.world_checkout_id = 1
      `)
      assert.equal(durable.rows[0]?.status, 'completed')
      assert.equal(durable.rows[0]?.finalized_block_number, '256')
      assert.equal(durable.rows[0]?.finalized_block_hash, RECEIPT_BLOCK_HASH)
      assert.equal(durable.rows[0]?.finalized_block_time.getTime(), blockTime.getTime())
      assert.ok((durable.rows[0]?.finalized_at.getTime() ?? 0) > endTime.getTime())
      assert.equal(durable.rows[0]?.world_payment_attempt_id, 1)
      assert.equal(durable.rows[0]?.payment_to, SELLER_WALLET)
      assert.ok(harnessState.rpcMethods.includes('eth_getBlockByNumber'))
    },
  )

  await t.test('terminal city payment outcomes atomically close the real PostgreSQL lane without a sale', async () => {
    const outcomes = [
      { phase: 'payment_invalid', reason: 'city payment invalid' },
      { phase: 'payment_expired', reason: 'city payment expired' },
      { phase: 'founder_review', reason: 'city founder review' },
    ] as const
    const headers = { Authorization: `Bearer ${BUYER_SECRET}`, 'Content-Type': 'application/json' }
    const terminalCityOffer = (
      phase: typeof outcomes[number]['phase'],
      reservedAt: Date,
      reservedUntil: Date,
    ) => ({
      id: 501,
      channel: 'world',
      phase,
      asset_type: 'thing',
      asset_id: 77,
      asset_name: 'City compass',
      locked: true,
      seller: 'city-seller',
      buyer: 'city-buyer',
      market_buyer: 'buyer-two',
      price_usdc: 2,
      seller_wallet: SELLER_WALLET,
      market_origin: 'https://1f3ea.com',
      market_draft_id: 1,
      market_listing_id: 2,
      market_checkout_id: 1,
      pending_x402_tx_hash: TX_HASH,
      pending_x402_at: new Date(reservedAt.getTime() + 60_000).toISOString(),
      reserved_at: reservedAt.toISOString(),
      reserved_until: reservedUntil.toISOString(),
      created_at: new Date(reservedAt.getTime() - 1_000).toISOString(),
      claimed_at: null,
      canceled_at: null,
    })

    for (const outcome of outcomes) {
      await resetAndSeed()
      harnessState.rpcMethods = []
      const reservedAt = new Date(Date.now() - 3 * 60 * 60 * 1000)
      const reservedUntil = new Date(reservedAt.getTime() + 5 * 60 * 1000)
      const checkoutCreatedAt = new Date(reservedAt.getTime() - 60_000)
      await connectedDatabase().query(`
        UPDATE world_checkouts
        SET created_at = $1, expires_at = $2, status = 'active', completed_at = NULL
        WHERE id = 1
      `, [checkoutCreatedAt, new Date(checkoutCreatedAt.getTime() + 10 * 60 * 1000)])
      harnessState.cityOffer = terminalCityOffer(outcome.phase, reservedAt, reservedUntil)

      const syncTerminalOutcome = async () => {
        const response = await app.request('/api/world/sync/2', {
          method: 'POST', headers, body: '{}',
        })
        assert.equal(response.status, 200, await response.clone().text())
        const body = await response.json() as {
          status: string
          city_phase: string
          do_not_pay_again: boolean
        }
        assert.equal(body.status, 'stale')
        assert.equal(body.city_phase, outcome.phase)
        assert.equal(body.do_not_pay_again, true)
      }
      await syncTerminalOutcome()
      const firstWrite = await connectedDatabase().query<{ canceled_at: Date }>(`
        SELECT canceled_at FROM world_drafts WHERE id = 1
      `)
      assert.ok(firstWrite.rows[0]?.canceled_at instanceof Date)
      await syncTerminalOutcome()

      const durable = await connectedDatabase().query<{
        world_state: string
        withdrawn: boolean
        withdrawn_reason: string
        draft_state: string
        canceled_at: Date
        canceled_reason: string
        checkout_status: string
        purchases: number
        payment_attempts: number
        cancellation_events: number
      }>(`
        SELECT listing.world_state, listing.withdrawn, listing.withdrawn_reason,
          draft.state AS draft_state, draft.canceled_at, draft.canceled_reason,
          checkout.status AS checkout_status,
          (SELECT count(*)::int FROM purchases WHERE world_checkout_id = checkout.id) AS purchases,
          (SELECT count(*)::int FROM world_payment_attempts
            WHERE world_checkout_id = checkout.id) AS payment_attempts,
          (SELECT count(*)::int FROM events
            WHERE kind = 'world_canceled' AND detail->>'listing_id' = listing.id::text
          ) AS cancellation_events
        FROM listings listing
        JOIN world_drafts draft ON draft.id = listing.world_draft_id
        JOIN world_checkouts checkout ON checkout.listing_id = listing.id
        WHERE listing.id = 2 AND checkout.id = 1
      `)
      const terminalState = durable.rows[0]
      assert.equal(terminalState?.world_state, 'stale')
      assert.equal(terminalState?.withdrawn, true)
      assert.equal(terminalState?.withdrawn_reason, outcome.reason)
      assert.equal(terminalState?.draft_state, 'canceled')
      assert.equal(terminalState?.canceled_at.getTime(), firstWrite.rows[0]?.canceled_at.getTime())
      assert.equal(terminalState?.canceled_reason, outcome.reason)
      assert.equal(terminalState?.checkout_status, 'expired')
      assert.equal(terminalState?.purchases, 0)
      assert.equal(terminalState?.payment_attempts, 0)
      assert.equal(terminalState?.cancellation_events, 1)
      assert.deepEqual(harnessState.rpcMethods, [])
    }

    await resetAndSeed()
    harnessState.rpcMethods = []
    const reservedAt = new Date(Date.now() - 3 * 60 * 60 * 1000)
    const reservedUntil = new Date(reservedAt.getTime() + 5 * 60 * 1000)
    const checkoutCreatedAt = new Date(reservedAt.getTime() - 60_000)
    await connectedDatabase().query(`
      UPDATE listings SET world_state = 'canceled', withdrawn = TRUE,
        withdrawn_at = $1, withdrawn_reason = 'withdrawn by merchant' WHERE id = 2
    `, [new Date(reservedUntil.getTime() + 60_000)])
    await connectedDatabase().query(`
      UPDATE world_drafts SET state = 'withdrawn', canceled_at = $1,
        canceled_reason = 'withdrawn by merchant' WHERE id = 1
    `, [new Date(reservedUntil.getTime() + 60_000)])
    await connectedDatabase().query(`
      UPDATE world_checkouts SET created_at = $1, expires_at = $2, status = 'expired'
        WHERE id = 1
    `, [checkoutCreatedAt,
      new Date(checkoutCreatedAt.getTime() + 10 * 60 * 1000)])
    harnessState.cityOffer = terminalCityOffer('payment_expired', reservedAt, reservedUntil)

    const afterWithdrawal = await app.request('/api/world/sync/2', {
      method: 'POST', headers, body: '{}',
    })
    assert.equal(afterWithdrawal.status, 200, await afterWithdrawal.clone().text())
    assert.equal((await afterWithdrawal.json() as { status: string }).status, 'canceled')
    const preserved = await connectedDatabase().query<{
      world_state: string
      withdrawn_reason: string
      draft_state: string
      canceled_reason: string
      cancellation_events: number
    }>(`
      SELECT listing.world_state, listing.withdrawn_reason, draft.state AS draft_state,
        draft.canceled_reason, (SELECT count(*)::int FROM events WHERE kind = 'world_canceled')
          AS cancellation_events
      FROM listings listing JOIN world_drafts draft ON draft.id = listing.world_draft_id
      WHERE listing.id = 2
    `)
    assert.deepEqual(preserved.rows[0], {
      world_state: 'canceled',
      withdrawn_reason: 'withdrawn by merchant',
      draft_state: 'withdrawn',
      canceled_reason: 'withdrawn by merchant',
      cancellation_events: 0,
    })
    assert.deepEqual(harnessState.rpcMethods, [])
  })

  await t.test('listing fee finality may arrive after its first fixed PostgreSQL window', async () => {
    await resetAndSeed()
    harnessState.rpcMethods = []
    const transferBlockTime = new Date(Math.floor((Date.now() - 1_000) / 1_000) * 1_000)
    const finalityArrivesAt = new Date(Date.now() + 1_000)
    harnessState.chain = {
      transferBlockTime,
      finalityArrivesAt,
      amountUnits: 1_000_000n,
      fromWallet: BUYER_WALLET,
      toWallet: TREASURY,
    }
    const headers = { Authorization: `Bearer ${BUYER_SECRET}`, 'Content-Type': 'application/json' }
    const body = JSON.stringify({
      title: 'Finality timing fixture',
      description: 'real PostgreSQL listing fee timing',
      preview: 'one immutable payment window',
      artifact: 'real database delivery',
      price_usdc: 0.25,
      seller_wallet: BUYER_WALLET,
      tags: ['test'],
      aisle: 'tools',
      fee_tx_hash: TX_HASH,
    })

    const waiting = await app.request('/api/listing', { method: 'POST', headers, body })
    assert.equal(waiting.status, 202, await waiting.clone().text())
    assert.equal((await waiting.json() as { do_not_pay_again: boolean }).do_not_pay_again, true)
    const pending = await connectedDatabase().query<{
      minimum_block_time: Date
      maximum_block_time: Date
      payment_status: string
    }>(`
      SELECT minimum_block_time, maximum_block_time, payment_status
      FROM listing_fee_attempts WHERE lower(tx_hash) = lower($1)
    `, [TX_HASH])
    assert.equal(pending.rows[0]?.payment_status, 'payment_pending')
    assert.equal(
      (pending.rows[0]?.maximum_block_time.getTime() ?? 0)
        - (pending.rows[0]?.minimum_block_time.getTime() ?? 0),
      60 * 60 * 1000,
    )
    assert.ok(transferBlockTime <= pending.rows[0]!.maximum_block_time)

    while (Date.now() <= finalityArrivesAt.getTime()) await delay(25)
    const created = await app.request('/api/listing', { method: 'POST', headers, body })
    assert.equal(created.status, 201, await created.clone().text())

    const durable = await connectedDatabase().query<{
      payment_status: string
      finalized_block_time: Date
      finalized_at: Date
      maximum_block_time: Date
      listing_fee_attempt_id: string
      payment_use_attempt_id: string
      verification_method: string
    }>(`
      SELECT attempt.payment_status, attempt.finalized_block_time, attempt.finalized_at,
        attempt.maximum_block_time, fee.listing_fee_attempt_id::text,
        payment_use.listing_fee_attempt_id::text AS payment_use_attempt_id,
        fee.verification_method
      FROM listing_fee_attempts attempt
      JOIN fees fee ON fee.listing_fee_attempt_id = attempt.id
      JOIN payment_uses payment_use ON payment_use.listing_fee_attempt_id = attempt.id
      WHERE lower(attempt.tx_hash) = lower($1)
    `, [TX_HASH])
    assert.equal(durable.rows[0]?.payment_status, 'completed')
    assert.equal(durable.rows[0]?.finalized_block_time.getTime(), transferBlockTime.getTime())
    assert.ok((durable.rows[0]?.finalized_at.getTime() ?? 0)
      > (durable.rows[0]?.maximum_block_time.getTime() ?? Number.MAX_SAFE_INTEGER))
    assert.equal(durable.rows[0]?.listing_fee_attempt_id, durable.rows[0]?.payment_use_attempt_id)
    assert.equal(durable.rows[0]?.verification_method, 'direct')
  })

  await t.test('direct world-listing finality may arrive after its real PostgreSQL draft window', async () => {
    await resetAndSeed()
    harnessState.rpcMethods = []
    const now = Date.now()
    const createdAt = new Date(Math.floor(now / 1_000) * 1_000 - 1_000)
    const expiresAt = new Date(now + 700)
    const transferBlockTime = new Date(Math.floor(now / 1_000) * 1_000)
    const finalityArrivesAt = new Date(expiresAt.getTime() + 100)
    await preparePendingWorldListingDraft(createdAt, expiresAt)
    harnessState.chain = {
      transferBlockTime,
      finalityArrivesAt,
      amountUnits: 1_000_000n,
      fromWallet: BUYER_WALLET,
      toWallet: TREASURY,
    }
    const headers = { Authorization: `Bearer ${BUYER_SECRET}`, 'Content-Type': 'application/json' }
    const body = JSON.stringify({ draft_id: 1, city_offer_id: 501, fee_tx_hash: TX_HASH })

    const waiting = await app.request('/api/world/listing', { method: 'POST', headers, body })
    assert.equal(waiting.status, 202, await waiting.clone().text())
    assert.equal((await waiting.json() as { do_not_pay_again: boolean }).do_not_pay_again, true)

    while (Date.now() <= finalityArrivesAt.getTime()) await delay(25)
    const expired = await connectedDatabase().query(`
      UPDATE world_drafts SET state = 'expired'
      WHERE id = 1 AND state = 'pending'
    `)
    assert.equal(expired.rowCount, 1)
    const activated = await app.request('/api/world/listing', { method: 'POST', headers, body })
    assert.equal(activated.status, 201, await activated.clone().text())

    const durable = await connectedDatabase().query<{
      payment_status: string
      maximum_block_time: Date
      finalized_block_time: Date
      finalized_at: Date
      draft_expires_at: Date
      draft_state: string
      verification_method: string
      seller_wallet: string
    }>(`
      SELECT attempt.payment_status, attempt.maximum_block_time,
        attempt.finalized_block_time, attempt.finalized_at,
        draft.expires_at AS draft_expires_at, draft.state AS draft_state, fee.verification_method,
        listing.seller_wallet
      FROM listing_fee_attempts attempt
      JOIN fees fee ON fee.listing_fee_attempt_id = attempt.id
      JOIN listings listing ON listing.id = fee.listing_id
      JOIN world_drafts draft ON draft.listing_id = listing.id
      WHERE lower(attempt.tx_hash) = lower($1)
    `, [TX_HASH])
    assert.equal(durable.rows[0]?.payment_status, 'completed')
    assert.equal(durable.rows[0]?.draft_state, 'active')
    assert.equal(durable.rows[0]?.verification_method, 'direct')
    assert.equal(durable.rows[0]?.seller_wallet, BUYER_WALLET)
    assert.ok((durable.rows[0]?.maximum_block_time.getTime() ?? Number.MAX_SAFE_INTEGER)
      <= expiresAt.getTime())
    assert.equal(durable.rows[0]?.finalized_block_time.getTime(), transferBlockTime.getTime())
    assert.ok((durable.rows[0]?.finalized_at.getTime() ?? 0) > expiresAt.getTime())
    assert.equal(durable.rows[0]?.draft_expires_at.toISOString(), '9999-12-31T23:59:59.999Z')
  })

  await t.test('x402 world-listing finality may arrive after its real PostgreSQL draft window', async () => {
    await resetAndSeed()
    harnessState.rpcMethods = []
    const now = Date.now()
    const createdAt = new Date(Math.floor(now / 1_000) * 1_000 - 1_000)
    const expiresAt = new Date(now + 700)
    const operationStartedAt = new Date()
    const transferBlockTime = new Date(Math.floor(operationStartedAt.getTime() / 1_000) * 1_000)
    const finalityArrivesAt = new Date(expiresAt.getTime() + 100)
    await preparePendingWorldListingDraft(createdAt, expiresAt)
    const nonce = `0x${'4'.repeat(64)}`
    harnessState.authorizationNonce = nonce
    harnessState.chain = {
      transferBlockTime,
      finalityArrivesAt,
      amountUnits: 1_000_000n,
      fromWallet: BUYER_WALLET,
      toWallet: TREASURY,
    }
    const requestHash = sha256(JSON.stringify({
      version: 1,
      merchant_id: 2,
      kind: 'world_listing',
      draft_id: 1,
      city_offer_id: 501,
      thing_id: 77,
      title: 'City compass',
      description: 'A city-owned thing.',
      preview: 'A world preview.',
      price_usdc: 2,
      seller_wallet: BUYER_WALLET.toLowerCase(),
      tags: ['world'],
    }))
    const operationKey = `world-listing-fee:merchant:2:request:${requestHash}`
    const paymentHeader = x402PaymentHeader({
      payer: BUYER_WALLET,
      payee: TREASURY,
      amountUnits: '1000000',
      nonce,
    })
    const { beginX402Settlement, recordX402Settlement } =
      await import('../../src/x402-payment-attempts.ts')
    const reserved = await beginX402Settlement({
      operationKey,
      operationKind: 'world_listing_fee',
      operationStartedAt,
      startBlock: 256n,
      paymentHeader,
      requirements: {
        network: 'base',
        asset: USDC,
        payTo: TREASURY,
        maxAmountRequired: '1000000',
        resource: 'https://1f3ea.com/api/world/listing',
      },
    })
    assert.equal(reserved.disposition, 'created')
    await recordX402Settlement({
      operationKey,
      proofDigest: reserved.attempt.proof_digest,
      transaction: TX_HASH,
      payerWallet: BUYER_WALLET,
    })

    while (Date.now() <= finalityArrivesAt.getTime()) await delay(25)
    const expired = await connectedDatabase().query(`
      UPDATE world_drafts SET state = 'expired'
      WHERE id = 1 AND state = 'pending'
    `)
    assert.equal(expired.rowCount, 1)
    const headers = { Authorization: `Bearer ${BUYER_SECRET}`, 'Content-Type': 'application/json' }
    const activated = await app.request('/api/world/listing', {
      method: 'POST', headers, body: JSON.stringify({ draft_id: 1, city_offer_id: 501 }),
    })
    assert.equal(activated.status, 201, await activated.clone().text())

    const durable = await connectedDatabase().query<{
      status: string
      operation_started_at: Date
      finalized_block_time: Date
      finalized_at: Date
      draft_expires_at: Date
      draft_state: string
      x402_payment_operation_key: string
      verification_method: string
      seller_wallet: string
    }>(`
      SELECT attempt.status, attempt.operation_started_at,
        attempt.finalized_block_time, attempt.finalized_at,
        draft.expires_at AS draft_expires_at, draft.state AS draft_state,
        fee.x402_payment_operation_key, fee.verification_method,
        listing.seller_wallet
      FROM x402_payment_attempts attempt
      JOIN fees fee ON lower(fee.tx_hash) = lower(attempt.tx_hash)
      JOIN listings listing ON listing.id = fee.listing_id
      JOIN world_drafts draft ON draft.listing_id = listing.id
      WHERE attempt.operation_key = $1
    `, [operationKey])
    assert.equal(durable.rows[0]?.status, 'verified')
    assert.equal(durable.rows[0]?.draft_state, 'active')
    assert.equal(durable.rows[0]?.x402_payment_operation_key, operationKey)
    assert.equal(durable.rows[0]?.verification_method, 'x402')
    assert.equal(durable.rows[0]?.seller_wallet, BUYER_WALLET)
    assert.ok((durable.rows[0]?.operation_started_at.getTime() ?? Number.MAX_SAFE_INTEGER)
      <= expiresAt.getTime())
    assert.equal(durable.rows[0]?.finalized_block_time.getTime(), transferBlockTime.getTime())
    assert.ok((durable.rows[0]?.finalized_at.getTime() ?? 0) > expiresAt.getTime())
    assert.equal(durable.rows[0]?.draft_expires_at.toISOString(), '9999-12-31T23:59:59.999Z')
  })

  await t.test('strict custody migration rejects receipt-only old direct and world writes', async () => {
    await resetAndSeed()
    const oldDirectIntent = await connectedDatabase().query<{ id: number }>(`
      INSERT INTO direct_purchase_intents (
        listing_id, merchant_id, payer_wallet, seller_wallet, network, asset,
        minimum_amount_usdc, challenge_nonce, created_at, expires_at
      ) VALUES (1, 2, $1, $2, 'base', $3, 0.5, repeat('d', 64), now(), now() + interval '10 minutes')
      RETURNING id
    `, [BUYER_WALLET, SELLER_WALLET, USDC.toLowerCase()])
    await assert.rejects(
      connectedDatabase().query(`
        INSERT INTO purchases (
          listing_id, merchant_id, amount_usdc, tx_hash, verified_via,
          direct_purchase_intent_id
        ) VALUES (1, 2, 0.5, $1, 'claim', $2)
      `, [`0x${'d'.repeat(64)}`, oldDirectIntent.rows[0]!.id]),
      /not reserved by this intent|payment_uses_pkey/iu,
    )

    await assert.rejects(
      connectedDatabase().query(`
        INSERT INTO purchases (
          listing_id, merchant_id, amount_usdc, tx_hash, verified_via,
          world_checkout_id, world_receipt
        ) VALUES (2, 2, 2, $1, 'world', 1, '{}'::jsonb)
      `, [`0x${'e'.repeat(64)}`]),
      /purchases_world_requires_payment_attempt|violates check constraint/iu,
    )

    await assert.rejects(
      connectedDatabase().query(`
        INSERT INTO fees (merchant_id, listing_id, amount_usdc, tx_hash)
        VALUES (1, 2, 1, $1)
      `, [`0x${'6'.repeat(64)}`]),
      /verification_method|null value|not-null constraint/iu,
    )

    await assert.rejects(
      connectedDatabase().query(`
        INSERT INTO fees (
          merchant_id, listing_id, amount_usdc, tx_hash, verification_method
        ) VALUES (1, 2, 1, $1, 'x402')
      `, [`0x${'7'.repeat(64)}`]),
      /fees_x402_requires_payment_attempt|fees_verification_method_link|violates check constraint/iu,
    )
  })

  await t.test('review states keep complete finality facts and reject partial or mutable history', async () => {
    await resetAndSeed()
    const client = connectedDatabase()

    const direct = await client.query<{ id: number }>(`
      INSERT INTO direct_purchase_intents (
        listing_id, merchant_id, payer_wallet, seller_wallet, network, asset,
        minimum_amount_usdc, challenge_nonce, created_at, expires_at
      ) VALUES (1, 2, $1, $2, 'base', $3, 0.5, repeat('1', 64),
        now() - interval '2 minutes', now() + interval '8 minutes')
      RETURNING id
    `, [BUYER_WALLET, SELLER_WALLET, USDC.toLowerCase()])
    await client.query(`
      UPDATE direct_purchase_intents
      SET payment_tx_hash = $1, payment_status = 'payment_pending'
      WHERE id = $2
    `, [`0x${'1'.repeat(64)}`, direct.rows[0]!.id])
    await client.query(`
      UPDATE direct_purchase_intents SET
        payment_status = 'needs_review', payment_review_reason = 'finalized delivery conflict',
        finalized_block_number = 256, finalized_block_hash = $1,
        finalized_block_time = now() - interval '1 minute', finalized_at = now()
      WHERE id = $2
    `, [`0x${'2'.repeat(64)}`, direct.rows[0]!.id])

    await client.query(`
      INSERT INTO world_payment_attempts (
        world_checkout_id, listing_id, merchant_id, tx_hash, payer_wallet, payee_wallet,
        amount_units, start_time, end_time, city_block_time, verified_via
      ) VALUES (1, 2, 2, $1, $2, $3, 2000000,
        now() - interval '45 seconds', now() + interval '2 minutes',
        now() - interval '30 seconds', 'claim')
    `, [`0x${'3'.repeat(64)}`, BUYER_WALLET, SELLER_WALLET])
    await client.query(`
      UPDATE world_payment_attempts SET
        status = 'needs_review', review_reason = 'finalized receipt conflict',
        finalized_block_number = 256, finalized_block_hash = $1,
        finalized_block_time = city_block_time, finalized_at = now()
      WHERE world_checkout_id = 1
    `, [`0x${'4'.repeat(64)}`])

    const listingAttempt = await client.query<{ id: string }>(`
      INSERT INTO listing_fee_attempts (
        merchant_id, fee_request_kind, fee_request_hash, tx_hash, payer_wallet,
        payee_wallet, asset, amount_usdc, minimum_block_time, maximum_block_time
      ) VALUES (2, 'artifact_listing', repeat('5', 64), $1, $2, $3, $4, 1,
        now() - interval '1 hour', now())
      RETURNING id::text
    `, [`0x${'5'.repeat(64)}`, BUYER_WALLET, TREASURY, USDC.toLowerCase()])
    await assert.rejects(
      client.query(`
        UPDATE listing_fee_attempts SET payment_status = 'needs_review',
          payment_review_reason = 'partial evidence', finalized_block_number = 256
        WHERE id = $1
      `, [listingAttempt.rows[0]!.id]),
      /listing_fee_attempt_finality_complete|violates check constraint/iu,
    )
    await client.query(`
      UPDATE listing_fee_attempts SET payment_status = 'needs_review',
        payment_review_reason = 'pre-chain conflict'
      WHERE id = $1
    `, [listingAttempt.rows[0]!.id])
    await assert.rejects(
      client.query(`
        UPDATE listing_fee_attempts SET payment_review_reason = 'rewritten history'
        WHERE id = $1
      `, [listingAttempt.rows[0]!.id]),
      /terminal listing fee attempt state is immutable/iu,
    )

    const finalizedListingAttempt = await client.query<{ id: string }>(`
      INSERT INTO listing_fee_attempts (
        merchant_id, fee_request_kind, fee_request_hash, tx_hash, payer_wallet,
        payee_wallet, asset, amount_usdc, minimum_block_time, maximum_block_time
      ) VALUES (2, 'artifact_listing', repeat('6', 64), $1, $2, $3, $4, 1,
        now() - interval '1 hour', now())
      RETURNING id::text
    `, [`0x${'6'.repeat(64)}`, BUYER_WALLET, TREASURY, USDC.toLowerCase()])
    await client.query(`
      UPDATE listing_fee_attempts SET
        payment_status = 'needs_review', payment_review_reason = 'outside fixed window',
        finalized_block_number = 256, finalized_block_hash = $1,
        finalized_block_time = minimum_block_time - interval '1 second', finalized_at = now()
      WHERE id = $2
    `, [`0x${'7'.repeat(64)}`, finalizedListingAttempt.rows[0]!.id])

    const evidence = await client.query<{
      direct_facts: number
      world_facts: number
      listing_facts: number
      null_review_facts: number
    }>(`
      SELECT
        (SELECT num_nonnulls(finalized_block_number, finalized_block_hash,
          finalized_block_time, finalized_at) FROM direct_purchase_intents WHERE id = $1)
          AS direct_facts,
        (SELECT num_nonnulls(finalized_block_number, finalized_block_hash,
          finalized_block_time, finalized_at) FROM world_payment_attempts WHERE world_checkout_id = 1)
          AS world_facts,
        (SELECT num_nonnulls(finalized_block_number, finalized_block_hash,
          finalized_block_time, finalized_at) FROM listing_fee_attempts WHERE id = $2)
          AS listing_facts,
        (SELECT num_nonnulls(finalized_block_number, finalized_block_hash,
          finalized_block_time, finalized_at) FROM listing_fee_attempts WHERE id = $3)
          AS null_review_facts
    `, [direct.rows[0]!.id, finalizedListingAttempt.rows[0]!.id, listingAttempt.rows[0]!.id])
    assert.deepEqual(evidence.rows[0], {
      direct_facts: 4,
      world_facts: 4,
      listing_facts: 4,
      null_review_facts: 0,
    })
  })
}
