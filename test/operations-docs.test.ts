import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import test from 'node:test'

const root = new URL('../', import.meta.url)
const read = (path: string) => readFileSync(new URL(path, root), 'utf8')

const RUNTIME_NAMES = [
  'BASE_RPC_URL',
  'CI',
  'CITY_ORIGIN',
  'DATABASE_URL',
  'FACILITATOR_URL',
  'HOSTED_MARKET_CIMD_ORIGINS',
  'HOSTED_MARKET_OAUTH_CLIENTS',
  'HOSTED_MARKET_SIGNIN_ENABLED',
  'MAINTAINER_ID',
  'MARKET_IDENTITY_RECOVERY_ENABLED',
  'MARKET_IDENTITY_ROTATION_ENABLED',
  'NODE_ENV',
  'PAYMENT_CUSTODY_READY',
  'PUBLIC_ORIGIN',
  'TREASURY_ADDRESS',
  'VERCEL',
  'VERCEL_ENV',
] as const

const MIGRATION_NAMES = [
  'PREVIEW_DATABASE_URL_UNPOOLED',
  'PRODUCTION_DATABASE_URL_UNPOOLED',
  'CONFIRM_MARKET_PREVIEW_MIGRATION',
  'CONFIRM_MARKET_PRODUCTION_MIGRATION',
] as const

