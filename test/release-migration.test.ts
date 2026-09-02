import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  PREVIEW_MIGRATION_ACKNOWLEDGEMENT,
  PRODUCTION_MIGRATION_ACKNOWLEDGEMENT,
  executeReleaseMigration,
  resolveReleaseMigration,
  splitMigrationSql,
  type MigrationDatabase,
} from '../scripts/release-migrate.ts'

const PREVIEW_HOST = 'ep-market-preview.us-east-2.aws.neon.tech'
const PRODUCTION_HOST = 'ep-market-production.us-east-2.aws.neon.tech'
const PREVIEW_URL = `postgresql://market:private@${PREVIEW_HOST}/market_preview?sslmode=require`
const PRODUCTION_URL = `postgresql://market:private@${PRODUCTION_HOST}/market?sslmode=require`

function previewEnvironment(overrides: Record<string, string | undefined> = {}) {
  return {
    PREVIEW_DATABASE_URL_UNPOOLED: PREVIEW_URL,
    CONFIRM_MARKET_PREVIEW_MIGRATION: PREVIEW_MIGRATION_ACKNOWLEDGEMENT,
    ...overrides,
  }
}

function productionEnvironment(overrides: Record<string, string | undefined> = {}) {
  return {
    PRODUCTION_DATABASE_URL_UNPOOLED: PRODUCTION_URL,
    CONFIRM_MARKET_PRODUCTION_MIGRATION: PRODUCTION_MIGRATION_ACKNOWLEDGEMENT,
    ...overrides,
  }
}

test('release migrations require an explicit target, named migration, database, and endpoint', () => {
  const environment = previewEnvironment()
  for (const args of [
    [],
    ['--target', 'preview'],
    ['--target', 'preview', '--migration', 'direct-payments'],
    ['--target', 'preview', '--migration', 'direct-payments', '--database', 'market_preview'],
  ]) {
    assert.throws(() => resolveReleaseMigration(args, environment))
  }
})

test('release migrations reject unknown and repeated safety arguments', () => {
  const base = [
    '--target', 'preview',
    '--migration', 'direct-payments',
    '--database', 'market_preview',
    '--endpoint', PREVIEW_HOST,
    '--production-endpoint', PRODUCTION_HOST,
  ]
  assert.throws(
    () => resolveReleaseMigration([...base, '--targte', 'preview'], previewEnvironment()),
    /unknown argument/i,
  )
  assert.throws(
    () => resolveReleaseMigration([...base, '--target', 'production'], previewEnvironment()),
    /must appear exactly once/i,
  )
  assert.throws(
    () => resolveReleaseMigration([
      ...base.slice(0, base.indexOf('--database')),
      '--database=market_preview',
      ...base.slice(base.indexOf('--database')),
    ], previewEnvironment()),
    /must appear exactly once/i,
  )
})

test('preview uses only its direct URL and refuses the production endpoint', () => {
  const args = [
    '--target', 'preview',
    '--migration', 'direct-payments',
    '--database', 'market_preview',
    '--endpoint', PREVIEW_HOST,
    '--production-endpoint', PRODUCTION_HOST,
  ]
  const run = resolveReleaseMigration(args, previewEnvironment())
  assert.equal(run.target, 'preview')
  assert.equal(run.migrationFile, 'db/migrations/20260823_direct_payments.sql')
  assert.equal(run.databaseName, 'market_preview')
  assert.equal(run.endpoint, PREVIEW_HOST)
  assert.equal(run.databaseUrl, PREVIEW_URL)

  assert.throws(
    () => resolveReleaseMigration(
      args.map(value => value === PREVIEW_HOST ? PRODUCTION_HOST : value),
      previewEnvironment({ PREVIEW_DATABASE_URL_UNPOOLED: PRODUCTION_URL }),
    ),
    /preview endpoint must differ from production/i,
  )
})

