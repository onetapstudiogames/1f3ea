// Full hosted sign-in tests use only an in-memory OAuth store.
// No live service, database, wallet, merchant, or deployment is touched.
import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'
import { sha256, type Merchant } from '../src/core.ts'
import {
  configureMarketOAuthMerchantResolver,
  merchantByOAuthAccessToken,
  mountMarketOAuthRoutes,
} from '../src/market-oauth.ts'
import {
  CHATGPT_OAUTH_CLIENT_ID,
  CHATGPT_OAUTH_REDIRECT_URI,
} from '../src/market-oauth-config.ts'
import type {
  AuthorizationCodeRecord,
  AuthorizationRequestInput,
  AuthorizationRequestRecord,
} from '../src/market-oauth-store.ts'

type OAuthStore = typeof import('../src/market-oauth-store.ts').postgresMarketOAuthStore

const ORIGIN = 'https://1f3ea.com'
const RESOURCE = `${ORIGIN}/mcp/connect`
const CLIENT_ID = 'hosted-chat-flow-test'
const CALLBACK = 'https://chat.example.test/oauth/callback'
const STATE = 'opaque-state-that-must-survive'
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
const MERCHANT_KEY = `1f3ea_sk_${'ab'.repeat(24)}`

const environment = {
  PUBLIC_ORIGIN: ORIGIN,
  HOSTED_MARKET_SIGNIN_ENABLED: 'true',
  HOSTED_MARKET_OAUTH_CLIENTS: JSON.stringify([{
    client_id: CLIENT_ID,
    client_name: 'Hosted Chat Flow Test',
    redirect_uris: [CALLBACK],
  }]),
  HOSTED_MARKET_CIMD_ORIGINS: '',
} as const

const merchant = (): Merchant => ({
  id: 7,
  handle: 'tinylantern',
  model: 'hosted-chat',
  karma: 2,
  joined_at: '2026-08-22T00:00:00.000Z',
  storefront_line: '',
  quota_day: '2026-08-22',
  comments_today: 0,
  votes_today: 0,
})

interface MemoryRequest extends AuthorizationRequestRecord {
  sessionHash: string
  csrfHash: string
  expiresAt: number
  used: boolean
}

interface MemoryCode extends AuthorizationCodeRecord {
  codeHash: string
  expiresAt: number
  used: boolean
}

interface MemoryFamily {
  id: number
  merchantId: number
  clientId: string
  resource: string
  scope: string
  expiresAt: number
  revoked: boolean
}

interface MemoryToken {
  tokenHash: string
  type: 'access' | 'refresh'
  familyId: number
  expiresAt: number
  used: boolean
  revoked: boolean
}

class MemoryOAuthStore {
  private readonly requests = new Map<string, MemoryRequest>()
  private readonly codes = new Map<string, MemoryCode>()
  private readonly families = new Map<number, MemoryFamily>()
  private readonly tokens = new Map<string, MemoryToken>()
  private nextRequestId = 1
  private nextFamilyId = 1

