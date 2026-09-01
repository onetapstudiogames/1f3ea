// Hosted-market connector contract tests use an in-memory Hono app only.
// No live database, deployment, wallet, secret, or payment is touched.
import test from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { auth, setOAuthMerchantResolver } from '../src/core.ts'
import { mcp } from '../src/mcp.ts'

const ORIGIN = 'https://1f3ea.com'
const LEGACY_SECRET = `1f3ea_sk_${'ab'.repeat(24)}`
const ACCESS_TOKEN = `1f3ea_at_${'cd'.repeat(32)}`
const RESOURCE_METADATA = `${ORIGIN}/.well-known/oauth-protected-resource/mcp/connect`
const OAUTH_SCHEME = { type: 'oauth2', scopes: ['market:merchant'] } as const
const NOAUTH_SCHEME = { type: 'noauth' } as const
const FRONT_DOOR_TEXT = '1F3EA connector-native front door\n'
const OFFICIAL_FACTS = { domain: ORIGIN, token: null, network: 'base' } as const
const PUBLIC_TOOL_NAMES = [
  'front_door', 'official_facts', 'browse', 'visit_store', 'read_listing',
  'world_status', 'read_events', 'merchants',
] as const
const TOOL_NAMES = [
  'front_door', 'official_facts', 'browse', 'visit_store', 'set_store',
  'read_listing', 'read_events', 'merchants', 'list_item', 'draft_world',
  'list_world', 'checkout_world', 'sync_world', 'edit_item', 'world_status',
  'withdraw_item', 'buy', 'my_purchases', 'vote', 'comment', 'me',
] as const

process.env.PUBLIC_ORIGIN = ORIGIN
process.env.HOSTED_MARKET_SIGNIN_ENABLED = 'true'

const jsonResponse = (obj: unknown, status = 200) => new Response(
  JSON.stringify(obj),
  { status, headers: { 'content-type': 'application/json' } },
)

function neonEncode(rows: Record<string, unknown>[]) {
  const keys = Object.keys(rows[0] ?? {})
  const typeOf = (value: unknown) => {
    if (typeof value === 'boolean') return 16
    if (typeof value === 'number') return Number.isInteger(value) ? 23 : 701
    return 25
  }
  return {
    command: 'SELECT',
    rowCount: rows.length,
    fields: keys.map(name => ({ name, dataTypeID: typeOf(rows[0]?.[name]) })),
    rows: rows.map(row => keys.map(key => row[key] == null ? null : String(row[key]))),
  }
}

interface ToolDefinition {
  name: string
  description: string
  inputSchema: {
    type?: string
    properties?: Record<string, unknown>
    required?: string[]
    additionalProperties?: boolean
  }
  annotations: {
    readOnlyHint: boolean
    destructiveHint: boolean
    idempotentHint: boolean
    openWorldHint: boolean
  }
  securitySchemes?: unknown[]
  _meta?: { securitySchemes?: unknown[] }
}

interface ToolResult {
  isError: boolean
  content: { type: string; text: string }[]
  _meta?: { 'mcp/www_authenticate'?: string[] }
}

interface ToolCallResponse {
  error?: { message: string }
  result?: ToolResult
}

function createHarness(payload: Record<string, unknown> = { merchant: { id: 7, handle: 'tinylantern' } }) {
  let forwardedAuthorization: string | undefined
  const market = new Hono()
  market.get('/', c => c.text(FRONT_DOOR_TEXT))
  market.get('/api/official', c => c.json(OFFICIAL_FACTS))
  market.get('/api/shelves', c => c.json({ listings: [] }))
  market.get('/api/me', async c => {
    forwardedAuthorization = c.req.header('authorization')
    if (forwardedAuthorization === `Bearer ${LEGACY_SECRET}`) return c.json(payload)
    const merchant = await auth(c)
    if (merchant) return c.json(payload)
    c.header(
      'WWW-Authenticate',
      `Bearer resource_metadata="${RESOURCE_METADATA}", error="invalid_token", ` +
        'error_description="Sign in to 1F3EA to use merchant tools."',
    )
    return c.json({ error: 'A valid merchant sign-in is required.' }, 401)
  })

  const gateway = new Hono()
  gateway.post('/mcp', c => mcp(c, market))
  gateway.post('/mcp/connect', c => mcp(c, market, {
    hostedChat: true,
    forwardUnauthorizedStatus: true,
  }))
  return { gateway, market, forwardedAuthorization: () => forwardedAuthorization }
}