test('world payment finality is registered for guarded preview and production targets', () => {
  const preview = resolveReleaseMigration([
    '--target', 'preview',
    '--migration', 'world-payment-finality',
    '--database', 'market_preview',
    '--endpoint', PREVIEW_HOST,
    '--production-endpoint', PRODUCTION_HOST,
  ], previewEnvironment())
  assert.equal(preview.migrationFile, 'db/migrations/20260827_world_payment_finality.sql')
  assert.ok(preview.postconditions.some(item => item.kind === 'table' && item.name === 'world_payment_attempts'))
  assert.ok(preview.postconditions.some(item =>
    item.kind === 'column' && item.table === 'purchases' && item.name === 'world_payment_attempt_id'))
  assert.deepEqual(
    Object.fromEntries(['table', 'column', 'index', 'constraint', 'function', 'trigger'].map(kind => [
      kind,
      preview.postconditions.filter(item => item.kind === kind).length,
    ])),
    { table: 2, column: 56, index: 11, constraint: 52, function: 14, trigger: 15 },
  )
  assert.ok(preview.postconditions.some(item =>
    item.kind === 'column' && item.table === 'listing_fee_attempts'
      && item.name === 'maximum_block_time'))
  assert.ok(preview.postconditions.some(item =>
    item.kind === 'function' && item.name === 'claim_payment_use'
      && item.contains === 'listing_fee_attempt_id'))
  const moneyDefinitions = preview.postconditions.filter(item =>
    ['index', 'constraint', 'function', 'trigger'].includes(item.kind))
  assert.equal(moneyDefinitions.length, 92)
  assert.equal(moneyDefinitions.every(item =>
    'definitionSha256' in item && /^[0-9a-f]{64}$/u.test(item.definitionSha256 ?? '')), true)
  assert.ok(preview.postconditions.some(item =>
    item.kind === 'column' && item.table === 'fees' && item.name === 'verification_method'
      && item.dataType === 'text' && item.notNull === true
      && Object.hasOwn(item, 'defaultExpression') && item.defaultExpression === null))
  for (const name of [
    'purchases_claim_requires_direct_payment_intent',
    'fees_new_rows_not_legacy',
  ]) {
    assert.ok(preview.postconditions.some(item =>
      item.kind === 'constraint' && item.name === name && item.validated === false))
  }
  assert.ok(preview.postconditions.some(item =>
    item.kind === 'index' && item.name === 'world_payment_attempts_tx_owner_unique'
      && item.unique === true && item.definitionIncludes?.includes('needs_review')))
  assert.ok(preview.postconditions.some(item =>
    item.kind === 'constraint' && item.table === 'fees'
      && item.name === 'fees_verification_method_link'
      && item.definitionIncludes?.includes('listing_fee_attempt_id is not null')))
  assert.ok(preview.postconditions.some(item =>
    item.kind === 'trigger' && item.table === 'purchases'
      && item.name === 'payment_use_claim' && item.functionName === 'claim_payment_use'
      && item.enabled === 'O' && item.definitionIncludes?.includes('before insert')))

  const production = resolveReleaseMigration([
    '--target', 'production',
    '--migration', 'world-payment-finality',
    '--database', 'market',
    '--endpoint', PRODUCTION_HOST,
  ], productionEnvironment())
  assert.equal(production.migrationFile, preview.migrationFile)
})