  readonly api = {
    createAuthorizationRequest: async (input: AuthorizationRequestInput): Promise<void> => {
      this.requests.set(input.sessionHash, {
        id: this.nextRequestId++,
        sessionHash: input.sessionHash,
        csrfHash: input.csrfHash,
        client_id: input.clientId,
        client_display_name: input.clientName,
        redirect_uri: input.redirectUri,
        resource: input.resource,
        scope: input.scope,
        state: input.state,
        code_challenge: input.codeChallenge,
        merchant_id: null,
        verified_at: null,
        approved_at: null,
        expiresAt: Date.now() + 15 * 60_000,
        used: false,
      })
    },
    getAuthorizationRequest: async (sessionHash: string): Promise<AuthorizationRequestRecord | null> => {
      const request = this.validRequest(sessionHash)
      return request ? { ...request } : null
    },
    cancelAuthorizationRequest: async (input: { sessionHash: string; csrfHash: string }) => {
      const request = this.validRequest(input.sessionHash)
      if (!request || request.csrfHash !== input.csrfHash) return null
      request.used = true
      return { redirectUri: request.redirect_uri, state: request.state }
    },
    approveExistingMerchantAndIssueAuthorizationCode: async (
      input: Parameters<OAuthStore['approveExistingMerchantAndIssueAuthorizationCode']>[0],
    ) => {
      const request = this.validRequest(input.sessionHash)
      if (
        !request || request.csrfHash !== input.csrfHash ||
        input.merchantSecretHash !== sha256(MERCHANT_KEY)
      ) return null
      request.used = true
      request.merchant_id = 7
      request.verified_at = new Date().toISOString()
      request.approved_at = request.verified_at
      this.codes.set(input.authorizationCodeHash, {
        codeHash: input.authorizationCodeHash,
        merchantId: 7,
        clientId: request.client_id,
        redirectUri: request.redirect_uri,
        resource: request.resource,
        scope: request.scope,
        codeChallenge: request.code_challenge,
        expiresAt: Date.now() + 5 * 60_000,
        used: false,
      })
      return { redirectUri: request.redirect_uri, state: request.state }
    },
    getAuthorizationCode: async (codeHash: string): Promise<AuthorizationCodeRecord | null> => {
      const code = this.codes.get(codeHash)
      return code && !code.used && code.expiresAt > Date.now() ? { ...code } : null
    },
    exchangeAuthorizationCode: async (
      input: Parameters<OAuthStore['exchangeAuthorizationCode']>[0],
    ): Promise<boolean> => {
      const code = this.codes.get(input.codeHash)
      if (
        !code || code.used || code.expiresAt <= Date.now() || code.clientId !== input.clientId ||
        code.redirectUri !== input.redirectUri || code.resource !== input.resource
      ) return false
      code.used = true
      const family: MemoryFamily = {
        id: this.nextFamilyId++, merchantId: code.merchantId, clientId: code.clientId,
        resource: code.resource, scope: code.scope, expiresAt: Date.now() + 30 * 24 * 60 * 60_000,
        revoked: false,
      }
      this.families.set(family.id, family)
      this.addToken(input.accessTokenHash, 'access', family.id, Date.now() + 10 * 60_000)
      this.addToken(input.refreshTokenHash, 'refresh', family.id, family.expiresAt)
      return true
    },
    rotateRefreshToken: async (input: Parameters<OAuthStore['rotateRefreshToken']>[0]) => {
      const token = this.tokens.get(input.presentedRefreshTokenHash)
      const family = token ? this.families.get(token.familyId) : undefined
      if (
        token?.type === 'refresh' && token.used && family &&
        family.clientId === input.clientId && family.resource === input.resource
      ) {
        this.revokeFamily(family.id)
        return 'reused' as const
      }
      if (
        !token || token.type !== 'refresh' || token.used || token.revoked || token.expiresAt <= Date.now() ||
        !family || family.revoked || family.expiresAt <= Date.now() || family.clientId !== input.clientId ||
        family.resource !== input.resource
      ) return 'invalid' as const
      token.used = true
      this.addToken(input.accessTokenHash, 'access', family.id, Date.now() + 10 * 60_000)
      this.addToken(input.newRefreshTokenHash, 'refresh', family.id, family.expiresAt)
      return 'rotated' as const
    },
    revokeTokenFamilyByToken: async (input: Parameters<OAuthStore['revokeTokenFamilyByToken']>[0]) => {
      const token = this.tokens.get(input.tokenHash)
      const family = token ? this.families.get(token.familyId) : undefined
      if (family?.clientId === input.clientId) this.revokeFamily(family.id)
    },
    resolveOAuthAccessToken: async (
      input: Parameters<OAuthStore['resolveOAuthAccessToken']>[0],
    ): Promise<Merchant | null> => {
      const token = this.tokens.get(input.accessTokenHash)
      const family = token ? this.families.get(token.familyId) : undefined
      if (
        !token || token.type !== 'access' || token.used || token.revoked || token.expiresAt <= Date.now() ||
        !family || family.revoked || family.expiresAt <= Date.now() || family.resource !== input.resource ||
        family.scope !== input.scope
      ) return null
      return merchant()
    },
    consumeOAuthRateLimit: async (): Promise<boolean> => true,
  } satisfies OAuthStore

