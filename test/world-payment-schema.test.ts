import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const freshSchema = await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8')
const migrationUrl = new URL('../db/migrations/20260827_world_payment_finality.sql', import.meta.url)
const x402MigrationUrl = new URL('../db/migrations/20260828_x402_payment_attempts.sql', import.meta.url)

test('the fresh schema ends with both exact guarded payment migrations', async () => {
  const worldMigration = await readFile(migrationUrl, 'utf8')
  const x402Migration = await readFile(x402MigrationUrl, 'utf8')
  assert.equal(freshSchema.endsWith(worldMigration + x402Migration), true)
})

test('world payment attempts durably anchor immutable transfer and finality facts', async () => {
  const migration = await readFile(migrationUrl, 'utf8')
  for (const ddl of [freshSchema, migration]) {
    assert.match(ddl, /CREATE TABLE IF NOT EXISTS world_payment_attempts/iu)
    assert.match(ddl, /world_checkout_id[\s\S]*PRIMARY KEY/iu)
    assert.match(ddl, /world_payment_attempts_tx_owner_unique/iu)
    assert.match(ddl, /world_payment_attempts_listing_owner_unique/iu)
    assert.match(ddl, /start_time[\s\S]*end_time/iu)
    assert.match(ddl, /finalized_block_number[\s\S]*finalized_block_hash[\s\S]*finalized_block_time[\s\S]*finalized_at/iu)
    assert.match(ddl, /payment_pending[\s\S]*completed[\s\S]*needs_review/iu)
    assert.match(ddl, /world_payment_attempt_terms_immutable/iu)
  }
})

test('pending world evidence reserves one market-wide payment use until atomic completion', async () => {
  const migration = await readFile(migrationUrl, 'utf8')
  for (const ddl of [freshSchema, migration]) {
    assert.match(ddl, /payment_uses[\s\S]*world_payment_attempt_id/iu)
    assert.match(ddl, /purchases[\s\S]*world_payment_attempt_id/iu)
    assert.match(ddl, /purchases_world_payment_attempt_fk/iu)
    assert.match(ddl, /claim_payment_use[\s\S]*world_payment_attempt_id/iu)
    assert.match(ddl, /purchases_world_requires_payment_attempt/iu)
    assert.match(ddl, /linked_payment_use_immutable/iu)
  }
})

test('signed direct claims reserve one transaction and require finality before delivery', async () => {
  const migration = await readFile(migrationUrl, 'utf8')
  for (const ddl of [freshSchema, migration]) {
    assert.match(ddl, /direct_purchase_intents[\s\S]*payment_tx_hash/iu)
    assert.match(ddl, /direct_purchase_intents_payment_state/iu)
    assert.match(ddl, /direct_payment_intent_reserve_use/iu)
    assert.match(ddl, /direct_payment_intent_completion_matches/iu)
    assert.match(ddl, /purchases_direct_payment_intent_match/iu)
    assert.match(ddl,
      /purchases_claim_requires_direct_payment_intent[\s\S]*verified_via <> 'claim'[\s\S]*direct_purchase_intent_id IS NOT NULL[\s\S]*NOT VALID/iu)
  }
})

test('finality review records preserve complete evidence and immutable payment terms', async () => {
  const migration = await readFile(migrationUrl, 'utf8')
  for (const ddl of [freshSchema, migration]) {
    assert.match(ddl,
      /OLD\.start_time[\s\S]*OLD\.city_block_time[\s\S]*OLD\.verified_via[\s\S]*OLD\.created_at/iu)
    assert.match(ddl,
      /needs_review[\s\S]*finalized_block_number[\s\S]*finalized_block_hash[\s\S]*finalized_block_time[\s\S]*finalized_at/iu)
    assert.match(ddl, /listing_fee_attempt_finality_complete/iu)
    assert.match(ddl,
      /OLD\.payment_status <> 'unsubmitted' OR NEW\.payment_status <> 'unsubmitted'/iu)
  }
})

test('direct listing fees keep one immutable closed payment window', async () => {
  const migration = await readFile(migrationUrl, 'utf8')
  for (const ddl of [freshSchema, migration]) {
    assert.match(ddl, /minimum_block_time[\s\S]*maximum_block_time/iu)
    assert.match(ddl,
      /maximum_block_time = minimum_block_time \+ interval '1 hour'/iu)
    assert.match(ddl,
      /finalized_block_time >= minimum_block_time[\s\S]*finalized_block_time <= maximum_block_time/iu)
    assert.match(ddl, /fees[\s\S]*verification_method/iu)
    assert.match(ddl, /fees_verification_method_allowed/iu)
    assert.match(ddl, /fees_verification_method_link/iu)
    assert.match(ddl,
      /fees_new_rows_not_legacy[\s\S]*verification_method <> 'legacy'[\s\S]*NOT VALID/iu)
  }
})

