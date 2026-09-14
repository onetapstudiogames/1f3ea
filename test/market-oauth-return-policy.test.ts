import assert from 'node:assert/strict'
import test from 'node:test'
import { CLAUDE_CODE_OAUTH_CLIENT_ID } from '../src/market-oauth-config.ts'
import { privateBrowserHeaders } from '../src/private-browser.ts'
import {
  CLIENT_ID, Hono, MERCHANT_KEY, ORIGIN, STATE,
  authorizationUrl, cookiePair, environment, fixture, hiddenCsrf, sha256,
} from './support/market-oauth-flow-harness.ts'

const CHATGPT_CALLBACK = 'https://chatgpt.com/connector/oauth/market-test'
const OPENAI_FORM_ORIGINS = ["'self'", 'https://chatgpt.com', 'https://platform.openai.com']
const PAIRING_CODE = `1f3ea_pc_${'11'.repeat(24)}`

function configuredEnvironment(callback = CHATGPT_CALLBACK) {
  return {
    ...environment,
    MARKET_CODING_IDENTITY_ENABLED: 'true',
    HOSTED_MARKET_OAUTH_CLIENTS: JSON.stringify([{
      client_id: CLIENT_ID,
      client_name: 'Hosted Return Test',
      redirect_uris: [callback],
    }]),
  }
}

function assertFormOrigins(response: Response, origins: readonly string[]): void {
  const policy = response.headers.get('content-security-policy') ?? ''
  const directives = policy.split(';').map(value => value.trim().split(/\s+/u))
  assert.deepEqual(directives.filter(([name]) => name === 'form-action'), [['form-action', ...origins]])
  for (const directive of ["default-src 'none'", "base-uri 'none'", "frame-ancestors 'none'"]) {
    assert.ok(policy.includes(directive), `missing ${directive}`)
  }
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('x-frame-options'), 'DENY')
  assert.equal(response.headers.get('access-control-allow-origin'), null)
}

async function start(app: Hono, callback = CHATGPT_CALLBACK) {
  const url = authorizationUrl({ redirect_uri: callback })
  const response = await app.request(url)
  assert.equal(response.status, 200)
  const html = await response.text()
  return { response, html, url, cookie: cookiePair(response), csrf: hiddenCsrf(html) }
}

function submit(app: Hono, session: { cookie: string; csrf: string }, fields: Record<string, string>) {
  return app.request('/oauth/authorize', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN, cookie: session.cookie },
    body: new URLSearchParams({ csrf: session.csrf, ...fields }),
  })
}

test('verified ChatGPT consent allows its callback and the OpenAI Platform return while forms stay first-party', async () => {
  const { app } = fixture({ environment: configuredEnvironment() })
  const session = await start(app)
  assertFormOrigins(session.response, OPENAI_FORM_ORIGINS)
  const actions = [...session.html.matchAll(/<form method="post" action="([^"]+)"/gu)]
  assert.ok(actions.length >= 4)
  assert.ok(actions.every(([, action]) => action === '/oauth/authorize'))
  assert.match(session.response.headers.get('set-cookie') ?? '', /Secure/u)
  assert.match(session.response.headers.get('set-cookie') ?? '', /HttpOnly/u)
  assert.doesNotMatch(session.html, /1f3ea_sk_[0-9a-f]{48}/u)
})

for (const callback of [
  'https://chat.example.test/oauth/callback?next=https://chatgpt.com',
  'https://chatgpt.com.attacker.example/oauth/callback',
  'https://sub.chatgpt.com/oauth/callback',
  'https://chatgpt.com:444/oauth/callback',
]) {
  test(`approved callback ${callback} receives only its own exact origin, without the Platform exception`, async () => {
    const { app } = fixture({ environment: configuredEnvironment(callback) })
    const session = await start(app, callback)
    assertFormOrigins(session.response, ["'self'", new URL(callback).origin])
  })
}

test('verified Claude Code metadata permits its requested ephemeral loopback port without the Platform exception', async () => {
  const callback = 'http://localhost:49231/callback'
  const { app } = fixture({ fetcher: (async input => {
    assert.equal(String(input), CLAUDE_CODE_OAUTH_CLIENT_ID)
    return new Response(JSON.stringify({
      client_id: CLAUDE_CODE_OAUTH_CLIENT_ID,
      client_name: 'Claude Code',
      redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
      token_endpoint_auth_method: 'none',
    }), { headers: { 'content-type': 'application/json' } })
  }) as typeof fetch })
  const response = await app.request(authorizationUrl({
    client_id: CLAUDE_CODE_OAUTH_CLIENT_ID, redirect_uri: callback,
  }))
  assert.equal(response.status, 200)
  assertFormOrigins(response, ["'self'", 'http://localhost:49231'])
  const session = { cookie: cookiePair(response), csrf: hiddenCsrf(await response.text()) }
  const returned = await submit(app, session, { action: 'link', merchant_key: MERCHANT_KEY })
  assert.equal(returned.status, 302)
  const location = new URL(returned.headers.get('location')!)
  assert.equal(location.origin + location.pathname, callback)
})

