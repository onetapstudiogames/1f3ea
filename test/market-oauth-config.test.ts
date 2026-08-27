import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CHATGPT_CIMD_ORIGIN,
  CHATGPT_OAUTH_CLIENT_ID,
  CHATGPT_OAUTH_REDIRECT_URI,
  MARKET_OAUTH_ACCESS_TOKEN_PREFIX,
  MARKET_OAUTH_AUTHORIZATION_CODE_PREFIX,
  MARKET_OAUTH_REFRESH_TOKEN_PREFIX,
  MARKET_OAUTH_RESOURCE,
  MARKET_OAUTH_SCOPE,
  MarketOAuthClientError,
  hostedMarketSigninEnabled,
  marketOAuthResource,
  marketPublicOrigin,
  marketTokenLooksSensitive,
  parseMarketCimdOrigins,
  parseMarketOAuthClients,
  resolveMarketOAuthClient,
  validateMarketAuthorizationRequest,
  verifyMarketPkceS256,
  type MarketOAuthClient,
} from '../src/market-oauth-config.ts'

const PREVIEW_ORIGIN = 'https://market-preview.example.test'
const CLIENT_ORIGIN = 'https://chat.example.test'
const CLIENT_ID = `${CLIENT_ORIGIN}/oauth/client.json`
const REDIRECT_URI = `${CLIENT_ORIGIN}/oauth/callback`
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'

const staticClient: MarketOAuthClient = {
  clientId: 'hosted-chat-preview',
  clientName: 'Hosted Chat Preview',
  redirectUris: [REDIRECT_URI],
  tokenEndpointAuthMethod: 'none',
}

function metadata(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    client_id: CLIENT_ID,
    client_name: 'Hosted Chat',
    redirect_uris: [REDIRECT_URI],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    ...overrides,
  })
}

function jsonResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: 200,
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  })
}

async function clientError(pending: Promise<unknown>): Promise<MarketOAuthClientError> {
  try {
    await pending
    assert.fail('expected OAuth client resolution to fail')
  } catch (error) {
    assert.ok(error instanceof MarketOAuthClientError)
    return error
  }
}

function validRequest(resource = MARKET_OAUTH_RESOURCE): Record<string, unknown> {
  return {
    response_type: 'code',
    client_id: staticClient.clientId,
    redirect_uri: REDIRECT_URI,
    resource,
    scope: MARKET_OAUTH_SCOPE,
    state: 'opaque-client-state',
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
  }
}

test('hosted market sign-in is off unless explicitly enabled', () => {
  assert.equal(hostedMarketSigninEnabled({}), false)
  assert.equal(hostedMarketSigninEnabled({ HOSTED_MARKET_SIGNIN_ENABLED: 'false' }), false)
  assert.equal(hostedMarketSigninEnabled({ HOSTED_MARKET_SIGNIN_ENABLED: 'true' }), true)
  assert.equal(hostedMarketSigninEnabled({ HOSTED_MARKET_SIGNIN_ENABLED: 'TRUE' }), false)
})

test('the market audience, scope, prefixes, and PUBLIC_ORIGIN remain narrow', () => {
  assert.equal(MARKET_OAUTH_RESOURCE, 'https://1f3ea.com/mcp/connect')
  assert.equal(MARKET_OAUTH_SCOPE, 'market:merchant')
  assert.equal(marketPublicOrigin({}), 'https://1f3ea.com')
  assert.equal(marketPublicOrigin({ PUBLIC_ORIGIN: PREVIEW_ORIGIN }), PREVIEW_ORIGIN)
  assert.equal(marketOAuthResource({ PUBLIC_ORIGIN: PREVIEW_ORIGIN }), `${PREVIEW_ORIGIN}/mcp/connect`)
  assert.match(MARKET_OAUTH_AUTHORIZATION_CODE_PREFIX, /^1f3ea_ac_$/)
  assert.match(MARKET_OAUTH_ACCESS_TOKEN_PREFIX, /^1f3ea_at_$/)
  assert.match(MARKET_OAUTH_REFRESH_TOKEN_PREFIX, /^1f3ea_rt_$/)

  for (const unsafe of [
    'http://market-preview.example.test',
    'https://user@market-preview.example.test',
    'https://market-preview.example.test/path',
    'https://market-preview.example.test?query=yes',
    'https://market-preview.example.test/#fragment',
  ]) {
    assert.throws(() => marketPublicOrigin({ PUBLIC_ORIGIN: unsafe }), /HTTPS origin/i)
    assert.throws(() => marketOAuthResource({ PUBLIC_ORIGIN: unsafe }), /HTTPS origin/i)
  }
})