test('a finalized world purchase must match its checkout and every public receipt payment fact', async () => {
  const migration = await readFile(migrationUrl, 'utf8')
  for (const ddl of [freshSchema, migration]) {
    assert.match(ddl, /NEW\.world_checkout_id = NEW\.world_payment_attempt_id/iu)
    assert.match(ddl, /checkout\.merchant_id = NEW\.merchant_id/iu)
    assert.match(ddl, /world_receipt->>'payment_from'[\s\S]*attempt\.payer_wallet/iu)
    assert.match(ddl, /world_receipt->>'payment_to'[\s\S]*attempt\.payee_wallet/iu)
    assert.match(ddl, /world_receipt->>'city_verified_via'[\s\S]*attempt\.verified_via/iu)
    assert.match(ddl, /world_receipt->>'city_block_time'[\s\S]*attempt\.city_block_time/iu)
  }
})

test('world attempts independently reject reservations more than 60 seconds before checkout', async () => {
  const migration = await readFile(migrationUrl, 'utf8')
  for (const ddl of [freshSchema, migration]) {
    assert.match(ddl, /validate_world_payment_attempt_completion/iu)
    assert.match(ddl,
      /checkout\.id = NEW\.world_checkout_id[\s\S]*NEW\.start_time >= checkout\.created_at - interval '60 seconds'/iu)
    assert.match(ddl, /NEW\.start_time < checkout\.expires_at/iu)
  }
})

test('new x402 results require one exact terminal payment attempt while legacy rows survive', async () => {
  const migration = await readFile(x402MigrationUrl, 'utf8')
  for (const ddl of [freshSchema, migration]) {
    assert.match(ddl, /fees[\s\S]*x402_payment_operation_key/iu)
    assert.match(ddl, /purchases[\s\S]*x402_payment_operation_key/iu)
    assert.match(ddl, /fees_x402_payment_attempt_fk[\s\S]*NOT VALID/iu)
    assert.match(ddl, /purchases_x402_payment_attempt_fk[\s\S]*NOT VALID/iu)
    assert.match(ddl,
      /fees_x402_requires_payment_attempt[\s\S]*verification_method = 'x402'[\s\S]*x402_payment_operation_key IS NOT NULL[\s\S]*NOT VALID/iu)
    assert.match(ddl,
      /purchases_x402_requires_payment_attempt[\s\S]*verified_via = 'x402'[\s\S]*x402_payment_operation_key IS NOT NULL[\s\S]*NOT VALID/iu)
    assert.match(ddl, /fees_x402_payment_attempt_unique/iu)
    assert.match(ddl, /purchases_x402_payment_attempt_unique/iu)
    assert.match(ddl, /validate_x402_result_link[\s\S]*status = 'verified'/iu)
    assert.match(ddl, /attempt\.tx_hash = lower\(NEW\.tx_hash\)/iu)
    assert.match(ddl, /attempt\.amount_units = NEW\.amount_usdc \* 1000000/iu)
    assert.match(ddl, /attempt\.payee_wallet = lower\(listing\.seller_wallet\)/iu)
    assert.match(ddl, /purchase:artifact:[\s\S]*api\/buy/iu)
    assert.match(ddl, /world-listing-fee:[\s\S]*api\/world\/listing/iu)
    assert.match(ddl, /listing-fee:artifact:[\s\S]*api\/listing/iu)
    assert.match(ddl, /protect_x402_result_link/iu)
    assert.match(ddl, /payment_uses[\s\S]*x402_payment_operation_key/iu)
    assert.match(ddl, /payment_uses_one_durable_owner_v2/iu)
    assert.match(ddl, /reserve_x402_payment_attempt_use/iu)
    assert.match(ddl,
      /x402_key := to_jsonb\(NEW\)->>'x402_payment_operation_key'[\s\S]*x402_payment_operation_key = \$3[\s\S]*INTO reservation_found/iu)
  }
})

test('x402 attempts anchor signed authorization and finality to the pre-facilitator Base head', async () => {
  const migration = await readFile(x402MigrationUrl, 'utf8')
  for (const ddl of [freshSchema, migration]) {
    assert.match(ddl, /authorization_valid_after\s+BIGINT\s+NOT NULL/iu)
    assert.match(ddl, /authorization_valid_before\s+BIGINT\s+NOT NULL/iu)
    assert.match(ddl, /start_block\s+BIGINT\s+NOT NULL/iu)
    assert.match(ddl,
      /finalized_block_number >= start_block/iu)
    assert.match(ddl,
      /extract\(epoch from finalized_block_time\)[\s\S]*authorization_valid_after/iu)
    assert.match(ddl,
      /extract\(epoch from finalized_block_time\)[\s\S]*authorization_valid_before/iu)
    assert.match(ddl,
      /OLD\.authorization_valid_after[\s\S]*OLD\.authorization_valid_before[\s\S]*OLD\.start_block/iu)
  }
})

test('the world finality migration contains no future payment rail', async () => {
  const migration = await readFile(migrationUrl, 'utf8')
  assert.doesNotMatch(migration, /voucher|city[ -]?credit|phase[ -]?c/iu)
})
