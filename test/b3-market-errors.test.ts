import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { Hono } from 'hono'

process.env.DATABASE_URL = 'postgresql://fake:fake@fake-host.example.neon.tech/fakedb'
process.env.TREASURY_ADDRESS = '0x3b9d230c9b995fb1a10add2d63ce37437916dcfd'

const { default: app } = await import('../src/index.ts')
const { MCP_TOOLS } = await import('../src/mcp-tool-catalog.ts')
const {
  MARKET_REFUSAL_REASONS,
  marketJsonRefusal,
  secondsUntilNextUtcDay,
  secondsUntilNextUtcHour,
} = await import('../src/market-refusal.ts')
const { unexpectedMarketFailure } = await import('../src/market-failure.ts')
const { harness: identityHarness } = await import('./support/market-identity-browser-harness.ts')
const {
  authorizationUrl,
  environment: oauthEnvironment,
  fixture: oauthFixture,
  MemoryOAuthStore,
  mountMarketOAuthRoutes,
} = await import('./support/market-oauth-flow-harness.ts')

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

test('UTC retry hints report only the remaining window', async t => {
  assert.equal(secondsUntilNextUtcHour(Date.UTC(2026, 8, 11, 10, 59, 50)), 10)
  assert.equal(secondsUntilNextUtcDay(Date.UTC(2026, 8, 11, 23, 59, 50)), 10)
  assert.equal(secondsUntilNextUtcHour(Date.UTC(2026, 8, 11, 10, 0, 0, 1)), 3600)
  assert.equal(secondsUntilNextUtcDay(Date.UTC(2026, 8, 11, 0, 0, 0, 1)), 86_400)

  const originalNow = Date.now
  Date.now = () => Date.UTC(2026, 8, 11, 10, 59, 50)
  t.after(() => { Date.now = originalNow })
  const app = new Hono()
  app.get('/hour', c => marketJsonRefusal(
    c, 429, 'rate_limited', 'The prose mentions a UTC day but this quota resets hourly.', undefined, 'utc_hour',
  ))
  const response = await app.request('/hour')
  assert.equal(response.headers.get('retry-after'), '10')
  assert.equal((await response.json() as { retry_after_seconds: number }).retry_after_seconds, 10)
})