test('x402 payment attempts are registered for guarded preview and production targets', () => {
  const preview = resolveReleaseMigration([
    '--target', 'preview',
    '--migration', 'x402-payment-attempts',
    '--database', 'market_preview',
    '--endpoint', PREVIEW_HOST,
    '--production-endpoint', PRODUCTION_HOST,
  ], previewEnvironment())

  assert.equal(preview.migrationFile, 'db/migrations/20260828_x402_payment_attempts.sql')
  const expectedObjectIds = [
    'table:x402_payment_attempts',
    'column:x402_payment_attempts.operation_key',
    'column:x402_payment_attempts.operation_kind',
    'column:x402_payment_attempts.proof_digest',
    'column:x402_payment_attempts.requirements_digest',
    'column:x402_payment_attempts.network',
    'column:x402_payment_attempts.asset',
    'column:x402_payment_attempts.payer_wallet',
    'column:x402_payment_attempts.payee_wallet',
    'column:x402_payment_attempts.amount_units',
    'column:x402_payment_attempts.resource',
    'column:x402_payment_attempts.authorization_nonce',
    'column:x402_payment_attempts.authorization_valid_after',
    'column:x402_payment_attempts.authorization_valid_before',
    'column:x402_payment_attempts.start_block',
    'column:x402_payment_attempts.status',
    'column:x402_payment_attempts.tx_hash',
    'column:x402_payment_attempts.review_reason',
    'column:x402_payment_attempts.operation_started_at',
    'column:x402_payment_attempts.settlement_started_at',
    'column:x402_payment_attempts.settled_at',
    'column:x402_payment_attempts.finalized_block_number',
    'column:x402_payment_attempts.finalized_block_hash',
    'column:x402_payment_attempts.finalized_block_time',
    'column:x402_payment_attempts.finalized_at',
    'column:x402_payment_attempts.created_at',
    'column:x402_payment_attempts.updated_at',
    'column:fees.x402_payment_operation_key',
    'column:purchases.x402_payment_operation_key',
    'column:payment_uses.x402_payment_operation_key',
    'index:x402_payment_attempts.x402_payment_attempts_reconcile',
    'index:fees.fees_x402_payment_attempt_unique',
    'index:purchases.purchases_x402_payment_attempt_unique',
    'index:payment_uses.payment_uses_x402_payment_attempt_unique',
    'constraint:x402_payment_attempts.x402_payment_attempts_pkey',
    'constraint:x402_payment_attempts.x402_payment_attempts_operation_key_shape',
    'constraint:x402_payment_attempts.x402_payment_attempts_operation_kind_allowed',
    'constraint:x402_payment_attempts.x402_payment_attempts_proof_digest_key',
    'constraint:x402_payment_attempts.x402_payment_attempts_proof_digest_shape',
    'constraint:x402_payment_attempts.x402_payment_attempts_requirements_digest_shape',
    'constraint:x402_payment_attempts.x402_payment_attempts_network_base',
    'constraint:x402_payment_attempts.x402_payment_attempts_asset_usdc',
    'constraint:x402_payment_attempts.x402_payment_attempts_payer_wallet_shape',
    'constraint:x402_payment_attempts.x402_payment_attempts_payee_wallet_shape',
    'constraint:x402_payment_attempts.x402_payment_attempts_amount_range',
    'constraint:x402_payment_attempts.x402_payment_attempts_resource_size',
    'constraint:x402_payment_attempts.x402_payment_attempts_nonce_shape',
    'constraint:x402_payment_attempts.x402_payment_attempts_status_allowed',
    'constraint:x402_payment_attempts.x402_payment_attempts_tx_hash_key',
    'constraint:x402_payment_attempts.x402_payment_attempts_tx_hash_shape',
    'constraint:x402_payment_attempts.x402_payment_attempts_review_reason_size',
    'constraint:x402_payment_attempts.x402_payment_attempts_authorization_owner',
    'constraint:x402_payment_attempts.x402_payment_attempts_authorization_window',
    'constraint:x402_payment_attempts.x402_payment_attempts_operation_overlap',
    'constraint:x402_payment_attempts.x402_payment_attempts_finality_complete',
    'constraint:x402_payment_attempts.x402_payment_attempts_finality_anchor',
    'constraint:x402_payment_attempts.x402_payment_attempts_state_facts',
    'constraint:x402_payment_attempts.x402_payment_attempts_time_order',
    'constraint:fees.fees_x402_payment_attempt_fk',
    'constraint:fees.fees_x402_requires_payment_attempt',
    'constraint:purchases.purchases_x402_payment_attempt_fk',
    'constraint:purchases.purchases_x402_requires_payment_attempt',
    'constraint:payment_uses.payment_uses_x402_payment_attempt_fk',
    'constraint:payment_uses.payment_uses_one_durable_owner_v2',
    'function:protect_x402_payment_attempt_history',
    'function:protect_x402_result_link',
    'function:validate_x402_result_link',
    'function:protect_linked_payment_use',
    'function:claim_payment_use',
    'function:reserve_x402_payment_attempt_use',
    'function:validate_x402_payment_attempt_use',
    'trigger:x402_payment_attempts.x402_payment_attempts_keep_history',
    'trigger:fees.fees_x402_payment_attempt_match',
    'trigger:fees.fees_x402_result_link_immutable',
    'trigger:purchases.purchases_x402_payment_attempt_match',
    'trigger:purchases.purchases_x402_result_link_immutable',
    'trigger:payment_uses.linked_payment_use_immutable',
    'trigger:x402_payment_attempts.x402_payment_attempt_reserve_use',
    'trigger:x402_payment_attempts.x402_payment_attempt_use_matches',
    'trigger:purchases.payment_use_claim',
    'trigger:fees.payment_use_claim',
  ].sort()
  const objectId = (item: typeof preview.postconditions[number]): string =>
    item.kind === 'table' || item.kind === 'function'
      ? `${item.kind}:${item.name}`
      : `${item.kind}:${item.table}.${item.name}`
  assert.deepEqual(preview.postconditions.map(objectId).sort(), expectedObjectIds)
  assert.deepEqual(
    Object.fromEntries(['table', 'column', 'index', 'constraint', 'function', 'trigger'].map(kind => [
      kind,
      preview.postconditions.filter(item => item.kind === kind).length,
    ])),
    { table: 1, column: 29, index: 4, constraint: 30, function: 7, trigger: 10 },
  )
  const definitionObjects = preview.postconditions.filter(item =>
    item.kind === 'index' || item.kind === 'constraint'
      || item.kind === 'function' || item.kind === 'trigger')
  assert.equal(definitionObjects.length, 51)
  assert.deepEqual(
    definitionObjects.map(objectId).sort(),
    expectedObjectIds.filter(id => /^(?:index|constraint|function|trigger):/u.test(id)),
  )
  assert.equal(definitionObjects.every(item =>
    /^[0-9a-f]{64}$/u.test(item.definitionSha256 ?? '')), true)
  assert.equal(preview.postconditions.filter(item => item.kind === 'column').every(item =>
    typeof item.dataType === 'string' && typeof item.notNull === 'boolean'), true)
  assert.ok(preview.postconditions.some(item =>
    item.kind === 'column' && item.table === 'x402_payment_attempts'
      && item.name === 'status' && item.dataType === 'text' && item.notNull === true
      && item.defaultExpression === "'settling'::text"))
  assert.ok(preview.postconditions.some(item =>
    item.kind === 'index' && item.name === 'x402_payment_attempts_reconcile'
      && [
        '(updated_at, operation_key)', 'where', "'settling'::text", "'settled'::text",
        "'needs_review'::text", 'finalized_block_number is null',
      ]
        .every(fragment => item.definitionIncludes?.includes(fragment))))
  assert.ok(preview.postconditions.some(item =>
    item.kind === 'constraint' && item.name === 'x402_payment_attempts_finality_complete'
      && [
        'finalized_block_number is null', 'finalized_block_hash is null',
        'finalized_block_time is null', 'finalized_at is null',
        'finalized_block_number is not null',
        "finalized_block_hash ~ '^0x[0-9a-f]{64}$'::text",
      ].every(fragment => item.definitionIncludes?.includes(fragment))))
  assert.ok(preview.postconditions.some(item =>
    item.kind === 'constraint' && item.name === 'x402_payment_attempts_state_facts'
      && [
        "status = 'settled'::text", "status = 'verified'::text",
        'finalized_block_number is not null',
      ].every(fragment => item.definitionIncludes?.includes(fragment))))
  assert.ok(preview.postconditions.some(item =>
    item.kind === 'constraint' && item.name === 'x402_payment_attempts_time_order'
      && [
        'operation_started_at <= settlement_started_at',
        'finalized_at >= finalized_block_time',
      ].every(fragment => item.definitionIncludes?.includes(fragment))))
  assert.ok(preview.postconditions.some(item =>
    item.kind === 'function' && item.name === 'protect_x402_payment_attempt_history'
      && [
        "old.status = 'verified'", 'old.finalized_block_number is not null',
        'new.operation_started_at',
      ].every(fragment => item.containsAll?.includes(fragment))))
  assert.ok(preview.postconditions.some(item =>
    item.kind === 'trigger' && item.table === 'x402_payment_attempts'
      && item.name === 'x402_payment_attempts_keep_history'
      && item.functionName === 'protect_x402_payment_attempt_history'
      && item.enabled === 'O'
      && ['before', 'update', 'delete']
        .every(fragment => item.definitionIncludes?.includes(fragment))))
  for (const name of [
    'fees_x402_payment_attempt_fk', 'fees_x402_requires_payment_attempt',
    'purchases_x402_payment_attempt_fk', 'purchases_x402_requires_payment_attempt',
  ]) {
    assert.ok(preview.postconditions.some(item =>
      item.kind === 'constraint' && item.name === name && item.validated === false))
  }
  for (const [table, name] of [
    ['fees', 'fees_x402_payment_attempt_match'],
    ['purchases', 'purchases_x402_payment_attempt_match'],
  ]) {
    assert.ok(preview.postconditions.some(item =>
      item.kind === 'trigger' && item.table === table && item.name === name
      && item.functionName === 'validate_x402_result_link' && item.deferred === true))
  }

  const production = resolveReleaseMigration([
    '--target', 'production',
    '--migration', 'x402-payment-attempts',
    '--database', 'market',
    '--endpoint', PRODUCTION_HOST,
  ], productionEnvironment())
  assert.equal(production.migrationFile, preview.migrationFile)

  assert.throws(
    () => resolveReleaseMigration([
      '--target', 'preview',
      '--migration', 'x402-payment-attempt',
      '--database', 'market_preview',
      '--endpoint', PREVIEW_HOST,
      '--production-endpoint', PRODUCTION_HOST,
    ], previewEnvironment()),
    /--migration.*x402-payment-attempts/i,
  )
})

