import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { FRONTDOOR, LLMS } from '../src/door.ts'
import { AISLES } from '../src/market.ts'

const read = (path: string) => readFileSync(path, 'utf8')
const PAYMENT_RELIABILITY_STANDARD = [
  '## Payment reliability',
  '',
  'Every payment-path change requires:',
  '',
  '- real-timing tests against real PostgreSQL, including chain finality later than',
  '  the intent or operation window;',
  '- adversarial refuter review before merge; and',
  '- a read-only or self-cleaning post-deploy production probe of the changed',
  '  surface.',
  '',
  'Use city PR #107 as the test model. City issue #103, market PRs #13/#20, and',
  'city PRs #115/#116 record why: mocks missed chain timing and SQL preparation,',
  'while non-production runtimes missed live-only failures.',
].join('\n')

function sourceTypeScriptFiles(directory = 'src'): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = `${directory}/${entry.name}`
    if (entry.isDirectory()) return sourceTypeScriptFiles(path)
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : []
  })
}

const FAKE_COMMIT = '0123456789abcdef0123456789abcdef01234567'

function runPreparedDeploy(dirty: boolean) {
  const temporaryRoot = tmpdir()
  const projectRoot = mkdtempSync(join(temporaryRoot, '1f3ea-deploy-gate-'))

  try {
    const scriptDirectory = join(projectRoot, 'scripts')
    const fakeBin = join(projectRoot, 'fake-bin')
    mkdirSync(scriptDirectory)
    mkdirSync(fakeBin)
    const deployScript = join(scriptDirectory, 'deploy.sh')
    copyFileSync('scripts/deploy.sh', deployScript)

    const fakeGit = join(fakeBin, 'git')
    writeFileSync(fakeGit, `#!/usr/bin/env bash
case "$1" in
  symbolic-ref) printf '%s\\n' hygiene ;;
  status)
    if [ "\${FAKE_DIRTY:-0}" = "1" ]; then printf '%s\\n' '?? leftover'; fi
    ;;
  config)
    case "$3" in
      *.remote) printf '%s\\n' origin ;;
      *.merge) printf '%s\\n' refs/heads/hygiene ;;
      *) exit 97 ;;
    esac
    ;;
  rev-parse) printf '%s\\n' '${FAKE_COMMIT}' ;;
  ls-remote) printf '%s\\t%s\\n' '${FAKE_COMMIT}' refs/heads/hygiene ;;
  *) exit 98 ;;
esac
`)
    for (const name of ['npm', 'npx']) {
      writeFileSync(join(fakeBin, name), '#!/usr/bin/env bash\nexit 0\n')
    }
    for (const name of ['git', 'npm', 'npx']) chmodSync(join(fakeBin, name), 0o755)

    const launcher = `
fake_bin="$1"
deploy_script="$2"
if command -v cygpath >/dev/null 2>&1; then
  fake_bin=$(cygpath -u "$fake_bin")
  deploy_script=$(cygpath -u "$deploy_script")
fi
PATH="$fake_bin:$PATH"
exec bash "$deploy_script" --prepare
`
    const run = spawnSync('bash', ['-c', launcher, 'deploy-test', fakeBin, deployScript], {
      encoding: 'utf8',
      env: { ...process.env, FAKE_DIRTY: dirty ? '1' : '0' },
    })
    if (run.error) throw run.error
    return { status: run.status, stdout: run.stdout, stderr: run.stderr }
  } finally {
    const relativeProject = relative(temporaryRoot, projectRoot)
    if (
      relativeProject === '' ||
      relativeProject === '..' ||
      relativeProject.startsWith(`..${sep}`) ||
      isAbsolute(relativeProject)
    ) throw new Error(`refusing to remove unexpected test path: ${projectRoot}`)
    rmSync(projectRoot, { recursive: true, force: true })
  }
}

const finalOutputLine = (output: string) => output.trimEnd().split(/\r?\n/).at(-1) ?? ''

test('the generated public doors exactly contain their text-file sources', () => {
  assert.equal(FRONTDOOR, read('src/frontdoor.txt'))
  assert.equal(LLMS, read('src/llms.txt'))
})

test('every project guide surface points to the routed human about and help pages', () => {
  const surfaces = [
    read('src/frontdoor.txt'),
    read('src/llms.txt'),
    read('README.md'),
    read('docs/SPEC.md'),
    read('docs/DECISIONS.md'),
  ]
  for (const surface of surfaces) {
    assert.match(surface, /\/about\b/u)
    assert.match(surface, /\/help\b/u)
  }

  const routes = read('src/human-pages.ts')
  for (const asset of [
    '1f3ea-icon.svg', '1f3ea-32.png', '1f3ea-180.png', '1f3ea-512.png',
  ]) assert.ok(routes.includes(asset), asset)
})

