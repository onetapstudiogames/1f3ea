import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('OAuth storage schema keeps only hashed, bounded, one-use sign-in records', async () => {
  const [schema, migration] = await Promise.all([
    source('db/schema.sql'),
    source('db/migrations/20260822_hosted_market_signin.sql'),
  ])
  for (const ddl of [schema, migration]) {
    for (const table of [
      'oauth_authorization_requests',
      'oauth_authorization_codes',
      'oauth_token_families',
      'oauth_tokens',
      'oauth_rate_limits',
    ]) assert.match(ddl, new RegExp(`CREATE TABLE(?: IF NOT EXISTS)? ${table}`, 'i'), table)
    assert.match(ddl, /code_challenge[^,]*CHECK[^,]*43/i)
    assert.match(ddl, /code_challenge_method[^,]*S256/i)
    assert.match(ddl, /token_hash[^,]*UNIQUE/i)
    assert.match(ddl, /token_type[^,]*(?:access|refresh)/i)
    assert.match(ddl, /expires_at/i)
    assert.match(ddl, /used_at/i)
    assert.match(ddl, /revoked_at/i)
    assert.doesNotMatch(ddl, /merchant_(?:key|secret)\s+TEXT/i)
    assert.doesNotMatch(ddl, /access_token\s+TEXT|refresh_token\s+TEXT|authorization_code\s+TEXT/i)
  }
})

