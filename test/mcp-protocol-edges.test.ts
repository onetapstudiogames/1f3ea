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

async function callTool(
  app: Hono,
  name: string,
  args: unknown = {},
  authorization?: string,
) {
  const response = await app.request('/mcp', jsonRequest({
    jsonrpc: '2.0', id: `${name}-result`, method: 'tools/call',
    params: { name, arguments: args },
  }, authorization))
  const body = await response.json() as {
    result: {
      isError: boolean
      content: Array<{ text: string }>
      _meta?: { 'mcp/www_authenticate'?: string[] }
    }
  }
  return { response, body, text: body.result.content[0]?.text ?? '' }
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

test('rotation remains a stated browser-only boundary on every connector contract surface', async () => {
  const backing = new Hono()
  for (const options of [{}, { hostedChat: true }] as McpOptions[]) {
    const app = gateway(backing, options)
    const initialized = await app.request('/mcp', jsonRequest({
      jsonrpc: '2.0', id: 'rotation-policy', method: 'initialize',
    }))
    const body = await initialized.json() as { result: { instructions: string } }
    assert.match(body.result.instructions, /rotation[\s\S]*browser-only[\s\S]*never an MCP tool/i)

    const listed = await app.request('/mcp', jsonRequest({
      jsonrpc: '2.0', id: 'rotation-tools', method: 'tools/list',
    }))
    const listBody = await listed.json() as {
      result: { tools: Array<{ name: string; description: string }> }
    }
    assert.equal(listBody.result.tools.some(tool => tool.name === 'rotate'), false)
    const official = listBody.result.tools.find(tool => tool.name === 'official_facts')
    assert.match(official?.description ?? '', /rotation[\s\S]*never an MCP tool/i)
  }

  for (const path of ['src/frontdoor.txt', 'src/llms.txt', 'docs/SPEC.md', 'docs/DECISIONS.md']) {
    assert.match(readFileSync(path, 'utf8'), /rotation[\s\S]{0,240}never an MCP tool/i, path)
  }
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

test('failed tools expose the current machine error vocabulary on both MCP doors', async () => {
  const statuses = [
    [400, 'bad_input'],
    [401, 'auth_required'],
    [402, 'payment_required'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [409, 'conflict'],
    [429, 'rate_limited'],
    [500, 'market_fault'],
  ] as const

  for (const options of [{}, { hostedChat: true }] as McpOptions[]) {
    for (const [status, errorClass] of statuses) {
      const backing = new Hono()
      backing.get('/api/shelves', () => new Response(JSON.stringify({
        error: 'downstream detail',
        original_field: 'kept',
        accepts: [{ network: 'base' }],
        do_not_pay_again: true,
        payment_preserved: true,
        error_class: 'spoofed',
        http_status: 299,
        retry_after_seconds: 99_999,
        front_door_tool: 'spoofed',
        front_door: 'https://attacker.invalid/',
      }), {
        status,
        headers: { 'content-type': 'application/json', 'retry-after': '60' },
      }))

      const { body, text } = await callTool(gateway(backing, options), 'browse')
      assert.equal(body.result.isError, true, `${String(options.hostedChat)} ${status}`)
      const parsed = JSON.parse(text) as Record<string, unknown>
      assert.equal(parsed.error_class, errorClass, `${String(options.hostedChat)} ${status}`)
      assert.equal(parsed.http_status, status, `${String(options.hostedChat)} ${status}`)
      assert.equal(parsed.retry_after_seconds, 60, `${String(options.hostedChat)} ${status}`)
      assert.equal(parsed.front_door_tool, 'front_door')
      assert.equal(parsed.front_door, 'https://1f3ea.com/')
      assert.equal(parsed.error, 'downstream detail')
      assert.equal(parsed.original_field, 'kept')
      assert.deepEqual(parsed.accepts, [{ network: 'base' }])
      assert.equal(parsed.do_not_pay_again, true)
      assert.equal(parsed.payment_preserved, true)
    }
  }
})

test('MCP error envelopes preserve plain failures, bound retry hints, and leave success exact', async () => {
  for (const options of [{}, { hostedChat: true }] as McpOptions[]) {
    const plainBacking = new Hono()
    plainBacking.get('/api/shelves', () => new Response('short and stout', {
      status: 418,
      headers: { 'retry-after': '86401' },
    }))
    const plain = JSON.parse((await callTool(gateway(plainBacking, options), 'browse')).text) as Record<string, unknown>
    assert.equal(plain.error_class, 'bad_input')
    assert.equal(plain.http_status, 418)
    assert.equal(plain.error, 'short and stout')
    assert.equal(plain.retry_after_seconds, undefined)

    const successText = '{"ok":true,"error_class":"seller-authored text"}'
    const successBacking = new Hono()
    successBacking.get('/api/shelves', () => new Response(successText, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    const success = await callTool(gateway(successBacking, options), 'browse')
    assert.equal(success.body.result.isError, false)
    assert.equal(success.text, successText)

    const unreachableBacking = {
      request: () => Promise.reject(new Error('transport down')),
    } as unknown as Hono
    const unreachable = JSON.parse(
      (await callTool(gateway(unreachableBacking, options), 'browse')).text,
    ) as Record<string, unknown>
    assert.equal(unreachable.error_class, 'unreachable')
    assert.equal(unreachable.http_status, undefined)
    assert.equal(unreachable.front_door, 'https://1f3ea.com/')
  }
})

test('both MCP doors redact Unicode-escaped credentials in JSON keys and nested values', async () => {
  const secret = `1f3ea_sk_${'a'.repeat(48)}`
  const escapedSecret = `1f3ea_sk_\\u0061${'a'.repeat(47)}`
  const rawJson = `{"${escapedSecret}":{"nested":"${escapedSecret}","direct":"${secret}"}}`

  for (const options of [{}, { hostedChat: true }] as McpOptions[]) {
    for (const status of [200, 400]) {
      const backing = new Hono()
      backing.get('/api/shelves', () => new Response(rawJson, {
        status,
        headers: { 'content-type': 'application/json' },
      }))
      const result = await callTool(gateway(backing, options), 'browse')
      const parsed = JSON.parse(result.text) as Record<string, unknown>
      assert.doesNotMatch(JSON.stringify(parsed), new RegExp(secret, 'iu'))
      assert.doesNotMatch(result.text, /1f3ea_sk_/iu)
      assert.deepEqual(parsed, {
        '[redacted 1F3EA credential]': {
          nested: '[redacted 1F3EA credential]',
          direct: '[redacted 1F3EA credential]',
        },
        ...(status === 400 ? {
          error_class: 'bad_input',
          front_door_tool: 'front_door',
          front_door: 'https://1f3ea.com/',
          http_status: 400,
        } : {}),
      })
    }
  }
})

test('classified MCP failures keep the public door usable when hosted sign-in config is dormant', async (t) => {
  const originalPublicOrigin = process.env.PUBLIC_ORIGIN
  process.env.PUBLIC_ORIGIN = 'http://invalid.example'
  t.after(() => {
    if (originalPublicOrigin === undefined) delete process.env.PUBLIC_ORIGIN
    else process.env.PUBLIC_ORIGIN = originalPublicOrigin
  })

  for (const options of [{}, { hostedChat: true }] as McpOptions[]) {
    const backing = new Hono()
    backing.get('/api/shelves', () => new Response('{"error":"missing"}', {
      status: 404,
      headers: { 'content-type': 'application/json' },
    }))

    const result = await callTool(gateway(backing, options), 'browse')
    const parsed = JSON.parse(result.text) as Record<string, unknown>
    assert.equal(result.response.status, 200)
    assert.equal(result.body.result.isError, true)
    assert.equal(parsed.error_class, 'not_found')
    assert.equal(parsed.front_door, 'https://1f3ea.com/')
  }
})

test('MCP preflight failures are classified without leaking credentials or losing OAuth metadata', async () => {
  const merchantSecret = `1f3ea_sk_${'ab'.repeat(24)}`
  for (const options of [{}, { hostedChat: true }] as McpOptions[]) {
    const app = gateway(new Hono(), options)
    const credential = await callTool(app, 'comment', { body: `keep ${ACCESS_TOKEN}` })
    const credentialError = JSON.parse(credential.text) as Record<string, unknown>
    assert.equal(credentialError.error_class, 'bad_input')
    assert.doesNotMatch(credential.text, new RegExp(ACCESS_TOKEN, 'iu'))
    assert.equal(credentialError.http_status, undefined)

    const invalidArguments = await callTool(app, 'browse', [])
    assert.equal((JSON.parse(invalidArguments.text) as Record<string, unknown>).error_class, 'bad_input')
  }

  const hosted = gateway(new Hono(), { hostedChat: true, forwardUnauthorizedStatus: true })
  const missing = await callTool(hosted, 'me')
  const missingError = JSON.parse(missing.text) as Record<string, unknown>
  assert.equal(missing.response.status, 401)
  assert.equal(missingError.error_class, 'auth_required')
  assert.equal(missingError.http_status, undefined)
  assert.equal(missing.body.result._meta?.['mcp/www_authenticate']?.length, 1)

  const wrongHostedCredential = await callTool(hosted, 'me', {}, `Bearer ${merchantSecret}`)
  assert.equal(
    (JSON.parse(wrongHostedCredential.text) as Record<string, unknown>).error_class,
    'auth_required',
  )

  const ordinary = gateway(new Hono())
  const wrongOrdinaryCredential = await callTool(ordinary, 'browse', {}, `Bearer ${ACCESS_TOKEN}`)
  assert.equal(
    (JSON.parse(wrongOrdinaryCredential.text) as Record<string, unknown>).error_class,
    'auth_required',
  )
})

test('machine error classes are stated on every contract mirror before MCP use', () => {
  for (const path of ['src/frontdoor.txt', 'src/llms.txt', 'docs/SPEC.md', 'docs/DECISIONS.md']) {
    const text = readFileSync(path, 'utf8')
    assert.match(
      text,
      /error_class[\s\S]*bad_input[\s\S]*not_found[\s\S]*auth_required[\s\S]*forbidden[\s\S]*payment_required[\s\S]*conflict[\s\S]*rate_limited[\s\S]*market_fault[\s\S]*unreachable/iu,
      path,
    )
    assert.match(text, /http_status/iu, path)
    assert.match(text, /retry_after_seconds/iu, path)
    assert.match(text, /status or\s+transport state[^.]*never[^.]*body/iu, path)
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
    { name: 'browse', arguments: {} },
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
    const parsed = JSON.parse(invalidStoreBody.result.content[0]!.text) as Record<string, unknown>
    assert.equal(parsed.error, 'no such store')
    assert.equal(parsed.error_class, 'not_found')
    assert.equal(parsed.http_status, 404)
  }

  const unknownTool = await app.request('/mcp', jsonRequest({
    jsonrpc: '2.0', id: 12, method: 'tools/call', params: { arguments: null },
  }))
  assert.deepEqual(await unknownTool.json(), {
    jsonrpc: '2.0', id: 12, error: { code: -32602, message: 'no such tool: ' },
  })
})

test('known tools reject non-object arguments before any backing request', async () => {
  let backingCalls = 0
  const backing = new Hono()
  backing.all('*', c => {
    backingCalls += 1
    return c.json({ unexpected: true })
  })
  const app = gateway(backing)

  for (const arguments_ of [null, [], 'not-an-object']) {
    const response = await app.request('/mcp', jsonRequest({
      jsonrpc: '2.0', id: 'argument-shape', method: 'tools/call',
      params: { name: 'browse', arguments: arguments_ },
    }))
    const body = await response.json() as {
      result: { isError: boolean; content: Array<{ text: string }> }
    }
    assert.equal(body.result.isError, true)
    const parsed = JSON.parse(body.result.content[0]!.text) as Record<string, unknown>
    assert.equal(parsed.error, 'Tool arguments must be an object.')
    assert.equal(parsed.error_class, 'bad_input')
    assert.equal(parsed.http_status, undefined)
  }
  assert.equal(backingCalls, 0)
})

test('connector parity tools preserve route methods, bodies, filters, and paging cursors', async () => {
  const seen: Array<{ method: string; path: string; body: unknown }> = []
  const backing = new Hono()
  backing.all('*', async c => {
    const url = new URL(c.req.url)
    seen.push({
      method: c.req.method,
      path: url.pathname + url.search,
      body: c.req.method === 'GET' ? null : await c.req.json(),
    })
    return c.json({ ok: true })
  })
  const app = gateway(backing)
  const calls = [
    { name: 'visit_store', arguments: { handle: 'agent-8', before_id: 44, limit: 5 } },
    { name: 'world_status', arguments: { draft_id: 12 } },
    { name: 'world_status', arguments: { checkout_id: 13 } },
    { name: 'my_purchases', arguments: { before_id: 14, limit: 2 } },
    { name: 'me', arguments: { listings_before_id: 15, listings_limit: 4, sales_limit: 5 } },
    { name: 'vote', arguments: { listing_id: 6 } },
    { name: 'read_events', arguments: { kind: 'listing_created', before_id: 31, limit: 7 } },
    { name: 'read_events', arguments: { scope: 'window', limit: 9 } },
    { name: 'merchants', arguments: { after_id: 21, limit: 11 } },
  ]

  for (const params of calls) {
    const response = await app.request('/mcp', jsonRequest({
      jsonrpc: '2.0', id: params.name, method: 'tools/call', params,
    }))
    const body = await response.json() as { result: { isError: boolean } }
    assert.equal(body.result.isError, false, params.name)
  }

  assert.deepEqual(seen, [
    { method: 'GET', path: '/api/store/agent-8?before_id=44&limit=5', body: null },
    { method: 'GET', path: '/api/world/draft/12', body: null },
    { method: 'GET', path: '/api/world/checkout/13', body: null },
    { method: 'GET', path: '/api/purchases?before_id=14&limit=2', body: null },
    { method: 'GET', path: '/api/me?listings_before_id=15&listings_limit=4&sales_limit=5', body: null },
    { method: 'POST', path: '/api/vote', body: { listing_id: 6 } },
    { method: 'GET', path: '/api/events?kind=listing_created&before_id=31&limit=7', body: null },
    { method: 'GET', path: '/api/events?scope=window&limit=9', body: null },
    { method: 'GET', path: '/api/merchants?after_id=21&limit=11', body: null },
  ])
})

test('world_status rejects both and neither id without dispatching a backing request', async () => {
  let backingCalls = 0
  const backing = new Hono()
  backing.all('*', c => {
    backingCalls += 1
    return c.json({ unexpected: true })
  })
  const app = gateway(backing)

  for (const arguments_ of [{}, { draft_id: 1, checkout_id: 2 }]) {
    const response = await app.request('/mcp', jsonRequest({
      jsonrpc: '2.0', id: 'world-status', method: 'tools/call',
      params: { name: 'world_status', arguments: arguments_ },
    }))
    const body = await response.json() as {
      result: { isError: boolean; content: Array<{ text: string }> }
    }
    assert.equal(body.result.isError, true)
    const parsed = JSON.parse(body.result.content[0]!.text) as Record<string, unknown>
    assert.equal(parsed.error, 'Send exactly one of draft_id or checkout_id.')
    assert.equal(parsed.error_class, 'bad_input')
    assert.equal(parsed.http_status, undefined)
  }
  for (const [arguments_, error] of [
    [{ draft_id: 0 }, 'draft_id must be an integer from 1 to 2147483647.'],
    [{ checkout_id: 2147483648 }, 'checkout_id must be an integer from 1 to 2147483647.'],
    [{ draft_id: '1' }, 'draft_id must be an integer from 1 to 2147483647.'],
  ] as const) {
    const response = await app.request('/mcp', jsonRequest({
      jsonrpc: '2.0', id: 'world-status-id', method: 'tools/call',
      params: { name: 'world_status', arguments: arguments_ },
    }))
    const body = await response.json() as {
      result: { isError: boolean; content: Array<{ text: string }> }
    }
    assert.equal(body.result.isError, true)
    const parsed = JSON.parse(body.result.content[0]!.text) as Record<string, unknown>
    assert.equal(parsed.error, error)
    assert.equal(parsed.error_class, 'bad_input')
    assert.equal(parsed.http_status, undefined)
  }
  assert.equal(backingCalls, 0)
})

test('new connector arguments reject invalid filters and limits instead of silently dropping them', async () => {
  let backingCalls = 0
  const backing = new Hono()
  backing.all('*', c => {
    backingCalls += 1
    return c.json({ unexpected: true })
  })
  const app = gateway(backing)
  const cases: Array<{
    name: string
    arguments: Record<string, unknown>
    error: string
  }> = [
    {
      name: 'visit_store', arguments: { handle: 'agent-8', limit: '5' },
      error: 'limit must be an integer from 1 to 50.',
    },
    {
      name: 'visit_store', arguments: { handle: 'agent-8', before_id: 0 },
      error: 'before_id must be an integer from 1 to 2147483647.',
    },
    {
      name: 'read_events', arguments: { kind: 'sale', scope: 'door' },
      error: 'scope and kind cannot be combined',
    },
    {
      name: 'read_events', arguments: { kind: 'x'.repeat(41) },
      error: 'kind must be 1 to 40 characters.',
    },
    {
      name: 'read_events', arguments: { scope: 'private' },
      error: 'scope must be door or window.',
    },
    {
      name: 'read_events', arguments: { limit: 201 },
      error: 'limit must be an integer from 1 to 200.',
    },
    {
      name: 'merchants', arguments: { after_id: [] },
      error: 'after_id must be an integer from 1 to 2147483647.',
    },
    {
      name: 'merchants', arguments: { limit: 501 },
      error: 'limit must be an integer from 1 to 500.',
    },
    {
      name: 'vote', arguments: { listing_id: '1' },
      error: 'listing_id must be an integer from 1 to 2147483647.',
    },
    {
      name: 'vote', arguments: { listing_id: 6, dry_run: true },
      error: 'Unexpected argument: dry_run. Remove it and retry.',
    },
    {
      name: 'read_events', arguments: { limt: 5 },
      error: 'Unexpected argument: limt. Remove it and retry.',
    },
    {
      name: 'my_purchases', arguments: { limit: 3 },
      error: 'limit must be an integer from 1 to 2.',
    },
    {
      name: 'me', arguments: { listings_limit: '4' },
      error: 'listings_limit must be an integer from 1 to 50.',
    },
    {
      name: 'me', arguments: { listings_before_id: 0 },
      error: 'listings_before_id must be an integer from 1 to 2147483647.',
    },
    {
      name: 'world_status', arguments: { draft_id: 1, checkout: 2, force: true },
      error: 'Unexpected arguments: checkout, force. Remove them and retry.',
    },
    {
      name: 'vote', arguments: { listing_id: 6, ['unsafe\nargument']: true },
      error: 'Unexpected argument name. Remove unsupported arguments and retry.',
    },
  ]

  for (const item of cases) {
    const response = await app.request('/mcp', jsonRequest({
      jsonrpc: '2.0', id: item.name, method: 'tools/call',
      params: { name: item.name, arguments: item.arguments },
    }))
    const body = await response.json() as {
      result: { isError: boolean; content: Array<{ text: string }> }
    }
    assert.equal(body.result.isError, true, item.name)
    const parsed = JSON.parse(body.result.content[0]!.text) as Record<string, unknown>
    assert.equal(parsed.error, item.error, item.name)
    assert.equal(parsed.error_class, 'bad_input', item.name)
    assert.equal(parsed.http_status, undefined, item.name)
  }
  assert.equal(backingCalls, 0)
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
    const parsed = JSON.parse(body.result.content[0]!.text) as Record<string, unknown>
    assert.equal(parsed.error, call.error, call.name)
    assert.equal(parsed.error_class, 'bad_input', call.name)
    assert.equal(parsed.http_status, 400, call.name)
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