test('production needs its own exact acknowledgement and target facts', () => {
  const args = [
    '--target', 'production',
    '--migration', 'hosted-market-signin',
    '--database', 'market',
    '--endpoint', PRODUCTION_HOST,
  ]
  assert.throws(
    () => resolveReleaseMigration(args, productionEnvironment({
      CONFIRM_MARKET_PRODUCTION_MIGRATION: 'yes',
    })),
    /CONFIRM_MARKET_PRODUCTION_MIGRATION/,
  )

  const run = resolveReleaseMigration(args, productionEnvironment())
  assert.equal(run.target, 'production')
  assert.equal(run.migrationFile, 'db/migrations/20260822_hosted_market_signin.sql')
  assert.equal(run.databaseUrl, PRODUCTION_URL)
})

test('merchant identity has its own guarded additive release migration', () => {
  const run = resolveReleaseMigration([
    '--target', 'production',
    '--migration', 'market-identity',
    '--database', 'market',
    '--endpoint', PRODUCTION_HOST,
  ], productionEnvironment())
  assert.equal(run.migration, 'market-identity')
  assert.equal(run.migrationFile, 'db/migrations/20260827_market_identity.sql')
  for (const object of [
    'pending_merchant_registrations',
    'pending_merchant_registration_recovery_codes',
    'merchant_recovery_codes',
    'merchant_recovery_ceremony_results',
    'merchant_recovery_ceremony_results_expiry',
    'merchant_key_rotations',
    'oauth_authorization_request_recovery_codes',
  ]) {
    assert.ok(run.postconditions.some(condition => condition.name === object), object)
  }
  assert.ok(run.postconditions.some(condition =>
    condition.kind === 'column' && condition.table === 'merchants' &&
    condition.name === 'recovery_generation'))
  for (const [table, name] of [
    ['merchant_recovery_codes', 'merchant_recovery_codes_ceremony_state'],
    ['merchant_recovery_codes', 'merchant_recovery_codes_expiry_window'],
    ['merchant_recovery_ceremony_results', 'merchant_recovery_ceremony_results_outcome_allowed'],
    ['merchant_recovery_ceremony_results', 'merchant_recovery_ceremony_results_retention_window'],
    ['merchant_identity_rate_limits', 'merchant_identity_rate_limits_attempt_kind_allowed'],
    ['oauth_authorization_requests', 'oauth_authorization_requests_intent_allowed'],
    ['oauth_authorization_requests', 'oauth_authorization_requests_identity_values'],
    ['oauth_authorization_requests', 'oauth_authorization_requests_identity_state'],
    ['oauth_authorization_requests', 'oauth_authorization_requests_key_confirmation_time'],
  ] as const) {
    assert.ok(run.postconditions.some(condition =>
      condition.kind === 'constraint' && condition.table === table && condition.name === name), name)
  }
})

