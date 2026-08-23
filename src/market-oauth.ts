import { randomBytes } from 'node:crypto'
import type { Context, Hono } from 'hono'
import { setOAuthMerchantResolver, sha256, type Merchant } from './core.ts'
import {
  MARKET_OAUTH_ACCESS_TOKEN_PREFIX,
  MARKET_OAUTH_AUTHORIZATION_CODE_PREFIX,
  MARKET_OAUTH_REFRESH_TOKEN_PREFIX,
  MARKET_OAUTH_SCOPE,
  hostedMarketSigninEnabled,
  marketOAuthResource,
  marketPublicOrigin,
  marketTokenLooksSensitive,
  parseMarketCimdOrigins,
  parseMarketOAuthClients,
  resolveMarketOAuthClient,
  validateMarketAuthorizationRequest,
  verifyMarketPkceS256,
  type MarketOAuthEnvironment,
} from './market-oauth-config.ts'
import {
  postgresMarketOAuthStore,
  type MarketOAuthStore,
  type OAuthAttemptKind,
} from './market-oauth-store.ts'

const SESSION_COOKIE = '__Host-1f3ea_oauth'
const MAX_FORM_BYTES = 8_192
const ACCESS_TOKEN_SECONDS = 10 * 60
const REFRESH_TOKEN_SECONDS = 30 * 24 * 60 * 60
const AUTHORIZATION_FIELDS = new Set([
  'response_type', 'client_id', 'redirect_uri', 'resource', 'scope', 'state',
  'code_challenge', 'code_challenge_method', 'ui_locales',
])

export interface MarketOAuthRouteOptions {
  environment?: MarketOAuthEnvironment
  store?: MarketOAuthStore
  fetcher?: typeof fetch
}

interface Runtime {
  environment: MarketOAuthEnvironment
  store: MarketOAuthStore
  fetcher: typeof fetch
  origin: string
  resource: string
  staticClients: ReturnType<typeof parseMarketOAuthClients>
  cimdOrigins: ReturnType<typeof parseMarketCimdOrigins>
}

function runtime(options: MarketOAuthRouteOptions): Runtime | null {
  const environment = options.environment ?? process.env
  if (!hostedMarketSigninEnabled(environment)) return null
  return {
    environment,
    store: options.store ?? postgresMarketOAuthStore,
    fetcher: options.fetcher ?? fetch,
    origin: marketPublicOrigin(environment),
    resource: marketOAuthResource(environment),
    staticClients: parseMarketOAuthClients(environment.HOSTED_MARKET_OAUTH_CLIENTS),
    cimdOrigins: parseMarketCimdOrigins(environment.HOSTED_MARKET_CIMD_ORIGINS),
  }
}

function opaque(prefix = ''): string {
  return prefix + randomBytes(32).toString('hex')
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!)
}

function privateHeaders(c: Context, html = false): void {
  c.header('Cache-Control', 'no-store')
  c.header('Pragma', 'no-cache')
  c.header('Referrer-Policy', html ? 'same-origin' : 'no-referrer')
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('X-Frame-Options', 'DENY')
  c.res.headers.delete('Access-Control-Allow-Origin')
  c.res.headers.delete('Access-Control-Allow-Credentials')
  if (html) {
    c.header(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    )
  }
}