test('static client configuration permits only public clients with exact HTTPS redirects', () => {
  const parsed = parseMarketOAuthClients(JSON.stringify([{
    client_id: staticClient.clientId,
    client_name: staticClient.clientName,
    redirect_uris: staticClient.redirectUris,
  }]))
  assert.deepEqual(parsed, [staticClient])

  const unsafeClients = [
    [{ client_id: 'bad', client_name: 'Bad', redirect_uris: ['http://chat.example.test/callback'] }],
    [{ client_id: 'bad', client_name: 'Bad', redirect_uris: ['https://*.example.test/callback'] }],
    [{ client_id: 'bad', client_name: 'Bad', redirect_uris: ['https://user@chat.example.test/callback'] }],
    [{ client_id: 'bad', client_name: 'Bad', redirect_uris: ['https://chat.example.test/callback#fragment'] }],
    [{ client_id: 'bad', client_name: 'Bad', redirect_uris: [REDIRECT_URI], client_secret: 'forbidden' }],
    [{ client_id: 'bad', client_name: `Bad 1f3ea_sk_${'ab'.repeat(24)}`, redirect_uris: [REDIRECT_URI] }],
    [{ client_id: 'bad', client_name: 'Bad', redirect_uris: [`${REDIRECT_URI}?key=1f3ea_sk_${'ab'.repeat(24)}`] }],
    [{ client_id: 'bad', client_name: 'Bad', redirect_uris: [`${REDIRECT_URI}?key=1f3ea%5Fsk%5F${'ab'.repeat(24)}`] }],
  ]
  for (const clients of unsafeClients) {
    assert.throws(() => parseMarketOAuthClients(JSON.stringify(clients)))
  }
})

test('CIMD origins are exact HTTPS origins and include the stable ChatGPT origin', () => {
  assert.deepEqual(parseMarketCimdOrigins(undefined), [CHATGPT_CIMD_ORIGIN])
  assert.deepEqual(
    parseMarketCimdOrigins(JSON.stringify([CLIENT_ORIGIN, CHATGPT_CIMD_ORIGIN])),
    [CHATGPT_CIMD_ORIGIN, CLIENT_ORIGIN],
  )

  for (const unsafe of [
    ['http://chatgpt.com'],
    ['https://*.example.com'],
    ['https://example.com/a/path'],
    ['https://user@example.com'],
    ['https://example.com?query=yes'],
  ]) {
    assert.throws(() => parseMarketCimdOrigins(JSON.stringify(unsafe)))
  }
})

test('authorization accepts only exact code flow details, one scope, state, and a 43-character S256 challenge', () => {
  assert.deepEqual(validateMarketAuthorizationRequest(validRequest(), [staticClient]), {
    clientId: staticClient.clientId,
    clientName: staticClient.clientName,
    redirectUri: REDIRECT_URI,
    resource: MARKET_OAUTH_RESOURCE,
    scope: MARKET_OAUTH_SCOPE,
    state: 'opaque-client-state',
    codeChallenge: CHALLENGE,
  })

  const secret = `1f3ea_sk_${'ab'.repeat(24)}`
  const rejected = [
    { ...validRequest(), response_type: 'token' },
    { ...validRequest(), client_id: 'unknown' },
    { ...validRequest(), redirect_uri: `${REDIRECT_URI}/almost` },
    { ...validRequest(), resource: 'https://1f3ea.com/mcp' },
    { ...validRequest(), scope: 'market:merchant market:admin' },
    { ...validRequest(), code_challenge_method: 'plain' },
    { ...validRequest(), code_challenge: `${CHALLENGE}x` },
    { ...validRequest(), code_challenge: 'too-short' },
    { ...validRequest(), state: '' },
    { ...validRequest(), state: 'x'.repeat(4_097) },
    { ...validRequest(), state: `return-${secret}` },
  ]
  for (const request of rejected) {
    assert.throws(() => validateMarketAuthorizationRequest(request, [staticClient]))
  }

  const previewResource = marketOAuthResource({ PUBLIC_ORIGIN: PREVIEW_ORIGIN })
  assert.equal(
    validateMarketAuthorizationRequest(validRequest(previewResource), [staticClient], previewResource).resource,
    previewResource,
  )
})