test('coding-client identity has its own guarded additive release migration, separate from market-identity', () => {
  const run = resolveReleaseMigration([
    '--target', 'production',
    '--migration', 'market-coding-identity',
    '--database', 'market',
    '--endpoint', PRODUCTION_HOST,
  ], productionEnvironment())
  assert.equal(run.migration, 'market-coding-identity')
  assert.equal(run.migrationFile, 'db/migrations/20260902_market_identity_json_doors.sql')
  assert.ok(run.postconditions.some(condition =>
    condition.kind === 'table' && condition.name === 'merchant_pairing_codes'))
  for (const name of ['id', 'merchant_id', 'code_hash', 'created_at', 'expires_at', 'used_at', 'invalidated_at']) {
    assert.ok(run.postconditions.some(condition =>
      condition.kind === 'column' && condition.table === 'merchant_pairing_codes' && condition.name === name), name)
  }
  for (const name of ['merchant_pairing_codes_merchant', 'merchant_pairing_codes_expiry']) {
    assert.ok(run.postconditions.some(condition =>
      condition.kind === 'index' && condition.table === 'merchant_pairing_codes' && condition.name === name), name)
  }
  assert.ok(run.postconditions.some(condition =>
    condition.kind === 'constraint' && condition.table === 'merchant_identity_rate_limits'
      && condition.name === 'merchant_identity_rate_limits_attempt_kind_allowed'
      && condition.definitionIncludes?.includes('pair_create')))

  const preview = resolveReleaseMigration([
    '--target', 'preview',
    '--migration', 'market-coding-identity',
    '--database', 'market_preview',
    '--endpoint', PREVIEW_HOST,
    '--production-endpoint', PRODUCTION_HOST,
  ], previewEnvironment())
  assert.equal(preview.migrationFile, run.migrationFile)
})

