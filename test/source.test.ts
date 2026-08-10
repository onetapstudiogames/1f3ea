import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { FRONTDOOR, LLMS } from '../src/door.ts'
import { AISLES } from '../src/market.ts'

const read = (path: string) => readFileSync(path, 'utf8')

test('the generated front door exactly contains the text-file source', () => {
  assert.equal(FRONTDOOR, read('src/frontdoor.txt'))
})

test('the public doors point agents to the released marketplace skill', () => {
  const skillUrl = 'https://github.com/onetapstudiogames/1f3ea-marketplace'
  for (const text of [FRONTDOOR, LLMS]) {
    assert.match(text, /A tiny free-time marketplace for AI agents only\./)
    assert.ok(text.includes(skillUrl))
    assert.doesNotMatch(text, /onetapstudiogames\/1f3ea-skill/)
  }
})

test('fresh and live schemas gain storefront fields without a storefront table', () => {
  const schema = read('db/schema.sql')
  assert.match(schema, /storefront_line\s+TEXT\s+NOT NULL\s+DEFAULT ''/)
  assert.match(schema, /aisle\s+TEXT\s+NOT NULL\s+DEFAULT 'other'/)
  assert.match(schema, /ALTER TABLE merchants\s+ADD COLUMN IF NOT EXISTS storefront_line/s)
  assert.match(schema, /ALTER TABLE listings\s+ADD COLUMN IF NOT EXISTS aisle/s)
  assert.match(schema, /WHERE aisle IS NULL/)
  assert.match(schema, /ALTER COLUMN aisle SET DEFAULT 'other'/)
  assert.match(schema, /ALTER COLUMN aisle SET NOT NULL/)
  assert.ok(schema.includes(`aisle IN ('${AISLES.join("','")}')`))
  assert.ok(schema.indexOf("ARRAY['prompt'") < schema.indexOf("ARRAY['webhook'"))
  assert.doesNotMatch(schema, /CREATE TABLE IF NOT EXISTS storefronts?\b/i)
})

test('fresh and live schemas record timestamps for both terminal listing actions', () => {
  const schema = read('db/schema.sql')
  assert.match(schema, /removed_at\s+TIMESTAMPTZ/)
  assert.match(schema, /withdrawn\s+BOOLEAN\s+NOT NULL\s+DEFAULT FALSE/)
  assert.match(schema, /withdrawn_at\s+TIMESTAMPTZ/)
  assert.match(schema, /ALTER TABLE listings\s+ADD COLUMN IF NOT EXISTS removed_at\s+TIMESTAMPTZ/s)
  assert.match(schema, /ALTER TABLE listings\s+ADD COLUMN IF NOT EXISTS withdrawn_at\s+TIMESTAMPTZ/s)
  assert.match(schema, /UPDATE listings l SET removed_at = removal\.at[\s\S]*FROM \([\s\S]*events[\s\S]*kind = 'moderation'[\s\S]*action[\s\S]*remove[\s\S]*l\.removed_at IS NULL/)
})

test('payment hashes are canonical and case-insensitively unique in both money tables', () => {
  const schema = read('db/schema.sql')
  assert.match(schema, /purchases_tx_hash_lower_unique[\s\S]*lower\(tx_hash\)/)
  assert.match(schema, /fees_tx_hash_lower_unique[\s\S]*lower\(tx_hash\)/)
  assert.match(schema, /UPDATE purchases SET tx_hash = lower\(tx_hash\)/)
  assert.match(schema, /UPDATE fees SET tx_hash = lower\(tx_hash\)/)
  assert.match(schema, /CREATE TABLE IF NOT EXISTS payment_uses/)
  assert.match(schema, /CREATE OR REPLACE FUNCTION claim_payment_use/)
  assert.match(schema, /CREATE TRIGGER payment_use_claim[\s\S]*ON fees/)
  assert.match(schema, /CREATE TRIGGER payment_use_claim[\s\S]*ON purchases/)
})

test('schema migrations run as one transaction', () => {
  const migrate = read('scripts/migrate.ts')
  assert.match(migrate, /sql\.transaction/)
  assert.doesNotMatch(migrate, /for \(const st of statements\)[\s\S]*await sql\.query/)
})

test('deployment passes the pulled database environment to either Node runtime', () => {
  const deploy = read('scripts/deploy.sh')
  assert.ok(deploy.includes('node --env-file="./$ENVFILE" --experimental-strip-types scripts/migrate.ts'))
  assert.ok(deploy.includes('node.exe --env-file="./$ENVFILE" --experimental-strip-types scripts/migrate.ts'))
  assert.doesNotMatch(deploy, /curl[^\n]*\|\s*head\s+-c/)
})

test('listing quota runtime machinery is gone and the old column has a post-deploy cleanup', () => {
  const runtime = [
    'src/core.ts', 'src/index.ts', 'src/mcp.ts', 'src/frontdoor.txt', 'src/llms.txt',
  ].map(read).join('\n')
  assert.doesNotMatch(runtime, /listings_today|QUOTAS\.listings|releaseListingQuota|one new listing per UTC day/i)
  assert.doesNotMatch(read('db/schema.sql'), /listings_today/)
  assert.match(read('db/cleanup-listing-quota.sql'), /DROP COLUMN IF EXISTS listings_today/)
})
