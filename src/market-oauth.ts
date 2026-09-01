import { randomBytes } from 'node:crypto'
import type { Context, Hono } from 'hono'
import {
  HANDLE_RE,
  newSecret,
  setOAuthMerchantResolver,
  sha256,
  type Merchant,
} from './core.ts'
import {
  exactFormFields,
  oneFormValue,
  readBoundedFormResult,
  trustedBrowserForm,
} from './browser-form.ts'
import {
  clearBrowserSessionCookie,
  inspectBrowserSessionCookie,
  newBrowserSessionCookie,
  setBrowserSessionCookie,
  type BrowserSessionCookie,
} from './browser-session.ts'
import { privateBrowserHeaders as privateHeaders } from './private-browser.ts'
import {
  MARKET_OAUTH_ACCESS_TOKEN_PREFIX,
  MARKET_OAUTH_AUTHORIZATION_CODE_PREFIX,
  MARKET_OAUTH_REFRESH_TOKEN_PREFIX,
  MARKET_OAUTH_SCOPE,
  MarketOAuthClientError,
  marketOAuthResource,
  marketTokenLooksSensitive,
  parseMarketCimdOrigins,
  parseMarketOAuthClients,
  resolveMarketOAuthClient,
  validateMarketAuthorizationRequest,
  verifyMarketPkceS256,
  type MarketOAuthEnvironment,
} from './market-oauth-config.ts'
import { hostedMarketSigninReadiness } from './hosted-market-readiness.ts'
import {
  MARKET_OAUTH_SESSION_COOKIE as SESSION_COOKIE,
  isInitialAuthorizationRequest,
  isSameAuthorizationRequest,
  isStagedAuthorizationRequest,
  oauthBrowserError as browserError,
  oauthConsentPage as consentPage,
  oauthHtml as html,
  oauthModelValue as modelValue,
  resumedMerchantKeyPage,
  saveMerchantKeyPage,
  stagedAuthorizationResponse,
  terminalAuthorizationResponse,
} from './market-oauth-browser.ts'
import { newRecoveryCodeSet } from './recovery-codes.ts'
import {
  postgresMarketOAuthStore,
  type AuthorizationRequestInput,
  type AuthorizationRequestRecord,
  type MarketOAuthStore,
  type OAuthAttemptKind,
} from './market-oauth-store.ts'
import { postgresErrorDetails } from './postgres-error.ts'

const ACCESS_TOKEN_SECONDS = 10 * 60
const REFRESH_TOKEN_SECONDS = 30 * 24 * 60 * 60
const TOKEN_REQUESTS_PER_IP_OR_CLIENT_UTC_HOUR = 120
const REVOCATIONS_PER_IP_OR_CLIENT_UTC_HOUR = 120
const OAUTH_RATE_RETRY_AFTER_SECONDS = 60 * 60
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
  const readiness = hostedMarketSigninReadiness(environment)
  if (!readiness.ready) return null
  return {
    environment,
    store: options.store ?? postgresMarketOAuthStore,
    fetcher: options.fetcher ?? fetch,
    origin: readiness.origin,
    resource: marketOAuthResource(environment),
    staticClients: parseMarketOAuthClients(environment.HOSTED_MARKET_OAUTH_CLIENTS),
    cimdOrigins: parseMarketCimdOrigins(environment.HOSTED_MARKET_CIMD_ORIGINS),
  }
}

function opaque(prefix = ''): string {
  return prefix + randomBytes(32).toString('hex')
}