test('target resolution rejects pooled, mismatched, and generic database connections', () => {
  const args = [
    '--target', 'production',
    '--migration', 'direct-payments',
    '--database', 'market',
    '--endpoint', PRODUCTION_HOST,
  ]
  assert.throws(
    () => resolveReleaseMigration(args, productionEnvironment({
      PRODUCTION_DATABASE_URL_UNPOOLED: PRODUCTION_URL.replace('ep-market-', 'ep-market-pooler-'),
    })),
    /direct, non-pooled/i,
  )
  assert.throws(
    () => resolveReleaseMigration(args, productionEnvironment({
      PRODUCTION_DATABASE_URL_UNPOOLED: PRODUCTION_URL.replace('/market?', '/other?'),
    })),
    /database name does not match/i,
  )
  assert.throws(
    () => resolveReleaseMigration(args, productionEnvironment({
      PRODUCTION_DATABASE_URL_UNPOOLED: PRODUCTION_URL.replace(PRODUCTION_HOST, PREVIEW_HOST),
    })),
    /endpoint does not match/i,
  )
  assert.throws(
    () => resolveReleaseMigration(args, {
      DATABASE_URL: PRODUCTION_URL,
      CONFIRM_MARKET_PRODUCTION_MIGRATION: PRODUCTION_MIGRATION_ACKNOWLEDGEMENT,
    }),
    /PRODUCTION_DATABASE_URL_UNPOOLED/,
  )
})

test('execution proves the connected database before one transaction and checks the result', async () => {
  const run = resolveReleaseMigration([
    '--target', 'preview',
    '--migration', 'direct-payments',
    '--database', 'market_preview',
    '--endpoint', PREVIEW_HOST,
    '--production-endpoint', PRODUCTION_HOST,
  ], previewEnvironment())
  const calls: string[] = []
  const database: MigrationDatabase = {
    async identify() {
      calls.push('identify')
      return { databaseName: 'market_preview' }
    },
    async inspect() { return [] },
    async transaction(operation) {
      calls.push('transaction:begin')
      try {
        const result = await operation(async text => {
          calls.push(text.startsWith('SELECT') ? 'verify:query' : 'migrate:query')
          return text.startsWith('SELECT') ? [{ present: true }] : []
        })
        calls.push('transaction:commit')
        return result
      } catch (error) {
        calls.push('transaction:rollback')
        throw error
      }
    },
  }

  const result = await executeReleaseMigration(run, database)
  assert.equal(calls[0], 'identify')
  assert.equal(calls[1], 'transaction:begin')
  assert.ok(calls.includes('migrate:query'))
  assert.ok(calls.includes('verify:query'))
  assert.equal(calls.at(-1), 'transaction:commit')
  assert.ok(result.statementCount > 0)
  assert.ok(result.postconditionCount > 0)
})

test('execution refuses a connected database mismatch before applying SQL', async () => {
  const run = resolveReleaseMigration([
    '--target', 'production',
    '--migration', 'direct-payments',
    '--database', 'market',
    '--endpoint', PRODUCTION_HOST,
  ], productionEnvironment())
  let migrated = false
  const database: MigrationDatabase = {
    async identify() { return { databaseName: 'market_preview' } },
    async inspect() { throw new Error('inspection must not run') },
    async transaction<T>(): Promise<T> {
      migrated = true
      throw new Error('transaction must not run')
    },
  }

  await assert.rejects(() => executeReleaseMigration(run, database), /connected database.*market_preview/i)
  assert.equal(migrated, false)
})