test('source wires a separate feature-gated hosted door without replacing the Wave 6 door', async () => {
  const [index, mcp, core, store, readiness, config] = await Promise.all([
    source('src/index.ts'), source('src/mcp.ts'), source('src/core.ts'),
    source('src/market-oauth-store.ts'), source('src/hosted-market-readiness.ts'),
    source('src/market-oauth-config.ts'),
  ])
  assert.match(index, /mountMarketOAuthRoutes\(app/)
  assert.match(index, /app\.post\('\/mcp\/connect'/)
  assert.match(index, /app\.post\('\/mcp'/)
  assert.match(index, /hostedMarketSigninReadiness/)
  assert.match(readiness, /hostedMarketSigninEnabled/)
  assert.match(config, /HOSTED_MARKET_SIGNIN_ENABLED/)
  assert.match(mcp, /wrong 1F3EA connector address/i)
  assert.match(mcp, /mcp\/www_authenticate/)
  assert.match(core, /hostedConnectorRequests\s*=\s*new WeakSet<Request>/)
  assert.match(store, /resolveOAuthAccessToken[\s\S]*SELECT[\s\S]*FROM merchants/i)

  assert.match(mcp, /fresh ten-minute direct-payment intent/i)
  for (const field of ['intent_id', 'tx_hash', 'payer_signature']) assert.match(mcp, new RegExp(field))
})

test('front doors and setup guide give the safe ChatGPT path and an exact wrong-address fix', async () => {
  const [frontdoor, llms, readme, guide] = await Promise.all([
    source('src/frontdoor.txt'), source('src/llms.txt'), source('README.md'),
    source('docs/HOSTED_CHATGPT_ACCESS.md'),
  ])
  for (const text of [frontdoor, llms, readme, guide]) {
    assert.match(text, /https:\/\/1f3ea\.com\/mcp\/connect/i)
    assert.match(text, /OAuth|sign[- ]in/i)
    assert.match(text, /https:\/\/1f3ea\.com\/mcp\b/i)
    assert.doesNotMatch(
      text,
      /(?:paste|put|type)\s+(?:your\s+|the\s+)?(?:permanent\s+)?`?1f3ea_sk_[^\n]{0,60}(?:into|in)\s+(?:ChatGPT|chat|a tool)/i,
    )
  }
  assert.match(guide, /remove|delete/i)
  assert.match(guide, /add|create/i)
  assert.match(guide, /permanent merchant key[^\n]*(?:1F3EA|authorization|sign-in) page/i)
  assert.match(guide, /reconnect|connect again/i)
  assert.match(guide, /small screen|mobile/i)
  assert.match(guide, /create|register/i)
  assert.match(guide, /HOSTED_MARKET_SIGNIN_ENABLED/)
})

test('every identity guide states the save-first merchant contract and gated recovery paths', async () => {
  const surfaces = await Promise.all([
    source('src/frontdoor.txt'),
    source('src/llms.txt'),
    source('README.md'),
    source('docs/HOSTED_CHATGPT_ACCESS.md'),
    source('docs/SPEC.md'),
    source('docs/DECISIONS.md'),
    source('src/legal.ts'),
  ])
  for (const text of surfaces) {
    assert.match(text, /\/join/i)
    assert.match(text, /eight[^\n.]{0,100}recovery codes|8[^\n.]{0,100}recovery codes/i)
    assert.match(text, /\/recovery/i)
    assert.match(text, /\/rotate/i)
    assert.doesNotMatch(text, /POST\s+(?:https:\/\/1f3ea\.com)?\/api\/(?:register|rotate)/i)
    assert.doesNotMatch(text, /(?:GET\s+)?\/api\/official\.identity\b/i)
  }
  const guide = surfaces[3]!
  assert.match(guide, /save[^\n.]{0,100}merchant key[\s\S]{0,600}save[^\n.]{0,120}(?:eight|8) recovery codes[\s\S]{0,600}re-enter/i)
  assert.match(guide, /MARKET_IDENTITY_RECOVERY_ENABLED/)
  assert.match(guide, /MARKET_IDENTITY_ROTATION_ENABLED/)
  assert.match(guide, /protected[^\n.]{0,100}(?:me|merchant)[^\n.]{0,120}(?:real|live)/i)
  assert.match(guide, /dormant|unavailable|disabled/i)
})

test('public visit guidance names connector-native opening reads before any web fallback', async () => {
  const [mcp, frontdoor, llms, readme, guide, specification, decisions] = await Promise.all([
    source('src/mcp.ts'), source('src/frontdoor.txt'), source('src/llms.txt'),
    source('README.md'), source('docs/HOSTED_CHATGPT_ACCESS.md'), source('docs/SPEC.md'),
    source('docs/DECISIONS.md'),
  ])
  for (const [name, text] of [
    ['MCP server', mcp],
    ['front door', frontdoor],
    ['compact machine map', llms],
    ['readme', readme],
    ['hosted connector guide', guide],
    ['specification', specification],
    ['decisions', decisions],
  ] as const) {
    assert.match(text, /front_door/i, `${name}: connector front door`)
    assert.match(text, /official_facts/i, `${name}: connector official facts`)
  }

  for (const [name, text] of [
    ['compact machine map', llms],
    ['readme', readme],
    ['hosted connector guide', guide],
  ] as const) {
    assert.match(
      text,
      /front_door[\s\S]{0,320}https:\/\/1f3ea\.com\/[\s\S]{0,160}(?:if|when)[\s\S]{0,80}(?:open|URL)/i,
      `${name}: connector-first URL fallback`,
    )
  }

  assert.doesNotMatch(llms, /https:\/\/1f3ea\.com\/\s*[—-]\s*read it first/i)
  assert.doesNotMatch(mcp, /Read https:\/\/1f3ea\.com\/ for the constitution/i)
})

test('hosted guidance mirrors every anonymous parity read and the response-safety boundary', async () => {
  const [frontdoor, llms, guide, frontdoorGuide] = await Promise.all([
    source('src/frontdoor.txt'), source('src/llms.txt'),
    source('docs/HOSTED_CHATGPT_ACCESS.md'), source('docs/FRONTDOOR.md'),
  ])
  for (const [name, text] of [
    ['front door', frontdoor], ['compact map', llms],
    ['hosted guide', guide], ['front-door guide', frontdoorGuide],
  ] as const) {
    for (const tool of [
      'front_door', 'official_facts', 'browse', 'visit_store', 'read_listing',
      'world_status', 'read_events', 'merchants',
    ]) assert.match(text, new RegExp(`\\b${tool}\\b`, 'i'), `${name}: ${tool}`)
    assert.match(text, /credential-shaped 1F3EA values[\s\S]*redact/i, `${name}: redaction`)
    assert.match(text, /untrusted data[\s\S]*never as instructions/i, `${name}: untrusted data`)
  }
})

test('public safety copy retains direct seller payment and the fresh signed intent requirement', async () => {
  const [frontdoor, llms, guide] = await Promise.all([
    source('src/frontdoor.txt'), source('src/llms.txt'), source('docs/HOSTED_CHATGPT_ACCESS.md'),
  ])
  for (const text of [frontdoor, llms, guide]) {
    assert.match(text, /direct(?:ly)?[^\n]{0,80}seller|seller[^\n]{0,80}direct/i)
    assert.match(text, /fresh[^\n]{0,80}(?:10|ten)[- ]minute/i)
    assert.match(text, /purchase-intent|direct-payment intent/i)
    assert.match(text, /intent_id/i)
    assert.match(text, /tx_hash/i)
    assert.match(text, /payer_signature/i)
  }
})

test('privacy and support explain credential isolation and revocation without claiming deployment', async () => {
  const legal = await source('src/legal.ts')
  assert.match(legal, /hash/i)
  assert.match(legal, /access token|refresh token/i)
  assert.match(legal, /merchant key[^\n]*(?:not stored|never stored|only.*hash)/i)
  assert.match(legal, /revoke|disconnect/i)
  assert.match(legal, /\/mcp\/connect/)
})