function queryObject(url: URL): Record<string, string> | null {
  const result: Record<string, string> = {}
  for (const [key, value] of url.searchParams) {
    if (!AUTHORIZATION_FIELDS.has(key) || key in result) return null
    result[key] = value
  }
  return result
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
  clearBrowserSessionCookie(c, SESSION_COOKIE)
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

function oauthUnavailable(
  c: Context,
  status: 429 | 503,
  description: string,
  retryAfter = 1,
) {
  privateHeaders(c)
  c.header('Retry-After', String(retryAfter))
  return c.json({
    error: 'temporarily_unavailable',
    error_description: description,
  }, status)
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
    } catch (error) {
      if (error instanceof MarketOAuthClientError && error.status === 400) {
        return browserError(c, 400, 'The requesting chat app is not approved.')
      }
      c.header('Retry-After', '1')
      return browserError(
        c,
        503,
        "1F3EA could not read the requesting chat app's client metadata. Try again in a moment.",
      )
    }
    let request
    try {
      request = validateMarketAuthorizationRequest(query, [client], oauth.resource)
    } catch {
      return browserError(c, 400, 'The sign-in request was not valid.')
    }
    const authorizationInput = (cookie: BrowserSessionCookie): AuthorizationRequestInput => ({
      sessionHash: sha256(cookie.session),
      csrfHash: sha256(cookie.csrf),
      clientId: request.clientId,
      clientName: request.clientName,
      redirectUri: request.redirectUri,
      resource: request.resource,
      scope: request.scope,
      state: request.state,
      codeChallenge: request.codeChallenge,
    })
    const renderConsent = (
      cookie: BrowserSessionCookie,
      existing?: AuthorizationRequestRecord,
    ): Response => html(
      c,
      200,
      'Connect to 1F3EA',
      consentPage(
        existing?.client_display_name ?? request.clientName,
        cookie.csrf,
        existing !== undefined,
      ),
    )
    const renderActiveRequest = (
      existing: AuthorizationRequestRecord,
      cookie: BrowserSessionCookie,
    ): Response => {
      if (isInitialAuthorizationRequest(existing)) return renderConsent(cookie, existing)
      if (isStagedAuthorizationRequest(existing)) {
        return stagedAuthorizationResponse(c, existing, cookie.csrf)
      }
      return browserError(
        c,
        403,
        'This sign-in already advanced. If a merchant creation response disappeared, restart sign-in and use the saved key as an existing merchant. Do not register again.',
      )
    }
    const renderMatchingProgress = async (
      cookie: BrowserSessionCookie,
    ): Promise<Response | null> => {
      const progress = await oauth.store.getAuthorizationRequestProgress({
        sessionHash: sha256(cookie.session),
        csrfHash: sha256(cookie.csrf),
      })
      if (!progress || !isSameAuthorizationRequest(progress.request, authorizationInput(cookie))) {
        return null
      }
      return terminalAuthorizationResponse(c, progress)
    }

    const cookieState = inspectBrowserSessionCookie(c, SESSION_COOKIE)
    if (cookieState.kind === 'valid') {
      try {
        const input = authorizationInput(cookieState.cookie)
        const existing = await oauth.store.getAuthorizationRequest(input.sessionHash)
        if (existing) {
          if (!isSameAuthorizationRequest(existing, input)) {
            return browserError(
              c,
              409,
              'This browser is already continuing a different sign-in. Return to the original sign-in and cancel it, or wait up to 15 minutes for it to expire before starting this one.',
            )
          }
          return renderActiveRequest(existing, cookieState.cookie)
        }
        const terminal = await renderMatchingProgress(cookieState.cookie)
        if (terminal) return terminal
      } catch {
        c.header('Retry-After', '1')
        return browserError(c, 503, '1F3EA could not resume sign-in. Try again in a moment.')
      }
    }

    try {
      const allowed = await admitted(oauth, [`client:${request.clientId}`], 'authorize', 60)
      if (!allowed) return browserError(c, 429, 'Too many sign-in attempts. Try again in one hour.')
    } catch {
      c.header('Retry-After', '1')
      return browserError(c, 503, '1F3EA could not start sign-in. Try again in a moment.')
    }

    const createFreshAuthorization = async (
      cookie: BrowserSessionCookie,
      canRetryCollision: boolean,
    ): Promise<Response> => {
      const input = authorizationInput(cookie)
      try {
        await oauth.store.createAuthorizationRequest(input)
      } catch (error) {
        if (postgresErrorDetails(error).code !== '23505') throw error
        const existing = await oauth.store.getAuthorizationRequest(input.sessionHash)
        if (
          existing && isSameAuthorizationRequest(existing, input) &&
          (isInitialAuthorizationRequest(existing) || isStagedAuthorizationRequest(existing))
        ) {
          setBrowserSessionCookie(c, SESSION_COOKIE, cookie.raw)
          return renderActiveRequest(existing, cookie)
        }
        if (canRetryCollision) return createFreshAuthorization(newBrowserSessionCookie(), false)
        throw error
      }
      setBrowserSessionCookie(c, SESSION_COOKIE, cookie.raw)
      return renderConsent(cookie)
    }

    try {
      return await createFreshAuthorization(newBrowserSessionCookie(), true)
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
      const formRead = await readBoundedFormResult(c)
      if (formRead.kind === 'unreadable') {
        c.header('Retry-After', '1')
        return browserError(c, 503, 'The sign-in form could not be read. Try again in a moment.')
      }
      const values = formRead.kind === 'form' ? formRead.values : null
      const action = values ? oneFormValue(values, 'action', 20) : null
      const csrf = values ? oneFormValue(values, 'csrf', 128) : null
      if (!values || !csrf || !['link', 'register', 'confirm', 'cancel'].includes(action ?? '')) {
        return browserError(c, 403, 'This sign-in page expired or is incomplete.')
      }
      const cookieState = inspectBrowserSessionCookie(c, SESSION_COOKIE)
      if (cookieState.kind === 'missing') {
        return browserError(c, 403, 'This form was submitted without its private browser cookie. Start again from the chat app.')
      }
      if (cookieState.kind === 'invalid' || cookieState.cookie.csrf !== csrf) {
        return browserError(c, 403, 'This form and its private browser cookie did not match. Start again from the chat app.')
      }
      const allowedFields = {
        link: ['action', 'csrf', 'merchant_key'],
        register: ['action', 'csrf', 'handle', 'model'],
        confirm: ['action', 'csrf', 'merchant_key'],
        cancel: ['action', 'csrf'],
      } as const
      if (!exactFormFields(values, allowedFields[action as keyof typeof allowedFields])) {
        return browserError(c, 403, 'This sign-in form contained unexpected information.')
      }
      const sessionHash = sha256(cookieState.cookie.session)
      const csrfHash = sha256(csrf)
      const terminalProgress = async (): Promise<Response | null> => {
        const progress = await oauth.store.getAuthorizationRequestProgress({ sessionHash, csrfHash })
        return progress ? terminalAuthorizationResponse(c, progress) : null
      }
      const pending = await oauth.store.getAuthorizationRequest(sessionHash)
      if (!pending) {
        return await terminalProgress() ?? browserError(
          c,
          403,
          'This sign-in request expired, was already used, or lost its browser state. Start again from the chat app.',
        )
      }

      if (action === 'register' && isStagedAuthorizationRequest(pending)) {
        return stagedAuthorizationResponse(c, pending, csrf)
      }

      if (action === 'cancel') {
        const canceled = await oauth.store.cancelAuthorizationRequest({ sessionHash, csrfHash })
        if (!canceled) {
          return await terminalProgress() ?? browserError(c, 403, 'This sign-in request expired or was already used.')
        }
        return redirect(c, callbackUrl(canceled.redirectUri, canceled.state, oauth.origin, {
          error: 'access_denied',
        }))
      }

      if (action === 'confirm') {
        if (!isStagedAuthorizationRequest(pending)) {
          return browserError(c, 403, 'This merchant is not waiting for key confirmation.')
        }
        const merchantKey = oneFormValue(values, 'merchant_key', 80)
        if (!merchantKey || !/^1f3ea_sk_[0-9a-f]{48}$/.test(merchantKey)) {
          return html(
            c,
            403,
            'Merchant key not verified',
            '<p class="warning">That saved merchant key could not be verified. Check it and try again.</p>' +
              resumedMerchantKeyPage(pending.new_handle!, csrf),
          )
        }
        const allowed = await admitted(
          oauth,
          [
            `signup-confirm-ip:${clientAddress(c, oauth.environment)}`,
            `signup-confirm-session:${sessionHash}`,
          ],
          'merchant_key',
          10,
        )
        if (!allowed) {
          return browserError(c, 429, 'Too many key attempts. This sign-in expires before the one-hour wait ends; start again after the next UTC hour.')
        }
        const code = opaque(MARKET_OAUTH_AUTHORIZATION_CODE_PREFIX)
        const approved = await oauth.store.confirmNewMerchantAndIssueAuthorizationCode({
          sessionHash,
          csrfHash,
          merchantSecretHash: sha256(merchantKey),
          authorizationCodeHash: sha256(code),
        })
        if (approved.status === 'request_unavailable') {
          return await terminalProgress() ?? browserError(c, 403, 'This sign-in request is no longer available.')
        }
        if (approved.status === 'confirmation_not_ready') {
          return browserError(c, 403, 'This merchant is not waiting for key confirmation.')
        }
        if (approved.status === 'confirmation_rejected') {
          return html(
            c,
            403,
            'Merchant key not verified',
            '<p class="warning">That saved merchant key could not be verified. Check it and try again.</p>' +
              resumedMerchantKeyPage(pending.new_handle!, csrf),
          )
        }
        if (approved.status === 'handle_taken') {
          return browserError(
            c,
            409,
            'That handle was taken before confirmation. This losing signup is closed; its saved key and recovery codes are inactive. Check whether the existing store belongs to this agent before choosing another handle.',
          )
        }
        return redirect(c, callbackUrl(approved.redirectUri, approved.state, oauth.origin, { code }))
      }

      if (action === 'link') {
        if (!isInitialAuthorizationRequest(pending)) {
          return browserError(c, 403, 'This sign-in is already preparing a new merchant. Continue that signup or cancel it first.')
        }
        const merchantKey = oneFormValue(values, 'merchant_key', 80)
        if (!merchantKey || !/^1f3ea_sk_[0-9a-f]{48}$/.test(merchantKey)) {
          return html(
            c,
            403,
            'Merchant key not verified',
            '<p class="warning">That merchant key could not be verified. Check it and try again.</p>' +
              consentPage(pending.client_display_name, csrf, true),
          )
        }
        const allowed = await admitted(
          oauth,
          [`ip:${clientAddress(c, oauth.environment)}`, `client:${pending.client_id}`],
          'merchant_key',
          10,
        )
        if (!allowed) return browserError(c, 429, 'Too many key attempts. Try again after the next UTC hour.')
        const code = opaque(MARKET_OAUTH_AUTHORIZATION_CODE_PREFIX)
        const approved = await oauth.store.approveExistingMerchantAndIssueAuthorizationCode({
          sessionHash,
          csrfHash,
          merchantSecretHash: sha256(merchantKey),
          authorizationCodeHash: sha256(code),
        })
        if (approved.status === 'request_unavailable') {
          return await terminalProgress() ?? browserError(c, 403, 'This sign-in request is no longer available.')
        }
        if (approved.status === 'merchant_key_rejected') {
          return html(
            c,
            403,
            'Merchant key not verified',
            '<p class="warning">That merchant key could not be verified. Check it and try again.</p>' +
              consentPage(pending.client_display_name, csrf, true),
          )
        }
        return redirect(c, callbackUrl(approved.redirectUri, approved.state, oauth.origin, { code }))
      }

      if (!isInitialAuthorizationRequest(pending)) {
        return browserError(c, 403, 'This sign-in already advanced. Continue it or cancel it before starting another merchant.')
      }
      const handle = String(values.get('handle') ?? '').toLowerCase().trim()
      const model = modelValue(values)
      if (!HANDLE_RE.test(handle) || model === null) {
        return html(
          c,
          400,
          'Merchant details not valid',
          '<p class="warning">The handle must be 3–32 lowercase letters, numbers, or hyphens; the model label is optional and limited to 120 ordinary characters.</p>' +
            consentPage(pending.client_display_name, csrf, true),
        )
      }
      const registrationLimits: ReadonlyArray<readonly [string, number]> = [
        [`signup-ip:${clientAddress(c, oauth.environment)}`, 3],
        ['signup-global', 300],
        [`signup-client:${pending.client_id}`, 300],
      ]
      for (const [bucket, maximum] of registrationLimits) {
        if (!(await admitted(oauth, [bucket], 'authorize', maximum))) {
          return browserError(c, 429, 'New-merchant preparation is at its stated hourly limit. This sign-in expires before the wait ends; start again after the next UTC hour.')
        }
      }
      const merchantKey = newSecret()
      const recoveryCodes = newRecoveryCodeSet()
      const staged = await oauth.store.stageNewMerchantRegistration({
        sessionHash,
        csrfHash,
        handle,
        model,
        merchantSecretHash: sha256(merchantKey),
        recoveryCodeHashes: recoveryCodes.map(sha256),
      })
      if (staged.status === 'request_unavailable') {
        const resumed = await oauth.store.getAuthorizationRequest(sessionHash)
        if (resumed && isStagedAuthorizationRequest(resumed)) {
          return stagedAuthorizationResponse(c, resumed, csrf)
        }
        return await terminalProgress() ?? browserError(c, 403, 'This sign-in request is no longer available.')
      }
      if (staged.status === 'handle_taken') {
        return html(
          c,
          409,
          'Handle already taken',
          '<p class="warning">That merchant handle is already taken. Check whether it belongs to this agent before choosing another one.</p>' +
            consentPage(pending.client_display_name, csrf, true),
        )
      }
      return html(
        c,
        200,
        'Save the merchant key',
        saveMerchantKeyPage(staged.handle, merchantKey, recoveryCodes, csrf),
      )
    } catch {
      c.header('Retry-After', '1')
      return browserError(
        c,
        503,
        '1F3EA could not return the sign-in result. Reload this page to resume. If merchant creation may have completed, restart sign-in and use the saved key as an existing merchant; do not register again.',
      )
    }
  })

  app.post('/oauth/token', async c => {
    try {
      const formRead = await readBoundedFormResult(c)
      if (formRead.kind === 'unreadable') {
        return oauthUnavailable(c, 503, 'token request could not be read; retry later')
      }
      const values = formRead.kind === 'form' ? formRead.values : null
      if (!values || c.req.header('authorization') || values.has('client_secret')) {
        return tokenError(c, 'invalid_request')
      }
      const grantType = oneFormValue(values, 'grant_type', 64)
      const allowedFields = grantType === 'authorization_code'
        ? ['grant_type', 'client_id', 'redirect_uri', 'resource', 'code', 'code_verifier', 'scope']
        : grantType === 'refresh_token'
          ? ['grant_type', 'client_id', 'resource', 'refresh_token', 'scope']
          : []
      if (!allowedFields.length || !exactFormFields(values, allowedFields)) {
        return tokenError(c, 'invalid_request')
      }
      const clientId = oneFormValue(values, 'client_id', 2_048)
      const resource = oneFormValue(values, 'resource', 2_048)
      const scope = values.has('scope') ? oneFormValue(values, 'scope', 128) : MARKET_OAUTH_SCOPE
      if (!clientId || resource !== oauth.resource || scope !== MARKET_OAUTH_SCOPE) {
        return tokenError(c, 'invalid_client')
      }
      const allowed = await admitted(
        oauth,
        [`ip:${clientAddress(c, oauth.environment)}`, `client:${clientId}`],
        grantType === 'refresh_token' ? 'refresh' : 'token',
        TOKEN_REQUESTS_PER_IP_OR_CLIENT_UTC_HOUR,
      )
      if (!allowed) {
        return oauthUnavailable(
          c,
          429,
          `token requests allow ${TOKEN_REQUESTS_PER_IP_OR_CLIENT_UTC_HOUR} attempts per UTC hour ` +
            'for each IP and each client; retry after the next UTC hour begins',
          OAUTH_RATE_RETRY_AFTER_SECONDS,
        )
      }

      if (grantType === 'authorization_code') {
        const code = oneFormValue(values, 'code', 100)
        const redirectUri = oneFormValue(values, 'redirect_uri', 4_096)
        const verifier = oneFormValue(values, 'code_verifier', 128)
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

      const presented = oneFormValue(values, 'refresh_token', 100)
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
      return oauthUnavailable(c, 503, 'token request could not be completed; retry later')
    }
  })

  app.post('/oauth/revoke', async c => {
    const opaqueSuccess = () => {
      privateHeaders(c)
      return c.body(null, 200)
    }
    const formRead = await readBoundedFormResult(c)
    if (formRead.kind === 'unreadable') {
      return oauthUnavailable(c, 503, 'revocation request could not be read; retry later')
    }
    const values = formRead.kind === 'form' ? formRead.values : null
    const clientId = values ? oneFormValue(values, 'client_id', 2_048) : null
    const token = values ? oneFormValue(values, 'token', 100) : null
    const validToken = Boolean(token && /^1f3ea_(?:at|rt)_[0-9a-f]{64}$/.test(token))
    const eligible = Boolean(
      values && !c.req.header('authorization') && !values.has('client_secret') &&
      exactFormFields(values, ['token', 'client_id', 'token_type_hint']) && clientId && validToken
    )
    if (!eligible) return opaqueSuccess()

    let allowed: boolean
    try {
      allowed = await admitted(
          oauth,
          [`ip:${clientAddress(c, oauth.environment)}`, `client:${clientId!}`],
          'revoke',
          REVOCATIONS_PER_IP_OR_CLIENT_UTC_HOUR,
        )
    } catch {
      return oauthUnavailable(c, 503, 'revocation could not be completed; retry later')
    }
    if (!allowed) {
      return oauthUnavailable(
        c,
        429,
        `revocation allows ${REVOCATIONS_PER_IP_OR_CLIENT_UTC_HOUR} attempts per UTC hour ` +
          'for each IP and each client; retry after the next UTC hour begins',
        OAUTH_RATE_RETRY_AFTER_SECONDS,
      )
    }

    try {
      await oauth.store.revokeTokenFamilyByToken({ tokenHash: sha256(token!), clientId: clientId! })
    } catch {
      return oauthUnavailable(c, 503, 'revocation could not be completed; retry later')
    }
    return opaqueSuccess()
  })
}

export async function merchantByOAuthAccessToken(
  accessToken: string,
  environment: MarketOAuthEnvironment = process.env,
  store: MarketOAuthStore = postgresMarketOAuthStore,
): Promise<Merchant | null> {
  if (!hostedMarketSigninReadiness(environment).ready) return null
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
  if (!hostedMarketSigninReadiness(environment).ready) {
    setOAuthMerchantResolver(null)
    return
  }
  const store = options.store ?? postgresMarketOAuthStore
  setOAuthMerchantResolver(token => merchantByOAuthAccessToken(token, environment, store))
}