test('x402 execution names its required migration before opening a transaction', async () => {
  const run = resolveReleaseMigration([
    '--target', 'preview',
    '--migration', 'x402-payment-attempts',
    '--database', 'market_preview',
    '--endpoint', PREVIEW_HOST,
    '--production-endpoint', PRODUCTION_HOST,
  ], previewEnvironment())
  const calls: string[] = []
  const database: MigrationDatabase = {
    async identify() {
      calls.push('identify')
      return { databaseName: 'market_preview' }
    },
    async inspect() {
      calls.push('inspect')
      return [{ present: false }]
    },
    async transaction<T>(): Promise<T> {
      calls.push('transaction')
      throw new Error('transaction must not run')
    },
  }

  await assert.rejects(
    () => executeReleaseMigration(run, database),
    /x402-payment-attempts requires world-payment-finality.*first/i,
  )
  assert.equal(calls[0], 'identify')
  assert.ok(calls.includes('inspect'))
  assert.equal(calls.includes('transaction'), false)
})

test('execution rolls back if any required object is absent before commit', async () => {
  const run = resolveReleaseMigration([
    '--target', 'production',
    '--migration', 'hosted-market-signin',
    '--database', 'market',
    '--endpoint', PRODUCTION_HOST,
  ], productionEnvironment())
  const calls: string[] = []
  const database: MigrationDatabase = {
    async identify() { return { databaseName: 'market' } },
    async inspect() { return [] },
    async transaction(operation) {
      calls.push('begin')
      try {
        const result = await operation(async text => {
          if (!text.startsWith('SELECT')) {
            calls.push('migration-change')
            return []
          }
          return [{ present: false }]
        })
        calls.push('commit')
        return result
      } catch (error) {
        calls.push('rollback')
        throw error
      }
    },
  }

  await assert.rejects(
    () => executeReleaseMigration(run, database),
    /migration postconditions failed/i,
  )
  assert.ok(calls.includes('migration-change'))
  assert.equal(calls.at(-1), 'rollback')
  assert.equal(calls.includes('commit'), false)
})

test('release SQL is additive and each delta matches the live schema contract', async () => {
  const [direct, oauth, identity, worldFinality, x402Attempts] = await Promise.all([
    readFile(new URL('../db/migrations/20260823_direct_payments.sql', import.meta.url), 'utf8'),
    readFile(new URL('../db/migrations/20260822_hosted_market_signin.sql', import.meta.url), 'utf8'),
    readFile(new URL('../db/migrations/20260827_market_identity.sql', import.meta.url), 'utf8'),
    readFile(new URL('../db/migrations/20260827_world_payment_finality.sql', import.meta.url), 'utf8'),
    readFile(new URL('../db/migrations/20260828_x402_payment_attempts.sql', import.meta.url), 'utf8'),
  ])
  assert.match(direct, /CREATE TABLE IF NOT EXISTS direct_purchase_intents/)
  assert.match(direct, /ADD COLUMN IF NOT EXISTS direct_purchase_intent_id/)
  assert.match(direct, /purchases_direct_intent_listing_fk/)
  assert.match(direct, /purchases_direct_intent_unique/)
  assert.match(identity, /ADD COLUMN IF NOT EXISTS recovery_generation/)
  assert.match(identity, /CREATE TABLE IF NOT EXISTS pending_merchant_registrations/)
  assert.match(identity, /CREATE TABLE IF NOT EXISTS oauth_authorization_request_recovery_codes/)
  assert.match(worldFinality, /CREATE TABLE IF NOT EXISTS world_payment_attempts/)
  assert.match(worldFinality, /ADD COLUMN IF NOT EXISTS world_payment_attempt_id/)
  assert.match(x402Attempts, /CREATE TABLE IF NOT EXISTS x402_payment_attempts/)
  assert.match(x402Attempts, /CREATE TRIGGER x402_payment_attempts_keep_history/)
  for (const sql of [direct, oauth, identity, worldFinality, x402Attempts]) {
    assert.doesNotMatch(sql, /\b(?:DROP TABLE|DROP COLUMN|TRUNCATE|DELETE FROM)\b/i)
    assert.doesNotMatch(sql, /^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;\s*$/im)
  }
})

test('SQL splitting keeps DO blocks and quoted semicolons intact', async () => {
  const direct = await readFile(
    new URL('../db/migrations/20260823_direct_payments.sql', import.meta.url),
    'utf8',
  )
  const statements = splitMigrationSql(direct)

  assert.equal(statements.length, 8)
  assert.ok(
    statements.some(statement => statement.includes('DO $$BEGIN IF NOT EXISTS') && statement.endsWith('END$$')),
  )
  assert.ok(
    statements.some(statement => statement.includes("conname = 'purchases_direct_intent_listing_fk'")),
  )
})

