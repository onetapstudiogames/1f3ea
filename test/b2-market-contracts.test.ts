import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

process.env.DATABASE_URL = 'postgresql://fake:fake@fake-host.example.neon.tech/fakedb'
process.env.TREASURY_ADDRESS = '0x3b9d230c9b995fb1a10add2d63ce37437916dcfd'

const { default: app, validListing } = await import('../src/index.ts')
const { MCP_TOOLS } = await import('../src/mcp-tool-catalog.ts')
const { MARKET_LIMITS } = await import('../src/market-facts.ts')
const { WINDOW_JS } = await import('../src/window-client.ts')

function mcpRequest(method: string, params?: unknown) {
  return app.request('/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
}

test('all connector tools reject fields outside their advertised schemas', () => {
  assert.ok(MCP_TOOLS.length > 21)
  for (const tool of MCP_TOOLS) {
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name)
  }
})

test('connector parity includes help, flag, draft cancel, treasury, and moderation', async () => {
  const response = await mcpRequest('tools/list')
  const body = await response.json() as { result: { tools: Array<{ name: string }> } }
  const names = body.result.tools.map(tool => tool.name)
  for (const expected of [
    'help', 'flag', 'cancel_world_draft', 'treasury', 'remove_listing', 'pin_listing',
  ]) assert.ok(names.includes(expected), expected)
})

test('the agent help endpoint and human help page use the live connector catalog', async () => {
  const [apiResponse, pageResponse] = await Promise.all([
    app.request('/api/help'),
    app.request('/help'),
  ])
  assert.equal(apiResponse.status, 200)
  const api = await apiResponse.json() as { tool_count: number; tools: Array<{
    name: string; requires_sign_in: boolean; maintainer_only: boolean
    endpoints: Array<{ method: string; path: string }>
  }> }
  assert.equal(api.tool_count, MCP_TOOLS.length)
  assert.deepEqual(api.tools.map(tool => tool.name), MCP_TOOLS.map(tool => tool.name))
  assert.equal(api.tools.find(tool => tool.name === 'treasury')?.requires_sign_in, false)
  assert.equal(api.tools.find(tool => tool.name === 'flag')?.requires_sign_in, true)
  assert.equal(api.tools.find(tool => tool.name === 'pin_listing')?.maintainer_only, true)
  assert.deepEqual(api.tools.find(tool => tool.name === 'world_status')?.endpoints, [
    { method: 'GET', path: '/api/world/draft/:draft_id' },
    { method: 'GET', path: '/api/world/checkout/:checkout_id' },
  ])
  const page = await pageResponse.text()
  for (const tool of MCP_TOOLS) assert.match(page, new RegExp(`<code>${tool.name}</code>`, 'u'), tool.name)
})

test('every HTTP error points callers to public help', async () => {
  const response = await app.request('/no-such-market-route')
  assert.equal(response.status, 404)
  assert.match(response.headers.get('link') ?? '', /<\/help>;\s*rel="help"/u)
})

test('ordinary listing requests reject unknown fields', () => {
  const result = validListing({
    title: 'A useful thing',
    description: 'Useful.',
    preview: '',
    artifact: 'hello',
    price_usdc: 0,
    seller_wallet: '0x1111111111111111111111111111111111111111',
    tags: [],
    unexpected: true,
  })
  assert.equal(result, 'body may contain only: title, description, preview, artifact, price_usdc, seller_wallet, tags, aisle, fee_tx_hash')
})

test('public collection filters reject values beyond the published bounds', async () => {
  const [query, tag, eventKind] = await Promise.all([
    app.request(`/api/shelves?q=${'q'.repeat(101)}`),
    app.request(`/api/shelves?tag=${'t'.repeat(41)}`),
    app.request(`/api/events?kind=${'k'.repeat(41)}`),
  ])
  assert.equal(query.status, 400)
  assert.equal(tag.status, 400)
  assert.equal(eventKind.status, 400)
  assert.match(await query.text(), /at most 100 characters/u)
  assert.match(await tag.text(), /at most 40 characters/u)
  assert.match(await eventKind.text(), /at most 40 characters/u)
})

