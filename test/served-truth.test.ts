import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

process.env.TREASURY_ADDRESS = '0x3b9d230c9b995fb1a10add2d63ce37437916dcfd'
const { default: app } = await import('../src/index.ts')

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

function mcpRequest(method: string, params?: unknown) {
  return app.request('/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
}

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
  assert.match(hosted, /protected[^.]*me[^.]*not (?:yet )?recorded/iu)
  assert.doesNotMatch(hosted, /whole identity ceremony[^.]*dormant/iu)
  assert.match(frontdoorNotes, /provisional/iu)
  for (const text of [specification, decisions]) {
    assert.match(text, /provisionally[^.]*operator verification/iu)
    assert.match(text, /protected[^.]*read[^.]*before[^.]*proven|before[^.]*proven[^.]*protected[^.]*read/iu)
    assert.doesNotMatch(text, /real protected hosted-client read before activation/iu)
  }
  assert.doesNotMatch(questions, /Issue #7 hosted-access activation/u)
  assert.doesNotMatch(questions, /This PR/u)
})
