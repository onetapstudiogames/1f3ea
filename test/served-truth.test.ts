import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

process.env.TREASURY_ADDRESS = '0x3b9d230c9b995fb1a10add2d63ce37437916dcfd'
process.env.PUBLIC_ORIGIN = 'https://1f3ea.com'
process.env.HOSTED_MARKET_SIGNIN_ENABLED = 'true'
process.env.MARKET_IDENTITY_RECOVERY_ENABLED = 'true'
process.env.MARKET_IDENTITY_ROTATION_ENABLED = 'true'
process.env.HOSTED_MARKET_CIMD_ORIGINS = '["https://chatgpt.com"]'
const { default: app } = await import('../src/index.ts')

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

const WITHDRAW_ITEM_CONTRACT = 'Withdrawing is permanent and idempotent. Send only the id of a listing you own; there is no custom reason. ' +
  'The public listing becomes the fixed tombstone "withdrawn by merchant". The listing fee is not refunded, ' +
  'completed sales and prior buyers\' copies are preserved, and new purchase attempts stop. An accepted x402 ' +
  'payment may still finish. A payment made before withdrawal for a fresh signed direct-payment intent remains ' +
  'claimable only when it landed inside that intent\'s window. A maintainer-removed listing cannot be withdrawn. ' +
  'A sold city-ownership listing cannot be withdrawn because its market receipt is permanent. Withdrawing an unsold ' +
  'city-ownership listing cancels the market listing but does not unlock the city thing; use the returned city_cancel_url separately.'
const HOSTED_PROOF_CONTRACT = 'When official facts publishes hosted_connector, hosted discovery works without sign-in. Protected merchant use for a host is ' +
  'proven only after that host completes and records a real protected me read. Recorded proven hosts: none.'

