import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CHATGPT_CIMD_ORIGIN,
  MARKET_OAUTH_RESOURCE,
  MARKET_OAUTH_SCOPE,
  MarketOAuthClientError,
  parseMarketCimdOrigins,
  resolveMarketOAuthClient,
  validateMarketAuthorizationRequest,
} from '../src/market-oauth-config.ts'
import {
  CHALLENGE, MERCHANT_KEY, ORIGIN, RESOURCE, STATE, VERIFIER,
  cookiePair, environment, fixture, hiddenCsrf, merchantByOAuthAccessToken,
} from './support/market-oauth-flow-harness.ts'

const pluginId = 'plugin-abc_123'
const clientId = `${CHATGPT_CIMD_ORIGIN}/oauth/${pluginId}/client.json`
const redirectUri = `${CHATGPT_CIMD_ORIGIN}/connector/oauth/${pluginId}`

function document(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    client_id: clientId,
    client_name: 'ChatGPT plugin',
    redirect_uris: [redirectUri],
    token_endpoint_auth_method: 'private_key_jwt',
    token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
    ...overrides,
  })
}

function fetchDocument(body = document()): typeof fetch {
  return (async () => new Response(body, {
    headers: { 'content-type': 'application/json' },
  })) as typeof fetch
}

test('a canonical ChatGPT plugin document selects public PKCE and binds authorization to its callback', async () => {
  const fetched: string[] = []
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    fetched.push(String(input))
    assert.equal(init?.redirect, 'manual')
    return new Response(document(), { headers: { 'content-type': 'application/json' } })
  }) as typeof fetch

  const client = await resolveMarketOAuthClient(clientId, [], parseMarketCimdOrigins(undefined), fetcher)
  assert.deepEqual(fetched, [clientId])
  assert.deepEqual(client, {
    clientId,
    clientName: 'ChatGPT plugin',
    redirectUris: [redirectUri],
    tokenEndpointAuthMethod: 'none',
  })
  const request = {
    response_type: 'code', client_id: clientId, redirect_uri: redirectUri,
    resource: MARKET_OAUTH_RESOURCE, scope: MARKET_OAUTH_SCOPE,
    state: 'opaque-state', code_challenge_method: 'S256', code_challenge: 'a'.repeat(43),
  }
  assert.equal(validateMarketAuthorizationRequest(request, [client]).redirectUri, redirectUri)
  assert.throws(() => validateMarketAuthorizationRequest({
    ...request, redirect_uri: `${CHATGPT_CIMD_ORIGIN}/connector/oauth/other-plugin`,
  }, [client]), /not registered/i)
})