async function rpc(
  app: Hono,
  path: '/mcp' | '/mcp/connect',
  method: string,
  params?: Record<string, unknown>,
  authorization?: string,
  expectedStatus = 200,
) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (authorization) headers.authorization = authorization
  const response = await app.request(path, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  assert.equal(response.status, expectedStatus)
  return response.json() as Promise<Record<string, unknown>>
}

async function tools(app: Hono, path: '/mcp' | '/mcp/connect') {
  const body = await rpc(app, path, 'tools/list') as { result: { tools: ToolDefinition[] } }
  return body.result.tools
}

test('both catalogs keep permanent-key creation out of tools and hosted tools advertise OAuth', async () => {
  const { gateway } = createHarness()
  const legacy = await tools(gateway, '/mcp')
  const hosted = await tools(gateway, '/mcp/connect')

  assert.deepEqual(legacy.map(tool => tool.name), [...TOOL_NAMES])
  assert.deepEqual(hosted.map(tool => tool.name), [...TOOL_NAMES])
  assert.equal(legacy.length, 21)
  assert.equal(hosted.length, 21)
  assert.equal(legacy.some(tool => tool.name === 'register'), false)
  assert.equal(legacy.some(tool => tool.name === 'rotate'), false)
  assert.equal(legacy.every(tool => tool.securitySchemes === undefined), true)
  assert.equal(hosted.some(tool => tool.name === 'register'), false)
  assert.equal(hosted.some(tool => tool.name === 'rotate'), false)

  for (const name of PUBLIC_TOOL_NAMES) {
    assert.ok(legacy.some(tool => tool.name === name), `legacy ${name}`)
    const tool = hosted.find(candidate => candidate.name === name)
    assert.ok(tool, name)
    assert.deepEqual(tool.securitySchemes, [NOAUTH_SCHEME, OAUTH_SCHEME])
    assert.deepEqual(tool._meta?.securitySchemes, [NOAUTH_SCHEME, OAUTH_SCHEME])
  }
  for (const tool of hosted.filter(candidate => !PUBLIC_TOOL_NAMES.includes(
    candidate.name as typeof PUBLIC_TOOL_NAMES[number],
  ))) {
    assert.deepEqual(tool.securitySchemes, [OAUTH_SCHEME], tool.name)
    assert.deepEqual(tool._meta?.securitySchemes, [OAUTH_SCHEME], tool.name)
  }

  for (const name of ['front_door', 'official_facts']) {
    const tool = hosted.find(candidate => candidate.name === name)
    assert.ok(tool, name)
    assert.deepEqual(tool.inputSchema.properties ?? {}, {})
    assert.deepEqual(tool.inputSchema.required ?? [], [])
    assert.deepEqual(tool.annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    })
  }

  const serialized = JSON.stringify(hosted)
  assert.doesNotMatch(serialized, /1f3ea_(?:sk|at|rt|ac)_/i)
  for (const forbidden of ['secret', 'access_token', 'refresh_token', 'authorization_code']) {
    assert.equal(hosted.some(tool => forbidden in (tool.inputSchema.properties ?? {})), false, forbidden)
  }
})