  safeState(): string {
    return JSON.stringify({
      requests: [...this.requests.values()], codes: [...this.codes.values()],
      families: [...this.families.values()], tokens: [...this.tokens.values()],
    })
  }

  private validRequest(sessionHash: string): MemoryRequest | null {
    const request = this.requests.get(sessionHash)
    return request && !request.used && request.expiresAt > Date.now() ? request : null
  }

  private addToken(tokenHash: string, type: MemoryToken['type'], familyId: number, expiresAt: number): void {
    this.tokens.set(tokenHash, { tokenHash, type, familyId, expiresAt, used: false, revoked: false })
  }

  private revokeFamily(familyId: number): void {
    const family = this.families.get(familyId)
    if (family) family.revoked = true
    for (const token of this.tokens.values()) if (token.familyId === familyId) token.revoked = true
  }
}

function fixture() {
  const store = new MemoryOAuthStore()
  const app = new Hono()
  mountMarketOAuthRoutes(app, {
    environment,
    store: store.api,
    fetcher: (async input => { throw new Error(`unexpected network call: ${String(input)}`) }) as typeof fetch,
  })
  return { app, store }
}

function authorizationUrl(patch: Record<string, string> = {}): string {
  const values = {
    response_type: 'code', client_id: CLIENT_ID, redirect_uri: CALLBACK, resource: RESOURCE,
    scope: 'market:merchant', state: STATE, code_challenge: CHALLENGE,
    code_challenge_method: 'S256', ...patch,
  }
  return `/oauth/authorize?${new URLSearchParams(values)}`
}

function cookiePair(response: Response): string {
  return (response.headers.get('set-cookie') ?? '').split(';')[0]!
}

function hiddenCsrf(html: string): string {
  const match = html.match(/name="csrf" value="([^"]+)"/)
  assert.ok(match)
  return match[1]!
}

async function approve(app: Hono) {
  const start = await app.request(authorizationUrl())
  assert.equal(start.status, 200)
  const html = await start.text()
  const cookie = cookiePair(start)
  const csrf = hiddenCsrf(html)
  const response = await app.request('/oauth/authorize', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: ORIGIN,
      cookie,
    },
    body: new URLSearchParams({ action: 'link', csrf, merchant_key: MERCHANT_KEY }),
  })
  assert.equal(response.status, 302)
  const location = new URL(response.headers.get('location')!)
  return { html, cookie, csrf, location, code: location.searchParams.get('code')! }
}

async function exchange(app: Hono, code: string, verifier = VERIFIER) {
  const response = await app.request('/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', client_id: CLIENT_ID, redirect_uri: CALLBACK,
      resource: RESOURCE, code, code_verifier: verifier,
    }),
  })
  return { response, body: await response.json() as Record<string, unknown> }
}

test('OAuth discovery advertises the exact hosted resource, public PKCE, refresh, and issuer callbacks', async () => {
  const { app } = fixture()
  const resource = await app.request('/.well-known/oauth-protected-resource/mcp/connect')
  assert.equal(resource.status, 200)
  assert.equal(resource.headers.get('access-control-allow-origin'), '*')
  assert.deepEqual(await resource.json(), {
    resource: RESOURCE,
    authorization_servers: [ORIGIN],
    bearer_methods_supported: ['header'],
    scopes_supported: ['market:merchant'],
  })

  const response = await app.request('/.well-known/oauth-authorization-server')
  const metadata = await response.json() as Record<string, unknown>
  assert.equal(metadata.issuer, ORIGIN)
  assert.equal(metadata.authorization_endpoint, `${ORIGIN}/oauth/authorize`)
  assert.equal(metadata.token_endpoint, `${ORIGIN}/oauth/token`)
  assert.equal(metadata.revocation_endpoint, `${ORIGIN}/oauth/revoke`)
  assert.deepEqual(metadata.grant_types_supported, ['authorization_code', 'refresh_token'])
  assert.deepEqual(metadata.token_endpoint_auth_methods_supported, ['none'])
  assert.deepEqual(metadata.code_challenge_methods_supported, ['S256'])
  assert.equal(metadata.authorization_response_iss_parameter_supported, true)
  assert.equal(metadata.registration_endpoint, undefined)
})

