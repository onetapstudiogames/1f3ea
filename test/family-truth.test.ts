import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

process.env.DATABASE_URL = 'postgresql://fake:fake@fake-host.example.neon.tech/fakedb'
process.env.TREASURY_ADDRESS = '0x3b9d230c9b995fb1a10add2d63ce37437916dcfd'

const { default: app } = await import('../src/index.ts')
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const BUYER_BINDING =
  'public market checkout binds its authenticated market_buyer to a normalized city_handle; ' +
  'the city requires city_handle to match the authenticated city claimant, then records that ' +
  'resident as buyer and copies market_buyer onto the city offer'

test('every market discovery surface tells the same family and world-delivery truth', () => {
  const surfaces = [
    ['front door', read('../src/frontdoor.txt')],
    ['compact machine map', read('../src/llms.txt')],
    ['readme', read('../README.md')],
    ['specification', read('../docs/SPEC.md')],
    ['decisions', read('../docs/DECISIONS.md')],
  ] as const

  for (const [name, value] of surfaces) {
    assert.match(value, /1f3d9/iu, name)
    assert.match(value, /world/iu, name)
    assert.match(value, /ownership/iu, name)
    assert.match(value, /public records/iu, name)
  }
  assert.match(read('../src/frontdoor.txt'), /github\.com\/onetapstudiogames\/1f3d9-citylife/iu)
  assert.match(read('../src/llms.txt'), /github\.com\/onetapstudiogames\/1f3d9-citylife/iu)

  for (const [name, value] of [
    ['front door', read('../src/frontdoor.txt')],
    ['compact machine map', read('../src/llms.txt')],
    ['specification', read('../docs/SPEC.md')],
  ] as const) {
    assert.match(value, /ten-minute\s+(?:public\s+)?(?:checkout\s+)?intent/iu, `${name}: market intent`)
    assert.match(value, /five-minute\s+(?:city\s+)?reservation/iu, `${name}: city reservation`)
  }

  for (const [name, value] of surfaces) {
    assert.match(value, /payment.pending/iu, `${name}: pending payment`)
    assert.match(value, /payment.invalid/iu, `${name}: invalid payment`)
    assert.match(value, /(?:without|must not|do not) pay(?:ing)? again/iu, `${name}: no second payment`)
  }

  for (const [name, value] of surfaces.slice(0, 4)) {
    assert.match(value, /exact total/iu, `${name}: bounded collection total`)
    assert.match(value, /\/api\/window/iu, `${name}: human window completeness`)
  }
  for (const [name, value] of surfaces.slice(0, 3)) {
    assert.match(value, /scope=door/iu, `${name}: front-door activity scope`)
    assert.match(value, /scope=window/iu, `${name}: window activity scope`)
  }
})

test('every active market surface frames 1f916 as a separate place other people run', async () => {
  const [frontDoorResponse, compactMapResponse, windowResponse] = await Promise.all([
    app.request('/'),
    app.request('/llms.txt'),
    app.request('/window'),
  ])
  const [frontDoor, compactMap, window] = await Promise.all([
    frontDoorResponse.text(),
    compactMapResponse.text(),
    windowResponse.text(),
  ])
  const surfaces = [
    ['front door', frontDoor],
    ['compact machine map', compactMap],
    ['human window', window],
    ['readme', read('../README.md')],
    ['specification', read('../docs/SPEC.md')],
  ] as const

  for (const [name, value] of surfaces) {
    assert.match(value, /1f916/iu, `${name}: names the wider-world place`)
    assert.match(
      value,
      /(?:separate[\s\S]{0,220}other people run|other people run[\s\S]{0,220}separate)/iu,
      `${name}: separateness and operator truth`,
    )
    assert.doesNotMatch(
      value,
      /third of three|third sibling|the trio completes|one of (?:a|the) trio/iu,
      `${name}: no family claim`,
    )
  }

  assert.doesNotMatch(read('../package.json'), /1f916/iu, 'package description')
  assert.doesNotMatch(read('../server.json'), /1f916/iu, 'server description')
  assert.doesNotMatch(
    read('../docs/OPEN-QUESTIONS.md'),
    /(?:1f916[\s\S]{0,100}completed family|completed family[\s\S]{0,100}1f916)/iu,
    'active planning notes do not claim a shared family',
  )

})

test('official facts and MCP advertise the city bridge and all world tools', async () => {
  const official = await app.request('/api/official')
  assert.equal(official.status, 200)
  const facts = await official.json() as Record<string, unknown>
  assert.equal(facts.city, 'https://1f3d9.com')
  assert.match(JSON.stringify(facts), /public/i)
  assert.match(JSON.stringify(facts), /market_buyer.*city_handle/i)
  assert.equal((facts.world as { buyer_binding?: unknown }).buyer_binding, BUYER_BINDING)
  const directFacts = JSON.stringify(facts.ordinary_direct_payment)
  assert.match(directFacts, /signed payer/i)
  assert.match(directFacts, /Base USDC/i)
  assert.match(directFacts, /one fee or one purchase/i)
  const paginationFacts = JSON.stringify(facts.public_pagination)
  assert.match(paginationFacts, /exact total/i)
  assert.match(paginationFacts, /next_cursor/i)
  assert.match(paginationFacts, /comments_next_after_id/i)
  assert.match(paginationFacts, /next_before_id/i)
  assert.match(paginationFacts, /scope=door\|window/i)
  assert.match(paginationFacts, /\/api\/window/i)

  const initialized = await app.request('/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  })
  const payload = await initialized.json() as { result: { instructions: string } }
  assert.match(payload.result.instructions, /world aisle/i)
  assert.match(payload.result.instructions, /city resident/i)

  const tools = await app.request('/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
  })
  const names = ((await tools.json() as {
    result: { tools: Array<{ name: string }> }
  }).result.tools).map(tool => tool.name)
  for (const name of ['draft_world', 'list_world', 'checkout_world', 'sync_world']) {
    assert.ok(names.includes(name), name)
  }
})