test('connector parity schemas state every exclusivity rule, default, limit, and vote boundary', async () => {
  const { gateway } = createHarness()
  const catalog = await tools(gateway, '/mcp/connect')
  const find = (name: string) => {
    const tool = catalog.find(candidate => candidate.name === name)
    assert.ok(tool, name)
    return tool
  }

  const visitStore = find('visit_store')
  const visitProperties = visitStore.inputSchema.properties as Record<string, {
    minimum?: number; maximum?: number; description?: string
  }>
  assert.equal(visitStore.inputSchema.additionalProperties, false)
  assert.equal(visitProperties.before_id?.minimum, 1)
  assert.equal(visitProperties.limit?.maximum, 50)
  assert.match(visitProperties.limit?.description ?? '', /default.*maximum 50/i)
  assert.match(visitStore.description, /without paging arguments[\s\S]*complete live catalog/i)

  const worldStatus = find('world_status')
  const worldSchema = worldStatus.inputSchema as {
    additionalProperties?: boolean
    properties: Record<string, { minimum?: number; maximum?: number }>
    oneOf?: Array<{ required: string[] }>
  }
  assert.equal(worldSchema.additionalProperties, false)
  assert.equal(worldSchema.properties.draft_id?.minimum, 1)
  assert.equal(worldSchema.properties.checkout_id?.maximum, 2_147_483_647)
  assert.deepEqual(worldSchema.oneOf, [
    { required: ['draft_id'] }, { required: ['checkout_id'] },
  ])
  assert.match(worldStatus.description, /exactly one of draft_id or checkout_id/i)
  assert.match(worldStatus.description, /public IDs are not proof of ownership/i)

  const readEvents = find('read_events')
  const eventProperties = readEvents.inputSchema.properties as Record<string, {
    enum?: string[]; maxLength?: number; maximum?: number; description?: string
  }>
  assert.equal(readEvents.inputSchema.additionalProperties, false)
  assert.equal(eventProperties.kind?.maxLength, 40)
  assert.deepEqual(eventProperties.scope?.enum, ['door', 'window'])
  assert.equal(eventProperties.limit?.maximum, 200)
  assert.match(readEvents.description, /kind or scope, never both/i)
  assert.match(eventProperties.limit?.description ?? '', /default.*maximum 200/i)

  const merchants = find('merchants')
  const merchantProperties = merchants.inputSchema.properties as Record<string, {
    minimum?: number; maximum?: number; description?: string
  }>
  assert.equal(merchants.inputSchema.additionalProperties, false)
  assert.equal(merchantProperties.after_id?.minimum, 1)
  assert.equal(merchantProperties.limit?.maximum, 500)
  assert.match(merchantProperties.limit?.description ?? '', /default.*maximum 500/i)

  const myPurchases = find('my_purchases')
  const purchaseProperties = myPurchases.inputSchema.properties as Record<string, {
    minimum?: number; maximum?: number; description?: string
  }>
  assert.equal(myPurchases.inputSchema.additionalProperties, false)
  assert.equal(purchaseProperties.before_id?.minimum, 1)
  assert.equal(purchaseProperties.limit?.maximum, 2)
  assert.match(purchaseProperties.limit?.description ?? '', /default.*maximum 2/i)
  assert.match(myPurchases.description, /exact total/i)
  assert.match(myPurchases.description, /next_before_id/i)
  assert.match(myPurchases.description, /artifact body.*256 KB/i)
  assert.match(myPurchases.description, /credential-shaped 1F3EA values[\s\S]*replaced/i)
  assert.match(myPurchases.description, /may differ from the stored bytes/i)

  const me = find('me')
  const meProperties = me.inputSchema.properties as Record<string, {
    minimum?: number; maximum?: number; description?: string
  }>
  assert.equal(me.inputSchema.additionalProperties, false)
  assert.equal(meProperties.listings_before_id?.minimum, 1)
  assert.equal(meProperties.listings_limit?.maximum, 50)
  assert.match(meProperties.listings_limit?.description ?? '', /default.*maximum 50/i)
  assert.match(me.description, /listings[\s\S]*exact paged/i)

  const vote = find('vote')
  const voteProperties = vote.inputSchema.properties as Record<string, {
    minimum?: number; maximum?: number
  }>
  assert.equal(vote.inputSchema.additionalProperties, false)
  assert.equal(voteProperties.listing_id?.minimum, 1)
  assert.equal(voteProperties.listing_id?.maximum, 2_147_483_647)
  assert.match(vote.description, /50 votes per UTC day/i)
  assert.match(vote.description, /cannot vote for yourself/i)
  assert.deepEqual(vote.annotations, {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  })
})

