import { sql } from './db.ts'
import type { Merchant } from './core.ts'

export type OAuthAttemptKind = 'authorize' | 'merchant_key' | 'token' | 'refresh' | 'revoke'

export interface AuthorizationRequestInput {
  sessionHash: string
  csrfHash: string
  clientId: string
  clientName: string
  redirectUri: string
  resource: string
  scope: string
  state: string
  codeChallenge: string
}

export interface AuthorizationRequestRecord {
  id: number
  client_id: string
  client_display_name: string
  redirect_uri: string
  resource: string
  scope: string
  state: string
  code_challenge: string
  merchant_id: number | null
  verified_at: string | null
  approved_at: string | null
}

export interface AuthorizationRedirect {
  redirectUri: string
  state: string
}

export interface AuthorizationCodeRecord {
  merchantId: number
  clientId: string
  redirectUri: string
  resource: string
  scope: string
  codeChallenge: string
}

export interface TokenPairHashes {
  accessTokenHash: string
  refreshTokenHash: string
}

export interface CodeExchangeInput extends TokenPairHashes {
  codeHash: string
  clientId: string
  redirectUri: string
  resource: string
}

export interface RefreshRotationInput {
  presentedRefreshTokenHash: string
  clientId: string
  resource: string
  accessTokenHash: string
  newRefreshTokenHash: string
}

export type RefreshRotationResult = 'rotated' | 'reused' | 'invalid'

export interface MarketOAuthStore {
  createAuthorizationRequest(input: AuthorizationRequestInput): Promise<void>
  getAuthorizationRequest(sessionHash: string): Promise<AuthorizationRequestRecord | null>
  cancelAuthorizationRequest(input: {
    sessionHash: string
    csrfHash: string
  }): Promise<AuthorizationRedirect | null>
  approveExistingMerchantAndIssueAuthorizationCode(input: {
    sessionHash: string
    csrfHash: string
    merchantSecretHash: string
    authorizationCodeHash: string
  }): Promise<AuthorizationRedirect | null>
  getAuthorizationCode(codeHash: string): Promise<AuthorizationCodeRecord | null>
  exchangeAuthorizationCode(input: CodeExchangeInput): Promise<boolean>
  rotateRefreshToken(input: RefreshRotationInput): Promise<RefreshRotationResult>
  revokeTokenFamilyByToken(input: { tokenHash: string; clientId: string }): Promise<void>
  resolveOAuthAccessToken(input: {
    accessTokenHash: string
    resource: string
    scope: string
  }): Promise<Merchant | null>
  consumeOAuthRateLimit(input: {
    bucketHash: string
    attemptKind: OAuthAttemptKind
    maximum: number
  }): Promise<boolean>
}

export type MarketOAuthQuery = (
  strings: TemplateStringsArray,
  ...values: readonly unknown[]
) => Promise<readonly Record<string, unknown>[]>

const SHA256_HASH = /^[0-9a-f]{64}$/

function requireHash(value: string, name: string): void {
  if (!SHA256_HASH.test(value)) throw new Error(`${name} must be a lowercase sha256 hash`)
}

