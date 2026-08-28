import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'

import {
  BUYER_SECRET,
  BUYER_WALLET,
  SELLER_WALLET,
  TREASURY,
  USDC,
  connectedDatabase,
  harnessState,
  resetAndSeed,
  sha256,
  worldFinalityMigrationDdl,
  x402PaymentAttemptsMigrationDdl,
  x402PaymentHeader,
  type MarketPostgresApp,
} from './market-postgres-harness.ts'

const LISTING_TX = `0x${'6'.repeat(64)}`
const PURCHASE_TX = `0x${'7'.repeat(64)}`

async function applyPaymentMigrations(...migrations: readonly string[]): Promise<void> {
  const { splitMigrationSql } = await import('../../scripts/release-migrate.ts')
  const session = await connectedDatabase().connect()
  try {
    await session.query('BEGIN')
    for (const migration of migrations) {
      for (const statement of splitMigrationSql(migration)) {
        await session.query(statement)
      }
    }
    await session.query('COMMIT')
  } catch (error) {
    await session.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    session.release()
  }
}

async function applyX402Migration(): Promise<void> {
  await applyPaymentMigrations(x402PaymentAttemptsMigrationDdl)
}

async function preserveSettledX402(input: {
  operationKey: string
  operationKind: 'listing_fee' | 'purchase'
  payee: string
  amountUnits: string
  resource: string
  nonce: string
  txHash: string
  startBlock?: bigint
}): Promise<void> {
  const paymentHeader = x402PaymentHeader({
    payer: BUYER_WALLET,
    payee: input.payee,
    amountUnits: input.amountUnits,
    nonce: input.nonce,
  })
  const { beginX402Settlement, recordX402Settlement } =
    await import('../../src/x402-payment-attempts.ts')
  const reserved = await beginX402Settlement({
    operationKey: input.operationKey,
    operationKind: input.operationKind,
    startBlock: input.startBlock ?? 0x100n,
    operationStartedAt: new Date(Date.now() - 1_000),
    paymentHeader,
    requirements: {
      network: 'base', asset: USDC, payTo: input.payee,
      maxAmountRequired: input.amountUnits, resource: input.resource,
    },
  })
  assert.equal(reserved.disposition, 'created')
  await recordX402Settlement({
    operationKey: input.operationKey,
    proofDigest: reserved.attempt.proof_digest,
    transaction: input.txHash,
    payerWallet: BUYER_WALLET,
  })
}