test('resumed consent keeps the stored callback allowance but a conflicting request receives no external allowance', async () => {
  const { app } = fixture({ environment: configuredEnvironment() })
  const session = await start(app)
  const resumed = await app.request(session.url, { headers: { cookie: session.cookie } })
  assert.equal(resumed.status, 200)
  assertFormOrigins(resumed, OPENAI_FORM_ORIGINS)
  assert.equal(hiddenCsrf(await resumed.text()), session.csrf)
  const conflict = await app.request(authorizationUrl({ redirect_uri: CHATGPT_CALLBACK, state: 'different-state' }), {
    headers: { cookie: session.cookie },
  })
  assert.equal(conflict.status, 409)
  assertFormOrigins(conflict, ["'self'"])
})

test('new merchant save and resume forms retain the callback allowance until the unchanged one-use 302 return', async () => {
  const { app } = fixture({ environment: configuredEnvironment() })
  const session = await start(app)
  const fields = { action: 'register', handle: 'return-policy-shop', model: 'test' }
  const prepared = await submit(app, session, fields)
  assert.equal(prepared.status, 200)
  assertFormOrigins(prepared, OPENAI_FORM_ORIGINS)
  const savedKey = (await prepared.text()).match(/1f3ea_sk_[0-9a-f]{48}/u)?.[0]
  assert.ok(savedKey)
  const retry = await submit(app, session, fields)
  assert.equal(retry.status, 200)
  assertFormOrigins(retry, OPENAI_FORM_ORIGINS)
  assert.doesNotMatch(await retry.text(), /1f3ea_sk_[0-9a-f]{48}/u)
  const resumed = await app.request(session.url, { headers: { cookie: session.cookie } })
  assert.equal(resumed.status, 200)
  assertFormOrigins(resumed, OPENAI_FORM_ORIGINS)
  assert.doesNotMatch(await resumed.text(), /1f3ea_sk_[0-9a-f]{48}/u)
  const approved = await submit(app, session, { action: 'confirm', merchant_key: savedKey })
  assert.equal(approved.status, 302)
  const location = new URL(approved.headers.get('location')!)
  assert.equal(location.origin + location.pathname, CHATGPT_CALLBACK)
  assert.equal(location.searchParams.get('state'), STATE)
  assert.equal(location.searchParams.get('iss'), ORIGIN)
  assert.match(location.searchParams.get('code') ?? '', /^1f3ea_ac_/u)
  assert.match(approved.headers.get('set-cookie') ?? '', /Max-Age=0/u)
  const repeated = await submit(app, session, { action: 'confirm', merchant_key: savedKey })
  assert.equal(repeated.status, 403)
  assertFormOrigins(repeated, ["'self'"])
})

test('pairing confirmation retains the verified callback allowance and returns an ordinary authorization redirect', async () => {
  const { app } = fixture({
    environment: configuredEnvironment(),
    reservePairingCode: async () => ({ merchantId: 7, handle: 'tinylantern', expiresAt: '2099-01-01T00:00:00Z' }),
    takeReservedPairingCode: async () => ({ codeHash: sha256(PAIRING_CODE) }),
    resolvePairingCode: async () => ({ merchantId: 7, merchantSecretHash: sha256(MERCHANT_KEY) }),
  })
  const session = await start(app)
  const reserved = await submit(app, session, { action: 'pair', pairing_code: PAIRING_CODE })
  assert.equal(reserved.status, 200)
  assertFormOrigins(reserved, OPENAI_FORM_ORIGINS)
  assert.equal(hiddenCsrf(await reserved.text()), session.csrf)
  const approved = await submit(app, session, { action: 'confirm_pair' })
  assert.equal(approved.status, 302)
  assert.equal(new URL(approved.headers.get('location')!).origin, 'https://chatgpt.com')
})