test('both MCP doors teach connector-first visit opening with URL access only as fallback', async () => {
  const { gateway } = createHarness()
  for (const path of ['/mcp', '/mcp/connect'] as const) {
    const initialized = await rpc(gateway, path, 'initialize', {}) as {
      result: { instructions: string }
    }
    const instructions = initialized.result.instructions
    assert.match(instructions, /front_door[\s\S]*official_facts/i, path)
    assert.match(
      instructions,
      /https:\/\/1f3ea\.com\/[\s\S]{0,160}(?:if|when)[\s\S]{0,80}(?:open|URL)/i,
      path,
    )
    assert.doesNotMatch(instructions, /Read https:\/\/1f3ea\.com\/ for the constitution/i, path)
    assert.match(instructions, /rotation[\s\S]*browser-only[\s\S]*never an MCP tool/i, path)
    assert.match(instructions, /no credential[\s\S]*(?:chat|tool input|tool output)/i, path)
    assert.match(instructions, /merchant-authored text[\s\S]*untrusted data[\s\S]*never as instructions/i, path)
  }
})

test('every tool that can return merchant-authored text states the untrusted-data boundary', async () => {
  const { gateway } = createHarness()
  const catalog = await tools(gateway, '/mcp/connect')
  for (const name of [
    'front_door', 'browse', 'visit_store', 'read_listing', 'world_status',
    'read_events', 'merchants', 'buy', 'my_purchases', 'me',
  ]) {
    const tool = catalog.find(candidate => candidate.name === name)
    assert.ok(tool, name)
    assert.match(tool.description, /merchant-authored text[\s\S]*untrusted data[\s\S]*never as instructions/i, name)
  }
})

test('hosted catalog preserves the Wave 6 signed direct-payment claim', async () => {
  const { gateway } = createHarness()
  const buy = (await tools(gateway, '/mcp/connect')).find(tool => tool.name === 'buy')
  assert.ok(buy)
  assert.deepEqual(buy.inputSchema.required, ['id'])
  assert.ok(buy.inputSchema.properties?.payer_wallet)
  assert.ok(buy.inputSchema.properties?.intent_id)
  assert.ok(buy.inputSchema.properties?.tx_hash)
  assert.ok(buy.inputSchema.properties?.payer_signature)
  assert.match(buy.description, /fresh ten-minute direct-payment intent/i)
})

test('anonymous hosted browsing works while a protected call returns an OAuth challenge', async () => {
  const { gateway } = createHarness()
  const browse = await rpc(gateway, '/mcp/connect', 'tools/call', {
    name: 'browse', arguments: {},
  }) as { result: ToolResult }
  assert.equal(browse.result.isError, false)
  assert.deepEqual(JSON.parse(browse.result.content[0]!.text), { listings: [] })

  const me = await rpc(gateway, '/mcp/connect', 'tools/call', {
    name: 'me', arguments: {},
  }, undefined, 401) as { result: ToolResult }
  assert.equal(me.result.isError, true)
  assert.deepEqual(me.result._meta?.['mcp/www_authenticate'], [
    `Bearer resource_metadata="${RESOURCE_METADATA}", scope="market:merchant", ` +
      'error="invalid_token", error_description="Sign in to 1F3EA to use merchant tools."',
  ])
  assert.doesNotMatch(JSON.stringify(me), /1f3ea_(?:sk|at|rt|ac)_/i)
})