test('package and runbook expose separate guarded preview and production commands', async () => {
  const [packageText, runbook] = await Promise.all([
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
    readFile(new URL('../docs/RELEASE_MIGRATIONS.md', import.meta.url), 'utf8'),
  ])
  const scripts = (JSON.parse(packageText) as { scripts: Record<string, string> }).scripts
  assert.match(scripts['migrate:preview:direct-payments'] ?? '', /--target preview --migration direct-payments$/)
  assert.match(scripts['migrate:production:direct-payments'] ?? '', /--target production --migration direct-payments$/)
  assert.match(scripts['migrate:preview:hosted-market-signin'] ?? '', /--target preview --migration hosted-market-signin$/)
  assert.match(scripts['migrate:production:hosted-market-signin'] ?? '', /--target production --migration hosted-market-signin$/)
  assert.match(scripts['migrate:preview:market-identity'] ?? '', /--target preview --migration market-identity$/)
  assert.match(scripts['migrate:production:market-identity'] ?? '', /--target production --migration market-identity$/)
  assert.match(scripts['migrate:preview:market-coding-identity'] ?? '', /--target preview --migration market-coding-identity$/)
  assert.match(scripts['migrate:production:market-coding-identity'] ?? '', /--target production --migration market-coding-identity$/)
  assert.match(scripts['migrate:preview:world-payment-finality'] ?? '', /--target preview --migration world-payment-finality$/)
  assert.match(scripts['migrate:production:world-payment-finality'] ?? '', /--target production --migration world-payment-finality$/)
  assert.match(scripts['migrate:preview:x402-payment-attempts'] ?? '', /--target preview --migration x402-payment-attempts$/)
  assert.match(scripts['migrate:production:x402-payment-attempts'] ?? '', /--target production --migration x402-payment-attempts$/)

  assert.match(runbook, /PREVIEW_DATABASE_URL_UNPOOLED/)
  assert.match(runbook, /PRODUCTION_DATABASE_URL_UNPOOLED/)
  assert.match(runbook, /--database <expected-database>/)
  assert.match(runbook, /--endpoint <exact-non-pooled-hostname>/)
  assert.match(runbook, /--production-endpoint <exact-production-hostname>/)
  assert.match(runbook, /CONFIRM_MARKET_PREVIEW_MIGRATION=APPLY_ADDITIVE_MARKET_SCHEMA_TO_ISOLATED_PREVIEW/)
  assert.match(runbook, /CONFIRM_MARKET_PRODUCTION_MIGRATION=APPLY_ADDITIVE_MARKET_SCHEMA_TO_PRODUCTION/)
  assert.match(runbook, /after all three commands report\s+all checks passed/i)
  assert.doesNotMatch(runbook, /after both commands report/i)
  assert.ok(
    runbook.indexOf('migrate:preview:direct-payments') <
    runbook.indexOf('migrate:production:direct-payments'),
  )
  assert.match(runbook, /migrate:preview:market-coding-identity/)
  assert.match(runbook, /migrate:production:market-coding-identity/)
  assert.match(runbook, /MARKET_CODING_IDENTITY_ENABLED/)
  assert.match(runbook, /migrate:preview:world-payment-finality/)
  assert.match(runbook, /migrate:production:world-payment-finality/)
  assert.match(runbook, /migrate:preview:x402-payment-attempts/)
  assert.match(runbook, /migrate:production:x402-payment-attempts/)
  assert.ok(
    runbook.indexOf('migrate:preview:world-payment-finality') <
    runbook.indexOf('migrate:preview:x402-payment-attempts'),
  )
  assert.ok(
    runbook.indexOf('migrate:production:world-payment-finality') <
    runbook.indexOf('migrate:production:x402-payment-attempts'),
  )
  assert.match(runbook, /PAYMENT_CUSTODY_READY/)
  assert.match(runbook, /503 before facilitator, Base, or new payment-table work/)
  assert.match(runbook, /prior deployment inactive/)
  assert.match(runbook, /every table, column, index, constraint, trigger, and\s+trigger function present/)
  assert.match(runbook, /fees\.verification_method/)
  assert.match(runbook, /no prior-deployment invocation\s+for one full provider maximum function duration/)
  assert.match(runbook, /semantic runner postcondition/)
})