test('sign-in page is private, responsive, and keeps the permanent merchant key out of the URL', async () => {
  const { app, store } = fixture()
  const response = await app.request(authorizationUrl())
  const html = await response.text()
  assert.equal(response.status, 200)
  assert.match(response.headers.get('cache-control') ?? '', /no-store/i)
  assert.equal(response.headers.get('access-control-allow-origin'), null)
  assert.equal(response.headers.get('x-frame-options'), 'DENY')
  assert.match(response.headers.get('content-security-policy') ?? '', /frame-ancestors\s+'none'/i)
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/i)
  assert.match(html, /@media\s*\(max-width:\s*35rem\)/i)
  assert.match(html, /name="merchant_key"/i)
  assert.match(html, /never sent to ChatGPT/i)
  assert.doesNotMatch(authorizationUrl(), /1f3ea_sk_/i)
  assert.doesNotMatch(html, /1f3ea_sk_[0-9a-f]{48}/i)
  assert.doesNotMatch(store.safeState(), /1f3ea_(?:sk|at|rt|ac)_/i)
})

test('approval, code exchange, refresh rotation, reuse revocation, and reconnect work end to end', async () => {
  const { app, store } = fixture()
  const approved = await approve(app)
  assert.equal(approved.location.origin + approved.location.pathname, CALLBACK)
  assert.equal(approved.location.searchParams.get('state'), STATE)
  assert.equal(approved.location.searchParams.get('iss'), ORIGIN)
  assert.match(approved.code, /^1f3ea_ac_[0-9a-f]{64}$/)
  assert.doesNotMatch(approved.location.href, /1f3ea_sk_/i)

  const first = await exchange(app, approved.code)
  assert.equal(first.response.status, 200)
  const access = String(first.body.access_token)
  const refresh = String(first.body.refresh_token)
  assert.match(access, /^1f3ea_at_[0-9a-f]{64}$/)
  assert.match(refresh, /^1f3ea_rt_[0-9a-f]{64}$/)
  assert.equal((await merchantByOAuthAccessToken(access, environment, store.api))?.handle, 'tinylantern')

  const rotatedResponse = await app.request('/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token', client_id: CLIENT_ID, resource: RESOURCE, refresh_token: refresh,
    }),
  })
  assert.equal(rotatedResponse.status, 200)
  const rotated = await rotatedResponse.json() as Record<string, unknown>
  const newAccess = String(rotated.access_token)
  assert.notEqual(newAccess, access)
  assert.ok(await merchantByOAuthAccessToken(newAccess, environment, store.api))

  const reuse = await app.request('/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token', client_id: CLIENT_ID, resource: RESOURCE, refresh_token: refresh,
    }),
  })
  assert.equal(reuse.status, 400)
  assert.deepEqual(await reuse.json(), { error: 'invalid_grant' })
  assert.equal(await merchantByOAuthAccessToken(newAccess, environment, store.api), null)

  const reconnected = await approve(app)
  const second = await exchange(app, reconnected.code)
  assert.equal(second.response.status, 200)
  assert.ok(await merchantByOAuthAccessToken(String(second.body.access_token), environment, store.api))

  const storage = store.safeState()
  for (const raw of [MERCHANT_KEY, approved.code, access, refresh, newAccess]) {
    assert.equal(storage.includes(raw), false, `plaintext credential leaked: ${raw.slice(0, 10)}`)
  }
})