test('only canonical safe ChatGPT plugin client IDs are fetched', async () => {
  let fetchCount = 0
  const fetcher = (async () => {
    fetchCount += 1
    return new Response(document(), { headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  const unsafe = [
    `${CHATGPT_CIMD_ORIGIN}/oauth//client.json`,
    `${CHATGPT_CIMD_ORIGIN}/oauth/a/b/client.json`,
    `${CHATGPT_CIMD_ORIGIN}/oauth/%61/client.json`,
    `${CHATGPT_CIMD_ORIGIN}/oauth/a%2Fb/client.json`,
    `${CHATGPT_CIMD_ORIGIN}/oauth/./client.json`,
    `${CHATGPT_CIMD_ORIGIN}/oauth/../client.json`,
    `${CHATGPT_CIMD_ORIGIN}/oauth/a.b/client.json`,
    `${CHATGPT_CIMD_ORIGIN}/oauth/a@b/client.json`,
    `${CHATGPT_CIMD_ORIGIN}/oauth/${'a'.repeat(129)}/client.json`,
    `${CHATGPT_CIMD_ORIGIN}:443/oauth/${pluginId}/client.json`,
    `https://sub.chatgpt.com/oauth/${pluginId}/client.json`,
    `${CHATGPT_CIMD_ORIGIN}/oauth/${pluginId}/client.json?x=1`,
    `${CHATGPT_CIMD_ORIGIN}/oauth/${pluginId}/client.json#fragment`,
  ]
  for (const candidate of unsafe) {
    await assert.rejects(resolveMarketOAuthClient(candidate, [], [CHATGPT_CIMD_ORIGIN], fetcher),
      (error: unknown) => error instanceof MarketOAuthClientError && error.status === 400)
  }
  assert.equal(fetchCount, 0)
})

test('ChatGPT plugin metadata must attest its exact identity and sole matching callback', async () => {
  const invalid = [
    document({ client_id: `${CHATGPT_CIMD_ORIGIN}/oauth/other-plugin/client.json` }),
    document({ redirect_uris: [`${CHATGPT_CIMD_ORIGIN}/connector/oauth/other-plugin`] }),
    document({ redirect_uris: [redirectUri, `${CHATGPT_CIMD_ORIGIN}/connector/oauth/other-plugin`] }),
    document({ redirect_uris: [redirectUri, redirectUri] }),
    document({ redirect_uris: [`${redirectUri}?next=https://example.test`] }),
    document({ redirect_uris: [`${redirectUri}/`] }),
    document({ token_endpoint_auth_methods_supported: ['private_key_jwt'] }),
    document({ token_endpoint_auth_methods_supported: ['none'] }),
  ]
  for (const body of invalid) {
    await assert.rejects(resolveMarketOAuthClient(clientId, [], [CHATGPT_CIMD_ORIGIN], fetchDocument(body)),
      (error: unknown) => error instanceof MarketOAuthClientError && error.status === 400)
  }
})

test('a ChatGPT plugin completes authorize, code exchange, refresh, and revoke on its exact callback', async () => {
  const livePluginId = 'tgm7xlLGmmDt'
  const liveClientId = `${CHATGPT_CIMD_ORIGIN}/oauth/${livePluginId}/client.json`
  const liveCallback = `${CHATGPT_CIMD_ORIGIN}/connector/oauth/${livePluginId}`
  let metadataFetches = 0
  const { app, store } = fixture({ fetcher: (async (input, init) => {
    metadataFetches += 1
    assert.equal(String(input), liveClientId)
    assert.equal(init?.redirect, 'manual')
    return new Response(JSON.stringify({
      client_id: liveClientId,
      client_name: 'ChatGPT',
      redirect_uris: [liveCallback],
      token_endpoint_auth_method: 'private_key_jwt',
      token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
    }), { headers: { 'content-type': 'application/json' } })
  }) as typeof fetch })
  const query = new URLSearchParams({
    response_type: 'code', client_id: liveClientId, redirect_uri: liveCallback,
    resource: RESOURCE, scope: MARKET_OAUTH_SCOPE, state: STATE,
    code_challenge: CHALLENGE, code_challenge_method: 'S256',
  })
  const start = await app.request(`/oauth/authorize?${query}`)
  assert.equal(start.status, 200)
  assert.equal(metadataFetches, 1)
  const approved = await app.request('/oauth/authorize', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: ORIGIN,
      cookie: cookiePair(start),
    },
    body: new URLSearchParams({
      action: 'link', csrf: hiddenCsrf(await start.text()), merchant_key: MERCHANT_KEY,
    }),
  })
  assert.equal(approved.status, 302)
  const callback = new URL(approved.headers.get('location')!)
  assert.equal(callback.origin + callback.pathname, liveCallback)
  assert.equal(callback.searchParams.get('state'), STATE)
  assert.equal(callback.searchParams.get('iss'), ORIGIN)
  const code = callback.searchParams.get('code')!
  assert.match(code, /^1f3ea_ac_[0-9a-f]{64}$/)

  const codeFields = {
    grant_type: 'authorization_code', client_id: liveClientId,
    redirect_uri: liveCallback, resource: RESOURCE, code, code_verifier: VERIFIER,
  }
  const wrongCallback = await app.request('/oauth/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      ...codeFields, redirect_uri: `${CHATGPT_CIMD_ORIGIN}/connector/oauth/other-plugin`,
    }),
  })
  assert.equal(wrongCallback.status, 400)
  const exchanged = await app.request('/oauth/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(codeFields),
  })
  assert.equal(exchanged.status, 200)
  const first = await exchanged.json() as Record<string, unknown>
  const firstAccess = String(first.access_token)
  const firstRefresh = String(first.refresh_token)
  assert.equal((await merchantByOAuthAccessToken(firstAccess, environment, store.api))?.handle, 'tinylantern')

  const renewed = await app.request('/oauth/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token', client_id: liveClientId,
      resource: RESOURCE, refresh_token: firstRefresh,
    }),
  })
  assert.equal(renewed.status, 200)
  const second = await renewed.json() as Record<string, unknown>
  const secondAccess = String(second.access_token)
  const secondRefresh = String(second.refresh_token)
  assert.notEqual(secondAccess, firstAccess)
  assert.equal((await merchantByOAuthAccessToken(secondAccess, environment, store.api))?.handle, 'tinylantern')

  const revoked = await app.request('/oauth/revoke', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: secondRefresh, client_id: liveClientId }),
  })
  assert.equal(revoked.status, 200)
  assert.equal(await merchantByOAuthAccessToken(secondAccess, environment, store.api), null)
  const refreshAfterRevoke = await app.request('/oauth/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token', client_id: liveClientId,
      resource: RESOURCE, refresh_token: secondRefresh,
    }),
  })
  assert.equal(refreshAfterRevoke.status, 400)
  assert.equal(metadataFetches, 1)
})