test('existing text limits state their UTF-16 counting rule at an astral boundary', async () => {
  const queryLimit = MARKET_LIMITS.collection.queryMaxChars
  const astralQuery = '💡'.repeat((queryLimit / 2) + 1)
  const response = await app.request(`/api/shelves?q=${encodeURIComponent(astralQuery)}`)
  assert.equal(response.status, 400)
  assert.match(await response.text(), /100 characters measured as UTF-16 code units/u)

  const browse = MCP_TOOLS.find(tool => tool.name === 'browse')
  assert.ok(browse)
  const querySchema = (browse.inputSchema.properties as Record<string, Record<string, unknown>>).q
  assert.ok(querySchema)
  assert.equal(querySchema.maxLength, queryLimit)
  assert.equal(querySchema['x-maxUtf16CodeUnits'], queryLimit)
  assert.match(String(querySchema.description), /UTF-16 code units/u)

  for (const toolName of ['list_item', 'draft_world']) {
    const tool = MCP_TOOLS.find(candidate => candidate.name === toolName)
    assert.ok(tool, toolName)
    const fields = tool.inputSchema.properties as Record<string, Record<string, unknown>>
    for (const [field, limit] of [
      ['title', MARKET_LIMITS.listing.titleMaxChars],
      ['description', MARKET_LIMITS.listing.descriptionMaxChars],
      ['preview', MARKET_LIMITS.listing.previewMaxChars],
    ] as const) {
      assert.equal(fields[field]?.['x-maxUtf16CodeUnits'], limit, `${toolName}.${field}`)
      assert.match(String(fields[field]?.description), /UTF-16 code units/u, `${toolName}.${field}`)
    }
  }
})

test('window client sizes come from the same collection facts as its server payload', () => {
  const expected = [
    ['MAX_FILTER_CHARS', MARKET_LIMITS.collection.queryMaxChars],
    ['EVENT_PAGE_SIZE', MARKET_LIMITS.collection.windowEvents],
    ['LISTING_PAGE_SIZE', MARKET_LIMITS.collection.windowListings],
    ['MERCHANT_PAGE_SIZE', MARKET_LIMITS.collection.windowMerchants],
    ['COMMENT_PAGE_SIZE', MARKET_LIMITS.collection.listingCommentsPage],
  ] as const
  for (const [name, value] of expected)
    assert.match(WINDOW_JS, new RegExp(`const ${name} = ${value}\\b`, 'u'), name)
})

test('public facts explain agent-only design and the missing caller limits', async () => {
  const [frontDoorResponse, llmsResponse] = await Promise.all([
    app.request('/'),
    app.request('/llms.txt'),
  ])
  const [frontDoor, llms] = await Promise.all([frontDoorResponse.text(), llmsResponse.text()])
  for (const text of [frontDoor, llms]) {
    assert.match(text, /agent-only by design\.\s*humans watch/iu)
    assert.match(text, /request expires after 15 minutes/iu)
    assert.match(text, /authorization code expires after 5 minutes/iu)
    assert.match(text, /short pass lasts 10 minutes/iu)
    assert.match(text, /long pass lasts 30 days/iu)
    assert.match(text, /pairing[^.]*20[^.]*UTC hour/iu)
    assert.match(text, /one pending world draft/iu)
    assert.match(text, /activate it, cancel it, or wait for expiry/iu)
    assert.match(text, /machine shop window[^.]*takes no parameters[^.]*refuses credentials/iu)
  }
})

test('the changelog is served as a web page and exact plain text', async () => {
  const [page, plain] = await Promise.all([
    app.request('/changelog'),
    app.request('/changelog.txt'),
  ])
  assert.equal(page.status, 200)
  assert.match(await page.text(), /<link rel="canonical" href="https:\/\/1f3ea\.com\/changelog">/u)
  assert.equal(plain.status, 200)
  assert.equal(await plain.text(), readFileSync('CHANGELOG.md', 'utf8'))
})

test('the duplicate shop-window picture address redirects to the canonical image', async () => {
  const response = await app.request('/window-card.png')
  assert.equal(response.status, 308)
  assert.equal(response.headers.get('location'), '/og-image.png')
})

test('world listing details show a validated public city offer link', () => {
  assert.match(WINDOW_JS, /Open the public city offer/u)
  assert.match(WINDOW_JS, /url\.origin === 'https:\/\/1f3d9\.com'/u)
  assert.match(WINDOW_JS, /api\\\/world\\\/offer/u)
})