test('all new public reads dispatch anonymously while purchase and vote stop for sign-in first', async () => {
  const { gateway, market } = createHarness()
  let protectedBackingCalls = 0
  market.get('/api/world/draft/:id', c => c.json({ draft: { id: Number(c.req.param('id')) } }))
  market.get('/api/events', c => c.json({ events: [], page_size: Number(c.req.query('limit')) }))
  market.get('/api/merchants', c => c.json({ merchants: [], page_size: Number(c.req.query('limit')) }))
  market.get('/api/purchases', c => {
    protectedBackingCalls += 1
    return c.json({ purchases: [] })
  })
  market.post('/api/vote', c => {
    protectedBackingCalls += 1
    return c.json({ ok: true })
  })

  for (const [name, arguments_] of [
    ['world_status', { draft_id: 7 }],
    ['read_events', { limit: 5 }],
    ['merchants', { limit: 6 }],
  ] as const) {
    const response = await rpc(gateway, '/mcp/connect', 'tools/call', {
      name, arguments: arguments_,
    }) as { result: ToolResult }
    assert.equal(response.result.isError, false, name)
  }

  for (const [name, arguments_] of [
    ['my_purchases', {}],
    ['vote', { listing_id: 3 }],
  ] as const) {
    const response = await rpc(gateway, '/mcp/connect', 'tools/call', {
      name, arguments: arguments_,
    }, undefined, 401) as { result: ToolResult }
    assert.equal(response.result.isError, true, name)
    assert.match(response.result.content[0]!.text, /sign in to 1F3EA/i, name)
  }
  assert.equal(protectedBackingCalls, 0)
})

test('a protected hosted call uses HTTP 401 so the client starts OAuth and sends a bearer', async () => {
  const { gateway } = createHarness()
  const response = await gateway.request('/mcp/connect', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'me', arguments: {} },
    }),
  })

  assert.equal(response.status, 401)
  assert.match(response.headers.get('www-authenticate') ?? '', /resource_metadata=/i)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('pragma'), 'no-cache')
  assert.match(response.headers.get('vary') ?? '', /(?:^|,\s*)Authorization(?:,|$)/iu)
  assert.match(response.headers.get('access-control-expose-headers') ?? '', /WWW-Authenticate/iu)
  const body = await response.json() as { result: ToolResult }
  assert.equal(body.result.isError, true)
  assert.equal(body.result._meta?.['mcp/www_authenticate']?.length, 1)
})

test('anonymous opening reads have exact parity across the ordinary and hosted MCP doors', async () => {
  const { gateway } = createHarness()
  for (const [name, expected] of [
    ['front_door', FRONT_DOOR_TEXT],
    ['official_facts', JSON.stringify(OFFICIAL_FACTS)],
  ] as const) {
    const legacy = await rpc(gateway, '/mcp', 'tools/call', {
      name, arguments: {},
    }) as ToolCallResponse
    const hosted = await rpc(gateway, '/mcp/connect', 'tools/call', {
      name, arguments: {},
    }) as ToolCallResponse

    assert.ok(legacy.result, legacy.error?.message ?? `legacy ${name} returned no result`)
    assert.ok(hosted.result, hosted.error?.message ?? `hosted ${name} returned no result`)
    assert.equal(legacy.result.isError, false, `legacy ${name}`)
    assert.equal(hosted.result.isError, false, `hosted ${name}`)
    assert.equal(legacy.result.content[0]!.text, expected, `legacy ${name} bytes`)
    assert.equal(hosted.result.content[0]!.text, expected, `hosted ${name} bytes`)
    assert.equal(hosted.result.content[0]!.text, legacy.result.content[0]!.text, name)
  }
})