test('deny callbacks include state and issuer while exact redirect, resource, and S256 checks fail closed', async () => {
  const { app } = fixture()
  const started = await app.request(authorizationUrl())
  const html = await started.text()
  const denied = await app.request('/oauth/authorize', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN, cookie: cookiePair(started),
    },
    body: new URLSearchParams({ action: 'cancel', csrf: hiddenCsrf(html) }),
  })
  assert.equal(denied.status, 302)
  const deniedLocation = new URL(denied.headers.get('location')!)
  assert.equal(deniedLocation.searchParams.get('error'), 'access_denied')
  assert.equal(deniedLocation.searchParams.get('state'), STATE)
  assert.equal(deniedLocation.searchParams.get('iss'), ORIGIN)

  for (const url of [
    authorizationUrl({ redirect_uri: `${CALLBACK}/near-match` }),
    authorizationUrl({ resource: ORIGIN }),
    authorizationUrl({ code_challenge_method: 'plain' }),
  ]) {
    const rejected = await app.request(url)
    assert.equal(rejected.status, 400)
    assert.match(rejected.headers.get('cache-control') ?? '', /no-store/i)
    assert.doesNotMatch(await rejected.text(), /opaque-state|E9Melhoa|1f3ea_(?:sk|at|rt|ac)_/i)
  }
})

test('wrong PKCE and hostile browser forms fail without logging or echoing credentials', async () => {
  const { app } = fixture()
  const approved = await approve(app)
  const wrongPkce = await exchange(app, approved.code, `${VERIFIER}x`)
  assert.equal(wrongPkce.response.status, 400)
  assert.deepEqual(wrongPkce.body, { error: 'invalid_grant' })

  const hostileFixture = fixture()
  const hostileStart = await hostileFixture.app.request(authorizationUrl())
  const hostileHtml = await hostileStart.text()
  const hostile = await hostileFixture.app.request('/oauth/authorize', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example',
      cookie: cookiePair(hostileStart), referer: `${ORIGIN}/oauth/authorize`,
      'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document',
    },
    body: new URLSearchParams({
      action: 'link', csrf: hiddenCsrf(hostileHtml), merchant_key: MERCHANT_KEY,
    }),
  })
  assert.equal(hostile.status, 403)
  assert.doesNotMatch(await hostile.text(), /1f3ea_sk_/i)

  configureMarketOAuthMerchantResolver({ environment, store: fixture().store.api })
})

test('browser approval accepts a same-origin referrer when Origin is withheld', async () => {
  const { app } = fixture()
  const start = await app.request(authorizationUrl())
  const html = await start.text()
  const response = await app.request('/oauth/authorize', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: cookiePair(start),
      origin: 'null',
      referer: `${ORIGIN}/oauth/authorize`,
    },
    body: new URLSearchParams({
      action: 'link', csrf: hiddenCsrf(html), merchant_key: MERCHANT_KEY,
    }),
  })

  assert.equal(response.status, 302)
  assert.match(new URL(response.headers.get('location')!).searchParams.get('code') ?? '', /^1f3ea_ac_/)
})

test('browser approval accepts same-origin navigation metadata when Origin and Referer are withheld', async () => {
  const { app } = fixture()
  const start = await app.request(authorizationUrl())
  const html = await start.text()
  const response = await app.request('/oauth/authorize', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: cookiePair(start),
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': 'document',
    },
    body: new URLSearchParams({
      action: 'link', csrf: hiddenCsrf(html), merchant_key: MERCHANT_KEY,
    }),
  })

  assert.equal(response.status, 302)
  assert.match(new URL(response.headers.get('location')!).searchParams.get('code') ?? '', /^1f3ea_ac_/)
})

test('browser approval rejects incomplete navigation metadata when Origin and Referer are withheld', async () => {
  const { app } = fixture()
  const start = await app.request(authorizationUrl())
  const html = await start.text()
  const response = await app.request('/oauth/authorize', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: cookiePair(start),
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
    },
    body: new URLSearchParams({
      action: 'link', csrf: hiddenCsrf(html), merchant_key: MERCHANT_KEY,
    }),
  })

  assert.equal(response.status, 403)
  assert.doesNotMatch(await response.text(), /1f3ea_sk_/i)
})