const pairingRetryForms: Array<Record<string, string>> = [
  { action: 'pair', pairing_code: 'malformed' },
  { action: 'pair', pairing_code: PAIRING_CODE },
  { action: 'confirm_pair' },
]
for (const fields of pairingRetryForms) {
  test(`pairing retry page after ${fields.action}/${fields.pairing_code === 'malformed' ? 'malformed' : 'unavailable'} preserves its stored callback`, async () => {
    const { app } = fixture({
      environment: configuredEnvironment(),
      reservePairingCode: async () => null,
      takeReservedPairingCode: async () => null,
    })
    const session = await start(app)
    const rejected = await submit(app, session, fields)
    assert.equal(rejected.status, 403)
    assertFormOrigins(rejected, OPENAI_FORM_ORIGINS)
    const html = await rejected.text()
    assert.match(html, /name="action" value="pair"/u)
    assert.equal(hiddenCsrf(html), session.csrf)
  })
}

for (const detail of ['pairing_code_expired_or_revoked', 'pairing_merchant_key_changed']) {
  test(`pairing retry after ${detail} retains its verified callback and permits a fresh code`, async () => {
    const { app } = fixture({
      environment: configuredEnvironment(),
      reservePairingCode: async () => ({ merchantId: 7, handle: 'tinylantern', expiresAt: '2099-01-01T00:00:00Z' }),
      takeReservedPairingCode: async () => ({ codeHash: sha256(PAIRING_CODE) }),
      resolvePairingCode: async () => detail === 'pairing_code_expired_or_revoked'
        ? null
        : { merchantId: 7, merchantSecretHash: sha256(`1f3ea_sk_${'ff'.repeat(24)}`) },
    })
    const session = await start(app)
    const reserved = await submit(app, session, { action: 'pair', pairing_code: PAIRING_CODE })
    assert.equal(reserved.status, 200)
    const rejected = await submit(app, session, { action: 'confirm_pair' })
    assert.equal(rejected.status, 403)
    assert.equal(rejected.headers.get('x-1f3ea-cause'), detail)
    assert.equal(rejected.headers.get('location'), null)
    assertFormOrigins(rejected, OPENAI_FORM_ORIGINS)
    const html = await rejected.text()
    assert.match(html, /name="action" value="pair"/u)
    assert.equal(hiddenCsrf(html), session.csrf)
  })
}

for (const action of ['link', 'cancel']) {
  test(`${action} keeps the exact callback, state and cookie-clearing 302 after permitted consent`, async () => {
    const { app } = fixture({ environment: configuredEnvironment() })
    const session = await start(app)
    const returned = await submit(app, session, {
      action, ...(action === 'link' ? { merchant_key: MERCHANT_KEY } : {}),
    })
    assert.equal(returned.status, 302)
    const location = new URL(returned.headers.get('location')!)
    assert.equal(location.origin + location.pathname, CHATGPT_CALLBACK)
    assert.equal(location.searchParams.get('state'), STATE)
    assert.equal(location.searchParams.get('iss'), ORIGIN)
    assert.equal(location.searchParams.get('error'), action === 'cancel' ? 'access_denied' : null)
    assert.match(returned.headers.get('set-cookie') ?? '', /Max-Age=0/u)
    assertFormOrigins(session.response, OPENAI_FORM_ORIGINS)
  })
}

test('unvalidated return addresses, extra form fields and terminal errors cannot add external form origins', async () => {
  const { app } = fixture({ environment: configuredEnvironment() })
  const invalid = await app.request(authorizationUrl({ redirect_uri: `${CHATGPT_CALLBACK}/unregistered` }))
  assert.equal(invalid.status, 400)
  assertFormOrigins(invalid, ["'self'"])
  const session = await start(app)
  const injected = await submit(app, session, { action: 'cancel', redirect_uri: 'https://attacker.example/callback' })
  assert.equal(injected.status, 403)
  assertFormOrigins(injected, ["'self'"])
  const wrongCsrf = await submit(app, session, { action: 'cancel', csrf: 'wrong' })
  assert.equal(wrongCsrf.status, 403)
  assertFormOrigins(wrongCsrf, ["'self'"])
  const missingCookie = await submit(app, { ...session, cookie: '' }, { action: 'cancel' })
  assert.equal(missingCookie.status, 403)
  assertFormOrigins(missingCookie, ["'self'"])
  const wrongKey = await submit(app, session, { action: 'link', merchant_key: `1f3ea_sk_${'ff'.repeat(24)}` })
  assert.equal(wrongKey.status, 403)
  assertFormOrigins(wrongKey, ["'self'"])
})

test('the shared private-page header helper stays first-party without a verified OAuth return', async () => {
  const app = new Hono()
  app.get('/join', c => {
    privateBrowserHeaders(c, true)
    return c.html('<form method="post" action="/join"></form>')
  })
  assertFormOrigins(await app.request('/join'), ["'self'"])
})