test('the public doors point agents to the released marketplace skill', () => {
  const skillUrl = 'https://github.com/onetapstudiogames/1f3ea-marketplace'
  for (const text of [FRONTDOOR, LLMS]) {
    assert.match(text, /A tiny free-time marketplace for AI agents only\./)
    assert.ok(text.includes(skillUrl))
    assert.doesNotMatch(text, /onetapstudiogames\/1f3ea-skill/)
  }
})

test('every discovery surface states the exact collection pagination contract', () => {
  const surfaces = [
    read('src/frontdoor.txt'),
    read('src/llms.txt'),
    read('README.md'),
    read('docs/SPEC.md'),
    read('docs/DECISIONS.md'),
  ]
  for (const surface of surfaces) {
    assert.match(surface, /exact total/i)
    assert.match(surface, /has_more/)
    assert.match(surface, /cursor|after_id|before_id/i)
  }
  const collectionRoutes = read('src/collection-routes.ts')
  assert.match(collectionRoutes, /\/\* public:shelves \*\/[\s\S]*count\(\*\)::int AS __total/)
  assert.match(collectionRoutes, /\/\* public:listing-comments \*\/[\s\S]*comments_next_after_id/)
  assert.match(collectionRoutes, /\/\* public:merchants \*\/[\s\S]*next_after_id/)
  assert.match(collectionRoutes, /\/\* public:events \*\/[\s\S]*next_before_id/)
  assert.match(collectionRoutes, /\/\* private:me-listings \*\/[\s\S]*listings_next_before_id/)
  assert.match(read('src/purchase-history-routes.ts'),
    /\/\* private:purchases \*\/[\s\S]*count\(\*\)::int AS __total[\s\S]*next_before_id/)
})

test('every human-window surface states the canonical sharing contract', () => {
  for (const surface of [
    read('src/frontdoor.txt'),
    read('src/llms.txt'),
    read('README.md'),
    read('docs/SPEC.md'),
    read('docs/DECISIONS.md'),
  ]) {
    assert.match(surface, /canonical public URL/i)
    assert.match(surface, /aisle.*item.*storefront/is)
    assert.match(surface, /link preview|Open Graph/i)
  }
})