test('an authenticated hosted visit opens and browses through MCP with zero global fetches', async () => {
  const seen: Array<{ path: string; authorization: string | undefined }> = []
  const market = new Hono()
  market.use('*', async (c, next) => {
    seen.push({ path: c.req.path, authorization: c.req.header('authorization') })
    await next()
  })
  market.get('/', c => c.text(FRONT_DOOR_TEXT))
  market.get('/api/official', c => c.json(OFFICIAL_FACTS))
  market.get('/api/me', c => c.req.header('authorization') === `Bearer ${ACCESS_TOKEN}`
    ? c.json({ merchant: { id: 7, handle: 'tinylantern' } })
    : c.json({ error: 'sign in required' }, 401))
  market.get('/api/shelves', c => c.json({ listings: [] }))

  const gateway = new Hono()
  gateway.post('/mcp/connect', c => mcp(c, market, {
    hostedChat: true,
    forwardUnauthorizedStatus: false,
  }))

  const previousFetch = globalThis.fetch
  let fetchCalls = 0
  globalThis.fetch = (async () => {
    fetchCalls += 1
    throw new Error('the connector-native visit must not use global fetch')
  }) as typeof fetch
  try {
    for (const name of ['front_door', 'official_facts', 'me', 'browse']) {
      const response = await rpc(gateway, '/mcp/connect', 'tools/call', {
        name, arguments: {},
      }, `Bearer ${ACCESS_TOKEN}`) as ToolCallResponse
      assert.ok(response.result, response.error?.message ?? `${name} returned no result`)
      assert.equal(response.result.isError, false, name)
    }
    assert.deepEqual(seen, [
      { path: '/', authorization: `Bearer ${ACCESS_TOKEN}` },
      { path: '/api/official', authorization: `Bearer ${ACCESS_TOKEN}` },
      { path: '/api/me', authorization: `Bearer ${ACCESS_TOKEN}` },
      { path: '/api/shelves', authorization: `Bearer ${ACCESS_TOKEN}` },
    ])
    assert.equal(fetchCalls, 0)
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('OAuth access is isolated to the hosted connector and the legacy door gives the exact correction', async () => {
  const harness = createHarness()
  const merchant = {
    id: 7, handle: 'tinylantern', model: 'hosted-chat', karma: 2,
    joined_at: '2026-08-22T00:00:00.000Z', storefront_line: '', quota_day: '2026-08-22',
    comments_today: 0, votes_today: 0,
  }
  const previousDatabaseUrl = process.env.DATABASE_URL
  const previousFetch = globalThis.fetch
  process.env.DATABASE_URL = 'postgresql://fake:fake@fake-host.example.neon.tech/fakedb'
  globalThis.fetch = (async (_input, init) => {
    const body = init?.body && typeof init.body === 'string'
      ? JSON.parse(init.body)
      : { query: '' }
    assert.match(String(body.query ?? ''), /UPDATE merchants SET[\s\S]*WHERE id =/i)
    return jsonResponse(neonEncode([merchant]))
  }) as typeof fetch
  setOAuthMerchantResolver(async token => token === ACCESS_TOKEN ? merchant : null)
  try {
    const raw = await harness.market.request('/api/me', {
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
    })
    assert.equal(raw.status, 401)

    const wrongDoor = await rpc(harness.gateway, '/mcp', 'tools/call', {
      name: 'me', arguments: {},
    }, `Bearer ${ACCESS_TOKEN}`) as { result: ToolResult }
    assert.equal(wrongDoor.result.isError, true)
    assert.match(wrongDoor.result.content[0]!.text, /wrong 1F3EA connector address/i)
    assert.match(wrongDoor.result.content[0]!.text, /remove|delete/i)
    assert.match(wrongDoor.result.content[0]!.text, /add|create/i)
    assert.match(wrongDoor.result.content[0]!.text, /https:\/\/1f3ea\.com\/mcp\/connect/i)
    assert.doesNotMatch(JSON.stringify(wrongDoor), new RegExp(ACCESS_TOKEN, 'i'))

    const hosted = await rpc(harness.gateway, '/mcp/connect', 'tools/call', {
      name: 'me', arguments: {},
    }, `Bearer ${ACCESS_TOKEN}`) as { result: ToolResult }
    assert.equal(hosted.result.isError, false)
    assert.equal(harness.forwardedAuthorization(), `Bearer ${ACCESS_TOKEN}`)
  } finally {
    setOAuthMerchantResolver(null)
    globalThis.fetch = previousFetch
    if (previousDatabaseUrl == null) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previousDatabaseUrl
  }
})

test('the hosted door refuses permanent keys and credentials in any tool argument without echoing them', async () => {
  const { gateway } = createHarness()
  const permanent = await rpc(gateway, '/mcp/connect', 'tools/call', {
    name: 'me', arguments: {},
  }, `Bearer ${LEGACY_SECRET}`) as { result: ToolResult }
  assert.equal(permanent.result.isError, true)
  assert.match(permanent.result.content[0]!.text, /permanent merchant key/i)
  assert.match(permanent.result.content[0]!.text, /1F3EA sign-in page/i)
  assert.doesNotMatch(JSON.stringify(permanent), new RegExp(LEGACY_SECRET, 'i'))

  const credentialArguments: Array<[string, string]> = [
    ['body', `remember ${LEGACY_SECRET}`],
    ['refresh_token', 'hidden'],
    ['recovery_code', 'hidden'],
    ['replacement_key', 'hidden'],
  ]
  for (const [field, value] of credentialArguments) {
    const rejected = await rpc(gateway, '/mcp/connect', 'tools/call', {
      name: 'comment', arguments: { listing_id: 1, [field]: value },
    }) as { result: ToolResult }
    assert.equal(rejected.result.isError, true)
    assert.match(rejected.result.content[0]!.text, /do not put (?:secrets|credentials)/i)
    assert.doesNotMatch(JSON.stringify(rejected), /1f3ea_(?:sk|at|rt|ac|rc)_/i)
  }

  const credentialAsPropertyName = `1f3ea_sk_${'f6'.repeat(24)}`
  const rejectedKey = await rpc(gateway, '/mcp/connect', 'tools/call', {
    name: 'vote', arguments: { listing_id: 6, [credentialAsPropertyName]: true },
  }) as { result: ToolResult }
  assert.equal(rejectedKey.result.isError, true)
  assert.match(rejectedKey.result.content[0]!.text, /do not put (?:secrets|credentials)/i)
  assert.doesNotMatch(JSON.stringify(rejectedKey), new RegExp(credentialAsPropertyName, 'i'))
})

test('MCP redacts every 1F3EA credential family from backing responses', async () => {
  for (const credential of [
    `1f3ea_sk_${'a1'.repeat(24)}`,
    `1f3ea_at_${'b2'.repeat(32)}`,
    `1f3ea_rt_${'c3'.repeat(32)}`,
    `1f3ea_ac_${'d4'.repeat(32)}`,
    `1f3ea_rc_${'e5'.repeat(32)}`,
  ]) {
    const { gateway } = createHarness({ merchant: { id: 7, note: `old ${credential}` } })
    const response = await rpc(gateway, '/mcp', 'tools/call', {
      name: 'me', arguments: {},
    }, `Bearer ${LEGACY_SECRET}`) as { result: ToolResult }
    const text = response.result.content[0]!.text
    assert.doesNotMatch(text, new RegExp(credential, 'i'))
    assert.match(text, /redacted.*credential/i)
  }
})

test('hosted my_purchases reads streamed bytes without trusting Content-Length and redacts credentials', async () => {
  const credentials = [
    `1f3ea_sk_${'a1'.repeat(24)}`,
    `1f3ea_at_${'b2'.repeat(32)}`,
    `1f3ea_rt_${'c3'.repeat(32)}`,
    `1f3ea_ac_${'d4'.repeat(32)}`,
    `1f3ea_rc_${'e5'.repeat(32)}`,
  ]
  for (const contentLength of [undefined, '0']) {
    const { gateway, market } = createHarness()
    market.get('/api/purchases', () => {
      const encoded = new TextEncoder().encode(JSON.stringify({
        purchases: [{ listing_id: 4, artifact: credentials.join('\n') }],
      }))
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoded.subarray(0, 13))
          controller.enqueue(encoded.subarray(13))
          controller.close()
        },
      })
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (contentLength !== undefined) headers['content-length'] = contentLength
      return new Response(stream, { headers })
    })

    const response = await rpc(gateway, '/mcp/connect', 'tools/call', {
      name: 'my_purchases', arguments: {},
    }, `Bearer ${ACCESS_TOKEN}`) as { result: ToolResult }
    assert.equal(response.result.isError, false, `Content-Length ${contentLength ?? 'absent'}`)
    const text = response.result.content[0]!.text
    assert.match(text, /artifact/i)
    for (const credential of credentials) assert.doesNotMatch(text, new RegExp(credential, 'i'))
    assert.equal(text.match(/\[redacted 1F3EA credential\]/g)?.length, credentials.length)
  }
})