test('PKCE uses RFC 7636 S256 and credentials are recognized before public output or logs', () => {
  assert.equal(verifyMarketPkceS256(VERIFIER, CHALLENGE), true)
  assert.equal(verifyMarketPkceS256(`${VERIFIER}x`, CHALLENGE), false)
  assert.equal(verifyMarketPkceS256('short', CHALLENGE), false)

  for (const credential of [
    `1f3ea_sk_${'a1'.repeat(24)}`,
    `${MARKET_OAUTH_AUTHORIZATION_CODE_PREFIX}${'b2'.repeat(32)}`,
    `${MARKET_OAUTH_ACCESS_TOKEN_PREFIX}${'c3'.repeat(32)}`,
    `${MARKET_OAUTH_REFRESH_TOKEN_PREFIX}${'d4'.repeat(32)}`,
    `1f3ea_rc_${'e5'.repeat(32)}`,
  ]) {
    assert.equal(marketTokenLooksSensitive(credential), true)
    assert.equal(marketTokenLooksSensitive(`accidental public note: ${credential}`), true)
  }
  assert.equal(marketTokenLooksSensitive('a merchant carries a tiny lantern'), false)
})

test('a configured client resolves without a metadata network request', async () => {
  let fetchCount = 0
  const fetcher = (async () => {
    fetchCount += 1
    throw new Error('static clients must not use the network')
  }) as typeof fetch

  const resolved = await resolveMarketOAuthClient(
    staticClient.clientId,
    [staticClient],
    [CLIENT_ORIGIN],
    fetcher,
  )
  assert.equal(resolved, staticClient)
  assert.equal(fetchCount, 0)
})

test('CIMD fetches only an allowlisted HTTPS origin with redirects disabled and a timeout', async () => {
  let fetchedUrl = ''
  let fetchedInit: RequestInit | undefined
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    fetchedUrl = String(input)
    fetchedInit = init
    return jsonResponse(metadata())
  }) as typeof fetch

  const resolved = await resolveMarketOAuthClient(CLIENT_ID, [], [CLIENT_ORIGIN], fetcher)
  assert.deepEqual(resolved, {
    clientId: CLIENT_ID,
    clientName: 'Hosted Chat',
    redirectUris: [REDIRECT_URI],
    tokenEndpointAuthMethod: 'none',
  })
  assert.equal(fetchedUrl, CLIENT_ID)
  assert.equal(fetchedInit?.method, 'GET')
  assert.equal(fetchedInit?.redirect, 'manual')
  assert.equal(new Headers(fetchedInit?.headers).get('accept'), 'application/json')
  assert.ok(fetchedInit?.signal instanceof AbortSignal)

  const redirecting = (async () => new Response('', {
    status: 302,
    headers: { location: `${CLIENT_ORIGIN}/other.json` },
  })) as typeof fetch
  await assert.rejects(
    resolveMarketOAuthClient(CLIENT_ID, [], [CLIENT_ORIGIN], redirecting),
    /rejected/i,
  )
})

