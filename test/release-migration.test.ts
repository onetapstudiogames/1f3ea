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
    async migrate(statements) {
      calls.push(`migrate:${statements.length}`)
    },
    async missingPostconditions(postconditions) {
      calls.push(`verify:${postconditions.length}`)
      return []
    },
  }

  const result = await executeReleaseMigration(run, database)
  assert.deepEqual(calls.map(call => call.split(':')[0]), ['identify', 'migrate', 'verify'])
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
    async migrate() { migrated = true },
    async missingPostconditions() { return [] },
  }

  await assert.rejects(() => executeReleaseMigration(run, database), /connected database.*market_preview/i)
  assert.equal(migrated, false)
})

test('execution fails if any required object is absent after the transaction', async () => {
  const run = resolveReleaseMigration([
    '--target', 'production',
    '--migration', 'hosted-market-signin',
    '--database', 'market',
    '--endpoint', PRODUCTION_HOST,
  ], productionEnvironment())
  const database: MigrationDatabase = {
    async identify() { return { databaseName: 'market' } },
    async migrate() {},
    async missingPostconditions() { return ['table:oauth_tokens'] },
  }

  await assert.rejects(
    () => executeReleaseMigration(run, database),
    /migration postconditions failed.*oauth_tokens/i,
  )
})

test('release SQL is additive and the direct-payment delta matches the live schema contract', async () => {
  const [direct, oauth] = await Promise.all([
    readFile(new URL('../db/migrations/20260823_direct_payments.sql', import.meta.url), 'utf8'),
    readFile(new URL('../db/migrations/20260822_hosted_market_signin.sql', import.meta.url), 'utf8'),
  ])
  assert.match(direct, /CREATE TABLE IF NOT EXISTS direct_purchase_intents/)
  assert.match(direct, /ADD COLUMN IF NOT EXISTS direct_purchase_intent_id/)
  assert.match(direct, /purchases_direct_intent_listing_fk/)
  assert.match(direct, /purchases_direct_intent_unique/)
  for (const sql of [direct, oauth]) {
    assert.doesNotMatch(sql, /\b(?:DROP TABLE|DROP COLUMN|TRUNCATE|DELETE FROM)\b/i)
    assert.doesNotMatch(sql, /^\s*(?:BEGIN|COMMIT|ROLLBACK)\b/im)
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

  assert.match(runbook, /PREVIEW_DATABASE_URL_UNPOOLED/)
  assert.match(runbook, /PRODUCTION_DATABASE_URL_UNPOOLED/)
  assert.match(runbook, /--database <expected-database>/)
  assert.match(runbook, /--endpoint <exact-non-pooled-hostname>/)
  assert.match(runbook, /--production-endpoint <exact-production-hostname>/)
  assert.match(runbook, /CONFIRM_MARKET_PREVIEW_MIGRATION=APPLY_ADDITIVE_MARKET_SCHEMA_TO_ISOLATED_PREVIEW/)
  assert.match(runbook, /CONFIRM_MARKET_PRODUCTION_MIGRATION=APPLY_ADDITIVE_MARKET_SCHEMA_TO_PRODUCTION/)
  assert.ok(
    runbook.indexOf('migrate:preview:direct-payments') <
    runbook.indexOf('migrate:production:direct-payments'),
  )
})
