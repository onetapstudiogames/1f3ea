import type { Context, Hono } from 'hono'
import { sha256 } from './core.ts'
import { exactFormFields, oneFormValue, readBoundedFormResult } from './browser-form.ts'
import { privateBrowserHeaders as privateHeaders } from './private-browser.ts'
import {
  MARKET_OAUTH_ACCESS_TOKEN_PREFIX,
  MARKET_OAUTH_REFRESH_TOKEN_PREFIX,
  MARKET_OAUTH_SCOPE,
  verifyMarketPkceS256,
} from './market-oauth-config.ts'
import { admitted, clientAddress, opaque, type Runtime } from './market-oauth-runtime.ts'
import { MARKET_LIMITS } from './market-facts.ts'
import {
  markMarketRefusal,
  secondsUntilNextUtcHour,
  type MarketRefusalDetail,
} from './market-refusal.ts'

const ACCESS_TOKEN_SECONDS = MARKET_LIMITS.oauth.accessPassMinutes * 60
const TOKEN_REQUESTS_PER_IP_OR_CLIENT_UTC_HOUR = MARKET_LIMITS.oauth.tokenRequestsPerIpOrClientUtcHour
const REFRESHES_PER_CONNECTION_UTC_HOUR = MARKET_LIMITS.oauth.refreshesPerConnectionUtcHour
const JUNK_REFRESHES_PER_IP_OR_CLIENT_UTC_HOUR = MARKET_LIMITS.oauth.junkRefreshesPerIpOrClientUtcHour
const REVOCATIONS_PER_IP_OR_CLIENT_UTC_HOUR = MARKET_LIMITS.oauth.revocationsPerIpOrClientUtcHour

type TokenRefusalDetail = Extract<MarketRefusalDetail,
  | 'authorization_code_fields'
  | 'authorization_code_mismatch'
  | 'authorization_code_spent'
  | 'client_contract_mismatch'
  | 'invalid_grant_fields'
  | 'refresh_token_rejected'
  | 'refresh_token_shape'
  | 'unsupported_client_authentication'
>

const TOKEN_CAUSE_DESCRIPTIONS: Record<TokenRefusalDetail, string> = Object.freeze({
  unsupported_client_authentication: 'Send one form body without Authorization or client_secret.',
  invalid_grant_fields: 'Send only the fields allowed for authorization_code or refresh_token.',
  client_contract_mismatch: 'client_id, resource, and scope must match the original authorization.',
  authorization_code_fields: 'code, redirect_uri, and code_verifier must have the required form.',
  authorization_code_mismatch: 'The code, client, redirect_uri, resource, scope, or PKCE verifier did not match.',
  authorization_code_spent: 'The one-use authorization code was expired, already used, or unavailable.',
  refresh_token_shape: 'refresh_token must be the long pass issued by this authorization server.',
  refresh_token_rejected: 'The refresh token was expired, revoked, reused, or did not match this client.',
})

function tokenError(
  c: Context,
  error: 'invalid_request' | 'invalid_client' | 'invalid_grant',
  cause: TokenRefusalDetail,
) {
  privateHeaders(c)
  const reference = markMarketRefusal(c, 400, 'invalid_request', undefined, cause)
  return c.json({
    error,
    error_description: TOKEN_CAUSE_DESCRIPTIONS[cause],
    request_id: reference.requestId,
  }, 400)
}

