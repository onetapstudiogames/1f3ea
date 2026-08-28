// Protocol edge tests use only in-memory Hono apps. They never contact the
// database, a wallet, the facilitator, or a live deployment.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Hono } from 'hono'
import { mcp, type McpOptions } from '../src/mcp.ts'

const ACCESS_TOKEN = `1f3ea_at_${'cd'.repeat(32)}`

function gateway(backing: Hono, options: McpOptions = {}) {
  const app = new Hono()
  app.post('/mcp', c => mcp(c, backing, options))
  return app
}

function jsonRequest(body: unknown, authorization?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (authorization) headers.authorization = authorization
  return {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  }
}

test('MCP rejects malformed envelopes, batches, missing methods, and unknown methods', async () => {
  const app = gateway(new Hono())

  const malformedJson = await app.request('/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{',
  })
  assert.equal(malformedJson.status, 200)
  assert.deepEqual(await malformedJson.json(), {
    jsonrpc: '2.0', id: null, error: { code: -32600, message: 'not a JSON-RPC 2.0 message' },
  })

  const batch = await app.request('/mcp', jsonRequest([]))
  assert.deepEqual(await batch.json(), {
    jsonrpc: '2.0', id: null, error: { code: -32600, message: 'batches not supported' },
  })

  const wrongVersion = await app.request('/mcp', jsonRequest({ jsonrpc: '1.0', id: 9, method: 'ping' }))
  assert.deepEqual(await wrongVersion.json(), {
    jsonrpc: '2.0', id: 9, error: { code: -32600, message: 'not a JSON-RPC 2.0 message' },
  })

  const missingMethod = await app.request('/mcp', jsonRequest({ jsonrpc: '2.0', id: 10 }))
  assert.equal((await missingMethod.json() as { error: { code: number } }).error.code, -32600)

  const unknown = await app.request('/mcp', jsonRequest({ jsonrpc: '2.0', id: 11, method: 'not-real' }))
  assert.deepEqual(await unknown.json(), {
    jsonrpc: '2.0', id: 11, error: { code: -32601, message: 'method not found: not-real' },
  })

  const structuredToolName = await app.request('/mcp', jsonRequest({
    jsonrpc: '2.0', id: 12, method: 'tools/call',
    params: { name: JSON.parse('{"toString":null,"valueOf":null}'), arguments: {} },
  }))
  assert.equal(structuredToolName.status, 200)
  assert.deepEqual(await structuredToolName.json(), {
    jsonrpc: '2.0', id: 12, error: { code: -32602, message: 'no such tool: ' },
  })
})

test('MCP lifecycle replies preserve ids, negotiate protocol versions, and accept notifications', async () => {
  const backing = new Hono()
  const ordinary = gateway(backing)
  const hosted = gateway(backing, { hostedChat: true })

  const defaultInitialize = await ordinary.request('/mcp', jsonRequest({
    jsonrpc: '2.0', method: 'initialize',
  }))
  const defaultBody = await defaultInitialize.json() as {
    id: unknown
    result: { protocolVersion: string; instructions: string }
  }
  assert.equal(defaultBody.id, null)
  assert.equal(defaultBody.result.protocolVersion, '2025-06-18')
  assert.match(defaultBody.result.instructions, /\/join/i)

  const requestedInitialize = await hosted.request('/mcp', jsonRequest({
    jsonrpc: '2.0', id: 'start', method: 'initialize', params: { protocolVersion: '2026-01-01' },
  }))
  const requestedBody = await requestedInitialize.json() as {
    id: unknown
    result: { protocolVersion: string; instructions: string }
  }
  assert.equal(requestedBody.id, 'start')
  assert.equal(requestedBody.result.protocolVersion, '2026-01-01')
  assert.match(requestedBody.result.instructions, /hosted 1F3EA market connector/i)

  const initialized = await ordinary.request('/mcp', jsonRequest({
    jsonrpc: '2.0', method: 'notifications/initialized',
  }))
  assert.equal(initialized.status, 202)
  assert.equal(await initialized.text(), '')

  const ping = await ordinary.request('/mcp', jsonRequest({ jsonrpc: '2.0', method: 'ping' }))
  assert.deepEqual(await ping.json(), { jsonrpc: '2.0', id: null, result: {} })
})

