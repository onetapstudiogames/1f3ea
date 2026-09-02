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
test('OAuth routes and access tokens stay dormant until every hosted-sign-in dependency is ready', async () => {
  const store = new MemoryOAuthStore()
  const app = new Hono()
  const incompleteEnvironment = {
    ...environment,
    MARKET_IDENTITY_ROTATION_ENABLED: 'false',
  }
  mountMarketOAuthRoutes(app, { environment: incompleteEnvironment, store: store.api })

  assert.equal((await app.request('/.well-known/oauth-authorization-server')).status, 404)
  assert.equal((await app.request(authorizationUrl())).status, 404)
  assert.equal(
    await merchantByOAuthAccessToken(`1f3ea_at_${'ab'.repeat(32)}`, incompleteEnvironment, {
      ...store.api,
      resolveOAuthAccessToken: async () => { throw new Error('must not query dormant OAuth') },
    }),
    null,
  )

  const invalidApp = new Hono()
  assert.doesNotThrow(() => mountMarketOAuthRoutes(invalidApp, {
    environment: { ...environment, PUBLIC_ORIGIN: 'not a public https origin' },
    store: store.api,
  }))
  assert.equal((await invalidApp.request('/.well-known/oauth-authorization-server')).status, 404)
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
  assert.match(html, /never sent to the hosted client/i)
  assert.doesNotMatch(authorizationUrl(), /1f3ea_sk_/i)
  assert.doesNotMatch(html, /1f3ea_sk_[0-9a-f]{48}/i)
  assert.doesNotMatch(store.safeState(), /1f3ea_(?:sk|at|rt|ac)_/i)
})

test('a browser cookie cannot silently substitute its active request for a different sign-in', async () => {
  const { app } = fixture()
  const original = await app.request(authorizationUrl())
  const cookie = cookiePair(original)
  const mismatchedState = 'different-state-must-not-be-echoed'

  const mismatch = await app.request(authorizationUrl({ state: mismatchedState }), {
    headers: { cookie },
  })
  assert.equal(mismatch.status, 409)
  assert.equal(mismatch.headers.get('set-cookie'), null)
  assert.match(mismatch.headers.get('cache-control') ?? '', /no-store/iu)
  const mismatchBody = await mismatch.text()
  assert.match(mismatchBody, /different sign-in.*original.*cancel.*15 minutes/isu)
  assert.doesNotMatch(mismatchBody, new RegExp(`${STATE}|${mismatchedState}|${CHALLENGE}`, 'u'))

  const resumed = await app.request(authorizationUrl(), { headers: { cookie } })
  assert.equal(resumed.status, 200)
  assert.match(await resumed.text(), /continuing its earlier sign-in/iu)
})

test('sign-in offers resumable save-first merchant creation without putting a key in chat', async () => {
  const { app } = fixture()
  const response = await app.request(authorizationUrl())
  const body = await response.text()

  assert.equal(response.status, 200)
  assert.match(body, /name="action" value="register"/u)
  assert.match(body, /merchant has not been created|not created until/iu)
  assert.match(body, /save[^.]*merchant key[^.]*re-enter/iu)
  assert.match(body, /eight recovery codes|8 recovery codes/iu)
  assert.doesNotMatch(body, /1f3ea_(?:sk|rc)_[0-9a-f]+/iu)
})

test('save-first signup reveals one key and eight codes, then exact confirmation creates the merchant', async () => {
  const { app, store } = fixture()
  const prepared = await prepareMerchant(app)

  assert.equal(prepared.response.status, 200)
  assert.match(prepared.merchantKey, /^1f3ea_sk_[0-9a-f]{48}$/u)
  assert.equal(prepared.recoveryCodes.length, 8)
  assert.equal(new Set(prepared.recoveryCodes).size, 8)
  assert.equal(store.merchantCount(), 1, 'staging must not create a merchant')
  assert.equal(store.stagedRecoveryCodeCount(), 8)
  for (const credential of [prepared.merchantKey, ...prepared.recoveryCodes]) {
    assert.doesNotMatch(store.safeState(), new RegExp(credential, 'u'))
  }

  const wrong = await confirmMerchant(app, prepared, `1f3ea_sk_${'cd'.repeat(24)}`)
  assert.equal(wrong.status, 403)
  assert.match(await wrong.text(), /could not be verified.*try again/isu)
  assert.equal(store.merchantCount(), 1)

  const confirmed = await confirmMerchant(app, prepared)
  assert.equal(confirmed.status, 302)
  const callback = new URL(confirmed.headers.get('location')!)
  const code = callback.searchParams.get('code')!
  assert.equal(callback.searchParams.get('state'), STATE)
  assert.equal(callback.searchParams.get('iss'), ORIGIN)
  assert.equal(store.merchantCount(), 2)
  assert.equal(store.recoveryCodeCount(prepared.handle), 8)
  assert.equal(store.stagedRecoveryCodeCount(), 0)

  const exchanged = await exchange(app, code)
  assert.equal(exchanged.response.status, 200)
  assert.equal(
    (await merchantByOAuthAccessToken(String(exchanged.body.access_token), environment, store.api))
      ?.handle,
    prepared.handle,
  )
})