export function createMarketOAuthStore(query: MarketOAuthQuery): MarketOAuthStore {
  async function createAuthorizationRequest(input: AuthorizationRequestInput): Promise<void> {
    requireHash(input.sessionHash, 'sessionHash')
    requireHash(input.csrfHash, 'csrfHash')
    await query`
      INSERT INTO oauth_authorization_requests (
        session_hash, csrf_hash, client_id, client_display_name, redirect_uri,
        resource, scope, state, code_challenge, code_challenge_method, expires_at
      ) VALUES (
        ${input.sessionHash}, ${input.csrfHash}, ${input.clientId}, ${input.clientName},
        ${input.redirectUri}, ${input.resource}, ${input.scope}, ${input.state},
        ${input.codeChallenge}, 'S256', now() + interval '15 minutes'
      )
    `
  }

  async function getAuthorizationRequest(
    sessionHash: string,
  ): Promise<AuthorizationRequestRecord | null> {
    requireHash(sessionHash, 'sessionHash')
    const rows = await query`
      SELECT id, client_id, client_display_name, redirect_uri, resource, scope,
        state, code_challenge, merchant_id, verified_at, approved_at
      FROM oauth_authorization_requests
      WHERE session_hash = ${sessionHash}
        AND merchant_id IS NULL
        AND used_at IS NULL
        AND expires_at > now()
      LIMIT 1
    ` as unknown as AuthorizationRequestRecord[]
    return rows[0] ?? null
  }

  async function cancelAuthorizationRequest(input: {
    sessionHash: string
    csrfHash: string
  }): Promise<AuthorizationRedirect | null> {
    requireHash(input.sessionHash, 'sessionHash')
    requireHash(input.csrfHash, 'csrfHash')
    const rows = await query`
      UPDATE oauth_authorization_requests
      SET used_at = now()
      WHERE session_hash = ${input.sessionHash}
        AND csrf_hash = ${input.csrfHash}
        AND merchant_id IS NULL
        AND used_at IS NULL
        AND expires_at > now()
      RETURNING redirect_uri, state
    ` as unknown as { redirect_uri: string; state: string }[]
    const redirect = rows[0]
    return redirect ? { redirectUri: redirect.redirect_uri, state: redirect.state } : null
  }

  async function approveExistingMerchantAndIssueAuthorizationCode(input: {
    sessionHash: string
    csrfHash: string
    merchantSecretHash: string
    authorizationCodeHash: string
  }): Promise<AuthorizationRedirect | null> {
    requireHash(input.sessionHash, 'sessionHash')
    requireHash(input.csrfHash, 'csrfHash')
    requireHash(input.merchantSecretHash, 'merchantSecretHash')
    requireHash(input.authorizationCodeHash, 'authorizationCodeHash')
    const rows = await query`
      WITH proven_merchant AS MATERIALIZED (
        SELECT id
        FROM merchants
        WHERE secret_hash = ${input.merchantSecretHash}
      ), consumed_request AS (
        UPDATE oauth_authorization_requests request
        SET merchant_id = merchant.id,
            verified_at = now(),
            approved_at = now(),
            used_at = now()
        FROM proven_merchant merchant
        WHERE request.session_hash = ${input.sessionHash}
          AND request.csrf_hash = ${input.csrfHash}
          AND request.merchant_id IS NULL
          AND request.used_at IS NULL
          AND request.expires_at > now()
        RETURNING request.id, merchant.id AS merchant_id, request.client_id,
          request.redirect_uri, request.resource, request.scope, request.state,
          request.code_challenge
      ), issued_code AS (
        INSERT INTO oauth_authorization_codes (
          request_id, code_hash, merchant_id, client_id, redirect_uri, resource,
          scope, code_challenge, code_challenge_method, expires_at
        )
        SELECT id, ${input.authorizationCodeHash}, merchant_id, client_id, redirect_uri,
          resource, scope, code_challenge, 'S256', now() + interval '5 minutes'
        FROM consumed_request
        RETURNING request_id
      )
      SELECT request.redirect_uri, request.state
      FROM consumed_request request
      JOIN issued_code code ON code.request_id = request.id
    ` as unknown as { redirect_uri: string; state: string }[]
    const redirect = rows[0]
    return redirect ? { redirectUri: redirect.redirect_uri, state: redirect.state } : null
  }

  async function getAuthorizationCode(codeHash: string): Promise<AuthorizationCodeRecord | null> {
    requireHash(codeHash, 'codeHash')
    const rows = await query`
      SELECT merchant_id, client_id, redirect_uri, resource, scope, code_challenge
      FROM oauth_authorization_codes
      WHERE code_hash = ${codeHash}
        AND used_at IS NULL
        AND expires_at > now()
      LIMIT 1
    ` as unknown as {
      merchant_id: number
      client_id: string
      redirect_uri: string
      resource: string
      scope: string
      code_challenge: string
    }[]
    const code = rows[0]
    return code ? {
      merchantId: code.merchant_id,
      clientId: code.client_id,
      redirectUri: code.redirect_uri,
      resource: code.resource,
      scope: code.scope,
      codeChallenge: code.code_challenge,
    } : null
  }

  async function exchangeAuthorizationCode(input: CodeExchangeInput): Promise<boolean> {
    requireHash(input.codeHash, 'codeHash')
    requireHash(input.accessTokenHash, 'accessTokenHash')
    requireHash(input.refreshTokenHash, 'refreshTokenHash')
    const rows = await query`
      WITH consumed_code AS (
        UPDATE oauth_authorization_codes
        SET used_at = now()
        WHERE code_hash = ${input.codeHash}
          AND client_id = ${input.clientId}
          AND redirect_uri = ${input.redirectUri}
          AND resource = ${input.resource}
          AND used_at IS NULL
          AND expires_at > now()
        RETURNING merchant_id, client_id, resource, scope
      ), new_family AS (
        INSERT INTO oauth_token_families (
          merchant_id, client_id, resource, scope, expires_at
        )
        SELECT merchant_id, client_id, resource, scope, now() + interval '30 days'
        FROM consumed_code
        RETURNING id
      ), new_access AS (
        INSERT INTO oauth_tokens (token_hash, token_type, family_id, expires_at)
        SELECT ${input.accessTokenHash}, 'access', id, now() + interval '10 minutes'
        FROM new_family
        RETURNING id
      ), new_refresh AS (
        INSERT INTO oauth_tokens (token_hash, token_type, family_id, expires_at)
        SELECT ${input.refreshTokenHash}, 'refresh', id, now() + interval '30 days'
        FROM new_family
        RETURNING id
      )
      SELECT family.id
      FROM new_family family
      WHERE EXISTS (SELECT 1 FROM new_access) AND EXISTS (SELECT 1 FROM new_refresh)
    ` as unknown as { id: number }[]
    return rows.length === 1
  }

  async function revokeReusedRefreshToken(input: {
    presentedRefreshTokenHash: string
    clientId: string
    resource: string
  }): Promise<boolean> {
    const rows = await query`
      WITH reused AS MATERIALIZED (
        SELECT family.id
        FROM oauth_tokens token
        JOIN oauth_token_families family ON family.id = token.family_id
        WHERE token.token_hash = ${input.presentedRefreshTokenHash}
          AND token.token_type = 'refresh'
          AND family.client_id = ${input.clientId}
          AND family.resource = ${input.resource}
          AND token.used_at IS NOT NULL
      ), revoked AS (
        UPDATE oauth_token_families family
        SET revoked_at = coalesce(family.revoked_at, now()),
            revoke_reason = coalesce(family.revoke_reason, 'refresh token reuse')
        FROM reused
        WHERE family.id = reused.id
        RETURNING family.id
      ), revoked_tokens AS (
        UPDATE oauth_tokens token
        SET revoked_at = coalesce(token.revoked_at, now())
        FROM revoked
        WHERE token.family_id = revoked.id
        RETURNING token.id
      )
      SELECT id FROM revoked
    ` as unknown as { id: number }[]
    return rows.length === 1
  }

  async function rotateRefreshToken(input: RefreshRotationInput): Promise<RefreshRotationResult> {
    requireHash(input.presentedRefreshTokenHash, 'presentedRefreshTokenHash')
    requireHash(input.accessTokenHash, 'accessTokenHash')
    requireHash(input.newRefreshTokenHash, 'newRefreshTokenHash')
    const rows = await query`
      WITH consumed_refresh AS (
        UPDATE oauth_tokens token
        SET used_at = now()
        FROM oauth_token_families family
        WHERE token.family_id = family.id
          AND token.token_hash = ${input.presentedRefreshTokenHash}
          AND token.token_type = 'refresh'
          AND token.used_at IS NULL
          AND token.revoked_at IS NULL
          AND token.expires_at > now()
          AND family.client_id = ${input.clientId}
          AND family.resource = ${input.resource}
          AND family.revoked_at IS NULL
          AND family.expires_at > now()
        RETURNING token.id, token.family_id
      ), new_access AS (
        INSERT INTO oauth_tokens (token_hash, token_type, family_id, expires_at)
        SELECT ${input.accessTokenHash}, 'access', consumed.family_id,
          LEAST(now() + interval '10 minutes', family.expires_at)
        FROM consumed_refresh consumed
        JOIN oauth_token_families family ON family.id = consumed.family_id
        RETURNING id
      ), new_refresh AS (
        INSERT INTO oauth_tokens (
          token_hash, token_type, family_id, rotated_from_token_id, expires_at
        )
        SELECT ${input.newRefreshTokenHash}, 'refresh', consumed.family_id, consumed.id,
          family.expires_at
        FROM consumed_refresh consumed
        JOIN oauth_token_families family ON family.id = consumed.family_id
        RETURNING id
      )
      SELECT id FROM consumed_refresh
      WHERE EXISTS (SELECT 1 FROM new_access)
        AND EXISTS (SELECT 1 FROM new_refresh)
    ` as unknown as { id: number }[]
    if (rows.length === 1) return 'rotated'
    return (await revokeReusedRefreshToken(input)) ? 'reused' : 'invalid'
  }

  async function revokeTokenFamilyByToken(input: {
    tokenHash: string
    clientId: string
  }): Promise<void> {
    requireHash(input.tokenHash, 'tokenHash')
    await query`
      WITH matching_family AS MATERIALIZED (
        SELECT family.id
        FROM oauth_tokens token
        JOIN oauth_token_families family ON family.id = token.family_id
        WHERE token.token_hash = ${input.tokenHash}
          AND family.client_id = ${input.clientId}
      ), revoked AS (
        UPDATE oauth_token_families family
        SET revoked_at = coalesce(family.revoked_at, now()),
            revoke_reason = coalesce(family.revoke_reason, 'client revocation')
        FROM matching_family
        WHERE family.id = matching_family.id
        RETURNING family.id
      )
      UPDATE oauth_tokens token
      SET revoked_at = coalesce(token.revoked_at, now())
      FROM revoked
      WHERE token.family_id = revoked.id
    `
  }

  async function resolveOAuthAccessToken(input: {
    accessTokenHash: string
    resource: string
    scope: string
  }): Promise<Merchant | null> {
    requireHash(input.accessTokenHash, 'accessTokenHash')
    const rows = await query`
      SELECT merchant.id, merchant.handle, merchant.model, merchant.storefront_line,
        merchant.karma, merchant.joined_at, merchant.quota_day,
        merchant.comments_today, merchant.votes_today
      FROM oauth_tokens token
      JOIN oauth_token_families family ON family.id = token.family_id
      JOIN merchants merchant ON merchant.id = family.merchant_id
      WHERE token.token_hash = ${input.accessTokenHash}
        AND token.token_type = 'access'
        AND token.used_at IS NULL
        AND token.revoked_at IS NULL
        AND token.expires_at > now()
        AND family.resource = ${input.resource}
        AND family.scope = ${input.scope}
        AND family.revoked_at IS NULL
        AND family.expires_at > now()
    ` as unknown as Merchant[]
    return rows[0] ?? null
  }

  async function consumeOAuthRateLimit(input: {
    bucketHash: string
    attemptKind: OAuthAttemptKind
    maximum: number
  }): Promise<boolean> {
    requireHash(input.bucketHash, 'bucketHash')
    if (!Number.isInteger(input.maximum) || input.maximum < 1 || input.maximum > 10_000) {
      throw new Error('maximum must be an integer between 1 and 10000')
    }
    const rows = await query`
      WITH current_window AS MATERIALIZED (
        SELECT date_trunc('hour', now(), 'UTC') AS window_start
      ), cleanup AS (
        DELETE FROM oauth_rate_limits
        WHERE window_start < (SELECT window_start FROM current_window) - interval '24 hours'
      ), retired_codes AS MATERIALIZED (
        SELECT id
        FROM oauth_authorization_codes
        WHERE expires_at <= now() - interval '30 days'
        ORDER BY expires_at, id
        LIMIT 50
      ), pruned_codes AS (
        DELETE FROM oauth_authorization_codes code
        USING retired_codes retired
        WHERE code.id = retired.id
        RETURNING code.id
      ), retired_requests AS MATERIALIZED (
        SELECT request.id
        FROM oauth_authorization_requests request
        WHERE request.expires_at <= now() - interval '30 days'
          AND NOT EXISTS (
            SELECT 1 FROM oauth_authorization_codes code
            WHERE code.request_id = request.id
              AND code.id NOT IN (SELECT id FROM retired_codes)
          )
        ORDER BY request.expires_at, request.id
        LIMIT 50
      ), pruned_requests AS (
        DELETE FROM oauth_authorization_requests request
        USING retired_requests retired
        WHERE request.id = retired.id
        RETURNING request.id
      ), retired_tokens AS MATERIALIZED (
        SELECT token.id
        FROM oauth_tokens token
        JOIN oauth_token_families family ON family.id = token.family_id
        WHERE family.expires_at <= now() - interval '30 days'
        ORDER BY token.id DESC
        LIMIT 50
      ), pruned_tokens AS (
        DELETE FROM oauth_tokens token
        USING retired_tokens retired
        WHERE token.id = retired.id
        RETURNING token.id
      ), retired_families AS MATERIALIZED (
        SELECT family.id
        FROM oauth_token_families family
        WHERE family.expires_at <= now() - interval '30 days'
          AND NOT EXISTS (
            SELECT 1 FROM oauth_tokens token
            WHERE token.family_id = family.id
              AND token.id NOT IN (SELECT id FROM retired_tokens)
          )
        ORDER BY family.expires_at, family.id
        LIMIT 50
      ), pruned_families AS (
        DELETE FROM oauth_token_families family
        USING retired_families retired
        WHERE family.id = retired.id
        RETURNING family.id
      ), admitted AS (
        INSERT INTO oauth_rate_limits (bucket_hash, attempt_kind, window_start, used)
        SELECT ${input.bucketHash}, ${input.attemptKind}, window_start, 1
        FROM current_window
        ON CONFLICT (bucket_hash, attempt_kind, window_start) DO UPDATE
        SET used = oauth_rate_limits.used + 1
        WHERE oauth_rate_limits.used < ${input.maximum}
        RETURNING used
      )
      SELECT used FROM admitted
    ` as unknown as { used: number }[]
    return rows.length === 1
  }

  return {
    createAuthorizationRequest,
    getAuthorizationRequest,
    cancelAuthorizationRequest,
    approveExistingMerchantAndIssueAuthorizationCode,
    getAuthorizationCode,
    exchangeAuthorizationCode,
    rotateRefreshToken,
    revokeTokenFamilyByToken,
    resolveOAuthAccessToken,
    consumeOAuthRateLimit,
  }
}

export const postgresMarketOAuthStore = createMarketOAuthStore(
  sql as unknown as MarketOAuthQuery,
)

export const {
  createAuthorizationRequest,
  getAuthorizationRequest,
  cancelAuthorizationRequest,
  approveExistingMerchantAndIssueAuthorizationCode,
  getAuthorizationCode,
  exchangeAuthorizationCode,
  rotateRefreshToken,
  revokeTokenFamilyByToken,
  resolveOAuthAccessToken,
  consumeOAuthRateLimit,
} = postgresMarketOAuthStore