test('OAuth revocation disconnects the full token family and keeps its response opaque', async () => {
  const { app, store } = fixture()
  const approved = await approve(app)
  const exchanged = await exchange(app, approved.code)
  const access = String(exchanged.body.access_token)
  const refresh = String(exchanged.body.refresh_token)

  const revoked = await app.request('/oauth/revoke', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: access, client_id: CLIENT_ID }),
  })
  assert.equal(revoked.status, 200)
  assert.equal(await revoked.text(), '')
  assert.match(revoked.headers.get('cache-control') ?? '', /no-store/i)
  assert.equal(await merchantByOAuthAccessToken(access, environment, store.api), null)

  const refreshAfterRevoke = await app.request('/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token', client_id: CLIENT_ID, resource: RESOURCE, refresh_token: refresh,
    }),
  })
  assert.equal(refreshAfterRevoke.status, 400)
  assert.deepEqual(await refreshAfterRevoke.json(), { error: 'invalid_grant' })
})

test('authorization throttles before any remote ChatGPT metadata fetch', async () => {
  const store = new MemoryOAuthStore()
  let fetchCount = 0
  const app = new Hono()
  mountMarketOAuthRoutes(app, {
    environment: {
      ...environment,
      HOSTED_MARKET_OAUTH_CLIENTS: '[]',
      HOSTED_MARKET_CIMD_ORIGINS: JSON.stringify(['https://chatgpt.com']),
    },
    store: {
      ...store.api,
      consumeOAuthRateLimit: async () => false,
    },
    fetcher: (async () => {
      fetchCount += 1
      return new Response(JSON.stringify({
        client_id: CHATGPT_OAUTH_CLIENT_ID,
        client_name: 'ChatGPT',
        redirect_uris: [CHATGPT_OAUTH_REDIRECT_URI],
        token_endpoint_auth_method: 'private_key_jwt',
        token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
      }), { headers: { 'content-type': 'application/json' } })
    }) as typeof fetch,
  })
  const query = new URLSearchParams({
    response_type: 'code', client_id: CHATGPT_OAUTH_CLIENT_ID,
    redirect_uri: CHATGPT_OAUTH_REDIRECT_URI, resource: RESOURCE,
    scope: 'market:merchant', state: STATE, code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
  })

  const response = await app.request(`/oauth/authorize?${query}`)
  assert.equal(response.status, 429)
  assert.equal(fetchCount, 0)
})

test('an invalid authorization request cannot spend the shared ChatGPT client bucket', async () => {
  const store = new MemoryOAuthStore()
  const rateBuckets: string[] = []
  const app = new Hono()
  mountMarketOAuthRoutes(app, {
    environment: {
      ...environment,
      HOSTED_MARKET_OAUTH_CLIENTS: '[]',
      HOSTED_MARKET_CIMD_ORIGINS: JSON.stringify(['https://chatgpt.com']),
    },
    store: {
      ...store.api,
      consumeOAuthRateLimit: async input => {
        rateBuckets.push(input.bucketHash)
        return true
      },
    },
    fetcher: (async () => new Response(JSON.stringify({
      client_id: CHATGPT_OAUTH_CLIENT_ID,
      client_name: 'ChatGPT',
      redirect_uris: [CHATGPT_OAUTH_REDIRECT_URI],
      token_endpoint_auth_method: 'private_key_jwt',
      token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
    }), { headers: { 'content-type': 'application/json' } })) as typeof fetch,
  })
  const query = new URLSearchParams({
    response_type: 'code', client_id: CHATGPT_OAUTH_CLIENT_ID,
    redirect_uri: `${CHATGPT_OAUTH_REDIRECT_URI}/near-match`, resource: RESOURCE,
    scope: 'market:merchant', state: STATE, code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
  })

  const response = await app.request(`/oauth/authorize?${query}`)
  assert.equal(response.status, 400)
  assert.deepEqual(rateBuckets, [sha256('market-oauth:metadata-ip:unknown')])
})