function mcpRequest(method: string, params?: unknown) {
  return app.request('/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
}

test('every public fee surface states the uncapped logged shopkeeper exception', async () => {
  const toolsResponse = await mcpRequest('tools/list')
  const toolsBody = await toolsResponse.json() as {
    result: { tools: Array<{ name: string; description: string }> }
  }
  const toolCopy = toolsBody.result.tools
    .filter(tool => tool.name === 'list_item' || tool.name === 'list_world')
    .map(tool => tool.description)
    .join('\n')
  const surfaces = [
    await (await app.request('/')).text(),
    await (await app.request('/llms.txt')).text(),
    await (await app.request('/terms')).text(),
    await (await app.request('/window')).text(),
    await (await app.request('/city-bridge')).text(),
    read('docs/FRONTDOOR.md'),
    read('docs/SPEC.md'),
    read('docs/DECISIONS.md'),
    toolCopy,
  ]

  for (const [index, surface] of surfaces.entries()) {
    assert.match(surface, /shopkeeper/iu, String(index))
    assert.match(surface, /without a cap|uncapped/iu, String(index))
    assert.match(surface, /maintainer_seed/u, String(index))
  }
})

test('official facts and MCP state the bounded city recovery contract', async () => {
  const officialResponse = await app.request('/api/official')
  assert.equal(officialResponse.status, 200)
  const official = await officialResponse.json() as { world: { payment_recovery: string } }
  assert.match(official.world.payment_recovery, /at most two hours/iu)
  assert.match(official.world.payment_recovery, /payment_pending[^;]*locked/iu)
  assert.match(official.world.payment_recovery, /payment_invalid[^,;]*canonical invalid evidence/iu)
  assert.match(official.world.payment_recovery, /payment_expired[^,;]*deadline ended without an ownership transfer/iu)
  assert.match(official.world.payment_recovery, /founder_review[^,;]*retained payment evidence/iu)
  assert.match(official.world.payment_recovery, /do not pay again/iu)
  assert.match(official.world.payment_recovery, /city seller[^;]*authenticates[^;]*POSTs \{\}[^;]*cancel URL/iu)
  assert.match(official.world.payment_recovery, /needs_review/iu)
  assert.match(official.world.payment_recovery, /records no (?:market )?sale/iu)
  assert.match(official.world.payment_recovery, /same sync|rereads/iu)

  const toolsResponse = await mcpRequest('tools/list')
  assert.equal(toolsResponse.status, 200)
  const toolsBody = await toolsResponse.json() as {
    result: { tools: Array<{ name: string; description: string }> }
  }
  const sync = toolsBody.result.tools.find(tool => tool.name === 'sync_world')
  assert.ok(sync)
  assert.match(sync.description, /at most two hours/iu)
  assert.match(sync.description, /payment_invalid/iu)
  assert.match(sync.description, /payment_expired/iu)
  assert.match(sync.description, /founder_review/iu)
  assert.match(sync.description, /all three[^.]*without a sale/iu)
  assert.match(sync.description, /city seller[^.]*authenticates[^.]*POSTs \{\}[^.]*cancel URL/iu)
})

test('every active world-contract surface names all bounded terminal city outcomes', async () => {
  const served = [
    await (await app.request('/')).text(),
    await (await app.request('/llms.txt')).text(),
    await (await app.request('/terms')).text(),
  ]
  const files = ['README.md', 'docs/SPEC.md', 'docs/DECISIONS.md'].map(read)

  for (const [index, text] of [...served, ...files].entries()) {
    assert.match(text, /at most two hours/iu, String(index))
    assert.match(text, /do not pay again|without paying again/iu, String(index))
    assert.match(text, /payment_invalid/iu, String(index))
    assert.match(text, /payment_expired/iu, String(index))
    assert.match(text, /founder_review/iu, String(index))
    assert.match(text, /no-sale|no market sale|without (?:recording )?a sale/iu, String(index))
  }
})

test('agent entry surfaces state world input values before the first write', async () => {
  const surfaces = [
    await (await app.request('/')).text(),
    await (await app.request('/llms.txt')).text(),
  ]

  for (const [index, text] of surfaces.entries()) {
    assert.match(text, /title[^\n]*3-120[^\n]*description[^\n]*1-4000[^\n]*preview[^\n]*4000/iu, String(index))
    assert.match(text, /price_usdc[^\n]*greater than 0[^\n]*at most 10,?000[^\n]*six decimal/iu, String(index))
    assert.match(text, /seller_wallet[^\n]*0x[^\n]*40 hex/iu, String(index))
    assert.match(text, /tags[^\n]*at most 8[^\n]*40 characters/iu, String(index))
    assert.match(text, /thing_id[^\n]*positive integer/iu, String(index))
    assert.match(text, /draft_id[^\n]*city_offer_id[^\n]*positive integers/iu, String(index))
    assert.match(text, /fee_tx_hash[^\n]*0x[^\n]*64 hex/iu, String(index))
    assert.match(text, /city_handle[^\n]*\^\[a-z0-9\]\[a-z0-9-\]\{2,31\}\$/iu, String(index))
    assert.match(text, /one active checkout[^\n]*buyer[^\n]*listing[^\n]*ten-minute expiry/iu, String(index))
  }
})

test('hosted-access docs describe the current provisional state, not dormant identity pages', () => {
  const hosted = read('docs/HOSTED_CHATGPT_ACCESS.md')
  const frontdoorNotes = read('docs/FRONTDOOR.md')
  const questions = read('docs/OPEN-QUESTIONS.md')
  const specification = read('docs/SPEC.md')
  const decisions = read('docs/DECISIONS.md')

  assert.match(hosted, /join.*recovery.*rotation.*enabled/isu)
  assert.ok(hosted.includes(HOSTED_PROOF_CONTRACT))
  assert.doesNotMatch(hosted, /whole identity ceremony[^.]*dormant/iu)
  assert.ok(frontdoorNotes.includes(HOSTED_PROOF_CONTRACT))
  assert.ok(specification.includes(HOSTED_PROOF_CONTRACT))
  assert.match(decisions, /operator verification/iu)
  assert.match(decisions, /protected[^.]*read[^.]*before[^.]*proven|before[^.]*proven[^.]*protected[^.]*read/iu)
  assert.doesNotMatch(decisions, /real protected hosted-client read before activation/iu)
  assert.doesNotMatch(questions, /Issue #7 hosted-access activation/u)
  assert.doesNotMatch(questions, /This PR/u)
})

test('withdraw_item states one exact complete caller contract on every mirrored surface', async () => {
  const toolsResponse = await mcpRequest('tools/list')
  const toolsBody = await toolsResponse.json() as {
    result: { tools: Array<{ name: string; description: string }> }
  }
  const withdrawal = toolsBody.result.tools.find(tool => tool.name === 'withdraw_item')
  assert.ok(withdrawal)
  assert.equal(withdrawal.description, WITHDRAW_ITEM_CONTRACT)

  for (const [name, text] of [
    ['front door', await (await app.request('/')).text()],
    ['llms', await (await app.request('/llms.txt')).text()],
    ['specification', read('docs/SPEC.md')],
  ] as const) assert.ok(text.includes(WITHDRAW_ITEM_CONTRACT), name)
})

test('public hosted surfaces publish the same empty per-host proof record', async () => {
  const official = await (await app.request('/api/official')).json() as {
    identity: { hosted_status: string; hosted_proven_hosts: string[] }
  }
  assert.equal(official.identity.hosted_status, HOSTED_PROOF_CONTRACT)
  assert.deepEqual(official.identity.hosted_proven_hosts, [])

  for (const [path, text] of [
    ['/', await (await app.request('/')).text()],
    ['/llms.txt', await (await app.request('/llms.txt')).text()],
    ['/about', await (await app.request('/about')).text()],
    ['/help', await (await app.request('/help')).text()],
    ['/privacy', await (await app.request('/privacy')).text()],
    ['/support', await (await app.request('/support')).text()],
  ] as const) {
    assert.ok(text.includes(HOSTED_PROOF_CONTRACT), path)
    assert.doesNotMatch(text, /\b(?:ChatGPT|Claude)\b/u, path)
  }
})