export async function runMarketPostgresX402ResultCases(
  t: TestContext,
  app: MarketPostgresApp,
): Promise<void> {
  await t.test('world and x402 migrations stay exact when interleaved and keep one transaction owner', async () => {
    await resetAndSeed()
    const client = connectedDatabase()
    await applyPaymentMigrations(
      worldFinalityMigrationDdl,
      x402PaymentAttemptsMigrationDdl,
      worldFinalityMigrationDdl,
      x402PaymentAttemptsMigrationDdl,
    )

    const { missingMigrationPostconditions } = await import('../../scripts/release-migrate.ts')
    const { MIGRATIONS } = await import('../../scripts/release-migration-registry.ts')
    const queryCatalog = async (text: string, values: readonly unknown[]) =>
      (await client.query(text, [...values])).rows
    for (const migration of ['world-payment-finality', 'x402-payment-attempts'] as const) {
      assert.deepEqual(
        await missingMigrationPostconditions(MIGRATIONS[migration].postconditions, queryCatalog),
        [],
        `${migration} catalog drifted after interleaved reruns`,
      )
    }

    const { beginX402Settlement, recordX402Settlement } =
      await import('../../src/x402-payment-attempts.ts')
    const reassignmentKey = 'purchase:artifact:2:interleave-owner'
    await beginX402Settlement({
      operationKey: reassignmentKey,
      operationKind: 'purchase',
      startBlock: 0x100n,
      operationStartedAt: new Date(),
      paymentHeader: x402PaymentHeader({
        payer: BUYER_WALLET,
        payee: SELLER_WALLET,
        amountUnits: '500000',
        nonce: `0x${'1'.repeat(64)}`,
      }),
      requirements: {
        network: 'base', asset: USDC, payTo: SELLER_WALLET,
        maxAmountRequired: '500000', resource: 'https://1f3ea.com/api/buy/interleave-owner',
      },
    })

    const seededX402Tx = `0x${'f'.repeat(64)}`
    await assert.rejects(
      client.query('UPDATE payment_uses SET used_as = $1 WHERE tx_hash = $2', [
        'purchases', seededX402Tx,
      ]),
      /linked payment use history is immutable/iu,
    )
    await assert.rejects(
      client.query('DELETE FROM payment_uses WHERE tx_hash = $1', [seededX402Tx]),
      /linked payment use history is immutable/iu,
    )
    await assert.rejects(
      client.query(`
        UPDATE payment_uses SET x402_payment_operation_key = $1 WHERE tx_hash = $2
      `, [reassignmentKey, seededX402Tx]),
      /linked payment use history is immutable/iu,
    )

    const crossChannelTx = `0x${'2'.repeat(64)}`
    await client.query(`
      INSERT INTO world_payment_attempts (
        world_checkout_id, listing_id, merchant_id, tx_hash, payer_wallet, payee_wallet,
        amount_units, start_time, end_time, city_block_time, verified_via
      )
      SELECT checkout.id, checkout.listing_id, checkout.merchant_id, $1, $2, $3,
        2000000, checkout.created_at,
        LEAST(checkout.expires_at, checkout.created_at + interval '5 minutes'),
        checkout.created_at + interval '1 second', 'claim'
      FROM world_checkouts checkout WHERE checkout.id = 1
    `, [crossChannelTx, BUYER_WALLET, SELLER_WALLET])
    const crossChannelKey = 'purchase:artifact:2:interleave-conflict'
    const x402 = await beginX402Settlement({
      operationKey: crossChannelKey,
      operationKind: 'purchase',
      startBlock: 0x100n,
      operationStartedAt: new Date(),
      paymentHeader: x402PaymentHeader({
        payer: BUYER_WALLET,
        payee: SELLER_WALLET,
        amountUnits: '500000',
        nonce: `0x${'2'.repeat(64)}`,
      }),
      requirements: {
        network: 'base', asset: USDC, payTo: SELLER_WALLET,
        maxAmountRequired: '500000', resource: 'https://1f3ea.com/api/buy/interleave-conflict',
      },
    })
    const collision = await recordX402Settlement({
      operationKey: crossChannelKey,
      proofDigest: x402.attempt.proof_digest,
      transaction: crossChannelTx,
      payerWallet: BUYER_WALLET,
    })
    assert.equal(collision.status, 'needs_review')
    assert.match(collision.review_reason ?? '', /already assigned.*do not pay again/iu)
    const durableOwner = await client.query<{
      world_payment_attempt_id: number | null
      x402_payment_operation_key: string | null
    }>(`
      SELECT world_payment_attempt_id, x402_payment_operation_key
      FROM payment_uses WHERE tx_hash = $1
    `, [crossChannelTx])
    assert.deepEqual(durableOwner.rows[0], {
      world_payment_attempt_id: 1,
      x402_payment_operation_key: null,
    })
  })

  await t.test('x402 settlement reserves one global tx or preserves a conflicting tx for review', async () => {
    await resetAndSeed()
    const client = connectedDatabase()
    const conflictingTx = `0x${'c'.repeat(64)}`
    await client.query(`
      INSERT INTO payment_uses (tx_hash, used_as) VALUES ($1, 'purchases')
    `, [conflictingTx])
    const operationKey = `listing-fee:artifact:2:${'c'.repeat(64)}`
    const paymentHeader = x402PaymentHeader({
      payer: BUYER_WALLET, payee: TREASURY, amountUnits: '1000000',
      nonce: `0x${'c'.repeat(64)}`,
    })
    const { beginX402Settlement, recordX402Settlement } =
      await import('../../src/x402-payment-attempts.ts')
    const reserved = await beginX402Settlement({
      operationKey, operationKind: 'listing_fee', startBlock: 0x100n,
      operationStartedAt: new Date(), paymentHeader,
      requirements: {
        network: 'base', asset: USDC, payTo: TREASURY,
        maxAmountRequired: '1000000', resource: 'https://1f3ea.com/api/listing',
      },
    })
    const reviewed = await recordX402Settlement({
      operationKey, proofDigest: reserved.attempt.proof_digest,
      transaction: conflictingTx, payerWallet: BUYER_WALLET,
    })
    assert.equal(reviewed.status, 'needs_review')
    assert.equal(reviewed.tx_hash, conflictingTx)
    assert.ok(reviewed.settled_at)
    assert.match(reviewed.review_reason ?? '', /already assigned.*no delivery.*do not pay again/iu)
    const conflict = await client.query<{
      x402_key: string | null
      attempt_status: string
      attempt_tx: string
    }>(`
      SELECT payment_use.x402_payment_operation_key AS x402_key,
        attempt.status AS attempt_status, attempt.tx_hash AS attempt_tx
      FROM payment_uses payment_use CROSS JOIN x402_payment_attempts attempt
      WHERE payment_use.tx_hash = $1 AND attempt.operation_key = $2
    `, [conflictingTx, operationKey])
    assert.deepEqual(conflict.rows[0], {
      x402_key: null, attempt_status: 'needs_review', attempt_tx: conflictingTx,
    })
    assert.equal((await client.query(`
      SELECT count(*)::int AS n FROM fees WHERE x402_payment_operation_key = $1
      UNION ALL
      SELECT count(*)::int AS n FROM purchases WHERE x402_payment_operation_key = $1
    `, [operationKey])).rows.every(row => row.n === 0), true)
  })

  await t.test('x402 start block rejects old evidence but allows same-block late finality', async () => {
    await resetAndSeed()
    const { beginX402Settlement, recordX402Finality, recordX402Settlement } =
      await import('../../src/x402-payment-attempts.ts')
    const oldKey = `purchase:artifact:2:91`
    const oldHeader = x402PaymentHeader({
      payer: BUYER_WALLET, payee: SELLER_WALLET, amountUnits: '500000',
      nonce: `0x${'d'.repeat(64)}`,
    })
    const oldAttempt = await beginX402Settlement({
      operationKey: oldKey, operationKind: 'purchase', startBlock: 0x101n,
      operationStartedAt: new Date(), paymentHeader: oldHeader,
      requirements: {
        network: 'base', asset: USDC, payTo: SELLER_WALLET,
        maxAmountRequired: '500000', resource: 'https://1f3ea.com/api/buy/91',
      },
    })
    await recordX402Settlement({
      operationKey: oldKey, proofDigest: oldAttempt.attempt.proof_digest,
      transaction: `0x${'d'.repeat(64)}`, payerWallet: BUYER_WALLET,
    })
    const oldFinality = await recordX402Finality({
      operationKey: oldKey, proofDigest: oldAttempt.attempt.proof_digest,
      transaction: `0x${'d'.repeat(64)}`, outcome: 'verified', blockNumber: 0x100n,
      blockHash: `0x${'1'.repeat(64)}`,
      blockTime: new Date('2026-08-28T12:00:00Z'),
      finalizedAt: new Date('2026-08-28T13:00:00Z'),
    })
    assert.equal(oldFinality.status, 'needs_review')
    assert.equal(oldFinality.finalized_block_number, '256')
    assert.equal(oldFinality.finalized_block_hash, `0x${'1'.repeat(64)}`)
    assert.equal(oldFinality.finalized_block_time, '2026-08-28T12:00:00.000Z')
    assert.equal(oldFinality.finalized_at, '2026-08-28T13:00:00.000Z')
    assert.match(oldFinality.review_reason ?? '', /predates.*operation.*do not pay again/iu)
    const oldReplay = await recordX402Finality({
      operationKey: oldKey, proofDigest: oldAttempt.attempt.proof_digest,
      transaction: `0x${'d'.repeat(64)}`, outcome: 'verified', blockNumber: 0x100n,
      blockHash: `0x${'1'.repeat(64)}`,
      blockTime: new Date('2026-08-28T12:00:00Z'),
      finalizedAt: new Date('2026-08-28T13:00:00Z'),
    })
    assert.equal(oldReplay.updated_at, oldFinality.updated_at)

    const sameKey = `purchase:artifact:2:92`
    const sameHeader = x402PaymentHeader({
      payer: BUYER_WALLET, payee: SELLER_WALLET, amountUnits: '500000',
      nonce: `0x${'e'.repeat(64)}`,
    })
    const sameAttempt = await beginX402Settlement({
      operationKey: sameKey, operationKind: 'purchase', startBlock: 0x100n,
      operationStartedAt: new Date(), paymentHeader: sameHeader,
      requirements: {
        network: 'base', asset: USDC, payTo: SELLER_WALLET,
        maxAmountRequired: '500000', resource: 'https://1f3ea.com/api/buy/92',
      },
    })
    await recordX402Settlement({
      operationKey: sameKey, proofDigest: sameAttempt.attempt.proof_digest,
      transaction: `0x${'e'.repeat(64)}`, payerWallet: BUYER_WALLET,
    })
    const sameFinality = await recordX402Finality({
      operationKey: sameKey, proofDigest: sameAttempt.attempt.proof_digest,
      transaction: `0x${'e'.repeat(64)}`, outcome: 'verified', blockNumber: 0x100n,
      blockHash: `0x${'2'.repeat(64)}`,
      blockTime: new Date('2026-08-28T12:00:00Z'),
      finalizedAt: new Date('2026-08-28T14:00:00Z'),
    })
    assert.equal(sameFinality.status, 'verified')
    assert.equal(sameFinality.finalized_block_number, '256')
    const uses = await connectedDatabase().query<{ operation_key: string; used_as: string }>(`
      SELECT x402_payment_operation_key AS operation_key, used_as
      FROM payment_uses WHERE tx_hash = $1
    `, [`0x${'e'.repeat(64)}`])
    assert.deepEqual(uses.rows[0], { operation_key: sameKey, used_as: 'purchases' })

    const windowKey = 'purchase:artifact:2:93'
    const windowAttempt = await beginX402Settlement({
      operationKey: windowKey, operationKind: 'purchase', startBlock: 0x100n,
      operationStartedAt: new Date(),
      paymentHeader: x402PaymentHeader({
        payer: BUYER_WALLET, payee: SELLER_WALLET, amountUnits: '500000',
        nonce: `0x${'3'.repeat(64)}`,
      }),
      requirements: {
        network: 'base', asset: USDC, payTo: SELLER_WALLET,
        maxAmountRequired: '500000', resource: 'https://1f3ea.com/api/buy/93',
      },
    })
    await recordX402Settlement({
      operationKey: windowKey, proofDigest: windowAttempt.attempt.proof_digest,
      transaction: `0x${'3'.repeat(64)}`, payerWallet: BUYER_WALLET,
    })
    const outsideWindow = await recordX402Finality({
      operationKey: windowKey, proofDigest: windowAttempt.attempt.proof_digest,
      transaction: `0x${'3'.repeat(64)}`, outcome: 'verified', blockNumber: 0x100n,
      blockHash: `0x${'4'.repeat(64)}`, blockTime: new Date('2100-01-01T00:00:00Z'),
      finalizedAt: new Date('2100-01-01T01:00:00Z'),
    })
    assert.equal(outsideWindow.status, 'needs_review')
    assert.equal(outsideWindow.finalized_block_number, '256')
    assert.match(outsideWindow.review_reason ?? '', /outside.*signed authorization window.*do not pay again/iu)
  })

  await t.test('x402 state times stay monotonic when the app clock leads PostgreSQL', async () => {
    await resetAndSeed()
    const {
      beginX402Settlement,
      markX402SettlementNeedsReview,
      recordX402Finality,
      recordX402Settlement,
    } = await import('../../src/x402-payment-attempts.ts')
    const appClock = new Date(Date.now() + 5_000)
    const finalityKey = 'purchase:artifact:2:future-clock-finality'
    const finalityAttempt = await beginX402Settlement({
      operationKey: finalityKey,
      operationKind: 'purchase',
      startBlock: 0x100n,
      operationStartedAt: appClock,
      paymentHeader: x402PaymentHeader({
        payer: BUYER_WALLET, payee: SELLER_WALLET, amountUnits: '500000',
        nonce: `0x${'a'.repeat(64)}`,
      }),
      requirements: {
        network: 'base', asset: USDC, payTo: SELLER_WALLET,
        maxAmountRequired: '500000', resource: 'https://1f3ea.com/api/buy/future-clock-finality',
      },
    })
    const settled = await recordX402Settlement({
      operationKey: finalityKey,
      proofDigest: finalityAttempt.attempt.proof_digest,
      transaction: `0x${'a'.repeat(64)}`,
      payerWallet: BUYER_WALLET,
    })
    const finalized = await recordX402Finality({
      operationKey: finalityKey,
      proofDigest: finalityAttempt.attempt.proof_digest,
      transaction: `0x${'a'.repeat(64)}`,
      outcome: 'verified',
      blockNumber: 0x100n,
      blockHash: `0x${'b'.repeat(64)}`,
      blockTime: new Date(),
      finalizedAt: new Date(Date.now() + 1_000),
    })
    assert.equal(finalized.status, 'verified')
    assert.ok(Date.parse(finalized.updated_at) >= Date.parse(settled.updated_at))

    const reviewKey = 'purchase:artifact:2:future-clock-review'
    const reviewAttempt = await beginX402Settlement({
      operationKey: reviewKey,
      operationKind: 'purchase',
      startBlock: 0x100n,
      operationStartedAt: appClock,
      paymentHeader: x402PaymentHeader({
        payer: BUYER_WALLET, payee: SELLER_WALLET, amountUnits: '500000',
        nonce: `0x${'c'.repeat(64)}`,
      }),
      requirements: {
        network: 'base', asset: USDC, payTo: SELLER_WALLET,
        maxAmountRequired: '500000', resource: 'https://1f3ea.com/api/buy/future-clock-review',
      },
    })
    const reviewed = await markX402SettlementNeedsReview({
      operationKey: reviewKey,
      proofDigest: reviewAttempt.attempt.proof_digest,
      reason: 'facilitator outcome is uncertain; do not pay again',
    })
    assert.equal(reviewed.status, 'needs_review')
    assert.ok(Date.parse(reviewed.updated_at) >= Date.parse(reviewAttempt.attempt.updated_at))
  })

  await t.test('the x402 result migration preserves old rows but rejects new receipt-only writes', async () => {
    await resetAndSeed()
    const client = connectedDatabase()
    await client.query(`
      DROP TRIGGER IF EXISTS fees_x402_payment_attempt_match ON fees;
      DROP TRIGGER IF EXISTS purchases_x402_payment_attempt_match ON purchases;
      DROP TRIGGER IF EXISTS fees_x402_result_link_immutable ON fees;
      DROP TRIGGER IF EXISTS purchases_x402_result_link_immutable ON purchases;
      DROP FUNCTION IF EXISTS validate_x402_result_link();
      DROP FUNCTION IF EXISTS protect_x402_result_link();
      ALTER TABLE fees DROP COLUMN IF EXISTS x402_payment_operation_key CASCADE;
      ALTER TABLE purchases DROP COLUMN IF EXISTS x402_payment_operation_key CASCADE;
    `)
    await client.query(`
      INSERT INTO purchases (listing_id, merchant_id, amount_usdc, tx_hash, verified_via)
      VALUES (1, 2, 0.5, $1, 'x402')
    `, [`0x${'8'.repeat(64)}`])

    await applyX402Migration()
    const legacy = await client.query<{
      fee_link: string | null
      purchase_link: string | null
    }>(`
      SELECT fee.x402_payment_operation_key AS fee_link,
        purchase.x402_payment_operation_key AS purchase_link
      FROM fees fee CROSS JOIN purchases purchase
      WHERE fee.id = 1 AND purchase.listing_id = 1 AND purchase.merchant_id = 2
    `)
    assert.deepEqual(legacy.rows[0], { fee_link: null, purchase_link: null })

    await assert.rejects(client.query(`
      INSERT INTO fees (merchant_id, listing_id, amount_usdc, tx_hash, verification_method)
      VALUES (1, 1, 1, $1, 'x402')
    `, [`0x${'9'.repeat(64)}`]), /fees_x402_requires_payment_attempt|check constraint/iu)
    await assert.rejects(client.query(`
      INSERT INTO purchases (listing_id, merchant_id, amount_usdc, tx_hash, verified_via)
      VALUES (1, 1, 0.5, $1, 'x402')
    `, [`0x${'a'.repeat(64)}`]), /purchases_x402_requires_payment_attempt|check constraint/iu)
  })

  await t.test('artifact x402 listing fees and purchases persist their exact verified attempt', async () => {
    await resetAndSeed()
    const headers = { Authorization: `Bearer ${BUYER_SECRET}`, 'Content-Type': 'application/json' }
    const listing = {
      title: 'Linked x402 listing', description: 'Real PostgreSQL result linkage.',
      preview: 'one durable attempt', artifact: 'linked artifact', price_usdc: 0.75,
      seller_wallet: BUYER_WALLET, tags: ['test'], aisle: 'tools',
    }
    const requestHash = sha256(JSON.stringify({
      version: 1, merchant_id: 2, kind: 'artifact_listing', ...listing,
      seller_wallet: BUYER_WALLET.toLowerCase(),
    }))
    const listingOperationKey = `listing-fee:artifact:2:${requestHash}`
    const listingNonce = `0x${'5'.repeat(64)}`
    await preserveSettledX402({
      operationKey: listingOperationKey, operationKind: 'listing_fee', payee: TREASURY,
      amountUnits: '1000000', resource: 'https://1f3ea.com/api/listing',
      nonce: listingNonce, txHash: LISTING_TX,
    })
    harnessState.authorizationNonce = listingNonce
    harnessState.chain = {
      transferBlockTime: new Date(), finalityArrivesAt: new Date(Date.now() - 1),
      amountUnits: 1_000_000n, fromWallet: BUYER_WALLET, toWallet: TREASURY,
    }
    const listed = await app.request('/api/listing', {
      method: 'POST', headers, body: JSON.stringify(listing),
    })
    assert.equal(listed.status, 201, await listed.clone().text())

    const purchaseOperationKey = 'purchase:artifact:2:1'
    const purchaseNonce = `0x${'6'.repeat(64)}`
    await preserveSettledX402({
      operationKey: purchaseOperationKey, operationKind: 'purchase', payee: SELLER_WALLET,
      amountUnits: '500000', resource: 'https://1f3ea.com/api/buy/1',
      nonce: purchaseNonce, txHash: PURCHASE_TX,
    })
    harnessState.authorizationNonce = purchaseNonce
    harnessState.chain = {
      transferBlockTime: new Date(), finalityArrivesAt: new Date(Date.now() - 1),
      amountUnits: 500_000n, fromWallet: BUYER_WALLET, toWallet: SELLER_WALLET,
    }
    const bought = await app.request('/api/buy/1', { method: 'POST', headers })
    assert.equal(bought.status, 200, await bought.clone().text())

    const links = await connectedDatabase().query<{
      fee_link: string
      purchase_link: string
      fee_status: string
      purchase_status: string
    }>(`
      SELECT fee.x402_payment_operation_key AS fee_link,
        purchase.x402_payment_operation_key AS purchase_link,
        fee_attempt.status AS fee_status, purchase_attempt.status AS purchase_status
      FROM fees fee
      JOIN x402_payment_attempts fee_attempt
        ON fee_attempt.operation_key = fee.x402_payment_operation_key
      CROSS JOIN purchases purchase
      JOIN x402_payment_attempts purchase_attempt
        ON purchase_attempt.operation_key = purchase.x402_payment_operation_key
      WHERE lower(fee.tx_hash) = lower($1) AND lower(purchase.tx_hash) = lower($2)
    `, [LISTING_TX, PURCHASE_TX])
    assert.deepEqual(links.rows[0], {
      fee_link: listingOperationKey, purchase_link: purchaseOperationKey,
      fee_status: 'verified', purchase_status: 'verified',
    })
  })
}