test('every literal SQL row cap in the whole source tree matches the audited non-public allowlist', () => {
  const actual = Object.fromEntries(sourceTypeScriptFiles().flatMap(path => {
    const limits = [...read(path).matchAll(/\bLIMIT\s+\d+\b/g)].map(match => match[0])
    return limits.length ? [[path, limits]] : []
  }))
  assert.deepEqual(actual, {
    'src/artifact-listing-routes.ts': ['LIMIT 1'],
    'src/market-identity-progress-store.ts': ['LIMIT 2'],
    'src/market-identity-store.ts': ['LIMIT 1', 'LIMIT 1'],
    'src/market-oauth-store.ts': [
      'LIMIT 1', 'LIMIT 1', 'LIMIT 1',
      'LIMIT 50', 'LIMIT 50', 'LIMIT 50', 'LIMIT 50',
    ],
    'src/world-payment-sync.ts': ['LIMIT 1'],
    'src/x402-payment-attempts.ts': ['LIMIT 1', 'LIMIT 1'],
  })

  const identityStore = read('src/market-identity-store.ts')
  const marketRoutes = read('src/artifact-listing-routes.ts')
  assert.match(marketRoutes, /\/\* x402-listing:completed \*\/[\s\S]*?LIMIT 1/)
  const identityProgressStore = read('src/market-identity-progress-store.ts')
  assert.match(identityProgressStore, /getMerchantRotationProgress[\s\S]*?LIMIT 2/)
  assert.match(identityStore, /getMerchantRegistrationProgress[\s\S]*?LIMIT 1/)
  assert.match(identityStore, /completed = \(await sql`[\s\S]*?LIMIT 1/)
  const oauthStore = read('src/market-oauth-store.ts')
  assert.match(oauthStore, /getAuthorizationRequest[\s\S]*?LIMIT 1/)
  assert.match(oauthStore, /getAuthorizationCode[\s\S]*?LIMIT 1/)
  assert.equal((oauthStore.match(/retired_(?:codes|requests|tokens|families)[\s\S]*?LIMIT 50/g) ?? []).length, 4)
  assert.match(read('src/world-payment-sync.ts'), /priorWorldPurchase[\s\S]*?LIMIT 1/)
})

test('public market text teaches the fresh signed direct-payment flow, not tx-hash-only replay', () => {
  for (const text of [FRONTDOOR, LLMS]) {
    assert.match(text, /POST .*\/api\/purchase-intent\/:id/i)
    assert.match(text, /payer_wallet/i)
    assert.match(text, /POST .*\/api\/claim\/:id/i)
    assert.match(text, /intent_id/i)
    assert.match(text, /payer_signature/i)
    assert.doesNotMatch(text, /POST .*\/api\/claim\/:id\s+\{"tx_hash"\}/i)
  }
})

test('served and mirrored payment text contains no unimplemented payment rail', () => {
  const surfaces = [
    read('README.md'),
    read('docs/SPEC.md'),
    read('docs/DECISIONS.md'),
    read('src/frontdoor.txt'),
    read('src/door.ts'),
    read('src/llms.txt'),
    read('src/mcp.ts'),
    read('src/mcp-tool-catalog.ts'),
    read('src/legal.ts'),
  ]
  for (const surface of surfaces) {
    assert.doesNotMatch(surface, /voucher|city[ -]?credit|phase[ -]?c|credit rail|coming soon/iu)
  }
})

test('caller payment contracts state finality windows and safe retries before use', () => {
  const mcpContract = [read('src/mcp.ts'), read('src/mcp-tool-catalog.ts')].join('\n')
  for (const surface of [FRONTDOOR, LLMS, mcpContract]) {
    assert.match(surface, /one-hour|inclusive (?:one-)?hour/iu)
    assert.match(surface, /finalized head|Base finality/iu)
    assert.match(surface, /eight-second/iu)
    assert.match(surface, /do_not_pay_again/iu)
    assert.match(surface, /payment_preserved/iu)
  }

  for (const surface of [read('README.md'), read('docs/SPEC.md'), read('docs/DECISIONS.md')]) {
    assert.match(surface,
      /buyer wallet.*seller wallet|buyer.*directly.*seller|wallet-to-wallet.*buyer to seller/isu)
    assert.match(surface, /one-hour|one hour/iu)
    assert.match(surface, /finalized head|canonical finalized/iu)
    assert.match(surface, /do not pay again|do_not_pay_again|without paying again|never paid again/iu)
  }
})

test('caller x402 contracts explain saved-payment retries before payment use', () => {
  const mcpContract = [read('src/mcp.ts'), read('src/mcp-tool-catalog.ts')].join('\n')
  for (const surface of [FRONTDOOR, LLMS, mcpContract]) {
    assert.match(surface, /verified[\s\S]{0,100}(?:saved|stored)[\s\S]{0,100}before[\s\S]{0,100}settle/iu)
    assert.match(surface, /same\s+(?:endpoint|request)[\s\S]{0,100}(?:body|operation)/iu)
    assert.match(surface, /without X-PAYMENT|omit X-PAYMENT/iu)
    assert.match(surface, /canonical[\s\S]{0,60}finalized[\s\S]{0,60}Base/iu)
    assert.match(surface, /do_not_pay_again/iu)
  }

  for (const surface of [read('README.md'), read('docs/SPEC.md'), read('docs/DECISIONS.md')]) {
    assert.match(surface, /verified[\s\S]{0,100}(?:saved|stored)[\s\S]{0,100}before[\s\S]{0,100}settle/iu)
    assert.match(surface, /same\s+(?:endpoint|request)[\s\S]{0,100}(?:body|operation)/iu)
    assert.match(surface, /canonical[\s\S]{0,60}finalized[\s\S]{0,60}Base/iu)
    assert.match(surface, /do not pay again|do_not_pay_again/iu)
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

test('world ownership is an additive, strongly separated delivery channel', () => {
  const schema = read('db/schema.sql')
  assert.match(schema, /CREATE TABLE IF NOT EXISTS world_drafts/)
  assert.match(schema, /CREATE TABLE IF NOT EXISTS world_checkouts/)
  assert.match(schema, /delivery_kind\s+TEXT\s+NOT NULL\s+DEFAULT 'artifact'/)
  assert.match(schema, /delivery_kind IN \('artifact','city_ownership'\)/)
  assert.match(schema, /world_origin[\s\S]*https:\/\/1f3d9\.com/)
  assert.match(schema, /world_offer_id/)
  assert.match(schema, /world_asset_id/)
  assert.match(schema, /world_seller_handle/)
  assert.match(schema, /world_draft_id/)
  assert.match(schema, /world_state[\s\S]*'active'[\s\S]*'sold'[\s\S]*'canceled'[\s\S]*'stale'/)
  assert.match(schema, /verified_via IN \('x402','claim','free','world'\)/)
  assert.match(schema, /world_receipt\s+JSONB/)
  assert.match(schema, /world_receipt IS NOT NULL AND jsonb_typeof\(world_receipt\) = 'object'/)
  assert.match(schema, /world_checkouts_one_active_per_buyer[\s\S]*\(listing_id, merchant_id\)/)
  assert.doesNotMatch(schema, /world_checkouts_one_active_per_listing/)
  assert.match(schema, /purchases_world_checkout_listing_fk[\s\S]*FOREIGN KEY \(listing_id, world_checkout_id\)[\s\S]*REFERENCES world_checkouts\(listing_id, id\)/)
  assert.ok(schema.includes(`aisle IN ('${AISLES.join("','")}')`))
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

test('direct purchase intents are private, short-lived, exact, and claimed once', () => {
  const schema = read('db/schema.sql')
  const purchaseRoutes = read('src/artifact-purchase-routes.ts')
  assert.match(schema, /CREATE TABLE IF NOT EXISTS direct_purchase_intents/)
  assert.match(schema, /merchant_id[\s\S]*listing_id[\s\S]*payer_wallet[\s\S]*seller_wallet/)
  assert.match(schema, /network[\s\S]*asset[\s\S]*minimum_amount_usdc/)
  assert.match(schema, /challenge_nonce[\s\S]*created_at[\s\S]*expires_at/)
  assert.match(schema, /expires_at <= created_at \+ interval '10 minutes'/)
  assert.match(schema, /direct_purchase_intents_open_unique[\s\S]*claimed_at IS NULL[\s\S]*superseded_at IS NULL/)
  assert.match(schema, /direct_purchase_intents_buyer_listing_unique[\s\S]*\(merchant_id, listing_id\)/)
  assert.match(schema, /direct_purchase_intent_id/)
  assert.match(schema, /purchases_direct_intent_listing_fk[\s\S]*FOREIGN KEY \(listing_id, direct_purchase_intent_id\)[\s\S]*REFERENCES direct_purchase_intents\(listing_id, id\)/)
  assert.match(schema, /purchases_direct_intent_unique/)
  assert.match(purchaseRoutes, /INSERT INTO direct_purchase_intents[\s\S]*ON CONFLICT \(merchant_id, listing_id\) DO UPDATE/)
  assert.match(purchaseRoutes, /direct_purchase_intents\.claimed_at IS NULL[\s\S]*direct_purchase_intents\.expires_at <= EXCLUDED\.created_at/)
})

test('schema migrations run as one transaction', () => {
  const migrate = read('scripts/migrate.ts')
  assert.match(migrate, /sql\.transaction/)
  assert.doesNotMatch(migrate, /for \(const st of statements\)[\s\S]*await sql\.query/)
})

test('deployment helper only prepares an exact pushed GitHub commit for Vercel', () => {
  const deploy = read('scripts/deploy.sh')
  assert.match(deploy, /Manual production deployment is disabled\./)
  assert.match(deploy, /scripts\/deploy\.sh --prepare/)
  assert.match(deploy, /git status --porcelain/)
  assert.match(deploy, /git config --get "branch\.\$branch\.remote"/)
  assert.match(deploy, /git config --get "branch\.\$branch\.merge"/)
  assert.match(deploy, /git ls-remote/)
  assert.match(deploy, /npm run typecheck/)
  assert.match(deploy, /^npm run test:coverage$/m)
  assert.match(deploy, /^npm run test:postgres$/m)
  assert.doesNotMatch(deploy, /^npm test$/m)
  assert.match(deploy, /merg(?:e|ing).*GitHub.*main/is)
  assert.match(deploy, /Vercel.*exact.*main commit/is)
  assert.doesNotMatch(deploy, /api\.(?:vercel|porkbun)\.com/i)
  assert.doesNotMatch(deploy, /\b(?:VERCEL_TOKEN|PORKBUN_API_KEY|PORKBUN_SECRET_KEY)\b/)
  assert.doesNotMatch(deploy, /\b(?:vercel(?:@[\w.-]+)?|VC)\s+deploy\b/i)
  assert.doesNotMatch(deploy, /\bnpx\b[^\n]*\bvercel(?:@[\w.-]+)?\b/i)
  assert.doesNotMatch(deploy, /--prod\b|scripts\/(?:migrate|release-migrate)\.[a-z]+/i)
  assert.doesNotMatch(deploy, /@\{upstream\}/)
})

test('payment reliability is fail-hard in the required checks job and working standard', () => {
  const ci = read('.github/workflows/ci.yml')
  const standard = read('AGENTS.md')

  assert.ok(standard.includes(PAYMENT_RELIABILITY_STANDARD))
  assert.match(ci, /^jobs:\r?\n  checks:\r?\n    runs-on:/mu)
  assert.match(
    ci,
    /- name: Run PostgreSQL integration tests\r?\n\s+run: npm run test:postgres/u,
  )
  assert.doesNotMatch(ci, /continue-on-error:\s*true/iu)
})

test('deployment helper ends a successful prepare with GATE_EXIT=0', () => {
  const run = runPreparedDeploy(false)

  assert.equal(run.status, 0, run.stderr)
  assert.equal(finalOutputLine(run.stdout), 'GATE_EXIT=0')
})

test('deployment helper ends a rejected dirty prepare with its nonzero gate status', () => {
  const run = runPreparedDeploy(true)

  assert.equal(run.status, 1, run.stderr)
  assert.match(run.stdout, /preparation worktree must be clean/)
  assert.equal(finalOutputLine(run.stdout), 'GATE_EXIT=1')
})

test('the human window browser matrix is installed and part of the release gate', () => {
  const packageJson = JSON.parse(read('package.json')) as {
    scripts?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  const playwright = read('playwright.config.ts')
  const browserSpec = read('e2e/window.spec.ts')
  const tsconfig = read('tsconfig.json')
  const gitignore = read('.gitignore')
  const deploy = read('scripts/deploy.sh')
  const ci = read('.github/workflows/ci.yml')

  assert.equal(packageJson.scripts?.['test:e2e'], 'playwright test')
  assert.match(packageJson.devDependencies?.['@playwright/test'] ?? '', /^\^?1\.62\./)
  for (const name of [
    'phone-light', 'phone-dark', 'tablet-light',
    'tablet-dark', 'desktop-light', 'desktop-dark',
  ]) assert.match(playwright, new RegExp(`name:\\s*['"]${name}['"]`))
  for (const width of [320, 768, 1440]) assert.match(playwright, new RegExp(`width:\\s*${width}\\b`))
  assert.match(playwright, /colorScheme:\s*['"]light['"]/)
  assert.match(playwright, /colorScheme:\s*['"]dark['"]/)
  assert.match(browserSpec, /END-OF-DESCRIPTION/)
  assert.match(browserSpec, /events_has_more/)
  assert.match(browserSpec, /scrollWidth/)
  assert.match(tsconfig, /e2e\/\*\*\/\*\.ts/)
  assert.match(gitignore, /test-results\//)
  assert.match(deploy, /playwright install chromium[\s\S]*npm run test:e2e/)
  assert.match(ci, /playwright install --with-deps chromium/)
  assert.match(ci, /npm run test:e2e/)
})

test('listing edits and public edit receipts share one changed-field allowlist', () => {
  const market = read('src/market.ts')
  const listingRoutes = read('src/artifact-listing-routes.ts')
  const windowRoute = read('src/window.ts')
  const windowClient = read('src/window-client-catalog.ts')

  assert.match(market, /export const EDITABLE_LISTING_FIELDS\s*=\s*\[/)
  assert.match(listingRoutes, /import \{[\s\S]*EDITABLE_LISTING_FIELDS[\s\S]*\} from '\.\/market\.ts'/)
  assert.doesNotMatch(listingRoutes, /^const EDITABLE_LISTING_FIELDS\s*=/m)
  assert.match(windowRoute, /EDITABLE_LISTING_FIELDS/)
  assert.match(windowClient, /EDITABLE_LISTING_FIELDS/)
  assert.doesNotMatch([market, listingRoutes, windowRoute, windowClient].join('\n'), /PUBLIC_LISTING_CHANGED_FIELDS/)
})

test('listing quota runtime machinery is gone and the old column has a post-deploy cleanup', () => {
  const runtime = [
    'src/core.ts', 'src/index.ts', 'src/mcp.ts', 'src/mcp-tool-catalog.ts',
    'src/frontdoor.txt', 'src/llms.txt',
  ].map(read).join('\n')
  assert.doesNotMatch(runtime, /listings_today|QUOTAS\.listings|releaseListingQuota|one new listing per UTC day/i)
  assert.doesNotMatch(read('db/schema.sql'), /listings_today/)
  assert.match(read('db/cleanup-listing-quota.sql'), /DROP COLUMN IF EXISTS listings_today/)
})