test('payment MCP tools separate invalid proofs, unclassified rejections, and unavailable verification', async () => {
  const app = gateway(new Hono())
  const response = await app.request('/mcp', jsonRequest({
    jsonrpc: '2.0', id: 'payment-contract', method: 'tools/list',
  }))
  const body = await response.json() as {
    result: { tools: Array<{ name: string; description: string }> }
  }

  for (const name of ['list_item', 'list_world', 'buy']) {
    const description = body.result.tools.find(tool => tool.name === name)?.description ?? ''
    assert.match(description, /402 means payment is required or the proof is known to be invalid/i)
    assert.match(description, /502 means the facilitator rejected a request without identifying/i)
    assert.match(description, /proof, the market's requirements, or facilitator handling/i)
    assert.match(description, /do not replace or replay the proof blindly/i)
    assert.match(description, /terminal.*unrecognized.*do not retry or replay/i)
    assert.match(description, /503 means payment or chain verification is\s+unavailable/i)
    assert.match(description, /pending or duplicate settlement.*same proof/i)
    assert.match(description, /retry the same proof/i)
    assert.match(description, /do not pay again/i)
  }
})

test('public action contracts explain how failure causes cross each door', () => {
  for (const path of ['src/frontdoor.txt', 'src/llms.txt']) {
    const text = readFileSync(path, 'utf8')
    assert.match(text, /When sending a payment proof, a 402 means payment is required\s+or the proof is known to be invalid/i)
    assert.match(text, /A 502 means the facilitator rejected a\s+request without identifying/i)
    assert.match(text, /proof, the market's\s+requirements, or\s+facilitator handling/i)
    assert.match(text, /do not replace or replay the proof blindly/i)
    assert.match(text, /terminal.*unrecognized.*do not retry or replay/i)
    assert.match(text, /503 means payment or chain verification is unavailable/i)
    assert.match(text, /explicit\s+facilitator failure that did not match a known caller mistake/i)
    assert.match(text, /retry the same proof/i)
    assert.match(text, /do not pay again/i)
    assert.match(text, /pending or duplicate settlement.*same proof/i)
    assert.match(text, /MCP tool result preserves the same cause/i)
    assert.match(text, /shop window preserves each bounded API failure cause as inert text/i)
    assert.match(text, /OAuth token exchange allows 120 attempts per UTC hour for each IP and\s+each\s+client/i)
    assert.match(text, /token exchange.*429 means retry after the next UTC hour begins/i)
    assert.match(text, /token exchange.*503 means the exchange could not be completed/i)
    assert.match(text, /Token exchange 429 and 503 responses are \{"error":"temporarily_unavailable","error_description":"\.\.\."\}/i)
    assert.match(text, /OAuth revocation keeps invalid (?:and|or) unknown tokens opaque/i)
    assert.match(text, /readable malformed\s+token is opaque/i)
    assert.match(text, /unreadable request body.*503/i)
    assert.match(text, /temporarily_unavailable/i)
    assert.match(text, /revocation allows 120 attempts per UTC hour for each IP and\s+each client/i)
    assert.match(text, /429 means retry after the next UTC hour begins/i)
    assert.match(text, /503 means (?:the\s+)?revocation could not be completed/i)
  }
})

test('MCP tool routing handles empty arguments, filters, validated stores, and each buy shape', async () => {
  const seen: Array<{ method: string; path: string; body: unknown }> = []
  const backing = new Hono()
  backing.all('*', async c => {
    const path = new URL(c.req.url).pathname + new URL(c.req.url).search
    seen.push({
      method: c.req.method,
      path,
      body: c.req.method === 'GET' ? null : await c.req.json(),
    })
    if (path === '/api/store/_') return c.json({ error: 'no such store' }, 404)
    return c.json({ ok: true })
  })
  const app = gateway(backing)

  const calls = [
    { name: 'browse', arguments: ['ignored'] },
    { name: 'browse', arguments: { q: 'signed tools', tag: 'mcp', aisle: 'tools', sort: 'karma' } },
    { name: 'visit_store', arguments: { handle: 'agent-8' } },
    { name: 'buy', arguments: { id: 3 } },
    { name: 'buy', arguments: { id: 4, payer_wallet: '0x1111111111111111111111111111111111111111' } },
    { name: 'buy', arguments: { id: 5, intent_id: 8, tx_hash: 'proof' } },
  ]
  for (const params of calls) {
    const response = await app.request('/mcp', jsonRequest({
      jsonrpc: '2.0', id: params.name, method: 'tools/call', params,
    }))
    const body = await response.json() as { result: { isError: boolean } }
    assert.equal(body.result.isError, false)
  }

  assert.deepEqual(seen, [
    { method: 'GET', path: '/api/shelves', body: null },
    { method: 'GET', path: '/api/shelves?q=signed+tools&tag=mcp&aisle=tools&sort=karma', body: null },
    { method: 'GET', path: '/api/store/agent-8', body: null },
    { method: 'POST', path: '/api/buy/3', body: {} },
    {
      method: 'POST', path: '/api/purchase-intent/4',
      body: { payer_wallet: '0x1111111111111111111111111111111111111111' },
    },
    { method: 'POST', path: '/api/claim/5', body: { intent_id: 8, tx_hash: 'proof' } },
  ])

  for (const handle of [undefined, 'a/b', '\ud800']) {
    const invalidStore = await app.request('/mcp', jsonRequest({
      jsonrpc: '2.0', id: 'invalid-store', method: 'tools/call',
      params: { name: 'visit_store', arguments: handle === undefined ? {} : { handle } },
    }))
    assert.equal(invalidStore.status, 200)
    const invalidStoreBody = await invalidStore.json() as {
      result: { isError: boolean; content: Array<{ text: string }> }
    }
    assert.equal(invalidStoreBody.result.isError, true)
    assert.deepEqual(JSON.parse(invalidStoreBody.result.content[0]!.text), {
      error: 'no such store',
    })
  }

  const unknownTool = await app.request('/mcp', jsonRequest({
    jsonrpc: '2.0', id: 12, method: 'tools/call', params: { arguments: null },
  }))
  assert.deepEqual(await unknownTool.json(), {
    jsonrpc: '2.0', id: 12, error: { code: -32602, message: 'no such tool: ' },
  })
})

test('MCP route builders leave structured invalid ids to backing validation', async () => {
  const paths: string[] = []
  const backing = new Hono()
  backing.all('*', c => {
    const path = new URL(c.req.url).pathname
    paths.push(path)
    return c.json({
      error: path.startsWith('/api/world/') ? 'listing id must be a positive integer' : 'bad id',
    }, 400)
  })
  const app = gateway(backing)
  const invalidId = JSON.parse('{"toString":null,"valueOf":null}') as Record<string, null>
  const calls = [
    { name: 'read_listing', arguments: { id: invalidId }, error: 'bad id' },
    {
      name: 'checkout_world', arguments: { listing_id: invalidId, city_handle: 'agent-8' },
      error: 'listing id must be a positive integer',
    },
    {
      name: 'sync_world', arguments: { listing_id: invalidId },
      error: 'listing id must be a positive integer',
    },
    { name: 'edit_item', arguments: { id: invalidId }, error: 'bad id' },
    { name: 'withdraw_item', arguments: { id: invalidId }, error: 'bad id' },
    { name: 'buy', arguments: { id: invalidId }, error: 'bad id' },
    {
      name: 'buy', arguments: { id: invalidId, payer_wallet: '0x1111111111111111111111111111111111111111' },
      error: 'bad id',
    },
    { name: 'buy', arguments: { id: invalidId, intent_id: 1 }, error: 'bad id' },
  ]

  for (const [index, call] of calls.entries()) {
    const response = await app.request('/mcp', jsonRequest({
      jsonrpc: '2.0', id: index, method: 'tools/call', params: call,
    }))
    assert.equal(response.status, 200, call.name)
    const body = await response.json() as {
      result: { isError: boolean; content: Array<{ text: string }> }
    }
    assert.equal(body.result.isError, true, call.name)
    assert.deepEqual(JSON.parse(body.result.content[0]!.text), { error: call.error }, call.name)
  }

  assert.deepEqual(paths, [
    '/api/listing/NaN',
    '/api/world/checkout/NaN',
    '/api/world/sync/NaN',
    '/api/listing/NaN',
    '/api/listing/NaN/withdraw',
    '/api/buy/NaN',
    '/api/purchase-intent/NaN',
    '/api/claim/NaN',
  ])
})

test('ordinary MCP preserves invalid and unavailable payment causes', async () => {
  const backing = new Hono()
  backing.post('/api/buy/:id', c => Number(c.req.param('id')) === 1
    ? c.json({
      x402Version: 1,
      error: 'X-PAYMENT proof was rejected; create a fresh payment proof before retrying',
      accepts: [],
    }, 402)
    : c.json({
      error: 'payment facilitator verification is unavailable; retry this request with the same X-PAYMENT proof later',
    }, 503))
  const app = gateway(backing)

  for (const expected of [
    { id: 1, error: 'X-PAYMENT proof was rejected; create a fresh payment proof before retrying' },
    { id: 2, error: 'payment facilitator verification is unavailable; retry this request with the same X-PAYMENT proof later' },
  ]) {
    const response = await app.request('/mcp', jsonRequest({
      jsonrpc: '2.0', id: expected.id, method: 'tools/call',
      params: { name: 'buy', arguments: { id: expected.id } },
    }))
    const body = await response.json() as {
      result: { isError: boolean; content: Array<{ text: string }> }
    }
    assert.equal(body.result.isError, true)
    assert.equal((JSON.parse(body.result.content[0]!.text) as { error: string }).error, expected.error)
  }
})

test('hosted MCP keeps OAuth challenges on both pre-route and backing-route failures', async () => {
  const backing = new Hono()
  backing.get('/api/shelves', c => c.json({ error: 'expired access' }, 401))

  const forwarded = gateway(backing, { hostedChat: true, forwardUnauthorizedStatus: true })
  const anonymous = await forwarded.request('/mcp', jsonRequest({
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'me', arguments: {} },
  }))
  assert.equal(anonymous.status, 401)
  assert.match(anonymous.headers.get('www-authenticate') ?? '', /resource_metadata=/)
  assert.equal(anonymous.headers.get('cache-control'), 'no-store')
  assert.equal(anonymous.headers.get('pragma'), 'no-cache')
  assert.match(anonymous.headers.get('vary') ?? '', /Authorization/iu)
  assert.match(anonymous.headers.get('access-control-expose-headers') ?? '', /WWW-Authenticate/iu)

  const backingFailure = await forwarded.request('/mcp', jsonRequest({
    jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'browse', arguments: {} },
  }, `Bearer ${ACCESS_TOKEN}`))
  assert.equal(backingFailure.status, 401)
  assert.match(backingFailure.headers.get('www-authenticate') ?? '', /resource_metadata=/)
  assert.equal(backingFailure.headers.get('cache-control'), 'no-store')
  assert.equal(backingFailure.headers.get('pragma'), 'no-cache')
  assert.match(backingFailure.headers.get('vary') ?? '', /Authorization/iu)
  assert.match(backingFailure.headers.get('access-control-expose-headers') ?? '', /WWW-Authenticate/iu)
  const failedBody = await backingFailure.json() as {
    result: {
      isError: boolean
      content: Array<{ text: string }>
      _meta: { 'mcp/www_authenticate': string[] }
    }
  }
  assert.equal(failedBody.result.isError, true)
  assert.equal((JSON.parse(failedBody.result.content[0]!.text) as { error: string }).error, 'expired access')
  assert.equal(failedBody.result._meta['mcp/www_authenticate'].length, 1)

  const wrapped = gateway(backing, { hostedChat: true, forwardUnauthorizedStatus: false })
  const wrappedFailure = await wrapped.request('/mcp', jsonRequest({
    jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'browse', arguments: {} },
  }, `Bearer ${ACCESS_TOKEN}`))
  assert.equal(wrappedFailure.status, 200)
  const wrappedBody = await wrappedFailure.json() as {
    result: { isError: boolean; content: Array<{ text: string }> }
  }
  assert.equal(wrappedBody.result.isError, true)
  assert.equal((JSON.parse(wrappedBody.result.content[0]!.text) as { error: string }).error, 'expired access')
})

test('ordinary MCP keeps backing errors inside the tool result and warns on nested credentials', async () => {
  const backing = new Hono()
  backing.get('/api/shelves', c => c.json({ error: 'bad filter' }, 400))
  const app = gateway(backing)

  const backingError = await app.request('/mcp', jsonRequest({
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'browse', arguments: {} },
  }))
  assert.equal(backingError.status, 200)
  const backingBody = await backingError.json() as { result: { isError: boolean } }
  assert.equal(backingBody.result.isError, true)

  const nestedCredential = await app.request('/mcp', jsonRequest({
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'comment', arguments: { body: [`save ${ACCESS_TOKEN}`] } },
  }))
  const credentialBody = await nestedCredential.json() as { result: { content: Array<{ text: string }> } }
  assert.match(credentialBody.result.content[0]!.text, /configure the Authorization header/i)
  assert.doesNotMatch(JSON.stringify(credentialBody), new RegExp(ACCESS_TOKEN, 'i'))
})
