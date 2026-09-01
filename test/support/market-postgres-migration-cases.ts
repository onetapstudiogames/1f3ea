import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'

import {
  BUYER_SECRET,
  BUYER_WALLET,
  PAYER_SIGNATURE,
  POSTGRES_DATABASE,
  SELLER_WALLET,
  TREASURY,
  TX_HASH,
  USDC,
  connectedDatabase,
  previousSchemaDdl,
  resetAndSeed,
  transactionalMigrationDatabase,
  x402PaymentAttemptsMigrationDdl,
  x402PaymentHeader,
  type MarketPostgresApp,
} from './market-postgres-harness.ts'

export async function runMarketPostgresMigrationCases(
  t: TestContext,
  app: MarketPostgresApp,
): Promise<void> {
  await t.test('the guarded runner upgrades legacy payment history and reruns idempotently', async () => {
    const client = connectedDatabase()
    await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
    await client.query(previousSchemaDdl)
    await client.query(`
      INSERT INTO merchants (id, handle, model, secret_hash) VALUES
        (1, 'legacy-seller', 'integration', repeat('1', 64)),
        (2, 'legacy-buyer', 'integration', repeat('2', 64));
      INSERT INTO listings (
        id, merchant_id, title, description, preview, artifact, price_usdc,
        seller_wallet, tags, aisle, dup_hash
      ) VALUES (
        1, 1, 'Legacy direct good', 'Existing claimed payment history.',
        'legacy preview', 'legacy artifact', 0.5, '${SELLER_WALLET}',
        ARRAY['test'], 'tools', repeat('a', 64)
      );
      INSERT INTO world_drafts (
        id, merchant_id, thing_id, title, description, preview, price_usdc,
        seller_wallet, tags, state
      ) VALUES (
        1, 1, 77, 'Legacy world thing', 'Existing world payment history.',
        'legacy world preview', 2, '${SELLER_WALLET}', ARRAY['world'], 'pending'
      );
      INSERT INTO listings (
        id, merchant_id, title, description, preview, artifact, price_usdc,
        seller_wallet, tags, aisle, dup_hash, delivery_kind, world_origin,
        world_offer_id, world_asset_id, world_seller_handle, world_draft_id,
        world_state
      ) VALUES (
        2, 1, 'Legacy world thing', 'Existing world payment history.',
        'legacy world preview', '', 2, '${SELLER_WALLET}', ARRAY['world'],
        'world', repeat('e', 64), 'city_ownership', 'https://1f3d9.com',
        501, 77, 'legacy-seller', 1, 'sold'
      );
      UPDATE world_drafts SET state = 'sold', listing_id = 2 WHERE id = 1;
      INSERT INTO world_checkouts (
        id, listing_id, merchant_id, city_handle, status, completed_at
      ) VALUES (1, 2, 2, 'legacy-buyer', 'completed', now());
    `)
    const legacyIntent = await client.query<{ id: number }>(`
      INSERT INTO direct_purchase_intents (
        listing_id, merchant_id, payer_wallet, seller_wallet, network, asset,
        minimum_amount_usdc, challenge_nonce, created_at, expires_at, claimed_at
      ) VALUES (
        1, 2, $1, $2, 'base', $3, 0.5, repeat('b', 64),
        now() - interval '5 minutes', now() + interval '5 minutes', now()
      ) RETURNING id
    `, [BUYER_WALLET, SELLER_WALLET, USDC.toLowerCase()])
    await client.query(`
      INSERT INTO purchases (
        listing_id, merchant_id, amount_usdc, tx_hash, verified_via
      ) VALUES (1, 2, 0.5, $1, 'claim')
    `, [`0x${'c'.repeat(64)}`])
    await client.query(`
      INSERT INTO purchases (
        listing_id, merchant_id, amount_usdc, tx_hash, verified_via,
        world_checkout_id, world_receipt
      ) VALUES (2, 2, 2, $1, 'world', 1, $2::jsonb)
    `, [
      `0x${'f'.repeat(64)}`,
      JSON.stringify({
        payment_from: BUYER_WALLET,
        payment_to: SELLER_WALLET,
        city_verified_via: 'legacy',
      }),
    ])
    await client.query(`
      INSERT INTO fees (merchant_id, listing_id, amount_usdc, tx_hash)
      VALUES (1, 1, 1, $1)
    `, [`0x${'d'.repeat(64)}`])

    const {
      executeReleaseMigration,
      missingMigrationPostconditions,
      PREVIEW_MIGRATION_ACKNOWLEDGEMENT,
      resolveReleaseMigration,
    } = await import('../../scripts/release-migrate.ts')
    const previewHost = 'ep-market-preview.us-east-2.aws.neon.tech'
    const productionHost = 'ep-market-production.us-east-2.aws.neon.tech'
    const run = resolveReleaseMigration([
      '--target', 'preview', '--migration', 'world-payment-finality',
      '--database', POSTGRES_DATABASE, '--endpoint', previewHost,
      '--production-endpoint', productionHost,
    ], {
      PREVIEW_DATABASE_URL_UNPOOLED:
        `postgresql://market:private@${previewHost}/${POSTGRES_DATABASE}?sslmode=require`,
      CONFIRM_MARKET_PREVIEW_MIGRATION: PREVIEW_MIGRATION_ACKNOWLEDGEMENT,
    })
    const migrationDatabase = transactionalMigrationDatabase(client)

    const first = await executeReleaseMigration(run, migrationDatabase)
    assert.equal(first.postconditionCount, 150)
    const legacy = await client.query<{
      payment_status: string
      verification_method: string
      direct_purchase_intent_id: number | null
      world_payment_attempt_id: number | null
    }>(`
      SELECT intent.payment_status, fee.verification_method,
        direct_purchase.direct_purchase_intent_id,
        world_purchase.world_payment_attempt_id
      FROM direct_purchase_intents intent
      CROSS JOIN fees fee
      CROSS JOIN purchases direct_purchase
      CROSS JOIN purchases world_purchase
      WHERE intent.id = $1 AND fee.tx_hash = $2
        AND direct_purchase.listing_id = 1
        AND world_purchase.listing_id = 2
    `, [legacyIntent.rows[0]!.id, `0x${'d'.repeat(64)}`])
    assert.deepEqual(legacy.rows[0], {
      payment_status: 'legacy_completed',
      verification_method: 'legacy',
      direct_purchase_intent_id: null,
      world_payment_attempt_id: null,
    })
    await assert.rejects(
      client.query(`
        INSERT INTO purchases (
          listing_id, merchant_id, amount_usdc, tx_hash, verified_via
        ) VALUES (1, 1, 0.5, $1, 'claim')
      `, [`0x${'8'.repeat(64)}`]),
      /purchases_claim_requires_direct_payment_intent|violates check constraint/iu,
    )
    await assert.rejects(
      client.query(`
        INSERT INTO fees (merchant_id, listing_id, amount_usdc, tx_hash)
        VALUES (1, 1, 1, $1)
      `, [`0x${'e'.repeat(64)}`]),
      /verification_method|null value|not-null constraint/iu,
    )
    await assert.rejects(
      client.query(`
        INSERT INTO fees (
          merchant_id, listing_id, amount_usdc, tx_hash, verification_method
        ) VALUES (1, 1, 1, $1, 'legacy')
      `, [`0x${'9'.repeat(64)}`]),
      /fees_new_rows_not_legacy|violates check constraint/iu,
    )
    await client.query(`
      INSERT INTO fees (
        merchant_id, listing_id, amount_usdc, tx_hash, verification_method
      ) VALUES (1, 1, 1, $1, 'x402')
    `, [`0x${'0'.repeat(64)}`])

    const second = await executeReleaseMigration(run, migrationDatabase)
    assert.deepEqual(second, first)
    const preserved = await client.query<{
      direct_purchase_intent_id: number | null
      world_payment_attempt_id: number | null
      verification_method: string
    }>(`
      SELECT direct_purchase.direct_purchase_intent_id,
        world_purchase.world_payment_attempt_id, fee.verification_method
      FROM purchases direct_purchase
      CROSS JOIN purchases world_purchase
      CROSS JOIN fees fee
      WHERE direct_purchase.listing_id = 1
        AND world_purchase.listing_id = 2
        AND fee.tx_hash = $1
    `, [`0x${'d'.repeat(64)}`])
    assert.deepEqual(preserved.rows[0], {
      direct_purchase_intent_id: null,
      world_payment_attempt_id: null,
      verification_method: 'legacy',
    })
  })

  await t.test('x402 settlement custody is durable, concurrent, and contains no bearer proof', async () => {
    await resetAndSeed()
    const {
      X402PaymentAttemptConflictError,
      beginX402Settlement,
      markX402SettlementNeedsReview,
      readX402PaymentAttempt,
      recordX402Settlement,
    } = await import('../../src/x402-payment-attempts.ts')
    const operationKey = `listing-fee:1:${'a'.repeat(64)}`
    const paymentHeader = x402PaymentHeader({
      payer: BUYER_WALLET,
      payee: TREASURY,
      amountUnits: '1000000',
      nonce: `0x${'4'.repeat(64)}`,
    })
    const input = {
      operationKey,
      operationKind: 'listing_fee' as const,
      operationStartedAt: new Date(Date.now() - 1_000),
      startBlock: 256n,
      paymentHeader,
      requirements: {
        network: 'base' as const,
        asset: USDC,
        payTo: TREASURY,
        maxAmountRequired: '1000000',
        resource: 'https://1f3ea.com/api/listing',
      },
    }

    const concurrent = await Promise.all([
      beginX402Settlement(input),
      beginX402Settlement(input),
    ])
    assert.deepEqual(
      concurrent.map(result => result.disposition).sort(),
      ['created', 'existing'],
    )
    const reserved = await readX402PaymentAttempt(operationKey)
    assert.equal(reserved?.status, 'settling')
    assert.equal(reserved?.payer_wallet, BUYER_WALLET)
    assert.equal(reserved?.payee_wallet, TREASURY)

    const decoded = JSON.parse(Buffer.from(paymentHeader, 'base64').toString('utf8')) as {
      x402Version: number
      scheme: string
      network: string
      payload: { signature: string; authorization: Record<string, string> }
    }
    const reorderedHeader = Buffer.from(JSON.stringify({
      network: decoded.network,
      payload: {
        authorization: {
          nonce: decoded.payload.authorization.nonce,
          validBefore: decoded.payload.authorization.validBefore,
          validAfter: decoded.payload.authorization.validAfter,
          value: decoded.payload.authorization.value,
          to: decoded.payload.authorization.to,
          from: decoded.payload.authorization.from,
        },
        signature: decoded.payload.signature,
      },
      scheme: decoded.scheme,
      x402Version: decoded.x402Version,
    })).toString('base64')
    assert.equal((await beginX402Settlement({ ...input, paymentHeader: reorderedHeader })).disposition,
      'existing')

    const reboundHeader = Buffer.from(JSON.stringify({ ...decoded, memo: 'another operation' }))
      .toString('base64')
    await assert.rejects(
      beginX402Settlement({
        ...input,
        operationKey: `purchase:2:${'b'.repeat(64)}`,
        operationKind: 'purchase',
        paymentHeader: reboundHeader,
      }),
      (error: unknown) => error instanceof X402PaymentAttemptConflictError,
    )

    const reviewed = await markX402SettlementNeedsReview({
      operationKey,
      proofDigest: reserved!.proof_digest,
      reason: 'the facilitator response did not prove whether settlement completed',
    })
    assert.equal(reviewed.status, 'needs_review')
    const settled = await recordX402Settlement({
      operationKey,
      proofDigest: reserved!.proof_digest,
      transaction: TX_HASH,
      payerWallet: BUYER_WALLET,
    })
    assert.equal(settled.status, 'settled')
    await assert.rejects(
      connectedDatabase().query(`
        UPDATE x402_payment_attempts SET amount_units = amount_units + 1
        WHERE operation_key = $1
      `, [operationKey]),
      /terms are immutable/iu,
    )
    await assert.rejects(
      connectedDatabase().query(`
        UPDATE x402_payment_attempts SET review_reason = 'changed after settlement'
        WHERE operation_key = $1
      `, [operationKey]),
      /x402_payment_attempts_state_facts|review reason is immutable/iu,
    )

    const columnNames = await connectedDatabase().query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'x402_payment_attempts'
      ORDER BY ordinal_position
    `)
    assert.doesNotMatch(columnNames.rows.map(row => row.column_name).join(' '),
      /header|signature|signed_payload/iu)
    const stored = await connectedDatabase().query<{ row_text: string }>(`
      SELECT row_to_json(attempt)::text AS row_text
      FROM x402_payment_attempts attempt WHERE operation_key = $1
    `, [operationKey])
    assert.doesNotMatch(stored.rows[0]!.row_text, new RegExp(PAYER_SIGNATURE.slice(2), 'iu'))

    const { splitMigrationSql } = await import('../../scripts/release-migrate.ts')
    const session = await connectedDatabase().connect()
    try {
      await session.query('BEGIN')
      for (const statement of splitMigrationSql(x402PaymentAttemptsMigrationDdl)) {
        await session.query(statement)
      }
      await session.query('COMMIT')
    } catch (error) {
      await session.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      session.release()
    }
    assert.equal((await readX402PaymentAttempt(operationKey))?.tx_hash, TX_HASH)
  })

  await t.test('x402 migration refuses a drifted pre-existing custody table', async () => {
    await resetAndSeed()
    await connectedDatabase().query(`
      ALTER TABLE x402_payment_attempts
      DROP CONSTRAINT x402_payment_attempts_state_facts
    `)
    const { splitMigrationSql } = await import('../../scripts/release-migrate.ts')
    const session = await connectedDatabase().connect()
    try {
      await session.query('BEGIN')
      await assert.rejects(async () => {
        for (const statement of splitMigrationSql(x402PaymentAttemptsMigrationDdl)) {
          await session.query(statement)
        }
      }, /existing x402 payment custody is incompatible/iu)
    } finally {
      await session.query('ROLLBACK').catch(() => undefined)
      session.release()
    }
  })

  await t.test('the guarded x402 runner installs every exact object on a fresh database', async () => {
    await resetAndSeed()
    const client = connectedDatabase()
    await client.query('DROP TABLE x402_payment_attempts CASCADE')
    await client.query('DROP FUNCTION protect_x402_payment_attempt_history()')
    const {
      executeReleaseMigration,
      missingMigrationPostconditions,
      resolveReleaseMigration,
      PREVIEW_MIGRATION_ACKNOWLEDGEMENT,
    } = await import('../../scripts/release-migrate.ts')
    const previewHost = 'ep-market-preview.us-east-2.aws.neon.tech'
    const productionHost = 'ep-market-production.us-east-2.aws.neon.tech'
    const run = resolveReleaseMigration([
      '--target', 'preview', '--migration', 'x402-payment-attempts',
      '--database', POSTGRES_DATABASE, '--endpoint', previewHost,
      '--production-endpoint', productionHost,
    ], {
      PREVIEW_DATABASE_URL_UNPOOLED:
        `postgresql://market:private@${previewHost}/${POSTGRES_DATABASE}?sslmode=require`,
      CONFIRM_MARKET_PREVIEW_MIGRATION: PREVIEW_MIGRATION_ACKNOWLEDGEMENT,
    })

    const result = await executeReleaseMigration(run, transactionalMigrationDatabase(client))
    assert.equal(result.postconditionCount, 81)
    assert.deepEqual(await missingMigrationPostconditions(
      run.postconditions,
      async (text, values) => (await client.query(text, [...values])).rows,
    ), [])
  })

  await t.test('a failed catalog postcondition rolls back every x402 migration change', async () => {
    await resetAndSeed()
    const client = connectedDatabase()
    await client.query('DROP TABLE x402_payment_attempts CASCADE')
    await client.query('DROP FUNCTION protect_x402_payment_attempt_history()')
    const {
      executeReleaseMigration,
      resolveReleaseMigration,
      PREVIEW_MIGRATION_ACKNOWLEDGEMENT,
    } = await import('../../scripts/release-migrate.ts')
    const previewHost = 'ep-market-preview.us-east-2.aws.neon.tech'
    const productionHost = 'ep-market-production.us-east-2.aws.neon.tech'
    const run = resolveReleaseMigration([
      '--target', 'preview', '--migration', 'x402-payment-attempts',
      '--database', POSTGRES_DATABASE, '--endpoint', previewHost,
      '--production-endpoint', productionHost,
    ], {
      PREVIEW_DATABASE_URL_UNPOOLED:
        `postgresql://market:private@${previewHost}/${POSTGRES_DATABASE}?sslmode=require`,
      CONFIRM_MARKET_PREVIEW_MIGRATION: PREVIEW_MIGRATION_ACKNOWLEDGEMENT,
    })
    const impossibleRun = {
      ...run,
      postconditions: [...run.postconditions, { kind: 'table' as const, name: 'must_not_exist' }],
    }

    await assert.rejects(
      executeReleaseMigration(impossibleRun, transactionalMigrationDatabase(client)),
      /migration postconditions failed.*must_not_exist/iu,
    )
    const rolledBack = await client.query<{
      payment_table: string | null
      history_function: string | null
    }>(`
      SELECT to_regclass('public.x402_payment_attempts')::text AS payment_table,
        to_regprocedure('public.protect_x402_payment_attempt_history()')::text
          AS history_function
    `)
    assert.deepEqual(rolledBack.rows[0], {
      payment_table: null,
      history_function: null,
    })
  })

  await t.test('x402 exact preflight refuses repairable drift before migration SQL runs', async () => {
    await resetAndSeed()
    const client = connectedDatabase()
    await client.query(`
      DO $drift$
      DECLARE definition text;
      BEGIN
        SELECT pg_get_functiondef(
          'protect_x402_payment_attempt_history()'::regprocedure
        ) INTO definition;
        EXECUTE replace(
          definition,
          'OLD.status = ''verified''',
          'OLD.status = ''settled'''
        );
      END
      $drift$;
      DROP TRIGGER x402_payment_attempts_keep_history ON x402_payment_attempts;
      CREATE TRIGGER x402_payment_attempts_keep_history
        BEFORE UPDATE OR DELETE ON x402_payment_attempts
        FOR EACH ROW WHEN (OLD.status = 'settling')
        EXECUTE FUNCTION protect_x402_payment_attempt_history();
    `)
    const before = (await client.query<{
      function_definition: string
      trigger_definition: string
    }>(`
      SELECT
        pg_get_functiondef('protect_x402_payment_attempt_history()'::regprocedure)
          AS function_definition,
        pg_get_triggerdef(trigger.oid, true) AS trigger_definition
      FROM pg_trigger trigger
      WHERE trigger.tgrelid = 'x402_payment_attempts'::regclass
        AND trigger.tgname = 'x402_payment_attempts_keep_history'
        AND NOT trigger.tgisinternal
    `)).rows[0]!
    const {
      executeReleaseMigration,
      resolveReleaseMigration,
      PREVIEW_MIGRATION_ACKNOWLEDGEMENT,
    } = await import('../../scripts/release-migrate.ts')
    const previewHost = 'ep-market-preview.us-east-2.aws.neon.tech'
    const productionHost = 'ep-market-production.us-east-2.aws.neon.tech'
    const run = resolveReleaseMigration([
      '--target', 'preview', '--migration', 'x402-payment-attempts',
      '--database', POSTGRES_DATABASE, '--endpoint', previewHost,
      '--production-endpoint', productionHost,
    ], {
      PREVIEW_DATABASE_URL_UNPOOLED:
        `postgresql://market:private@${previewHost}/${POSTGRES_DATABASE}?sslmode=require`,
      CONFIRM_MARKET_PREVIEW_MIGRATION: PREVIEW_MIGRATION_ACKNOWLEDGEMENT,
    })

    await assert.rejects(
      executeReleaseMigration(run, transactionalMigrationDatabase(client)),
      /existing migration objects drifted.*protect_x402_payment_attempt_history.*x402_payment_attempts_keep_history/iu,
    )
    const after = (await client.query<typeof before>(`
      SELECT
        pg_get_functiondef('protect_x402_payment_attempt_history()'::regprocedure)
          AS function_definition,
        pg_get_triggerdef(trigger.oid, true) AS trigger_definition
      FROM pg_trigger trigger
      WHERE trigger.tgrelid = 'x402_payment_attempts'::regclass
        AND trigger.tgname = 'x402_payment_attempts_keep_history'
        AND NOT trigger.tgisinternal
    `)).rows[0]!
    assert.deepEqual(after, before)
  })

  await t.test('every database-backed public GET executes against PostgreSQL', async () => {
    await resetAndSeed()

    const door = await app.request('/')
    assert.equal(door.status, 200)
    assert.match(await door.text(), /seller-one/u, 'the door must not hide a failed query behind its fallback')

    const windowResponse = await app.request('/api/window')
    assert.equal(windowResponse.status, 200)
    const windowBody = await windowResponse.json() as { merchant_total: number; listings_total: number }
    assert.equal(windowBody.merchant_total, 2)
    assert.equal(windowBody.listings_total, 2)

    const completeStore = await app.request('/api/store/seller-one')
    assert.equal(completeStore.status, 200)
    assert.equal(((await completeStore.json()) as { total: number }).total, 2)

    const boundedStore = await app.request('/api/store/seller-one?limit=1')
    assert.equal(boundedStore.status, 200)
    const boundedStoreBody = await boundedStore.json() as { returned: number; has_more: boolean }
    assert.equal(boundedStoreBody.returned, 1)
    assert.equal(boundedStoreBody.has_more, true)

    for (const path of ['/api/shelves?sort=new', '/api/shelves?sort=karma']) {
      const response = await app.request(path)
      assert.equal(response.status, 200, path)
      assert.equal(((await response.json()) as { total: number }).total, 2, path)
    }

    const listing = await app.request('/api/listing/1')
    assert.equal(listing.status, 200)
    assert.equal(((await listing.json()) as { comments_total: number }).comments_total, 1)

    const merchants = await app.request('/api/merchants')
    assert.equal(merchants.status, 200)
    assert.equal(((await merchants.json()) as { total: number }).total, 2)

    const events = await app.request('/api/events')
    assert.equal(events.status, 200)
    assert.equal(((await events.json()) as { total: number }).total, 2)

    const treasury = await app.request('/treasury')
    assert.equal(treasury.status, 200)
    assert.equal(((await treasury.json()) as { fees_count: number }).fees_count, 1)

    const merchantHeaders = { Authorization: `Bearer ${BUYER_SECRET}` }
    const purchases = await app.request('/api/purchases', { headers: merchantHeaders })
    assert.equal(purchases.status, 200)
    assert.deepEqual(await purchases.json(), {
      purchases: [], total: 0, returned: 0, page_size: 2,
      has_more: false, next_before_id: null,
    })

    const standing = await app.request('/api/me', { headers: merchantHeaders })
    assert.equal(standing.status, 200)
    const standingBody = await standing.json() as {
      listings_total: number; listings_returned: number; listings_page_size: number
      listings_has_more: boolean; listings_next_before_id: number | null
    }
    assert.deepEqual({
      total: standingBody.listings_total,
      returned: standingBody.listings_returned,
      pageSize: standingBody.listings_page_size,
      hasMore: standingBody.listings_has_more,
      cursor: standingBody.listings_next_before_id,
    }, { total: 0, returned: 0, pageSize: 50, hasMore: false, cursor: null })

    const draft = await app.request('/api/world/draft/1')
    assert.equal(draft.status, 200)
    assert.equal(((await draft.json()) as { draft: { status: string } }).draft.status, 'active')

    const checkout = await app.request('/api/world/checkout/1')
    assert.equal(checkout.status, 200)
    assert.equal(((await checkout.json()) as { checkout: { status: string } }).checkout.status, 'active')
  })

  await t.test('the guarded runner finds every payment migration object in real PostgreSQL', async () => {
    await resetAndSeed()
    const {
      missingMigrationPostconditions,
      resolveReleaseMigration,
      PREVIEW_MIGRATION_ACKNOWLEDGEMENT,
    } = await import('../../scripts/release-migrate.ts')
    const previewHost = 'ep-market-preview.us-east-2.aws.neon.tech'
    const productionHost = 'ep-market-production.us-east-2.aws.neon.tech'
    const run = resolveReleaseMigration([
      '--target', 'preview', '--migration', 'world-payment-finality',
      '--database', 'market_preview', '--endpoint', previewHost,
      '--production-endpoint', productionHost,
    ], {
      PREVIEW_DATABASE_URL_UNPOOLED:
        `postgresql://market:private@${previewHost}/market_preview?sslmode=require`,
      CONFIRM_MARKET_PREVIEW_MIGRATION: PREVIEW_MIGRATION_ACKNOWLEDGEMENT,
    })
    const missing = await missingMigrationPostconditions(
      run.postconditions,
      async (text, values) => (await connectedDatabase().query(text, [...values])).rows,
    )
    assert.equal(run.postconditions.length, 150)
    assert.deepEqual(missing, [])

    const expectDrift = async (statements: readonly string[], expected: string) => {
      const session = await connectedDatabase().connect()
      try {
        await session.query('BEGIN')
        for (const statement of statements) await session.query(statement)
        const drift = await missingMigrationPostconditions(
          run.postconditions,
          async (text, values) => (await session.query(text, [...values])).rows,
        )
        assert.ok(drift.includes(expected), `${expected}: ${drift.join(', ')}`)
      } finally {
        await session.query('ROLLBACK').catch(() => undefined)
        session.release()
      }
    }
    await expectDrift([
      'DROP INDEX world_payment_attempts_tx_owner_unique',
      `CREATE UNIQUE INDEX world_payment_attempts_tx_owner_unique
         ON world_payment_attempts (tx_hash) WHERE status = 'needs_review'`,
    ], 'index:world_payment_attempts.world_payment_attempts_tx_owner_unique')
    await expectDrift([
      'ALTER TABLE fees ALTER COLUMN verification_method DROP NOT NULL',
      "ALTER TABLE fees ALTER COLUMN verification_method SET DEFAULT 'legacy'",
    ], 'column:fees.verification_method')
    await expectDrift([
      'ALTER TABLE fees DROP CONSTRAINT fees_verification_method_link',
      'ALTER TABLE fees ADD CONSTRAINT fees_verification_method_link CHECK (true)',
    ], 'constraint:fees.fees_verification_method_link')
    await expectDrift([
      'ALTER TABLE world_payment_attempts DROP CONSTRAINT world_payment_attempt_window',
      `ALTER TABLE world_payment_attempts ADD CONSTRAINT world_payment_attempt_window
         CHECK (end_time > start_time OR end_time <= start_time + interval '5 minutes')`,
    ], 'constraint:world_payment_attempts.world_payment_attempt_window')
    await expectDrift([
      `DO $drift$
       DECLARE definition text;
       BEGIN
         SELECT pg_get_functiondef('claim_payment_use()'::regprocedure) INTO definition;
         EXECUTE replace(
           definition,
           'direct_purchase_intent_id IS NOT NULL',
           'direct_purchase_intent_id IS NULL'
         );
       END
       $drift$`,
    ], 'function:claim_payment_use')
    await expectDrift([
      'ALTER TABLE world_payment_attempts DISABLE TRIGGER world_payment_attempt_reserve_use',
    ], 'trigger:world_payment_attempts.world_payment_attempt_reserve_use')
  })

  await t.test('the x402 guarded runner finds all objects and rejects semantic catalog drift', async () => {
    await resetAndSeed()
    const {
      missingMigrationPostconditions,
      resolveReleaseMigration,
      PREVIEW_MIGRATION_ACKNOWLEDGEMENT,
    } = await import('../../scripts/release-migrate.ts')
    const previewHost = 'ep-market-preview.us-east-2.aws.neon.tech'
    const productionHost = 'ep-market-production.us-east-2.aws.neon.tech'
    const run = resolveReleaseMigration([
      '--target', 'preview', '--migration', 'x402-payment-attempts',
      '--database', 'market_preview', '--endpoint', previewHost,
      '--production-endpoint', productionHost,
    ], {
      PREVIEW_DATABASE_URL_UNPOOLED:
        `postgresql://market:private@${previewHost}/market_preview?sslmode=require`,
      CONFIRM_MARKET_PREVIEW_MIGRATION: PREVIEW_MIGRATION_ACKNOWLEDGEMENT,
    })
    const queryCatalog = async (text: string, values: readonly unknown[]) =>
      (await connectedDatabase().query(text, [...values])).rows

    assert.equal(run.postconditions.length, 81)
    assert.deepEqual(await missingMigrationPostconditions(run.postconditions, queryCatalog), [])

    const expectExactDrift = async (statements: readonly string[], expected: string) => {
      const session = await connectedDatabase().connect()
      try {
        await session.query('BEGIN')
        for (const statement of statements) await session.query(statement)
        const drift = await missingMigrationPostconditions(
          run.postconditions,
          async (text, values) => (await session.query(text, [...values])).rows,
        )
        assert.deepEqual(drift, [expected])
      } finally {
        await session.query('ROLLBACK').catch(() => undefined)
        session.release()
      }
    }

    await expectExactDrift([
      "ALTER TABLE x402_payment_attempts ALTER COLUMN status SET DEFAULT 'needs_review'",
    ], 'column:x402_payment_attempts.status')
    await expectExactDrift([
      'DROP INDEX x402_payment_attempts_reconcile',
      `CREATE INDEX x402_payment_attempts_reconcile
         ON x402_payment_attempts (updated_at, operation_key)
         WHERE status IN ('settling', 'settled', 'verified')`,
    ], 'index:x402_payment_attempts.x402_payment_attempts_reconcile')
    await expectExactDrift([
      'ALTER TABLE x402_payment_attempts DROP CONSTRAINT x402_payment_attempts_finality_complete',
      `ALTER TABLE x402_payment_attempts
         ADD CONSTRAINT x402_payment_attempts_finality_complete
         CHECK (finalized_block_number IS NULL OR finalized_block_number >= 0)`,
    ], 'constraint:x402_payment_attempts.x402_payment_attempts_finality_complete')
    await expectExactDrift([
      `DO $drift$
       DECLARE definition text;
       BEGIN
         SELECT pg_get_functiondef(
           'protect_x402_payment_attempt_history()'::regprocedure
         ) INTO definition;
         EXECUTE replace(
           definition,
           'OLD.status = ''verified''',
           'OLD.status = ''settled'''
         );
       END
       $drift$`,
    ], 'function:protect_x402_payment_attempt_history')
    await expectExactDrift([
      'DROP TRIGGER x402_payment_attempts_keep_history ON x402_payment_attempts',
      `CREATE TRIGGER x402_payment_attempts_keep_history
         BEFORE UPDATE OR DELETE ON x402_payment_attempts
         FOR EACH ROW WHEN (OLD.status = 'never')
         EXECUTE FUNCTION protect_x402_payment_attempt_history()`,
    ], 'trigger:x402_payment_attempts.x402_payment_attempts_keep_history')
  })

}