function oauthUnavailable(
  c: Context,
  status: 429 | 503,
  description: string,
  retryAfter = 1,
) {
  privateHeaders(c)
  c.header('Retry-After', String(retryAfter))
  const reference = markMarketRefusal(c, status, status === 429 ? 'rate_limited' : 'storage_unavailable')
  return c.json({
    error: 'temporarily_unavailable',
    error_description: description,
    request_id: reference.requestId,
    ...(status === 429 ? { retry_after_seconds: retryAfter } : {}),
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

export function mountMarketOAuthTokenRoutes(app: Hono, oauth: Runtime): void {
  app.post('/oauth/token', async c => {
    try {
      const formRead = await readBoundedFormResult(c)
      if (formRead.kind === 'unreadable') {
        return oauthUnavailable(c, 503, 'token request could not be read; retry later')
      }
      const values = formRead.kind === 'form' ? formRead.values : null
      if (!values || c.req.header('authorization') || values.has('client_secret')) {
        return tokenError(c, 'invalid_request', 'unsupported_client_authentication')
      }
      const grantType = oneFormValue(values, 'grant_type', 64)
      const allowedFields = grantType === 'authorization_code'
        ? ['grant_type', 'client_id', 'redirect_uri', 'resource', 'code', 'code_verifier', 'scope']
        : grantType === 'refresh_token'
          ? ['grant_type', 'client_id', 'resource', 'refresh_token', 'scope']
          : []
      if (!allowedFields.length || !exactFormFields(values, allowedFields)) {
        return tokenError(c, 'invalid_request', 'invalid_grant_fields')
      }
      const clientId = oneFormValue(values, 'client_id', 2_048)
      const resource = oneFormValue(values, 'resource', 2_048)
      const scope = values.has('scope') ? oneFormValue(values, 'scope', 128) : MARKET_OAUTH_SCOPE
      const junkRefreshAdmission = () => admitted(
        oauth,
        [`junk-ip:${clientAddress(c, oauth.environment)}`, `junk-client:${clientId ?? ''}`],
        'refresh',
        JUNK_REFRESHES_PER_IP_OR_CLIENT_UTC_HOUR,
      )
      const junkRefreshThrottle = () => oauthUnavailable(
        c,
        429,
        `junk refresh requests allow ${JUNK_REFRESHES_PER_IP_OR_CLIENT_UTC_HOUR} attempts for each IP and each client per UTC hour; ` +
          'retry after the next UTC hour begins',
        secondsUntilNextUtcHour(),
      )
      if (!clientId || resource !== oauth.resource || scope !== MARKET_OAUTH_SCOPE) {
        if (grantType === 'refresh_token' && !(await junkRefreshAdmission())) return junkRefreshThrottle()
        return tokenError(c, 'invalid_client', 'client_contract_mismatch')
      }

      if (grantType === 'authorization_code') {
        const allowed = await admitted(
          oauth,
          [`ip:${clientAddress(c, oauth.environment)}`, `client:${clientId}`],
          'token',
          TOKEN_REQUESTS_PER_IP_OR_CLIENT_UTC_HOUR,
        )
        if (!allowed) {
          return oauthUnavailable(
            c,
            429,
            `token requests allow ${TOKEN_REQUESTS_PER_IP_OR_CLIENT_UTC_HOUR} attempts per UTC hour ` +
              'for each IP and each client; retry after the next UTC hour begins',
            secondsUntilNextUtcHour(),
          )
        }
        const code = oneFormValue(values, 'code', 100)
        const redirectUri = oneFormValue(values, 'redirect_uri', 4_096)
        const verifier = oneFormValue(values, 'code_verifier', 128)
        if (!code || !/^1f3ea_ac_[0-9a-f]{64}$/.test(code) || !redirectUri || !verifier) {
          return tokenError(c, 'invalid_grant', 'authorization_code_fields')
        }
        const codeHash = sha256(code)
        const stored = await oauth.store.getAuthorizationCode(codeHash)
        if (
          !stored || stored.clientId !== clientId || stored.redirectUri !== redirectUri ||
          stored.resource !== resource || stored.scope !== MARKET_OAUTH_SCOPE ||
          !verifyMarketPkceS256(verifier, stored.codeChallenge)
        ) return tokenError(c, 'invalid_grant', 'authorization_code_mismatch')
        const accessToken = opaque(MARKET_OAUTH_ACCESS_TOKEN_PREFIX)
        const refreshToken = opaque(MARKET_OAUTH_REFRESH_TOKEN_PREFIX)
        const exchanged = await oauth.store.exchangeAuthorizationCode({
          codeHash, clientId, redirectUri, resource,
          accessTokenHash: sha256(accessToken), refreshTokenHash: sha256(refreshToken),
        })
        if (!exchanged) return tokenError(c, 'invalid_grant', 'authorization_code_spent')
        return tokenResponse(c, accessToken, refreshToken)
      }

      const presented = oneFormValue(values, 'refresh_token', 100)
      if (!presented || !/^1f3ea_rt_[0-9a-f]{64}$/.test(presented)) {
        if (!(await junkRefreshAdmission())) return junkRefreshThrottle()
        return tokenError(c, 'invalid_grant', 'refresh_token_shape')
      }
      const presentedRefreshTokenHash = sha256(presented)
      const subject = await oauth.store.resolveRefreshRateLimitSubject({
        presentedRefreshTokenHash, clientId, resource,
      })
      if (subject.status === 'junk') {
        if (!(await junkRefreshAdmission())) return junkRefreshThrottle()
        return tokenError(c, 'invalid_grant', 'refresh_token_rejected')
      }
      if (subject.status === 'active') {
        const allowed = await admitted(
          oauth,
          [`connection:${subject.connectionKey}`],
          'refresh',
          REFRESHES_PER_CONNECTION_UTC_HOUR,
        )
        if (!allowed) {
          return oauthUnavailable(
            c,
            429,
            `refresh requests allow ${REFRESHES_PER_CONNECTION_UTC_HOUR} attempts per connection per UTC hour; ` +
              'retry after the next UTC hour begins',
            secondsUntilNextUtcHour(),
          )
        }
      }
      if (subject.status === 'reused') {
        // The first replay still reaches atomic family revocation if junk
        // capacity or its store fails. Later requests classify as junk.
        try {
          await junkRefreshAdmission()
        } catch {
          // Rate accounting is best-effort only for this security revocation.
        }
      }
      const accessToken = opaque(MARKET_OAUTH_ACCESS_TOKEN_PREFIX)
      const refreshToken = opaque(MARKET_OAUTH_REFRESH_TOKEN_PREFIX)
      const rotated = await oauth.store.rotateRefreshToken({
        presentedRefreshTokenHash, clientId, resource,
        accessTokenHash: sha256(accessToken), newRefreshTokenHash: sha256(refreshToken),
      })
      if (rotated !== 'rotated') return tokenError(c, 'invalid_grant', 'refresh_token_rejected')
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
        secondsUntilNextUtcHour(),
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