test('CIMD metadata fetch is aborted after four seconds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let requestSignal: AbortSignal | null | undefined
  const fetcher = ((_: string | URL | Request, init?: RequestInit) => {
    requestSignal = init?.signal
    return new Promise<Response>((_resolve, reject) => {
      requestSignal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })
  }) as typeof fetch

  const pending = resolveMarketOAuthClient(CLIENT_ID, [], [CLIENT_ORIGIN], fetcher)
  assert.equal(requestSignal?.aborted, false)
  t.mock.timers.tick(3_999)
  assert.equal(requestSignal?.aborted, false)
  t.mock.timers.tick(1)
  const error = await clientError(pending)
  assert.equal(error.status, 503)
  assert.match(error.message, /metadata.*unavailable.*try again/i)
  assert.equal(requestSignal?.aborted, true)
})

test('CIMD classifies fetch, HTTP, and unreadable responses as upstream unavailable', async () => {
  const upstreams = [
    (async () => { throw new Error('private network detail') }) as typeof fetch,
    (async () => new Response('down', { status: 503 })) as typeof fetch,
    (async () => new Response('not json', {
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch,
    (async () => jsonResponse('[]')) as typeof fetch,
  ]

  for (const fetcher of upstreams) {
    const error = await clientError(resolveMarketOAuthClient(CLIENT_ID, [], [CLIENT_ORIGIN], fetcher))
    assert.equal(error.status, 503)
    assert.match(error.message, /metadata.*(?:unavailable|unreadable).*try again/i)
    assert.doesNotMatch(error.message, /private network detail/i)
  }
})

test('CIMD keeps unapproved IDs and readable but invalid metadata as caller errors', async () => {
  const unapproved = await clientError(resolveMarketOAuthClient(
    'https://outside.example/client.json',
    [],
    [CLIENT_ORIGIN],
    (async () => assert.fail('unapproved client must not fetch')) as typeof fetch,
  ))
  assert.equal(unapproved.status, 400)
  assert.match(unapproved.message, /unknown OAuth client/i)

  const invalidMetadata = await clientError(resolveMarketOAuthClient(
    CLIENT_ID,
    [],
    [CLIENT_ORIGIN],
    (async () => jsonResponse(metadata({
      client_id: `${CLIENT_ORIGIN}/someone-else.json`,
    }))) as typeof fetch,
  ))
  assert.equal(invalidMetadata.status, 400)
  assert.match(invalidMetadata.message, /identity mismatch/i)
})

test('unallowlisted, credential-bearing, malformed, and fragment-bearing client IDs never fetch', async () => {
  let fetchCount = 0
  const fetcher = (async () => {
    fetchCount += 1
    return jsonResponse(metadata())
  }) as typeof fetch
  const secret = `1f3ea_sk_${'ab'.repeat(24)}`

  for (const clientId of [
    'https://outside.example/client.json',
    'http://chat.example.test/client.json',
    'https://chat.example.test/',
    'https://user@chat.example.test/client.json',
    'https://chat.example.test/client.json?redirect=https://internal.example',
    'https://chat.example.test/client.json#fragment',
    `${CLIENT_ORIGIN}/oauth/${secret}/client.json`,
    `${CLIENT_ORIGIN}/oauth/1f3ea%5Fsk%5F${'ab'.repeat(24)}/client.json`,
  ]) {
    await assert.rejects(resolveMarketOAuthClient(clientId, [], [CLIENT_ORIGIN], fetcher))
  }
  assert.equal(fetchCount, 0)
})

test('CIMD rejects unsafe identity, redirects, auth methods, media types, and oversized bodies', async () => {
  const rejectedDocuments = [
    metadata({ client_id: `${CLIENT_ORIGIN}/someone-else.json` }),
    metadata({ client_name: undefined }),
    metadata({ redirect_uris: undefined }),
    metadata({ redirect_uris: ['http://chat.example.test/callback'] }),
    metadata({ redirect_uris: ['https://user@chat.example.test/callback'] }),
    metadata({ redirect_uris: ['https://chat.example.test/callback#fragment'] }),
    metadata({ token_endpoint_auth_method: 'client_secret_basic' }),
    metadata({ token_endpoint_auth_method: undefined }),
    metadata({
      token_endpoint_auth_method: undefined,
      token_endpoint_auth_methods_supported: ['none'],
    }),
    metadata({ token_endpoint_auth_method: 'none', token_endpoint_auth_methods_supported: ['private_key_jwt'] }),
    metadata({ ignored_note: `1f3ea_sk_${'ab'.repeat(24)}` }),
  ]
  for (const document of rejectedDocuments) {
    const fetcher = (async () => jsonResponse(document)) as typeof fetch
    await assert.rejects(resolveMarketOAuthClient(CLIENT_ID, [], [CLIENT_ORIGIN], fetcher))
  }

  const wrongType = (async () => new Response(metadata(), {
    headers: { 'content-type': 'text/html' },
  })) as typeof fetch
  await assert.rejects(resolveMarketOAuthClient(CLIENT_ID, [], [CLIENT_ORIGIN], wrongType), /JSON/i)

  const falselyDeclaredTooLarge = (async () => jsonResponse(metadata(), {
    headers: { 'content-length': '65537' },
  })) as typeof fetch
  assert.equal(
    (await resolveMarketOAuthClient(CLIENT_ID, [], [CLIENT_ORIGIN], falselyDeclaredTooLarge)).clientId,
    CLIENT_ID,
  )

  const actualTooLarge = (async () => jsonResponse(JSON.stringify({ padding: 'x'.repeat(65_536) }))) as typeof fetch
  await assert.rejects(resolveMarketOAuthClient(CLIENT_ID, [], [CLIENT_ORIGIN], actualTooLarge), /too large/i)
})

test('the exact stable ChatGPT CIMD negotiates public PKCE from its advertised choices', async () => {
  let unexpectedFetchCount = 0
  const unexpectedFetcher = (async () => {
    unexpectedFetchCount += 1
    return jsonResponse(metadata())
  }) as typeof fetch
  await assert.rejects(resolveMarketOAuthClient(
    'https://chatgpt.com/not-the-stable-client.json',
    [],
    [CHATGPT_CIMD_ORIGIN],
    unexpectedFetcher,
  ))
  assert.equal(unexpectedFetchCount, 0)

  const fetcher = (async () => jsonResponse(JSON.stringify({
    client_id: CHATGPT_OAUTH_CLIENT_ID,
    client_uri: 'https://chatgpt.com/',
    client_name: 'ChatGPT',
    redirect_uris: [CHATGPT_OAUTH_REDIRECT_URI],
    token_endpoint_auth_method: 'private_key_jwt',
    token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  }))) as typeof fetch

  const client = await resolveMarketOAuthClient(
    CHATGPT_OAUTH_CLIENT_ID,
    [],
    [CHATGPT_CIMD_ORIGIN],
    fetcher,
  )
  assert.deepEqual(client, {
    clientId: CHATGPT_OAUTH_CLIENT_ID,
    clientName: 'ChatGPT',
    redirectUris: [CHATGPT_OAUTH_REDIRECT_URI],
    tokenEndpointAuthMethod: 'none',
  })

  for (const supported of [['private_key_jwt'], ['none']]) {
    const incomplete = (async () => jsonResponse(JSON.stringify({
      client_id: CHATGPT_OAUTH_CLIENT_ID,
      client_name: 'ChatGPT',
      redirect_uris: [CHATGPT_OAUTH_REDIRECT_URI],
      token_endpoint_auth_method: 'private_key_jwt',
      token_endpoint_auth_methods_supported: supported,
    }))) as typeof fetch
    await assert.rejects(resolveMarketOAuthClient(
      CHATGPT_OAUTH_CLIENT_ID,
      [],
      [CHATGPT_CIMD_ORIGIN],
      incomplete,
    ))
  }

  const wrongRedirect = (async () => jsonResponse(JSON.stringify({
    client_id: CHATGPT_OAUTH_CLIENT_ID,
    client_name: 'ChatGPT',
    redirect_uris: ['https://chatgpt.com/not-the-connector-callback'],
    token_endpoint_auth_method: 'private_key_jwt',
    token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
  }))) as typeof fetch
  await assert.rejects(resolveMarketOAuthClient(
    CHATGPT_OAUTH_CLIENT_ID,
    [],
    [CHATGPT_CIMD_ORIGIN],
    wrongRedirect,
  ), /redirect/i)
})
