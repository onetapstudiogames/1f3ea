import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CALLBACK,
  CHALLENGE,
  CHATGPT_OAUTH_CLIENT_ID,
  CHATGPT_OAUTH_REDIRECT_URI,
  CLIENT_ID,
  Hono,
  MERCHANT_KEY,
  MemoryOAuthStore,
  ORIGIN,
  RESOURCE,
  STATE,
  VERIFIER,
  approve,
  authorizationUrl,
  brokenFormRequest,
  configureMarketOAuthMerchantResolver,
  confirmMerchant,
  cookiePair,
  environment,
  exchange,
  fixture,
  hiddenCsrf,
  merchant,
  merchantByOAuthAccessToken,
  mountMarketOAuthRoutes,
  prepareMerchant,
  sha256,
} from './support/market-oauth-flow-harness.ts'

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

test('OAuth revocation names retryable operational failures without revealing token state', async () => {
  const { app: issuer, store } = fixture()
  const approved = await approve(issuer)
  const exchanged = await exchange(issuer, approved.code)
  const access = String(exchanged.body.access_token)

  const limitedApp = new Hono()
  mountMarketOAuthRoutes(limitedApp, {
    environment,
    store: { ...store.api, consumeOAuthRateLimit: async () => false },
  })
  const limited = await limitedApp.request('/oauth/revoke', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: access, client_id: CLIENT_ID }),
  })
  assert.equal(limited.status, 429)
  assert.equal(limited.headers.get('retry-after'), '3600')
  assert.match(limited.headers.get('cache-control') ?? '', /no-store/i)
  assert.deepEqual(await limited.json(), {
    error: 'temporarily_unavailable',
    error_description: 'revocation allows 120 attempts per UTC hour for each IP and each client; ' +
      'retry after the next UTC hour begins',
  })
  assert.deepEqual(await merchantByOAuthAccessToken(access, environment, store.api), merchant())

  const failingApp = new Hono()
  mountMarketOAuthRoutes(failingApp, {
    environment,
    store: {
      ...store.api,
      revokeTokenFamilyByToken: async () => { throw new Error('database unavailable') },
    },
  })
  const failed = await failingApp.request('/oauth/revoke', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: access, client_id: CLIENT_ID }),
  })
  assert.equal(failed.status, 503)
  assert.equal(failed.headers.get('retry-after'), '1')
  assert.match(failed.headers.get('cache-control') ?? '', /no-store/i)
  assert.deepEqual(await failed.json(), {
    error: 'temporarily_unavailable',
    error_description: 'revocation could not be completed; retry later',
  })
  assert.deepEqual(await merchantByOAuthAccessToken(access, environment, store.api), merchant())
})

test('OAuth token throttling names the hourly rule without revealing grant state', async () => {
  const store = new MemoryOAuthStore()
  const app = new Hono()
  mountMarketOAuthRoutes(app, {
    environment,
    store: { ...store.api, consumeOAuthRateLimit: async () => false },
  })

  const response = await app.request('/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', client_id: CLIENT_ID, redirect_uri: CALLBACK,
      resource: RESOURCE, code: `1f3ea_ac_${'ab'.repeat(32)}`, code_verifier: VERIFIER,
      scope: 'market:merchant',
    }),
  })

  assert.equal(response.status, 429)
  assert.equal(response.headers.get('retry-after'), '3600')
  assert.match(response.headers.get('cache-control') ?? '', /no-store/i)
  assert.deepEqual(await response.json(), {
    error: 'temporarily_unavailable',
    error_description: 'token requests allow 120 attempts per UTC hour for each IP and each client; ' +
      'retry after the next UTC hour begins',
  })
})

test('OAuth token operational failures name a retryable cause without revealing grant state', async () => {
  const store = new MemoryOAuthStore()
  const app = new Hono()
  mountMarketOAuthRoutes(app, {
    environment,
    store: {
      ...store.api,
      consumeOAuthRateLimit: async () => { throw new Error('private rate-store detail') },
    },
  })

  const response = await app.request('/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token', client_id: CLIENT_ID, resource: RESOURCE,
      refresh_token: `1f3ea_rt_${'ab'.repeat(32)}`, scope: 'market:merchant',
    }),
  })

  assert.equal(response.status, 503)
  assert.equal(response.headers.get('retry-after'), '1')
  assert.deepEqual(await response.json(), {
    error: 'temporarily_unavailable',
    error_description: 'token request could not be completed; retry later',
  })
})

test('OAuth revoke distinguishes an unreadable request from an opaque malformed no-op', async () => {
  const { app } = fixture()
  const malformed = await app.request('/oauth/revoke', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: 'not-a-token', client_id: CLIENT_ID }),
  })
  assert.equal(malformed.status, 200)
  assert.equal(await malformed.text(), '')

  const failedBody = new ReadableStream<Uint8Array>({
    start(controller) { controller.error(new Error('private body-stream detail')) },
  })
  const request = new Request(`${ORIGIN}/oauth/revoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: failedBody,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' })
  const unreadable = await app.request(request)
  assert.equal(unreadable.status, 503)
  assert.equal(unreadable.headers.get('retry-after'), '1')
  assert.deepEqual(await unreadable.json(), {
    error: 'temporarily_unavailable',
    error_description: 'revocation request could not be read; retry later',
  })
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

test('authorization distinguishes unreadable client metadata from an unapproved client', async () => {
  const metadataEnvironment = {
    ...environment,
    HOSTED_MARKET_OAUTH_CLIENTS: '[]',
    HOSTED_MARKET_CIMD_ORIGINS: JSON.stringify(['https://chatgpt.com']),
  }
  const query = new URLSearchParams({
    response_type: 'code', client_id: CHATGPT_OAUTH_CLIENT_ID,
    redirect_uri: CHATGPT_OAUTH_REDIRECT_URI, resource: RESOURCE,
    scope: 'market:merchant', state: STATE, code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
  })
  const unavailableFetchers = [
    (async () => { throw new Error('private network detail') }) as typeof fetch,
    (async () => new Response('down', { status: 503 })) as typeof fetch,
    (async () => new Response('not json', {
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch,
    (async () => new Response('[]', {
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch,
  ]

  for (const fetcher of unavailableFetchers) {
    const app = new Hono()
    mountMarketOAuthRoutes(app, {
      environment: metadataEnvironment,
      store: new MemoryOAuthStore().api,
      fetcher,
    })
    const response = await app.request(`/oauth/authorize?${query}`)
    assert.equal(response.status, 503)
    assert.equal(response.headers.get('retry-after'), '1')
    const body = await response.text()
    assert.match(body, /could not read the requesting chat app(?:'|&#39;)s client metadata.*try again/i)
    assert.doesNotMatch(body, /private network detail/i)
  }

  let fetchCount = 0
  const app = new Hono()
  mountMarketOAuthRoutes(app, {
    environment: metadataEnvironment,
    store: new MemoryOAuthStore().api,
    fetcher: (async () => {
      fetchCount += 1
      return new Response('{}', { headers: { 'content-type': 'application/json' } })
    }) as typeof fetch,
  })
  query.set('client_id', 'https://outside.example/client.json')
  const unapproved = await app.request(`/oauth/authorize?${query}`)
  assert.equal(unapproved.status, 400)
  assert.match(await unapproved.text(), /requesting chat app is not approved/i)
  assert.equal(fetchCount, 0)
})