test('the environment runbook maps every application and release variable exactly once', () => {
  const runbook = read('docs/runbooks/ENVIRONMENT.md')
  const documented = [...runbook.matchAll(/^\| `([A-Z][A-Z0-9_]*)` \|/gmu)].map(match => match[1]!)

  const runtimeSource = [
    ...readdirSync(new URL('src/', root), { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.ts'))
      .map(entry => read(`src/${entry.name}`)),
    read('playwright.config.ts'),
  ].join('\n')
  const runtimeUsed = [...runtimeSource.matchAll(
    /\b(?:process\.env|environment)\.([A-Z][A-Z0-9_]*)/gu,
  )].map(match => match[1]!)
  assert.deepEqual([...new Set(runtimeUsed)].sort(), [...RUNTIME_NAMES].sort())

  const migrationSource = read('scripts/release-migration-resolution.ts')
  const migrationUsed = [...MIGRATION_NAMES].filter(name => migrationSource.includes(name))
  assert.deepEqual(migrationUsed.sort(), [...MIGRATION_NAMES].sort())

  const allUsed = [...new Set([...runtimeUsed, ...migrationUsed])]
  assert.deepEqual([...new Set(documented)].sort(), allUsed.sort())
  assert.equal(documented.length, allUsed.length)
  assert.match(runbook, /`VERCEL`[^\n]*x-vercel-forwarded-for[^\n]*rate-limit/iu)
  assert.match(runbook, /`VERCEL`[^\n]*unknown[^\n]*bucket/iu)
})

test('the docs index reaches current deployment and market-operations runbooks', () => {
  const index = read('docs/README.md')
  for (const path of [
    'runbooks/ENVIRONMENT.md',
    'runbooks/DEPLOYMENT.md',
    'runbooks/OPERATIONS.md',
    'CITY_PARITY.md',
  ]) assert.match(index, new RegExp(path.replace('.', '\\.'), 'u'), path)
  assert.match(index, /https:\/\/1f3ea\.com\/city-bridge/u)
  assert.doesNotMatch(index, /CITY_BRIDGE\.md/u)

  const deployment = read('docs/runbooks/DEPLOYMENT.md')
  assert.match(deployment, /merge[^.]*main[^.]*Vercel/isu)
  assert.match(deployment, /scripts\/deploy\.sh --prepare/iu)
  assert.match(deployment, /does not deploy/iu)
  assert.match(deployment, /git ls-tree -r HEAD --name-only \| wc -l/u)
  assert.match(deployment, /never[^.]*--no-verify/iu)
  assert.doesNotMatch(deployment, /declared-file integrity report/iu)
  assert.match(deployment, /rollback[\s\S]*reviewed pull request/iu)
  assert.match(deployment, /additive migration[^.]*not[^.]*rolled back/iu)

  const operations = read('docs/runbooks/OPERATIONS.md')
  assert.match(operations, /GET \/treasury/u)
  assert.doesNotMatch(operations, /\/api\/treasury/u)
  for (const id of [1, 2, 3, 4, 6, 8]) {
    assert.match(operations, new RegExp(`listing ${id}\\b`, 'iu'), `listing ${id}`)
  }
  assert.match(operations, /retire[^.]*replacement/iu)
  assert.match(operations, /protected[^.]*me[^.]*not (?:yet )?recorded/iu)
  for (const seed of [
    'seed/01-1f3ea-mcp-quickstart.json',
    'seed/04-price-your-artifact.json',
  ]) assert.match(operations, new RegExp(seed.replaceAll('/', '\\/').replace('.', '\\.'), 'u'), seed)
  assert.match(operations, /exact replacement listing text/iu)
  assert.match(operations, /\$KeeperToken[\s\S]*SecureString/iu)
  assert.doesNotMatch(operations, /KEEPER_MARKET_KEY|KEEPER_SELLER_WALLET/u)
  assert.match(operations, /Get-FileHash[\s\S]*CDBFDAF6645490BE7C436C8A958C949F21110DDC3B290A9B18B97962E28CB12B/u)
  assert.match(operations, /Get-FileHash[\s\S]*689E95F589E79D3C1C7ABCD1908FDCD4C7A005D6FB0E61D18FDE5008DF9CB0B0/u)
  assert.match(operations, /api\/me[\s\S]*listings_total -ne 8/iu)
  assert.match(operations, /api\/me[\s\S]*listings_total -ne 9/iu)
  assert.match(operations, /api\/listing\/1[\s\S]*original\.seller_wallet/iu)
  assert.match(operations, /api\/listing\/4[\s\S]*original\.seller_wallet/iu)
  assert.match(operations, /merchant[^.]*#1[\s\S]*one command[^.]*listing #1/iu)
  assert.match(operations, /merchant[^.]*#1[\s\S]*one command[^.]*listing #4/iu)

  const parity = read('docs/CITY_PARITY.md')
  assert.doesNotMatch(parity, /Matched in this docs PR|Open PR #/u)
  assert.match(parity, /## Rendered-route inventory/iu)
  for (const route of [
    '/', '/llms.txt', '/about', '/help', '/city-bridge', '/window',
    '/join', '/recovery', '/rotate', '/oauth/authorize', '/mcp', '/mcp/connect',
    '/privacy', '/terms', '/support', '/humans.txt', '/robots.txt',
  ]) assert.ok(parity.includes(`| \`${route}\` |`), route)

  assert.match(parity, /## Shared-surface difference table/iu)
  for (const category of [
    'Styling and typography',
    'Share images and canonical links',
    'Window presentation',
    'Reading-cost and completeness counters',
    'Loading, empty, and failure states',
    'Setup-page pattern',
    'Error-class vocabulary',
    'Accessibility and device checks',
  ]) assert.ok(parity.includes(`| ${category} |`), category)
  assert.match(parity, /market_fault[^.]*replaces[^.]*city_fault/iu)
  assert.match(parity, /Implemented and merged in PR #32[^\n]*live verification/iu)
  assert.match(parity, /Implemented in PR #33[^\n]*live verification pending/iu)
  assert.doesNotMatch(parity, /Companion PR #(?:32|33)|not (?:yet )?on `main`/iu)

  assert.match(parity, /## Mechanic × surface consistency matrix/iu)
  assert.match(
    parity,
    /Front door[^\n]*llms\.txt[^\n]*Market skill[^\n]*City skill[^\n]*Setup[^\n]*About[^\n]*Window[^\n]*System design/iu,
  )
  assert.match(parity, /city-owned[^.]*not changed|city repo[^.]*unchanged/iu)
  assert.match(deployment, /re-?audit[^.]*CITY_PARITY\.md/iu)
})

test('release migration status names every registered migration without inference', () => {
  const runbook = read('docs/RELEASE_MIGRATIONS.md')
  assert.match(runbook, /Status as of 2026-09-01/u)

  for (const migration of [
    '20260823_direct_payments.sql',
    '20260822_hosted_market_signin.sql',
    '20260827_market_identity.sql',
    '20260827_world_payment_finality.sql',
    '20260828_x402_payment_attempts.sql',
  ]) {
    assert.match(runbook, new RegExp(`${migration.replace('.', '\\.')}[^\\n]*not recorded`, 'iu'), migration)
  }
  assert.match(runbook, /route availability[^.]*does not prove[^.]*migration/isu)
})