test('staged signup resumes without redisclosing credentials and cancellation creates nothing', async () => {
  const { app, store } = fixture()
  const prepared = await prepareMerchant(app, 'resume-shop')

  const resumed = await app.request(authorizationUrl(), {
    headers: { cookie: prepared.cookie },
  })
  const resumedBody = await resumed.text()
  assert.equal(resumed.status, 200)
  assert.match(resumedBody, /cannot show the merchant key or recovery codes again/iu)
  assert.doesNotMatch(resumedBody, /1f3ea_(?:sk|rc)_[0-9a-f]{48,64}/iu)

  const repeated = await app.request('/oauth/authorize', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN, cookie: prepared.cookie,
    },
    body: new URLSearchParams({
      action: 'register', csrf: prepared.csrf, handle: 'another-shop', model: '',
    }),
  })
  const repeatedBody = await repeated.text()
  assert.equal(repeated.status, 200)
  assert.match(repeatedBody, /Continue creating resume-shop/iu)
  assert.doesNotMatch(repeatedBody, /1f3ea_(?:sk|rc)_[0-9a-f]{48,64}/iu)

  const canceled = await app.request('/oauth/authorize', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN, cookie: prepared.cookie,
    },
    body: new URLSearchParams({ action: 'cancel', csrf: prepared.csrf }),
  })
  assert.equal(canceled.status, 302)
  assert.equal(new URL(canceled.headers.get('location')!).searchParams.get('error'), 'access_denied')
  assert.equal(store.merchantCount(), 1)
  assert.equal(store.stagedRecoveryCodeCount(), 0)

  const terminal = await app.request(authorizationUrl(), { headers: { cookie: prepared.cookie } })
  assert.equal(terminal.status, 403)
  assert.match(await terminal.text(), /canceled.*No staged merchant was created/isu)
})

test('a lost confirmation response reports the already-created truth without issuing new credentials', async () => {
  const store = new MemoryOAuthStore()
  const app = new Hono()
  mountMarketOAuthRoutes(app, {
    environment,
    store: {
      ...store.api,
      confirmNewMerchantAndIssueAuthorizationCode: async input => {
        await store.api.confirmNewMerchantAndIssueAuthorizationCode(input)
        throw new Error('simulated response loss after commit')
      },
    },
  })
  const prepared = await prepareMerchant(app, 'lost-response')

  const lost = await confirmMerchant(app, prepared)
  assert.equal(lost.status, 503)
  const lostBody = await lost.text()
  assert.match(lostBody, /may have completed.*saved key.*do not register again/isu)
  assert.doesNotMatch(lostBody, /1f3ea_(?:sk|rc)_[0-9a-f]{48,64}/iu)
  assert.equal(store.merchantCount(), 2)

  const reloaded = await app.request(authorizationUrl(), { headers: { cookie: prepared.cookie } })
  assert.equal(reloaded.status, 403)
  const reloadedBody = await reloaded.text()
  assert.match(reloadedBody, /lost-response was created.*already completed/isu)
  assert.match(reloadedBody, /Do not register the merchant again/iu)
  assert.doesNotMatch(reloadedBody, /1f3ea_(?:sk|rc)_[0-9a-f]{48,64}/iu)
})

test('a handle race closes the losing staged signup and makes its saved credentials inactive', async () => {
  const { app, store } = fixture()
  const prepared = await prepareMerchant(app, 'racy-shop')
  store.takeHandle(prepared.handle)

  const raced = await confirmMerchant(app, prepared)
  assert.equal(raced.status, 409)
  assert.match(await raced.text(), /losing signup is closed.*inactive/isu)
  assert.equal(store.merchantCount(), 2)
  assert.equal(store.recoveryCodeCount(prepared.handle), 0)
  assert.equal(store.stagedRecoveryCodeCount(), 0)

  const fresh = await app.request(authorizationUrl())
  const freshBody = await fresh.text()
  const rejected = await app.request('/oauth/authorize', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN, cookie: cookiePair(fresh),
    },
    body: new URLSearchParams({
      action: 'link', csrf: hiddenCsrf(freshBody), merchant_key: prepared.merchantKey,
    }),
  })
  assert.equal(rejected.status, 403)
  assert.match(await rejected.text(), /merchant key could not be verified/iu)
})

test('OAuth form limits use actual bytes and ignore misleading Content-Length', async () => {
  const { app } = fixture()
  const validSized = new URLSearchParams({
    grant_type: 'authorization_code', client_id: CLIENT_ID, redirect_uri: CALLBACK,
    resource: RESOURCE, code: `1f3ea_ac_${'ab'.repeat(32)}`, code_verifier: VERIFIER,
  }).toString()
  const misleading = await app.request('/oauth/token', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'content-length': String(1_000_000),
    },
    body: validSized,
  })
  assert.equal(misleading.status, 400)
  assert.deepEqual(await misleading.json(), { error: 'invalid_grant' })

  const oversized = await app.request('/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${'x'.repeat(8_193)}`,
  })
  assert.equal(oversized.status, 400)
  assert.deepEqual(await oversized.json(), { error: 'invalid_request' })
})

test('authorization and token routes distinguish broken streams from caller-invalid forms', async () => {
  const { app } = fixture()
  const authorization = await app.request(brokenFormRequest('/oauth/authorize'))
  assert.equal(authorization.status, 503)
  assert.equal(authorization.headers.get('retry-after'), '1')
  assert.match(authorization.headers.get('cache-control') ?? '', /no-store/iu)
  const authorizationBody = await authorization.text()
  assert.match(authorizationBody, /could not be read.*try again/isu)
  assert.doesNotMatch(authorizationBody, /private body-stream detail/iu)

  const token = await app.request(brokenFormRequest('/oauth/token'))
  assert.equal(token.status, 503)
  assert.equal(token.headers.get('retry-after'), '1')
  assert.match(token.headers.get('cache-control') ?? '', /no-store/iu)
  assert.deepEqual(await token.json(), {
    error: 'temporarily_unavailable',
    error_description: 'token request could not be read; retry later',
  })
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