function trustedBrowserForm(c: Context, publicOrigin: string): boolean {
  const requestOrigin = c.req.header('origin')
  if (requestOrigin && requestOrigin !== 'null') return requestOrigin === publicOrigin

  const referer = c.req.header('referer')
  if (referer) {
    try {
      return new URL(referer).origin === publicOrigin
    } catch {
      return false
    }
  }

  return c.req.header('sec-fetch-site') === 'same-origin'
    && c.req.header('sec-fetch-mode') === 'navigate'
    && c.req.header('sec-fetch-dest') === 'document'
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · 1F3EA</title><style>
:root{color-scheme:dark}*{box-sizing:border-box}body{max-width:42rem;margin:3rem auto;padding:0 1.2rem;background:#10141a;color:#f3eee4;font:17px/1.55 system-ui,sans-serif}main{background:#181e27;border:1px solid #48505c;border-radius:14px;padding:1.4rem}h1{line-height:1.15}label{display:block;margin:1rem 0 .35rem}input{width:100%;min-height:2.75rem;padding:.75rem;background:#10141a;color:#f3eee4;border:1px solid #778291;border-radius:7px}button{min-height:2.75rem;margin:.8rem .5rem 0 0;padding:.7rem 1rem;border:0;border-radius:8px;background:#f4a261;color:#151515;font-weight:700}.secondary{background:#778291;color:#fff}.warning{color:#ffd166}.muted{color:#b3bdc9}@media (max-width:35rem){body{margin:1rem auto;padding:0 .75rem;font-size:16px}main{padding:1rem}button{display:block;width:100%;margin:.65rem 0 0}}
</style></head><body><main>${body}</main></body></html>`
}

function html(c: Context, status: 200 | 400 | 403 | 429 | 503, title: string, body: string) {
  privateHeaders(c, true)
  return c.html(page(title, body), status)
}

function browserError(c: Context, status: 400 | 403 | 429 | 503, message: string) {
  return html(c, status, 'Sign-in stopped', `<h1>Sign-in stopped</h1><p>${escapeHtml(message)}</p>`)
}

function consentPage(clientName: string, csrf: string): string {
  return `<h1>Connect ${escapeHtml(clientName)} to 1F3EA</h1>
<p>Link an existing merchant. Your permanent merchant key is checked by 1F3EA and never sent to ChatGPT.</p>
<p class="warning">Enter it only on this 1F3EA sign-in page. Never paste it into chat or a tool argument.</p>
<form method="post" action="/oauth/authorize">
<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<label for="merchant_key">Permanent merchant key</label>
<input id="merchant_key" name="merchant_key" type="password" required autocomplete="off" spellcheck="false">
<button name="action" value="link" type="submit">Connect merchant</button>
<button class="secondary" name="action" value="cancel" type="submit">Cancel</button>
</form><p class="muted">No new merchant is registered here. Use the ordinary 1F3EA MCP or JSON API first.</p>`
}

function setSessionCookie(c: Context, value: string): void {
  c.header(
    'Set-Cookie',
    `${SESSION_COOKIE}=${value}; Path=/; Max-Age=900; Secure; HttpOnly; SameSite=Lax`,
  )
}

function clearSessionCookie(c: Context): void {
  c.header(
    'Set-Cookie',
    `${SESSION_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`,
  )
}

function sessionCookie(c: Context): string | null {
  const cookie = c.req.header('cookie') ?? ''
  for (const pair of cookie.split(';')) {
    const [name, ...parts] = pair.trim().split('=')
    if (name === SESSION_COOKIE) return parts.join('=') || null
  }
  return null
}

function queryObject(url: URL): Record<string, string> | null {
  const result: Record<string, string> = {}
  for (const [key, value] of url.searchParams) {
    if (!AUTHORIZATION_FIELDS.has(key) || key in result) return null
    result[key] = value
  }
  return result
}

async function form(c: Context): Promise<URLSearchParams | null> {
  const type = c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  const declared = Number(c.req.header('content-length') ?? 0)
  if (type !== 'application/x-www-form-urlencoded' || declared > MAX_FORM_BYTES) return null
  const text = await c.req.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_FORM_BYTES) return null
  return new URLSearchParams(text)
}

function one(values: URLSearchParams, key: string, maximum: number): string | null {
  const all = values.getAll(key)
  if (all.length !== 1 || all[0] === '' || Buffer.byteLength(all[0]!, 'utf8') > maximum) return null
  return all[0]!
}

function exactFields(values: URLSearchParams, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed)
  const seen = new Set<string>()
  for (const key of values.keys()) {
    if (!allowedSet.has(key) || seen.has(key)) return false
    seen.add(key)
  }
  return true
}

function clientAddress(c: Context, environment: MarketOAuthEnvironment): string {
  if (environment.VERCEL !== '1') return 'unknown'
  return (c.req.header('x-vercel-forwarded-for') ?? '').split(',').at(-1)?.trim() || 'unknown'
}

async function admitted(
  oauth: Runtime,
  buckets: readonly string[],
  attemptKind: OAuthAttemptKind,
  maximum: number,
): Promise<boolean> {
  for (const bucket of buckets) {
    const accepted = await oauth.store.consumeOAuthRateLimit({
      bucketHash: sha256(`market-oauth:${bucket}`), attemptKind, maximum,
    })
    if (!accepted) return false
  }
  return true
}

function redirect(c: Context, destination: string): Response {
  privateHeaders(c)
  clearSessionCookie(c)
  return c.redirect(destination, 302)
}

function callbackUrl(
  redirectUri: string,
  state: string,
  issuer: string,
  values: Readonly<Record<string, string>>,
): string {
  const url = new URL(redirectUri)
  for (const [key, value] of Object.entries({ ...values, state, iss: issuer })) {
    url.searchParams.set(key, value)
  }
  return url.href
}

function tokenError(c: Context, error: 'invalid_request' | 'invalid_client' | 'invalid_grant') {
  privateHeaders(c)
  return c.json({ error }, 400)
}

function tokenResponse(c: Context, accessToken: string, refreshToken: string) {
  privateHeaders(c)
  return c.json({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_SECONDS,
    refresh_token: refreshToken,
    scope: MARKET_OAUTH_SCOPE,
  })
}

export function marketOAuthChallenge(
  environment: MarketOAuthEnvironment = process.env,
): string {
  return `Bearer resource_metadata="${marketPublicOrigin(environment)}/.well-known/oauth-protected-resource/mcp/connect", scope="${MARKET_OAUTH_SCOPE}"`
}

export function mountMarketOAuthRoutes(app: Hono, options: MarketOAuthRouteOptions = {}): void {
  const oauth = runtime(options)
  if (!oauth) return

  const protectedResource = (c: Context) => {
    c.header('Access-Control-Allow-Origin', '*')
    return c.json({
      resource: oauth.resource,
      authorization_servers: [oauth.origin],
      bearer_methods_supported: ['header'],
      scopes_supported: [MARKET_OAUTH_SCOPE],
    })
  }
  app.get('/.well-known/oauth-protected-resource', protectedResource)
  app.get('/.well-known/oauth-protected-resource/mcp/connect', protectedResource)
  app.get('/.well-known/oauth-authorization-server', c => c.json({
    issuer: oauth.origin,
    authorization_endpoint: `${oauth.origin}/oauth/authorize`,
    token_endpoint: `${oauth.origin}/oauth/token`,
    revocation_endpoint: `${oauth.origin}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: [MARKET_OAUTH_SCOPE],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  }))

  app.options('/oauth/*', c => {
    privateHeaders(c)
    return c.body(null, 204)
  })

  app.get('/oauth/authorize', async c => {
    const query = queryObject(new URL(c.req.url))
    if (!query) return browserError(c, 400, 'The sign-in request was not valid.')
    const rawClientId = query.client_id
    if (
      !rawClientId || Buffer.byteLength(rawClientId, 'utf8') > 2_048 ||
      marketTokenLooksSensitive(rawClientId)
    ) return browserError(c, 400, 'The sign-in request was not valid.')
    try {
      const allowed = await admitted(
        oauth,
        [`metadata-ip:${clientAddress(c, oauth.environment)}`],
        'authorize',
        120,
      )
      if (!allowed) return browserError(c, 429, 'Too many sign-in attempts. Try again in one hour.')
    } catch {
      c.header('Retry-After', '1')
      return browserError(c, 503, '1F3EA could not start sign-in. Try again in a moment.')
    }
    let client
    try {
      client = await resolveMarketOAuthClient(
        rawClientId, oauth.staticClients, oauth.cimdOrigins, oauth.fetcher,
      )
    } catch {
      return browserError(c, 400, 'The requesting chat app is not approved.')
    }
    let request
    try {
      request = validateMarketAuthorizationRequest(query, [client], oauth.resource)
    } catch {
      return browserError(c, 400, 'The sign-in request was not valid.')
    }
    try {
      const allowed = await admitted(
        oauth,
        [`client:${request.clientId}`],
        'authorize',
        60,
      )
      if (!allowed) return browserError(c, 429, 'Too many sign-in attempts. Try again in one hour.')
      const session = opaque()
      const csrf = opaque()
      await oauth.store.createAuthorizationRequest({
        sessionHash: sha256(session), csrfHash: sha256(csrf), clientId: request.clientId,
        clientName: request.clientName, redirectUri: request.redirectUri, resource: request.resource,
        scope: request.scope, state: request.state, codeChallenge: request.codeChallenge,
      })
      setSessionCookie(c, session)
      return html(c, 200, 'Connect to 1F3EA', consentPage(request.clientName, csrf))
    } catch {
      c.header('Retry-After', '1')
      return browserError(c, 503, '1F3EA could not start sign-in. Try again in a moment.')
    }
  })

  app.post('/oauth/authorize', async c => {
    try {
      if (!trustedBrowserForm(c, oauth.origin)) {
        return browserError(c, 403, 'This approval did not come from the 1F3EA sign-in page.')
      }
      const values = await form(c)
      const session = sessionCookie(c)
      const action = values ? one(values, 'action', 20) : null
      const csrf = values ? one(values, 'csrf', 128) : null
      if (!values || !session || !csrf || !['link', 'cancel'].includes(action ?? '')) {
        return browserError(c, 403, 'This sign-in page expired or is incomplete.')
      }
      const allowedFields = action === 'link'
        ? ['action', 'csrf', 'merchant_key']
        : ['action', 'csrf']
      if (!exactFields(values, allowedFields)) {
        return browserError(c, 403, 'This sign-in form contained unexpected information.')
      }
      const sessionHash = sha256(session)
      const csrfHash = sha256(csrf)
      const pending = await oauth.store.getAuthorizationRequest(sessionHash)
      if (!pending) return browserError(c, 403, 'This sign-in request expired or was already used.')

      if (action === 'cancel') {
        const canceled = await oauth.store.cancelAuthorizationRequest({ sessionHash, csrfHash })
        if (!canceled) return browserError(c, 403, 'This sign-in request expired or was already used.')
        return redirect(c, callbackUrl(canceled.redirectUri, canceled.state, oauth.origin, {
          error: 'access_denied',
        }))
      }

      const merchantKey = one(values, 'merchant_key', 80)
      if (!merchantKey || !/^1f3ea_sk_[0-9a-f]{48}$/.test(merchantKey)) {
        return browserError(c, 403, 'That merchant key could not be verified.')
      }
      const allowed = await admitted(
        oauth,
        [`ip:${clientAddress(c, oauth.environment)}`, `client:${pending.client_id}`],
        'merchant_key',
        10,
      )
      if (!allowed) return browserError(c, 429, 'Too many key attempts. Try again in one hour.')
      const code = opaque(MARKET_OAUTH_AUTHORIZATION_CODE_PREFIX)
      const approved = await oauth.store.approveExistingMerchantAndIssueAuthorizationCode({
        sessionHash, csrfHash, merchantSecretHash: sha256(merchantKey),
        authorizationCodeHash: sha256(code),
      })
      if (!approved) return browserError(c, 403, 'That merchant key could not be verified.')
      return redirect(c, callbackUrl(approved.redirectUri, approved.state, oauth.origin, { code }))
    } catch {
      c.header('Retry-After', '1')
      return browserError(c, 503, '1F3EA could not complete sign-in. Try again in a moment.')
    }
  })

  app.post('/oauth/token', async c => {
    try {
      const values = await form(c)
      if (!values || c.req.header('authorization') || values.has('client_secret')) {
        return tokenError(c, 'invalid_request')
      }
      const grantType = one(values, 'grant_type', 64)
      const allowedFields = grantType === 'authorization_code'
        ? ['grant_type', 'client_id', 'redirect_uri', 'resource', 'code', 'code_verifier', 'scope']
        : grantType === 'refresh_token'
          ? ['grant_type', 'client_id', 'resource', 'refresh_token', 'scope']
          : []
      if (!allowedFields.length || !exactFields(values, allowedFields)) {
        return tokenError(c, 'invalid_request')
      }
      const clientId = one(values, 'client_id', 2_048)
      const resource = one(values, 'resource', 2_048)
      const scope = values.has('scope') ? one(values, 'scope', 128) : MARKET_OAUTH_SCOPE
      if (!clientId || resource !== oauth.resource || scope !== MARKET_OAUTH_SCOPE) {
        return tokenError(c, 'invalid_client')
      }
      const allowed = await admitted(
        oauth,
        [`ip:${clientAddress(c, oauth.environment)}`, `client:${clientId}`],
        grantType === 'refresh_token' ? 'refresh' : 'token',
        120,
      )
      if (!allowed) return tokenError(c, 'invalid_grant')

      if (grantType === 'authorization_code') {
        const code = one(values, 'code', 100)
        const redirectUri = one(values, 'redirect_uri', 4_096)
        const verifier = one(values, 'code_verifier', 128)
        if (!code || !/^1f3ea_ac_[0-9a-f]{64}$/.test(code) || !redirectUri || !verifier) {
          return tokenError(c, 'invalid_grant')
        }
        const codeHash = sha256(code)
        const stored = await oauth.store.getAuthorizationCode(codeHash)
        if (
          !stored || stored.clientId !== clientId || stored.redirectUri !== redirectUri ||
          stored.resource !== resource || stored.scope !== MARKET_OAUTH_SCOPE ||
          !verifyMarketPkceS256(verifier, stored.codeChallenge)
        ) return tokenError(c, 'invalid_grant')
        const accessToken = opaque(MARKET_OAUTH_ACCESS_TOKEN_PREFIX)
        const refreshToken = opaque(MARKET_OAUTH_REFRESH_TOKEN_PREFIX)
        const exchanged = await oauth.store.exchangeAuthorizationCode({
          codeHash, clientId, redirectUri, resource,
          accessTokenHash: sha256(accessToken), refreshTokenHash: sha256(refreshToken),
        })
        if (!exchanged) return tokenError(c, 'invalid_grant')
        return tokenResponse(c, accessToken, refreshToken)
      }

      const presented = one(values, 'refresh_token', 100)
      if (!presented || !/^1f3ea_rt_[0-9a-f]{64}$/.test(presented)) {
        return tokenError(c, 'invalid_grant')
      }
      const accessToken = opaque(MARKET_OAUTH_ACCESS_TOKEN_PREFIX)
      const refreshToken = opaque(MARKET_OAUTH_REFRESH_TOKEN_PREFIX)
      const rotated = await oauth.store.rotateRefreshToken({
        presentedRefreshTokenHash: sha256(presented), clientId, resource,
        accessTokenHash: sha256(accessToken), newRefreshTokenHash: sha256(refreshToken),
      })
      if (rotated !== 'rotated') return tokenError(c, 'invalid_grant')
      return tokenResponse(c, accessToken, refreshToken)
    } catch {
      privateHeaders(c)
      c.header('Retry-After', '1')
      return c.json({ error: 'temporarily_unavailable' }, 503)
    }
  })

  app.post('/oauth/revoke', async c => {
    try {
      const values = await form(c)
      const clientId = values ? one(values, 'client_id', 2_048) : null
      const token = values ? one(values, 'token', 100) : null
      const validToken = Boolean(
        token && (/^1f3ea_(?:at|rt)_[0-9a-f]{64}$/.test(token)),
      )
      if (
        values && !c.req.header('authorization') && !values.has('client_secret') &&
        exactFields(values, ['token', 'client_id', 'token_type_hint']) && clientId && validToken &&
        await admitted(
          oauth,
          [`ip:${clientAddress(c, oauth.environment)}`, `client:${clientId}`],
          'revoke',
          120,
        )
      ) await oauth.store.revokeTokenFamilyByToken({ tokenHash: sha256(token!), clientId })
    } catch {
      // RFC 7009 revocation is intentionally idempotent and does not reveal token state.
    }
    privateHeaders(c)
    return c.body(null, 200)
  })
}

export async function merchantByOAuthAccessToken(
  accessToken: string,
  environment: MarketOAuthEnvironment = process.env,
  store: MarketOAuthStore = postgresMarketOAuthStore,
): Promise<Merchant | null> {
  if (!hostedMarketSigninEnabled(environment)) return null
  if (!/^1f3ea_at_[0-9a-f]{64}$/.test(accessToken)) return null
  return store.resolveOAuthAccessToken({
    accessTokenHash: sha256(accessToken),
    resource: marketOAuthResource(environment),
    scope: MARKET_OAUTH_SCOPE,
  })
}

export function configureMarketOAuthMerchantResolver(
  options: { environment?: MarketOAuthEnvironment; store?: MarketOAuthStore } = {},
): void {
  const environment = options.environment ?? process.env
  const store = options.store ?? postgresMarketOAuthStore
  setOAuthMerchantResolver(token => merchantByOAuthAccessToken(token, environment, store))
}