test('market refusals return a quoteable reference and log only fixed redacted fields', async t => {
  const secret = `1f3ea_sk_${'a'.repeat(48)}`
  const lines: string[] = []
  const original = console.error
  console.error = (...values: unknown[]) => lines.push(values.map(String).join(' '))
  t.after(() => { console.error = original })

  const refusalApp = new Hono()
  refusalApp.post('/identity/:input', c => marketJsonRefusal(
    c, 403, 'credential_rejected', 'That credential was rejected.', 'Check the saved key and retry.',
  ))
  const response = await refusalApp.request(`/identity/${secret}?token=${secret}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ [`unsupported_${secret}`]: secret }),
  })
  const body = await response.json() as Record<string, unknown>

  assert.match(String(body.request_id), UUID)
  assert.equal(response.headers.get('x-request-id'), body.request_id)
  assert.equal(response.headers.get('x-1f3ea-reason'), 'credential_rejected')
  assert.equal(response.headers.get('x-1f3ea-error-class'), 'forbidden')
  assert.equal(body.next_step, 'Check the saved key and retry.')
  assert.equal(body.front_door, 'https://1f3ea.com/')
  assert.equal(lines.length, 1)
  assert.match(lines[0]!, /market_refusal/u)
  assert.match(lines[0]!, /\/identity\/:input/u)
  assert.doesNotMatch(JSON.stringify(body) + lines[0], new RegExp(secret, 'u'))
  assert.doesNotMatch(lines[0]!, /token=/u)
})

test('unexpected failures return a safe name and request id without logging raw errors', async t => {
  const secret = `1f3ea_sk_${'b'.repeat(48)}`
  const lines: string[] = []
  const original = console.error
  console.error = (...values: unknown[]) => lines.push(values.map(String).join(' '))
  t.after(() => { console.error = original })

  const failureApp = new Hono()
  failureApp.onError(unexpectedMarketFailure)
  failureApp.get('/break/:input', () => {
    const error = new Error(`raw message ${secret}`)
    error.name = secret
    throw error
  })
  const response = await failureApp.request(`/break/${secret}?authorization=${secret}`)
  const text = await response.text()
  const body = JSON.parse(text) as Record<string, unknown>

  assert.equal(response.status, 500)
  assert.equal(body.error_name, 'Error')
  assert.match(String(body.request_id), UUID)
  assert.equal(response.headers.get('x-request-id'), body.request_id)
  assert.equal(lines.length, 1)
  assert.match(lines[0]!, /request_failure/u)
  assert.doesNotMatch(text + lines[0], new RegExp(secret, 'u'))
  assert.doesNotMatch(lines[0]!, /raw message|authorization=/u)
})

test('unknown browser paths render links while agent calls keep the JSON contract', async () => {
  const browser = await app.request('/this-page-does-not-exist', {
    headers: { accept: 'text/html,application/xhtml+xml' },
  })
  assert.equal(browser.status, 404)
  assert.match(browser.headers.get('content-type') ?? '', /text\/html/iu)
  const page = await browser.text()
  assert.match(page, /Page not found/iu)
  assert.match(page, /href="\/"/u)
  assert.match(page, /href="\/window"/u)

  const agent = await app.request('/this-page-does-not-exist', {
    headers: { accept: 'application/json' },
  })
  assert.equal(agent.status, 404)
  assert.match(agent.headers.get('content-type') ?? '', /application\/json/iu)
  assert.equal((await agent.json() as { front_door_tool?: string }).front_door_tool, 'front_door')

  const refused = await app.request('/this-page-does-not-exist', {
    headers: { accept: 'text/html;q=0,application/json' },
  })
  assert.match(refused.headers.get('content-type') ?? '', /application\/json/iu)
  const jsonPreferred = await app.request('/this-page-does-not-exist', {
    headers: { accept: 'application/json;q=1,text/html;q=0.1' },
  })
  assert.match(jsonPreferred.headers.get('content-type') ?? '', /application\/json/iu)
  const browserWildcard = await app.request('/this-page-does-not-exist', {
    headers: { accept: 'text/html,*/*;q=0.8' },
  })
  assert.match(browserWildcard.headers.get('content-type') ?? '', /text\/html/iu)
  const exactHtmlRefusal = await app.request('/this-page-does-not-exist', {
    headers: { accept: 'text/html;q=0,*/*;q=0.8' },
  })
  assert.match(exactHtmlRefusal.headers.get('content-type') ?? '', /application\/json/iu)
  const noAccept = await app.request('/this-page-does-not-exist')
  assert.match(noAccept.headers.get('content-type') ?? '', /application\/json/iu)
  assert.equal(browser.headers.get('vary'), 'Accept')
})

test('front door tool names and refusal reasons come from their canonical lists', () => {
  const frontDoor = readFileSync('src/frontdoor.txt', 'utf8')
  const names = MCP_TOOLS.map(tool => tool.name).join(', ')
  assert.match(frontDoor, new RegExp(`Tools: ${names.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.`, 'u'))
  for (const reason of MARKET_REFUSAL_REASONS) assert.match(frontDoor, new RegExp(`\\b${reason}\\b`, 'u'), reason)
})

test('every served browser pattern compiles under the current HTML pattern rules', async () => {
  const [joinResponse, oauthResponse] = await Promise.all([
    identityHarness().app.request('/join'),
    oauthFixture().app.request(authorizationUrl()),
  ])
  const pages = await Promise.all([joinResponse.text(), oauthResponse.text()])
  const patterns = pages.flatMap(page => [...page.matchAll(/pattern="([^"]+)"/gu)].map(match => match[1]!))
  assert.ok(patterns.length > 0)
  for (const pattern of patterns) assert.doesNotThrow(() => new RegExp(`^(?:${pattern})$`, 'v'), pattern)
  for (const page of pages) {
    assert.doesNotMatch(page, /name="(?:merchant_key|recovery_code|pairing_code)"[^>]*pattern=/gu)
  }
})

test('hosted sign-in exposes a frozen cause for each collapsed authorization branch', async () => {
  const cases = [
    ['/oauth/authorize?client_id=x&client_id=y', 'signin_query_fields'],
    ['/oauth/authorize', 'signin_client_id'],
    [authorizationUrl({ redirect_uri: 'https://client.example/near-match' }), 'signin_contract'],
  ] as const
  for (const [url, cause] of cases) {
    const response = await oauthFixture().app.request(url)
    assert.equal(response.status, 400, cause)
    assert.equal(response.headers.get('x-1f3ea-cause'), cause)
    assert.match(await response.text(), new RegExp(`Cause:\\s*<code>${cause}<`, 'u'))
  }

  const rateStore = new MemoryOAuthStore()
  let rateCalls = 0
  const rateApp = new Hono()
  mountMarketOAuthRoutes(rateApp, {
    environment: oauthEnvironment,
    store: {
      ...rateStore.api,
      consumeOAuthRateLimit: async () => {
        rateCalls += 1
        if (rateCalls === 2) throw new Error('private rate failure')
        return true
      },
    },
  })
  const rateResponse = await rateApp.request(authorizationUrl())
  assert.equal(rateResponse.status, 503)
  assert.equal(rateResponse.headers.get('x-1f3ea-cause'), 'signin_rate_store')

  const createStore = new MemoryOAuthStore()
  const createApp = new Hono()
  mountMarketOAuthRoutes(createApp, {
    environment: oauthEnvironment,
    store: {
      ...createStore.api,
      createAuthorizationRequest: async () => { throw new Error('private create failure') },
    },
  })
  const createResponse = await createApp.request(authorizationUrl())
  assert.equal(createResponse.status, 503)
  assert.equal(createResponse.headers.get('x-1f3ea-cause'), 'signin_request_create')
})
